FROM node:18

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    libc6 \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install
RUN npm install crypto-browserify stream-browserify

# Copy the rest of the application
COPY . .

# Create a file to fix crypto issue
RUN echo "global.crypto = require('crypto');" > crypto-fix.js

# Set environment variables to load the fix
ENV NODE_OPTIONS="--require ./crypto-fix.js"

# Start the bot
CMD ["node", "index.js"] 