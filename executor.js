/**
 * Executor — Futures Bot
 * Open / Close Long & Short positions di Bitget USDT-M Perpetual
 */
import {
  placeOrder, calcContractSize, calcLiquidationPrice,
  setLeverage, setMarginMode, getOrder, getCurrentPrice,
} from './bitgetFutures.js';
import { config }   from './config.js';
import { log }      from './logger.js';
import { logTrade } from './logger.js';
import {
  openPosition, closePosition, recordPartialClose,
  getPosition,
} from './state.js';

const isDryRun = process.env.DRY_RUN === 'true';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Setup leverage & margin mode sebelum order
// ─────────────────────────────────────────────────────────────────────────────
async function setupSymbol(symbol, leverage, marginMode) {
  if (isDryRun) return;
  try {
    await setMarginMode(symbol, marginMode === 'isolated' ? 'isolated' : 'crossed');
    await setLeverage(symbol, leverage);
    log('executor', `Setup ${symbol}: marginMode=${marginMode} leverage=${leverage}x`);
  } catch (err) {
    log('executor_warn', `Setup ${symbol} gagal (mungkin sudah set): ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN LONG
// ─────────────────────────────────────────────────────────────────────────────
export async function executeLong(candidate) {
  const { symbol, signals, strategy, slPrice: candidateSlPrice } = candidate;
  const cfg       = config.trading;
  const mgmt      = config.management;
  const leverage  = candidate.leverage ?? cfg.leverage ?? 5;
  const budget    = cfg.budgetPerTrade;
  const marginMode = cfg.marginMode ?? 'isolated';

  log('executor', `📈 OPEN LONG: ${symbol} | lev=${leverage}x | budget=${budget} USDT | mode=${marginMode}`);

  try {
    const { price, size, exposure } = await calcContractSize(symbol, budget, leverage);

    if (size <= 0) throw new Error('Contract size tidak valid');

    // SL & TP: pakai custom dari user jika ada, fallback ke config %
    const slPct    = mgmt.stopLossPct / 100;
    const tp1Pct   = mgmt.takeProfitPct / 100;
    const slPrice  = candidateSlPrice ?? price * (1 - slPct);
    const tp1Price = candidate.tp1Price ?? price * (1 + tp1Pct);
    const liqPrice = calcLiquidationPrice(price, leverage, 'long');

    if (isDryRun) {
      const slLabel  = candidateSlPrice ? '(custom)' : '(auto)';
      const tp1Label = candidate.tp1Price ? '(custom)' : '(auto)';
      log('executor', `[DRY RUN] LONG ${symbol} size=${size} @ ${price} | SL=${slPrice.toFixed(6)}${slLabel} TP1=${tp1Price.toFixed(6)}${tp1Label} Liq=${liqPrice.toFixed(6)}`);
      openPosition({ symbol, side: 'long', entryPrice: price, size, leverage, margin: budget, orderId: `dry_${Date.now()}`, slPrice, tp1Price, liqPrice, signals, strategy });
      logTrade({ side: 'open_long', symbol, qty: size, price, reason: strategy });
      return { success: true, side: 'long', entryPrice: price, size, slPrice, tp1Price, liqPrice };
    }

    await setupSymbol(symbol, leverage, marginMode);

    const order   = await placeOrder({ symbol, side: 'open_long', orderType: 'market', size });
    const orderId = order?.orderId;
    if (!orderId) throw new Error('Tidak ada orderId dari API');

    await sleep(1500);
    const detail    = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice = detail ? parseFloat(detail.priceAvg || detail.fillPrice || price) : price;
    const fillSize  = detail ? parseFloat(detail.baseVolume || detail.fillSize || size) : size;

    const finalSlPrice  = candidateSlPrice ?? fillPrice * (1 - slPct);
    const finalTp1Price = candidate.tp1Price ?? fillPrice * (1 + mgmt.takeProfitPct / 100);
    const finalLiqPrice = calcLiquidationPrice(fillPrice, leverage, 'long');

    openPosition({ symbol, side: 'long', entryPrice: fillPrice, size: fillSize, leverage, margin: budget, orderId, slPrice: finalSlPrice, tp1Price: finalTp1Price, liqPrice: finalLiqPrice, signals, strategy });
    logTrade({ side: 'open_long', symbol, qty: fillSize, price: fillPrice, reason: strategy });

    log('executor', `✅ LONG ${symbol} @ ${fillPrice} | size=${fillSize} | SL=${finalSlPrice.toFixed(4)} | TP1=${finalTp1Price.toFixed(4)} | Liq=${finalLiqPrice.toFixed(4)}`);
    return { success: true, side: 'long', entryPrice: fillPrice, size: fillSize, slPrice: finalSlPrice, tp1Price: finalTp1Price, liqPrice: finalLiqPrice };

  } catch (err) {
    log('executor_error', `OPEN LONG ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN SHORT
// ─────────────────────────────────────────────────────────────────────────────
export async function executeShort(candidate) {
  const { symbol, signals, strategy, slPrice: candidateSlPrice } = candidate;
  const cfg        = config.trading;
  const mgmt       = config.management;
  const leverage   = candidate.leverage ?? cfg.leverage ?? 5;
  const budget     = cfg.budgetPerTrade;
  const marginMode = cfg.marginMode ?? 'isolated';

  log('executor', `📉 OPEN SHORT: ${symbol} | lev=${leverage}x | budget=${budget} USDT | mode=${marginMode}`);

  try {
    const { price, size, exposure } = await calcContractSize(symbol, budget, leverage);

    if (size <= 0) throw new Error('Contract size tidak valid');

    // SL & TP: pakai custom dari user jika ada, fallback ke config %
    const slPct    = mgmt.stopLossPct / 100;
    const tp1Pct   = mgmt.takeProfitPct / 100;
    const slPrice  = candidateSlPrice ?? price * (1 + slPct);       // short: SL di atas entry
    const tp1Price = candidate.tp1Price ?? price * (1 - tp1Pct);    // short: TP di bawah entry
    const liqPrice = calcLiquidationPrice(price, leverage, 'short');

    if (isDryRun) {
      log('executor', `[DRY RUN] SHORT ${symbol} size=${size} @ ${price} | SL=${slPrice.toFixed(6)} TP1=${tp1Price.toFixed(6)} Liq=${liqPrice.toFixed(6)}`);
      openPosition({ symbol, side: 'short', entryPrice: price, size, leverage, margin: budget, orderId: `dry_${Date.now()}`, slPrice, tp1Price, liqPrice, signals, strategy });
      logTrade({ side: 'open_short', symbol, qty: size, price, reason: strategy });
      return { success: true, side: 'short', entryPrice: price, size, slPrice, tp1Price, liqPrice };
    }

    await setupSymbol(symbol, leverage, marginMode);

    const order   = await placeOrder({ symbol, side: 'open_short', orderType: 'market', size });
    const orderId = order?.orderId;
    if (!orderId) throw new Error('Tidak ada orderId dari API');

    await sleep(1500);
    const detail    = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice = detail ? parseFloat(detail.priceAvg || detail.fillPrice || price) : price;
    const fillSize  = detail ? parseFloat(detail.baseVolume || detail.fillSize || size) : size;

    const finalSlPrice  = candidateSlPrice ?? fillPrice * (1 + slPct);
    const finalTp1Price = candidate.tp1Price ?? fillPrice * (1 - mgmt.takeProfitPct / 100);
    const finalLiqPrice = calcLiquidationPrice(fillPrice, leverage, 'short');

    openPosition({ symbol, side: 'short', entryPrice: fillPrice, size: fillSize, leverage, margin: budget, orderId, slPrice: finalSlPrice, tp1Price: finalTp1Price, liqPrice: finalLiqPrice, signals, strategy });
    logTrade({ side: 'open_short', symbol, qty: fillSize, price: fillPrice, reason: strategy });

    log('executor', `✅ SHORT ${symbol} @ ${fillPrice} | size=${fillSize} | SL=${finalSlPrice.toFixed(4)} | TP1=${finalTp1Price.toFixed(4)} | Liq=${finalLiqPrice.toFixed(4)}`);
    return { success: true, side: 'short', entryPrice: fillPrice, size: fillSize, slPrice: finalSlPrice, tp1Price: finalTp1Price, liqPrice: finalLiqPrice };

  } catch (err) {
    log('executor_error', `OPEN SHORT ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOSE POSITION (long atau short)
// ─────────────────────────────────────────────────────────────────────────────
export async function executeClose(symbol, side, { reason, position }) {
  const closeSide = side === 'long' ? 'close_long' : 'close_short';

  try {
    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error(`Tidak bisa ambil harga ${symbol}`);

    log('executor', `🔒 CLOSE ${side.toUpperCase()}: ${symbol} @ ${currentPrice} | reason=${reason}`);

    if (isDryRun) {
      const closed = closePosition(symbol, side, { exitPrice: currentPrice, reason });
      logTrade({ side: closeSide, symbol, qty: position.size, price: currentPrice, reason });
      return { success: true, exitPrice: currentPrice, pnlPct: closed?.pnlPct, pnlUsdt: closed?.pnlUsdt };
    }

    const order   = await placeOrder({ symbol, side: closeSide, orderType: 'market', size: position.size, reduceOnly: true });
    const orderId = order?.orderId;
    await sleep(1500);
    const detail    = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice = detail ? parseFloat(detail.priceAvg || detail.fillPrice || currentPrice) : currentPrice;

    const closed = closePosition(symbol, side, { exitPrice: fillPrice, reason });
    logTrade({ side: closeSide, symbol, qty: position.size, price: fillPrice, reason });

    log('executor', `✅ CLOSE ${side.toUpperCase()} ${symbol} @ ${fillPrice} | PnL=${closed?.pnlPct?.toFixed(2)}%`);
    return { success: true, exitPrice: fillPrice, pnlPct: closed?.pnlPct, pnlUsdt: closed?.pnlUsdt };

  } catch (err) {
    log('executor_error', `CLOSE ${side.toUpperCase()} ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTIAL CLOSE
// ─────────────────────────────────────────────────────────────────────────────
export async function executePartialClose(symbol, side, { closePct, reason, position }) {
  const closeSize = Math.floor(position.size * (closePct / 100) * 10000) / 10000;
  if (closeSize <= 0) return { success: false, error: 'Partial size terlalu kecil' };

  const closeSide = side === 'long' ? 'close_long' : 'close_short';

  try {
    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error('Harga tidak valid');

    log('executor', `🔒 PARTIAL CLOSE ${side.toUpperCase()}: ${symbol} ${closePct}% (${closeSize}) @ ${currentPrice}`);

    if (isDryRun) {
      recordPartialClose(symbol, side, { closeSize, price: currentPrice, reason });
      logTrade({ side: closeSide, symbol, qty: closeSize, price: currentPrice, reason: `partial-${reason}` });
      return { success: true, exitPrice: currentPrice, closeSize };
    }

    const order   = await placeOrder({ symbol, side: closeSide, orderType: 'market', size: closeSize, reduceOnly: true });
    await sleep(1500);
    const detail    = await getOrder(order?.orderId, symbol).catch(() => null);
    const fillPrice = detail ? parseFloat(detail.priceAvg || currentPrice) : currentPrice;

    recordPartialClose(symbol, side, { closeSize, price: fillPrice, reason });
    logTrade({ side: closeSide, symbol, qty: closeSize, price: fillPrice, reason: `partial-${reason}` });

    return { success: true, exitPrice: fillPrice, closeSize };

  } catch (err) {
    log('executor_error', `PARTIAL CLOSE ${symbol} ${side} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}
