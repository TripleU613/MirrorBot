#!/bin/bash
# Exposes local FlareSolverr via Cloudflare Tunnel and auto-updates the
# MirrorBot Worker secret (FS_URL). Run this to enable APKMirror access.
#
# Prerequisites: FlareSolverr running, cloudflared installed, gh CLI authed.
# Secrets are read from environment — never hardcoded.

set -e

WORKER_NAME="mirrorbot"
FS_PORT="8191"
TUNNEL_LOG="/tmp/cloudflared-tunnel.log"
TUNNEL_PID_FILE="/tmp/cloudflared-tunnel.pid"

# Read secrets from environment or local config
if [ -f ~/.config/mirrorbot/env ]; then
  # shellcheck disable=SC1090
  source ~/.config/mirrorbot/env
fi

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN (Workers API token) or add to ~/.config/mirrorbot/env}"

# --- Check FlareSolverr ------------------------------------------------
echo "[tunnel] Checking FlareSolverr at localhost:${FS_PORT}..."
if ! curl -sf "http://localhost:${FS_PORT}/v1" -o /dev/null --max-time 5 2>/dev/null; then
  echo "[tunnel] FlareSolverr not responding. Starting it..."
  if [ -d ~/Desktop/FlareSolverr ]; then
    cd ~/Desktop/FlareSolverr && docker compose up -d && cd - > /dev/null
  else
    echo "[tunnel] ERROR: FlareSolverr not running and ~/Desktop/FlareSolverr not found."
    exit 1
  fi
  echo "[tunnel] Waiting for FlareSolverr..."
  until curl -sf "http://localhost:${FS_PORT}/v1" -o /dev/null --max-time 3 2>/dev/null; do sleep 2; done
fi
echo "[tunnel] FlareSolverr is up."

# --- Kill any existing tunnel ------------------------------------------
if [ -f "$TUNNEL_PID_FILE" ]; then
  OLD_PID=$(cat "$TUNNEL_PID_FILE")
  kill "$OLD_PID" 2>/dev/null || true
  rm -f "$TUNNEL_PID_FILE"
fi

# --- Start quick tunnel ------------------------------------------------
echo "[tunnel] Starting Cloudflare Tunnel..."
cloudflared tunnel --url "http://localhost:${FS_PORT}" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

# --- Capture tunnel URL ------------------------------------------------
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oP 'https://[a-zA-Z0-9\-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[tunnel] ERROR: Could not get tunnel URL. Check $TUNNEL_LOG"
  kill "$TUNNEL_PID" 2>/dev/null
  exit 1
fi

echo "[tunnel] Tunnel URL: $TUNNEL_URL"

# --- Update Worker secret ----------------------------------------------
echo "$TUNNEL_URL" | npx wrangler secret put FS_URL --name "$WORKER_NAME" 2>/dev/null
echo ""
echo "✅  MirrorBot → FlareSolverr tunnel is live."
echo "    URL:  $TUNNEL_URL"
echo "    Ctrl+C to stop (bot falls back to direct fetch when stopped)."
echo ""

# --- Cleanup on exit ---------------------------------------------------
cleanup() {
  echo ""
  echo "[tunnel] Stopping tunnel..."
  kill "$TUNNEL_PID" 2>/dev/null || true
  echo "" | npx wrangler secret put FS_URL --name "$WORKER_NAME" 2>/dev/null || true
  rm -f "$TUNNEL_PID_FILE"
  echo "[tunnel] Done."
}
trap cleanup EXIT INT TERM

wait "$TUNNEL_PID"
