/**
 * Technical Indicators — sama persis dengan spot bot
 * RSI, EMA, MACD, Bollinger Bands, ADX, ATR, UT Bot Alert
 */

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0  ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

export function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

export function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;
  const k_fast = 2 / (fastPeriod + 1), k_slow = 2 / (slowPeriod + 1), k_signal = 2 / (signalPeriod + 1);
  let emaFast = closes.slice(0, fastPeriod).reduce((a, b) => a + b, 0) / fastPeriod;
  let emaSlow = closes.slice(0, slowPeriod).reduce((a, b) => a + b, 0) / slowPeriod;
  const macdLine = [];
  for (let i = slowPeriod; i < closes.length; i++) {
    emaFast = closes[i] * k_fast + emaFast * (1 - k_fast);
    emaSlow = closes[i] * k_slow + emaSlow * (1 - k_slow);
    macdLine.push(emaFast - emaSlow);
  }
  if (macdLine.length < signalPeriod) return null;
  let signal = macdLine.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < macdLine.length; i++) signal = macdLine[i] * k_signal + signal * (1 - k_signal);
  const macdValue = macdLine[macdLine.length - 1];
  return { macd: macdValue, signal, histogram: macdValue - signal };
}

export function calcBollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const sd    = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  const upper = mean + stdDev * sd, lower = mean - stdDev * sd;
  const price = closes[closes.length - 1];
  return { upper, middle: mean, lower, pctB: sd > 0 ? (price - lower) / (upper - lower) : 0.5 };
}

export function calcATR(highs, lows, closes, period = 10) {
  if (highs.length < period + 1) return null;
  const trArr = [];
  for (let i = 1; i < highs.length; i++) {
    trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  let atr = trArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const atrArr = new Array(period).fill(null);
  atrArr.push(atr);
  for (let i = period; i < trArr.length; i++) { atr = (atr * (period - 1) + trArr[i]) / period; atrArr.push(atr); }
  return atrArr;
}

export function calcADX(highs, lows, closes, period = 14) {
  if (highs.length < period * 2) return null;
  const trArr = [], plusDMArr = [], minusDMArr = [];
  for (let i = 1; i < highs.length; i++) {
    const highDiff = highs[i] - highs[i-1], lowDiff = lows[i-1] - lows[i];
    plusDMArr.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDMArr.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  let atr = trArr.slice(0, period).reduce((a,b)=>a+b,0);
  let plusDI = plusDMArr.slice(0, period).reduce((a,b)=>a+b,0);
  let minDI  = minusDMArr.slice(0, period).reduce((a,b)=>a+b,0);
  const dxArr = [];
  for (let i = period; i < trArr.length; i++) {
    atr += trArr[i] - atr/period; plusDI += plusDMArr[i] - plusDI/period; minDI += minusDMArr[i] - minDI/period;
    const pDI = atr > 0 ? (plusDI/atr)*100 : 0, mDI = atr > 0 ? (minDI/atr)*100 : 0;
    dxArr.push({ dx: (pDI+mDI) > 0 ? Math.abs(pDI-mDI)/(pDI+mDI)*100 : 0, pDI, mDI });
  }
  if (dxArr.length < period) return null;
  let adx = dxArr.slice(0, period).reduce((s,d)=>s+d.dx,0) / period;
  for (let i = period; i < dxArr.length; i++) adx = (adx*(period-1)+dxArr[i].dx)/period;
  const last = dxArr[dxArr.length-1];
  return { adx, plusDI: last.pDI, minusDI: last.mDI };
}

export function calcUTBot(highs, lows, closes, keyValue = 1, atrPeriod = 10) {
  if (closes.length < atrPeriod + 5) return null;
  const atrArr = calcATR(highs, lows, closes, atrPeriod);
  if (!atrArr) return null;
  const startIdx = atrArr.findIndex(v => v !== null);
  if (startIdx === -1) return null;
  const stops = new Array(closes.length).fill(null);
  stops[startIdx] = closes[startIdx] - atrArr[startIdx] * keyValue;
  for (let i = startIdx + 1; i < closes.length; i++) {
    const atr = atrArr[i];
    if (!atr) { stops[i] = stops[i-1]; continue; }
    const nLoss = atr * keyValue, close = closes[i], prevStop = stops[i-1] ?? (close - nLoss);
    stops[i] = close > prevStop ? Math.max(prevStop, close - nLoss) : Math.min(prevStop, close + nLoss);
  }
  const lastIdx = closes.length - 1, prevIdx = closes.length - 2;
  const close = closes[lastIdx], prevClose = closes[prevIdx];
  const stop = stops[lastIdx], prevStop = stops[prevIdx];
  const atr = atrArr[lastIdx];
  if (!stop || !prevStop || !atr) return null;
  let signal = null;
  if (prevClose <= prevStop && close > stop) signal = 'BUY';
  if (prevClose >= prevStop && close < stop) signal = 'SELL';
  return { signal, trailingStop: stop, prevStop, atr, close, prevClose, nLoss: atr * keyValue };
}
