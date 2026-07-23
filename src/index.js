const config = require('./config');
const gmgn = require('./gmgn-api');
const tg = require('./telegram');

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

function send(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

function findWallet(addr) {
  return wallets.find((w) => w.address === addr);
}

async function pollWallet(w) {
  try {
    const activity = await gmgn.getWalletActivity(config.GMGN_API_KEY, w.address, 5, w.chain);
    if (!activity?.activities?.length && !activity?.length) return;

    const list = activity.activities || activity;
    const latestTxHash = list[0].tx_hash;
    if (!latestTxHash) return;

    const prev = lastTxMap[w.address];
    if (prev === undefined) {
      lastTxMap[w.address] = latestTxHash;
      await tg.sendMessage(tg.formatTx(list, w.address, w.chain));
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
        await tg.sendMessage(tg.formatTx(newTxs.reverse(), w.address, w.chain));
      }
    }
  } catch (err) {
    console.error(`[ERROR] ${tg.shortAddr(w.address)} ${err.message}`);
  }
}

async function pollAll() {
  console.log(`[POLL] ${wallets.length} wallets at ${new Date().toLocaleTimeString()}`);
  for (const w of wallets) {
    await pollWallet(w);
  }
}

async function startPolling() {
  await tg.sendMessage('🤖 <b>Wallet Tracker Started</b>\nMonitoring wallet activity…');
  if (wallets.length > 0) await pollAll();
  setInterval(pollAll, config.POLL_INTERVAL_MS);
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
        '/list — List tracked wallets\n' +
        '/stats &lt;address&gt; [chain] — Get wallet stats\n' +
        '/chains — Show available chains'
      );
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
      lastTxMap[addr] = undefined;
      await send(cid, `✅ [${resolvedChain.toUpperCase()}] Tracking <code>${tg.shortAddr(addr)}</code>`);
      await pollWallet({ address: addr, chain: resolvedChain });
      break;
    }
    case '/untrack': {
      const addr = parts[1];
      if (!addr) { await send(cid, 'Usage: /untrack &lt;wallet_address&gt;'); return; }
      wallets = wallets.filter((w) => w.address !== addr);
      config.saveWallets(wallets);
      delete lastTxMap[addr];
      await send(cid, `❌ Stopped <code>${tg.shortAddr(addr)}</code>`);
      break;
    }
    case '/list': {
      if (!wallets.length) {
        await send(cid, 'No wallets tracked. Use /track &lt;address&gt; [chain]');
        return;
      }
      const lines = wallets.map((w, i) =>
        `${i + 1}. [${w.chain.toUpperCase()}] <code>${w.address}</code>`
      );
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
  { command: 'list', description: 'Show tracked wallets' },
  { command: 'stats', description: 'Wallet stats: /stats <addr> [chain]' },
  { command: 'chains', description: 'Show available chains' },
  { command: 'help', description: 'Show all commands' },
]).catch(() => {});

bot.on('message', (msg) => {
  if (msg.text?.startsWith('/')) {
    handleCommand(msg).catch((err) => console.error(err));
  }
});

startPolling().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
