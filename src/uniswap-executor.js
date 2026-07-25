const { ethers } = require('ethers');
const { Token, CurrencyAmount, Ether } = require('@uniswap/sdk-core');
const v4sdk = require('@uniswap/v4-sdk');
const { Pool, Position } = v4sdk;
const rpcDecoder = require('./rpc-decoder');

// Standard Uniswap V4 fee tier → tickSpacing mapping (hooks = 0x0 default)
const STANDARD_FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const HOOKS_ZERO = '0x0000000000000000000000000000000000000000';

const UNISWAP_V4_POSM_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes32 positionInfo)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) returns (bytes)',
];

const STATEVIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  'function getPositionInfo(bytes32 poolId, bytes32 positionId) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];

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
const UNIVERSAL_ROUTER_ADDRESS = process.env.UNIVERSAL_ROUTER_ADDRESS || '0x8876789976deCbFcbBBe364623C63652dB8c0904';
const PERMIT2_ADDRESS = process.env.PERMIT2_ADDRESS || '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// Universal Router executes V4 swaps via command 0x10 (V4_SWAP)
const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];
const V4_SWAP_COMMAND = '0x10';

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
    rangeStr,
    tickLower,
    tickUpper,
    tickCurrent: tick,
    sqrtPriceX96: s0.sqrtPriceX96.toString(),
    isC0Usdg: isC0Usd,
    isC1Usdg: isC1Usd,
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

          const estHourlyUsd = v4Detail.feeUsd > 0 ? v4Detail.feeUsd / ageHours : 0;
          const baseForYield = depTotalUsd > 0 ? depTotalUsd : (v4Detail.valueUsd > 0 ? v4Detail.valueUsd : 0);
          const estHourlyPercent = baseForYield > 0 ? (estHourlyUsd / baseForYield) * 100 : 0;

          const ageStr = formatAgeFromTimestamp(nftMintTsMap[tid]);

          // Compute price range and inRange status
          const tickCurrent = Number(v4Detail.tickCurrent);
          const tickLower = Number(v4Detail.tickLower);
          const tickUpper = Number(v4Detail.tickUpper);
          const inRange = tickCurrent >= tickLower && tickCurrent <= tickUpper;

          let priceA = 0;
          let priceB = 0;
          let priceNow = 0;
          const sqrtP = Number(v4Detail.sqrtPriceX96) / Math.pow(2, 96);
          const rawNow = sqrtP * sqrtP;

          if (v4Detail.isC0Usdg) {
            priceA = Math.pow(10, v4Detail.dec1 - 6) / Math.pow(1.0001, tickLower);
            priceB = Math.pow(10, v4Detail.dec1 - 6) / Math.pow(1.0001, tickUpper);
            priceNow = Math.pow(10, v4Detail.dec1 - 6) / rawNow;
          } else if (v4Detail.isC1Usdg) {
            priceA = Math.pow(1.0001, tickLower) * Math.pow(10, v4Detail.dec0 - 6);
            priceB = Math.pow(1.0001, tickUpper) * Math.pow(10, v4Detail.dec0 - 6);
            priceNow = rawNow * Math.pow(10, v4Detail.dec0 - 6);
          } else {
            priceA = Math.pow(1.0001, tickLower) * Math.pow(10, v4Detail.dec0 - v4Detail.dec1);
            priceB = Math.pow(1.0001, tickUpper) * Math.pow(10, v4Detail.dec0 - v4Detail.dec1);
            priceNow = rawNow * Math.pow(10, v4Detail.dec0 - v4Detail.dec1);
          }

          const priceMin = Math.min(priceA, priceB);
          const priceMax = Math.max(priceA, priceB);

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
            estHourlyUsd,
            estHourlyPercent,
            pnlUsd,
            pnlPercent,
            fee: v4Detail.feePct,
            liquidity: 'Active',
            ageStr,
            tickLower: v4Detail.rangeStr,
            tickUpper: '',
            priceMin,
            priceMax,
            priceNow,
            inRange,
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
  const provider = wallet.provider;
  const CHAIN_ID = 4663;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // Step 1: Find tokenId minted in original tx to get pool key + tick range
  const txHash = tx.tx_hash;
  if (!txHash) throw new Error('No tx_hash in activity data');

  const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/transactions/${txHash}/token-transfers?type=ERC-721`);
  const data = await res.json();
  const mintTransfer = data.items?.find(item =>
    item.from?.hash === '0x0000000000000000000000000000000000000000' &&
    item.token?.address_hash?.toLowerCase() === UNISWAP_V4_POSM_ADDRESS.toLowerCase()
  );
  if (!mintTransfer?.total?.token_id) throw new Error('Could not find minted position NFT in original tx');
  const refTokenId = mintTransfer.total.token_id;

  // Step 2: Get pool key and tick range from original position
  const posm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, provider);
  const sv = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);

  const [pk, infoRaw] = await posm.getPoolAndPositionInfo(refTokenId);
  const info = BigInt(infoRaw);
  const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
  const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));

  // Step 3: Token metadata
  let dec0 = 18, sym0 = 'TOKEN0', dec1 = 18, sym1 = 'TOKEN1';
  const isC0Native = pk.currency0.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const isC1Native = pk.currency1.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  if (!isC0Native) {
    try { const c = new ethers.Contract(pk.currency0, ERC20_ABI, provider); [dec0, sym0] = await Promise.all([c.decimals().then(Number), c.symbol()]); } catch {}
  }
  if (!isC1Native) {
    try { const c = new ethers.Contract(pk.currency1, ERC20_ABI, provider); [dec1, sym1] = await Promise.all([c.decimals().then(Number), c.symbol()]); } catch {}
  }

  // Step 4: Current pool state
  const poolId = ethers.keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks]
  ));
  const s0 = await sv.getSlot0(poolId);

  // Step 5: Build Pool + Position from $amountUsd USDG
  const cur0 = isC0Native ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(pk.currency0), dec0, sym0);
  const cur1 = isC1Native ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(pk.currency1), dec1, sym1);
  const pool = new Pool(cur0, cur1, Number(pk.fee), Number(pk.tickSpacing), pk.hooks, s0.sqrtPriceX96.toString(), '0', Number(s0.tick));

  const isC0Usdg = pk.currency0.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const isC1Usdg = pk.currency1.toLowerCase() === USDG_ADDRESS.toLowerCase();
  if (!isC0Usdg && !isC1Usdg) throw new Error('Neither token is USDG — cannot determine deposit amount');

  const usdgRaw = ethers.parseUnits(amountUsd.toString(), 6).toString();
  const position = isC1Usdg
    ? Position.fromAmount1({ pool, tickLower, tickUpper, amount1: usdgRaw })
    : Position.fromAmount0({ pool, tickLower, tickUpper, amount0: usdgRaw, useFullPrecision: false });

  const { amount0: mint0, amount1: mint1 } = position.mintAmounts;
  const amount0Max = (BigInt(mint0.toString()) * 101n / 100n).toString();
  const amount1Max = (BigInt(mint1.toString()) * 101n / 100n).toString();

  // Step 6: Permit2 approvals
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
  async function ensurePermit2(tokenAddr, amountMax) {
    if (tokenAddr.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return;
    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    const erc20Allow = await erc20.allowance(wallet.address, PERMIT2_ADDRESS).catch(() => 0n);
    if (erc20Allow < BigInt(amountMax)) {
      await (await erc20.approve(PERMIT2_ADDRESS, ethers.MaxUint256)).wait();
    }
    const [p2Amount] = await permit2.allowance(wallet.address, tokenAddr, UNISWAP_V4_POSM_ADDRESS).catch(() => [0n]);
    if (p2Amount < BigInt(amountMax)) {
      await permit2.approve(tokenAddr, UNISWAP_V4_POSM_ADDRESS, BigInt(amountMax) * 2n, 2n ** 48n - 1n);
    }
  }
  await ensurePermit2(pk.currency0, amount0Max);
  await ensurePermit2(pk.currency1, amount1Max);

  // Step 7: Mint position
  const planner = new v4sdk.V4PositionPlanner();
  planner.addMint(pool, tickLower, tickUpper, position.liquidity.toString(), amount0Max, amount1Max, wallet.address, '0x');
  planner.addSettlePair(cur0, cur1);
  const unlockData = planner.finalize();

  const posmWallet = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, wallet);
  const txResponse = await posmWallet.modifyLiquidities(unlockData, deadline);
  const receipt = await txResponse.wait();
  return receipt.hash;
}

async function closePositionAndSwapToUsdg(tokenId) {
  const wallet = getWallet();
  const provider = wallet.provider;
  const posm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const CHAIN_ID = 4663;

  // Get pool key and tick range from position
  const [pk, infoRaw] = await posm.getPoolAndPositionInfo(tokenId);

  let dec0 = 18, sym0 = 'TOKEN0';
  let dec1 = 18, sym1 = 'TOKEN1';
  const isC0Native = pk.currency0.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const isC1Native = pk.currency1.toLowerCase() === ethers.ZeroAddress.toLowerCase();

  if (!isC0Native) {
    try {
      const c = new ethers.Contract(pk.currency0, ERC20_ABI, provider);
      [dec0, sym0] = await Promise.all([c.decimals().then(Number), c.symbol()]);
    } catch {}
  }
  if (!isC1Native) {
    try {
      const c = new ethers.Contract(pk.currency1, ERC20_ABI, provider);
      [dec1, sym1] = await Promise.all([c.decimals().then(Number), c.symbol()]);
    } catch {}
  }

  const cur0 = isC0Native ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(pk.currency0), dec0, sym0);
  const cur1 = isC1Native ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(pk.currency1), dec1, sym1);

  // Close LP position and withdraw underlying tokens to wallet.
  // NOTE: addBurn (Actions.BURN_POSITION) hanya menghancurkan NFT LP position (ERC-721 tokenId),
  //       BUKAN token ERC-20 underlying. Token0 & token1 di dalam posisi di-release ke PoolManager.
  //       addTakePair (Actions.TAKE_PAIR) lalu mengirim underlying token0 + token1 ke wallet user.
  //       Tidak ada token ERC-20 milik user yang dibakar/dihancurkan pada langkah ini.
  const planner = new v4sdk.V4PositionPlanner();
  planner.addBurn(tokenId, 0, 0, '0x');
  planner.addTakePair(cur0, cur1, wallet.address);
  const unlockData = planner.finalize();

  const burnTx = await posm.modifyLiquidities(unlockData, deadline);
  await burnTx.wait();

  // Swap non-USDG token to USDG via Universal Router
  const isC0Usdg = pk.currency0.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const isC1Usdg = pk.currency1.toLowerCase() === USDG_ADDRESS.toLowerCase();
  if (isC0Usdg && isC1Usdg) return burnTx.hash;

  const nonUsdgAddr = isC1Usdg ? pk.currency0 : pk.currency1;
  const zeroForOne = isC1Usdg; // swap currency0→currency1 if c1 is USDG

  const tokenContract = new ethers.Contract(nonUsdgAddr, ERC20_ABI, wallet);
  const balance = await tokenContract.balanceOf(wallet.address);
  if (balance === 0n) return burnTx.hash;

  // Approve Universal Router to spend non-USDG token
  const allowance = await tokenContract.allowance(wallet.address, UNIVERSAL_ROUTER_ADDRESS).catch(() => 0n);
  if (allowance < balance) {
    const approveTx = await tokenContract.approve(UNIVERSAL_ROUTER_ADDRESS, ethers.MaxUint256);
    await approveTx.wait();
  }

  // Build V4 exact-in single-hop swap
  const swapPlanner = new v4sdk.V4Planner();
  swapPlanner.addAction(v4sdk.Actions.SWAP_EXACT_IN_SINGLE, [{
    poolKey: { currency0: pk.currency0, currency1: pk.currency1, fee: pk.fee, tickSpacing: pk.tickSpacing, hooks: pk.hooks },
    zeroForOne,
    amountIn: balance,
    amountOutMinimum: 0n,
    hookData: '0x',
  }]);
  swapPlanner.addAction(v4sdk.Actions.SETTLE_ALL, [nonUsdgAddr, balance]);
  swapPlanner.addAction(v4sdk.Actions.TAKE_ALL, [USDG_ADDRESS, 0n]);

  const router = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, UNIVERSAL_ROUTER_ABI, wallet);
  const swapTx = await router.execute(V4_SWAP_COMMAND, [swapPlanner.finalize()], deadline);
  const swapReceipt = await swapTx.wait();
  return swapReceipt.hash;
}

async function ensurePermit2Allowance(wallet, tokenAddr, amountMax) {
  if (tokenAddr.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return;
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
  const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const erc20Allow = await erc20.allowance(wallet.address, PERMIT2_ADDRESS).catch(() => 0n);
  if (erc20Allow < BigInt(amountMax)) {
    await (await erc20.approve(PERMIT2_ADDRESS, ethers.MaxUint256)).wait();
  }
  const [p2Amount] = await permit2.allowance(wallet.address, tokenAddr, UNISWAP_V4_POSM_ADDRESS).catch(() => [0n]);
  if (p2Amount < BigInt(amountMax)) {
    await permit2.approve(tokenAddr, UNISWAP_V4_POSM_ADDRESS, BigInt(amountMax) * 2n, 2n ** 48n - 1n);
  }
}

async function findUsdgPool(tokenAddress) {
  if (!tokenAddress) throw new Error('tokenAddress required');
  if (tokenAddress.toLowerCase() === USDG_ADDRESS.toLowerCase()) {
    throw new Error('Cannot deploy USDG/USDG pool — address is USDG itself');
  }

  const provider = getProvider();
  const sv = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const tokenAddr = ethers.getAddress(tokenAddress);
  const usdgAddr = ethers.getAddress(USDG_ADDRESS);
  const [currency0, currency1] = tokenAddr.toLowerCase() < usdgAddr.toLowerCase()
    ? [tokenAddr, usdgAddr]
    : [usdgAddr, tokenAddr];
  const isC0Usdg = currency0.toLowerCase() === usdgAddr.toLowerCase();
  const isC1Usdg = currency1.toLowerCase() === usdgAddr.toLowerCase();

  // Fetch token metadata once (USDG hardcoded: 6 decimals)
  let tokenDec = 18, tokenSym = 'TOKEN';
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    [tokenDec, tokenSym] = await Promise.all([c.decimals().then(Number), c.symbol()]);
  } catch {}
  const dec0 = isC0Usdg ? 6 : tokenDec;
  const dec1 = isC1Usdg ? 6 : tokenDec;
  const sym0 = isC0Usdg ? 'USDG' : tokenSym;
  const sym1 = isC1Usdg ? 'USDG' : tokenSym;

  // Iterate standard fee tiers with hooks=0x0
  for (const { fee, tickSpacing } of STANDARD_FEE_TIERS) {
    const poolId = ethers.keccak256(coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [currency0, currency1, fee, tickSpacing, HOOKS_ZERO]
    ));
    try {
      const s0 = await sv.getSlot0(poolId);
      if (s0.sqrtPriceX96 > 0n) {
        return {
          pk: { currency0, currency1, fee, tickSpacing, hooks: HOOKS_ZERO },
          poolId,
          sqrtPriceX96: s0.sqrtPriceX96.toString(),
          tick: Number(s0.tick),
          dec0, dec1, sym0, sym1, isC0Usdg, isC1Usdg,
        };
      }
    } catch {}
  }

  // Fallback: DexScreener for pools with custom hooks / non-standard fee tiers
  try {
    const ds = await rpcDecoder.fetchDexScreenerLiquidity(tokenAddr);
    const dsQuoteUsdg = ds && ((ds.baseSymbol || '').toUpperCase() === 'USDG' || (ds.quoteSymbol || '').toUpperCase() === 'USDG');
    if (dsQuoteUsdg) {
      // DexScreener doesn't expose V4 poolKey directly; still return metadata so caller can surface a helpful message.
      // Best-effort: caller may treat this as "pool exists elsewhere but not accessible via standard fee tiers".
    }
  } catch {}

  return null;
}

// Returns ALL active USDG pools for a token across standard fee tiers, with TVL estimate.
async function findAllUsdgPools(tokenAddress) {
  if (!tokenAddress) throw new Error('tokenAddress required');
  if (tokenAddress.toLowerCase() === USDG_ADDRESS.toLowerCase()) {
    throw new Error('Cannot deploy USDG/USDG pool — address is USDG itself');
  }

  const provider = getProvider();
  const sv = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const tokenAddr = ethers.getAddress(tokenAddress);
  const usdgAddr = ethers.getAddress(USDG_ADDRESS);
  const [currency0, currency1] = tokenAddr.toLowerCase() < usdgAddr.toLowerCase()
    ? [tokenAddr, usdgAddr]
    : [usdgAddr, tokenAddr];
  const isC0Usdg = currency0.toLowerCase() === usdgAddr.toLowerCase();
  const isC1Usdg = !isC0Usdg;

  let tokenDec = 18, tokenSym = 'TOKEN';
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    [tokenDec, tokenSym] = await Promise.all([c.decimals().then(Number), c.symbol()]);
  } catch {}

  const dec0 = isC0Usdg ? 6 : tokenDec;
  const dec1 = isC1Usdg ? 6 : tokenDec;
  const sym0 = isC0Usdg ? 'USDG' : tokenSym;
  const sym1 = isC1Usdg ? 'USDG' : tokenSym;

  const pools = [];

  for (const { fee, tickSpacing } of STANDARD_FEE_TIERS) {
    const poolId = ethers.keccak256(coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [currency0, currency1, fee, tickSpacing, HOOKS_ZERO]
    ));
    try {
      const s0 = await sv.getSlot0(poolId);
      if (s0.sqrtPriceX96 > 0n) {
        // Estimate TVL from active liquidity:
        //   For TOKEN/USDG (USDG = c1, dec=6): TVL ≈ 2 × L × sqrtP / 1e6
        //   For USDG/TOKEN (USDG = c0, dec=6): TVL ≈ 2 × L / sqrtP / 1e6
        let tvlUsd = 0;
        try {
          const totalLiq = await sv.getLiquidity(poolId);
          if (totalLiq > 0n) {
            const liqNum = Number(totalLiq);
            const sqrtP = Number(s0.sqrtPriceX96) / Math.pow(2, 96);
            tvlUsd = isC1Usdg
              ? 2 * liqNum * sqrtP / 1e6
              : 2 * liqNum / sqrtP / 1e6;
          }
        } catch {}

        pools.push({
          pk: { currency0, currency1, fee, tickSpacing, hooks: HOOKS_ZERO },
          poolId,
          sqrtPriceX96: s0.sqrtPriceX96.toString(),
          tick: Number(s0.tick),
          dec0, dec1, sym0, sym1, isC0Usdg, isC1Usdg,
          tvlUsd,
        });
      }
    } catch {}
  }

  return pools;
}

// Re-fetch current sqrtPriceX96 + tick for a specific pool (for price refresh)
async function getPoolSlot0(poolId) {
  const provider = getWallet().provider;
  const sv = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);
  const s0 = await sv.getSlot0(poolId);
  if (!s0 || s0.sqrtPriceX96 === 0n) throw new Error('Pool tidak aktif atau tidak ditemukan');
  return {
    sqrtPriceX96: s0.sqrtPriceX96.toString(),
    tick: Number(s0.tick),
  };
}

async function executeAutoDeployLp(tokenAddress, amountUsd = 50, preFoundPool = null, rangePct = 20) {
  const wallet = getWallet();
  const provider = wallet.provider;
  const CHAIN_ID = 4663;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const poolInfo = preFoundPool || await findUsdgPool(tokenAddress);
  if (!poolInfo) throw new Error(`No USDG pool found for ${tokenAddress} across standard V4 fee tiers`);

  const { pk, sqrtPriceX96, tick, dec0, dec1, sym0, sym1, isC0Usdg, isC1Usdg } = poolInfo;
  const tickSpacing = Number(pk.tickSpacing);

  // Check USDG balance
  const usdgContract = new ethers.Contract(USDG_ADDRESS, ERC20_ABI, provider);
  const usdgBalance = await usdgContract.balanceOf(wallet.address);
  const usdgNeeded = ethers.parseUnits(amountUsd.toString(), 6);
  if (usdgBalance < usdgNeeded) {
    throw new Error(`Insufficient USDG balance: have ${ethers.formatUnits(usdgBalance, 6)}, need ${amountUsd}`);
  }

  // One-side lower LP tick range:
  // We want USDG liquidity that buys TOKEN as TOKEN price drops from priceNow down to priceNow * (1 - rangePct/100).
  // Note: If isC0Usdg is true (currency0=USDG, currency1=TOKEN), tokenPrice = 10^(dec1-6) / 1.0001^tick.
  //       Therefore, a LOWER TOKEN price corresponds to a HIGHER tick!
  //       If isC0Usdg is false (currency0=TOKEN, currency1=USDG), tokenPrice = 1.0001^tick * 10^(dec0-6).
  //       Therefore, a LOWER TOKEN price corresponds to a LOWER tick!
  const alignDown = (t, ts) => Math.floor(t / ts) * ts;
  const minTickAligned = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const maxTickAligned = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;

  const ratio = 1 - rangePct / 100;
  const rawTickDiff = Math.log(ratio) / Math.log(1.0001); // negative number (~ -6931 for 50%)
  const tickDiffAbs = Math.floor(Math.abs(rawTickDiff) / tickSpacing) * tickSpacing;

  let tickLower, tickUpper;
  if (isC0Usdg) {
    // currency0 is USDG: TOKEN price drops -> tick increases.
    // Range is [tickCurrent, tickCurrent + tickDiffAbs]
    tickLower = alignDown(tick, tickSpacing);
    tickUpper = tickLower + tickDiffAbs;
  } else {
    // currency1 is USDG: TOKEN price drops -> tick decreases.
    // Range is [tickCurrent - tickDiffAbs, tickCurrent]
    tickUpper = alignDown(tick, tickSpacing);
    tickLower = tickUpper - tickDiffAbs;
  }

  tickLower = Math.max(tickLower, minTickAligned);
  tickUpper = Math.min(tickUpper, maxTickAligned);
  if (tickLower >= tickUpper) {
    throw new Error(`Invalid tick range: lower=${tickLower} upper=${tickUpper}`);
  }

  // Build Pool + Position
  const isC0Native = pk.currency0.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const isC1Native = pk.currency1.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const cur0 = isC0Native ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(pk.currency0), dec0, sym0);
  const cur1 = isC1Native ? Ether.onChain(CHAIN_ID) : new Token(CHAIN_ID, ethers.getAddress(pk.currency1), dec1, sym1);
  const pool = new Pool(cur0, cur1, Number(pk.fee), tickSpacing, pk.hooks, sqrtPriceX96, '0', tick);

  // One-side lower → range fully below current tick → position is 100% currency1 (if USDG=c1) or 100% currency0 (if USDG=c0)
  const usdgRaw = usdgNeeded.toString();
  const position = isC1Usdg
    ? Position.fromAmount1({ pool, tickLower, tickUpper, amount1: usdgRaw })
    : Position.fromAmount0({ pool, tickLower, tickUpper, amount0: usdgRaw, useFullPrecision: false });

  const { amount0: mint0, amount1: mint1 } = position.mintAmounts;
  const amount0Max = (BigInt(mint0.toString()) * 101n / 100n).toString();
  const amount1Max = (BigInt(mint1.toString()) * 101n / 100n).toString();

  await ensurePermit2Allowance(wallet, pk.currency0, amount0Max);
  await ensurePermit2Allowance(wallet, pk.currency1, amount1Max);

  const planner = new v4sdk.V4PositionPlanner();
  planner.addMint(pool, tickLower, tickUpper, position.liquidity.toString(), amount0Max, amount1Max, wallet.address, '0x');
  planner.addSettlePair(cur0, cur1);
  const unlockData = planner.finalize();

  const posmWallet = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, wallet);
  const txResponse = await posmWallet.modifyLiquidities(unlockData, deadline);
  const receipt = await txResponse.wait();
  return {
    hash: receipt.hash,
    fee: Number(pk.fee),
    tickSpacing,
    tickLower,
    tickUpper,
    tokenSymbol: isC0Usdg ? sym1 : sym0,
  };
}

module.exports = {
  getExecutorAddress,
  getExecutorBalance,
  getExecutorPositions,
  executeCopyAddLiquidity,
  closePositionAndSwapToUsdg,
  findUsdgPool,
  findAllUsdgPools,
  getPoolSlot0,
  executeAutoDeployLp,
};
