require('./logger');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const WALLETS_PATH         = path.resolve(__dirname, '..', 'wallets.json');
const SETTINGS_PATH        = path.resolve(__dirname, '..', 'settings.json');
const POSITIONS_CACHE_PATH = path.resolve(__dirname, '..', 'positions_cache.json');
const TRADE_HISTORY_PATH   = path.resolve(__dirname, '..', 'trade_history.json');

function loadWallets() {
  try {
    const raw = fs.readFileSync(WALLETS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((w) => {
      let chains = w.chains;
      if (!chains) {
        if (w.chain) {
          chains = w.chain === 'all' || w.chain === 'both' ? ['robinhood', 'bsc'] : [w.chain];
        } else {
          chains = ['robinhood', 'bsc'];
        }
      }
      return {
        ...w,
        chain: chains[0] || 'robinhood',
        chains,
      };
    });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('⚠️ [CONFIG] Failed to load wallets.json:', err.message);
    }
    return [];
  }
}

function saveWallets(wallets) {
  try {
    fs.writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2));
    console.log(`💾 [CONFIG] Saved ${wallets.length} tracked wallets to wallets.json`);
  } catch (err) {
    console.error('❌ [CONFIG] Failed to save wallets.json:', err.message);
  }
}

const DEFAULT_SETTINGS = {
  amount_usd: parseFloat(process.env.DEFAULT_COPY_AMOUNT_USD) || 50,
  range_pct: 20, // % below current price for one-side lower LP
  tp_pct: 30, // % price increase to trigger Take Profit
  sl_pct: 15, // % price drop to trigger Stop Loss
  auto_close_enabled: true, // Auto close LP position when TP/SL is hit
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('⚠️ [CONFIG] Failed to load settings.json:', err.message);
    }
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log(`💾 [CONFIG] Saved settings to settings.json ($${settings.amount_usd}, -${settings.range_pct}%, TP: +${settings.tp_pct}%, SL: -${settings.sl_pct}%, AutoClose: ${settings.auto_close_enabled ? 'ON' : 'OFF'})`);
  } catch (err) {
    console.error('❌ [CONFIG] Failed to save settings.json:', err.message);
  }
}

function loadPositionsCache() {
  try {
    const raw = fs.readFileSync(POSITIONS_CACHE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('⚠️ [CONFIG] Failed to load positions_cache.json:', err.message);
    }
    return {};
  }
}

function savePositionsCache(cache) {
  try {
    fs.writeFileSync(POSITIONS_CACHE_PATH, JSON.stringify(cache, null, 2));
    console.log(`💾 [CONFIG] Saved positions cache to positions_cache.json (${Object.keys(cache).length} cached positions)`);
  } catch (err) {
    console.error('❌ [CONFIG] Error saving positions cache:', err.message);
  }
}

function loadTradeHistory() {
  try {
    const raw = fs.readFileSync(TRADE_HISTORY_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('⚠️ [CONFIG] Failed to load trade_history.json:', err.message);
    }
    return [];
  }
}

function saveTradeHistory(history) {
  try {
    fs.writeFileSync(TRADE_HISTORY_PATH, JSON.stringify(history, null, 2));
    console.log(`💾 [CONFIG] Saved ${history.length} trades to trade_history.json`);
  } catch (err) {
    console.error('❌ [CONFIG] Error saving trade history:', err.message);
  }
}

function recordClosedTrade(tradeData) {
  const history = loadTradeHistory();
  const entry = {
    id: tradeData.tokenId || tradeData.id || Date.now().toString(),
    tokenId: tradeData.tokenId,
    protocol: (tradeData.protocol || 'v4').toUpperCase(),
    pair: tradeData.pair || `${tradeData.symbol0 || 'TOKEN'}/${tradeData.symbol1 || 'USDG'}`,
    tokenSymbol: tradeData.tokenSymbol || tradeData.symbol0 || 'TOKEN',
    depTotalUsd: Number(tradeData.depTotalUsd || 0),
    closedTotalUsd: Number(tradeData.closedTotalUsd || 0),
    pnlUsd: Number(tradeData.pnlUsd || 0),
    pnlPercent: Number(tradeData.pnlPercent || 0),
    closedAt: new Date().toISOString(),
    closeTxHash: tradeData.closeTxHash || null,
    swapTxHash: tradeData.swapTxHash || null,
  };
  history.unshift(entry);
  saveTradeHistory(history);
  return entry;
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
  loadPositionsCache,
  savePositionsCache,
  loadTradeHistory,
  saveTradeHistory,
  recordClosedTrade,
};

