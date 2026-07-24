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

const UNISWAP_V3_NFPM_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)'
];

const UNISWAP_V4_POSM_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function modifyLiquidities(bytes commands, bytes[] inputs, uint256 deadline) payable'
];

const UNISWAP_V3_SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
];

const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address token0, address token1, uint24 fee) view returns (address)'
];

const UNISWAP_V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
];

// Addresses on Robinhood Chain
const UNISWAP_V3_NFPM_ADDRESS = process.env.UNISWAP_V3_NFPM_ADDRESS || '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
const UNISWAP_V4_POSM_ADDRESS = process.env.UNISWAP_V4_POSM_ADDRESS || '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const UNISWAP_V3_ROUTER_ADDRESS = process.env.UNISWAP_V3_ROUTER_ADDRESS || '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const USDG_ADDRESS = process.env.USDG_ADDRESS || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

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
  return 'https://robinhood-mainnet.g.alchemy.com/v2/demo';
}

function getProvider() {
  const rpcUrl = getRobinhoodRpcUrl();
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getWallet() {
  const pk = process.env.EXECUTIVE_PRIVATE_KEY;
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

  // 1. Check Uniswap V3 Positions (100% Pure Dynamic On-Chain Query)
  try {
    const v3Nfpm = new ethers.Contract(UNISWAP_V3_NFPM_ADDRESS, UNISWAP_V3_NFPM_ABI, provider);
    const v3Bal = await v3Nfpm.balanceOf(wallet.address).catch(() => 0n);

    for (let i = 0; i < Number(v3Bal); i++) {
      try {
        const tid = await v3Nfpm.tokenOfOwnerByIndex(wallet.address, i);
        const pos = await v3Nfpm.positions(tid);
        if (pos.liquidity === 0n) continue;

        const token0Contract = new ethers.Contract(pos.token0, ERC20_ABI, provider);
        const token1Contract = new ethers.Contract(pos.token1, ERC20_ABI, provider);

        const [sym0, sym1, dec0Raw, dec1Raw] = await Promise.all([
          token0Contract.symbol().catch(() => 'TOKEN0'),
          token1Contract.symbol().catch(() => 'TOKEN1'),
          token0Contract.decimals().catch(() => 18n),
          token1Contract.decimals().catch(() => 18n)
        ]);

        const dec0 = Number(dec0Raw);
        const dec1 = Number(dec1Raw);

        let currentTick = 0;
        let sqrtPriceX96 = 0n;
        try {
          const factoryAddr = await v3Nfpm.factory().catch(() => '0x33128a8fC17869897dcE68Ed026d694621f6FDfD');
          const factory = new ethers.Contract(factoryAddr, UNISWAP_V3_FACTORY_ABI, provider);
          const poolAddress = await factory.getPool(pos.token0, pos.token1, pos.fee);
          if (poolAddress && poolAddress !== ethers.ZeroAddress) {
            const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
            const slot0 = await poolContract.slot0();
            sqrtPriceX96 = slot0.sqrtPriceX96;
            currentTick = Number(slot0.tick);
          } else {
            currentTick = Math.floor((Number(pos.tickLower) + Number(pos.tickUpper)) / 2);
          }
        } catch {
          currentTick = Math.floor((Number(pos.tickLower) + Number(pos.tickUpper)) / 2);
        }

        const { amount0, amount1 } = getAmountsForLiquidity(pos.liquidity, currentTick, pos.tickLower, pos.tickUpper, dec0, dec1);
        const { totalUsd } = calculatePositionUsd(amount0, amount1, pos.token0, pos.token1, sqrtPriceX96, dec0, dec1);

        // Unclaimed fees (tokensOwed0 & tokensOwed1)
        let unclaimed0 = 0;
        let unclaimed1 = 0;
        let unclaimedUsd = 0;
        if (pos.tokensOwed0 !== undefined && pos.tokensOwed1 !== undefined) {
          unclaimed0 = Number(pos.tokensOwed0) / Math.pow(10, dec0);
          unclaimed1 = Number(pos.tokensOwed1) / Math.pow(10, dec1);
          const resFees = calculatePositionUsd(unclaimed0, unclaimed1, pos.token0, pos.token1, sqrtPriceX96, dec0, dec1);
          unclaimedUsd = resFees.totalUsd;
        }

        // Initial deposit calculation
        const mintTxHash = nftMintTxMap[tid.toString()];
        const { depAmount0, depAmount1, depTotalUsd } = await fetchMintDeposit(mintTxHash, wallet.address, pos.token0, pos.token1, dec0, dec1, sqrtPriceX96);

        // 24h fee earnings estimation
        const mintTsStr = nftMintTsMap[tid.toString()];
        let ageHours = 24;
        if (mintTsStr) {
          const ageMs = Date.now() - new Date(mintTsStr).getTime();
          ageHours = Math.max(0.5, ageMs / (1000 * 3600));
        }
        const est24hUsd = (unclaimedUsd / ageHours) * 24;
        const baseForYield = depTotalUsd > 0 ? depTotalUsd : (totalUsd > 0 ? totalUsd : 0);
        const est24hPercent = baseForYield > 0 ? (est24hUsd / baseForYield) * 100 : 0;

        const totalPosUsd = totalUsd + unclaimedUsd;
        const pnlUsd = depTotalUsd > 0 ? totalPosUsd - depTotalUsd : 0;
        const pnlPercent = depTotalUsd > 0 ? (pnlUsd / depTotalUsd) * 100 : 0;

        positions.push({
          tokenId: tid.toString(),
          symbol0: sym0,
          symbol1: sym1,
          amount0,
          amount1,
          totalUsd,
          depAmount0,
          depAmount1,
          depTotalUsd,
          unclaimed0,
          unclaimed1,
          unclaimedUsd,
          est24hUsd,
          est24hPercent,
          pnlUsd,
          pnlPercent,
          fee: Number(pos.fee) / 10000,
          liquidity: pos.liquidity.toString(),
          ageStr: formatAgeFromTimestamp(nftMintTsMap[tid.toString()]),
          tickLower: pos.tickLower.toString(),
          tickUpper: pos.tickUpper.toString(),
          isV4: false
        });
      } catch {
        // Skip
      }
    }
  } catch {
    // Skip V3 error
  }

  // 2. Check Uniswap V4 Positions (UNI-V4-POSM - 100% Pure Dynamic On-Chain Query)
  try {
    const url = `https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/nft`;
    const res = await fetch(url);
    const data = await res.json();

    const v4Posm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V4_POSM_ABI, provider);

    if (data.items) {
      for (const item of data.items) {
        const tid = (item.id || item.token_id).toString();
        try {
          const owner = await v4Posm.ownerOf(tid);
          if (owner.toLowerCase() === wallet.address.toLowerCase()) {
            // Check position liquidity dynamically on-chain via getPositionLiquidity
            const liq = await v4Posm.getPositionLiquidity(tid).catch(() => 0n);
            if (liq === 0n) continue; // Skip closed positions (liquidity = 0)

            const uriData = await v4Posm.tokenURI(tid);
            let sym0 = 'TOKEN0';
            let sym1 = 'TOKEN1';
            let fee = 0;
            let range = 'Concentrated';
            let pMin = 0;
            let pMax = 0;

            if (uriData.startsWith('data:application/json;base64,')) {
              const jsonStr = Buffer.from(uriData.replace('data:application/json;base64,', ''), 'base64').toString('utf-8');
              const meta = JSON.parse(jsonStr);
              const name = meta.name || '';

              // Parse title format: "Uniswap - 2.45% - USDG/BRODIE - 0.00099551<>0.0019768"
              const parts = name.split(' - ');
              if (parts.length >= 4) {
                fee = parseFloat(parts[1]);
                const pairParts = parts[2].split('/');
                if (pairParts.length === 2) {
                  sym0 = pairParts[0];
                  sym1 = pairParts[1];
                }
                const rangeParts = parts[3].split('<>');
                if (rangeParts.length === 2) {
                  pMin = parseFloat(rangeParts[0]);
                  pMax = parseFloat(rangeParts[1]);
                  range = `$${rangeParts[0]} - $${rangeParts[1]}`;
                }
              }
            }

            let amount0 = 0;
            let amount1 = 0;
            let totalUsd = 0;

            const dec0 = sym0 === 'USDG' ? 6 : 18;
            const dec1 = sym1 === 'USDG' ? 6 : 18;

            if (pMin > 0 && pMax > 0) {
              let pMinRaw, pMaxRaw;
              if (sym0 === 'USDG') {
                pMinRaw = (1 / pMax) * Math.pow(10, dec1 - dec0);
                pMaxRaw = (1 / pMin) * Math.pow(10, dec1 - dec0);
              } else {
                pMinRaw = pMin * Math.pow(10, dec1 - dec0);
                pMaxRaw = pMax * Math.pow(10, dec1 - dec0);
              }

              const tLower = Math.floor(Math.log(pMinRaw) / Math.log(1.0001));
              const tUpper = Math.floor(Math.log(pMaxRaw) / Math.log(1.0001));
              const tCurr = Math.floor((tLower + tUpper) / 2);

              const resLiq = getAmountsForLiquidity(liq.toString(), tCurr, tLower, tUpper, dec0, dec1);
              amount0 = resLiq.amount0;
              amount1 = resLiq.amount1;
              const pMid = Math.sqrt(pMin * pMax);

              if (sym0 === 'USDG') {
                totalUsd = amount0 + amount1 * pMid;
              } else if (sym1 === 'USDG') {
                totalUsd = amount0 * pMid + amount1;
              } else {
                totalUsd = amount0 + amount1;
              }
            }

            // Initial deposit calculation for V4
            const mintTxHash = nftMintTxMap[tid];
            const { depAmount0, depAmount1, depTotalUsd } = await fetchMintDeposit(mintTxHash, wallet.address, null, null, dec0, dec1, 0n, sym0, sym1);

            const unclaimed0 = 0;
            const unclaimed1 = 0;
            const unclaimedUsd = 0;

            const mintTsStr = nftMintTsMap[tid];
            let ageHours = 24;
            if (mintTsStr) {
              const ageMs = Date.now() - new Date(mintTsStr).getTime();
              ageHours = Math.max(0.5, ageMs / (1000 * 3600));
            }

            const totalPosUsd = totalUsd + unclaimedUsd;
            const pnlUsd = depTotalUsd > 0 ? totalPosUsd - depTotalUsd : 0;
            const pnlPercent = depTotalUsd > 0 ? (pnlUsd / depTotalUsd) * 100 : 0;

            const est24hUsd = unclaimedUsd > 0 ? (unclaimedUsd / ageHours) * 24 : 0;
            const baseForYield = depTotalUsd > 0 ? depTotalUsd : (totalUsd > 0 ? totalUsd : 0);
            const est24hPercent = baseForYield > 0 ? (est24hUsd / baseForYield) * 100 : 0;

            const ageStr = formatAgeFromTimestamp(nftMintTsMap[tid]);

            positions.push({
              tokenId: tid,
              symbol0: sym0,
              symbol1: sym1,
              amount0,
              amount1,
              totalUsd,
              depAmount0,
              depAmount1,
              depTotalUsd,
              unclaimed0,
              unclaimed1,
              unclaimedUsd,
              est24hUsd,
              est24hPercent,
              pnlUsd,
              pnlPercent,
              fee: fee,
              liquidity: liq.toString(),
              ageStr: ageStr,
              tickLower: range,
              tickUpper: '',
              isV4: true
            });
          }
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

  // Check and approve allowance
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

  const nfpm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V3_NFPM_ABI, wallet);

  const mintParams = {
    token0: token0Addr,
    token1: token1Addr,
    fee: 3000, // 0.3% fee tier
    tickLower: tx.tick_lower ?? -887272,
    tickUpper: tx.tick_upper ?? 887272,
    amount0Desired: parsedAmountUsd,
    amount1Desired: parsedAmountUsd,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600
  };

  const txResponse = await nfpm.mint(mintParams);
  const receipt = await txResponse.wait();
  return receipt.hash;
}

async function closePositionAndSwapToUsdg(tokenId) {
  const wallet = getWallet();
  const nfpm = new ethers.Contract(UNISWAP_V4_POSM_ADDRESS, UNISWAP_V3_NFPM_ABI, wallet);

  // 1. Get position details
  const pos = await nfpm.positions(tokenId).catch(() => null);

  const deadline = Math.floor(Date.now() / 1000) + 600;

  // 2. Decrease Liquidity (100%)
  if (pos && pos.liquidity > 0n) {
    const decreaseTx = await nfpm.decreaseLiquidity({
      tokenId,
      liquidity: pos.liquidity,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline
    });
    await decreaseTx.wait();
  }

  // 3. Collect tokens
  const collectTx = await nfpm.collect({
    tokenId,
    recipient: wallet.address,
    amount0Max: ethers.MaxUint128,
    amount1Max: ethers.MaxUint128
  });
  const collectReceipt = await collectTx.wait();

  // 4. Auto-Swap non-USDG tokens to USDG
  if (pos) {
    const swapRouter = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, UNISWAP_V3_SWAP_ROUTER_ABI, wallet);
    const tokensToCheck = [pos.token0, pos.token1];

    for (const tokenAddr of tokensToCheck) {
      if (tokenAddr && tokenAddr.toLowerCase() !== USDG_ADDRESS.toLowerCase()) {
        try {
          const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
          const bal = await tokenContract.balanceOf(wallet.address);
          if (bal > 0n) {
            // Approve router
            const approveTx = await tokenContract.approve(UNISWAP_V3_ROUTER_ADDRESS, bal);
            await approveTx.wait();

            // Swap to USDG
            const swapTx = await swapRouter.exactInputSingle({
              tokenIn: tokenAddr,
              tokenOut: USDG_ADDRESS,
              fee: pos.fee,
              recipient: wallet.address,
              deadline,
              amountIn: bal,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n
            });
            await swapTx.wait();
          }
        } catch (e) {
          console.error(`Error auto-swapping token ${tokenAddr} to USDG:`, e.message);
        }
      }
    }
  }

  return collectReceipt.hash;
}

module.exports = {
  getExecutorAddress,
  getExecutorBalance,
  getExecutorPositions,
  executeCopyAddLiquidity,
  closePositionAndSwapToUsdg,
};
