const { ethers } = require('ethers');

// Standard ABIs
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

// Addresses on Robinhood Chain
const UNISWAP_V4_POSM_ADDRESS = process.env.UNISWAP_V4_POSM_ADDRESS || '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const UNISWAP_V4_STATEVIEW_ADDRESS = process.env.UNISWAP_V4_STATEVIEW_ADDRESS || '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const USDG_ADDRESS = process.env.USDG_ADDRESS || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const signed24 = (v) => (v >= 0x800000 ? v - 0x1000000 : v);
const MASK256 = (1n << 256n) - 1n;

async function getV4PositionDetails(tokenId, walletAddress) {
  const provider = getProvider();
  const posm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, provider);
  const sv = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const [owner, liq] = await Promise.all([
    posm.ownerOf(tokenId).catch(() => ethers.ZeroAddress),
    posm.getPositionLiquidity(tokenId).catch(() => 0n)
  ]);

  if (owner.toLowerCase() !== walletAddress.toLowerCase() || liq === 0n) return null;

  const [pk, infoRaw] = await posm.getPoolAndPositionInfo(tokenId);
  const info = BigInt(infoRaw);
  const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
  const fee = Number(pk.fee);
  const tickSpacing = Number(pk.tickSpacing);
  const c0 = pk.currency0;
  const c1 = pk.currency1;

  let dec0 = 18, sym0 = 'TOKEN0';
  let dec1 = 18, sym1 = 'TOKEN1';

  if (c0.toLowerCase() === USDG_ADDRESS.toLowerCase()) { dec0 = 6; sym0 = 'USDG'; }
  else {
    try {
      const c = new ethers.Contract(c0, ERC20_ABI, provider);
      const [d, s] = await Promise.all([c.decimals(), c.symbol()]);
      dec0 = Number(d); sym0 = s;
    } catch {}
  }

  if (c1.toLowerCase() === USDG_ADDRESS.toLowerCase()) { dec1 = 6; sym1 = 'USDG'; }
  else {
    try {
      const c = new ethers.Contract(c1, ERC20_ABI, provider);
      const [d, s] = await Promise.all([c.decimals(), c.symbol()]);
      dec1 = Number(d); sym1 = s;
    } catch {}
  }

  const poolId = ethers.keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [c0, c1, fee, tickSpacing, pk.hooks]
  ));

  const positionId = ethers.solidityPackedKeccak256(
    ['address', 'int24', 'int24', 'bytes32'],
    [UNISWAP_V4_POSM_ADDRESS, tickLower, tickUpper, ethers.toBeHex(BigInt(tokenId), 32)]
  );

  const [s0, fgInside, posInfo] = await Promise.all([
    sv.getSlot0(poolId),
    sv.getFeeGrowthInside(poolId, tickLower, tickUpper).catch(() => [0n, 0n]),
    sv.getPositionInfo(poolId, positionId).catch(() => [0n, 0n, 0n])
  ]);

  const tick = Number(s0.tick);
  const CHAIN_ID = 4663;
  const cur0 = c0.toLowerCase() === ethers.ZeroAddress ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(c0), dec0, sym0);
  const cur1 = c1.toLowerCase() === ethers.ZeroAddress ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(c1), dec1, sym1);

  const pool = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), '0', tick);
  const pos = new Position({ pool, liquidity: liq.toString(), tickLower, tickUpper });

  const fee0raw = (((BigInt(fgInside[0]) - BigInt(posInfo[1])) & MASK256) * BigInt(liq)) >> 128n;
  const fee1raw = (((BigInt(fgInside[1]) - BigInt(posInfo[2])) & MASK256) * BigInt(liq)) >> 128n;

  const fee0 = CurrencyAmount.fromRawAmount(cur0, fee0raw.toString());
  const fee1 = CurrencyAmount.fromRawAmount(cur1, fee1raw.toString());

  const total0 = pos.amount0.add(fee0);
  const total1 = pos.amount1.add(fee1);

  const isC0Usd = c0.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const isC1Usd = c1.toLowerCase() === USDG_ADDRESS.toLowerCase();

  let valueUsd = 0;
  let feeUsd = 0;

  if (isC0Usd) {
    const val1In0 = Number(pool.priceOf(cur1).quote(total1).toExact());
    valueUsd = Number(total0.toExact()) + val1In0;
    const fee1In0 = Number(pool.priceOf(cur1).quote(fee1).toExact());
    feeUsd = Number(fee0.toExact()) + fee1In0;
  } else if (isC1Usd) {
    const val0In1 = Number(pool.priceOf(cur0).quote(total0).toExact());
    valueUsd = Number(total1.toExact()) + val0In1;
    const fee0In1 = Number(pool.priceOf(cur0).quote(fee0).toExact());
    feeUsd = Number(fee1.toExact()) + fee0In1;
  }

  let rangeStr = 'Concentrated';
  try {
    const uriData = await posm.tokenURI(tokenId);
    if (uriData.startsWith('data:application/json;base64,')) {
      const jsonStr = Buffer.from(uriData.replace('data:application/json;base64,', ''), 'base64').toString('utf-8');
      const meta = JSON.parse(jsonStr);
      const name = meta.name || '';
      const parts = name.split(' - ');
      if (parts.length >= 4) {
        rangeStr = `$${parts[3].replace('<>', ' - $')}`;
      }
    }
  } catch {}

  return {
    tokenId,
    sym0,
    sym1,
    dec0,
    dec1,
    amount0: Number(pos.amount0.toExact()),
    amount1: Number(pos.amount1.toExact()),
    unclaimed0: Number(fee0.toExact()),
    unclaimed1: Number(fee1.toExact()),
    valueUsd,
    feeUsd,
    feePct: fee / 10000,
    rangeStr
  };
}

function getAmountsForLiquidity(liquidityStr, tickCurrent, tickLower, tickUpper, dec0 = 18, dec1 = 18) {
  try {
    const liq = Number(liquidityStr);
    if (isNaN(liq) || liq <= 0) return { amount0: 0, amount1: 0 };

    const tLower = Number(tickLower);
    const tUpper = Number(tickUpper);
    const tCurr = Number(tickCurrent);

    const sqrtRatioA = Math.pow(1.0001, tLower / 2);
    const sqrtRatioB = Math.pow(1.0001, tUpper / 2);

    let amount0Raw = 0;
    let amount1Raw = 0;

    if (tCurr < tLower) {
      amount0Raw = (liq * (sqrtRatioB - sqrtRatioA)) / (sqrtRatioA * sqrtRatioB);
      amount1Raw = 0;
    } else if (tCurr >= tUpper) {
      amount1Raw = liq * (sqrtRatioB - sqrtRatioA);
      amount0Raw = 0;
    } else {
      const sqrtRatioCurrent = Math.pow(1.0001, tCurr / 2);
      amount0Raw = (liq * (sqrtRatioB - sqrtRatioCurrent)) / (sqrtRatioCurrent * sqrtRatioB);
      amount1Raw = liq * (sqrtRatioCurrent - sqrtRatioA);
    }

    const amount0 = Math.max(0, amount0Raw / Math.pow(10, dec0));
    const amount1 = Math.max(0, amount1Raw / Math.pow(10, dec1));

    return { amount0, amount1 };
  } catch {
    return { amount0: 0, amount1: 0 };
  }
}

function calculatePositionUsd(amount0, amount1, token0Addr, token1Addr, sqrtPriceX96, dec0 = 18, dec1 = 18) {
  try {
    let price0Usd = 0;
    let price1Usd = 0;

    const isToken0Usdg = token0Addr && token0Addr.toLowerCase() === USDG_ADDRESS.toLowerCase();
    const isToken1Usdg = token1Addr && token1Addr.toLowerCase() === USDG_ADDRESS.toLowerCase();

    if (sqrtPriceX96 && BigInt(sqrtPriceX96) > 0n) {
      const sqrtRatio = Number(sqrtPriceX96) / Math.pow(2, 96);
      const rawPrice = sqrtRatio * sqrtRatio; // token1 per token0 (unadjusted)
      const token0PriceInToken1 = rawPrice * Math.pow(10, Number(dec0) - Number(dec1));

      if (isToken1Usdg) {
        price0Usd = token0PriceInToken1;
        price1Usd = 1.0;
      } else if (isToken0Usdg) {
        price0Usd = 1.0;
        price1Usd = token0PriceInToken1 > 0 ? 1 / token0PriceInToken1 : 0;
      } else {
        price0Usd = 0;
        price1Usd = 0;
      }
    } else {
      if (isToken0Usdg) price0Usd = 1.0;
      if (isToken1Usdg) price1Usd = 1.0;
    }

    const totalUsd = amount0 * price0Usd + amount1 * price1Usd;
    return { totalUsd, price0Usd, price1Usd };
  } catch {
    return { totalUsd: 0, price0Usd: 0, price1Usd: 0 };
  }
}

async function fetchMintDeposit(mintTxHash, walletAddr, token0Addr, token1Addr, dec0 = 18, dec1 = 18, sqrtPriceX96 = 0n, sym0 = '', sym1 = '') {
  if (!mintTxHash || !walletAddr) return { depAmount0: 0, depAmount1: 0, depTotalUsd: 0 };
  try {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/transactions/${mintTxHash}`);
    const data = await res.json();
    if (!data.token_transfers) return { depAmount0: 0, depAmount1: 0, depTotalUsd: 0 };

    const walletLower = walletAddr.toLowerCase();
    let depAmount0 = 0;
    let depAmount1 = 0;

    data.token_transfers.forEach(t => {
      const fromAddr = t.from?.hash?.toLowerCase();
      if (fromAddr === walletLower) {
        const tAddr = t.token?.address_hash?.toLowerCase();
        const tSym = (t.token?.symbol || '').toUpperCase();
        const rawVal = BigInt(t.total?.value || '0');
        const decimals = Number(t.token?.decimals || 18);
        const val = Number(rawVal) / Math.pow(10, decimals);

        if (token0Addr && tAddr === token0Addr.toLowerCase()) {
          depAmount0 += val;
        } else if (token1Addr && tAddr === token1Addr.toLowerCase()) {
          depAmount1 += val;
        } else if (sym0 && tSym === sym0.toUpperCase()) {
          depAmount0 += val;
        } else if (sym1 && tSym === sym1.toUpperCase()) {
          depAmount1 += val;
        } else if (decimals === dec0 && depAmount0 === 0) {
          depAmount0 += val;
        } else if (decimals === dec1 && depAmount1 === 0) {
          depAmount1 += val;
        }
      }
    });

    const t0Addr = token0Addr || (sym0 === 'USDG' ? USDG_ADDRESS : null);
    const t1Addr = token1Addr || (sym1 === 'USDG' ? USDG_ADDRESS : null);

    let { totalUsd: depTotalUsd } = calculatePositionUsd(depAmount0, depAmount1, t0Addr, t1Addr, sqrtPriceX96, dec0, dec1);

    if (depTotalUsd === 0) {
      if (sym0 === 'USDG' || dec0 === 6) depTotalUsd += depAmount0;
      if (sym1 === 'USDG' || dec1 === 6) depTotalUsd += depAmount1;
    }

    return { depAmount0, depAmount1, depTotalUsd };
  } catch {
    return { depAmount0: 0, depAmount1: 0, depTotalUsd: 0 };
  }
}

function getRobinhoodRpcUrl() {
  if (process.env.ALCHEMY_RPC_URL) return process.env.ALCHEMY_RPC_URL;
  if (process.env.ALCHEMY_API_KEY && process.env.ALCHEMY_API_KEY !== 'your_alchemy_api_key_here') {
    return `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  }
  return 'https://rpc.mainnet.chain.robinhood.com';
}

function getProvider() {
  const rpcUrl = getRobinhoodRpcUrl();
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getWallet() {
  const pk = process.env.EXECUTIVE_PRIVATE_KEY || process.env.EXECUTIVE_PRIVATE_KEY || process.env.RH_WALLET_KEY;
  if (!pk || pk === '0x...' || pk.length < 32) {
    throw new Error('EXECUTIVE_PRIVATE_KEY not configured in .env');
  }
  const provider = getProvider();
  return new ethers.Wallet(pk, provider);
}

function getExecutorAddress() {
  try {
    const wallet = getWallet();
    return wallet.address;
  } catch {
    return null;
  }
}

function formatAgeFromTimestamp(tsStr) {
  if (!tsStr) return '-';
  const diffMs = Date.now() - new Date(tsStr).getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`;
  if (diffHours > 0) return `${diffHours}h ${diffMins % 60}m`;
  return `${diffMins}m`;
}

async function getExecutorBalance() {
  const wallet = getWallet();
  const provider = wallet.provider;
  const ethBalance = await provider.getBalance(wallet.address);
  const formattedEth = ethers.formatEther(ethBalance);

  // Common tokens on Robinhood chain
  const knownTokens = [
    { symbol: 'USDG', address: USDG_ADDRESS, decimals: 6 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 }
  ];

  const tokenBalances = [];
  for (const t of knownTokens) {
    try {
      const contract = new ethers.Contract(t.address, ERC20_ABI, provider);
      const bal = await contract.balanceOf(wallet.address);
      if (bal > 0n) {
        tokenBalances.push({
          symbol: t.symbol,
          address: t.address,
          balance: ethers.formatUnits(bal, t.decimals)
        });
      }
    } catch {
      // Ignore token balance error
    }
  }

  return {
    address: wallet.address,
    ethBalance: formattedEth,
    tokens: tokenBalances
  };
}

async function getExecutorPositions() {
  const wallet = getWallet();
  const provider = wallet.provider;
  const positions = [];

  // Fetch NFT mint timestamps & mint tx hashes dynamically from Blockscout
  const nftMintTsMap = {};
  const nftMintTxMap = {};
  try {
    const resTs = await fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/token-transfers?type=ERC-721`);
    const dataTs = await resTs.json();
    if (dataTs.items) {
      dataTs.items.forEach(item => {
        const tid = item.total?.token_id;
        const txHash = item.transaction_hash || item.tx_hash;
        if (tid && !nftMintTsMap[tid]) {
          if (item.timestamp) nftMintTsMap[tid] = item.timestamp;
          if (txHash) nftMintTxMap[tid] = txHash;
        }
      });
    }
  } catch {
    // Ignore age fetch error
  }

  // 2. Check Uniswap V4 Positions (UNI-V4-POSM - 100% Pure Dynamic On-Chain Query)
  try {
    const url = `https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/nft`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.items) {
      for (const item of data.items) {
        const tid = (item.id || item.token_id).toString();
        try {
          const v4Detail = await getV4PositionDetails(tid, wallet.address);
          if (!v4Detail) continue;

          // Initial deposit calculation for V4
          const mintTxHash = nftMintTxMap[tid];
          const { depAmount0, depAmount1, depTotalUsd } = await fetchMintDeposit(mintTxHash, wallet.address, null, null, v4Detail.dec0, v4Detail.dec1, 0n, v4Detail.sym0, v4Detail.sym1);

          const mintTsStr = nftMintTsMap[tid];
          let ageHours = 24;
          if (mintTsStr) {
            const ageMs = Date.now() - new Date(mintTsStr).getTime();
            ageHours = Math.max(0.5, ageMs / (1000 * 3600));
          }

          const totalPosUsd = v4Detail.valueUsd;
          const pnlUsd = depTotalUsd > 0 ? totalPosUsd - depTotalUsd : 0;
          const pnlPercent = depTotalUsd > 0 ? (pnlUsd / depTotalUsd) * 100 : 0;

          const est24hUsd = v4Detail.feeUsd > 0 ? (v4Detail.feeUsd / ageHours) * 24 : 0;
          const baseForYield = depTotalUsd > 0 ? depTotalUsd : (v4Detail.valueUsd > 0 ? v4Detail.valueUsd : 0);
          const est24hPercent = baseForYield > 0 ? (est24hUsd / baseForYield) * 100 : 0;

          const ageStr = formatAgeFromTimestamp(nftMintTsMap[tid]);

          positions.push({
            tokenId: tid,
            symbol0: v4Detail.sym0,
            symbol1: v4Detail.sym1,
            amount0: v4Detail.amount0,
            amount1: v4Detail.amount1,
            totalUsd: v4Detail.valueUsd - v4Detail.feeUsd,
            depAmount0,
            depAmount1,
            depTotalUsd,
            unclaimed0: v4Detail.unclaimed0,
            unclaimed1: v4Detail.unclaimed1,
            unclaimedUsd: v4Detail.feeUsd,
            est24hUsd,
            est24hPercent,
            pnlUsd,
            pnlPercent,
            fee: v4Detail.feePct,
            liquidity: 'Active',
            ageStr,
            tickLower: v4Detail.rangeStr,
            tickUpper: '',
            isV4: true
          });
        } catch {
          // Skip if burned or non-owned
        }
      }
    }
  } catch {
    // Skip V4 error
  }

  return positions;
}

async function executeCopyAddLiquidity(tx, amountUsd = 50) {
  const wallet = getWallet();
  const token0Addr = tx.token?.address || tx.token_address;
  const token1Addr = tx.quote_token?.token_address || tx.quote_address || USDG_ADDRESS;

  if (!token0Addr || !token1Addr) {
    throw new Error('Missing token contract addresses for liquidity minting');
  }

  // Approval for token0 and token1
  const token0 = new ethers.Contract(token0Addr, ERC20_ABI, wallet);
  const token1 = new ethers.Contract(token1Addr, ERC20_ABI, wallet);

  const parsedAmountUsd = ethers.parseUnits(amountUsd.toString(), 6); // Default USDG has 6 decimals

  // Check and approve allowance for V4 PositionManager
  const allow0 = await token0.allowance(wallet.address, UNISWAP_V4_POSM_ADDRESS).catch(() => 0n);
  if (allow0 < parsedAmountUsd) {
    const txApp0 = await token0.approve(UNISWAP_V4_POSM_ADDRESS, ethers.MaxUint256);
    await txApp0.wait();
  }

  const allow1 = await token1.allowance(wallet.address, UNISWAP_V4_POSM_ADDRESS).catch(() => 0n);
  if (allow1 < parsedAmountUsd) {
    const txApp1 = await token1.approve(UNISWAP_V4_POSM_ADDRESS, ethers.MaxUint256);
    await txApp1.wait();
  }

  const tickLower = tx.tick_lower ?? -887270;
  const tickUpper = tx.tick_upper ?? 887270;
  const fee = tx.fee ?? 3000;
  const tickSpacing = tx.tick_spacing ?? 60;
  const hooks = tx.hooks ?? ethers.ZeroAddress;

  // Use V4PositionPlanner from @uniswap/v4-sdk
  const planner = new v4sdk.V4PositionPlanner();
  planner.addMint(
    { currency0: token0Addr, currency1: token1Addr, fee, tickSpacing, hooks },
    tickLower,
    tickUpper,
    parsedAmountUsd.toString(),
    parsedAmountUsd.toString(),
    parsedAmountUsd.toString(),
    wallet.address,
    '0x'
  );

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const unlockData = planner.finalize();

  const posm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, wallet);
  const txResponse = await posm.modifyLiquidities(unlockData, deadline);
  const receipt = await txResponse.wait();
  return receipt.hash;
}

async function closePositionAndSwapToUsdg(tokenId) {
  const wallet = getWallet();
  const posm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, wallet);

  const deadline = Math.floor(Date.now() / 1000) + 600;

  // Use V4PositionPlanner to burn & collect liquidity on V4
  const planner = new v4sdk.V4PositionPlanner();
  planner.addBurn(tokenId, 0, 0, '0x');
  const unlockData = planner.finalize();

  const txResponse = await posm.modifyLiquidities(unlockData, deadline);
  const receipt = await txResponse.wait();
  return receipt.hash;
}

module.exports = {
  getExecutorAddress,
  getExecutorBalance,
  getExecutorPositions,
  executeCopyAddLiquidity,
  closePositionAndSwapToUsdg,
};
