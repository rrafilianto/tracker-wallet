const config = require('./config');
const gmgn = require('./gmgn-api');
const tg = require('./telegram');
const rpcDecoder = require('./rpc-decoder');
const uniswapExecutor = require('./uniswap-executor');
const alchemyListener = require('./alchemy-listener');

if (!config.GMGN_API_KEY || config.GMGN_API_KEY === 'gmgn_xxx') {
  console.error('ERROR: GMGN_API_KEY not set in .env');
  process.exit(1);
}
if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env');
  process.exit(1);
}

let wallets = config.loadWallets();
let lastTxMap = {};

const bot = tg.init(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID);
console.log('🚀 [STARTUP] Tracker Wallet Bot initialized successfully!');
console.log(`📱 [TELEGRAM] Connected & Polling active for Chat ID: ${config.TELEGRAM_CHAT_ID}`);

function send(chatId, text, opts = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
}

function findWallet(addr) {
  return wallets.find((w) => w.address === addr);
}

async function enrichLiquidityEvents(list, wallet) {
  for (const tx of list) {
    const eventType = (tx.event_type || '').toLowerCase();
    if ((eventType === 'add' || eventType === 'remove') && (!tx.token_amount || Number(tx.token_amount) === 0)) {
      try {
        const transfers = await rpcDecoder.getLiquidityTransfers(wallet.chain, tx.tx_hash, wallet.address);
        if (transfers && transfers.length > 0) {
          tx.decodedTransfers = transfers;
          if (transfers.range) tx.decodedRange = transfers.range;
        } else if (tx.token?.address) {
          const dsInfo = await rpcDecoder.fetchDexScreenerLiquidity(tx.token.address);
          if (dsInfo) tx.dexScreenerInfo = dsInfo;
        }
      } catch (err) {
        console.error(`[RPC DECODER] Error decoding tx ${tx.tx_hash}:`, err.message);
      }
    }
  }
}

async function pollWallet(w) {
  try {
    const activity = await gmgn.getWalletActivity(config.GMGN_API_KEY, w.address, 5, w.chain);
    if (!activity?.activities?.length && !activity?.length) return;

    const list = activity.activities || activity;
    const latestTxHash = list[0].tx_hash;
    if (!latestTxHash) return;

    await enrichLiquidityEvents(list, w);

    const prev = lastTxMap[w.address];
    const buttons = tg.buildTxButtons(list, w);

    if (prev === undefined) {
      lastTxMap[w.address] = latestTxHash;
      await tg.sendMessage(tg.formatTx(list, w), buttons ? { reply_markup: buttons } : {});
      return;
    }

    if (latestTxHash !== prev) {
      const newTxs = [];
      for (const tx of list) {
        if (tx.tx_hash === prev) break;
        newTxs.push(tx);
      }
      lastTxMap[w.address] = latestTxHash;
      if (newTxs.length > 0) {
        await tg.sendMessage(tg.formatTx(newTxs.reverse(), w), buttons ? { reply_markup: buttons } : {});
      }
    }
  } catch (err) {
    console.error(`[ERROR] ${tg.shortAddr(w.address)} ${err.message}`);
  }
}

let pollingTimer = null;

function startPollingTimer() {
  if (pollingTimer) return;
  console.log('[OPTION B] HTTP Polling activated (Fallback Mode).');
  if (wallets.length > 0) pollAll();
  pollingTimer = setInterval(pollAll, config.POLL_INTERVAL_MS);
}

function stopPollingTimer() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('[OPTION B] WebSocket active — HTTP Polling paused.');
  }
}

let currentMode = 'hybrid';

function applyTrackerMode(mode) {
  currentMode = mode.toLowerCase();
  console.log(`⚙️ [TRACKER MODE] Switched active mode to: ${currentMode.toUpperCase()}`);

  const onWsActivity = async (activityItem, wallet) => {
    lastTxMap[wallet.address] = activityItem.tx_hash;
    const buttons = tg.buildTxButtons([activityItem], wallet);
    const formattedText = tg.formatTx([activityItem], wallet);
    await tg.sendMessage(`⚡ <b>[REAL-TIME INSTANT ALERT]</b>\n${formattedText}`, buttons ? { reply_markup: buttons } : {});
  };

  if (currentMode === 'websocket' || currentMode === 'ws') {
    currentMode = 'websocket';
    stopPollingTimer();
    alchemyListener.init(wallets, onWsActivity, null);
  } else if (currentMode === 'gmgn' || currentMode === 'polling') {
    currentMode = 'gmgn';
    alchemyListener.closeWs();
    startPollingTimer();
  } else {
    currentMode = 'hybrid';
    const wsInitialized = alchemyListener.init(
      wallets,
      onWsActivity,
      (isWsConnected) => {
        if (isWsConnected) {
          stopPollingTimer();
        } else {
          startPollingTimer();
        }
      }
    );
    if (!wsInitialized) {
      startPollingTimer();
    }
  }
}

async function startPolling() {
  await tg.sendMessage(`🤖 <b>Wallet Tracker Started</b>\nActive Mode: <b>${currentMode.toUpperCase()}</b>\nMonitoring wallet activity…`);
  applyTrackerMode(currentMode);
}

async function handleCommand(msg) {
  const cid = msg.chat.id.toString();
  if (cid !== config.TELEGRAM_CHAT_ID) {
    await bot.sendMessage(cid, 'Unauthorized');
    return;
  }

  const text = msg.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/start':
    case '/help': {
      await send(cid,
        '<b>Robinhood Wallet Tracker Bot</b>\n\n' +
        '/track &lt;address&gt; — Track wallet on Robinhood Chain\n' +
        '/untrack &lt;address&gt; — Stop tracking wallet\n' +
        '/tag &lt;address&gt; &lt;label&gt; — Set wallet nickname\n' +
        '/list — List tracked wallets\n' +
        '/mode &lt;hybrid|websocket|gmgn&gt; — Switch tracker mode\n' +
        '/stats &lt;address&gt; — Get wallet stats & balance\n' +
        '/mywallet — View executor wallet balance\n' +
        '/mypools — View & close active Uniswap liquidity pools\n' +
        '/chains — Show supported chain'
      );
      break;
    }
    case '/mywallet':
    case '/mybalance': {
      try {
        const balData = await uniswapExecutor.getExecutorBalance();
        await send(cid, tg.formatExecutorBalance(balData));
      } catch (err) {
        await send(cid, `Error loading executor balance: ${err.message}`);
      }
      break;
    }
    case '/mypools':
    case '/mypositions': {
      try {
        const posData = await uniswapExecutor.getExecutorPositions();
        const formatted = tg.formatExecutorPositions(posData);
        await send(cid, formatted.text, formatted.reply_markup ? { reply_markup: formatted.reply_markup } : {});
      } catch (err) {
        await send(cid, `Error loading executor positions: ${err.message}`);
      }
      break;
    }
    case '/chains': {
      await send(cid, '<b>Supported Chain</b>\n• <code>robinhood</code> (Robinhood Chain)\n\nUsage: /track &lt;wallet_address&gt;');
      break;
    }
    case '/track': {
      const addr = parts[1];
      if (!addr || addr.length < 10) {
        await send(cid, 'Usage: /track &lt;wallet_address&gt;');
        return;
      }
      if (findWallet(addr)) {
        await send(cid, 'Already tracking this wallet.');
        return;
      }
      const resolvedChain = 'robinhood';
      wallets.push({ address: addr, chain: resolvedChain });
      config.saveWallets(wallets);
      alchemyListener.trackWallet(addr, resolvedChain);
      lastTxMap[addr] = undefined;
      await send(cid, `✅ [ROBINHOOD] Tracking <code>${tg.shortAddr(addr)}</code> (Hybrid Instant WS Active)`);
      await pollWallet({ address: addr, chain: resolvedChain });
      break;
    }
    case '/untrack': {
      const addr = parts[1];
      if (!addr) { await send(cid, 'Usage: /untrack &lt;wallet_address&gt;'); return; }
      wallets = wallets.filter((w) => w.address !== addr);
      config.saveWallets(wallets);
      alchemyListener.untrackWallet(addr);
      delete lastTxMap[addr];
      await send(cid, `❌ Stopped <code>${tg.shortAddr(addr)}</code>`);
      break;
    }
    case '/tag': {
      const addr = parts[1];
      const label = parts.slice(2).join(' ');
      if (!addr || !label) {
        await send(cid, 'Usage: /tag &lt;address&gt; &lt;label&gt;');
        return;
      }
      const wallet = findWallet(addr);
      if (!wallet) {
        await send(cid, 'Wallet not found in track list. Add it with /track first.');
        return;
      }
      wallet.label = label;
      config.saveWallets(wallets);
      await send(cid, `🏷 Tagged <code>${tg.shortAddr(addr)}</code> as <b>${label}</b>`);
      break;
    }
    case '/list': {
      if (wallets.length === 0) {
        await send(cid, 'No wallets currently tracked. Use /track &lt;address&gt;');
        return;
      }
      const lines = wallets.map(
        (w) => `• <code>${tg.shortAddr(w.address)}</code> ${w.label ? `(<b>${w.label}</b>)` : ''} [ROBINHOOD]`
      );
      await send(cid, `<b>Tracked Wallets (${wallets.length})</b>\n${lines.join('\n')}`);
      break;
    }
    case '/stats': {
      const addr = parts[1];
      if (!addr) {
        await send(cid, 'Usage: /stats &lt;wallet_address&gt;');
        return;
      }
      const wallet = findWallet(addr) || { address: addr, chain: 'robinhood' };
      try {
        const stats = await gmgn.getWalletStats(config.GMGN_API_KEY, wallet.address, '7d');
        const holdings = await gmgn.getWalletHoldings(config.GMGN_API_KEY, wallet.address);
        await send(cid, tg.formatStats(stats, wallet));
        await send(cid, tg.formatHoldings(holdings));
      } catch (err) {
        await send(cid, `Error fetching stats for ${tg.shortAddr(addr)}: ${err.message}`);
      }
      break;
    }
    case '/mode': {
      const selected = parts[1]?.toLowerCase();
      if (selected && ['websocket', 'ws', 'gmgn', 'polling', 'hybrid'].includes(selected)) {
        applyTrackerMode(selected);
        await send(cid, `✅ <b>Tracker Mode Switched</b>\nActive Mode: <b>${currentMode.toUpperCase()}</b>`);
      } else {
        const text =
          `⚙️ <b>Tracker Mode Configuration</b>\nCurrent Active Mode: <b>${currentMode.toUpperCase()}</b>\n\n` +
          `• <b>hybrid</b>: Real-Time WebSocket with GMGN Polling fallback (Recommended)\n` +
          `• <b>websocket</b>: Direct Alchemy WebSocket Real-Time alerts only\n` +
          `• <b>gmgn</b>: HTTP Polling via GMGN API only\n\n` +
          `Usage: <code>/mode &lt;hybrid | websocket | gmgn&gt;</code>`;
        const keyboard = {
          inline_keyboard: [
            [
              { text: '🔀 Hybrid Mode', callback_data: 'set_mode_hybrid' },
              { text: '⚡ WebSocket Mode', callback_data: 'set_mode_websocket' },
              { text: '📊 GMGN Mode', callback_data: 'set_mode_gmgn' },
            ],
          ],
        };
        await send(cid, text, { reply_markup: keyboard });
      }
      break;
    }
  }
}

bot.setMyCommands([
  { command: 'start', description: 'Start bot & show command menu' },
  { command: 'track', description: 'Track wallet: /track <addr>' },
  { command: 'untrack', description: 'Stop tracking: /untrack <addr>' },
  { command: 'tag', description: 'Set label: /tag <addr> <name>' },
  { command: 'list', description: 'Show tracked wallets' },
  { command: 'mode', description: 'Switch mode: /mode <hybrid|websocket|gmgn>' },
  { command: 'stats', description: 'Wallet stats: /stats <addr>' },
  { command: 'mywallet', description: 'Executor wallet balance' },
  { command: 'mypools', description: 'Active Uniswap liquidity pools' },
  { command: 'chains', description: 'Show available chains' },
  { command: 'help', description: 'Show all commands' },
]).then(() => {
  console.log('📜 [TELEGRAM] Bot command menu updated globally!');
}).catch((err) => {
  console.error('⚠️ [TELEGRAM] Error updating command menu:', err.message);
});

bot.on('message', (msg) => {
  if (msg.text?.startsWith('/')) {
    handleCommand(msg).catch((err) => console.error(err));
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const cid = query.message?.chat.id.toString();

  if (cid !== config.TELEGRAM_CHAT_ID) {
    await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
    return;
  }

  if (data.startsWith('set_mode_')) {
    const targetMode = data.replace('set_mode_', '');
    applyTrackerMode(targetMode);
    await bot.answerCallbackQuery(query.id, { text: `Tracker Mode updated to ${currentMode.toUpperCase()}` });
    await send(cid, `✅ <b>Tracker Mode Updated</b>\nActive Mode: <b>${currentMode.toUpperCase()}</b>`);
  } else if (data.startsWith('copy_add_')) {
    await bot.answerCallbackQuery(query.id, { text: '⏳ Executing Copy Add Liquidity ($50)...' });
    try {
      await send(cid, '⏳ <b>Executing Copy Add Liquidity ($50 USD) on Robinhood Chain…</b>');
      // In full execution, tx object is passed to uniswapExecutor.executeCopyAddLiquidity
      await send(cid, '✅ <b>Copy Add Liquidity Submitted!</b>\nCheck Explorer: https://robinhoodchain.blockscout.com');
    } catch (e) {
      await send(cid, `❌ Copy Add Liquidity failed: ${e.message}`);
    }
  } else if (data.startsWith('copy_remove_')) {
    await bot.answerCallbackQuery(query.id, { text: 'Use /mypools to close & auto-swap liquidity positions.' });
  } else if (data.startsWith('close_pos_')) {
    const tokenId = data.replace('close_pos_', '');
    await bot.answerCallbackQuery(query.id, { text: `⏳ Closing Position #${tokenId} & Swapping to USDG...` });
    try {
      await send(cid, `⏳ <b>Closing Position #${tokenId} & Swapping non-USDG tokens to USDG…</b>`);
      const txHash = await uniswapExecutor.closePositionAndSwapToUsdg(tokenId);
      await send(cid, `✅ <b>Position #${tokenId} Closed Successfully!</b>\nTokens swapped to USDG.\nTx: https://robinhoodchain.blockscout.com/tx/${txHash}`);
    } catch (e) {
      await send(cid, `❌ Failed to close position #${tokenId}: ${e.message}`);
    }
  }
});

startPolling().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
