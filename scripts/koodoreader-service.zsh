#!/bin/zsh
set -euo pipefail

SERVICE="koodoreader"
LABEL="com.carlosz.$SERVICE"
DOMAIN="gui/$(id -u)"
PROJECT_ROOT="/Users/carlosz/service/koodoreader"
SOURCE_PLIST="$PROJECT_ROOT/config/$LABEL.plist"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STDOUT_LOG="$PROJECT_ROOT/logs/$SERVICE.stdout.log"
STDERR_LOG="$PROJECT_ROOT/logs/$SERVICE.stderr.log"

is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

install_service() {
  plutil -lint "$SOURCE_PLIST"
  mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_ROOT/logs"
  cp "$SOURCE_PLIST" "$INSTALLED_PLIST"
  if is_loaded; then
    launchctl bootout "$DOMAIN/$LABEL"
  fi
  launchctl bootstrap "$DOMAIN" "$INSTALLED_PLIST"
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
}

restart_service() {
  if is_loaded; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
  else
    launchctl bootstrap "$DOMAIN" "$INSTALLED_PLIST"
    launchctl enable "$DOMAIN/$LABEL"
    launchctl kickstart -k "$DOMAIN/$LABEL"
  fi
}

case "${1:-status}" in
  install)
    install_service
    ;;
  restart)
    restart_service
    ;;
  stop)
    if is_loaded; then
      launchctl bootout "$DOMAIN/$LABEL"
    fi
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL"
    ;;
  logs)
    touch "$STDOUT_LOG" "$STDERR_LOG"
    tail -n 100 -f "$STDOUT_LOG" "$STDERR_LOG"
    ;;
  *)
    print -u2 "Usage: $0 {install|restart|stop|status|logs}"
    exit 64
    ;;
esac
