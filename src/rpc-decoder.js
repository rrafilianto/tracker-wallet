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

    data.items.forEach(item => {
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
            amount,
            direction: isFromWallet ? 'out' : 'in',
            tokenAddress: item.token?.address_hash
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
          params: [txHash]
        })
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
            transfers.push({
              tokenAddress: log.address.toLowerCase(),
              direction: from === paddedWallet ? 'out' : 'in',
              from: cleanAddress(from),
              to: cleanAddress(to),
              rawValue
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
        dex: pair.dexId
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

module.exports = {
  getLiquidityTransfers,
  fetchDexScreenerLiquidity,
};
