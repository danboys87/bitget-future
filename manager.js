/**
 * Manager — Futures Bot
 * Monitor semua posisi terbuka:
 *  - Stop Loss
 *  - TP1 (partial close 50% → BEP)
 *  - Trailing Stop
 *  - Liquidation warning
 *  - Max Hold Time
 */
import { getCurrentPrice }     from './bitgetFutures.js';
import { config }              from './config.js';
import { log }                 from './logger.js';
import {
  getAllPositions, updatePeakPrice, activateTrailing, setBEP,
} from './state.js';
import { executeClose, executePartialClose } from './executor.js';
import { notifyClose, notifyLiquidationWarning } from './telegram.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Hitung PnL % dengan leverage
// ─────────────────────────────────────────────────────────────────────────────
function calcPnlPct(position, currentPrice) {
  const { entryPrice, side, leverage } = position;
  const priceDiff = side === 'long'
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;
  return (priceDiff / entryPrice) * 100 * leverage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluasi satu posisi
// ─────────────────────────────────────────────────────────────────────────────
async function evaluatePosition(pos) {
  const { symbol, side, entryPrice, slPrice, tp1Price, liqPrice, leverage } = pos;
  const mgmt = config.management;

  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) {
    log('manager_warn', `Tidak bisa ambil harga ${symbol}, skip`);
    return;
  }

  const pnlPct    = calcPnlPct(pos, currentPrice);
  const holdHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
  const hasBEP    = pos.hasBEP;

  // Liquidation distance %
  const liqDist = side === 'long'
    ? ((currentPrice - liqPrice) / currentPrice) * 100
    : ((liqPrice - currentPrice) / currentPrice) * 100;

  log('manager',
    `${symbol} ${side.toUpperCase()} | price=${currentPrice} entry=${entryPrice} ` +
    `PnL=${pnlPct.toFixed(2)}% | hold=${holdHours.toFixed(1)}h | ` +
    `BEP=${hasBEP ? 'YES' : 'no'} | trail=${pos.trailingActive ? 'ON' : 'off'} | ` +
    `liqDist=${liqDist.toFixed(1)}%`
  );

  // ── 0. Liquidation Warning ─────────────────────────────────────────────────
  const liqBuffer = mgmt.liquidationBufferPct ?? 15;
  if (liqDist <= liqBuffer && liqDist > 0) {
    log('manager', `⚠️  LIQUIDATION WARNING: ${symbol} ${side} — ${liqDist.toFixed(1)}% dari liquidasi!`);
    await notifyLiquidationWarning({ symbol, side, currentPrice, liqPrice, liqDist });
  }

  // ── 1. Stop Loss ───────────────────────────────────────────────────────────
  const effectiveSL = hasBEP
    ? (side === 'long' ? entryPrice * 0.9995 : entryPrice * 1.0005) // BEP dengan buffer kecil
    : slPrice;

  const slHit = side === 'long'
    ? currentPrice <= effectiveSL
    : currentPrice >= effectiveSL;

  if (slHit) {
    const slLabel = hasBEP ? 'Break Even SL' : 'Stop Loss';
    log('manager', `🛑 ${slLabel}: ${symbol} ${side} | price=${currentPrice} SL=${effectiveSL?.toFixed(6)}`);
    const result = await executeClose(symbol, side, { reason: hasBEP ? 'break_even_sl' : 'stop_loss', position: pos });
    if (result.success) {
      await notifyClose({ symbol, side, entryPrice, exitPrice: result.exitPrice, pnlPct: result.pnlPct, pnlUsdt: result.pnlUsdt, reason: hasBEP ? 'break_even_sl' : 'stop_loss', leverage });
    }
    return;
  }

  // ── 2. TP1 — partial close 50% → set BEP ──────────────────────────────────
  if (!hasBEP) {
    const tp1Hit = side === 'long'
      ? currentPrice >= tp1Price
      : currentPrice <= tp1Price;

    if (tp1Hit) {
      log('manager', `🎯 TP1 hit: ${symbol} ${side} | price=${currentPrice} TP1=${tp1Price?.toFixed(6)} | Tutup 50%, set BEP`);
      const result = await executePartialClose(symbol, side, { closePct: 50, reason: 'tp1_partial', position: pos });
      if (result.success) {
        setBEP(symbol, side);
        activateTrailing(symbol, side);
        await notifyClose({ symbol, side, entryPrice, exitPrice: result.exitPrice, pnlPct: mgmt.takeProfitPct, pnlUsdt: null, reason: 'tp1_partial', leverage });
        log('manager', `✅ TP1 done, BEP set, trailing aktif: ${symbol} ${side}`);
      }
      return;
    }
  }

  // ── 3. Aktifkan trailing jika profit >= activateAtProfitPct ───────────────
  const activateAt = mgmt.trailingStop?.activateAtProfitPct ?? 3;
  if (!pos.trailingActive && !hasBEP && pnlPct >= activateAt) {
    log('manager', `🔻 Trailing aktif early: ${symbol} ${side} | PnL=${pnlPct.toFixed(2)}% >= ${activateAt}%`);
    activateTrailing(symbol, side);
  }

  // ── 4. Trailing Stop ───────────────────────────────────────────────────────
  if (pos.trailingActive || hasBEP) {
    updatePeakPrice(symbol, side, currentPrice);

    // Baca posisi terbaru setelah update peak
    const allPos = getAllPositions();
    const freshPos = allPos[pos.key];
    if (!freshPos) return;

    const trailPct     = mgmt.trailingStop?.trailPct ?? 1.5;
    const peakPrice    = freshPos.peakPrice;

    // Long: drop dari peak
    // Short: rise dari peak (peak = harga terendah)
    const dropFromPeak = side === 'long'
      ? ((peakPrice - currentPrice) / peakPrice) * 100
      : ((currentPrice - peakPrice) / peakPrice) * 100;

    if (dropFromPeak >= trailPct) {
      log('manager', `🔻 Trailing Stop: ${symbol} ${side} | drop=${dropFromPeak.toFixed(2)}% dari peak=${peakPrice}`);
      const result = await executeClose(symbol, side, { reason: 'trailing_stop', position: freshPos });
      if (result.success) {
        await notifyClose({ symbol, side, entryPrice, exitPrice: result.exitPrice, pnlPct: result.pnlPct, pnlUsdt: result.pnlUsdt, reason: 'trailing_stop', leverage });
      }
      return;
    }
    log('manager', `  Trail: peak=${peakPrice} drop=${dropFromPeak.toFixed(2)}% | trigger at ${trailPct}%`);
  }

  // ── 5. Max Hold Time ───────────────────────────────────────────────────────
  const maxHold = mgmt.maxHoldHours ?? 48;
  if (holdHours >= maxHold) {
    log('manager', `⏰ Max hold: ${symbol} ${side} sudah ${holdHours.toFixed(1)} jam`);
    const result = await executeClose(symbol, side, { reason: 'max_hold_time', position: pos });
    if (result.success) {
      await notifyClose({ symbol, side, entryPrice, exitPrice: result.exitPrice, pnlPct: result.pnlPct, pnlUsdt: result.pnlUsdt, reason: 'max_hold_time', leverage });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main management cycle
// ─────────────────────────────────────────────────────────────────────────────
export async function runManagementCycle() {
  const positions = Object.values(getAllPositions());

  if (positions.length === 0) {
    log('manager', 'Tidak ada posisi terbuka');
    return;
  }

  log('manager', `Mengevaluasi ${positions.length} posisi futures...`);

  for (const pos of positions) {
    try {
      await evaluatePosition(pos);
    } catch (err) {
      log('manager_error', `Error evaluasi ${pos.symbol} ${pos.side}: ${err.message}`);
    }
    await sleep(300);
  }

  log('manager', 'Management cycle selesai');
}
