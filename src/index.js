require('./logger');
const config = require('./config');
const gmgn = require('./gmgn-api');
const tg = require('./telegram');
const rpcDecoder = require('./rpc-decoder');
const uniswapExecutor = require('./uniswap-executor');
const gmgnWs = require('./gmgn-websocket');

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
let deploySettings = config.loadSettings(); // { amount_usd, range_pct, tp_pct, sl_pct, auto_close_enabled }
const pendingCopyTrades = new Map(); // shortKey -> fullTxHash
const pendingPoolSelections = new Map(); // shortKey -> { tokenAddr, pools }
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// ── Settings helpers ────────────────────────────────────────────────────────
const AMOUNT_PRESETS = [10, 25, 50, 100, 200, 500];
const PCT_PRESETS    = [5, 10, 20, 30, 50, 75]; // % below current price
const TP_PRESETS     = [10, 20, 30, 50, 100];   // % price increase for TP
const SL_PRESETS     = [5, 10, 15, 20, 30];     // % price drop for SL

function buildSettingsText(s) {
  const autoCloseStr = s.auto_close_enabled
    ? '🤖 <b>Auto-Close: ON</b> (Otomatis Liquidated ke USDG)'
    : '🔔 <b>Auto-Close: OFF</b> (Notifikasi Alert Saja)';

  return (
    `⚙️ <b>LP Deploy & TP/SL Settings</b>\n\n` +
    `💰 Amount: <b>$${s.amount_usd} USDG</b>\n` +
    `📉 Range: <b>-${s.range_pct}% di bawah harga saat ini</b>\n` +
    `🎯 Take Profit: <b>+${s.tp_pct || 30}%</b>\n` +
    `🚨 Stop Loss: <b>-${s.sl_pct || 15}%</b>\n` +
    `${autoCloseStr}\n\n` +
    `<b>💰 Ubah Amount (USDG):</b>\n` +
    `<b>📉 Ubah Range (% bawah harga):</b>\n` +
    `<b>🎯 Ubah Take Profit (+%):</b>\n` +
    `<b>🚨 Ubah Stop Loss (-%):</b>`
  );
}

function buildSettingsMarkup(s) {
  const amtRow1 = AMOUNT_PRESETS.slice(0, 3).map(v => ({
    text: s.amount_usd === v ? `✅ $${v}` : `$${v}`,
    callback_data: `settings_amount_${v}`,
  }));
  const amtRow2 = AMOUNT_PRESETS.slice(3).map(v => ({
    text: s.amount_usd === v ? `✅ $${v}` : `$${v}`,
    callback_data: `settings_amount_${v}`,
  }));
  const pctRow1 = PCT_PRESETS.slice(0, 3).map(v => ({
    text: s.range_pct === v ? `✅ -${v}%` : `-${v}%`,
    callback_data: `settings_pct_${v}`,
  }));
  const pctRow2 = PCT_PRESETS.slice(3).map(v => ({
    text: s.range_pct === v ? `✅ -${v}%` : `-${v}%`,
    callback_data: `settings_pct_${v}`,
  }));
  const tpRow = TP_PRESETS.map(v => ({
    text: (s.tp_pct || 30) === v ? `✅ +${v}%` : `+${v}%`,
    callback_data: `settings_tp_${v}`,
  }));
  const slRow = SL_PRESETS.map(v => ({
    text: (s.sl_pct || 15) === v ? `✅ -${v}%` : `-${v}%`,
    callback_data: `settings_sl_${v}`,
  }));
  const toggleRow = [{
    text: s.auto_close_enabled ? '🤖 Auto-Close: ON (Klik untuk OFF)' : '🔔 Auto-Close: OFF (Klik untuk ON)',
    callback_data: 'settings_autoclose_toggle',
  }];

  return { inline_keyboard: [amtRow1, amtRow2, pctRow1, pctRow2, tpRow, slRow, toggleRow] };
}

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
    if ((eventType === 'add' || eventType === 'remove') && tx.tx_hash) {
      try {
        const liqDetails = await uniswapExecutor.getLiquidityTxDetails(tx.tx_hash, wallet.address);
        if (liqDetails) tx.liqDetails = liqDetails;

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

    // Cache tx data for copy trade callbacks
    list.forEach((tx) => {
      if ((tx.event_type || '').toLowerCase() === 'add' && tx.tx_hash) {
        pendingCopyTrades.set(tx.tx_hash.slice(0, 10), tx);
      }
    });

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
    console.error(`❌ [POLL_ERROR] Failed polling wallet ${tg.shortAddr(w.address)} (${w.address}):`, err.message);
  }
}

function pollAll() {
  wallets.forEach((w) => pollWallet(w));
}

let pollingTimer = null;

function startPolling() {
  if (pollingTimer) return;
  console.log('[GMGN] HTTP Polling activated.');
  if (wallets.length > 0) pollAll();
  pollingTimer = setInterval(pollAll, config.POLL_INTERVAL_MS);
}

async function handleCommand(msg) {
  const cid = msg.chat.id.toString();
  if (cid !== config.TELEGRAM_CHAT_ID) {
    console.warn(`⚠️ [COMMAND_UNAUTHORIZED] Unauthorized command from Chat ID: ${cid}`);
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
        '/stats &lt;address&gt; — Get wallet stats & balance\n' +
        '/mywallet — View executor wallet balance\n' +
        '/mypools — View & close active Uniswap liquidity pools\n' +
        '/pnl — LP PnL history & performance analytics\n' +
        '/settings — LP deploy settings (amount & tick range)\n' +
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
        console.error(`❌ [COMMAND /mywallet] Failed to load executor balance:`, err.message);
        await send(cid, `Error loading executor balance: ${err.message}`);
      }
      break;
    }
    case '/mypools':
    case '/mypositions': {
      try {
        const posData = await uniswapExecutor.getExecutorPositions();
        const formatted = tg.formatExecutorPositions(posData, tg.formatWibTimeShort());
        await send(cid, formatted.text, formatted.reply_markup ? { reply_markup: formatted.reply_markup } : {});
        syncActivePositionsToWs();
      } catch (err) {
        console.error(`❌ [COMMAND /mypools] Failed to load executor positions:`, err.message);
        await send(cid, `Error loading executor positions: ${err.message}`);
      }
      break;
    }
    case '/pnl':
    case '/report': {
      try {
        const history = config.loadTradeHistory();
        await send(cid, tg.formatPnlReport(history));
      } catch (err) {
        console.error(`❌ [COMMAND /pnl] Failed to load PnL report:`, err.message);
        await send(cid, `Error loading PnL report: ${err.message}`);
      }
      break;
    }
    case '/settings': {
      await send(cid, buildSettingsText(deploySettings), { reply_markup: buildSettingsMarkup(deploySettings) });
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
      lastTxMap[addr] = undefined;
      console.log(`✅ [COMMAND /track] Started tracking wallet ${addr}`);
      await send(cid, `✅ [ROBINHOOD] Tracking <code>${tg.shortAddr(addr)}</code>`);
      await pollWallet({ address: addr, chain: resolvedChain });
      break;
    }
    case '/untrack': {
      const addr = parts[1];
      if (!addr) { await send(cid, 'Usage: /untrack &lt;address&gt;'); return; }
      wallets = wallets.filter((w) => w.address !== addr);
      config.saveWallets(wallets);
      delete lastTxMap[addr];
      console.log(`❌ [COMMAND /untrack] Stopped tracking wallet ${addr}`);
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
      console.log(`🏷️ [COMMAND /tag] Tagged wallet ${addr} as "${label}"`);
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
        console.error(`❌ [COMMAND /stats] Failed to fetch stats for ${tg.shortAddr(addr)}:`, err.message);
        await send(cid, `Error fetching stats for ${tg.shortAddr(addr)}: ${err.message}`);
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
  { command: 'stats', description: 'Wallet stats: /stats <addr>' },
  { command: 'mywallet', description: 'Executor wallet balance' },
  { command: 'mypools', description: 'Active Uniswap liquidity pools' },
  { command: 'pnl', description: 'LP PnL history & performance analytics' },
  { command: 'settings', description: 'LP deploy settings (amount & ticks)' },
  { command: 'chains', description: 'Show available chains' },
  { command: 'help', description: 'Show all commands' },
]).then(() => {
  console.log('📜 [TELEGRAM] Bot command menu updated globally!');
}).catch((err) => {
  console.error('⚠️ [TELEGRAM] Error updating command menu:', err.message);
});

bot.on('message', (msg) => {
  const text = msg.text?.trim();
  if (!text) return;
  if (text.startsWith('/')) {
    handleCommand(msg).catch((err) => console.error(err));
    return;
  }
  if (ADDRESS_RE.test(text)) {
    handleAutoDeploy(msg, text).catch((err) => console.error(err));
  }
});

function formatTvl(tvlUsd) {
  if (tvlUsd === undefined || tvlUsd === null || isNaN(tvlUsd)) return 'N/A';
  if (tvlUsd >= 1_000_000) return `$${(tvlUsd / 1_000_000).toFixed(2)}M`;
  if (tvlUsd >= 1_000) return `$${(tvlUsd / 1_000).toFixed(1)}K`;
  if (tvlUsd > 0) return `$${tvlUsd.toFixed(2)}`;
  return '$0';
}

// Format harga kecil ke notasi compact: 0.0₆641 (seperti di Uniswap UI)
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
function formatPriceCompact(price) {
  if (!price || !isFinite(price) || price <= 0) return '0';
  if (price >= 1e12) return 'N/A';
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(4);

  const str = price.toFixed(20);
  const afterDecimal = str.split('.')[1] || '';
  let zeros = 0;
  for (const ch of afterDecimal) {
    if (ch === '0') zeros++;
    else break;
  }
  const sigDigits = afterDecimal.slice(zeros, zeros + 3);
  const sub = zeros.toString().split('').map(d => SUBSCRIPT_DIGITS[+d]).join('');
  return `0.0${sub}${sigDigits}`;
}

// Konversi tick ke harga token (human-readable USD equivalent)
function tickToTokenPrice(tick, poolInfo) {
  const { dec0, dec1, pk, quoteToken, quoteTokenAddress, sym0, isC0Usdg } = poolInfo;
  const rawPrice = Math.pow(1.0001, tick);

  const qAddr = quoteTokenAddress ? quoteTokenAddress.toLowerCase() : '';
  const isQ0  = isC0Usdg || (pk.currency0 && pk.currency0.toLowerCase() === qAddr) || sym0 === quoteToken;

  const quoteUsdPrice = (quoteToken === 'WETH' || quoteToken === 'ETH') ? 2000 : 1; // rough ETH price multiplier for USD display

  if (isQ0) {
    // c0=QUOTE, c1=TOKEN — harga TOKEN dalam QUOTE = 10^(dec1-dec0) / rawPrice
    const priceInQuote = Math.pow(10, dec1 - dec0) / rawPrice;
    return priceInQuote * quoteUsdPrice;
  } else {
    // c0=TOKEN, c1=QUOTE — harga TOKEN dalam QUOTE = rawPrice × 10^(dec0-dec1)
    const priceInQuote = rawPrice * Math.pow(10, dec0 - dec1);
    return priceInQuote * quoteUsdPrice;
  }
}

function getTargetTokenSymbol(poolInfo) {
  if (!poolInfo) return 'TOKEN';
  const qAddr = poolInfo.quoteTokenAddress ? poolInfo.quoteTokenAddress.toLowerCase() : '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const isQ0  = poolInfo.isC0Usdg || (poolInfo.pk?.currency0 && poolInfo.pk.currency0.toLowerCase() === qAddr) || poolInfo.sym0 === poolInfo.quoteToken;
  return isQ0 ? poolInfo.sym1 : poolInfo.sym0;
}

// Helper: bangun teks + keyboard kartu konfirmasi deploy
function buildDeployConfirmation(poolInfo, shortKey, idx, settings, updatedAt = null) {
  const { dec0, dec1, pk, tick, protocol, quoteToken, quoteTokenAddress, sym0, sym1, isC0Usdg } = poolInfo;

  const qAddr  = quoteTokenAddress ? quoteTokenAddress.toLowerCase() : '';
  const isQ0   = isC0Usdg || (pk.currency0 && pk.currency0.toLowerCase() === qAddr) || sym0 === quoteToken;

  const tokenSym    = isQ0 ? sym1 : sym0;
  const quoteSym    = quoteToken || (isQ0 ? sym0 : sym1);
  const feePct      = (pk.fee / 10000).toFixed(2);
  const tvlStr      = formatTvl(poolInfo.tvlUsd);
  const amount      = settings.amount_usd;
  const rangePct    = settings.range_pct;
  const protocolTag = (protocol || 'v4').toUpperCase();
  const protoBadge  = protocol === 'v3' ? '🔷' : '🔶';

  // Hitung tick range
  const tickSpacing = Number(pk.tickSpacing);
  const alignDown   = (t, ts) => Math.floor(t / ts) * ts;
  
  const ratio       = 1 - rangePct / 100;
  const rawTickDiff = Math.log(ratio) / Math.log(1.0001);
  const tickDiffAbs = Math.floor(Math.abs(rawTickDiff) / tickSpacing) * tickSpacing;

  let tickLower, tickUpper;
  if (isQ0) {
    tickLower = alignDown(tick, tickSpacing);
    tickUpper = tickLower + tickDiffAbs;
  } else {
    tickUpper = alignDown(tick, tickSpacing);
    tickLower = tickUpper - tickDiffAbs;
  }

  const priceAtLower = tickToTokenPrice(tickLower, poolInfo);
  const priceAtUpper = tickToTokenPrice(tickUpper, poolInfo);

  const priceMin = Math.min(priceAtLower, priceAtUpper);
  const priceMax = Math.max(priceAtLower, priceAtUpper);

  const priceNow = tickToTokenPrice(tick, poolInfo);

  const isInvalidPrice = !isFinite(priceMin) || !isFinite(priceMax) || !isFinite(priceNow) || priceMin <= 0;
  const rangeStr = isInvalidPrice
    ? 'N/A (Empty / Uninitialized Pool)'
    : `${formatPriceCompact(priceMin)}–${formatPriceCompact(priceMax)} (now ${formatPriceCompact(priceNow)})`;

  let text =
    `📋 <b>Konfirmasi Deploy LP</b>\n\n` +
    `${protoBadge} Protocol: <b>Uniswap ${protocolTag}</b>\n` +
    `🏊 Pair: <b>${tokenSym}/${quoteSym}</b>\n` +
    `💸 Fee Tier: <b>${feePct}%</b>\n` +
    `📊 TVL Pool: <b>~${tvlStr}</b>\n` +
    `💰 Amount: <b>$${amount} ${quoteSym}</b>\n` +
    `📉 Range: <b>${rangeStr}</b>`;

  // Quote token warning
  if (quoteSym !== 'USDG') {
    text += `\n\n⚠️ <i>Quote token: ${quoteSym}</i>\n`;
    text += `🔄 <i>Jika saldo ${quoteSym} tidak cukup, sistem akan auto-swap USDG → ${quoteSym} (deficit only) sebelum deploy.</i>`;
  }

  if (updatedAt) text += `\n🕒 <i>Refreshed: ${updatedAt}</i>`;
  text += `\n\nLanjutkan deploy?`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔄 Refresh Price', callback_data: `pool_refresh_${shortKey}_${idx}` }],
      [
        { text: '✅ Confirm Deploy', callback_data: `pool_confirm_${shortKey}_${idx}` },
        { text: '❌ Cancel',         callback_data: `pool_cancel_${shortKey}` },
      ],
    ],
  };

  return { text, keyboard };
}

async function handleAutoDeploy(msg, addr) {
  const cid = msg.chat.id.toString();
  if (cid !== config.TELEGRAM_CHAT_ID) return;

  const amount = deploySettings.amount_usd;
  const shortKey = addr.slice(2, 12).toLowerCase();

  // Kirim pesan loading dulu
  const loadingMsg = await send(cid,
    `🔍 <b>Mencari pool USDG/WETH...</b>\n` +
    `Token: <code>${addr}</code>\n\n` +
    `⏳ Sedang fetch data pool dari Uniswap V3 & V4...`
  );

  try {
    const pools = await uniswapExecutor.findAllUsdgPoolsCombined(addr);

    if (pools.length === 0) {
      await bot.editMessageText(
        `❌ <b>Tidak ada pool ditemukan</b>\n` +
        `Token: <code>${addr}</code>\n\n` +
        `Token ini belum memiliki pool aktif di Uniswap V3 atau V4.`,
        { chat_id: cid, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
      );
      return;
    }

    // Simpan pools untuk dipakai saat user klik
    pendingPoolSelections.set(shortKey, { tokenAddr: addr, pools });

    const tokenSym = getTargetTokenSymbol(pools[0]);

    // Bangun keyboard — satu baris per pool, dengan badge V3/V4
    const poolButtons = pools.map((p, idx) => {
      const feePct    = (p.pk.fee / 10000).toFixed(2);
      const tvlStr    = formatTvl(p.tvlUsd);
      const protoBadge = p.protocol === 'v3' ? '🔷' : '🔶';
      const protoTag   = (p.protocol || 'v4').toUpperCase();
      const quoteTag   = (p.quoteToken && p.quoteToken !== 'USDG') ? ` [${p.quoteToken}]` : '';
      return [{
        text: `${protoBadge} ${protoTag} │ ${feePct}% │ TVL ~${tvlStr}${quoteTag}`,
        callback_data: `pool_deploy_${shortKey}_${idx}`,
      }];
    });
    poolButtons.push([{ text: '❌ Cancel', callback_data: `pool_cancel_${shortKey}` }]);

    const headerText =
      `🌊 <b>Pool tersedia — ${tokenSym}</b>\n\n` +
      `💰 Amount: <b>$${deploySettings.amount_usd} USDG</b>\n` +
      `📉 Range: <b>-${deploySettings.range_pct}% di bawah harga</b>\n` +
      `<i>Ubah via /settings</i>\n\n` +
      `<b>Pilih pool untuk deploy LP:</b>`;

    await bot.editMessageText(headerText, {
      chat_id: cid,
      message_id: loadingMsg.message_id,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: poolButtons },
    });
  } catch (err) {
    console.error(`❌ [AUTO-DEPLOY ERROR] Failed to fetch pool for token ${addr}:`, err.message);
    await bot.editMessageText(
      `❌ <b>Gagal fetch pool:</b> ${err.message}`,
      { chat_id: cid, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
    );
  }
}

bot.on('callback_query', async (query) => {
  const data = query.data;
  const cid = query.message?.chat.id.toString();

  if (cid !== config.TELEGRAM_CHAT_ID) {
    console.warn(`⚠️ [CALLBACK_UNAUTHORIZED] Unauthorized callback query from Chat ID: ${cid}, Data: ${data}`);
    await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
    return;
  }

  if (data.startsWith('copy_add_')) {
    const shortKey = data.replace('copy_add_', '');
    const txData = pendingCopyTrades.get(shortKey);
    const amount = deploySettings.amount_usd;

    await bot.answerCallbackQuery(query.id, { text: '🔍 Mencari pool USDG...' });

    try {
      if (!txData) throw new Error('Transaction data expired. Please wait for a new activity alert.');
      const tokenAddr = txData.token?.address;
      if (!tokenAddr || !ADDRESS_RE.test(tokenAddr)) {
        throw new Error('Token contract address not found in activity data.');
      }
      const tokenSym = txData.token?.symbol || tg.shortAddr(tokenAddr);

      // Kirim loading message
      const loadingMsg = await send(cid,
        `🔍 <b>Copy LP — Mencari pool USDG...</b>\n` +
        `Token: <b>${tokenSym}</b> (<code>${tg.shortAddr(tokenAddr)}</code>)\n\n` +
        `⏳ Sedang fetch data pool dari Uniswap V4...`
      );

      const pools = await uniswapExecutor.findAllUsdgPoolsCombined(tokenAddr);

      if (pools.length === 0) {
        await bot.editMessageText(
          `❌ <b>Tidak ada pool ditemukan</b>\n` +
          `Token: <b>${tokenSym}</b>\n\n` +
          `Token ini belum memiliki pool aktif di Uniswap V3 atau V4.`,
          { chat_id: cid, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
        );
        return;
      }

      // Simpan ke pendingPoolSelections (reuse flow yang sama dengan auto-deploy)
      pendingPoolSelections.set(shortKey, { tokenAddr, pools });

      // Bangun keyboard pilihan pool dengan badge V3/V4
      const poolButtons = pools.map((p, idx) => {
        const feePct    = (p.pk.fee / 10000).toFixed(2);
        const tvlStr    = formatTvl(p.tvlUsd);
        const protoBadge = p.protocol === 'v3' ? '🔷' : '🔶';
        const protoTag   = (p.protocol || 'v4').toUpperCase();
        const quoteTag   = (p.quoteToken && p.quoteToken !== 'USDG') ? ` [${p.quoteToken}]` : '';
        return [{
          text: `${protoBadge} ${protoTag} │ ${feePct}% │ TVL ~${tvlStr}${quoteTag}`,
          callback_data: `pool_deploy_${shortKey}_${idx}`,
        }];
      });
      poolButtons.push([{ text: '❌ Cancel', callback_data: `pool_cancel_${shortKey}` }]);

      const headerText =
        `🌊 <b>Copy LP — Pool tersedia — ${tokenSym}</b>\n\n` +
        `💰 Amount: <b>$${amount} USDG</b>\n` +
        `📉 Range: <b>-${deploySettings.range_pct}% di bawah harga</b>\n` +
        `<b>Pilih pool untuk deploy LP:</b>`;

      await bot.editMessageText(headerText, {
        chat_id: cid,
        message_id: loadingMsg.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: poolButtons },
      });
    } catch (e) {
      console.error(`❌ [CALLBACK copy_add] Copy add liquidity failed:`, e.message);
      await send(cid, `❌ Copy Add Liquidity failed: ${e.message}`);
    }
  } else if (data.startsWith('close_pos_')) {
    const raw = data.replace('close_pos_', '');
    let protocol = null;
    let tokenId = raw;

    if (raw.startsWith('v3_')) {
      protocol = 'v3';
      tokenId = raw.replace('v3_', '');
    } else if (raw.startsWith('v4_')) {
      protocol = 'v4';
      tokenId = raw.replace('v4_', '');
    }

    await bot.answerCallbackQuery(query.id, { text: `⏳ Closing Position #${tokenId} & Swapping to USDG...` });
    try {
      await send(cid, `⏳ <b>Closing Position #${tokenId} & Swapping tokens to USDG…</b>`);

      let res;
      if (protocol === 'v3') {
        res = await uniswapExecutor.closeV3PositionAndSwapToUsdg(tokenId);
      } else if (protocol === 'v4') {
        res = await uniswapExecutor.closePositionAndSwapToUsdg(tokenId);
      } else {
        // Legacy fallback check
        const v3Detail = await uniswapExecutor.getV3PositionDetails(tokenId, (await uniswapExecutor.getExecutorAddress())).catch(() => null);
        if (v3Detail) {
          res = await uniswapExecutor.closeV3PositionAndSwapToUsdg(tokenId);
        } else {
          res = await uniswapExecutor.closePositionAndSwapToUsdg(tokenId);
        }
      }
      
      let msg = `✅ <b>Position #${tokenId} Closed Successfully!</b>\n\n`;
      msg += `🔹 <b>Close LP Tx:</b> https://robinhoodchain.blockscout.com/tx/${res.closeTxHash}\n`;
      if (res.swapTxHash) {
        msg += `🔄 <b>Swap Tx:</b> https://robinhoodchain.blockscout.com/tx/${res.swapTxHash}\n\n`;
        msg += `Tokens swapped to USDG.`;
      } else {
        msg += `\n(Position was 100% USDG — no swap needed)`;
      }

      console.log(`✅ [CLOSE_POS_SUCCESS] Position #${tokenId} closed. CloseTx: ${res.closeTxHash}${res.swapTxHash ? `, SwapTx: ${res.swapTxHash}` : ''}`);
      await send(cid, msg);
    } catch (e) {
      console.error(`❌ [CALLBACK close_pos] Failed to close position #${tokenId}:`, e.message);
      await send(cid, `❌ Failed to close position #${tokenId}: ${e.message}`);
    }
  } else if (data === 'refresh_positions') {
    await bot.answerCallbackQuery(query.id, { text: '🔄 Fetching latest positions data...' });
    try {
      const posData = await uniswapExecutor.getExecutorPositions();
      const now = tg.formatWibTimeShort();
      const formatted = tg.formatExecutorPositions(posData, now);
      await bot.editMessageText(formatted.text, {
        chat_id: cid,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: formatted.reply_markup,
      });
    } catch (e) {
      if (e.message?.includes('message is not modified')) {
        await bot.answerCallbackQuery(query.id, { text: '✅ Positions data is up to date!' });
      } else {
        console.error(`❌ [CALLBACK refresh_positions] Failed to refresh positions:`, e.message);
        await bot.answerCallbackQuery(query.id, { text: `❌ Refresh failed: ${e.message}` });
      }
    }
  } else if (data.startsWith('pool_cancel_')) {
    const shortKey = data.replace('pool_cancel_', '');
    pendingPoolSelections.delete(shortKey);
    await bot.answerCallbackQuery(query.id, { text: 'Dibatalkan' });
    await send(cid, '❌ Auto-Deploy dibatalkan.');
  } else if (data.startsWith('pool_deploy_')) {
    // Format: pool_deploy_{shortKey}_{idx}  — tampilkan konfirmasi, BUKAN langsung deploy
    const raw = data.replace('pool_deploy_', '');
    const lastUnderscore = raw.lastIndexOf('_');
    const shortKey = raw.slice(0, lastUnderscore);
    const idx = parseInt(raw.slice(lastUnderscore + 1), 10);

    await bot.answerCallbackQuery(query.id, { text: '📋 Detail pool dipilih' });

    try {
      const selection = pendingPoolSelections.get(shortKey);
      if (!selection) throw new Error('Session expired. Paste token address again.');
      const poolInfo = selection.pools[idx];
      if (!poolInfo) throw new Error('Pool data tidak ditemukan.');

      const { text, keyboard } = buildDeployConfirmation(poolInfo, shortKey, idx, deploySettings);
      await send(cid, text, { reply_markup: keyboard });
    } catch (e) {
      console.error(`❌ [CALLBACK pool_deploy] Error preparing pool confirmation:`, e.message);
      await send(cid, `❌ Error: ${e.message}`);
    }
  } else if (data.startsWith('pool_refresh_')) {
    // Format: pool_refresh_{shortKey}_{idx}  — re-fetch harga on-chain & update konfirmasi
    const raw = data.replace('pool_refresh_', '');
    const lastUnderscore = raw.lastIndexOf('_');
    const shortKey = raw.slice(0, lastUnderscore);
    const idx = parseInt(raw.slice(lastUnderscore + 1), 10);

    await bot.answerCallbackQuery(query.id, { text: '🔄 Fetching latest price...' });

    try {
      const selection = pendingPoolSelections.get(shortKey);
      if (!selection) throw new Error('Session expired.');
      const poolInfo = selection.pools[idx];
      if (!poolInfo) throw new Error('Pool data tidak ditemukan.');

      // Fetch fresh slot0 dari blockchain
      const fresh = await uniswapExecutor.getPoolSlot0(poolInfo.poolId);
      poolInfo.sqrtPriceX96 = fresh.sqrtPriceX96;
      poolInfo.tick          = fresh.tick;

      const now = tg.formatWibTimeShort();

      const { text, keyboard } = buildDeployConfirmation(poolInfo, shortKey, idx, deploySettings, now);
      await bot.editMessageText(text, {
        chat_id: cid,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e) {
      console.error(`❌ [CALLBACK pool_refresh] Failed to refresh pool price:`, e.message);
      await send(cid, `❌ Refresh gagal: ${e.message}`);
    }
  } else if (data.startsWith('pool_confirm_')) {
    // Format: pool_confirm_{shortKey}_{idx}  — eksekusi deploy setelah konfirmasi
    const raw = data.replace('pool_confirm_', '');
    const lastUnderscore = raw.lastIndexOf('_');
    const shortKey = raw.slice(0, lastUnderscore);
    const idx = parseInt(raw.slice(lastUnderscore + 1), 10);

    const selection  = pendingPoolSelections.get(shortKey);
    const amount     = deploySettings.amount_usd;
    const rangePct   = deploySettings.range_pct;
    await bot.answerCallbackQuery(query.id, { text: `⏳ Deploying $${amount} USDG LP...` });

    try {
      if (!selection) throw new Error('Session expired. Paste token address again.');
      const poolInfo = selection.pools[idx];
      if (!poolInfo) throw new Error('Pool data tidak ditemukan.');

      const tokenSym  = getTargetTokenSymbol(poolInfo);
      const quoteSym   = poolInfo.quoteToken || 'USDG';
      const feePct     = (poolInfo.pk.fee / 10000).toFixed(2);
      const tvlStr     = formatTvl(poolInfo.tvlUsd);
      const protoLabel = (poolInfo.protocol || 'v4').toUpperCase();

      await send(cid,
        `⏳ <b>Deploying LP ${tokenSym}/${quoteSym} [${protoLabel}]</b>\n` +
        `Fee: <b>${feePct}%</b> | TVL ~${tvlStr}\n` +
        `Amount: <b>$${amount} ${quoteSym}</b> | Range: <b>-${rangePct}%</b>…`
      );

      // Dispatch to V3 or V4 executor
      let result;
      if (poolInfo.isV3) {
        result = await uniswapExecutor.executeAutoDeployLpV3(selection.tokenAddr, amount, poolInfo, rangePct);
      } else {
        result = await uniswapExecutor.executeAutoDeployLp(selection.tokenAddr, amount, poolInfo, rangePct);
      }
      pendingPoolSelections.delete(shortKey);

      const isInvalidPrice = result.priceMin >= 1e12 || result.priceMax >= 1e12 || result.priceNow >= 1e12;
      const rangeStr = (result.priceMin !== undefined && result.priceMax !== undefined && !isInvalidPrice)
        ? `${formatPriceCompact(result.priceMin)}–${formatPriceCompact(result.priceMax)} (now ${formatPriceCompact(result.priceNow)})`
        : `${result.tickLower} → ${result.tickUpper}`;

      let successMsg =
        `✅ <b>LP Deployed Successfully! [${protoLabel}]</b>\n` +
        `Pair: <b>${result.tokenSymbol}/${quoteSym}</b>\n` +
        `Fee Tier: <b>${(result.fee / 10000).toFixed(2)}%</b>\n` +
        `Range: <b>${rangeStr}</b>\n`;

      // Show swap tx if it happened
      if (result.swapTxHash) {
        successMsg += `🔄 <b>Swap USDG→${quoteSym} Tx:</b> https://robinhoodchain.blockscout.com/tx/${result.swapTxHash}\n`;
      }
      successMsg += `📌 <b>Deploy Tx:</b> https://robinhoodchain.blockscout.com/tx/${result.hash}`;

      console.log(`✅ [DEPLOY_LP_SUCCESS] [${protoLabel}] Pair: ${result.tokenSymbol}/${quoteSym}, Fee: ${(result.fee / 10000).toFixed(2)}%, DeployTx: ${result.hash}`);
      await send(cid, successMsg);
      syncActivePositionsToWs();
    } catch (e) {
      console.error(`❌ [CALLBACK pool_confirm] LP deployment failed:`, e.message);
      await send(cid, `❌ Deploy gagal: ${e.message}`);
    }
  } else if (data.startsWith('settings_amount_')) {
    const val = parseInt(data.replace('settings_amount_', ''), 10);
    if (!AMOUNT_PRESETS.includes(val)) {
      await bot.answerCallbackQuery(query.id, { text: 'Invalid value' });
      return;
    }
    deploySettings.amount_usd = val;
    config.saveSettings(deploySettings);
    await bot.answerCallbackQuery(query.id, { text: `✅ Amount diubah ke $${val} USDG` });
    await bot.editMessageText(buildSettingsText(deploySettings), {
      chat_id: cid,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: buildSettingsMarkup(deploySettings),
    });
  } else if (data.startsWith('settings_pct_')) {
    const val = parseInt(data.replace('settings_pct_', ''), 10);
    if (!PCT_PRESETS.includes(val)) {
      await bot.answerCallbackQuery(query.id, { text: 'Invalid value' });
      return;
    }
    deploySettings.range_pct = val;
    config.saveSettings(deploySettings);
    await bot.answerCallbackQuery(query.id, { text: `✅ Range diubah ke -${val}%` });
    await bot.editMessageText(buildSettingsText(deploySettings), {
      chat_id: cid,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: buildSettingsMarkup(deploySettings),
    });
  } else if (data.startsWith('settings_tp_')) {
    const val = parseInt(data.replace('settings_tp_', ''), 10);
    if (!TP_PRESETS.includes(val)) {
      await bot.answerCallbackQuery(query.id, { text: 'Invalid value' });
      return;
    }
    deploySettings.tp_pct = val;
    config.saveSettings(deploySettings);
    await bot.answerCallbackQuery(query.id, { text: `✅ TP diubah ke +${val}%` });
    await bot.editMessageText(buildSettingsText(deploySettings), {
      chat_id: cid,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: buildSettingsMarkup(deploySettings),
    });
  } else if (data.startsWith('settings_sl_')) {
    const val = parseInt(data.replace('settings_sl_', ''), 10);
    if (!SL_PRESETS.includes(val)) {
      await bot.answerCallbackQuery(query.id, { text: 'Invalid value' });
      return;
    }
    deploySettings.sl_pct = val;
    config.saveSettings(deploySettings);
    await bot.answerCallbackQuery(query.id, { text: `✅ SL diubah ke -${val}%` });
    await bot.editMessageText(buildSettingsText(deploySettings), {
      chat_id: cid,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: buildSettingsMarkup(deploySettings),
    });
  } else if (data === 'settings_autoclose_toggle') {
    deploySettings.auto_close_enabled = !deploySettings.auto_close_enabled;
    config.saveSettings(deploySettings);
    const statusText = deploySettings.auto_close_enabled ? 'Auto-Close ON 🤖' : 'Auto-Close OFF 🔔';
    await bot.answerCallbackQuery(query.id, { text: `✅ ${statusText}` });
    await bot.editMessageText(buildSettingsText(deploySettings), {
      chat_id: cid,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: buildSettingsMarkup(deploySettings),
    });
  }
});

async function handleTpSlTrigger({ type, position, currentPrice, deltaPct, entryPrice }) {
  const cid = config.TELEGRAM_CHAT_ID;
  const autoClosed = deploySettings.auto_close_enabled;
  const alertText = tg.formatTpSlAlert({
    type,
    position,
    currentPrice,
    deltaPct,
    entryPrice,
    autoClosed,
  });

  await send(cid, alertText);

  if (autoClosed) {
    try {
      const proto = position.protocol || 'v4';
      const posId = position.positionId || position.tokenId;
      console.log(`🤖 [AUTO-CLOSE] Closing ${proto.toUpperCase()} Position #${posId}...`);

      if (proto === 'v3') {
        await uniswapExecutor.closeV3PositionAndSwapToUsdg(posId);
      } else {
        await uniswapExecutor.closePositionAndSwapToUsdg(posId);
      }

      await send(cid, `🤖 <b>[AUTO-CLOSE SUCCESS]</b> Position #${posId} has been closed & liquidated to USDG.`);
      gmgnWs.unsubscribePosition(position.tokenAddress, posId);
    } catch (err) {
      console.error(`❌ [AUTO-CLOSE ERROR] Failed to close Position #${position.positionId}:`, err.message);
      await send(cid, `❌ <b>[AUTO-CLOSE FAILED]</b> Position #${position.positionId}: ${err.message}`);
    }
  }
}

async function syncActivePositionsToWs() {
  try {
    const posData = await uniswapExecutor.getExecutorPositions();
    if (posData && posData.length > 0) {
      posData.forEach((pos) => {
        if (pos.tokenAddress) {
          gmgnWs.subscribePosition(pos.tokenAddress, {
            positionId: pos.tokenId,
            tokenAddress: pos.tokenAddress,
            tokenSymbol: pos.tokenSymbol || 'Token',
            entryPriceUsd: pos.entryPriceUsd || pos.priceNow,
            tpPct: deploySettings.tp_pct || 30,
            slPct: deploySettings.sl_pct || 15,
            protocol: pos.protocol || 'v4',
          });
        }
      });
    }
  } catch (err) {
    console.error('[WS SYNC] Error syncing active positions:', err.message);
  }
}

// Initialize GMGN WebSocket Price Listener
gmgnWs.init(config.GMGN_API_KEY, handleTpSlTrigger);
syncActivePositionsToWs();

tg.sendMessage(`🤖 <b>Wallet Tracker Started</b>\nMode: <b>GMGN + WS TP/SL</b>\nMonitoring wallet activity & live LP positions…`)
  .then(() => startPolling())
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
