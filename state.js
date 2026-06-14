/**
 * State Management — Futures Bot
 * Track posisi long & short yang sedang terbuka.
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/futures-state.json'
  : path.join(__dirname, 'state.json');

const DEFAULT_STATE = {
  positions: {},   // { symbol_long: {...}, symbol_short: {...} }
  closed:    [],
  totalPnlUsdt: 0,
};

function loadLocal() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    log('state_error', `Gagal baca state: ${err.message}`);
  }
  return { ...DEFAULT_STATE, positions: {}, closed: [] };
}

function saveLocal(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log('state_error', `Gagal simpan state: ${err.message}`);
  }
}

let _state = loadLocal();

export function initState() {
  _state = loadLocal();
  log('state', `💾 State loaded: ${Object.keys(_state.positions).length} posisi terbuka`);
}

// ── Key helper ─────────────────────────────────────────────────────────────
// Gunakan key unik per symbol+side agar bisa punya long & short sekaligus
function posKey(symbol, side) {
  return `${symbol}_${side}`; // contoh: BTCUSDT_long
}

// ── Open Position ─────────────────────────────────────────────────────────────
export function openPosition({ symbol, side, entryPrice, size, leverage, margin, orderId, slPrice, tp1Price, liqPrice, signals, strategy }) {
  const key = posKey(symbol, side);
  _state.positions[key] = {
    key,
    symbol,
    side,           // 'long' | 'short'
    entryPrice,
    size,           // contract size
    leverage,
    margin,         // USDT yang dipakai sebagai margin
    orderId,
    slPrice,
    tp1Price,
    liqPrice,       // estimated liquidation price
    signals,
    strategy,
    openedAt:       new Date().toISOString(),
    peakPrice:      entryPrice,
    trailingActive: false,
    hasBEP:         false,
    partialSells:   [],
  };
  saveLocal(_state);
  log('state', `📂 ${side.toUpperCase()} terbuka: ${symbol} @ ${entryPrice} | size=${size} | lev=${leverage}x | liq=${liqPrice?.toFixed(4)}`);
}

// ── Update Peak ───────────────────────────────────────────────────────────────
export function updatePeakPrice(symbol, side, currentPrice) {
  const key = posKey(symbol, side);
  const pos = _state.positions[key];
  if (!pos) return;

  const isNewPeak = side === 'long'
    ? currentPrice > pos.peakPrice
    : currentPrice < pos.peakPrice; // short: peak = harga terendah

  if (isNewPeak) {
    pos.peakPrice = currentPrice;
    saveLocal(_state);
  }
}

export function activateTrailing(symbol, side) {
  const key = posKey(symbol, side);
  const pos = _state.positions[key];
  if (pos && !pos.trailingActive) {
    pos.trailingActive = true;
    saveLocal(_state);
    log('state', `🔻 Trailing aktif: ${symbol} ${side}`);
  }
}

export function setBEP(symbol, side) {
  const key = posKey(symbol, side);
  const pos = _state.positions[key];
  if (pos && !pos.hasBEP) {
    pos.hasBEP = true;
    saveLocal(_state);
    log('state', `✅ BEP set: ${symbol} ${side}`);
  }
}

export function recordPartialClose(symbol, side, { closeSize, price, reason }) {
  const key = posKey(symbol, side);
  const pos = _state.positions[key];
  if (!pos) return;
  pos.partialSells.push({ closeSize, price, reason, at: new Date().toISOString() });
  pos.size = Math.max(0, pos.size - closeSize);
  saveLocal(_state);
}

// ── Close Position ────────────────────────────────────────────────────────────
export function closePosition(symbol, side, { exitPrice, reason }) {
  const key = posKey(symbol, side);
  const pos = _state.positions[key];
  if (!pos) return null;

  // PnL calculation
  const priceDiff = side === 'long'
    ? exitPrice - pos.entryPrice
    : pos.entryPrice - exitPrice;

  const pnlPct  = (priceDiff / pos.entryPrice) * 100 * pos.leverage;
  const pnlUsdt = (priceDiff / pos.entryPrice) * pos.margin * pos.leverage;

  const closed = {
    ...pos,
    exitPrice,
    closedAt: new Date().toISOString(),
    reason,
    pnlPct,
    pnlUsdt,
  };

  _state.closed.push(closed);
  _state.totalPnlUsdt = (_state.totalPnlUsdt || 0) + pnlUsdt;
  delete _state.positions[key];
  saveLocal(_state);

  const sign = pnlPct >= 0 ? '+' : '';
  log('state', `📁 ${side.toUpperCase()} ditutup: ${symbol} @ ${exitPrice} | PnL=${sign}${pnlPct.toFixed(2)}% (${sign}${pnlUsdt.toFixed(2)} USDT) | reason=${reason}`);
  return closed;
}

// ── Getters ───────────────────────────────────────────────────────────────────
export function getPosition(symbol, side) {
  return _state.positions[posKey(symbol, side)] || null;
}

export function getAllPositions() {
  return _state.positions;
}

export function getLongPositions() {
  return Object.values(_state.positions).filter(p => p.side === 'long');
}

export function getShortPositions() {
  return Object.values(_state.positions).filter(p => p.side === 'short');
}

export function hasPosition(symbol, side = null) {
  if (side) return !!_state.positions[posKey(symbol, side)];
  // Cek keduanya
  return !!_state.positions[posKey(symbol, 'long')] || !!_state.positions[posKey(symbol, 'short')];
}

export function getOpenSymbols() {
  return [...new Set(Object.values(_state.positions).map(p => p.symbol))];
}

export function getStats() {
  const positions = Object.values(_state.positions);
  return {
    openPositions: positions.length,
    openLong:      positions.filter(p => p.side === 'long').length,
    openShort:     positions.filter(p => p.side === 'short').length,
    closedCount:   _state.closed.length,
    totalPnlUsdt:  _state.totalPnlUsdt || 0,
  };
}
