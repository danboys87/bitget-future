/**
 * Screener Long — Gainer ≥5% → UTBot BUY Signal (1H)
 * Untuk entry LONG di futures
 */
import { getAllTickers, getCandles } from './bitgetFutures.js';
import { calcUTBot, calcEMA }        from './indicators.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';
import { filterCryptoOnly }          from './symbolFilter.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _sentSignals = new Map();

function signalKey(symbol, ts) { return `${symbol}_BUY_${ts}`; }

async function is1HBullish(symbol) {
  try {
    const raw = await getCandles(symbol, '1H', 60);
    if (!Array.isArray(raw) || raw.length < 25) return true;
    const now = Date.now(), ps = now - (now % 3600000);
    const closed = raw.filter(c => parseInt(c[0]) < ps).sort((a,b) => parseInt(a[0]) - parseInt(b[0]));
    if (closed.length < 22) return true;
    const closes = closed.map(c => parseFloat(c[4]));
    const ema21  = calcEMA(closes, 21);
    return ema21 ? closes[closes.length-1] > ema21 : true;
  } catch { return true; }
}

async function scanUTBot(symbol, cfg) {
  const { keyValue, atrPeriod, filter1H_EMA21 } = cfg;
  try {
    const raw = await getCandles(symbol, '1H', Math.max(atrPeriod * 3 + 20, 60));
    if (!Array.isArray(raw) || raw.length < atrPeriod + 10) return null;
    const now = Date.now(), ps = now - (now % 3600000);
    const closed = raw.filter(c => parseInt(c[0]) < ps).sort((a,b) => parseInt(a[0]) - parseInt(b[0]));
    if (closed.length < atrPeriod + 5) return null;

    const highs  = closed.map(c => parseFloat(c[2]));
    const lows   = closed.map(c => parseFloat(c[3]));
    const closes = closed.map(c => parseFloat(c[4]));
    const lastTs = parseInt(closed[closed.length-1][0]);

    const result = calcUTBot(highs, lows, closes, keyValue, atrPeriod);
    if (!result || result.signal !== 'BUY') return null;

    const key = signalKey(symbol, lastTs);
    if (_sentSignals.has(key)) return null;

    if (filter1H_EMA21 !== false && !await is1HBullish(symbol)) return null;

    _sentSignals.set(key, Date.now());
    // Bersihkan cache lama
    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) { if (ts < cutoff) _sentSignals.delete(k); }

    const slBuffer = config.management?.slBuffer ?? 0.003;
    const slPrice  = result.trailingStop * (1 - slBuffer);
    const ema21_1H = calcEMA(closes, 21);

    return {
      trailingStop: result.trailingStop,
      atr:          result.atr,
      close:        result.close,
      slPrice,
      ema21_1H,
      lastTs,
    };
  } catch (err) {
    log('screener_error', `UTBot scan ${symbol}: ${err.message}`);
    return null;
  }
}

export async function runLongScreener() {
  const sc         = config.screening;
  const longCfg    = sc.long ?? {};
  const utbotCfg   = sc.utbot ?? {};
  const quoteAsset = config.trading.quoteAsset || 'USDT';
  const minGainPct = longCfg.minGainPct   ?? 5;
  const maxGainPct = longCfg.maxGainPct   ?? 20;
  const minVolUsdt = longCfg.minVolume24h ?? sc.minVolume24h ?? 10_000_000;
  const checkLimit = longCfg.checkLimit   ?? 200;
  const maxSignals = utbotCfg.maxSignalsPerRun ?? 5;
  const keyValue   = utbotCfg.keyValue   ?? 2;
  const atrPeriod  = utbotCfg.atrPeriod  ?? 10;
  const filter1H   = utbotCfg.filter1H_EMA21 !== false;

  log('screener', `══ LONG Screener (Gainer ${minGainPct}-${maxGainPct}% → UTBot BUY) ══`);

  let tickers;
  try { tickers = await getAllTickers(); }
  catch (err) { log('screener_error', `Gagal ambil ticker: ${err.message}`); return []; }

  // Filter crypto only
  const cryptoTickers = await filterCryptoOnly(tickers);

  // Step 1: Filter gainer
  const gainers = cryptoTickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))       return false;
      if (config.blacklist?.includes(t.symbol)) return false;
      if (hasPosition(t.symbol, 'long'))         return false;
      if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVolUsdt) return false;
      return true;
    })
    .map(t => {
      const raw = parseFloat(t.change24h || 0);
      const change24h = Math.abs(raw) < 1.5 && Math.abs(raw) > 0 ? raw * 100 : raw;
      return {
        symbol:    t.symbol,
        change24h,
        lastPrice: parseFloat(t.lastPr || t.last || 0),
        vol24h:    parseFloat(t.usdtVol || t.quoteVolume || 0),
      };
    })
    .filter(t => t.change24h >= minGainPct && t.change24h <= maxGainPct)
    .sort((a, b) => b.change24h - a.change24h)
    .slice(0, checkLimit);

  log('screener', `Gainer ≥${minGainPct}%: ${gainers.length} koin → scan UTBot BUY...`);

  // Step 2: Scan UTBot BUY signal
  const candidates = [];

  for (let i = 0; i < gainers.length; i++) {
    const coin   = gainers[i];
    const utbot  = await scanUTBot(coin.symbol, { keyValue, atrPeriod, filter1H_EMA21: filter1H });

    if (utbot) {
      log('screener', `  ✅ LONG candidate: ${coin.symbol} +${coin.change24h.toFixed(2)}% | TS=${utbot.trailingStop.toFixed(6)}`);
      candidates.push({
        symbol:       coin.symbol,
        side:         'long',
        signal:       'BUY',
        lastPrice:    coin.lastPrice,
        change24h:    coin.change24h,
        vol24h:       coin.vol24h,
        slPrice:      utbot.slPrice,
        trailingStop: utbot.trailingStop,
        atr:          utbot.atr,
        strategy:     'gainerUTBot_long',
        triggered:    true,
        signals: {
          gainerFilter: { bullish: true, label: `Gainer 24h: +${coin.change24h.toFixed(2)}%` },
          utbotBuy:     { bullish: true, label: `UTBot BUY | TS=${utbot.trailingStop.toFixed(6)} | ATR=${utbot.atr.toFixed(6)}` },
          ema21_1H:     { bullish: true, label: utbot.ema21_1H ? `Close > EMA21 1H ${utbot.ema21_1H.toFixed(6)}` : 'EMA21 1H OK' },
        },
        score: coin.change24h + (coin.vol24h / 1e7),
      });

      if (candidates.length >= maxSignals) break;
    }

    if (i % 10 === 9) await sleep(500); else await sleep(150);
  }

  log('screener', `Long screener selesai → ${candidates.length} kandidat LONG`);
  return candidates;
}
