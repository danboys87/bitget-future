/**
 * Bitget Futures REST API Client
 * USDT-M Perpetual (productType: USDT-FUTURES)
 * Docs: https://www.bitget.com/api-doc/contract/intro
 */
import crypto from 'crypto';
import axios  from 'axios';
import { log } from './logger.js';

const BASE_URL = 'https://api.bitget.com';

function sign(timestamp, method, requestPath, body, secretKey) {
  const msg = timestamp + method.toUpperCase() + requestPath + (body || '');
  return crypto.createHmac('sha256', secretKey).update(msg).digest('base64');
}

async function request(method, path, params = {}, body = null, auth = true) {
  const timestamp   = Date.now().toString();
  let requestPath   = path;

  if (method === 'GET' && Object.keys(params).length > 0) {
    requestPath = `${path}?${new URLSearchParams(params)}`;
  }

  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'locale': 'en-US' };

  if (auth) {
    headers['ACCESS-KEY']        = process.env.BITGET_API_KEY;
    headers['ACCESS-SIGN']       = sign(timestamp, method, requestPath, bodyStr, process.env.BITGET_SECRET_KEY);
    headers['ACCESS-TIMESTAMP']  = timestamp;
    headers['ACCESS-PASSPHRASE'] = process.env.BITGET_PASSPHRASE;
  }

  try {
    const res  = await axios({ method, url: BASE_URL + requestPath, headers, data: body || undefined, timeout: 10000 });
    const data = res.data;
    if (data.code !== '00000' && data.code !== 0) throw new Error(`Bitget API ${data.code}: ${data.msg}`);
    return data.data;
  } catch (err) {
    if (err.response) throw new Error(`Bitget HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    throw err;
  }
}

const PRODUCT_TYPE = 'USDT-FUTURES';

// ── Public ────────────────────────────────────────────────────────────────────
export async function getAllTickers() {
  return request('GET', '/api/v2/mix/market/tickers', { productType: PRODUCT_TYPE }, null, false);
}

export async function getTicker(symbol) {
  return request('GET', '/api/v2/mix/market/ticker', { symbol, productType: PRODUCT_TYPE }, null, false);
}

export async function getCandles(symbol, granularity = '1H', limit = 100) {
  return request('GET', '/api/v2/mix/market/candles', { symbol, granularity, limit: String(limit), productType: PRODUCT_TYPE }, null, false);
}

export async function getCurrentPrice(symbol) {
  const data = await getTicker(symbol);
  const t = Array.isArray(data) ? data[0] : data;
  return t ? parseFloat(t.lastPr || t.last) : null;
}

// ── Account ───────────────────────────────────────────────────────────────────
export async function getAccountInfo() {
  return request('GET', '/api/v2/mix/account/account', { productType: PRODUCT_TYPE, marginCoin: 'USDT' });
}

export async function getPositions() {
  return request('GET', '/api/v2/mix/position/all-position', { productType: PRODUCT_TYPE, marginCoin: 'USDT' });
}

export async function getPosition(symbol) {
  const positions = await getPositions();
  if (!Array.isArray(positions)) return null;
  return positions.find(p => p.symbol === symbol) || null;
}

// ── Trading ───────────────────────────────────────────────────────────────────

/**
 * Set leverage untuk symbol tertentu
 */
export async function setLeverage(symbol, leverage, marginMode = 'isolated') {
  return request('POST', '/api/v2/mix/account/set-leverage', {}, {
    symbol,
    productType: PRODUCT_TYPE,
    marginCoin:  'USDT',
    leverage:    String(leverage),
    holdSide:    'long_short', // set untuk kedua arah sekaligus
  });
}

/**
 * Set margin mode (isolated / cross)
 */
export async function setMarginMode(symbol, marginMode) {
  return request('POST', '/api/v2/mix/account/set-margin-mode', {}, {
    symbol,
    productType: PRODUCT_TYPE,
    marginCoin:  'USDT',
    marginMode,  // 'isolated' atau 'crossed'
  });
}

/**
 * Place order futures
 * side: 'open_long' | 'open_short' | 'close_long' | 'close_short'
 * orderType: 'market' | 'limit'
 */
export async function placeOrder({ symbol, side, orderType = 'market', size, price = null, reduceOnly = false }) {
  const body = {
    symbol,
    productType: PRODUCT_TYPE,
    marginMode:  'isolated',
    marginCoin:  'USDT',
    size:        String(size),
    side,
    orderType,
    force:       'gtc',
    clientOid:   `fut_${Date.now()}`,
  };
  if (price) body.price = String(price);
  if (reduceOnly) body.reduceOnly = 'YES';
  return request('POST', '/api/v2/mix/order/place-order', {}, body);
}

/**
 * Place TP/SL order (stop order)
 */
export async function placeTpSlOrder({ symbol, planType, triggerPrice, size, side }) {
  return request('POST', '/api/v2/mix/order/place-tpsl-order', {}, {
    symbol,
    productType:  PRODUCT_TYPE,
    marginCoin:   'USDT',
    planType,     // 'profit_plan' | 'loss_plan'
    triggerPrice: String(triggerPrice),
    size:         String(size),
    side,
    triggerType:  'mark_price',
    clientOid:    `tpsl_${Date.now()}`,
  });
}

/**
 * Cancel semua order untuk symbol
 */
export async function cancelAllOrders(symbol) {
  return request('POST', '/api/v2/mix/order/cancel-all-orders', {}, {
    symbol,
    productType: PRODUCT_TYPE,
    marginCoin:  'USDT',
  });
}

/**
 * Get order detail
 */
export async function getOrder(orderId, symbol) {
  return request('GET', '/api/v2/mix/order/detail', { symbol, orderId, productType: PRODUCT_TYPE });
}

/**
 * Get pending orders
 */
export async function getPendingOrders(symbol) {
  return request('GET', '/api/v2/mix/order/orders-pending', { symbol, productType: PRODUCT_TYPE });
}

/**
 * Hitung contract size dari budget USDT
 * size = (budget × leverage) / currentPrice
 */
export async function calcContractSize(symbol, budgetUsdt, leverage) {
  const price = await getCurrentPrice(symbol);
  if (!price || price <= 0) throw new Error(`Harga tidak valid untuk ${symbol}`);

  const exposure = budgetUsdt * leverage;
  const rawSize  = exposure / price;

  // Round ke presisi yang aman (Bitget futures umumnya 1-4 desimal)
  const size = Math.floor(rawSize * 10000) / 10000;
  return { price, size, exposure };
}

/**
 * Hitung liquidation price estimasi
 * Long:  liqPrice = entryPrice × (1 - 1/leverage + maintenanceMarginRate)
 * Short: liqPrice = entryPrice × (1 + 1/leverage - maintenanceMarginRate)
 */
export function calcLiquidationPrice(entryPrice, leverage, side, mmRate = 0.004) {
  if (side === 'long') {
    return entryPrice * (1 - 1 / leverage + mmRate);
  } else {
    return entryPrice * (1 + 1 / leverage - mmRate);
  }
}

/**
 * Test koneksi
 */
export async function testConnection() {
  try {
    const account = await getAccountInfo();
    return { ok: true, account };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
