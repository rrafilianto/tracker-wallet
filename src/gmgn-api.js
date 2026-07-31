require('./logger');
const crypto = require('crypto');

const BASE_URL = 'https://openapi.gmgn.ai/v1';

function detectChain() {
  return 'robinhood';
}

function buildUrl(endpoint, params) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  url.searchParams.set('timestamp', Math.floor(Date.now() / 1000));
  url.searchParams.set('client_id', crypto.randomUUID());
  return url.toString();
}

async function gmgnFetch(apiKey, endpoint, params = {}) {
  const url = buildUrl(endpoint, params);
  try {
    const res = await fetch(url, {
      headers: {
        'X-APIKEY': apiKey,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`GMGN API ${res.status}: ${errText}`);
      console.error(`❌ [GMGN API ERROR] Endpoint ${endpoint}:`, err.message);
      throw err;
    }
    const json = await res.json();
    if (json.code !== 0) {
      const err = new Error(`GMGN error ${json.code}: ${json.reason || json.message || JSON.stringify(json)}`);
      console.error(`❌ [GMGN API ERROR] Endpoint ${endpoint}:`, err.message);
      throw err;
    }
    return json.data;
  } catch (err) {
    console.error(`❌ [GMGN FETCH ERROR] Failed request to ${endpoint}:`, err.message);
    throw err;
  }
}

function getWalletActivity(apiKey, address, limit = 10, chain = 'robinhood') {
  return gmgnFetch(apiKey, '/user/wallet_activity', {
    chain: chain || 'robinhood',
    wallet_address: address,
    limit,
  });
}

function getWalletStats(apiKey, address, period = '7d', chain = 'robinhood') {
  return gmgnFetch(apiKey, '/user/wallet_stats', {
    chain: chain || 'robinhood',
    wallet_address: address,
    period,
  });
}

function getWalletHoldings(apiKey, address, chain = 'robinhood') {
  return gmgnFetch(apiKey, '/user/wallet_holdings', {
    chain: chain || 'robinhood',
    wallet_address: address,
    limit: 20,
    order_by: 'usd_value',
    direction: 'desc',
  });
}

module.exports = {
  getWalletActivity,
  getWalletStats,
  getWalletHoldings,
  detectChain,
  VALID_CHAINS: ['robinhood', 'bsc'],
};

