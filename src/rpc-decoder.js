const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const RPC_ENDPOINTS = {
  eth: ['https://cloudflare-eth.com', 'https://eth.llamarpc.com'],
  bsc: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.org'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
  sol: ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']
};

const BLOCKSCOUT_APIS = {
  robinhood: 'https://robinhoodchain.blockscout.com/api/v2/transactions'
};

function padAddress(addr) {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function cleanAddress(topic) {
  return '0x' + topic.toLowerCase().slice(26);
}

async function getBlockscoutTransfers(chain, txHash, walletAddress) {
  const baseUrl = BLOCKSCOUT_APIS[chain];
  if (!baseUrl) return [];
  try {
    const res = await fetch(`${baseUrl}/${txHash}/token-transfers`);
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

    return transfers;
  } catch {
    return [];
  }
}

async function getEvmReceiptTransfers(chain, txHash, walletAddress) {
  if (chain === 'robinhood') {
    const bsTransfers = await getBlockscoutTransfers(chain, txHash, walletAddress);
    if (bsTransfers.length > 0) return bsTransfers;
  }

  const rpcs = RPC_ENDPOINTS[chain] || RPC_ENDPOINTS.eth;
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

async function getSolanaTransfers(txHash, walletAddress) {
  const rpcs = RPC_ENDPOINTS.sol;
  for (const rpcUrl of rpcs) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });
      const json = await res.json();
      if (!json.result || !json.result.meta) continue;

      const meta = json.result.meta;
      const preBalances = meta.preTokenBalances || [];
      const postBalances = meta.postTokenBalances || [];
      const accountMap = {};

      preBalances.forEach(item => {
        if (item.owner === walletAddress) {
          accountMap[item.accountIndex] = {
            mint: item.mint,
            pre: Number(item.uiTokenAmount.uiAmount || 0),
            post: 0,
            symbol: item.uiTokenAmount.symbol
          };
        }
      });

      postBalances.forEach(item => {
        if (item.owner === walletAddress) {
          if (!accountMap[item.accountIndex]) {
            accountMap[item.accountIndex] = {
              mint: item.mint,
              pre: 0,
              post: Number(item.uiTokenAmount.uiAmount || 0),
              symbol: item.uiTokenAmount.symbol
            };
          } else {
            accountMap[item.accountIndex].post = Number(item.uiTokenAmount.uiAmount || 0);
          }
        }
      });

      const transfers = [];
      Object.values(accountMap).forEach(info => {
        const delta = info.post - info.pre;
        if (Math.abs(delta) > 0.000001) {
          transfers.push({
            tokenAddress: info.mint,
            amount: Math.abs(delta),
            direction: delta < 0 ? 'out' : 'in',
            symbol: info.symbol
          });
        }
      });
      return transfers;
    } catch {
      // Ignore & try next RPC
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

async function getLiquidityTransfers(chain, txHash, walletAddress) {
  if (!txHash || !walletAddress) return [];
  if (chain === 'sol') {
    return getSolanaTransfers(txHash, walletAddress);
  } else {
    return getEvmReceiptTransfers(chain, txHash, walletAddress);
  }
}

module.exports = {
  getLiquidityTransfers,
  fetchDexScreenerLiquidity,
};
