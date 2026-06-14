/**
 * Approval Queue — Futures Bot
 * Menyimpan kandidat yang menunggu konfirmasi manual via Telegram.
 * Timeout default 30 menit.
 */
import { log } from './logger.js';

// Map: `symbol_side` → { candidate, expiresAt }
const _queue = new Map();

export function addToQueue(candidate, timeoutMin = 30) {
  const key       = `${candidate.symbol}_${candidate.side}`;
  const expiresAt = Date.now() + timeoutMin * 60 * 1000;

  if (_queue.has(key)) {
    log('approval', `${key} sudah ada di queue, skip`);
    return false;
  }

  _queue.set(key, { candidate, expiresAt });
  log('approval', `${key} masuk queue, expired dalam ${timeoutMin} menit`);

  // Auto-expire
  setTimeout(() => {
    if (_queue.has(key)) {
      _queue.delete(key);
      log('approval', `⏰ ${key} expired tanpa konfirmasi`);
    }
  }, timeoutMin * 60 * 1000);

  return true;
}

export function approveCandidate(symbol, side) {
  const key  = `${symbol}_${side}`;
  const item = _queue.get(key);
  if (!item) return { ok: false, reason: `${key} tidak ada di queue atau sudah expired` };
  _queue.delete(key);
  log('approval', `✅ ${key} diapprove`);
  return { ok: true, candidate: item.candidate };
}

export function skipCandidate(symbol, side) {
  const key = `${symbol}_${side}`;
  if (!_queue.has(key)) return { ok: false, reason: `${key} tidak ada di queue` };
  _queue.delete(key);
  log('approval', `⏭ ${key} diskip`);
  return { ok: true };
}

export function getPendingQueue() {
  const now = Date.now();
  const result = [];
  for (const [key, item] of _queue.entries()) {
    result.push({
      key,
      symbol:    item.candidate.symbol,
      side:      item.candidate.side,
      minsLeft:  Math.max(0, Math.round((item.expiresAt - now) / 60000)),
      candidate: item.candidate,
    });
  }
  return result;
}

export function clearQueue() { _queue.clear(); }
