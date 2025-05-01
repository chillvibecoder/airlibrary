#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Log file
LOG_FILE="bot.log"
PID_FILE="bot.pid"
MAX_RESTARTS=5
RESTART_DELAY=10

# Function to check if bot is running
is_bot_running() {
    if [ -f "$PID_FILE" ]; then
        pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null; then
            return 0
        fi
    fi
    return 1
}

# Function to start the bot with auto-restart
start_bot() {
    if is_bot_running; then
        echo -e "${YELLOW}Bot is already running${NC}"
        return 1
    fi

    echo -e "${GREEN}Starting WhatsApp bot...${NC}"
    
    # Start the bot with logging and auto-restart
    while true; do
        if ! is_bot_running; then
            DEBUG=baileys* NODE_DEBUG=net,dns node index.js > "$LOG_FILE" 2>&1 &
            echo $! > "$PID_FILE"
            echo -e "${GREEN}Bot started with PID $(cat $PID_FILE)${NC}"
            echo -e "${YELLOW}Check $LOG_FILE for logs${NC}"
        fi

        # Monitor the bot
        while is_bot_running; do
            sleep 5
            # Check if the process is still responding
            if ! kill -0 $(cat "$PID_FILE") 2>/dev/null; then
                echo -e "${RED}Bot process died, restarting...${NC}"
                break
            fi
        done

        # Check if we should continue restarting
        if [ -f "$PID_FILE" ]; then
            rm "$PID_FILE"
        fi

        echo -e "${YELLOW}Waiting $RESTART_DELAY seconds before restart...${NC}"
        sleep $RESTART_DELAY
    done
}

# Function to stop the bot
stop_bot() {
    if [ -f "$PID_FILE" ]; then
        pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null; then
            echo -e "${YELLOW}Stopping WhatsApp bot...${NC}"
            kill "$pid"
            rm "$PID_FILE"
            echo -e "${GREEN}Bot stopped${NC}"
        else
            echo -e "${RED}Bot is not running${NC}"
            rm "$PID_FILE"
        fi
    else
        echo -e "${RED}Bot is not running${NC}"
    fi
}

# Function to show status
show_status() {
    if is_bot_running; then
        echo -e "${GREEN}Bot is running with PID $(cat $PID_FILE)${NC}"
    else
        echo -e "${RED}Bot is not running${NC}"
    fi
}

# Function to show logs
show_logs() {
    if [ -f "$LOG_FILE" ]; then
        tail -n 50 "$LOG_FILE"
    else
        echo -e "${RED}No log file found${NC}"
    fi
}

# Main script
case "$1" in
    start)
        start_bot
        ;;
    stop)
        stop_bot
        ;;
    restart)
        stop_bot
        sleep 2
        start_bot
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac

exit 0 