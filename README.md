# MirrorBot

Telegram bot that searches APKMirror and resolves direct download links.  
Runs entirely on **Cloudflare Workers** — no server required.

## Architecture

```
Telegram  →  CF Worker (webhook)  →  APKMirror (scraped)
                   ↕
              CF KV (rate-limit state)
```

IP rotation is handled by Cloudflare's distributed edge network — each
Worker request egresses from a geographically distributed PoP, and KV
enforces a minimum 2 s gap between requests to avoid CF 1015/1020 bans.

## Setup

### 1. GitHub secrets (Settings → Secrets → Actions)

| Secret | Value |
|---|---|
| `CF_API_KEY` | Cloudflare Global API Key |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |

### 2. Push to `main` → GitHub Actions deploys automatically

### 3. Register the webhook

After the first deploy, visit:
```
https://mirrorbot.<your-subdomain>.workers.dev/setup
```
This tells Telegram to send updates to the worker.

## Commands

| Command | Description |
|---|---|
| `/search <name>` | Search APKMirror for an app |
| `/dl <url>` | Resolve a direct download link from an APKMirror page |
| `/help` | Show command list |
| `/cancel` | Reset session |

## Optional: CF clearance seeding

If APKMirror starts blocking Workers IPs, set a `CF_CLEARANCE` Worker secret
with a fresh `cf_clearance` cookie value (grab from your browser DevTools).
The worker will include it in all requests.
