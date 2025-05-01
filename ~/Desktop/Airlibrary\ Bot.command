#!/bin/bash
cd /Users/manson/Downloads/airlibrary20250302

while true; do
    clear
    echo "Airlibrary Bot Management"
    echo "----------------------"
    echo "1. Start Bot"
    echo "2. Stop Bot"
    echo "3. Restart Bot"
    echo "4. Show Status"
    echo "5. Show Logs"
    echo "6. Exit"
    echo "----------------------"
    read -p "Enter your choice (1-6): " choice
    
    case $choice in
        1) ./manage_bot.sh start ;;
        2) ./manage_bot.sh stop ;;
        3) ./manage_bot.sh restart ;;
        4) ./manage_bot.sh status ;;
        5) ./manage_bot.sh logs ;;
        6) exit 0 ;;
        *) echo "Invalid choice" ;;
    esac
    
    read -p "Press Enter to continue..."
done 