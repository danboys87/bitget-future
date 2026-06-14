/**
 * Screener Short — UTBot SELL Signal (1H) untuk entry SHORT
 * Cari koin yang turun 3-20% (bearish momentum) + UTBot SELL signal
 */
import { getAllTickers, getCandles } from './bitgetFutures.js';
import { calcUTBot, calcEMA }        from './indicators.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';
import { filterCryptoOnly }          from './symbolFilter.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _sentSignals = new Map();

function signalKey(symbol, ts) { return `${symbol}_SELL_${ts}`; }

// Konfirmasi bearish: close < EMA21 1H
async function is1HBearish(symbol) {
  try {
    const raw = await getCandles(symbol, '1H', 60);
    if (!Array.isArray(raw) || raw.length < 25) return true;
    const now = Date.now(), ps = now - (now % 3600000);
    const closed = raw.filter(c => parseInt(c[0]) < ps).sort((a,b) => parseInt(a[0]) - parseInt(b[0]));
    if (closed.length < 22) return true;
    const closes = closed.map(c => parseFloat(c[4]));
    const ema21  = calcEMA(closes, 21);
    return ema21 ? closes[closes.length-1] < ema21 : true;
  } catch { return true; }
}

async function scanUTBotSell(symbol, cfg) {
  const { keyValue, atrPeriod } = cfg;
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
    if (!result || result.signal !== 'SELL') return null;

    const key = signalKey(symbol, lastTs);
    if (_sentSignals.has(key)) return null;

    // Filter bearish 1H
    if (!await is1HBearish(symbol)) {
      log('screener', `  ${symbol} SELL signal tapi 1H masih bullish → difilter`);
      return null;
    }

    _sentSignals.set(key, Date.now());
    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) { if (ts < cutoff) _sentSignals.delete(k); }

    // Short SL: trailing stop + buffer (di atas entry untuk short)
    const slBuffer = config.management?.slBuffer ?? 0.003;
    const slPrice  = result.trailingStop * (1 + slBuffer);
    const ema21_1H = calcEMA(closes, 21);

    return {
      trailingStop: result.trailingStop,
      atr:          result.atr,
      close:        result.close,
      slPrice,      // SL di atas entry (short)
      ema21_1H,
      lastTs,
    };
  } catch (err) {
    log('screener_error', `UTBot SELL scan ${symbol}: ${err.message}`);
    return null;
  }
}

export async function runShortScreener() {
  const sc         = config.screening;
  const shortCfg   = sc.short ?? {};
  const utbotCfg   = sc.utbot ?? {};
  const quoteAsset = config.trading.quoteAsset || 'USDT';
  const minLossPct = shortCfg.minLossPct  ?? 3;
  const maxLossPct = shortCfg.maxLossPct  ?? 20;
  const minVolUsdt = shortCfg.minVolume24h ?? sc.minVolume24h ?? 10_000_000;
  const checkLimit = shortCfg.checkLimit  ?? 200;
  const maxSignals = utbotCfg.maxSignalsPerRun ?? 5;
  const keyValue   = utbotCfg.keyValue   ?? 2;
  const atrPeriod  = utbotCfg.atrPeriod  ?? 10;

  log('screener', `══ SHORT Screener (Losers ${minLossPct}-${maxLossPct}% → UTBot SELL) ══`);

  let tickers;
  try { tickers = await getAllTickers(); }
  catch (err) { log('screener_error', `Gagal ambil ticker: ${err.message}`); return []; }

  const cryptoTickers = await filterCryptoOnly(tickers);

  // Filter koin yang turun (bearish momentum)
  const losers = cryptoTickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))       return false;
      if (config.blacklist?.includes(t.symbol)) return false;
      if (hasPosition(t.symbol, 'short'))        return false;
      if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVolUsdt) return false;
      return true;
    })
    .map(t => {
      const raw = parseFloat(t.change24h || 0);
      const change24h = Math.abs(raw) < 1.5 && Math.abs(raw) > 0 ? raw * 100 : raw;
      return {
        symbol:    t.symbol,
        change24h, // negatif untuk yang turun
        lastPrice: parseFloat(t.lastPr || t.last || 0),
        vol24h:    parseFloat(t.usdtVol || t.quoteVolume || 0),
      };
    })
    .filter(t => t.change24h <= -minLossPct && t.change24h >= -maxLossPct)
    .sort((a, b) => a.change24h - b.change24h) // sort yang paling turun dulu
    .slice(0, checkLimit);

  log('screener', `Losers ≤-${minLossPct}%: ${losers.length} koin → scan UTBot SELL...`);

  const candidates = [];

  for (let i = 0; i < losers.length; i++) {
    const coin  = losers[i];
    const utbot = await scanUTBotSell(coin.symbol, { keyValue, atrPeriod });

    if (utbot) {
      log('screener', `  ✅ SHORT candidate: ${coin.symbol} ${coin.change24h.toFixed(2)}% | TS=${utbot.trailingStop.toFixed(6)}`);
      candidates.push({
        symbol:       coin.symbol,
        side:         'short',
        signal:       'SELL',
        lastPrice:    coin.lastPrice,
        change24h:    coin.change24h,
        vol24h:       coin.vol24h,
        slPrice:      utbot.slPrice,    // SL di atas entry
        trailingStop: utbot.trailingStop,
        atr:          utbot.atr,
        strategy:     'utbot_short',
        triggered:    true,
        signals: {
          loserFilter: { bullish: false, label: `Bearish 24h: ${coin.change24h.toFixed(2)}%` },
          utbotSell:   { bullish: false, label: `UTBot SELL | TS=${utbot.trailingStop.toFixed(6)} | ATR=${utbot.atr.toFixed(6)}` },
          ema21_1H:    { bullish: false, label: utbot.ema21_1H ? `Close < EMA21 1H ${utbot.ema21_1H.toFixed(6)}` : 'EMA21 1H bearish' },
        },
        score: Math.abs(coin.change24h) + (coin.vol24h / 1e7),
      });

      if (candidates.length >= maxSignals) break;
    }

    if (i % 10 === 9) await sleep(500); else await sleep(150);
  }

  log('screener', `Short screener selesai → ${candidates.length} kandidat SHORT`);
  return candidates;
}
