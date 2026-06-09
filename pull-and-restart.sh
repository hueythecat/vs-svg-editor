#!/bin/bash
APP_NAME="vs-svg-editor"

cd ~/git/$APP_NAME || { echo "cd failed"; exit 1; }

BEFORE=$(git rev-parse HEAD)
git pull origin main >> ~/logs/$APP_NAME.log 2>&1
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" != "$AFTER" ]; then
  echo "$(date): Changes detected, reloading..." >> ~/logs/$APP_NAME.log
  if git diff --name-only "$BEFORE" "$AFTER" | grep -q "package.json"; then
    echo "$(date): package.json changed, running npm install..." >> ~/logs/$APP_NAME.log
    npm install
  fi
  #npm run build
  pm2 reload $APP_NAME
else
  echo "$(date): No changes." >> ~/logs/$APP_NAME.log
fi
