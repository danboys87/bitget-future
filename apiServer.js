/**
 * API Server — Futures Bot Dashboard
 * Port default: 3001
 */
import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log }           from './logger.js';
import { getCurrentPrice } from './bitgetFutures.js';
import { getAllPositions, getStats } from './state.js';
import { config, saveConfig }       from './config.js';
import { getPendingQueue }          from './approvalQueue.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = parseInt(process.env.DASHBOARD_PORT || '3001');
const API_SECRET = process.env.DASHBOARD_SECRET || '';

let _callbacks = {};
export function setApiCallbacks(cb) { _callbacks = cb; }

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,X-Secret',
  });
  res.end(JSON.stringify(data));
}
function err(res, msg, status = 400) { json(res, { ok: false, error: msg }, status); }
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function checkAuth(req) {
  if (!API_SECRET) return true;
  return req.headers['x-secret'] === API_SECRET;
}
function tailLog(lines = 150) {
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const logFile = path.join(__dirname, 'logs', `bot-${today}.log`);
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-lines);
  } catch { return []; }
}
function getClosedTrades() {
  try {
    const dir = path.join(__dirname, 'logs');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.startsWith('trades-') && f.endsWith('.jsonl')).sort().reverse();
    const trades = [];
    for (const f of files.slice(0, 7)) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines) { try { trades.push(JSON.parse(l)); } catch {} }
    }
    return trades.sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 200);
  } catch { return []; }
}

async function handle(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const route  = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Secret' });
    res.end(); return;
  }
  if (method === 'POST' && !checkAuth(req)) { err(res, 'Unauthorized', 401); return; }

  // ── GET /api/status ────────────────────────────────────────────────────────
  if (route === '/api/status' && method === 'GET') {
    const stats     = getStats();
    const positions = getAllPositions();
    const pending   = getPendingQueue();

    const enriched = {};
    for (const [key, pos] of Object.entries(positions)) {
      const price = await getCurrentPrice(pos.symbol).catch(() => null);
      let pnlPct = null, pnlUsdt = null;
      if (price) {
        const diff = pos.side === 'long' ? price - pos.entryPrice : pos.entryPrice - price;
        pnlPct  = (diff / pos.entryPrice) * 100 * pos.leverage;
        pnlUsdt = (diff / pos.entryPrice) * pos.margin * pos.leverage;
      }
      const liqDist = pos.liqPrice && price ? (
        pos.side === 'long'
          ? ((price - pos.liqPrice) / price) * 100
          : ((pos.liqPrice - price) / price) * 100
      ) : null;
      enriched[key] = { ...pos, currentPrice: price, pnlPct, pnlUsdt, liqDist };
    }

    json(res, {
      ok: true,
      stats,
      positions: enriched,
      pending: pending.map(p => ({
        key:       p.key,
        symbol:    p.symbol,
        side:      p.side,
        minsLeft:  p.minsLeft,
        lastPrice: p.candidate.lastPrice,
        change24h: p.candidate.change24h,
        vol24h:    p.candidate.vol24h,
        slPrice:   p.candidate.slPrice,
        signals:   p.candidate.signals,
        strategy:  p.candidate.strategy,
      })),
      config: {
        leverage:            config.trading.leverage,
        marginMode:          config.trading.marginMode,
        budgetPerTrade:      config.trading.budgetPerTrade,
        maxOpenPositions:    config.trading.maxOpenPositions,
        maxLongPositions:    config.trading.maxLongPositions,
        maxShortPositions:   config.trading.maxShortPositions,
        autoExecute:         config.trading.autoExecute !== false,
        approvalTimeoutMin:  config.trading.approvalTimeoutMin ?? 30,
        takeProfitPct:       config.management.takeProfitPct,
        stopLossPct:         config.management.stopLossPct,
        trailPct:            config.management.trailingStop?.trailPct,
        isDryRun:            process.env.DRY_RUN === 'true',
      },
      serverTime: new Date().toISOString(),
    });
    return;
  }

  // ── GET /api/history ───────────────────────────────────────────────────────
  if (route === '/api/history' && method === 'GET') {
    json(res, { ok: true, trades: getClosedTrades() }); return;
  }

  // ── GET /api/logs ──────────────────────────────────────────────────────────
  if (route === '/api/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('n') || '150');
    json(res, { ok: true, logs: tailLog(n) }); return;
  }

  // ── GET /api/price/:symbol ─────────────────────────────────────────────────
  if (route.startsWith('/api/price/') && method === 'GET') {
    const symbol = route.split('/').pop().toUpperCase();
    const price  = await getCurrentPrice(symbol).catch(() => null);
    json(res, { ok: true, symbol, price }); return;
  }

  // ── GET /api/config ────────────────────────────────────────────────────────
  if (route === '/api/config' && method === 'GET') {
    json(res, { ok: true, config }); return;
  }

  // ── POST /api/config ───────────────────────────────────────────────────────
  if (route === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    try { saveConfig(body); json(res, { ok: true, config }); }
    catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/mode ─────────────────────────────────────────────────────────
  // Toggle auto/manual mode tanpa restart bot
  if (route === '/api/mode' && method === 'POST') {
    const { autoExecute } = await readBody(req);
    if (typeof autoExecute !== 'boolean') { err(res, 'autoExecute must be boolean'); return; }
    _callbacks.setAutoExecute?.(autoExecute);
    // Simpan ke config file juga
    saveConfig({ trading: { autoExecute } });
    log('api_server', `Execute mode → ${autoExecute ? 'AUTO' : 'MANUAL'}`);
    json(res, { ok: true, autoExecute, message: `Mode diubah ke ${autoExecute ? 'AUTO' : 'MANUAL'}` });
    return;
  }

  // ── POST /api/open ─────────────────────────────────────────────────────────
  // Manual open posisi dari dashboard, support custom SL & TP1
  if (route === '/api/open' && method === 'POST') {
    const body = await readBody(req);
    const { symbol, side } = body;
    if (!symbol || !side) { err(res, 'symbol dan side required'); return; }
    if (!['long', 'short'].includes(side.toLowerCase())) { err(res, 'side harus long atau short'); return; }
    try {
      const opts = {
        slPrice:  body.slPrice  ? parseFloat(body.slPrice)  : null,
        tp1Price: body.tp1Price ? parseFloat(body.tp1Price) : null,
      };
      const result = side.toLowerCase() === 'long'
        ? await _callbacks.doManualLong?.(symbol.toUpperCase(), opts)
        : await _callbacks.doManualShort?.(symbol.toUpperCase(), opts);
      json(res, result?.success ? { ok: true, ...result } : { ok: false, error: result?.error });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/close ────────────────────────────────────────────────────────
  if (route === '/api/close' && method === 'POST') {
    const { symbol, side } = await readBody(req);
    if (!symbol || !side) { err(res, 'symbol dan side required'); return; }
    try {
      const result = await _callbacks.executeCloseManual?.(symbol.toUpperCase(), side.toLowerCase());
      json(res, result?.success ? { ok: true } : { ok: false, error: result?.error });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/approve ──────────────────────────────────────────────────────
  if (route === '/api/approve' && method === 'POST') {
    const { symbol, side } = await readBody(req);
    if (!symbol || !side) { err(res, 'symbol dan side required'); return; }
    try {
      const result = await _callbacks.doApprove?.(symbol.toUpperCase(), side.toLowerCase());
      json(res, result ?? { ok: false, error: 'Callback tidak tersedia' });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/skip ─────────────────────────────────────────────────────────
  if (route === '/api/skip' && method === 'POST') {
    const { symbol, side } = await readBody(req);
    if (!symbol || !side) { err(res, 'symbol dan side required'); return; }
    const result = _callbacks.doSkip?.(symbol.toUpperCase(), side.toLowerCase()) ?? { ok: false };
    json(res, result); return;
  }

  // ── POST /api/screen ───────────────────────────────────────────────────────
  if (route === '/api/screen' && method === 'POST') {
    const { side = 'both' } = await readBody(req);
    json(res, { ok: true, message: `Screening ${side} dimulai` });
    if (side === 'long')       _callbacks.doLongScreening?.().catch(() => {});
    else if (side === 'short') _callbacks.doShortScreening?.().catch(() => {});
    else                       _callbacks.doScreening?.().catch(() => {});
    return;
  }

  // ── POST /api/manage ───────────────────────────────────────────────────────
  if (route === '/api/manage' && method === 'POST') {
    json(res, { ok: true, message: 'Management cycle dimulai' });
    _callbacks.doManagement?.().catch(() => {});
    return;
  }

  json(res, { ok: false, error: 'Route tidak ditemukan' }, 404);
}

export function startApiServer(callbacks) {
  setApiCallbacks(callbacks);
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); }
    catch (e) { err(res, e.message, 500); }
  });
  server.listen(PORT, () => {
    log('api_server', `✅ Futures Dashboard API → http://localhost:${PORT}`);
  });
  return server;
}
