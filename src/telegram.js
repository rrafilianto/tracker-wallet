const RawTelegramBot = require('node-telegram-bot-api');
const TelegramBot = typeof RawTelegramBot === 'function' ? RawTelegramBot : (RawTelegramBot.default || RawTelegramBot.TelegramBot);

let bot = null;
let chatId = null;

function init(token, targetChatId) {
  bot = new TelegramBot(token, { polling: true });
  chatId = targetChatId;
  return bot;
}

function sendMessage(text, opts = {}) {
  if (!bot) throw new Error('Telegram bot not initialized');
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
}

function shortAddr(addr) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function chainLabel(chain) {
  return (chain || 'sol').toUpperCase();
}

function displayName(wallet) {
  if (wallet.label) return wallet.label;
  return shortAddr(wallet.address);
}

function formatWibTime(ts) {
  if (!ts) return '';
  const date = new Date((typeof ts === 'number' ? ts : parseInt(ts)) * 1000);
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const p = {};
  parts.forEach((item) => {
    p[item.type] = item.value;
  });
  return `${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute}:${p.second} WIB`;
}

function formatTx(activity, wallet) {
  const name = wallet.label || shortAddr(wallet.address);
  const lines = [`🔔 <b>[${chainLabel(wallet.chain)}] ${name}</b>`];

  if (!activity?.length) {
    lines.push('No recent transactions.');
    return lines.join('\n');
  }

  const typeLabels = {
    buy: '🟢 BUY',
    sell: '🔴 SELL',
    add: '📥 ADD LIQ',
    remove: '📤 REMOVE LIQ',
    transfer: '🔄 TRANSFER',
    transferin: '⬇️ TRANSFER IN',
    transferout: '⬆️ TRANSFER OUT',
  };

  const recent = activity.slice(0, 5);
  recent.forEach((tx, i) => {
    const symbol = tx.token?.symbol || tx.token_symbol || 'Unknown';
    const eventType = (tx.event_type || '').toLowerCase();
    const isLiq = eventType === 'add' || eventType === 'remove';
    const type =
      typeLabels[eventType] || `🔄 ${(tx.event_type || '').toUpperCase()}`;
    const shortHash = tx.tx_hash
      ? ` <code>${tx.tx_hash.slice(0, 6)}</code>`
      : '';
    const usdVal = tx.cost_usd || tx.usd_value || tx.volume_usd;
    const usd = usdVal ? `$${Number(usdVal).toLocaleString()}` : '';
    const tokenAmt = tx.token_amount || tx.amount;
    const amount =
      tokenAmt && Number(tokenAmt) > 0 ? `${Number(tokenAmt).toFixed(4)}` : '';
    const time = formatWibTime(tx.timestamp);

    lines.push(`${i + 1}. ${type} <b>${symbol}</b>${shortHash}`);

    if (!isLiq && amount) {
      lines.push(`   Amount: ${amount} ${symbol}`);
    }
    if (usd) lines.push(`   Value: ${usd}`);

    // Detail khusus untuk Add / Remove Liquidity
    if (isLiq) {
      const quoteSymbol =
        tx.quote_token?.symbol || tx.quote_symbol || tx.pair_symbol;
      const quoteAmt = tx.quote_token_amount || tx.quote_amount;
      const hasTokenAmt = amount && Number(tokenAmt) > 0;
      const hasQuoteAmt = quoteAmt && Number(quoteAmt) > 0;

      const actionText = eventType === 'add' ? 'Deposit' : 'Withdraw';

      if (tx.decodedTransfers && tx.decodedTransfers.length > 0) {
        tx.decodedTransfers.forEach((tr) => {
          let trSymbol = tr.symbol;
          if (!trSymbol) {
            const addrLower = (tr.tokenAddress || '').toLowerCase();
            if (addrLower === tx.token?.address?.toLowerCase())
              trSymbol = symbol;
            else if (addrLower === tx.quote_token?.token_address?.toLowerCase())
              trSymbol = quoteSymbol;
            else trSymbol = shortAddr(tr.tokenAddress);
          }
          const displayAmt =
            tr.amount !== undefined
              ? tr.amount >= 1000
                ? formatCompactNumber(tr.amount)
                : tr.amount.toFixed(4)
              : tr.rawValue
                ? formatCompactNumber(tr.rawValue)
                : '';
          lines.push(`   ${actionText} ${trSymbol}: ${displayAmt}`);
        });
      } else if (tx.dexScreenerInfo) {
        const ds = tx.dexScreenerInfo;
        if (ds.baseAmount && ds.quoteAmount) {
          lines.push(
            `   Pool Liquidity: ${Number(ds.baseAmount).toLocaleString()} ${ds.baseSymbol} + ${Number(ds.quoteAmount).toLocaleString()} ${ds.quoteSymbol}`,
          );
          if (ds.usdValue)
            lines.push(
              `   Pool Value: $${Number(ds.usdValue).toLocaleString()}`,
            );
        } else if (quoteSymbol) {
          lines.push(`   Pair: ${symbol}/${quoteSymbol}`);
        }
      } else {
        if (hasTokenAmt) {
          lines.push(`   ${actionText} ${symbol}: ${amount}`);
        }
        if (hasQuoteAmt && quoteSymbol) {
          lines.push(
            `   ${actionText} ${quoteSymbol}: ${Number(quoteAmt).toFixed(4)}`,
          );
        }
        if (!hasTokenAmt && !hasQuoteAmt && quoteSymbol) {
          lines.push(`   Pair: ${symbol}/${quoteSymbol}`);
        }
      }

      const dex =
        tx.dex_name ||
        tx.dex ||
        tx.platform ||
        tx.launchpad_platform ||
        tx.launchpad;
      if (dex) lines.push(`   Platform/DEX: ${dex}`);

      if (tx.gas_usd)
        lines.push(`   Gas Fee: $${Number(tx.gas_usd).toFixed(4)}`);

      // Range harga untuk Concentrated Liquidity (V3 / V4 / CLMM) jika didukung
      const minPrice = tx.min_price ?? tx.price_min ?? tx.tick_lower_price;
      const maxPrice = tx.max_price ?? tx.price_max ?? tx.tick_upper_price;
      if (
        minPrice !== undefined &&
        maxPrice !== undefined &&
        minPrice !== null &&
        maxPrice !== null
      ) {
        lines.push(
          `   Range: $${Number(minPrice).toFixed(4)} - $${Number(maxPrice).toFixed(4)}`,
        );
      } else if (tx.decodedRange) {
        lines.push(`   Range: ${tx.decodedRange}`);
      } else if (tx.range) {
        lines.push(`   Range: ${tx.range}`);
      }
    }

    if (time) lines.push(`   ${time}`);
  });

  return lines.join('\n');
}

function formatStats(stats, address, chain) {
  if (!stats) return 'No stats available.';
  const lines = [`📊 <b>[${chainLabel(chain)}] ${shortAddr(address)}</b>`];
  if (stats.native_balance !== undefined) {
    const bal = Number(stats.native_balance);
    const symbol = chain === 'sol' ? 'SOL' : 'ETH';
    lines.push(`Balance: <b>${bal.toFixed(4)} ${symbol}</b>`);
  }
  if (stats.realized_profit !== undefined)
    lines.push(
      `PnL: <b>${stats.realized_profit >= 0 ? '+' : ''}$${Number(stats.realized_profit).toLocaleString()}</b>`,
    );
  const winrate = stats.pnl_stat?.winrate;
  if (winrate !== undefined)
    lines.push(`Win Rate: <b>${(winrate * 100).toFixed(1)}%</b>`);
  if (stats.total_cost !== undefined)
    lines.push(
      `Total Spent: <b>$${Number(stats.total_cost).toLocaleString()}</b>`,
    );
  const buys = stats.buy || 0;
  const sells = stats.sell || 0;
  if (buys > 0 || sells > 0)
    lines.push(`Trades: <b>${buys + sells}</b> (${buys}B / ${sells}S)`);
  const holdPeriod = stats.pnl_stat?.avg_holding_period;
  if (holdPeriod !== undefined) {
    const mins = Math.round(Number(holdPeriod) / 60);
    lines.push(`Avg Hold: <b>${mins} min</b>`);
  }
  const pnlRatio = stats.realized_profit_pnl;
  if (pnlRatio !== undefined)
    lines.push(`PnL Ratio: <b>${Number(pnlRatio).toFixed(2)}x</b>`);
  return lines.join('\n');
}

function formatHoldings(holdings) {
  if (!holdings?.list?.length) return 'No holdings (requires private key).';
  const lines = ['💼 <b>Holdings</b>'];
  holdings.list.slice(0, 10).forEach((h) => {
    const sym =
      h.token?.symbol ||
      h.token_symbol ||
      h.token_address?.slice(0, 6) ||
      'Unknown';
    const usd = h.usd_value ? `$${Number(h.usd_value).toLocaleString()}` : '';
    const pnl = h.total_profit
      ? ` ${h.total_profit >= 0 ? '+' : ''}$${Number(h.total_profit).toLocaleString()}`
      : '';
    lines.push(`• ${sym}: ${usd}${pnl}`);
  });
  return lines.join('\n');
}

function formatExecutorBalance(bal) {
  if (!bal || !bal.address) return 'Executor wallet not configured.';
  const lines = [
    '💼 <b>Executor Wallet Balance</b> (Robinhood Chain)',
    `Address: <code>${bal.address}</code>`,
    `• <b>ETH</b>: ${Number(bal.ethBalance).toFixed(4)} ETH`,
  ];
  if (bal.tokens && bal.tokens.length > 0) {
    bal.tokens.forEach((t) => {
      lines.push(`• <b>${t.symbol}</b>: ${Number(t.balance).toLocaleString()}`);
    });
  } else {
    lines.push('• No ERC-20 token balances found.');
  }
  return lines.join('\n');
}

function formatCompactNumber(val) {
  if (val === undefined || val === null || val === '') return '0';
  const num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num) || num === 0) return '0';

  const abs = Math.abs(num);
  if (abs >= 1e15) return (num / 1e15).toFixed(2).replace(/\.00$/, '') + 'Q';
  if (abs >= 1e12) return (num / 1e12).toFixed(2).replace(/\.00$/, '') + 'T';
  if (abs >= 1e9) return (num / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (abs >= 1e6) return (num / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
  if (abs >= 1e3) return (num / 1e3).toFixed(2).replace(/\.00$/, '') + 'K';
  return num.toFixed(2).replace(/\.00$/, '');
}

function formatExecutorPositions(positions) {
  if (!positions || positions.length === 0) {
    return {
      text: '🏊 <b>Active Positions</b> (Uniswap V3 / V4)\nNo active liquidity positions found on Robinhood Chain.',
      reply_markup: undefined,
    };
  }

  let totalPortfolioUsd = 0;
  let totalDepUsd = 0;
  let totalUnclaimedUsd = 0;
  let totalEst24hUsd = 0;

  const lines = [`🏊 <b>Active Liquidity Positions (${positions.length})</b>`];
  const keyboard = [];

  positions.forEach((pos, i) => {
    const pair = pos.symbol1 ? `${pos.symbol0}/${pos.symbol1}` : pos.symbol0;
    const versionTag = pos.isV4 !== false ? 'V4' : 'V3';
    const rangeStr = pos.tickUpper ? `${pos.tickLower} <> ${pos.tickUpper}` : pos.tickLower;
    const ageStr = pos.ageStr || '-';

    // Deposit line
    const dep0Str = formatCompactNumber(pos.depAmount0 || 0);
    const dep1Str = formatCompactNumber(pos.depAmount1 || 0);
    const depTokens = pos.symbol1 ? `${dep0Str} ${pos.symbol0} + ${dep1Str} ${pos.symbol1}` : `${dep0Str} ${pos.symbol0}`;
    const depUsdStr = (pos.depTotalUsd || 0) > 0 ? ` (~$${pos.depTotalUsd.toFixed(2)} USD)` : '';
    const depositLine = (pos.depAmount0 > 0 || pos.depAmount1 > 0 || pos.depTotalUsd > 0)
      ? `\n   Deposit: <b>${depTokens}${depUsdStr}</b>`
      : '';

    // Current line
    const amt0Str = formatCompactNumber(pos.amount0 || 0);
    const amt1Str = formatCompactNumber(pos.amount1 || 0);
    const currTokens = pos.symbol1 ? `${amt0Str} ${pos.symbol0} + ${amt1Str} ${pos.symbol1}` : `${amt0Str} ${pos.symbol0}`;
    const posUsd = pos.totalUsd || 0;
    const usdStr = posUsd > 0 ? ` (~$${posUsd.toFixed(2)} USD)` : '';
    const currentLine = `\n   Current: <b>${currTokens}${usdStr}</b>`;

    // Unclaimed fees line
    const unc0Str = formatCompactNumber(pos.unclaimed0 || 0);
    const unc1Str = formatCompactNumber(pos.unclaimed1 || 0);
    const uncUsd = pos.unclaimedUsd || 0;
    const unclaimedTokens = pos.symbol1 ? `${unc0Str} ${pos.symbol0} + ${unc1Str} ${pos.symbol1}` : `${unc0Str} ${pos.symbol0}`;
    const uncUsdStr = uncUsd > 0 ? ` (~$${uncUsd.toFixed(2)} USD)` : '';
    const unclaimedLine = (pos.unclaimed0 > 0 || pos.unclaimed1 > 0 || uncUsd > 0)
      ? `\n   Unclaimed Fees: <b>${unclaimedTokens}${uncUsdStr}</b>`
      : '';

    // 24h Fees line
    const est24hUsd = pos.est24hUsd || 0;
    const est24hPercent = pos.est24hPercent || 0;
    const est24hLine = est24hUsd > 0
      ? `\n   24h Est. Fees: <b>+$${est24hUsd.toFixed(2)} USD/day (+${est24hPercent.toFixed(2)}%/day) ⚡</b>`
      : '';

    // PnL line
    const pnlUsd = pos.pnlUsd || 0;
    const pnlPercent = pos.pnlPercent || 0;
    const pnlEmoji = pnlUsd >= 0 ? '📈' : '📉';
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    const pnlLine = (pos.depTotalUsd || 0) > 0
      ? `\n   PnL: <b>${pnlSign}$${pnlUsd.toFixed(2)} USD (${pnlSign}${pnlPercent.toFixed(2)}%) ${pnlEmoji}</b>`
      : '';

    totalPortfolioUsd += posUsd;
    totalDepUsd += (pos.depTotalUsd || 0);
    totalUnclaimedUsd += uncUsd;
    totalEst24hUsd += est24hUsd;

    lines.push(
      `\n${i + 1}. <b>${pair}</b> (${pos.fee}% ${versionTag}) - Position #${pos.tokenId}` +
        depositLine +
        currentLine +
        unclaimedLine +
        est24hLine +
        pnlLine +
        `\n   Age: <b>${ageStr}</b>` +
        `\n   Price Range: <b>${rangeStr}</b>`,
    );

    keyboard.push([
      {
        text: `❌ Close #${pos.tokenId} (${pair} → USDG)`,
        callback_data: `close_pos_${pos.tokenId}`,
      },
    ]);
  });

  const totalValueWithFees = totalPortfolioUsd + totalUnclaimedUsd;
  const netPnlUsd = totalDepUsd > 0 ? totalValueWithFees - totalDepUsd : 0;
  const netPnlPercent = totalDepUsd > 0 ? (netPnlUsd / totalDepUsd) * 100 : 0;
  const pnlSign = netPnlUsd >= 0 ? '+' : '';

  let summaryHeader = `💰 <b>Total Positions Value: ~$${totalPortfolioUsd.toFixed(2)} USD</b>`;
  if (totalUnclaimedUsd > 0) {
    summaryHeader += ` (Unclaimed: ~$${totalUnclaimedUsd.toFixed(2)} USD)`;
  }
  if (totalEst24hUsd > 0) {
    summaryHeader += ` | 24h Est: <b>+$${totalEst24hUsd.toFixed(2)} USD/day</b>`;
  }
  if (totalDepUsd > 0) {
    summaryHeader += ` | PnL: <b>${pnlSign}$${netPnlUsd.toFixed(2)} (${pnlSign}${netPnlPercent.toFixed(1)}%)</b>`;
  }

  lines.unshift(summaryHeader + '\n');

  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: keyboard },
  };
}

function buildTxButtons(activity, wallet) {
  if (wallet.chain !== 'robinhood' || !activity?.length) return undefined;

  const keyboard = [];
  activity.slice(0, 3).forEach((tx) => {
    const eventType = (tx.event_type || '').toLowerCase();
    const symbol = tx.token?.symbol || tx.token_symbol || 'TOKEN';
    if (eventType === 'add') {
      keyboard.push([
        {
          text: `📥 Copy Add Liq ($50) — ${symbol}`,
          callback_data: `copy_add_${tx.tx_hash.slice(0, 10)}`,
        },
      ]);
    } else if (eventType === 'remove') {
      keyboard.push([
        {
          text: `📤 Copy Remove Liq — ${symbol}`,
          callback_data: `copy_remove_${tx.tx_hash.slice(0, 10)}`,
        },
      ]);
    }
  });

  return keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
}

module.exports = {
  init,
  sendMessage,
  formatTx,
  formatStats,
  formatHoldings,
  formatExecutorBalance,
  formatExecutorPositions,
  buildTxButtons,
  shortAddr,
  displayName,
};
