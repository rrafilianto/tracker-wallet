const { TelegramBot } = require('node-telegram-bot-api');

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

function formatTx(activity, address, chain) {
  const lines = [`🔔 <b>[${chainLabel(chain)}] ${shortAddr(address)}</b>`];

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
    const type = typeLabels[tx.event_type?.toLowerCase()] || `🔄 ${(tx.event_type || '').toUpperCase()}`;
    const shortHash = tx.tx_hash ? ` <code>${tx.tx_hash.slice(0, 6)}</code>` : '';
    const usd = tx.cost_usd ? `$${Number(tx.cost_usd).toLocaleString()}` : '';
    const amount = tx.token_amount ? `${Number(tx.token_amount).toFixed(4)}` : '';
    const time = tx.timestamp ? new Date((typeof tx.timestamp === 'number' ? tx.timestamp : parseInt(tx.timestamp)) * 1000).toLocaleString() : '';

    lines.push(`${i + 1}. ${type} <b>${symbol}</b>${shortHash}`);
    if (amount) lines.push(`   Amount: ${amount}`);
    if (usd) lines.push(`   Value: ${usd}`);
    if (time) lines.push(`   ${time}`);
  });

  return lines.join('\n');
}

function formatStats(stats, address, chain) {
  if (!stats) return 'No stats available.';
  const lines = [`📊 <b>[${chainLabel(chain)}] ${shortAddr(address)}</b>`];
  if (stats.realized_profit !== undefined)
    lines.push(`PnL: <b>${stats.realized_profit >= 0 ? '+' : ''}$${Number(stats.realized_profit).toLocaleString()}</b>`);
  const winrate = stats.pnl_stat?.winrate;
  if (winrate !== undefined)
    lines.push(`Win Rate: <b>${(winrate * 100).toFixed(1)}%</b>`);
  if (stats.total_cost !== undefined)
    lines.push(`Total Spent: <b>$${Number(stats.total_cost).toLocaleString()}</b>`);
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
    const sym = h.token?.symbol || h.token_symbol || h.token_address?.slice(0, 6) || 'Unknown';
    const usd = h.usd_value ? `$${Number(h.usd_value).toLocaleString()}` : '';
    const pnl = h.total_profit ? ` ${h.total_profit >= 0 ? '+' : ''}$${Number(h.total_profit).toLocaleString()}` : '';
    lines.push(`• ${sym}: ${usd}${pnl}`);
  });
  return lines.join('\n');
}

module.exports = {
  init,
  sendMessage,
  formatTx,
  formatStats,
  formatHoldings,
  shortAddr,
};
