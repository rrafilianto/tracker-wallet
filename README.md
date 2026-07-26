# 🚀 Robinhood Wallet Tracker & Uniswap V3/V4 Automated LP Bot

An automated Telegram bot designed for real-time tracking of crypto wallet activities on **Robinhood Chain**, equipped with an advanced **Uniswap V3 & V4 Automated LP Copy-Trading Engine**.

---

## ✨ Features

- **🔔 Real-Time Transaction Monitoring**  
  Get instant Telegram notifications when tracked wallets execute trades, transfers, or liquidity transactions on Robinhood Chain (via GMGN OpenAPI + Alchemy/Blockscout RPC log decoders).

- **⚡ Automated Uniswap V3 & V4 LP Copy-Trading**  
  - One-click LP copy deployment directly from Telegram alerts or by sending any Token Contract Address.
  - Automatically discovers available Uniswap V3 and V4 pools across standard and custom fee tiers (0.01% up to 10.00%).
  - Single-sided or custom concentrated liquidity placement below current market price.
  - Automatic quote token deficit swap (e.g. automatically converts USDG → WETH if the pool requires WETH).

- **💼 Portfolio & LP Position Management**  
  - `/mywallet` — Monitor your executor wallet's native ETH, USDG, WETH, and ERC-20 token balances.
  - `/mypools` — View all active Uniswap V3 & V4 LP positions, live price range status (**🟢 In Range** / **🔴 Out of Range**), and close positions instantly with automatic liquidation & swap back to USDG.

- **⚙️ Interactive Settings UI**  
  - `/settings` — Interactively adjust default copy amount ($10, $25, $50, $100, $200, $500) and LP tick range bounds (-5% to -75% below price) using inline keyboard buttons.

- **🏷️ Wallet Management & Analytics**  
  - `/tag` — Assign custom nicknames/labels to tracked wallet addresses.
  - `/stats` — View 7-day wallet performance, PnL, win rate, trade counts, and current token holdings via GMGN OpenAPI.

---

## 🛠️ Tech Stack & Smart Contract Addresses

- **Runtime:** Node.js (v18+) & Ethers.js v6
- **SDKs:** `@uniswap/v4-sdk`, `@uniswap/v3-sdk`, `@uniswap/sdk-core`
- **Data Providers:** GMGN OpenAPI, Alchemy RPC, Blockscout API, DexScreener API
- **Supported Network:** Robinhood Chain (EVM)

### Robinhood Chain Contract References
| Protocol / Token | Contract Address |
|---|---|
| **Uniswap V4 POSM** | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| **Uniswap V4 StateView** | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| **Uniswap V3 Factory** | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| **Uniswap V3 POSM** | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| **Universal Router** | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| **USDG Token** | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| **WETH Token** | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

---

## 🤖 Telegram Commands

| Command | Arguments | Description |
|---|---|---|
| `/start` / `/help` | — | Display bot commands and menu |
| `/track` | `<address>` | Start tracking a wallet on Robinhood Chain |
| `/untrack` | `<address>` | Stop tracking a wallet |
| `/tag` | `<address> <label>` | Set custom nickname/tag for a tracked wallet |
| `/list` | — | List all currently tracked wallets with tags |
| `/stats` | `<address>` | View 7d PnL, win rate, stats & token holdings |
| `/mywallet` | — | View executor wallet balances (ETH, USDG, WETH, tokens) |
| `/mypools` | — | View active Uniswap LP positions with option to close & swap back to USDG |
| `/settings` | — | Interactive menu to set LP copy amount (USDG) and range % |
| `/chains` | — | Show supported chains (`robinhood`) |

> 💡 **Auto-Deploy Shortcut:** Simply paste any Token Contract Address (`0x...`) directly into the bot chat to trigger instant Uniswap pool scanning & LP deployment!

---

## 📋 Prerequisites

1. **Node.js** v18 or higher
2. **Telegram Bot Token** (Create via [@BotFather](https://t.me/BotFather))
3. **Telegram Chat ID** (Get via `https://api.telegram.org/bot<TOKEN>/getUpdates`)
4. **GMGN OpenAPI Key** (Free read-only key from [GMGN AI](https://gmgn.ai/ai))
5. **Alchemy API Key** (RPC provider for Robinhood Chain)
6. **EVM Wallet Private Key** (Funded with ETH for gas & USDG for LP deployment)

---

## 🚀 Quick Start & Installation

### 1. Clone & Install Dependencies
```bash
git clone <repository-url>
cd tracker-wallet
npm install
```

### 2. Generate GMGN Key Pair (if needed)
Generate an Ed25519 key pair to register at https://gmgn.ai/ai:
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

### 3. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Configure your `.env` variables:
```env
# GMGN API & Telegram Settings
GMGN_API_KEY=gmgn_xxx
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=123456789
POLL_INTERVAL_SECONDS=60

# Alchemy RPC Settings
ALCHEMY_API_KEY=your_alchemy_api_key
ALCHEMY_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/your_alchemy_api_key

# Robinhood Chain Executor Wallet & LP Settings
EXECUTIVE_PRIVATE_KEY=0x_your_private_key_here
DEFAULT_COPY_AMOUNT_USD=50
SLIPPAGE_TOLERANCE_PCT=0.5
TARGET_QUOTE_TOKEN=USDG
```

### 4. Running the Bot

**Development / Local Mode:**
```bash
npm start
```

**Production Mode (using PM2):**
```bash
npm run pm2:start
```

PM2 Utility Commands:
```bash
npm run pm2:status    # Check process status
npm run pm2:logs      # View live logs
npm run pm2:restart   # Restart bot process
npm run pm2:stop      # Stop bot process
```

---

## 📂 Project Structure

```
tracker-wallet/
├── src/
│   ├── index.js          # Main entry point, polling loop, Telegram message & command router
│   ├── uniswap-executor.js# Uniswap V3 & V4 position minting, closing, quote auto-swapping
│   ├── rpc-decoder.js     # Alchemy & Blockscout RPC transaction log decoder & DexScreener helper
│   ├── gmgn-api.js       # GMGN OpenAPI client (wallet activities, stats, holdings)
│   ├── telegram.js       # Telegram Bot API wrapper, inline keyboards, HTML formatting
│   └── config.js         # Settings & tracked wallet persistence loader
├── .env.example          # Template environment file
├── ecosystem.config.js   # PM2 production process configuration
├── wallets.json          # Tracked wallet database (managed via bot commands)
└── package.json          # Node.js dependencies & scripts
```

---

## 🛡️ License

This project is licensed under the **ISC License**.

