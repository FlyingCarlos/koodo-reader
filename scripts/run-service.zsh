#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="/Users/carlosz/service/koodoreader"
LOG_DIR="$PROJECT_ROOT/logs"

mkdir -p "$LOG_DIR"
cd "$PROJECT_ROOT"

if [[ -f "$PROJECT_ROOT/.env" ]]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

export PATH="/Users/carlosz/.nvm/versions/node/v24.16.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec /Users/carlosz/.nvm/versions/node/v24.16.0/bin/node /Users/carlosz/service/koodoreader/scripts/local-server.cjs
