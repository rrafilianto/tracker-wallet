const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const WALLETS_PATH = path.resolve(__dirname, '..', 'wallets.json');

function loadWallets() {
  try {
    const raw = fs.readFileSync(WALLETS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveWallets(wallets) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2));
}

module.exports = {
  GMGN_API_KEY: process.env.GMGN_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MS: (parseInt(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000,
  loadWallets,
  saveWallets,
};
