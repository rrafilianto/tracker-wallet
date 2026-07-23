# Wallet Tracker Bot

A Telegram bot for monitoring crypto wallet activity across multiple chains using the [GMGN OpenAPI](https://gmgn.ai/).

## Features

- **Real-time notifications** — Get Telegram alerts when a tracked wallet makes a transaction
- **Multi-chain** — Supports Solana, Ethereum, BSC, Base, Robinhood
- **Wallet stats** — View PnL, win rate, trade count, average hold time
- **Auto-detect chain** — Automatically detects SOL vs EVM addresses

## Commands

| Command | Description |
|---------|-------------|
| `/track <addr> [chain]` | Start tracking a wallet |
| `/untrack <addr>` | Stop tracking a wallet |
| `/list` | List all tracked wallets |
| `/stats <addr> [chain]` | View wallet PnL & stats |
| `/chains` | Show supported chains |
| `/help` | Show all commands |

**Chains:** `sol`, `eth`, `bsc`, `base`, `robinhood`

## Prerequisites

- Node.js 18+
- [GMGN API Key](https://gmgn.ai/ai) (free, read-only)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Telegram Chat ID

## Setup

### 1. Get GMGN API Key

Generate an Ed25519 key pair:

```bash
node -e "
const crypto = require('crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
console.log('PUBLIC KEY (upload to GMGN):');
console.log(publicKey);
console.log('PRIVATE KEY (keep secret):');
console.log(privateKey);
"
```

Upload the **public key** at https://gmgn.ai/ai to get your API Key.

### 2. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow instructions
3. Save the bot token

### 3. Find Your Chat ID

Send a message to your bot, then visit:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Your Chat ID will be in the response under `message.chat.id`.

### 4. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
GMGN_API_KEY=gmgn_xxx
TELEGRAM_BOT_TOKEN=xxx:xxx
TELEGRAM_CHAT_ID=123456
POLL_INTERVAL_SECONDS=60
```

### 5. Start

```bash
npm install
npm start
```

## Deployment (PM2)

```bash
npm install -g pm2
npm run pm2:start
```

| Command | Description |
|---------|-------------|
| `npm run pm2:start` | Start with PM2 |
| `npm run pm2:stop` | Stop bot |
| `npm run pm2:restart` | Restart bot |
| `npm run pm2:logs` | View logs |
| `npm run pm2:status` | Check status |

## Project Structure

```
├── src/
│   ├── index.js        # Entry point, polling, command handler
│   ├── gmgn-api.js     # GMGN OpenAPI client
│   ├── telegram.js     # Telegram bot & formatters
│   └── config.js       # Config loader
├── .env                # API keys & config
├── wallets.json        # Tracked wallets (auto-managed)
└── ecosystem.config.js # PM2 config
```

## Tech Stack

- **Node.js** — Runtime
- **GMGN OpenAPI** — On-chain data
- **node-telegram-bot-api** — Telegram integration
