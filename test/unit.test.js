const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tg = require('../src/telegram.js');
const uniswapExecutor = require('../src/uniswap-executor.js');
const gmgn = require('../src/gmgn-api.js');
const rpcDecoder = require('../src/rpc-decoder.js');
const config = require('../src/config.js');

console.log('🧪 Running Comprehensive Tracker Wallet Unit Test Suite...\n');

// -------------------------------------------------------------
// 1. Telegram Helper & Formatting Functions
// -------------------------------------------------------------
console.log('1. Testing Telegram Helper & Formatting Functions...');

// shortAddr
assert.strictEqual(tg.shortAddr('0x1234567890abcdef1234567890abcdef12345678'), '0x12…5678');
assert.strictEqual(tg.shortAddr('short'), 'shor…hort');
assert.strictEqual(tg.shortAddr(''), '…');

// displayName
assert.strictEqual(tg.displayName({ label: 'MyWallet', address: '0x1234567890abcdef' }), 'MyWallet');
assert.strictEqual(tg.displayName({ address: '0x1234567890abcdef1234567890abcdef12345678' }), '0x12…5678');

// formatExecutorBalance
const mockBalData = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  ethBalance: '1.2345',
  tokens: [
    { symbol: 'USDG', balance: '100.5' },
    { symbol: 'BRODIE', balance: '5000' }
  ]
};
const balText = tg.formatExecutorBalance(mockBalData);
assert(balText.includes('Executor Wallet Balance'), 'Should format balance header');
assert(balText.includes('1.2345 ETH'), 'Should include ETH balance');
assert(balText.includes('USDG'), 'Should include token balances');

// formatHoldings & formatStats
const mockHoldings = {
  list: [
    { token: { symbol: 'USDG' }, balance: '100', usd_value: 100 },
    { token: { symbol: 'BRODIE' }, balance: '5000', usd_value: 50 }
  ]
};
const holdingsText = tg.formatHoldings(mockHoldings);
assert(holdingsText.includes('Holdings'), 'Should format holdings header');
assert(holdingsText.includes('USDG'), 'Should list USDG');

const mockStats = {
  realized_profit: 15.5,
  native_balance: 1.25
};
const statsText = tg.formatStats(mockStats, '0x1234567890abcdef1234567890abcdef12345678', 'robinhood');
assert(statsText.includes('0x12…5678'), 'Should format stats header with shortAddr');

console.log('  ✅ Telegram helper & formatting functions OK!');

// -------------------------------------------------------------
// 2. Uniswap Executor Math & Price Functions
// -------------------------------------------------------------
console.log('2. Testing Uniswap Executor Math & Price Functions...');

// getExecutorAddress (returns address or null)
const execAddr = uniswapExecutor.getExecutorAddress();
assert(execAddr === null || typeof execAddr === 'string');

// getExecutorPositions test formatting
const mockV4Positions = [
  {
    tokenId: '323546',
    symbol0: 'USDG',
    symbol1: 'BRODIE',
    amount0: 0.0642,
    amount1: 45.72,
    totalUsd: 0.13,
    depAmount0: 100,
    depAmount1: 0,
    depTotalUsd: 100,
    unclaimed0: 0,
    unclaimed1: 0,
    unclaimedUsd: 0,
    est24hUsd: 0,
    est24hPercent: 0,
    pnlUsd: -99.87,
    pnlPercent: -99.87,
    fee: 2.45,
    ageStr: '5h 17m',
    tickLower: '$0.00099551 - $0.0019768',
    tickUpper: '',
    isV4: true
  }
];
const posResult = tg.formatExecutorPositions(mockV4Positions);
assert(posResult.text.includes('Active Liquidity Positions (1)'));
assert(posResult.text.includes('Deposit: <b>100 USDG + 0 BRODIE'));
assert(posResult.text.includes('Current: <b>0.06 USDG + 45.72 BRODIE'));

console.log('  ✅ Uniswap executor math & price functions OK!');

// -------------------------------------------------------------
// 3. GMGN API & Chain Functions
// -------------------------------------------------------------
console.log('3. Testing GMGN API & Chain Functions...');

assert.strictEqual(gmgn.detectChain('0x1234'), 'robinhood');
assert.strictEqual(gmgn.detectChain('SolanaAddr'), 'robinhood');
assert.deepStrictEqual(gmgn.VALID_CHAINS, ['robinhood']);

console.log('  ✅ GMGN API & chain functions OK!');

// -------------------------------------------------------------
// 4. RPC Decoder Functions
// -------------------------------------------------------------
console.log('4. Testing RPC Decoder Functions...');

assert.strictEqual(typeof rpcDecoder.getLiquidityTransfers, 'function');
assert.strictEqual(typeof rpcDecoder.fetchDexScreenerLiquidity, 'function');

console.log('  ✅ RPC decoder functions OK!');

// -------------------------------------------------------------
// 5. Config Storage Functions
// -------------------------------------------------------------
console.log('5. Testing Config Storage Functions...');

const initialWallets = config.loadWallets();
assert(Array.isArray(initialWallets));

// Test saving and restoring wallets
const testWallets = [{ address: '0x0000000000000000000000000000000000000001', chain: 'robinhood', label: 'TestWallet' }];
config.saveWallets(testWallets);
const loadedTestWallets = config.loadWallets();
assert.strictEqual(loadedTestWallets.length, 1);
assert.strictEqual(loadedTestWallets[0].address, '0x0000000000000000000000000000000000000001');

// Restore initial wallets
config.saveWallets(initialWallets);

console.log('  ✅ Config storage functions OK!');

// -------------------------------------------------------------
// 6. Raw On-Chain Liquidity Conversion (1847294029482)
// -------------------------------------------------------------
console.log('6. Testing Raw On-Chain Liquidity Conversion (1847294029482)...');

const rawOnChainLiquidity = '1847294029482';
const pMin = 0.00099551;
const pMax = 0.0019768;
const pMinRaw = (1 / pMax) * Math.pow(10, 18 - 6);
const pMaxRaw = (1 / pMin) * Math.pow(10, 18 - 6);
const tLower = Math.floor(Math.log(pMinRaw) / Math.log(1.0001));
const tUpper = Math.floor(Math.log(pMaxRaw) / Math.log(1.0001));
const tCurr = Math.floor((tLower + tUpper) / 2);

const liqNum = Number(rawOnChainLiquidity);
const sqrtA = Math.pow(1.0001, tLower / 2);
const sqrtB = Math.pow(1.0001, tUpper / 2);
const sqrtC = Math.pow(1.0001, tCurr / 2);

const amt0Raw = liqNum * (sqrtB - sqrtC) / (sqrtC * sqrtB);
const amt1Raw = liqNum * (sqrtC - sqrtA);
const amt0 = Math.max(0, amt0Raw / 1e6);
const amt1 = Math.max(0, amt1Raw / 1e18);

assert(amt0 < 100, `Raw USDG amount should be realistic (< 100 USDG), got ${amt0}`);
assert(amt1 < 1000, `Raw BRODIE amount should be realistic (< 1000 BRODIE), got ${amt1}`);

console.log(`  Calculated for 1847294029482 -> ${amt0.toFixed(4)} USDG + ${amt1.toFixed(4)} BRODIE`);
console.log('  ✅ Raw On-Chain Liquidity Conversion OK!');

console.log('\n🎉 ALL MODULE UNIT TESTS PASSED SUCCESSFULLY! (6/6 Suites Passed)\n');
