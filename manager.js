/**
 * Manager — Futures Bot
 * Monitor semua posisi terbuka:
 *  - Stop Loss
 *  - TP1 (partial close → BEP → trailing aktif)
 *  - Trailing Stop (HANYA aktif setelah TP1, kecuali activateAfterTP1 = false)
 *  - Liquidation warning
 *  - Max Hold Time
 *
 * SATUAN — semua angka di user-config.json bagian "management" adalah
 * PERSEN GERAKAN HARGA (bukan persen margin / PnL berleverage):
 *   takeProfitPct, stopLossPct, trailPct, activateAtProfitPct, liquidationBufferPct
 * PnL % berleverage (persen dari margin) hanya ditampilkan di log/notifikasi.
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
// Gerakan harga % dari entry (positif = menguntungkan). Ini satuan acuan semua
// threshold di config.
// ─────────────────────────────────────────────────────────────────────────────
function calcPricePct(position, currentPrice) {
  const { entryPrice, side } = position;
  const priceDiff = side === 'long'
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;
  return (priceDiff / entryPrice) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluasi satu posisi
// ─────────────────────────────────────────────────────────────────────────────
async function evaluatePosition(pos) {
  const { symbol, side, entryPrice, slPrice, tp1Price, liqPrice, leverage } = pos;
  const mgmt      = config.management;
  const trailCfg  = mgmt.trailingStop ?? {};

  const trailEnabled   = trailCfg.enabled !== false;
  const afterTP1Only   = trailCfg.activateAfterTP1 !== false; // default: true
  const trailPct       = trailCfg.trailPct ?? 1.5;             // % harga
  const activateAtPct  = trailCfg.activateAtProfitPct ?? 2;    // % harga (hanya dipakai jika afterTP1Only = false)
  const tp1ClosePct    = mgmt.tp1?.closePct ?? 50;

  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) {
    log('manager_warn', `Tidak bisa ambil harga ${symbol}, skip`);
    return;
  }

  const pricePct  = calcPricePct(pos, currentPrice);   // % gerakan harga
  const marginPct = pricePct * leverage;               // % PnL terhadap margin (info saja)
  const holdHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000;
  const hasBEP    = pos.hasBEP;

  // Trailing dianggap aktif:
  //  - mode default (afterTP1Only): hanya jika TP1 sudah kena (hasBEP).
  //    Flag trailingActive lama dari sebelum TP1 diabaikan.
  //  - mode lama (afterTP1Only = false): ikut flag trailingActive.
  const trailingOn = trailEnabled && (afterTP1Only ? hasBEP : (pos.trailingActive || hasBEP));

  // Liquidation distance %
  const liqDist = side === 'long'
    ? ((currentPrice - liqPrice) / currentPrice) * 100
    : ((liqPrice - currentPrice) / currentPrice) * 100;

  log('manager',
    `${symbol} ${side.toUpperCase()} | price=${currentPrice} entry=${entryPrice} ` +
    `move=${pricePct.toFixed(2)}% (margin ${marginPct.toFixed(2)}%) | hold=${holdHours.toFixed(1)}h | ` +
    `BEP=${hasBEP ? 'YES' : 'no'} | trail=${trailingOn ? 'ON' : 'off'} | ` +
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

  // ── 2. TP1 — partial close → set BEP → aktifkan trailing ──────────────────
  if (!hasBEP) {
    const tp1Hit = side === 'long'
      ? currentPrice >= tp1Price
      : currentPrice <= tp1Price;

    if (tp1Hit) {
      log('manager', `🎯 TP1 hit: ${symbol} ${side} | price=${currentPrice} TP1=${tp1Price?.toFixed(6)} | Tutup ${tp1ClosePct}%, set BEP`);
      const result = await executePartialClose(symbol, side, { closePct: tp1ClosePct, reason: 'tp1_partial', position: pos });
      if (result.success) {
        setBEP(symbol, side);
        if (trailEnabled) {
          activateTrailing(symbol, side);
          // Mulai lacak peak dari harga saat TP1 (bukan dari entry)
          updatePeakPrice(symbol, side, currentPrice);
        }
        await notifyClose({ symbol, side, entryPrice, exitPrice: result.exitPrice, pnlPct: result.pnlPct, pnlUsdt: result.pnlUsdt, reason: 'tp1_partial', leverage });
        log('manager', `✅ TP1 done, BEP set, trailing ${trailEnabled ? 'aktif' : 'nonaktif (enabled=false)'}: ${symbol} ${side}`);
      }
      return;
    }
  }

  // ── 3. Aktivasi trailing lebih awal (HANYA jika activateAfterTP1 = false) ──
  if (trailEnabled && !afterTP1Only && !pos.trailingActive && !hasBEP && pricePct >= activateAtPct) {
    log('manager', `🔻 Trailing aktif early: ${symbol} ${side} | move=${pricePct.toFixed(2)}% >= ${activateAtPct}%`);
    activateTrailing(symbol, side);
    updatePeakPrice(symbol, side, currentPrice);
  }

  // ── 4. Trailing Stop ───────────────────────────────────────────────────────
  if (trailingOn) {
    updatePeakPrice(symbol, side, currentPrice);

    // Baca posisi terbaru setelah update peak
    const freshPos = getAllPositions()[pos.key];
    if (!freshPos) return;

    const peakPrice = freshPos.peakPrice;

    // Long: drop dari peak. Short: rise dari peak (peak = harga terendah)
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
