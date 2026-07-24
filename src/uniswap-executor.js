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

// Addresses on Robinhood Chain
const UNISWAP_V3_NFPM_ADDRESS = process.env.UNISWAP_V3_NFPM_ADDRESS || '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
const UNISWAP_V4_POSM_ADDRESS = process.env.UNISWAP_V4_POSM_ADDRESS || '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const UNISWAP_V3_ROUTER_ADDRESS = process.env.UNISWAP_V3_ROUTER_ADDRESS || '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const USDG_ADDRESS = process.env.USDG_ADDRESS || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

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

  // Fetch NFT mint timestamps dynamically from Blockscout for exact Age calculation
  const nftMintTsMap = {};
  try {
    const resTs = await fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/token-transfers?type=ERC-721`);
    const dataTs = await resTs.json();
    if (dataTs.items) {
      dataTs.items.forEach(item => {
        const tid = item.total?.token_id;
        if (tid && item.timestamp && !nftMintTsMap[tid]) {
          nftMintTsMap[tid] = item.timestamp;
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

        const [sym0, sym1] = await Promise.all([
          token0Contract.symbol().catch(() => 'TOKEN0'),
          token1Contract.symbol().catch(() => 'TOKEN1')
        ]);

        positions.push({
          tokenId: tid.toString(),
          symbol0: sym0,
          symbol1: sym1,
          fee: Number(pos.fee) / 10000,
          liquidity: pos.liquidity.toString(),
          ageStr: formatAgeFromTimestamp(nftMintTsMap[tid.toString()]),
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
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
                  range = `$${rangeParts[0]} - $${rangeParts[1]}`;
                }
              }
            }

            const ageStr = formatAgeFromTimestamp(nftMintTsMap[tid]);

            positions.push({
              tokenId: tid,
              symbol0: sym0,
              symbol1: sym1,
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
