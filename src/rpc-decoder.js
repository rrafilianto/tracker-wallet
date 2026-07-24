const { ethers } = require('ethers');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function getChainRpcs() {
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const alchemyUrl = process.env.ALCHEMY_RPC_URL;
  const list = [];

  if (alchemyUrl) list.push(alchemyUrl);
  if (alchemyKey && alchemyKey !== 'your_alchemy_api_key_here') {
    list.push(`https://robinhood-mainnet.g.alchemy.com/v2/${alchemyKey}`);
  }
  list.push('https://robinhood-mainnet.g.alchemy.com/v2/demo');
  return list;
}

const BLOCKSCOUT_API = 'https://robinhoodchain.blockscout.com/api/v2/transactions';

const tokenMetadataCache = new Map([
  ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', { symbol: 'USDG', decimals: 6 }],
  ['0x0000000000000000000000000000000000000000', { symbol: 'ETH', decimals: 18 }],
]);

async function getTokenMetadata(tokenAddress) {
  if (!tokenAddress) return { symbol: 'UNKNOWN', decimals: 18 };
  const addrLower = tokenAddress.toLowerCase();
  if (tokenMetadataCache.has(addrLower)) return tokenMetadataCache.get(addrLower);

  const rpcs = getChainRpcs();
  for (const rpcUrl of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const contract = new ethers.Contract(
        tokenAddress,
        [
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ],
        provider
      );

      const [symbol, decimals] = await Promise.all([
        contract.symbol().catch(() => null),
        contract.decimals().catch(() => 18),
      ]);

      const finalSymbol = symbol || `0x${addrLower.slice(2, 6)}`;
      const finalDecimals = Number(decimals || 18);
      const result = { symbol: finalSymbol, decimals: finalDecimals };
      tokenMetadataCache.set(addrLower, result);
      return result;
    } catch {
      // Try next RPC URL
    }
  }

  const fallback = { symbol: `0x${addrLower.slice(2, 6)}`, decimals: 18 };
  tokenMetadataCache.set(addrLower, fallback);
  return fallback;
}

function padAddress(addr) {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function cleanAddress(topic) {
  return '0x' + topic.toLowerCase().slice(26);
}

async function getBlockscoutTransfers(chain, txHash, walletAddress) {
  try {
    const res = await fetch(`${BLOCKSCOUT_API}/${txHash}/token-transfers`);
    const data = await res.json();
    if (!data.items) return [];

    const walletLower = walletAddress.toLowerCase();
    const transfers = [];

    data.items.forEach((item) => {
      const fromAddr = item.from?.hash?.toLowerCase();
      const toAddr = item.to?.hash?.toLowerCase();
      const isFromWallet = fromAddr === walletLower;
      const isToWallet = toAddr === walletLower;

      if (isFromWallet || isToWallet) {
        const symbol = item.token?.symbol || 'UNKNOWN';
        const decimals = Number(item.token?.decimals || item.total?.decimals || 18);
        const rawVal = item.total?.value;
        if (rawVal) {
          const amount = Number(rawVal) / Math.pow(10, decimals);
          transfers.push({
            symbol,
            decimals,
            amount,
            direction: isFromWallet ? 'out' : 'in',
            tokenAddress: item.token?.address_hash?.toLowerCase(),
          });
        }
      }
    });

    const jsonStr = JSON.stringify(data.items);
    const rangeMatch = jsonStr.match(/([\d\.]+)<>([\d\.]+)/);
    if (rangeMatch) {
      transfers.range = `$${rangeMatch[1]} - $${rangeMatch[2]}`;
    }

    return transfers;
  } catch {
    return [];
  }
}

async function getEvmReceiptTransfers(chain, txHash, walletAddress) {
  const bsTransfers = await getBlockscoutTransfers(chain, txHash, walletAddress);
  if (bsTransfers.length > 0) return bsTransfers;

  const rpcs = getChainRpcs();
  const paddedWallet = padAddress(walletAddress);

  for (const rpcUrl of rpcs) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        }),
      });
      const json = await res.json();
      if (!json.result || !json.result.logs) continue;

      const transfers = [];
      for (const log of json.result.logs) {
        if (log.topics && log.topics[0] === TRANSFER_TOPIC && log.topics.length >= 3) {
          const from = log.topics[1].toLowerCase();
          const to = log.topics[2].toLowerCase();

          if (from === paddedWallet || to === paddedWallet) {
            const rawValHex = log.data === '0x' || !log.data ? '0x0' : log.data;
            const rawValue = BigInt(rawValHex).toString();
            const tokenAddr = log.address.toLowerCase();
            const meta = await getTokenMetadata(tokenAddr);
            const amount = Number(BigInt(rawValue)) / Math.pow(10, meta.decimals);

            transfers.push({
              tokenAddress: tokenAddr,
              symbol: meta.symbol,
              decimals: meta.decimals,
              amount,
              direction: from === paddedWallet ? 'out' : 'in',
              from: cleanAddress(from),
              to: cleanAddress(to),
              rawValue,
            });
          }
        }
      }
      return transfers;
    } catch {
      // Ignore RPC error & try next
    }
  }
  return [];
}

async function fetchDexScreenerLiquidity(tokenAddress) {
  if (!tokenAddress) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const json = await res.json();
    if (json.pairs && json.pairs.length > 0) {
      const pair = json.pairs[0];
      return {
        baseSymbol: pair.baseToken?.symbol,
        quoteSymbol: pair.quoteToken?.symbol,
        baseAmount: pair.liquidity?.base,
        quoteAmount: pair.liquidity?.quote,
        usdValue: pair.liquidity?.usd,
        dex: pair.dexId,
      };
    }
  } catch {
    // Ignore error
  }
  return null;
}

async function getLiquidityTransfers(chain = 'robinhood', txHash, walletAddress) {
  if (!txHash || !walletAddress) return [];
  return getEvmReceiptTransfers('robinhood', txHash, walletAddress);
}

function analyzeAndClassifyTx(transfers, walletAddress, tx = {}) {
  const inTransfers = (transfers || []).filter((t) => t.direction === 'in');
  const outTransfers = (transfers || []).filter((t) => t.direction === 'out');

  const isQuote = (t) => {
    const sym = (t.symbol || '').toUpperCase();
    return sym === 'USDG' || sym === 'ETH' || sym === 'WETH' || sym === 'USDC' || sym === 'USDT';
  };

  const outQuote = outTransfers.find(isQuote);
  const outBase = outTransfers.find((t) => !isQuote(t));
  const inQuote = inTransfers.find(isQuote);
  const inBase = inTransfers.find((t) => !isQuote(t));

  let eventType = 'transfer';
  let mainToken = null;
  let quoteToken = null;
  let tokenAmount = 0;
  let quoteAmount = 0;
  let usdValue = 0;

  if (outQuote && inBase) {
    eventType = 'buy';
    mainToken = { symbol: inBase.symbol, address: inBase.tokenAddress };
    quoteToken = { symbol: outQuote.symbol, token_address: outQuote.tokenAddress };
    tokenAmount = inBase.amount;
    quoteAmount = outQuote.amount;
    if (outQuote.symbol === 'USDG') usdValue = quoteAmount;
  } else if (outBase && inQuote) {
    eventType = 'sell';
    mainToken = { symbol: outBase.symbol, address: outBase.tokenAddress };
    quoteToken = { symbol: inQuote.symbol, token_address: inQuote.tokenAddress };
    tokenAmount = outBase.amount;
    quoteAmount = inQuote.amount;
    if (inQuote.symbol === 'USDG') usdValue = quoteAmount;
  } else if (outTransfers.length >= 2 || (outBase && outQuote)) {
    eventType = 'add';
    mainToken = outBase
      ? { symbol: outBase.symbol, address: outBase.tokenAddress }
      : { symbol: outTransfers[0].symbol, address: outTransfers[0].tokenAddress };
    quoteToken = outQuote
      ? { symbol: outQuote.symbol, token_address: outQuote.tokenAddress }
      : (outTransfers[1] ? { symbol: outTransfers[1].symbol, token_address: outTransfers[1].tokenAddress } : null);
    tokenAmount = outBase ? outBase.amount : outTransfers[0]?.amount || 0;
    quoteAmount = outQuote ? outQuote.amount : outTransfers[1]?.amount || 0;
  } else if (inTransfers.length >= 2 || (inBase && inQuote)) {
    eventType = 'remove';
    mainToken = inBase
      ? { symbol: inBase.symbol, address: inBase.tokenAddress }
      : { symbol: inTransfers[0].symbol, address: inTransfers[0].tokenAddress };
    quoteToken = inQuote
      ? { symbol: inQuote.symbol, token_address: inQuote.tokenAddress }
      : (inTransfers[1] ? { symbol: inTransfers[1].symbol, token_address: inTransfers[1].tokenAddress } : null);
    tokenAmount = inBase ? inBase.amount : inTransfers[0]?.amount || 0;
    quoteAmount = inQuote ? inQuote.amount : inTransfers[1]?.amount || 0;
  } else if (inTransfers.length === 1 && outTransfers.length === 0) {
    eventType = 'transferin';
    mainToken = { symbol: inTransfers[0].symbol, address: inTransfers[0].tokenAddress };
    tokenAmount = inTransfers[0].amount;
  } else if (outTransfers.length === 1 && inTransfers.length === 0) {
    eventType = 'transferout';
    mainToken = { symbol: outTransfers[0].symbol, address: outTransfers[0].tokenAddress };
    tokenAmount = outTransfers[0].amount;
  } else if (outBase && inBase) {
    eventType = 'buy';
    mainToken = { symbol: inBase.symbol, address: inBase.tokenAddress };
    quoteToken = { symbol: outBase.symbol, token_address: outBase.tokenAddress };
    tokenAmount = inBase.amount;
    quoteAmount = outBase.amount;
  } else if (outTransfers.length > 0) {
    eventType = 'add';
    mainToken = { symbol: outTransfers[0].symbol, address: outTransfers[0].tokenAddress };
    tokenAmount = outTransfers[0].amount;
  } else if (inTransfers.length > 0) {
    eventType = 'remove';
    mainToken = { symbol: inTransfers[0].symbol, address: inTransfers[0].tokenAddress };
    tokenAmount = inTransfers[0].amount;
  }

  if (!mainToken && transfers && transfers.length > 0) {
    mainToken = { symbol: transfers[0].symbol, address: transfers[0].tokenAddress };
  }

  return {
    event_type: eventType,
    token: mainToken || { symbol: 'TOKEN', address: tx?.to },
    quote_token: quoteToken || { symbol: 'USDG', token_address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' },
    token_amount: tokenAmount,
    quote_amount: quoteAmount,
    cost_usd: usdValue,
  };
}

module.exports = {
  getLiquidityTransfers,
  fetchDexScreenerLiquidity,
  getTokenMetadata,
  analyzeAndClassifyTx,
};

