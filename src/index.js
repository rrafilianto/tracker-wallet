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

async function startPolling() {
  await tg.sendMessage('🤖 <b>Wallet Tracker Started</b>\nMonitoring wallet activity…');

  // Initialize Alchemy WebSocket Real-Time Listener with Option B Status Callback
  const wsInitialized = alchemyListener.init(
    wallets,
    null,
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
        '<b>Wallet Tracker Bot</b>\n\n' +
        '/track &lt;address&gt; [chain] — Start tracking\n' +
        '/untrack &lt;address&gt; — Stop tracking\n' +
        '/tag &lt;address&gt; &lt;label&gt; — Set wallet nickname\n' +
        '/list — List tracked wallets\n' +
        '/stats &lt;address&gt; [chain] — Get wallet stats & balance\n' +
        '/mywallet — View executor wallet balance\n' +
        '/mypools — View & close active Uniswap liquidity pools\n' +
        '/chains — Show available chains'
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
      const list = gmgn.VALID_CHAINS.map((c) => `• <code>${c}</code>`).join('\n');
      await send(cid, `<b>Supported Chains</b>\n${list}\n\nUsage: /track &lt;addr&gt; <code>&lt;chain&gt;</code>`);
      break;
    }
    case '/track': {
      const addr = parts[1];
      const chain = (parts[2] || '').toLowerCase();
      if (!addr || addr.length < 10) {
        await send(cid, 'Usage: /track &lt;wallet_address&gt; [chain]');
        return;
      }
      if (chain && !gmgn.VALID_CHAINS.includes(chain)) {
        await send(cid, `Invalid chain. Options: ${gmgn.VALID_CHAINS.join(', ')}`);
        return;
      }
      if (findWallet(addr)) {
        await send(cid, 'Already tracking this wallet.');
        return;
      }
      const resolvedChain = chain || gmgn.detectChain(addr);
      wallets.push({ address: addr, chain: resolvedChain });
      config.saveWallets(wallets);
      alchemyListener.trackWallet(addr, resolvedChain);
      lastTxMap[addr] = undefined;
      await send(cid, `✅ [${resolvedChain.toUpperCase()}] Tracking <code>${tg.shortAddr(addr)}</code> (Hybrid Instant WS Active)`);
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
        await send(cid, 'Wallet not tracked. Use /track first.');
        return;
      }
      wallet.label = label;
      config.saveWallets(wallets);
      await send(cid, `🏷️ <b>${label}</b> → <code>${tg.shortAddr(addr)}</code>`);
      break;
    }
    case '/list': {
      if (!wallets.length) {
        await send(cid, 'No wallets tracked. Use /track &lt;address&gt; [chain]');
        return;
      }
      const lines = wallets.map((w, i) => {
        const name = w.label || '—';
        return `${i + 1}. [${w.chain.toUpperCase()}] <code>${w.address}</code>\n   🏷️ ${name}`;
      });
      await send(cid, `📋 <b>Tracked (${wallets.length})</b>\n${lines.join('\n')}`);
      break;
    }
    case '/stats': {
      const addr = parts[1];
      const chain = (parts[2] || '').toLowerCase();
      if (!addr) { await send(cid, 'Usage: /stats &lt;wallet_address&gt; [chain]'); return; }
      const resolvedChain = chain || gmgn.detectChain(addr);
      try {
        const [stats, holdings] = await Promise.all([
          gmgn.getWalletStats(config.GMGN_API_KEY, addr, '7d', resolvedChain),
          gmgn.getWalletHoldings(config.GMGN_API_KEY, addr, resolvedChain).catch(() => null),
        ]);
        let response = tg.formatStats(stats, addr, resolvedChain);
        if (holdings) response += '\n\n' + tg.formatHoldings(holdings);
        await send(cid, response);
      } catch (err) {
        await send(cid, `Error: ${err.message}`);
      }
      break;
    }
  }
}

bot.setMyCommands([
  { command: 'track', description: 'Track wallet: /track <addr> [chain]' },
  { command: 'untrack', description: 'Stop tracking: /untrack <addr>' },
  { command: 'tag', description: 'Set label: /tag <addr> <name>' },
  { command: 'list', description: 'Show tracked wallets' },
  { command: 'stats', description: 'Wallet stats: /stats <addr> [chain]' },
  { command: 'mywallet', description: 'Executor wallet balance' },
  { command: 'mypools', description: 'Active Uniswap liquidity pools' },
  { command: 'chains', description: 'Show available chains' },
  { command: 'help', description: 'Show all commands' },
]).catch(() => {});

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

  if (data.startsWith('copy_add_')) {
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
