const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const WALLETS_PATH  = path.resolve(__dirname, '..', 'wallets.json');
const SETTINGS_PATH = path.resolve(__dirname, '..', 'settings.json');

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

const DEFAULT_SETTINGS = {
  amount_usd: parseFloat(process.env.DEFAULT_COPY_AMOUNT_USD) || 50,
  range_pct: 20, // % below current price for one-side lower LP
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

module.exports = {
  GMGN_API_KEY: process.env.GMGN_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  POLL_INTERVAL_MS: (parseInt(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000,
  DEFAULT_COPY_AMOUNT_USD: parseFloat(process.env.DEFAULT_COPY_AMOUNT_USD) || 50,
  loadWallets,
  saveWallets,
  loadSettings,
  saveSettings,
};
