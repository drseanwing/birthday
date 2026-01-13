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
        inDisagreement: false,
        disagreementResolved: false,
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
    logger.debug(`Updated ${player}'s answer`);
    
    // Check if both players have answered
    if (state.answers[otherPlayer] !== null) {
        logger.info('Both players have answered');
        
        const lachlanAnswer = state.answers.lachlan;
        const leighAnswer = state.answers.leigh;
        
        // Check for agreement
        if (lachlanAnswer === leighAnswer) {
            logger.info(`Players agree on answer: "${lachlanAnswer}"`);
            
            // Check if answer is correct
            const isCorrect = lachlanAnswer === currentQ.correct_answer;
            logger.info(`Answer is ${isCorrect ? 'CORRECT' : 'INCORRECT'}`);
            
            // Record in history
            state.history.push({
                question: state.currentQuestion,
                questionText: currentQ.question,
                agreedAnswer: lachlanAnswer,
                correctAnswer: currentQ.correct_answer,
                wasCorrect: isCorrect,
                timestamp: new Date().toISOString()
            });
            
            if (isCorrect) {
                // Move to next question
                state.currentQuestion++;
                state.answers = { lachlan: null, leigh: null };
                state.inDisagreement = false;
                
                // Check if game is complete
                if (state.currentQuestion >= questions.length) {
                    state.completed = true;
                    logger.info('GAME COMPLETED! All questions answered correctly.');
                }
            } else {
                // They agreed but were wrong - stay on question
                logger.info('Players agreed but answer was incorrect, resetting answers');
                state.answers = { lachlan: null, leigh: null };
            }
        } else {
            // Disagreement detected
            logger.warn(`DISAGREEMENT: Lachlan said "${lachlanAnswer}", Leigh said "${leighAnswer}"`);
            state.inDisagreement = true;
            state.disagreementResolved = false;
        }
    } else {
        logger.debug(`Waiting for ${otherPlayer} to answer`);
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
    
    const currentQ = questions[state.currentQuestion];
    const isCorrect = agreedAnswer === currentQ.correct_answer;
    
    logger.info(`Agreed answer is ${isCorrect ? 'CORRECT' : 'INCORRECT'}`);
    
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
    
    if (isCorrect) {
        // Move to next question
        state.currentQuestion++;
        state.answers = { lachlan: null, leigh: null };
        state.inDisagreement = false;
        state.disagreementResolved = false;
        
        // Check if game is complete
        if (state.currentQuestion >= questions.length) {
            state.completed = true;
            logger.info('GAME COMPLETED after disagreement resolution!');
        }
    } else {
        // They agreed but were wrong - stay on question, reset disagreement
        logger.info('Disagreement resolved but answer incorrect, resetting');
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
            completed: state.completed,
            playerAnswered: state.answers[player] !== null,
            otherPlayerAnswered: state.answers[player === CONFIG.PLAYERS.LACHLAN ? CONFIG.PLAYERS.LEIGH : CONFIG.PLAYERS.LACHLAN] !== null,
            playerAnswer: state.answers[player]
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
        
        // Validate question index
        if (state.currentQuestion >= questions.length) {
            logger.warn(`Attempt to answer beyond last question by ${player}`);
            return res.status(400).json({ error: 'No more questions' });
        }
        
        const currentQ = questions[state.currentQuestion];
        
        // Validate answer is one of the choices
        if (!isValidAnswer(answer, currentQ.choices)) {
            logger.warn(`Invalid answer choice from ${player}: ${answer}`);
            return res.status(400).json({ error: 'Invalid answer choice' });
        }
        
        // Check if player already answered
        if (state.answers[player] !== null && !state.inDisagreement) {
            logger.warn(`${player} attempted to answer twice`);
            return res.status(400).json({ error: 'You have already answered this question' });
        }
        
        // Process the answer
        state = processAnswer(state, player, answer, questions);
        await saveGameState(state);
        
        logger.info(`Answer from ${player} processed successfully`);
        
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
 * POST /api/resolve - Resolve disagreement
 * Processes agreed-upon answer after disagreement
 */
app.post('/api/resolve', async (req, res) => {
    const { agreedAnswer } = req.body;
    
    if (!agreedAnswer) {
        logger.warn('Missing agreed answer in /api/resolve');
        return res.status(400).json({ error: 'Agreed answer is required' });
    }
    
    try {
        let state = await loadGameState();
        const questions = await loadQuestions();
        
        if (!state.inDisagreement) {
            logger.warn('Attempt to resolve when not in disagreement');
            return res.status(400).json({ error: 'Not in disagreement state' });
        }
        
        const currentQ = questions[state.currentQuestion];
        
        // Validate agreed answer is one of the choices
        if (!isValidAnswer(agreedAnswer, currentQ.choices)) {
            logger.warn(`Invalid agreed answer: ${agreedAnswer}`);
            return res.status(400).json({ error: 'Invalid answer choice' });
        }
        
        // Process the resolution
        state = processDisagreementResolution(state, agreedAnswer, questions);
        await saveGameState(state);
        
        logger.info('Disagreement resolved successfully');
        
        res.json({
            success: true,
            message: 'Disagreement resolved'
        });
    } catch (error) {
        logger.error('Error in /api/resolve', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Failed to resolve disagreement' });
    }
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
