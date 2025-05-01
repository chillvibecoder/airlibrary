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

# Copy the rest of the application
COPY . .

# Set environment variables for crypto
ENV NODE_OPTIONS="--require crypto"

# Start the bot
CMD ["node", "index.js"] 