#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

while true; do
    clear
    echo -e "${GREEN}Airlibrary Bot Management${NC}"
    echo "----------------------"
    echo "1. Start Bot"
    echo "2. Stop Bot"
    echo "3. Restart Bot"
    echo "4. Show Status"
    echo "5. Show Logs"
    echo "6. Exit"
    echo "----------------------"
    echo -n "Enter your choice (1-6): "
    read choice
    
    case $choice in
        1) 
            echo -e "${YELLOW}Starting bot...${NC}"
            ./manage_bot.sh start
            ;;
        2) 
            echo -e "${YELLOW}Stopping bot...${NC}"
            ./manage_bot.sh stop
            ;;
        3) 
            echo -e "${YELLOW}Restarting bot...${NC}"
            ./manage_bot.sh restart
            ;;
        4) 
            echo -e "${YELLOW}Checking status...${NC}"
            ./manage_bot.sh status
            ;;
        5) 
            echo -e "${YELLOW}Showing logs...${NC}"
            ./manage_bot.sh logs
            ;;
        6) 
            echo -e "${GREEN}Exiting...${NC}"
            exit 0
            ;;
        *) 
            echo -e "${RED}Invalid choice${NC}"
            ;;
    esac
    
    echo -e "\n${YELLOW}Press Enter to continue...${NC}"
    read
done 