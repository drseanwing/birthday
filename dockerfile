# Royal Edinburgh Tattoo Trivia - Dockerfile
# ============================================
# Multi-stage build for optimized production image
# Includes comprehensive logging and error handling

# Stage 1: Base image with dependencies
# -------------------------------------
FROM node:18-alpine AS base

# Set working directory
WORKDIR /app

# Install production dependencies only
# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies with verbose logging
RUN echo "Installing dependencies..." && \
    npm install --only=production --verbose && \
    echo "Dependencies installed successfully"

# Stage 2: Production image
# -------------------------
FROM node:18-alpine AS production

# Add metadata labels
LABEL maintainer="Sean"
LABEL description="Royal Edinburgh Tattoo Birthday Trivia Game"
LABEL version="1.0"

# Set working directory
WORKDIR /app

# Create non-root user for security
# Running as non-root is a security best practice
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    echo "Created nodejs user (uid=1001, gid=1001)"

# Copy dependencies from base stage
COPY --from=base /app/node_modules ./node_modules

# Copy application files
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs questions.json ./
COPY --chown=nodejs:nodejs package*.json ./
COPY --chown=nodejs:nodejs public ./public/

# Verify critical files exist
RUN ls -la /app/questions.json && \
    echo "✓ questions.json copied successfully" && \
    ls -la /app/server.js && \
    echo "✓ server.js copied successfully"

# Create directories for runtime files with proper permissions
# These need to be writable by the nodejs user
RUN mkdir -p logs && \
    chown -R nodejs:nodejs /app && \
    chmod -R 755 /app && \
    echo "Created logs directory with proper permissions"

# Switch to non-root user
USER nodejs

# Expose the application port
# This is the internal container port (will be mapped to 130188)
EXPOSE 3000

# Set environment variables
# NODE_ENV=production enables production optimizations
ENV NODE_ENV=production
ENV PORT=3000

# Health check to ensure container is running properly
# Checks every 30 seconds, timeout after 3 seconds, 3 retries before unhealthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
# Using exec form to ensure proper signal handling
CMD ["node", "server.js"]

# Build instructions:
# ------------------
# docker build -t tattoo-trivia:latest .
#
# Run instructions:
# ----------------
# docker run -d -p 130188:3000 --name trivia-game tattoo-trivia:latest
#
# View logs:
# ---------
# docker logs -f trivia-game
