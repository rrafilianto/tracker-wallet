const { ethers } = require('ethers');
const rpcDecoder = require('./rpc-decoder');
const tg = require('./telegram');

let provider = null;
let trackedWallets = new Map(); // address (lowercase) => { chain, label }
let onActivityCallback = null;
let onStatusCallback = null;
let isConnected = false;

function getAlchemyWsUrl() {
  if (process.env.ALCHEMY_WS_URL) return process.env.ALCHEMY_WS_URL;
  if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'your_alchemy_api_key_here') {
    return `wss://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  }
  return null;
}

function init(wallets = [], callback = null, statusCallback = null) {
  onActivityCallback = callback;
  onStatusCallback = statusCallback;

  wallets.forEach((w) => {
    if (w.address) {
      trackedWallets.set(w.address.toLowerCase(), {
        address: w.address,
        chain: w.chain || 'robinhood',
        label: w.label || ''
      });
    }
  });

  const wsUrl = getAlchemyWsUrl();
  if (!wsUrl) {
    console.log('[ALCHEMY WS] ALCHEMY_API_KEY not configured. Falling back to HTTP polling.');
    if (onStatusCallback) onStatusCallback(false);
    return false;
  }

  try {
    provider = new ethers.WebSocketProvider(wsUrl);

    provider.websocket.on('open', () => {
      isConnected = true;
      console.log(`[ALCHEMY WS] WebSocket connected to Alchemy (${trackedWallets.size} wallets tracked)`);
      if (onStatusCallback) onStatusCallback(true);
    });

    provider.websocket.on('close', () => {
      isConnected = false;
      console.log('[ALCHEMY WS] WebSocket disconnected. Triggering HTTP polling fallback.');
      if (onStatusCallback) onStatusCallback(false);
    });

    provider.websocket.on('error', (err) => {
      isConnected = false;
      console.error('[ALCHEMY WS] WebSocket error:', err.message);
      if (onStatusCallback) onStatusCallback(false);
    });

    // Listen for new blocks and check for transactions involving tracked wallets
    provider.on('block', async (blockNumber) => {
      try {
        const block = await provider.getBlock(blockNumber, true);
        if (!block || !block.prefetchedTransactions) return;

        for (const tx of block.prefetchedTransactions) {
          const fromAddr = (tx.from || '').toLowerCase();
          const toAddr = (tx.to || '').toLowerCase();

          const matchedWallet = trackedWallets.get(fromAddr) || trackedWallets.get(toAddr);
          if (matchedWallet) {
            handleDetectedTransaction(tx, matchedWallet);
          }
        }
      } catch (e) {
        // Suppress block fetch errors
      }
    });

    return true;
  } catch (err) {
    isConnected = false;
    console.error('[ALCHEMY WS] Failed to initialize WebSocket provider:', err.message);
    if (onStatusCallback) onStatusCallback(false);
    return false;
  }
}

async function handleDetectedTransaction(tx, wallet) {
  try {
    const txHash = tx.hash;
    const transfers = await rpcDecoder.getLiquidityTransfers(wallet.chain, txHash, wallet.address);
    const classification = rpcDecoder.analyzeAndClassifyTx(transfers, wallet.address, tx);

    const activityItem = {
      tx_hash: txHash,
      timestamp: Math.floor(Date.now() / 1000),
      event_type: classification.event_type,
      token_amount: classification.token_amount,
      quote_token_amount: classification.quote_amount,
      cost_usd: classification.cost_usd,
      token: classification.token,
      quote_token: classification.quote_token,
      decodedTransfers: transfers,
      decodedRange: transfers.range || null
    };

    if (onActivityCallback) {
      onActivityCallback(activityItem, wallet);
    } else {
      const buttons = tg.buildTxButtons([activityItem], wallet);
      const formattedText = tg.formatTx([activityItem], wallet);
      await tg.sendMessage(`⚡ <b>[REAL-TIME INSTANT ALERT]</b>\n${formattedText}`, buttons ? { reply_markup: buttons } : {});
    }
  } catch (err) {
    console.error(`[ALCHEMY WS] Error processing detected tx ${tx.hash}:`, err.message);
  }
}

function trackWallet(address, chain = 'robinhood', label = '') {
  if (!address) return;
  trackedWallets.set(address.toLowerCase(), { address, chain, label });
  console.log(`[ALCHEMY WS] Now real-time tracking: ${address}`);
}

function untrackWallet(address) {
  if (!address) return;
  trackedWallets.delete(address.toLowerCase());
  console.log(`[ALCHEMY WS] Stopped real-time tracking: ${address}`);
}

function isWsConnected() {
  return isConnected;
}

function closeWs() {
  if (provider) {
    try {
      provider.destroy();
    } catch {
      // Ignore destroy error
    }
    provider = null;
  }
  isConnected = false;
  console.log('[ALCHEMY WS] WebSocket listener explicitly stopped.');
}

module.exports = {
  init,
  trackWallet,
  untrackWallet,
  isWsConnected,
  closeWs,
};
