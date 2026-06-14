/**
 * Bitget Futures Bot v1.0 — USDT-M Perpetual
 * Long & Short | Gainer+UTBot Pipeline | Auto / Manual Execute
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
dotenv.config();

import cron     from 'node-cron';
import readline from 'readline';
import { log }               from './logger.js';
import { config }            from './config.js';
import { testConnection, getCurrentPrice, getAllTickers } from './bitgetFutures.js';
import { runLongScreener }   from './screenerLong.js';
import { runShortScreener }  from './screenerShort.js';
import { runManagementCycle } from './manager.js';
import { executeLong, executeShort, executeClose } from './executor.js';
import { initState, getStats, getAllPositions, getLongPositions, getShortPositions } from './state.js';
import { initSymbolFilter }  from './symbolFilter.js';
import {
  notifyStartup, notifyOpen, notifyScreening,
  notifyStats, notifyError, notifyApprovalRequest,
} from './telegram.js';
import { startTelegramPolling, stopTelegramPolling } from './telegramCommands.js';
import { startApiServer }    from './apiServer.js';
import {
  addToQueue, approveCandidate, skipCandidate, getPendingQueue,
} from './approvalQueue.js';

const isDryRun = process.env.DRY_RUN === 'true';
const args     = process.argv.slice(2);

let _screenBusy = false;
let _manageBusy = false;
let _cronTasks  = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function intervalToCron(minutes) {
  if (minutes <= 0) minutes = 60;
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return `0 * * * *`;
  return `0 */${Math.floor(minutes / 60)} * * *`;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTE helper — auto atau masuk queue
// ─────────────────────────────────────────────────────────────────────────────
async function executeOrQueue(candidate) {
  const isAuto     = config.trading.autoExecute !== false;
  const timeoutMin = config.trading.approvalTimeoutMin ?? 30;

  if (isAuto) {
    // Auto-execute langsung
    const result = candidate.side === 'long'
      ? await executeLong(candidate)
      : await executeShort(candidate);

    if (result.success) {
      await notifyOpen({
        symbol:     candidate.symbol,
        side:       candidate.side,
        entryPrice: result.entryPrice,
        size:       result.size,
        leverage:   config.trading.leverage,
        margin:     config.trading.budgetPerTrade,
        slPrice:    result.slPrice,
        tp1Price:   result.tp1Price,
        liqPrice:   result.liqPrice,
        strategy:   candidate.strategy,
        change24h:  candidate.change24h,
      });
    } else {
      await notifyError(`${candidate.side.toUpperCase()} ${candidate.symbol} gagal: ${result.error}`);
    }
  } else {
    // Manual mode — masuk approval queue + kirim notif
    const added = addToQueue(candidate, timeoutMin);
    if (added) {
      await notifyApprovalRequest({ candidate, timeoutMin });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROVE (dipanggil dari Telegram /approve)
// ─────────────────────────────────────────────────────────────────────────────
export async function doApprove(symbol, side) {
  const result = approveCandidate(symbol, side);
  if (!result.ok) return result;

  const candidate = result.candidate;
  const execResult = side === 'long'
    ? await executeLong(candidate)
    : await executeShort(candidate);

  if (execResult.success) {
    await notifyOpen({
      symbol:     candidate.symbol,
      side:       candidate.side,
      entryPrice: execResult.entryPrice,
      size:       execResult.size,
      leverage:   config.trading.leverage,
      margin:     config.trading.budgetPerTrade,
      slPrice:    execResult.slPrice,
      tp1Price:   execResult.tp1Price,
      liqPrice:   execResult.liqPrice,
      strategy:   candidate.strategy,
      change24h:  candidate.change24h,
    });
    return { ok: true };
  } else {
    return { ok: false, reason: execResult.error };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LONG SCREENING
// ─────────────────────────────────────────────────────────────────────────────
export async function doLongScreening() {
  if (_screenBusy) { log('cron', 'Screening busy, skip LONG'); return []; }
  _screenBusy = true;
  try {
    const openLong = getLongPositions().length;
    const maxLong  = config.trading.maxLongPositions ?? 3;
    const slotLeft = maxLong - openLong;

    if (slotLeft <= 0) {
      log('screener', `Skip LONG: slot penuh (${openLong}/${maxLong})`);
      return [];
    }

    const candidates = await runLongScreener();
    await notifyScreening({ found: candidates.length, side: 'long', symbols: candidates.map(c => c.symbol) });
    if (!candidates.length) return [];

    const isAuto = config.trading.autoExecute !== false;
    log('screener', `Mode: ${isAuto ? '⚡ AUTO-EXECUTE' : '📋 MANUAL APPROVAL'} | ${candidates.length} kandidat LONG`);

    const toProcess = candidates.slice(0, slotLeft);
    for (const candidate of toProcess) {
      await executeOrQueue(candidate);
      await sleep(1000);
    }

    return candidates;
  } catch (err) {
    log('cron_error', `Long screening error: ${err.message}`);
    await notifyError(`Long screening error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHORT SCREENING
// ─────────────────────────────────────────────────────────────────────────────
export async function doShortScreening() {
  if (_screenBusy) { log('cron', 'Screening busy, skip SHORT'); return []; }
  _screenBusy = true;
  try {
    const openShort = getShortPositions().length;
    const maxShort  = config.trading.maxShortPositions ?? 3;
    const slotLeft  = maxShort - openShort;

    if (slotLeft <= 0) {
      log('screener', `Skip SHORT: slot penuh (${openShort}/${maxShort})`);
      return [];
    }

    const candidates = await runShortScreener();
    await notifyScreening({ found: candidates.length, side: 'short', symbols: candidates.map(c => c.symbol) });
    if (!candidates.length) return [];

    const isAuto = config.trading.autoExecute !== false;
    log('screener', `Mode: ${isAuto ? '⚡ AUTO-EXECUTE' : '📋 MANUAL APPROVAL'} | ${candidates.length} kandidat SHORT`);

    const toProcess = candidates.slice(0, slotLeft);
    for (const candidate of toProcess) {
      await executeOrQueue(candidate);
      await sleep(1000);
    }

    return candidates;
  } catch (err) {
    log('cron_error', `Short screening error: ${err.message}`);
    await notifyError(`Short screening error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}

export async function doScreening() {
  log('screener', '🔍 Menjalankan Long + Short screening...');
  await doLongScreening();
  await sleep(2000);
  await doShortScreening();
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL TRADE
// ─────────────────────────────────────────────────────────────────────────────
export async function doManualLong(symbol, opts = {}) {
  const candidate = {
    symbol,
    side:      'long',
    strategy:  'manual',
    signals:   {},
    change24h: 0,
    slPrice:   opts.slPrice  || null,  // custom SL dari user
    tp1Price:  opts.tp1Price || null,  // custom TP dari user
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
    side:      'short',
    strategy:  'manual',
    signals:   {},
    change24h: 0,
    slPrice:   opts.slPrice  || null,  // custom SL dari user
    tp1Price:  opts.tp1Price || null,  // custom TP dari user
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

// ─────────────────────────────────────────────────────────────────────────────
// MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
export async function doManagement() {
  if (_manageBusy) { log('cron', 'Management busy, skip'); return; }
  _manageBusy = true;
  try {
    await runManagementCycle();
  } catch (err) {
    log('cron_error', `Management error: ${err.message}`);
    await notifyError(`Management error: ${err.message}`);
  } finally {
    _manageBusy = false;
  }
}

export { skipCandidate, getPendingQueue };

// ─────────────────────────────────────────────────────────────────────────────
// CRON
// ─────────────────────────────────────────────────────────────────────────────
function startCron() {
  stopCron();
  const manageMin = config.schedule?.managementIntervalMin ?? 5;
  const screenMin = config.schedule?.screeningIntervalMin  ?? 60;

  log('cron', `Cron aktif:`);
  log('cron', `  Screening  : setiap ${screenMin} menit`);
  log('cron', `  Management : setiap ${manageMin} menit`);
  log('cron', `  Mode       : ${config.trading.autoExecute !== false ? '⚡ AUTO' : '📋 MANUAL'}`);

  const screenTask = cron.schedule(intervalToCron(screenMin), () => {
    log('cron', `🔍 Auto screening (mode: ${config.trading.autoExecute !== false ? 'AUTO' : 'MANUAL'})`);
    doScreening();
  });

  const manageTask = cron.schedule(intervalToCron(manageMin), doManagement);

  _cronTasks = [screenTask, manageTask];
}

function stopCron() {
  _cronTasks.forEach(t => t.stop());
  _cronTasks = [];
  stopTelegramPolling();
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
async function showStatus() {
  const stats     = getStats();
  const positions = getAllPositions();
  const pending   = getPendingQueue();
  const isAuto    = config.trading.autoExecute !== false;

  console.log('\n══════════════════════════════════════');
  console.log('  📊 FUTURES BOT v1.0');
  console.log('══════════════════════════════════════');
  console.log(`  Mode     : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}`);
  console.log(`  Execute  : ${isAuto ? '⚡ AUTO' : '📋 MANUAL'}`);
  console.log(`  Leverage : ${config.trading.leverage}x | ${config.trading.marginMode}`);
  console.log(`  Open     : ${stats.openPositions} (📈 ${stats.openLong} Long | 📉 ${stats.openShort} Short)`);
  if (pending.length > 0) {
    console.log(`  Pending  : ${pending.length} menunggu approval`);
    pending.forEach(p => console.log(`    → ${p.symbol} ${p.side} (sisa ${p.minsLeft}m)`));
  }
  console.log(`  Closed   : ${stats.closedCount}`);
  console.log(`  Total PnL: ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt?.toFixed(2)} USDT`);

  if (stats.openPositions > 0) {
    console.log('\n  Posisi Terbuka:');
    for (const [key, pos] of Object.entries(positions)) {
      const cur    = await getCurrentPrice(pos.symbol).catch(() => null);
      const isLong = pos.side === 'long';
      if (cur) {
        const diff   = isLong ? cur - pos.entryPrice : pos.entryPrice - cur;
        const pnlPct = (diff / pos.entryPrice) * 100 * pos.leverage;
        const sign   = pnlPct >= 0 ? '+' : '';
        console.log(`    ${isLong ? '📈' : '📉'} ${pos.symbol} entry=${pos.entryPrice} now=${cur} PnL=${sign}${pnlPct.toFixed(2)}%`);
      }
    }
  }
  console.log('══════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────────
function startREPL() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n[futures-bot] > ' });
  console.log('\n📖 Perintah: status | long | short | screen | manage | auto | manual | stats | stop | help\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().toLowerCase().split(' ');
    const cmd = parts[0];
    const arg = parts[1]?.toUpperCase();
    if (!cmd) { rl.prompt(); return; }
    switch (cmd) {
      case 'status':  await showStatus(); break;
      case 'long':    await doLongScreening(); break;
      case 'short':   await doShortScreening(); break;
      case 'screen':  await doScreening(); break;
      case 'manage':  await doManagement(); break;
      case 'auto':
        config.trading.autoExecute = true;
        console.log('⚡ Mode diubah ke AUTO-EXECUTE'); break;
      case 'manual':
        config.trading.autoExecute = false;
        console.log('📋 Mode diubah ke MANUAL APPROVAL'); break;
      case 'stats':   await notifyStats(getStats()); console.log('📊 Stats dikirim ke Telegram'); break;
      case 'stop':    console.log('🛑 Bot dihentikan...'); stopCron(); process.exit(0); break;
      case 'help':
        console.log([
          '',
          '  status  — posisi terbuka & PnL',
          '  long    — scan kandidat LONG',
          '  short   — scan kandidat SHORT',
          '  screen  — long + short sekaligus',
          '  manage  — cek TP/SL/trailing',
          '  auto    — switch ke auto-execute',
          '  manual  — switch ke manual approval',
          '  stats   — kirim statistik ke Telegram',
          '  stop    — hentikan bot',
          '',
        ].join('\n')); break;
      default: console.log(`❓ Perintah tidak dikenal: "${cmd}"`);
    }
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Bitget Futures Bot v1.0 — USDT-M Perpetual      ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Mode: ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}`);
  console.log(`  Execute: ${config.trading.autoExecute !== false ? '⚡ AUTO' : '📋 MANUAL'}`);
  console.log('');

  if (!isDryRun) {
    log('startup', 'Mengecek koneksi Bitget Futures API...');
    const conn = await testConnection();
    if (!conn.ok) { log('startup_error', `Koneksi gagal: ${conn.error}`); process.exit(1); }
    log('startup', `✅ Koneksi OK`);
  } else {
    log('startup', '🧪 DRY RUN mode');
  }

  const cfg       = config.trading;
  const manageMin = config.schedule?.managementIntervalMin ?? 5;
  const screenMin = config.schedule?.screeningIntervalMin  ?? 60;
  const isAuto    = cfg.autoExecute !== false;

  log('startup', `Config:`);
  log('startup', `  Budget/trade : ${cfg.budgetPerTrade} USDT | Lev: ${cfg.leverage}x | Exposure: ${cfg.budgetPerTrade * cfg.leverage} USDT`);
  log('startup', `  Margin mode  : ${cfg.marginMode}`);
  log('startup', `  Execute mode : ${isAuto ? '⚡ AUTO' : '📋 MANUAL (approval timeout: ' + cfg.approvalTimeoutMin + ' menit)'}`);
  log('startup', `  Scheduling   : screen=${screenMin}m | manage=${manageMin}m`);

  await notifyStartup(isDryRun);

  if (args.includes('--long-only'))  { await doLongScreening();  process.exit(0); }
  if (args.includes('--short-only')) { await doShortScreening(); process.exit(0); }
  if (args.includes('--manage-only')){ await doManagement();     process.exit(0); }

  initState();
  await initSymbolFilter();

  log('startup', 'Management cycle pertama...');
  await doManagement();

  startCron();

  startTelegramPolling({
    doLongScreening,
    doShortScreening,
    doScreening,
    doManagement,
    doApprove,
    doSkip:         skipCandidate,
    doManualLong,
    doManualShort,
    getPendingQueue,
    getAllPositions,
    getCurrentPrice,
    getConfig:      () => config,
    setAutoExecute: (val) => { config.trading.autoExecute = val; },
    stopBot:        () => { stopCron(); process.exit(0); },
  });

  startApiServer({
    doLongScreening,
    doShortScreening,
    doScreening,
    doManagement,
    doApprove,
    doSkip:         skipCandidate,
    doManualLong,
    doManualShort,
    getPendingQueue,
    getAllPositions,
    getStats,
    getCurrentPrice,
    getConfig:      () => config,
    setAutoExecute: (val) => { config.trading.autoExecute = val; },
    executeCloseManual: async (symbol, side) => {
      const pos = getAllPositions()[`${symbol}_${side}`];
      if (!pos) return { ok: false, error: 'Posisi tidak ditemukan' };
      return executeClose(symbol, side, { reason: 'manual_close', position: pos });
    },
  });

  if (process.stdin.isTTY) startREPL();
  else log('startup', 'Non-TTY mode — daemon');
}

main().catch(err => { log('fatal', err.message); process.exit(1); });
