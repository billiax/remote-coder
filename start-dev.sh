#!/usr/bin/env bash
set -e

# Hot-reload dev server — runs TypeScript directly via ts-node
# Tracks its own PID to safely kill only its own previous instance

PID_FILE="/tmp/remote-coder-dev.pid"

# Kill our previous dev instance (by PID file)
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[dev] Stopping previous instance (PID $OLD_PID) and children..."
    # Kill the process group (npx + ts-node child) so nothing lingers
    kill -- -"$OLD_PID" 2>/dev/null || kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

cleanup() {
  echo ""
  echo "[dev] Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup INT TERM

echo "[dev] Starting dev server with hot reload..."
echo "[dev] Press Ctrl+C to stop."

# Show Cloudflare tunnel URL if one is running
CF_URL=$(cat /tmp/cloudflared*.log 2>/dev/null | grep -o 'https://[^ ]*trycloudflare.com' | tail -1)
if [ -n "$CF_URL" ]; then
  echo "[dev] Cloudflare tunnel: $CF_URL"
fi

while true; do
  npx ts-node src/server.ts &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  echo "[dev] Server started (PID $SERVER_PID)"

  # Wait for ts-node compilation to finish before watching for changes
  sleep 3

  # Check server is still alive after startup
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[dev] Server failed to start. Not restarting (fix the error first)."
    rm -f "$PID_FILE"
    exit 1
  fi

  # Watch for file changes (only user-initiated edits, not ts-node reads)
  FILE_CHANGED=false
  if command -v inotifywait &>/dev/null; then
    # inotifywait (no -m) exits after the first matching event
    inotifywait -r -e modify,create,delete --include '\.(ts|json|md|html)$' src/ &
    WATCH_PID=$!
    # Wait for either: file change (inotifywait exits) or server crash
    wait -n $SERVER_PID $WATCH_PID 2>/dev/null
    # Determine what happened
    if ! kill -0 $WATCH_PID 2>/dev/null; then
      FILE_CHANGED=true
    fi
    kill $SERVER_PID 2>/dev/null || true
    kill $WATCH_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
    wait $WATCH_PID 2>/dev/null || true
  else
    # Fallback: poll for changes every 2s
    HASH=$(find src/ -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.html' | sort | xargs stat -c '%Y %n' 2>/dev/null | md5sum)
    while true; do
      sleep 2
      NEW_HASH=$(find src/ -name '*.ts' -o -name '*.json' -o -name '*.md' -o -name '*.html' | sort | xargs stat -c '%Y %n' 2>/dev/null | md5sum)
      if [ "$HASH" != "$NEW_HASH" ]; then
        echo "[dev] File change detected, restarting..."
        FILE_CHANGED=true
        break
      fi
      if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "[dev] Server exited unexpectedly."
        break
      fi
      HASH="$NEW_HASH"
    done
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
  fi

  if [ "$FILE_CHANGED" = false ]; then
    echo "[dev] Server crashed (no file change detected). Not restarting."
    rm -f "$PID_FILE"
    exit 1
  fi

  echo "[dev] Restarting in 1s..."
  sleep 1
done
