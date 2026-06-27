// ─── PATCH untuk index.js ────────────────────────────────────────────────────
// Ganti fungsi doManualLong dan doManualShort dengan versi yang support entryPrice
// opts: { entryPrice, slPrice, tp1Price }

export async function doManualLong(symbol, opts = {}) {
  const candidate = {
    symbol,
    side:       'long',
    strategy:   'manual',
    signals:    {},
    change24h:  0,
    entryPrice: opts.entryPrice || null,  // custom entry (limit simulation)
    slPrice:    opts.slPrice    || null,
    tp1Price:   opts.tp1Price   || null,
  };
  const result = await executeLong(candidate);
  if (result.success) {
    await notifyOpen({
      symbol,
      side:       'long',
      entryPrice: result.entryPrice,
      size:       result.size,
      leverage:   config.trading.leverage,
      margin:     config.trading.budgetPerTrade,
      slPrice:    result.slPrice,
      tp1Price:   result.tp1Price,
      liqPrice:   result.liqPrice,
      strategy:   'manual',
      change24h:  0,
    });
  }
  return result;
}

export async function doManualShort(symbol, opts = {}) {
  const candidate = {
    symbol,
    side:       'short',
    strategy:   'manual',
    signals:    {},
    change24h:  0,
    entryPrice: opts.entryPrice || null,
    slPrice:    opts.slPrice    || null,
    tp1Price:   opts.tp1Price   || null,
  };
  const result = await executeShort(candidate);
  if (result.success) {
    await notifyOpen({
      symbol,
      side:       'short',
      entryPrice: result.entryPrice,
      size:       result.size,
      leverage:   config.trading.leverage,
      margin:     config.trading.budgetPerTrade,
      slPrice:    result.slPrice,
      tp1Price:   result.tp1Price,
      liqPrice:   result.liqPrice,
      strategy:   'manual',
      change24h:  0,
    });
  }
  return result;
}
