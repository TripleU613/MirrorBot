#!/bin/bash
# Seeds Google Play auth tokens into the MirrorBot CF Worker (one-time setup).
# Tokens last weeks–months. Re-run when bot says "token expired".
#
# Requires: gplay-apk-downloader working locally (./gplay auth)

set -e

WORKER_URL="https://mirrorbot.goyslopgateway.workers.dev"
GPLAY_DIR="$(dirname "$0")/../gplay-apk-downloader"

echo "[seed] Getting anonymous Google Play tokens via local gplay..."

cd "$GPLAY_DIR"

# Ensure venv exists
if [ ! -d ".venv" ]; then
  echo "[seed] Setting up gplay virtualenv..."
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

# Get tokens for both architectures
ARM64_TOKEN=$(.venv/bin/python3 -c "
import sys, os
sys.path.insert(0, '.')
os.environ['PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION'] = 'python'
from gplay_downloader import get_auth_token
tok = get_auth_token('arm64-v8a')
print(tok)
" 2>/dev/null)

ARMEABI_TOKEN=$(.venv/bin/python3 -c "
import sys, os
sys.path.insert(0, '.')
os.environ['PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION'] = 'python'
from gplay_downloader import get_auth_token
tok = get_auth_token('armeabi-v7a')
print(tok)
" 2>/dev/null)

if [ -z "$ARM64_TOKEN" ] && [ -z "$ARMEABI_TOKEN" ]; then
  # Fallback: read from cached auth files
  ARM64_TOKEN=$(python3 -c "import json; d=json.load(open(os.path.expanduser('~/.gplay-auth.json'))); print(d.get('auth',''))" 2>/dev/null || echo "")
  ARMEABI_TOKEN=$(python3 -c "import json; d=json.load(open(os.path.expanduser('~/.gplay-auth-armv7.json'))); print(d.get('auth',''))" 2>/dev/null || echo "")
fi

if [ -z "$ARM64_TOKEN" ] && [ -z "$ARMEABI_TOKEN" ]; then
  echo "[seed] ERROR: Could not get tokens. Run: cd gplay-apk-downloader && ./gplay auth"
  exit 1
fi

echo "[seed] Got tokens. Seeding into Worker..."

RESPONSE=$(curl -s -X POST "$WORKER_URL/seed-token" \
  -H "Content-Type: application/json" \
  -d "{\"arm64\":\"$ARM64_TOKEN\",\"armeabi\":\"$ARMEABI_TOKEN\"}")

echo "[seed] Worker response: $RESPONSE"
echo ""
echo "✅ Done. MirrorBot can now download APKs from Google Play."
echo "   Tokens expire in ~60 days. Re-run this script then."
