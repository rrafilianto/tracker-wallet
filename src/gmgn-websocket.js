const WebSocket = require('ws');

const DYNAMIC_USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function getDynamicUserAgent() {
  if (process.env.USER_AGENT) return process.env.USER_AGENT;
  const idx = Math.floor(Math.random() * DYNAMIC_USER_AGENTS.length);
  return DYNAMIC_USER_AGENTS[idx];
}

function cleanErrorMessage(msg) {
  if (!msg) return 'Unknown error';
  const str = String(msg);
  if (str.includes('<html') || str.includes('cf-footer') || str.includes('Cloudflare')) {
    return 'HTTP 403 Forbidden (Cloudflare Anti-Bot Challenge)';
  }
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
}

class GmgnWebSocketManager {
  constructor() {
    this.ws = null;
    this.apiKey = null;
    this.onTpSlTrigger = null;
    this.pingInterval = null;
    this.reconnectTimer = null;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.subscribedTokens = new Map(); // tokenAddress (lower) -> Map(positionId -> positionObj)
    this.lastPrices = new Map(); // tokenAddress (lower) -> currentPrice
  }

  init(apiKey, onTpSlTriggerCallback) {
    this.apiKey = apiKey;
    this.onTpSlTrigger = onTpSlTriggerCallback;
    this.connect();
  }

  connect() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      const activeUserAgent = getDynamicUserAgent();
      const headers = {
        'User-Agent': activeUserAgent,
        'Origin': 'https://gmgn.ai',
      };
      if (this.apiKey) {
        headers['X-APIKEY'] = this.apiKey;
      }

      console.log('🔌 [GMGN WS] Connecting to wss://gmgn.ai/ws...');
      this.ws = new WebSocket('wss://gmgn.ai/ws', { headers });

      this.ws.on('open', () => {
        console.log('✅ [GMGN WS] Connected successfully!');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.stopFallbackPolling();

        // Setup Ping Heartbeat (every 25 seconds)
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.ping();
            } catch {
              // Ignore ping error
            }
          }
        }, 25000);

        // Resubscribe to all active tokens on reconnect
        this.resubscribeAll();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          // Ignore non-JSON messages
        }
      });

      this.ws.on('close', (code, reason) => {
        const cleanReason = cleanErrorMessage(reason);
        console.warn(`⚠️ [GMGN WS] Connection closed (${code}): ${cleanReason}`);
        this.cleanup();
        this.startFallbackPolling();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        const cleanMsg = cleanErrorMessage(err.message);
        console.error('❌ [GMGN WS] Error:', cleanMsg);
        this.cleanup();
        this.startFallbackPolling();
        this.scheduleReconnect();
      });
    } catch (err) {
      const cleanMsg = cleanErrorMessage(err.message);
      console.error('❌ [GMGN WS] Failed to initiate connection:', cleanMsg);
      this.cleanup();
      this.startFallbackPolling();
      this.scheduleReconnect();
    }
  }

  startFallbackPolling() {
    if (this.fallbackPollTimer) return;
    console.log('🔄 [PRICE MONITOR] Active Fallback Polling (DexScreener/RPC) for TP/SL...');
    this.fallbackPollTimer = setInterval(async () => {
      if (this.subscribedTokens.size === 0) return;
      for (const tokenAddr of this.subscribedTokens.keys()) {
        try {
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`);
          const json = await res.json();
          if (json.pairs && json.pairs.length > 0) {
            const priceUsd = parseFloat(json.pairs[0].priceUsd);
            if (priceUsd > 0) {
              this.updatePrice(tokenAddr, priceUsd);
            }
          }
        } catch {
          // Ignore fetch error
        }
      }
    }, 5000);
  }

  stopFallbackPolling() {
    if (this.fallbackPollTimer) {
      clearInterval(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }
  }

  cleanup() {
    this.isConnecting = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(30000, 3000 * Math.pow(1.5, this.reconnectAttempts - 1));
    console.log(`🔄 [GMGN WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (Attempt #${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  resubscribeAll() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const tokenAddr of this.subscribedTokens.keys()) {
      this.sendSubscribe(tokenAddr);
    }
  }

  sendSubscribe(tokenAddr) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        action: 'subscribe',
        channel: 'token_price',
        chain: 'robinhood',
        address: tokenAddr,
      });
      this.ws.send(payload);
    }
  }

  sendUnsubscribe(tokenAddr) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        action: 'unsubscribe',
        channel: 'token_price',
        chain: 'robinhood',
        address: tokenAddr,
      });
      this.ws.send(payload);
    }
  }

  /**
   * Subscribe a position to token price monitoring
   */
  subscribePosition(tokenAddress, positionInfo) {
    if (!tokenAddress || !positionInfo?.positionId) return;
    const tokenLower = tokenAddress.toLowerCase();

    if (!this.subscribedTokens.has(tokenLower)) {
      this.subscribedTokens.set(tokenLower, new Map());
      this.sendSubscribe(tokenLower);
    }

    const posMap = this.subscribedTokens.get(tokenLower);
    posMap.set(positionInfo.positionId, {
      ...positionInfo,
      triggered: false,
    });

    console.log(`📡 [GMGN WS] Subscribed Position #${positionInfo.positionId} for token ${tokenLower}`);
  }

  /**
   * Unsubscribe a position from token price monitoring
   */
  unsubscribePosition(tokenAddress, positionId) {
    if (!tokenAddress || !positionId) return;
    const tokenLower = tokenAddress.toLowerCase();

    const posMap = this.subscribedTokens.get(tokenLower);
    if (posMap) {
      posMap.delete(positionId);
      console.log(`📡 [GMGN WS] Unsubscribed Position #${positionId} for token ${tokenLower}`);

      if (posMap.size === 0) {
        this.subscribedTokens.delete(tokenLower);
        this.sendUnsubscribe(tokenLower);
      }
    }
  }

  /**
   * Manual price update handler (e.g. from RPC or polling fallback if needed)
   */
  updatePrice(tokenAddress, priceUsd) {
    if (!tokenAddress || !priceUsd || priceUsd <= 0) return;
    const tokenLower = tokenAddress.toLowerCase();
    this.lastPrices.set(tokenLower, priceUsd);
    this.evaluatePositions(tokenLower, priceUsd);
  }

  handleMessage(msg) {
    // Extract token address and price from WS payload
    const tokenAddr = (msg.address || msg.token_address || msg.data?.address || msg.data?.token_address || '').toLowerCase();
    const priceUsd = parseFloat(msg.price || msg.data?.price || msg.data?.price_usd);

    if (tokenAddr && priceUsd > 0) {
      this.lastPrices.set(tokenAddr, priceUsd);
      this.evaluatePositions(tokenAddr, priceUsd);
    }
  }

  evaluatePositions(tokenLower, currentPrice) {
    const posMap = this.subscribedTokens.get(tokenLower);
    if (!posMap || posMap.size === 0) return;

    for (const [posId, pos] of posMap.entries()) {
      if (pos.triggered) continue;
      const entryPrice = parseFloat(pos.entryPriceUsd);
      if (!entryPrice || entryPrice <= 0) continue;

      const deltaPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const tpTarget = parseFloat(pos.tpPct);
      const slTarget = parseFloat(pos.slPct);

      let triggerType = null;
      if (tpTarget > 0 && deltaPct >= tpTarget) {
        triggerType = 'TP';
      } else if (slTarget > 0 && deltaPct <= -slTarget) {
        triggerType = 'SL';
      }

      if (triggerType) {
        pos.triggered = true; // Mark as triggered to prevent duplicated alerts
        console.log(`🎯 [GMGN WS] ${triggerType} Triggered for Position #${posId}! Entry: $${entryPrice}, Current: $${currentPrice}, Delta: ${deltaPct.toFixed(2)}%`);

        if (typeof this.onTpSlTrigger === 'function') {
          this.onTpSlTrigger({
            type: triggerType,
            position: pos,
            currentPrice,
            deltaPct,
            entryPrice,
          });
        }
      }
    }
  }

  getLastPrice(tokenAddress) {
    return this.lastPrices.get((tokenAddress || '').toLowerCase()) || null;
  }
}

module.exports = new GmgnWebSocketManager();
