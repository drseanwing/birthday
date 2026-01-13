/**
 * Royal Edinburgh Tattoo Trivia Game - Server
 * ============================================
 * Backend server managing game state synchronization between twin players.
 * Handles question progression, answer validation, and disagreement resolution.
 * 
 * Features:
 * - Persistent state management using JSON file
 * - Comprehensive logging to external file
 * - Graceful error handling and recovery
 * - Real-time state synchronization
 */

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    PORT: process.env.PORT || 3000,
    STATE_FILE: path.join(__dirname, 'game-state.json'),
    QUESTIONS_FILE: path.join(__dirname, 'questions.json'),
    LOG_DIR: path.join(__dirname, 'logs'),
    LOG_FILE: path.join(__dirname, 'logs', 'game.log'),
    PLAYERS: {
        LACHLAN: 'lachlan',
        LEIGH: 'leigh'
    }
};

// ============================================
// LOGGING SETUP
// ============================================

/**
 * Configure Winston logger for verbose external logging
 * Logs to both file and console with timestamps and formatting
 */
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, stack }) => {
            if (stack) {
                return `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`;
            }
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ 
            filename: CONFIG.LOG_FILE,
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `[${timestamp}] ${level}: ${message}`;
                })
            )
        })
    ]
});

// ============================================
// INITIALIZATION
// ============================================

const app = express();

// Middleware configuration
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url} - IP: ${req.ip}`);
    next();
});

/**
 * Initialize required directories and files
 * Creates log directory and game state file if they don't exist
 */
async function initializeEnvironment() {
    try {
        logger.info('Initializing server environment...');
        
        // Create logs directory if it doesn't exist
        try {
            await fs.access(CONFIG.LOG_DIR);
            logger.debug('Logs directory exists');
        } catch {
            await fs.mkdir(CONFIG.LOG_DIR, { recursive: true });
            logger.info('Created logs directory');
        }
        
        // Initialize game state file if it doesn't exist
        try {
            await fs.access(CONFIG.STATE_FILE);
            logger.debug('Game state file exists');
        } catch {
            const initialState = createInitialState();
            await saveGameState(initialState);
            logger.info('Created initial game state file');
        }
        
        logger.info('Environment initialization complete');
    } catch (error) {
        logger.error('Failed to initialize environment', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Create initial game state structure
 * @returns {Object} Initial state object with all required properties
 */
function createInitialState() {
    logger.debug('Creating initial game state');
    return {
        currentQuestion: 0,
        answers: {
            lachlan: null,
            leigh: null
        },
        consensusAnswers: {
            lachlan: null,
            leigh: null
        },
        inDisagreement: false,
        disagreementResolved: false,
        showHint: false,
        completed: false,
        history: [],
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString()
    };
}

// ============================================
// STATE MANAGEMENT
// ============================================

/**
 * Load game state from persistent storage
 * Implements graceful degradation by creating new state if file is corrupted
 * @returns {Promise<Object>} Current game state
 */
async function loadGameState() {
    try {
        logger.debug('Loading game state from file');
        const data = await fs.readFile(CONFIG.STATE_FILE, 'utf8');
        const state = JSON.parse(data);
        
        // Backwards compatibility: add new fields if missing
        if (!state.consensusAnswers) {
            state.consensusAnswers = { lachlan: null, leigh: null };
        }
        if (state.showHint === undefined) {
            state.showHint = false;
        }
        
        logger.debug(`Game state loaded: Question ${state.currentQuestion}, Completed: ${state.completed}`);
        return state;
    } catch (error) {
        logger.warn('Failed to load game state, creating new state', { error: error.message });
        // Graceful degradation: create new state if file is corrupted or missing
        const newState = createInitialState();
        await saveGameState(newState);
        return newState;
    }
}

/**
 * Save game state to persistent storage
 * @param {Object} state - Game state to save
 * @returns {Promise<void>}
 */
async function saveGameState(state) {
    try {
        state.lastModified = new Date().toISOString();
        const data = JSON.stringify(state, null, 2);
        await fs.writeFile(CONFIG.STATE_FILE, data, 'utf8');
        logger.debug('Game state saved successfully');
    } catch (error) {
        logger.error('Failed to save game state', { error: error.message, stack: error.stack });
        throw error;
    }
}

/**
 * Load questions from JSON file
 * @returns {Promise<Array>} Array of question objects
 */
async function loadQuestions() {
    try {
        logger.debug(`Loading questions from: ${CONFIG.QUESTIONS_FILE}`);
        logger.debug(`Current working directory: ${process.cwd()}`);
        logger.debug(`__dirname: ${__dirname}`);
        
        const data = await fs.readFile(CONFIG.QUESTIONS_FILE, 'utf8');
        logger.debug(`Read ${data.length} bytes from questions file`);
        
        const parsed = JSON.parse(data);
        
        if (!parsed.questions || !Array.isArray(parsed.questions)) {
            throw new Error('Invalid questions file format: missing questions array');
        }
        
        const questions = parsed.questions;
        logger.info(`Successfully loaded ${questions.length} questions`);
        return questions;
    } catch (error) {
        logger.error('Failed to load questions - DETAILS:', { 
            errorMessage: error.message,
            errorCode: error.code,
            errorName: error.name,
            file: CONFIG.QUESTIONS_FILE,
            cwd: process.cwd(),
            dirname: __dirname
        });
        
        // Try to list directory contents for debugging
        try {
            const fsSync = require('fs');
            const files = fsSync.readdirSync(__dirname);
            logger.error(`Files in ${__dirname}: ${files.join(', ')}`);
        } catch (e) {
            logger.error('Could not list directory contents');
        }
        
        throw error;
    }
}

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/**
 * Validate player identifier
 * @param {string} player - Player identifier to validate
 * @returns {boolean} True if player is valid
 */
function isValidPlayer(player) {
    const valid = player === CONFIG.PLAYERS.LACHLAN || player === CONFIG.PLAYERS.LEIGH;
    if (!valid) {
        logger.warn(`Invalid player identifier: ${player}`);
    }
    return valid;
}

/**
 * Validate answer choice against available options
 * @param {string} answer - Answer to validate
 * @param {Array} choices - Valid choices for question
 * @returns {boolean} True if answer is valid
 */
function isValidAnswer(answer, choices) {
    const valid = choices.includes(answer);
    if (!valid) {
        logger.warn(`Invalid answer: ${answer}`);
    }
    return valid;
}

// ============================================
// GAME LOGIC
// ============================================

/**
 * Process player's answer submission
 * Handles answer validation, state updates, and disagreement detection
 * @param {Object} state - Current game state
 * @param {string} player - Player identifier
 * @param {string} answer - Submitted answer
 * @param {Array} questions - All questions
 * @returns {Object} Updated state with processing results
 */
function processAnswer(state, player, answer, questions) {
    logger.info(`Processing answer from ${player}: "${answer}"`);
    
    const currentQ = questions[state.currentQuestion];
    const otherPlayer = player === CONFIG.PLAYERS.LACHLAN ? CONFIG.PLAYERS.LEIGH : CONFIG.PLAYERS.LACHLAN;
    
    // Update player's answer
    state.answers[player] = answer;
    logger.info(`✓ Recorded ${player}'s answer: "${answer}"`);
    logger.debug(`Current answers - Lachlan: "${state.answers.lachlan}", Leigh: "${state.answers.leigh}"`);
    
    // Check if both players have answered
    if (state.answers[otherPlayer] !== null) {
        logger.info('Both players have answered, checking correctness...');
        
        const lachlanAnswer = state.answers.lachlan;
        const leighAnswer = state.answers.leigh;
        
        logger.info(`Lachlan answered: "${lachlanAnswer}"`);
        logger.info(`Leigh answered: "${leighAnswer}"`);
        logger.info(`Correct answer: "${currentQ.correct_answer}"`);
        
        // Check if BOTH players are correct
        const lachlanCorrect = lachlanAnswer === currentQ.correct_answer;
        const leighCorrect = leighAnswer === currentQ.correct_answer;
        
        logger.info(`Lachlan is ${lachlanCorrect ? 'CORRECT ✓' : 'INCORRECT ✗'}`);
        logger.info(`Leigh is ${leighCorrect ? 'CORRECT ✓' : 'INCORRECT ✗'}`);
        
        if (lachlanCorrect && leighCorrect) {
            // Both correct - advance to next question
            logger.info('✓ BOTH PLAYERS CORRECT - Advancing to next question');
            
            // Record in history
            state.history.push({
                question: state.currentQuestion,
                questionText: currentQ.question,
                lachlanAnswer: lachlanAnswer,
                leighAnswer: leighAnswer,
                correctAnswer: currentQ.correct_answer,
                bothCorrect: true,
                timestamp: new Date().toISOString()
            });
            
            const oldQuestion = state.currentQuestion;
            state.currentQuestion++;
            state.answers = { lachlan: null, leigh: null };
            state.inDisagreement = false;
            
            logger.info(`Moving from question ${oldQuestion} to question ${state.currentQuestion}`);
            
            // Check if game is complete
            if (state.currentQuestion >= questions.length) {
                state.completed = true;
                logger.info('🎉 GAME COMPLETED! All questions answered correctly.');
            } else {
                logger.info(`Next question: "${questions[state.currentQuestion].question}"`);
            }
        } else {
            // Either player wrong - enter consensus mode
            logger.warn('⚠ AT LEAST ONE PLAYER WRONG - Entering consensus mode');
            state.inDisagreement = true;
            state.disagreementResolved = false;
            
            // Record initial answers for reference
            logger.info('Waiting for twins to reach consensus on the correct answer...');
        }
    } else {
        logger.info(`Waiting for ${otherPlayer} to answer...`);
    }
    
    return state;
}

/**
 * Process disagreement resolution
 * Handles when twins come to agreement after initial disagreement
 * @param {Object} state - Current game state
 * @param {string} agreedAnswer - The answer they agreed upon
 * @param {Array} questions - All questions
 * @returns {Object} Updated state with resolution results
 */
function processDisagreementResolution(state, agreedAnswer, questions) {
    logger.info(`Processing disagreement resolution: "${agreedAnswer}"`);
    logger.debug(`Initial disagreement - Lachlan: "${state.answers.lachlan}", Leigh: "${state.answers.leigh}"`);
    
    const currentQ = questions[state.currentQuestion];
    const isCorrect = agreedAnswer === currentQ.correct_answer;
    
    logger.info(`Agreed answer "${agreedAnswer}" is ${isCorrect ? 'CORRECT ✓' : 'INCORRECT ✗'}`);
    logger.info(`Correct answer was: "${currentQ.correct_answer}"`);
    
    // Record resolution in history
    state.history.push({
        question: state.currentQuestion,
        questionText: currentQ.question,
        initialAnswers: {
            lachlan: state.answers.lachlan,
            leigh: state.answers.leigh
        },
        agreedAnswer: agreedAnswer,
        correctAnswer: currentQ.correct_answer,
        wasCorrect: isCorrect,
        wasDisagreement: true,
        timestamp: new Date().toISOString()
    });
    
    logger.debug(`Added resolution to history. History length: ${state.history.length}`);
    
    if (isCorrect) {
        // Move to next question
        const oldQuestion = state.currentQuestion;
        state.currentQuestion++;
        state.answers = { lachlan: null, leigh: null };
        state.inDisagreement = false;
        state.disagreementResolved = false;
        
        logger.info(`✓ Moving from question ${oldQuestion} to question ${state.currentQuestion}`);
        
        // Check if game is complete
        if (state.currentQuestion >= questions.length) {
            state.completed = true;
            logger.info('🎉 GAME COMPLETED after disagreement resolution!');
        } else {
            logger.info(`Next question: "${questions[state.currentQuestion].question}"`);
        }
    } else {
        // They agreed but were wrong - stay on question, reset disagreement
        logger.info('✗ Disagreement resolved but answer incorrect, resetting for retry');
        logger.info(`Staying on question ${state.currentQuestion}: "${currentQ.question}"`);
        state.answers = { lachlan: null, leigh: null };
        state.inDisagreement = false;
        state.disagreementResolved = false;
    }
    
    return state;
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * GET / - Root endpoint, redirects to game selection
 */
app.get('/', (req, res) => {
    logger.info('Root endpoint accessed');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Birthday Trivia</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    display: flex; 
                    justify-content: center; 
                    align-items: center; 
                    height: 100vh; 
                    margin: 0;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                }
                .container {
                    background: white;
                    padding: 40px;
                    border-radius: 15px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    text-align: center;
                }
                h1 { color: #333; margin-bottom: 30px; }
                a {
                    display: inline-block;
                    margin: 10px;
                    padding: 15px 30px;
                    background: #667eea;
                    color: white;
                    text-decoration: none;
                    border-radius: 8px;
                    font-size: 18px;
                    transition: all 0.3s;
                }
                a:hover {
                    background: #764ba2;
                    transform: translateY(-2px);
                    box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎉 Birthday Trivia Challenge 🎉</h1>
                <p>Choose your player:</p>
                <a href="/game?player=lachlan">Lachlan's Game</a>
                <a href="/game?player=leigh">Leigh's Game</a>
            </div>
        </body>
        </html>
    `);
});

/**
 * GET /game - Main game interface
 * Serves the game HTML to the specified player
 */
app.get('/game', (req, res) => {
    const player = req.query.player;
    
    if (!isValidPlayer(player)) {
        logger.warn(`Invalid player parameter in /game: ${player}`);
        return res.status(400).send('Invalid player. Please use the links provided.');
    }
    
    logger.info(`Serving game page to ${player}`);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * GET /api/state - Get current game state
 * Returns state information relevant to requesting player
 */
app.get('/api/state', async (req, res) => {
    const player = req.query.player;
    
    if (!isValidPlayer(player)) {
        logger.warn(`Invalid player in /api/state: ${player}`);
        return res.status(400).json({ error: 'Invalid player' });
    }
    
    try {
        const state = await loadGameState();
        const questions = await loadQuestions();
        
        logger.debug(`Sending state to ${player}: Question ${state.currentQuestion}`);
        
        // Prepare response data
        const response = {
            currentQuestion: state.currentQuestion,
            totalQuestions: questions.length,
            inDisagreement: state.inDisagreement,
            showHint: state.showHint || false,
            completed: state.completed,
            playerAnswered: state.answers[player] !== null,
            otherPlayerAnswered: state.answers[player === CONFIG.PLAYERS.LACHLAN ? CONFIG.PLAYERS.LEIGH : CONFIG.PLAYERS.LACHLAN] !== null,
            playerAnswer: state.answers[player],
            playerConsensusAnswered: state.consensusAnswers && state.consensusAnswers[player] !== null,
            otherPlayerConsensusAnswered: state.consensusAnswers && state.consensusAnswers[player === CONFIG.PLAYERS.LACHLAN ? CONFIG.PLAYERS.LEIGH : CONFIG.PLAYERS.LACHLAN] !== null
        };
        
        // Include question data if not completed
        if (!state.completed && state.currentQuestion < questions.length) {
            const currentQ = questions[state.currentQuestion];
            response.question = {
                text: currentQ.question,
                choices: currentQ.choices,
                hint: currentQ.hint
            };
            
            // Include both answers if in disagreement
            if (state.inDisagreement) {
                response.answers = state.answers;
            }
        }
        
        res.json(response);
    } catch (error) {
        logger.error('Error in /api/state', { 
            error: error.message, 
            stack: error.stack,
            player: player,
            errorName: error.name
        });
        logger.error(`Full error details: ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`);
        res.status(500).json({ error: 'Failed to load game state', details: error.message });
    }
});

/**
 * POST /api/answer - Submit an answer
 * Processes player's answer and updates game state
 */
app.post('/api/answer', async (req, res) => {
    const { player, answer } = req.body;
    
    logger.info(`POST /api/answer - Player: ${player}, Answer: "${answer}"`);
    
    if (!isValidPlayer(player)) {
        logger.warn(`Invalid player in /api/answer: ${player}`);
        return res.status(400).json({ error: 'Invalid player' });
    }
    
    if (!answer) {
        logger.warn(`Missing answer from ${player}`);
        return res.status(400).json({ error: 'Answer is required' });
    }
    
    try {
        let state = await loadGameState();
        const questions = await loadQuestions();
        
        logger.debug(`Current state - Question: ${state.currentQuestion}, InDisagreement: ${state.inDisagreement}`);
        
        // Validate question index
        if (state.currentQuestion >= questions.length) {
            logger.warn(`Attempt to answer beyond last question by ${player}`);
            return res.status(400).json({ error: 'No more questions' });
        }
        
        const currentQ = questions[state.currentQuestion];
        
        // Validate answer is one of the choices
        if (!isValidAnswer(answer, currentQ.choices)) {
            logger.warn(`Invalid answer choice from ${player}: ${answer}`);
            logger.debug(`Valid choices: ${JSON.stringify(currentQ.choices)}`);
            return res.status(400).json({ error: 'Invalid answer choice' });
        }
        
        // Check if player already answered
        if (state.answers[player] !== null && !state.inDisagreement) {
            logger.warn(`${player} attempted to answer twice`);
            return res.status(400).json({ error: 'You have already answered this question' });
        }
        
        // Clear hint flag when submitting new answer
        state.showHint = false;
        
        // Process the answer
        state = processAnswer(state, player, answer, questions);
        await saveGameState(state);
        
        logger.info(`✓ Answer from ${player} processed successfully: "${answer}"`);
        logger.debug(`New state - InDisagreement: ${state.inDisagreement}, CurrentQuestion: ${state.currentQuestion}`);
        
        res.json({
            success: true,
            message: 'Answer submitted',
            waitingForOther: state.answers[player === CONFIG.PLAYERS.LACHLAN ? CONFIG.PLAYERS.LEIGH : CONFIG.PLAYERS.LACHLAN] === null
        });
    } catch (error) {
        logger.error('Error in /api/answer', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to process answer' });
    }
});

/**
 * POST /api/consensus - Submit consensus answer
 * Each player submits their agreed answer independently
 */
app.post('/api/consensus', async (req, res) => {
    const { player, answer } = req.body;
    
    logger.info(`POST /api/consensus - Player: ${player}, Answer: "${answer}"`);
    
    if (!isValidPlayer(player)) {
        logger.warn(`Invalid player in /api/consensus: ${player}`);
        return res.status(400).json({ error: 'Invalid player' });
    }
    
    if (!answer) {
        logger.warn(`Missing consensus answer from ${player}`);
        return res.status(400).json({ error: 'Answer is required' });
    }
    
    try {
        let state = await loadGameState();
        const questions = await loadQuestions();
        
        logger.debug(`Current state - Question: ${state.currentQuestion}, InDisagreement: ${state.inDisagreement}`);
        logger.debug(`Consensus answers before - Lachlan: "${state.consensusAnswers.lachlan}", Leigh: "${state.consensusAnswers.leigh}"`);
        
        if (!state.inDisagreement) {
            logger.warn('Attempt to submit consensus when not in disagreement mode');
            return res.status(400).json({ error: 'Not in consensus mode' });
        }
        
        const currentQ = questions[state.currentQuestion];
        
        // Validate answer is one of the choices
        if (!isValidAnswer(answer, currentQ.choices)) {
            logger.warn(`Invalid consensus answer from ${player}: "${answer}"`);
            logger.debug(`Valid choices: ${JSON.stringify(currentQ.choices)}`);
            return res.status(400).json({ error: 'Invalid answer choice' });
        }
        
        // Record this player's consensus answer
        state.consensusAnswers[player] = answer;
        logger.info(`✓ Recorded ${player}'s consensus answer: "${answer}"`);
        
        const otherPlayer = player === CONFIG.PLAYERS.LACHLAN ? CONFIG.PLAYERS.LEIGH : CONFIG.PLAYERS.LACHLAN;
        
        // Check if both players have submitted consensus answers
        if (state.consensusAnswers[otherPlayer] !== null) {
            logger.info('Both players have submitted consensus answers, checking agreement...');
            
            const lachlanConsensus = state.consensusAnswers.lachlan;
            const leighConsensus = state.consensusAnswers.leigh;
            
            logger.info(`Lachlan consensus: "${lachlanConsensus}"`);
            logger.info(`Leigh consensus: "${leighConsensus}"`);
            
            if (lachlanConsensus === leighConsensus) {
                // They agree on consensus answer
                const consensusAnswer = lachlanConsensus;
                const isCorrect = consensusAnswer === currentQ.correct_answer;
                
                logger.info(`✓ Consensus reached: "${consensusAnswer}"`);
                logger.info(`Consensus answer is ${isCorrect ? 'CORRECT ✓' : 'INCORRECT ✗'}`);
                logger.info(`Correct answer: "${currentQ.correct_answer}"`);
                
                // Record in history
                state.history.push({
                    question: state.currentQuestion,
                    questionText: currentQ.question,
                    initialAnswers: {
                        lachlan: state.answers.lachlan,
                        leigh: state.answers.leigh
                    },
                    consensusAnswer: consensusAnswer,
                    correctAnswer: currentQ.correct_answer,
                    wasCorrect: isCorrect,
                    wasConsensus: true,
                    timestamp: new Date().toISOString()
                });
                
                if (isCorrect) {
                    // Correct! Advance to next question
                    const oldQuestion = state.currentQuestion;
                    state.currentQuestion++;
                    state.answers = { lachlan: null, leigh: null };
                    state.consensusAnswers = { lachlan: null, leigh: null };
                    state.inDisagreement = false;
                    state.showHint = false;
                    
                    logger.info(`✓ Advancing from question ${oldQuestion} to question ${state.currentQuestion}`);
                    
                    // Check if game is complete
                    if (state.currentQuestion >= questions.length) {
                        state.completed = true;
                        logger.info('🎉 GAME COMPLETED!');
                    }
                } else {
                    // Wrong! Show hint and reset to original question
                    logger.info('✗ Consensus answer WRONG - Showing hint and resetting to original question');
                    state.answers = { lachlan: null, leigh: null };
                    state.consensusAnswers = { lachlan: null, leigh: null };
                    state.inDisagreement = false;
                    state.showHint = true;
                    logger.info(`Hint will be shown: "${currentQ.hint}"`);
                }
            } else {
                // Still disagreeing! Reset consensus answers and stay in consensus mode
                logger.warn('⚠ Still disagreeing on consensus!');
                logger.warn(`  Lachlan says: "${lachlanConsensus}"`);
                logger.warn(`  Leigh says: "${leighConsensus}"`);
                logger.info('Resetting consensus answers, staying in consensus mode');
                state.consensusAnswers = { lachlan: null, leigh: null };
                // Keep inDisagreement = true
            }
        } else {
            logger.info(`Waiting for ${otherPlayer} to submit consensus answer...`);
        }
        
        await saveGameState(state);
        logger.info('✓ Consensus answer processed successfully');
        
        res.json({
            success: true,
            message: 'Consensus answer submitted',
            waitingForOther: state.consensusAnswers[otherPlayer] === null && state.inDisagreement
        });
    } catch (error) {
        logger.error('Error in /api/consensus', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to process consensus answer' });
    }
});

/**
 * POST /api/resolve - Legacy endpoint, redirects to /api/consensus
 * Kept for backwards compatibility
 */
app.post('/api/resolve', async (req, res) => {
    logger.warn('Using legacy /api/resolve endpoint, should use /api/consensus instead');
    
    // If old format (single agreedAnswer), convert to new format
    if (req.body.agreedAnswer && !req.body.player) {
        logger.error('Legacy /api/resolve called without player - cannot process');
        return res.status(400).json({ error: 'Player parameter required. Use /api/consensus endpoint.' });
    }
    
    // Forward to consensus endpoint
    req.url = '/api/consensus';
    return app._router.handle(req, res);
});

/**
 * POST /api/reset - Reset game state
 * Administrative endpoint to restart the game
 */
app.post('/api/reset', async (req, res) => {
    try {
        logger.warn('Game reset requested');
        const newState = createInitialState();
        await saveGameState(newState);
        logger.info('Game state reset successfully');
        res.json({ success: true, message: 'Game reset successfully' });
    } catch (error) {
        logger.error('Error in /api/reset', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to reset game' });
    }
});

// ============================================
// ERROR HANDLING
// ============================================

/**
 * 404 handler for unknown routes
 */
app.use((req, res) => {
    logger.warn(`404 Not Found: ${req.method} ${req.url}`);
    res.status(404).json({ error: 'Not found' });
});

/**
 * Global error handler
 * Catches any unhandled errors and returns appropriate response
 */
app.use((err, req, res, next) => {
    logger.error('Unhandled error', { 
        error: err.message, 
        stack: err.stack,
        url: req.url,
        method: req.method
    });
    
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// ============================================
// SERVER STARTUP
// ============================================

/**
 * Start the server
 * Initializes environment and begins listening for connections
 */
async function startServer() {
    try {
        await initializeEnvironment();
        
        app.listen(CONFIG.PORT, () => {
            logger.info(`=================================================`);
            logger.info(`  Royal Edinburgh Tattoo Trivia Game Server`);
            logger.info(`=================================================`);
            logger.info(`  Server running on port ${CONFIG.PORT}`);
            logger.info(`  Game URLs:`);
            logger.info(`    Lachlan: http://localhost:${CONFIG.PORT}/game?player=lachlan`);
            logger.info(`    Leigh:   http://localhost:${CONFIG.PORT}/game?player=leigh`);
            logger.info(`  Logs: ${CONFIG.LOG_FILE}`);
            logger.info(`=================================================`);
        });
    } catch (error) {
        logger.error('Failed to start server', { error: error.message, stack: error.stack });
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    process.exit(0);
});

// Start the server
startServer();
