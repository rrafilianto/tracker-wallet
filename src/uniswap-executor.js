const { ethers } = require('ethers');
const { Token, CurrencyAmount, Ether } = require('@uniswap/sdk-core');
const v4sdk = require('@uniswap/v4-sdk');
const { Pool, Position } = v4sdk;
const v3sdk = require('@uniswap/v3-sdk');
const rpcDecoder = require('./rpc-decoder');
const config = require('./config');

// Uniswap V4 fee tiers (supports any fee tier, including >1% fees: 2%, 3%, 5%, 10%)
const ALL_FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },       // 0.01%
  { fee: 500, tickSpacing: 10 },      // 0.05%
  { fee: 1000, tickSpacing: 10 },     // 0.10%
  { fee: 2000, tickSpacing: 20 },     // 0.20%
  { fee: 3000, tickSpacing: 60 },     // 0.30%
  { fee: 5000, tickSpacing: 60 },     // 0.50%
  { fee: 10000, tickSpacing: 200 },   // 1.00%
  { fee: 20000, tickSpacing: 200 },   // 2.00%
  { fee: 30000, tickSpacing: 200 },   // 3.00%
  { fee: 50000, tickSpacing: 200 },   // 5.00%
  { fee: 100000, tickSpacing: 200 },  // 10.00%
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

const safeAddr = (addr) => (addr ? ethers.getAddress(addr.toString().toLowerCase()) : ethers.ZeroAddress);

// Addresses on Robinhood Chain (Hardcoded & EIP-55 Checksummed)
const UNISWAP_V4_POSM_ADDRESS      = '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const UNISWAP_V4_STATEVIEW_ADDRESS = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const USDG_ADDRESS                 = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const UNIVERSAL_ROUTER_ADDRESS     = '0x8876789976dEcBfCbBbe364623C63652db8C0904';
const PERMIT2_ADDRESS              = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const WETH_ADDRESS                 = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const UNISWAP_V3_FACTORY_ADDRESS   = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const UNISWAP_V3_POSM_ADDRESS      = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';

// Universal Router executes V4 swaps via command 0x10 (V4_SWAP)
const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];
const V4_SWAP_COMMAND = '0x10';

// Robinhood Chain Universal Router menggunakan SWAP_EXACT_IN (path-based, 0x07)
// bukan SWAP_EXACT_IN_SINGLE (0x06). Dikonfirmasi dari decode on-chain tx sukses.
// Action codes: SWAP_EXACT_IN=0x07, SETTLE=0x0b, TAKE=0x0e
//
// Router ini menggunakan Universal Router V2.1.1 struct:
// SWAP_EXACT_IN: (currencyIn, PathKey[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)
// SETTLE: (address currency, uint256 amount=0, bool payerIsUser=true)
// TAKE: (address currency, address recipient, uint256 amount=0 means all)
//
// Helper: build V4 swap input (bytes) untuk router.execute(V4_SWAP_COMMAND, [input], deadline)
function buildV4SwapCalldata(tokenIn, tokenOut, fee, tickSpacing, hooks, amountIn, recipient) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const HOOKS = hooks || HOOKS_ZERO;

  // SWAP_EXACT_IN params (V2.1.1 struct, dengan minHopPriceX36):
  // (address currencyIn, PathKey[] path, uint256[] minHopPriceX36, uint128 amountIn, uint128 amountOutMinimum)
  const pathKeyType = '(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)';
  const swapParam = coder.encode(
    ['(address currencyIn,' + pathKeyType + '[] path,uint256[] minHopPriceX36,uint128 amountIn,uint128 amountOutMinimum)'],
    [{
      currencyIn: tokenIn,
      path: [{ intermediateCurrency: tokenOut, fee, tickSpacing, hooks: HOOKS, hookData: '0x' }],
      minHopPriceX36: [0n], // 0 = no minimum hop price constraint
      amountIn,
      amountOutMinimum: 0n,
    }]
  );

  // SETTLE params: (address currency, uint256 amount=0 berarti settle semua, bool payerIsUser=true)
  // amount=0 adalah pattern yang benar (dikonfirmasi dari on-chain tx)
  const settleParam = coder.encode(['address', 'uint256', 'bool'], [tokenIn, 0n, true]);

  // TAKE params: (address currency, address recipient, uint256 amount=0 means all)
  const takeParam = coder.encode(['address', 'address', 'uint256'], [tokenOut, recipient, 0n]);

  // V4 actions: SWAP_EXACT_IN(0x07) + SETTLE(0x0b) + TAKE(0x0e)
  const actions = '0x070b0e';
  return coder.encode(['bytes', 'bytes[]'], [actions, [swapParam, settleParam, takeParam]]);
}

// Uniswap V3 ABIs
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];
const UNISWAP_V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
];
const UNISWAP_V3_POSM_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function burn(uint256 tokenId)',
];
const WETH9_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 wad)',
];

// V3 fee tiers (standard Uniswap V3)
const V3_FEE_TIERS = [
  { fee: 100,   tickSpacing: 1  },  // 0.01%
  { fee: 500,   tickSpacing: 10 },  // 0.05%
  { fee: 3000,  tickSpacing: 60 },  // 0.30%
  { fee: 10000, tickSpacing: 200 }, // 1.00%
];

// Gas reserve to keep for ETH-native positions
const ETH_GAS_RESERVE = ethers.parseEther('0.005');

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
    { symbol: 'WETH', address: WETH_ADDRESS, decimals: 18 }
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
  const positions = [];

  // Load persistent static disk cache
  const posCache = config.loadPositionsCache();
  let cacheUpdated = false;

  // 1. Fetch Blockscout API data in parallel
  const [dataTs, dataV4, dataV3] = await Promise.all([
    fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/token-transfers?type=ERC-721`).then(r => r.json()).catch(() => ({})),
    fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/nft`).then(r => r.json()).catch(() => ({})),
    fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/nft?contract_address_hash=${UNISWAP_V3_POSM_ADDRESS}`).then(r => r.json()).catch(() => ({}))
  ]);

  const nftMintTsMap = {};
  const nftMintTxMap = {};
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

  // 2. Process Uniswap V4 Positions in parallel with disk caching for static deposit data
  if (dataV4.items) {
    const v4Promises = dataV4.items.map(async (item) => {
      const tid = (item.id || item.token_id).toString();
      const cacheKey = `v4_${tid}`;

      try {
        const v4Detail = await getV4PositionDetails(tid, wallet.address);
        if (!v4Detail) return null;

        // Check if static initial deposit is already cached on disk (retry/fallback if depTotalUsd is 0/missing)
        let depData = posCache[cacheKey];
        if (!depData || !depData.depTotalUsd) {
          const mintTxHash = nftMintTxMap[tid];
          const fetchedDep = await fetchMintDeposit(mintTxHash, wallet.address, null, null, v4Detail.dec0, v4Detail.dec1, 0n, v4Detail.sym0, v4Detail.sym1);
          const mintTsStr = nftMintTsMap[tid] || depData?.mintTsStr;
          if (fetchedDep && (fetchedDep.depTotalUsd > 0 || fetchedDep.depAmount0 > 0 || fetchedDep.depAmount1 > 0)) {
            depData = {
              depAmount0: fetchedDep.depAmount0,
              depAmount1: fetchedDep.depAmount1,
              depTotalUsd: fetchedDep.depTotalUsd,
              mintTsStr: mintTsStr || null,
              entryPriceUsd: depData?.entryPriceUsd || 0,
            };
          } else {
            // Fallback estimation from position value if Blockscout indexing missed the mint transfer
            const fallbackUsd = v4Detail.valueUsd > 0 ? Math.max(0, v4Detail.valueUsd - v4Detail.feeUsd) : 0;
            depData = {
              depAmount0: v4Detail.amount0 || 0,
              depAmount1: v4Detail.amount1 || 0,
              depTotalUsd: fallbackUsd,
              mintTsStr: mintTsStr || null,
              entryPriceUsd: depData?.entryPriceUsd || 0,
            };
          }
          posCache[cacheKey] = depData;
          cacheUpdated = true;
        }

        const mintTsStr = depData.mintTsStr || nftMintTsMap[tid];
        let ageHours = 24;
        if (mintTsStr) {
          const ageMs = Date.now() - new Date(mintTsStr).getTime();
          ageHours = Math.max(0.5, ageMs / (1000 * 3600));
        }

        const depTotalUsd = depData.depTotalUsd || 0;
        const depAmount0 = depData.depAmount0 || 0;
        const depAmount1 = depData.depAmount1 || 0;

        const totalPosUsd = v4Detail.valueUsd;
        const pnlUsd = depTotalUsd > 0 ? totalPosUsd - depTotalUsd : 0;
        const pnlPercent = depTotalUsd > 0 ? (pnlUsd / depTotalUsd) * 100 : 0;

        const estHourlyUsd = v4Detail.feeUsd > 0 ? v4Detail.feeUsd / ageHours : 0;
        const baseForYield = depTotalUsd > 0 ? depTotalUsd : (v4Detail.valueUsd > 0 ? v4Detail.valueUsd : 0);
        const estHourlyPercent = baseForYield > 0 ? (estHourlyUsd / baseForYield) * 100 : 0;

        const ageStr = formatAgeFromTimestamp(mintTsStr);

        const tickCurrent = Number(v4Detail.tickCurrent);
        const tickLower = Number(v4Detail.tickLower);
        const tickUpper = Number(v4Detail.tickUpper);
        const inRange = tickCurrent >= tickLower && tickCurrent <= tickUpper;

        let priceA = 0, priceB = 0, priceNow = 0;
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

        if (!depData.entryPriceUsd && priceNow > 0) {
          depData.entryPriceUsd = priceNow;
          posCache[cacheKey] = depData;
          cacheUpdated = true;
        }

        const priceMin = Math.min(priceA, priceB);
        const priceMax = Math.max(priceA, priceB);
        const tokenAddress = v4Detail.isC0Usdg ? v4Detail.currency1 : (v4Detail.isC1Usdg ? v4Detail.currency0 : v4Detail.currency1);
        const tokenSymbol = v4Detail.isC0Usdg ? v4Detail.sym1 : (v4Detail.isC1Usdg ? v4Detail.sym0 : v4Detail.sym1);

        return {
          tokenId: tid,
          tokenAddress,
          tokenSymbol,
          symbol0: v4Detail.sym0,
          symbol1: v4Detail.sym1,
          amount0: v4Detail.amount0,
          amount1: v4Detail.amount1,
          totalUsd: v4Detail.valueUsd - v4Detail.feeUsd,
          depAmount0,
          depAmount1,
          depTotalUsd,
          entryPriceUsd: depData.entryPriceUsd || priceNow,
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
          isV4: true,
          protocol: 'v4',
        };
      } catch {
        return null;
      }
    });

    const v4Results = await Promise.all(v4Promises);
    v4Results.forEach(p => { if (p) positions.push(p); });
  }

  // 3. Process Uniswap V3 Positions in parallel
  if (dataV3.items) {
    const v3Promises = dataV3.items.map(async (item) => {
      const tid = (item.id || item.token_id).toString();
      try {
        const v3Detail = await getV3PositionDetails(tid, wallet.address);
        if (!v3Detail) return null;

        const mintTsStr = nftMintTsMap[tid];
        let ageHours = 24;
        if (mintTsStr) {
          const ageMs = Date.now() - new Date(mintTsStr).getTime();
          ageHours = Math.max(0.5, ageMs / (1000 * 3600));
        }

        const totalPosUsd = v3Detail.valueUsd;
        const estHourlyUsd = v3Detail.feeUsd > 0 ? v3Detail.feeUsd / ageHours : 0;
        const estHourlyPercent = totalPosUsd > 0 ? (estHourlyUsd / totalPosUsd) * 100 : 0;
        const ageStr = formatAgeFromTimestamp(mintTsStr);

        const tokenAddress = v3Detail.isC0Usdg ? v3Detail.token1 : (v3Detail.isC1Usdg ? v3Detail.token0 : v3Detail.token1);
        const tokenSymbol = v3Detail.isC0Usdg ? v3Detail.sym1 : (v3Detail.isC1Usdg ? v3Detail.sym0 : v3Detail.sym1);

        return {
          tokenId: tid,
          tokenAddress,
          tokenSymbol,
          symbol0: v3Detail.sym0,
          symbol1: v3Detail.sym1,
          amount0: v3Detail.amount0,
          amount1: v3Detail.amount1,
          totalUsd: v3Detail.valueUsd,
          depAmount0: 0, depAmount1: 0, depTotalUsd: 0,
          entryPriceUsd: v3Detail.priceNow || 0,
          unclaimed0: v3Detail.unclaimed0,
          unclaimed1: v3Detail.unclaimed1,
          unclaimedUsd: v3Detail.feeUsd,
          estHourlyUsd,
          estHourlyPercent,
          pnlUsd: 0, pnlPercent: 0,
          fee: v3Detail.feePct,
          liquidity: 'Active',
          ageStr,
          tickLower: v3Detail.tickLower,
          tickUpper: v3Detail.tickUpper,
          priceMin: v3Detail.priceMin,
          priceMax: v3Detail.priceMax,
          priceNow: v3Detail.priceNow,
          inRange: v3Detail.inRange,
          isV3: true,
          protocol: 'v3',
        };
      } catch {
        return null;
      }
    });

    const v3Results = await Promise.all(v3Promises);
    v3Results.forEach(p => { if (p) positions.push(p); });
  }

  // Save updated disk cache if new static data was fetched
  if (cacheUpdated) {
    config.savePositionsCache(posCache);
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
  await ensurePermit2Allowance(wallet, pk.currency0, amount0Max, UNISWAP_V4_POSM_ADDRESS);
  await ensurePermit2Allowance(wallet, pk.currency1, amount1Max, UNISWAP_V4_POSM_ADDRESS);

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
  if (isC0Usdg && isC1Usdg) {
    return { closeTxHash: burnTx.hash, swapTxHash: null };
  }

  const nonUsdgAddr = isC1Usdg ? pk.currency0 : pk.currency1;
  const zeroForOne = isC1Usdg; // swap currency0→currency1 if c1 is USDG

  const tokenContract = new ethers.Contract(nonUsdgAddr, ERC20_ABI, wallet);
  const balance = await tokenContract.balanceOf(wallet.address);
  if (balance === 0n) {
    return { closeTxHash: burnTx.hash, swapTxHash: null };
  }

  // Approve Universal Router to spend non-USDG token via Permit2
  await ensurePermit2Allowance(wallet, nonUsdgAddr, balance, UNIVERSAL_ROUTER_ADDRESS);

  // Build V4 swap: token → USDG
  // Menggunakan SWAP_EXACT_IN (0x07, path-based) + SETTLE (0x0b) + TAKE (0x0e)
  // sesuai pattern Universal Router di Robinhood Chain (dikonfirmasi dari on-chain tx)
  const v4SwapInput = buildV4SwapCalldata(
    nonUsdgAddr,     // tokenIn  = non-USDG token
    USDG_ADDRESS,    // tokenOut = USDG
    Number(pk.fee),
    Number(pk.tickSpacing),
    pk.hooks,
    balance,         // amountIn = full balance token
    wallet.address   // recipient
  );

  const router = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, UNIVERSAL_ROUTER_ABI, wallet);
  const swapTx = await router.execute(V4_SWAP_COMMAND, [v4SwapInput], deadline);
  const swapReceipt = await swapTx.wait();
  return {
    closeTxHash: burnTx.hash,
    swapTxHash: swapReceipt.hash,
  };
}

async function ensurePermit2Allowance(wallet, tokenAddr, amountMax, spender = UNISWAP_V4_POSM_ADDRESS) {
  if (tokenAddr.toLowerCase() === ethers.ZeroAddress.toLowerCase()) return;
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
  const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const erc20Allow = await erc20.allowance(wallet.address, PERMIT2_ADDRESS).catch(() => 0n);
  if (erc20Allow < BigInt(amountMax)) {
    await (await erc20.approve(PERMIT2_ADDRESS, ethers.MaxUint256)).wait();
  }
  const [p2Amount] = await permit2.allowance(wallet.address, tokenAddr, spender).catch(() => [0n]);
  if (p2Amount < BigInt(amountMax)) {
    // Gunakan MAX_UINT160 agar tidak overflow saat approve Permit2 (uint160 max = 2^160-1)
    const MAX_UINT160 = (2n ** 160n) - 1n;
    const tx = await permit2.approve(tokenAddr, spender, MAX_UINT160, 2n ** 48n - 1n);
    await tx.wait();
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

  // Iterate fee tiers (0.01% up to 10.00%) with hooks=0x0
  for (const { fee, tickSpacing } of ALL_FEE_TIERS) {
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

// Returns ALL active USDG pools for a token across all fee tiers (0.01% - 10.00%), sorted by TVL descending.
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

  for (const { fee, tickSpacing } of ALL_FEE_TIERS) {
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

  // Sort pools by TVL in descending order (highest TVL pool first)
  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);

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
  const priceAtLower = tickToTokenPrice(tickLower, dec0, dec1, isC0Usdg);
  const priceAtUpper = tickToTokenPrice(tickUpper, dec0, dec1, isC0Usdg);
  const priceMin = Math.min(priceAtLower, priceAtUpper);
  const priceMax = Math.max(priceAtLower, priceAtUpper);

  const sqrtP = Number(sqrtPriceX96) / Math.pow(2, 96);
  const rawNow = sqrtP * sqrtP;
  const priceNow = isC0Usdg
    ? Math.pow(10, dec1 - 6) / rawNow
    : rawNow * Math.pow(10, dec0 - 6);

  return {
    hash: receipt.hash,
    fee: Number(pk.fee),
    tickSpacing,
    tickLower,
    tickUpper,
    tokenSymbol: isC0Usdg ? sym1 : sym0,
    priceMin,
    priceMax,
    priceNow,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Uniswap V3 Support
// ──────────────────────────────────────────────────────────────────────────────

// Returns all active V3 pools for a token where quote token is USDG or WETH.
async function findAllUsdgPoolsV3(tokenAddress) {
  if (!tokenAddress) throw new Error('tokenAddress required');
  const tokenAddr = ethers.getAddress(tokenAddress);
  const usdgAddr  = ethers.getAddress(USDG_ADDRESS);
  const wethAddr  = ethers.getAddress(WETH_ADDRESS);

  if (tokenAddr.toLowerCase() === usdgAddr.toLowerCase()) {
    throw new Error('Cannot deploy USDG/USDG pool');
  }
  if (tokenAddr.toLowerCase() === wethAddr.toLowerCase()) {
    throw new Error('Cannot deploy WETH/WETH pool');
  }

  const provider = getProvider();
  const factory  = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);

  const pools = [];

  // Check both USDG and WETH quote tokens per fee tier
  const quotePairs = [
    { qAddr: usdgAddr, qSym: 'USDG', qDec: 6,  label: 'USDG' },
    { qAddr: wethAddr, qSym: 'WETH', qDec: 18, label: 'WETH' },
  ];

  for (const { qAddr, qSym, qDec, label } of quotePairs) {
    if (tokenAddr.toLowerCase() === qAddr.toLowerCase()) continue;

    for (const { fee, tickSpacing } of V3_FEE_TIERS) {
      try {
        const poolAddr = await factory.getPool(tokenAddr, qAddr, fee);
        if (!poolAddr || poolAddr === ethers.ZeroAddress) continue;

        const poolContract = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI, provider);
        const [slot0Data, totalLiq, t0, t1] = await Promise.all([
          poolContract.slot0(),
          poolContract.liquidity().catch(() => 0n),
          poolContract.token0(),
          poolContract.token1(),
        ]);

        if (!slot0Data || slot0Data.sqrtPriceX96 === 0n) continue;

        // Fetch exact symbols and decimals for token0 and token1 directly from contracts
        let sym0 = 'TOKEN0', sym1 = 'TOKEN1', dec0 = 18, dec1 = 18;

        if (t0.toLowerCase() === usdgAddr.toLowerCase()) { sym0 = 'USDG'; dec0 = 6; }
        else if (t0.toLowerCase() === wethAddr.toLowerCase()) { sym0 = 'WETH'; dec0 = 18; }
        else {
          try { const c0 = new ethers.Contract(t0, ERC20_ABI, provider); [dec0, sym0] = await Promise.all([c0.decimals().then(Number), c0.symbol()]); } catch {}
        }

        if (t1.toLowerCase() === usdgAddr.toLowerCase()) { sym1 = 'USDG'; dec1 = 6; }
        else if (t1.toLowerCase() === wethAddr.toLowerCase()) { sym1 = 'WETH'; dec1 = 18; }
        else {
          try { const c1 = new ethers.Contract(t1, ERC20_ABI, provider); [dec1, sym1] = await Promise.all([c1.decimals().then(Number), c1.symbol()]); } catch {}
        }

        const isC0Usdg = t0.toLowerCase() === usdgAddr.toLowerCase();
        const isC1Usdg = t1.toLowerCase() === usdgAddr.toLowerCase();

        // Estimate TVL
        let tvlUsd = 0;
        try {
          if (totalLiq > 0n) {
            const liqNum = Number(totalLiq);
            const sqrtP  = Number(slot0Data.sqrtPriceX96) / Math.pow(2, 96);
            if (label === 'USDG') {
              tvlUsd = isC1Usdg
                ? 2 * liqNum * sqrtP / 1e6
                : 2 * liqNum / sqrtP / 1e6;
            } else {
              // WETH: rough ETH price ~$2000
              const isQ0 = t0.toLowerCase() === qAddr.toLowerCase();
              tvlUsd = isQ0
                ? 2 * liqNum / sqrtP / 1e18 * 2000
                : 2 * liqNum * sqrtP / 1e18 * 2000;
            }
          }
        } catch {}

        pools.push({
          pk: { currency0: t0, currency1: t1, fee, tickSpacing },
          poolId: poolAddr,
          sqrtPriceX96: slot0Data.sqrtPriceX96.toString(),
          tick: Number(slot0Data.tick),
          dec0, dec1, sym0, sym1, isC0Usdg, isC1Usdg,
          tvlUsd,
          isV3: true,
          protocol: 'v3',
          quoteToken: label,
          quoteTokenAddress: qAddr,
        });
      } catch {}
    }
  }

  pools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return pools;
}

// Combined: V4 USDG pools + V3 USDG/WETH pools, sorted by TVL
// Dynamically fetch all active Uniswap V3 & V4 pools for tokenAddress via DexScreener Indexer + RPC
async function fetchDynamicDexScreenerPools(tokenAddress) {
  if (!tokenAddress) return [];
  const tokenAddr = tokenAddress.toLowerCase();
  const provider  = getProvider();

  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`);
    const data = await res.json();
    if (!data.pairs) return [];

    const pools = [];
    const sv    = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);

    for (const p of data.pairs) {
      if (p.dexId !== 'uniswap') continue;
      const isV3 = p.labels?.includes('v3');
      const isV4 = p.labels?.includes('v4');
      if (!isV3 && !isV4) continue;

      const tvlUsd = Number(p.liquidity?.usd || 0);

      if (isV3 && p.pairAddress) {
        try {
          const poolContract = new ethers.Contract(p.pairAddress, UNISWAP_V3_POOL_ABI, provider);
          const [slot0, fee, tickSpacing, t0, t1] = await Promise.all([
            poolContract.slot0(),
            poolContract.fee().then(Number),
            poolContract.tickSpacing().then(Number),
            poolContract.token0(),
            poolContract.token1(),
          ]);
          if (!slot0 || slot0.sqrtPriceX96 === 0n) continue;

          let sym0 = 'TOKEN0', sym1 = 'TOKEN1', dec0 = 18, dec1 = 18;
          if (t0.toLowerCase() === USDG_ADDRESS.toLowerCase()) { sym0 = 'USDG'; dec0 = 6; }
          else if (t0.toLowerCase() === WETH_ADDRESS.toLowerCase()) { sym0 = 'WETH'; dec0 = 18; }
          else { try { const c0 = new ethers.Contract(t0, ERC20_ABI, provider); [dec0, sym0] = await Promise.all([c0.decimals().then(Number), c0.symbol()]); } catch {} }

          if (t1.toLowerCase() === USDG_ADDRESS.toLowerCase()) { sym1 = 'USDG'; dec1 = 6; }
          else if (t1.toLowerCase() === WETH_ADDRESS.toLowerCase()) { sym1 = 'WETH'; dec1 = 18; }
          else { try { const c1 = new ethers.Contract(t1, ERC20_ABI, provider); [dec1, sym1] = await Promise.all([c1.decimals().then(Number), c1.symbol()]); } catch {} }

          const isC0Usdg = t0.toLowerCase() === USDG_ADDRESS.toLowerCase();
          const isC1Usdg = t1.toLowerCase() === USDG_ADDRESS.toLowerCase();
          const qSym     = p.quoteToken?.symbol?.toUpperCase() || (isC0Usdg || isC1Usdg ? 'USDG' : 'WETH');

          pools.push({
            pk: { currency0: t0, currency1: t1, fee, tickSpacing },
            poolId: p.pairAddress,
            sqrtPriceX96: slot0.sqrtPriceX96.toString(),
            tick: Number(slot0.tick),
            dec0, dec1, sym0, sym1, isC0Usdg, isC1Usdg,
            tvlUsd,
            isV3: true,
            protocol: 'v3',
            quoteToken: qSym,
            quoteTokenAddress: isC0Usdg || isC1Usdg ? USDG_ADDRESS : (t0.toLowerCase() === WETH_ADDRESS.toLowerCase() ? t0 : t1),
          });
        } catch {}
      } else if (isV4 && p.pairAddress) {
        try {
          const poolId = p.pairAddress;
          const slot0  = await sv.getSlot0(poolId);
          if (!slot0 || slot0.sqrtPriceX96 === 0n) continue;

          const lpFee = slot0.lpFee ? Number(slot0.lpFee) : 3000;
          let tickSpacing = 60;
          if (lpFee <= 100) tickSpacing = 1;
          else if (lpFee <= 1000) tickSpacing = 10;
          else if (lpFee <= 2000) tickSpacing = 20;
          else if (lpFee >= 10000) tickSpacing = 200;

          const qSym = p.quoteToken?.symbol?.toUpperCase() || 'USDG';
          const isETH  = qSym === 'ETH';
          const isWETH = qSym === 'WETH';

          let qAddr = USDG_ADDRESS;
          if (isETH) qAddr = ethers.ZeroAddress;
          else if (isWETH) qAddr = WETH_ADDRESS;

          const [c0, c1] = tokenAddress.toLowerCase() < qAddr.toLowerCase()
            ? [tokenAddress, qAddr]
            : [qAddr, tokenAddress];

          let sym0 = 'TOKEN', sym1 = 'TOKEN', dec0 = 18, dec1 = 18;
          if (c0.toLowerCase() === USDG_ADDRESS.toLowerCase()) { sym0 = 'USDG'; dec0 = 6; }
          else if (c0.toLowerCase() === ethers.ZeroAddress.toLowerCase()) { sym0 = 'ETH'; dec0 = 18; }
          else if (c0.toLowerCase() === WETH_ADDRESS.toLowerCase()) { sym0 = 'WETH'; dec0 = 18; }
          else { try { const c0Contract = new ethers.Contract(c0, ERC20_ABI, provider); [dec0, sym0] = await Promise.all([c0Contract.decimals().then(Number), c0Contract.symbol()]); } catch {} }

          if (c1.toLowerCase() === USDG_ADDRESS.toLowerCase()) { sym1 = 'USDG'; dec1 = 6; }
          else if (c1.toLowerCase() === ethers.ZeroAddress.toLowerCase()) { sym1 = 'ETH'; dec1 = 18; }
          else if (c1.toLowerCase() === WETH_ADDRESS.toLowerCase()) { sym1 = 'WETH'; dec1 = 18; }
          else { try { const c1Contract = new ethers.Contract(c1, ERC20_ABI, provider); [dec1, sym1] = await Promise.all([c1Contract.decimals().then(Number), c1Contract.symbol()]); } catch {} }

          pools.push({
            pk: { currency0: c0, currency1: c1, fee: lpFee, tickSpacing, hooks: HOOKS_ZERO },
            poolId,
            sqrtPriceX96: slot0.sqrtPriceX96.toString(),
            tick: Number(slot0.tick),
            dec0, dec1, sym0, sym1,
            isC0Usdg: c0.toLowerCase() === USDG_ADDRESS.toLowerCase(),
            isC1Usdg: c1.toLowerCase() === USDG_ADDRESS.toLowerCase(),
            tvlUsd,
            isV4: true,
            protocol: 'v4',
            quoteToken: qSym,
            quoteTokenAddress: qAddr,
          });
        } catch {}
      }
    }
    return pools;
  } catch {
    return [];
  }
}

// Combined: Static search + Dynamic DexScreener search (all custom fee tiers V3 & V4)
async function findAllUsdgPoolsCombined(tokenAddress) {
  const [v4Pools, v3Pools, dynPools] = await Promise.all([
    findAllUsdgPools(tokenAddress).catch(() => []),
    findAllUsdgPoolsV3(tokenAddress).catch(() => []),
    fetchDynamicDexScreenerPools(tokenAddress).catch(() => []),
  ]);

  // Tag V4 pools with protocol info
  const taggedV4 = v4Pools.map(p => ({
    ...p,
    protocol: 'v4',
    quoteToken: p.isC0Usdg || p.isC1Usdg ? 'USDG' : 'OTHER',
    quoteTokenAddress: USDG_ADDRESS,
  }));

  const poolMap = new Map();
  [...dynPools, ...v3Pools, ...taggedV4].forEach(p => {
    const key = (p.poolId || '').toLowerCase();
    if (key && !poolMap.has(key)) {
      poolMap.set(key, p);
    }
  });

  let all = Array.from(poolMap.values());
  // Filter out pools with TVL < $1,000
  all = all.filter(p => (p.tvlUsd || 0) >= 1000);
  all.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return all;
}

// Pre-flight: ensure wallet has enough quote token. Swaps USDG→WETH if needed.
// Returns { swapTxHash: string|null }
async function ensureQuoteTokenBalance(wallet, quoteToken, amountNeededRaw) {
  const provider = wallet.provider;
  const amountNeeded = BigInt(amountNeededRaw.toString());

  if (quoteToken === 'USDG') {
    return { swapTxHash: null }; // wallet always has USDG
  }

  if (quoteToken === 'WETH') {
    const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, provider);
    const wethBalance  = await wethContract.balanceOf(wallet.address).catch(() => 0n);

    // Case 1: already have enough
    if (wethBalance >= amountNeeded) return { swapTxHash: null };

    // Case 2: swap only the deficit
    const deficit = amountNeeded - wethBalance;
    const swapTxHash = await swapUsdgToWeth(wallet, deficit);
    return { swapTxHash };
  }

  if (quoteToken === 'ETH') {
    const ethBalance = await provider.getBalance(wallet.address);
    const ethUsable  = ethBalance > ETH_GAS_RESERVE ? ethBalance - ETH_GAS_RESERVE : 0n;

    // Case 1: already have enough usable ETH
    if (ethUsable >= amountNeeded) return { swapTxHash: null };

    // Case 2: swap deficit USDG→WETH then unwrap to ETH
    const deficit = amountNeeded - ethUsable;
    const swapTxHash = await swapUsdgToEth(wallet, deficit);
    return { swapTxHash };
  }

  return { swapTxHash: null };
}

// Swap USDG → WETH via V4 Universal Router
async function swapUsdgToWeth(wallet, wethAmountRaw) {
  const provider   = wallet.provider;
  const CHAIN_ID   = 4663;
  const deadline   = Math.floor(Date.now() / 1000) + 600;

  // Approve USDG to Universal Router via Permit2
  const usdgContract = new ethers.Contract(USDG_ADDRESS, ERC20_ABI, wallet);
  const usdgBalance  = await usdgContract.balanceOf(wallet.address);
  if (usdgBalance > 0n) {
    await ensurePermit2Allowance(wallet, USDG_ADDRESS, usdgBalance, UNIVERSAL_ROUTER_ADDRESS);
  }

  // Determine pool ordering for USDG/WETH V4 pool (need to find it first)
  const usdgAddr = ethers.getAddress(USDG_ADDRESS);
  const wethAddr = ethers.getAddress(WETH_ADDRESS);
  const [c0, c1] = usdgAddr.toLowerCase() < wethAddr.toLowerCase()
    ? [usdgAddr, wethAddr]
    : [wethAddr, usdgAddr];
  const zeroForOne = c0.toLowerCase() === usdgAddr.toLowerCase();

  // Find the best USDG/WETH V4 pool
  const sv    = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let bestPoolKey = null;
  for (const { fee, tickSpacing } of ALL_FEE_TIERS) {
    const poolId = ethers.keccak256(coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [c0, c1, fee, tickSpacing, HOOKS_ZERO]
    ));
    try {
      const s0 = await sv.getSlot0(poolId);
      if (s0.sqrtPriceX96 > 0n) { bestPoolKey = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: HOOKS_ZERO }; break; }
    } catch {}
  }
  if (!bestPoolKey) throw new Error('No USDG/WETH V4 pool found for swap');

  // Swap exact-out WETH (receive wethAmountRaw WETH, pay up to all USDG balance)
  // USDG → WETH menggunakan SWAP_EXACT_IN path-based (pattern yg benar di chain ini)
  const v4SwapInput = buildV4SwapCalldata(
    USDG_ADDRESS,   // tokenIn  = USDG
    WETH_ADDRESS,   // tokenOut = WETH
    bestPoolKey.fee,
    bestPoolKey.tickSpacing,
    bestPoolKey.hooks,
    usdgBalance,    // amountIn
    wallet.address  // recipient
  );

  const router = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, UNIVERSAL_ROUTER_ABI, wallet);
  const tx     = await router.execute(V4_SWAP_COMMAND, [v4SwapInput], deadline);
  const receipt = await tx.wait();
  return receipt.hash;
}

// Swap USDG → WETH → unwrap to ETH
async function swapUsdgToEth(wallet, ethAmountRaw) {
  const wethTxHash = await swapUsdgToWeth(wallet, ethAmountRaw);

  // Unwrap WETH → ETH
  const weth9   = new ethers.Contract(WETH_ADDRESS, WETH9_ABI, wallet);
  const unwrapTx = await weth9.withdraw(ethAmountRaw);
  await unwrapTx.wait();

  return wethTxHash; // return the swap hash (unwrap is secondary)
}

// Get details of a V3 position
async function getV3PositionDetails(tokenId, walletAddress) {
  const provider = getProvider();
  const posm     = new ethers.Contract(UNISWAP_V3_POSM_ADDRESS, UNISWAP_V3_POSM_ABI, provider);

  const owner = await posm.ownerOf(tokenId).catch(() => ethers.ZeroAddress);
  if (owner.toLowerCase() !== walletAddress.toLowerCase()) return null;

  const pos = await posm.positions(tokenId).catch(() => null);
  if (!pos || pos.liquidity === 0n) return null;

  const { token0, token1, fee, tickLower, tickUpper, liquidity,
          tokensOwed0, tokensOwed1 } = pos;

  let dec0 = 18, sym0 = 'TOKEN0';
  let dec1 = 18, sym1 = 'TOKEN1';

  const isC0Usdg = token0.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const isC1Usdg = token1.toLowerCase() === USDG_ADDRESS.toLowerCase();
  const isC0Weth = token0.toLowerCase() === WETH_ADDRESS.toLowerCase();
  const isC1Weth = token1.toLowerCase() === WETH_ADDRESS.toLowerCase();

  if (isC0Usdg) { dec0 = 6; sym0 = 'USDG'; }
  else if (isC0Weth) { dec0 = 18; sym0 = 'WETH'; }
  else {
    try { const c = new ethers.Contract(token0, ERC20_ABI, provider); [dec0, sym0] = await Promise.all([c.decimals().then(Number), c.symbol()]); } catch {}
  }

  if (isC1Usdg) { dec1 = 6; sym1 = 'USDG'; }
  else if (isC1Weth) { dec1 = 18; sym1 = 'WETH'; }
  else {
    try { const c = new ethers.Contract(token1, ERC20_ABI, provider); [dec1, sym1] = await Promise.all([c.decimals().then(Number), c.symbol()]); } catch {}
  }

  // Get current tick from pool
  const factory    = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
  const poolAddr   = await factory.getPool(token0, token1, fee).catch(() => ethers.ZeroAddress);
  if (poolAddr === ethers.ZeroAddress) return null;

  const poolContract = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI, provider);
  const slot0Data    = await poolContract.slot0().catch(() => null);
  if (!slot0Data) return null;

  const CHAIN_ID  = 4663;
  const feeNumber = Number(fee);

  // Find tickSpacing from V3_FEE_TIERS
  const tierInfo  = V3_FEE_TIERS.find(t => t.fee === feeNumber) || { tickSpacing: 60 };
  const tickSpacing = tierInfo.tickSpacing;

  const tick = Number(slot0Data.tick);
  const sqrtPriceX96 = slot0Data.sqrtPriceX96.toString();

  const cur0 = new v3sdk.Token(CHAIN_ID, ethers.getAddress(token0), dec0, sym0);
  const cur1 = new v3sdk.Token(CHAIN_ID, ethers.getAddress(token1), dec1, sym1);

  const pool = new v3sdk.Pool(cur0, cur1, feeNumber, tickSpacing, sqrtPriceX96, liquidity.toString(), tick);
  const position = new v3sdk.Position({ pool, liquidity: liquidity.toString(), tickLower: Number(tickLower), tickUpper: Number(tickUpper) });

  const amt0 = Number(position.amount0.toExact());
  const amt1 = Number(position.amount1.toExact());

  // Unclaimed fees
  const unc0 = Number(ethers.formatUnits(tokensOwed0, dec0));
  const unc1 = Number(ethers.formatUnits(tokensOwed1, dec1));

  // Value in USD
  let valueUsd = 0, feeUsd = 0;
  const sqrtP  = Number(sqrtPriceX96) / Math.pow(2, 96);
  const rawNow = sqrtP * sqrtP;

  if (isC0Usdg) {
    const priceToken = Math.pow(10, dec1 - 6) / rawNow;
    valueUsd = (amt0 + unc0) + (amt1 + unc1) * priceToken;
    feeUsd   = unc0 + unc1 * priceToken;
  } else if (isC1Usdg) {
    const priceToken = rawNow * Math.pow(10, dec0 - 6);
    valueUsd = (amt1 + unc1) + (amt0 + unc0) * priceToken;
    feeUsd   = unc1 + unc0 * priceToken;
  } else if (isC0Weth || isC1Weth) {
    // Rough estimate using ETH~$2000
    const ETH_PRICE = 2000;
    if (isC1Weth) {
      valueUsd = (amt1 + unc1) * ETH_PRICE + (amt0 + unc0) * rawNow * ETH_PRICE * Math.pow(10, dec0 - 18);
      feeUsd   = unc1 * ETH_PRICE;
    } else {
      valueUsd = (amt0 + unc0) * ETH_PRICE + (amt1 + unc1) / rawNow * ETH_PRICE * Math.pow(10, dec1 - 18);
      feeUsd   = unc0 * ETH_PRICE;
    }
  }

  const inRange = tick >= Number(tickLower) && tick <= Number(tickUpper);

  // Price range
  let priceA = 0, priceB = 0, priceNow = 0;
  if (isC0Usdg) {
    priceA   = Math.pow(10, dec1 - 6) / Math.pow(1.0001, Number(tickLower));
    priceB   = Math.pow(10, dec1 - 6) / Math.pow(1.0001, Number(tickUpper));
    priceNow = Math.pow(10, dec1 - 6) / rawNow;
  } else if (isC1Usdg) {
    priceA   = Math.pow(1.0001, Number(tickLower)) * Math.pow(10, dec0 - 6);
    priceB   = Math.pow(1.0001, Number(tickUpper)) * Math.pow(10, dec0 - 6);
    priceNow = rawNow * Math.pow(10, dec0 - 6);
  } else {
    priceA   = Math.pow(1.0001, Number(tickLower)) * Math.pow(10, dec0 - dec1);
    priceB   = Math.pow(1.0001, Number(tickUpper)) * Math.pow(10, dec0 - dec1);
    priceNow = rawNow * Math.pow(10, dec0 - dec1);
  }

  return {
    tokenId,
    sym0, sym1, dec0, dec1,
    amount0: amt0, amount1: amt1,
    unclaimed0: unc0, unclaimed1: unc1,
    valueUsd, feeUsd,
    feePct: feeNumber / 10000,
    tickLower: Number(tickLower), tickUpper: Number(tickUpper), tickCurrent: tick,
    sqrtPriceX96,
    isC0Usdg, isC1Usdg,
    inRange,
    priceMin: Math.min(priceA, priceB),
    priceMax: Math.max(priceA, priceB),
    priceNow,
    protocol: 'v3',
    isV3: true,
  };
}

// Close a V3 position and swap non-USDG tokens back to USDG
async function closeV3PositionAndSwapToUsdg(tokenId) {
  const wallet   = getWallet();
  const provider = wallet.provider;
  const posm     = new ethers.Contract(UNISWAP_V3_POSM_ADDRESS, UNISWAP_V3_POSM_ABI, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 600;

  let closeTxHash = 'N/A';
  let token0, token1;

  try {
    const pos = await posm.positions(tokenId);
    token0 = pos.token0;
    token1 = pos.token1;
    const { liquidity } = pos;

    // 1. Decrease liquidity to 0
    if (liquidity > 0n) {
      await (await posm.decreaseLiquidity({
        tokenId, liquidity,
        amount0Min: 0n, amount1Min: 0n,
        deadline,
      })).wait();
    }

    // 2. Collect all tokens (including fees)
    const collectTx = await posm.collect({
      tokenId,
      recipient: wallet.address,
      amount0Max: BigInt('0xffffffffffffffffffffffffffffffff'),
      amount1Max: BigInt('0xffffffffffffffffffffffffffffffff'),
    });
    await collectTx.wait();
    closeTxHash = collectTx.hash;

    // 3. Burn the NFT
    try {
      await (await posm.burn(tokenId)).wait();
    } catch (burnErr) {
      console.warn(`[V3 CLOSE] Warning: posm.burn(#${tokenId}) failed or already burned:`, burnErr.message);
    }
  } catch (posErr) {
    console.warn(`[V3 CLOSE] Could not query/burn position #${tokenId} (may already be closed/burned):`, posErr.message);
  }

  let swapTxHash = null;

  // 4. Swap non-USDG token to USDG if needed
  if (token0 && token0.toLowerCase() !== USDG_ADDRESS.toLowerCase()) {
    const t0 = new ethers.Contract(token0, ERC20_ABI, wallet);
    const bal0 = await t0.balanceOf(wallet.address).catch(() => 0n);
    if (bal0 > 0n) swapTxHash = await swapTokenToUsdgV4(wallet, token0, bal0);
  }

  if (token1 && token1.toLowerCase() !== USDG_ADDRESS.toLowerCase()) {
    const t1 = new ethers.Contract(token1, ERC20_ABI, wallet);
    const bal1 = await t1.balanceOf(wallet.address).catch(() => 0n);
    if (bal1 > 0n) swapTxHash = await swapTokenToUsdgV4(wallet, token1, bal1);
  }

  return { closeTxHash, swapTxHash };
}

// Helper: swap any ERC-20 token → USDG via V4 Universal Router
async function swapTokenToUsdgV4(wallet, tokenAddr, balance) {
  const provider  = wallet.provider;
  const deadline  = Math.floor(Date.now() / 1000) + 600;

  const tAddrChk = safeAddr(tokenAddr);
  const usdgChk  = safeAddr(USDG_ADDRESS);
  const [c0, c1] = tAddrChk.toLowerCase() < usdgChk.toLowerCase()
    ? [tAddrChk, usdgChk]
    : [usdgChk, tAddrChk];
  const zeroForOne = c0.toLowerCase() === tAddrChk.toLowerCase();

  // Find pool
  const sv    = new ethers.Contract(UNISWAP_V4_STATEVIEW_ADDRESS, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  let bestPoolKey = null;
  for (const { fee, tickSpacing } of ALL_FEE_TIERS) {
    const poolId = ethers.keccak256(coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [c0, c1, fee, tickSpacing, HOOKS_ZERO]
    ));
    try {
      const s0 = await sv.getSlot0(poolId);
      if (s0.sqrtPriceX96 > 0n) { bestPoolKey = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: HOOKS_ZERO }; break; }
    } catch {}
  }
  if (!bestPoolKey) throw new Error(`No V4 pool found to swap ${tAddrChk} → USDG`);

  // Approve Universal Router to spend non-USDG token via Permit2
  await ensurePermit2Allowance(wallet, tAddrChk, balance, UNIVERSAL_ROUTER_ADDRESS);

  // token → USDG menggunakan SWAP_EXACT_IN path-based
  const v4SwapInput = buildV4SwapCalldata(
    tAddrChk,       // tokenIn  = non-USDG token
    safeAddr(USDG_ADDRESS), // tokenOut = USDG
    bestPoolKey.fee,
    bestPoolKey.tickSpacing,
    bestPoolKey.hooks,
    balance,        // amountIn = full balance
    wallet.address  // recipient
  );

  const router  = new ethers.Contract(UNIVERSAL_ROUTER_ADDRESS, UNIVERSAL_ROUTER_ABI, wallet);
  const tx      = await router.execute(V4_SWAP_COMMAND, [v4SwapInput], deadline);
  const receipt = await tx.wait();
  return receipt.hash;
}

// Deploy LP into a V3 pool (one-side lower, quote token only)
async function executeAutoDeployLpV3(tokenAddress, amountUsd, preFoundPool, rangePct = 20) {
  const wallet   = getWallet();
  const provider = wallet.provider;
  const CHAIN_ID = 4663;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const poolInfo   = preFoundPool;
  const { pk, sqrtPriceX96, tick, dec0, dec1, sym0, sym1, isC0Usdg, isC1Usdg, quoteToken } = poolInfo;
  const { fee, tickSpacing } = pk;

  // Build SDK objects
  const cur0 = new v3sdk.Token(CHAIN_ID, ethers.getAddress(pk.currency0), dec0, sym0);
  const cur1 = new v3sdk.Token(CHAIN_ID, ethers.getAddress(pk.currency1), dec1, sym1);

  // Get current pool state
  const poolContract  = new ethers.Contract(poolInfo.poolId, UNISWAP_V3_POOL_ABI, provider);
  const slot0Data     = await poolContract.slot0();
  const currentLiq    = await poolContract.liquidity().catch(() => 0n);

  const pool = new v3sdk.Pool(
    cur0, cur1,
    Number(fee), Number(tickSpacing),
    slot0Data.sqrtPriceX96.toString(),
    currentLiq.toString(),
    Number(slot0Data.tick)
  );

  // One-side lower tick range
  const alignDown   = (t, ts) => Math.floor(t / ts) * ts;
  const ratio       = 1 - rangePct / 100;
  const rawTickDiff = Math.log(ratio) / Math.log(1.0001);
  const tickDiffAbs = Math.floor(Math.abs(rawTickDiff) / Number(tickSpacing)) * Number(tickSpacing);
  const currentTick = Number(slot0Data.tick);

  let tickLower, tickUpper;
  if (isC0Usdg || quoteToken === 'WETH' && pk.currency0.toLowerCase() === ethers.getAddress(WETH_ADDRESS).toLowerCase()) {
    tickLower = alignDown(currentTick, Number(tickSpacing));
    tickUpper = tickLower + tickDiffAbs;
  } else {
    tickUpper = alignDown(currentTick, Number(tickSpacing));
    tickLower = tickUpper - tickDiffAbs;
  }

  const minTickAligned = Math.ceil(-887272 / Number(tickSpacing)) * Number(tickSpacing);
  const maxTickAligned = Math.floor(887272 / Number(tickSpacing)) * Number(tickSpacing);
  tickLower = Math.max(tickLower, minTickAligned);
  tickUpper = Math.min(tickUpper, maxTickAligned);
  if (tickLower >= tickUpper) throw new Error(`Invalid tick range: lower=${tickLower} upper=${tickUpper}`);

  // Determine amount needed in quote token
  const isC1Quote = !isC0Usdg && !(quoteToken === 'WETH' && pk.currency0.toLowerCase() === ethers.getAddress(WETH_ADDRESS).toLowerCase());

  // Amount in quote token raw
  let amountRaw;
  let position;

  if (quoteToken === 'USDG') {
    amountRaw = ethers.parseUnits(amountUsd.toString(), 6);
  } else {
    // WETH: convert amountUsd to WETH units using current price
    const sqrtP  = Number(slot0Data.sqrtPriceX96) / Math.pow(2, 96);
    const rawNow = sqrtP * sqrtP;
    const ethPrice = isC1Quote
      ? rawNow * Math.pow(10, dec0 - dec1)
      : Math.pow(10, dec1 - dec0) / rawNow;
    const wethAmount = amountUsd / (ethPrice * 2000 / 2000); // ~2000 USD/ETH approx
    amountRaw = ethers.parseUnits(wethAmount.toFixed(18), 18);
  }

  if (isC1Quote) {
    position = v3sdk.Position.fromAmount1({ pool, tickLower, tickUpper, amount1: amountRaw.toString() });
  } else {
    position = v3sdk.Position.fromAmount0({ pool, tickLower, tickUpper, amount0: amountRaw.toString(), useFullPrecision: false });
  }

  const { amount0: mint0, amount1: mint1 } = position.mintAmounts;
  const amount0Max = (BigInt(mint0.toString()) * 101n / 100n).toString();
  const amount1Max = (BigInt(mint1.toString()) * 101n / 100n).toString();

  // Pre-flight: ensure quote token balance
  const quoteAmountNeeded = isC1Quote ? BigInt(mint1.toString()) : BigInt(mint0.toString());
  const { swapTxHash } = await ensureQuoteTokenBalance(wallet, quoteToken, quoteAmountNeeded * 101n / 100n);

  // Approve tokens to V3 POSM (no Permit2)
  if (BigInt(amount0Max) > 0n && pk.currency0.toLowerCase() !== ethers.ZeroAddress.toLowerCase()) {
    const t0 = new ethers.Contract(pk.currency0, ERC20_ABI, wallet);
    const a0 = await t0.allowance(wallet.address, UNISWAP_V3_POSM_ADDRESS).catch(() => 0n);
    if (a0 < BigInt(amount0Max)) await (await t0.approve(UNISWAP_V3_POSM_ADDRESS, ethers.MaxUint256)).wait();
  }
  if (BigInt(amount1Max) > 0n && pk.currency1.toLowerCase() !== ethers.ZeroAddress.toLowerCase()) {
    const t1 = new ethers.Contract(pk.currency1, ERC20_ABI, wallet);
    const a1 = await t1.allowance(wallet.address, UNISWAP_V3_POSM_ADDRESS).catch(() => 0n);
    if (a1 < BigInt(amount1Max)) await (await t1.approve(UNISWAP_V3_POSM_ADDRESS, ethers.MaxUint256)).wait();
  }

  // Mint V3 position
  const posm = new ethers.Contract(UNISWAP_V3_POSM_ADDRESS, UNISWAP_V3_POSM_ABI, wallet);
  const txResponse = await posm.mint({
    token0: pk.currency0,
    token1: pk.currency1,
    fee: Number(fee),
    tickLower,
    tickUpper,
    amount0Desired: amount0Max,
    amount1Desired: amount1Max,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: wallet.address,
    deadline,
  });
  const receipt = await txResponse.wait();

  // Price info
  const sqrtPNow    = Number(slot0Data.sqrtPriceX96) / Math.pow(2, 96);
  const rawNowPrice = sqrtPNow * sqrtPNow;
  const priceAtLower = isC0Usdg
    ? Math.pow(10, dec1 - 6) / Math.pow(1.0001, tickLower)
    : Math.pow(1.0001, tickLower) * Math.pow(10, dec0 - 6);
  const priceAtUpper = isC0Usdg
    ? Math.pow(10, dec1 - 6) / Math.pow(1.0001, tickUpper)
    : Math.pow(1.0001, tickUpper) * Math.pow(10, dec0 - 6);
  const priceNow = isC0Usdg
    ? Math.pow(10, dec1 - 6) / rawNowPrice
    : rawNowPrice * Math.pow(10, dec0 - 6);

  const qAddr = poolInfo.quoteTokenAddress ? poolInfo.quoteTokenAddress.toLowerCase() : USDG_ADDRESS.toLowerCase();
  const isQ0  = isC0Usdg || (pk.currency0 && pk.currency0.toLowerCase() === qAddr) || sym0 === quoteToken;

  return {
    swapTxHash,
    hash: receipt.hash,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    tickLower,
    tickUpper,
    tokenSymbol: isQ0 ? sym1 : sym0,
    priceMin: Math.min(priceAtLower, priceAtUpper),
    priceMax: Math.max(priceAtLower, priceAtUpper),
    priceNow,
    quoteToken,
    protocol: 'v3',
  };
}

// Fetch liquidity transaction details (V3 or V4) for tracking activity alerts
async function getLiquidityTxDetails(txHash, walletAddress) {
  if (!txHash || !walletAddress) return null;

  try {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/transactions/${txHash}/token-transfers?type=ERC-721`);
    const data = await res.json();
    if (!data.items || data.items.length === 0) return null;

    const walletLower = walletAddress.toLowerCase();
    const nftItem = data.items.find(item =>
      (item.to?.hash?.toLowerCase() === walletLower || item.from?.hash === '0x0000000000000000000000000000000000000000') &&
      item.total?.token_id
    );

    if (!nftItem) return null;

    const contractAddr = (nftItem.token?.address_hash || '').toLowerCase();
    const tokenId = nftItem.total.token_id.toString();

    if (contractAddr === UNISWAP_V3_POSM_ADDRESS.toLowerCase()) {
      const v3Detail = await getV3PositionDetails(tokenId, walletAddress);
      if (!v3Detail) return null;

      const { depAmount0, depAmount1, depTotalUsd } = await fetchMintDeposit(
        txHash, walletAddress, null, null,
        v3Detail.dec0, v3Detail.dec1, 0n, v3Detail.sym0, v3Detail.sym1
      );

      const feePctStr = (v3Detail.feePct * 100).toFixed(2);
      const pair = `${v3Detail.sym0}/${v3Detail.sym1}`;
      const rangeStr = `${formatPriceCompact(v3Detail.priceMin)}–${formatPriceCompact(v3Detail.priceMax)}`;
      const priceNowStr = formatPriceCompact(v3Detail.priceNow);

      return {
        protocol: 'v3',
        protocolBadge: '🔷',
        protocolName: 'Uniswap V3',
        tokenId,
        feePct: feePctStr,
        pair,
        symbol0: v3Detail.sym0,
        symbol1: v3Detail.sym1,
        depAmount0: depAmount0 || v3Detail.amount0,
        depAmount1: depAmount1 || v3Detail.amount1,
        depTotalUsd: depTotalUsd || v3Detail.valueUsd,
        rangeStr,
        priceNow: priceNowStr,
        inRange: v3Detail.inRange,
      };
    } else if (contractAddr === UNISWAP_V4_POSM_ADDRESS.toLowerCase()) {
      const v4Detail = await getV4PositionDetails(tokenId, walletAddress);
      if (!v4Detail) return null;

      const { depAmount0, depAmount1, depTotalUsd } = await fetchMintDeposit(
        txHash, walletAddress, null, null,
        v4Detail.dec0, v4Detail.dec1, 0n, v4Detail.sym0, v4Detail.sym1
      );

      const feePctStr = (v4Detail.feePct * 100).toFixed(2);
      const pair = `${v4Detail.sym0}/${v4Detail.sym1}`;

      const tickLower   = Number(v4Detail.tickLower);
      const tickUpper   = Number(v4Detail.tickUpper);
      const tickCurrent = Number(v4Detail.tickCurrent);
      const inRange     = tickCurrent >= tickLower && tickCurrent <= tickUpper;

      let priceA = 0, priceB = 0, priceNow = 0;
      const sqrtP  = Number(v4Detail.sqrtPriceX96) / Math.pow(2, 96);
      const rawNow = sqrtP * sqrtP;

      if (v4Detail.isC0Usdg) {
        priceA   = Math.pow(10, v4Detail.dec1 - 6) / Math.pow(1.0001, tickLower);
        priceB   = Math.pow(10, v4Detail.dec1 - 6) / Math.pow(1.0001, tickUpper);
        priceNow = Math.pow(10, v4Detail.dec1 - 6) / rawNow;
      } else if (v4Detail.isC1Usdg) {
        priceA   = Math.pow(1.0001, tickLower) * Math.pow(10, v4Detail.dec0 - 6);
        priceB   = Math.pow(1.0001, tickUpper) * Math.pow(10, v4Detail.dec0 - 6);
        priceNow = rawNow * Math.pow(10, v4Detail.dec0 - 6);
      } else {
        priceA   = Math.pow(1.0001, tickLower) * Math.pow(10, v4Detail.dec0 - v4Detail.dec1);
        priceB   = Math.pow(1.0001, tickUpper) * Math.pow(10, v4Detail.dec0 - v4Detail.dec1);
        priceNow = rawNow * Math.pow(10, v4Detail.dec0 - v4Detail.dec1);
      }

      const priceMin = Math.min(priceA, priceB);
      const priceMax = Math.max(priceA, priceB);

      const rangeStr = `${formatPriceCompact(priceMin)}–${formatPriceCompact(priceMax)}`;
      const priceNowStr = formatPriceCompact(priceNow);

      return {
        protocol: 'v4',
        protocolBadge: '🔶',
        protocolName: 'Uniswap V4',
        tokenId,
        feePct: feePctStr,
        pair,
        symbol0: v4Detail.sym0,
        symbol1: v4Detail.sym1,
        depAmount0,
        depAmount1,
        depTotalUsd,
        rangeStr,
        priceNow: priceNowStr,
        inRange,
      };
    }
  } catch {
    return null;
  }
  return null;
}

module.exports = {
  getExecutorAddress,
  getExecutorBalance,
  getExecutorPositions,
  executeCopyAddLiquidity,
  closePositionAndSwapToUsdg,
  closeV3PositionAndSwapToUsdg,
  findUsdgPool,
  findAllUsdgPools,
  findAllUsdgPoolsV3,
  findAllUsdgPoolsCombined,
  getPoolSlot0,
  executeAutoDeployLp,
  executeAutoDeployLpV3,
  ensureQuoteTokenBalance,
  getV3PositionDetails,
  getLiquidityTxDetails,
};
