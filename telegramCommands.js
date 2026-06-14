/**
 * Telegram Command Handler — Futures Bot v1.0
 */
import { log }             from './logger.js';
import { getCurrentPrice } from './bitgetFutures.js';
import { getStats, getAllPositions } from './state.js';
import { executeClose }    from './executor.js';
import { config }          from './config.js';
import { notifyClose }     from './telegram.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

let _offset = 0, _polling = false, _pollTimer = null;

async function reply(chatId, text) {
  if (!getBase()) return;
  const LIMIT = 4000;
  const chunks = [];
  if (text.length <= LIMIT) { chunks.push(text); }
  else {
    const lines = text.split('\n'); let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > LIMIT) { chunks.push(chunk); chunk = line; }
      else { chunk = chunk ? chunk + '\n' + line : line; }
    }
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunks) {
    try {
      await fetch(`${getBase()}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }),
      });
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    } catch (err) { log('telegram_error', `Reply: ${err.message}`); }
  }
}

async function getUpdates() {
  if (!getBase()) return [];
  try {
    const res  = await fetch(`${getBase()}/getUpdates?offset=${_offset}&timeout=10&allowed_updates=["message"]`);
    const data = await res.json();
    return data.ok ? data.result : [];
  } catch { return []; }
}

async function buildStatusText(callbacks) {
  const stats     = getStats();
  const positions = getAllPositions();
  const pending   = callbacks.getPendingQueue?.() ?? [];
  const isDryRun  = process.env.DRY_RUN === 'true';
  const cfg       = config.trading;
  const isAuto    = cfg.autoExecute !== false;

  let text = `📊 <b>Futures Bot v1.0</b>\n`;
  text += `Mode     : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}\n`;
  text += `Execute  : ${isAuto ? '⚡ AUTO' : '📋 MANUAL'}\n`;
  text += `Leverage : ${cfg.leverage}x | ${cfg.marginMode}\n`;
  text += `Open     : ${stats.openPositions} (📈 ${stats.openLong} Long | 📉 ${stats.openShort} Short)\n`;
  text += `Closed   : ${stats.closedCount}\n`;
  text += `Total PnL: ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt?.toFixed(2)} USDT\n`;

  if (pending.length > 0) {
    text += `\n<b>⏳ Menunggu Approval (${pending.length}):</b>\n`;
    for (const p of pending) {
      const isLong = p.side === 'long';
      text += `  ${isLong ? '📈' : '📉'} <b>${p.symbol}</b> ${p.side.toUpperCase()} — sisa ${p.minsLeft}m\n`;
      text += `  /approve ${p.symbol} ${p.side} | /skip ${p.symbol} ${p.side}\n\n`;
    }
  }

  if (stats.openPositions > 0) {
    text += `\n<b>Posisi Terbuka:</b>\n`;
    for (const [key, pos] of Object.entries(positions)) {
      const isLong = pos.side === 'long';
      try {
        const cur    = await getCurrentPrice(pos.symbol);
        const diff   = isLong ? cur - pos.entryPrice : pos.entryPrice - cur;
        const pnlPct = cur ? (diff / pos.entryPrice) * 100 * pos.leverage : null;
        const pnlUsd = cur ? (diff / pos.entryPrice) * pos.margin * pos.leverage : null;
        const sign   = pnlPct >= 0 ? '+' : '';
        const emoji  = pnlPct >= 0 ? '🟢' : '🔴';
        const flags  = [pos.hasBEP ? 'BEP✅' : '', pos.trailingActive ? '🔻TRAIL' : ''].filter(Boolean).join(' ');
        text += `${emoji} ${isLong ? '📈' : '📉'} <b>${pos.symbol}</b> ${flags}\n`;
        text += `   Entry: ${pos.entryPrice} | Now: ${cur ?? '—'}\n`;
        text += `   SL: ${pos.slPrice?.toFixed(6)} | Liq: ${pos.liqPrice?.toFixed(6)}\n`;
        if (pnlPct !== null) text += `   PnL: ${sign}${pnlPct.toFixed(2)}% (${sign}${pnlUsd.toFixed(2)} USDT)\n`;
        text += `   /close ${pos.symbol} ${pos.side}\n\n`;
      } catch { text += `⚪ ${pos.symbol} ${pos.side} | Entry: ${pos.entryPrice}\n`; }
    }
  }
  return text;
}

async function handleCommand(chatId, text, callbacks) {
  if (String(chatId) !== String(getChatId())) { await reply(chatId, '⛔ Tidak diizinkan.'); return; }

  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const arg1  = parts[1]?.toUpperCase(); // symbol
  const arg2  = parts[2]?.toLowerCase(); // side (long/short)

  log('telegram', `Cmd: ${cmd}${arg1 ? ' ' + arg1 : ''}${arg2 ? ' ' + arg2 : ''}`);

  switch (cmd) {

    case '/status': {
      await reply(chatId, '⏳...');
      await reply(chatId, await buildStatusText(callbacks));
      break;
    }

    // ── Mode switch ───────────────────────────────────────────────────────────
    case '/auto': {
      callbacks.setAutoExecute?.(true);
      await reply(chatId, '⚡ <b>Mode: AUTO-EXECUTE</b>\n\nSignal baru akan langsung dieksekusi tanpa konfirmasi.');
      break;
    }

    case '/manual': {
      callbacks.setAutoExecute?.(false);
      const timeout = config.trading.approvalTimeoutMin ?? 30;
      await reply(chatId, `📋 <b>Mode: MANUAL APPROVAL</b>\n\nSignal baru akan menunggu konfirmasimu.\nTimeout: ${timeout} menit.`);
      break;
    }

    case '/mode': {
      const isAuto = config.trading.autoExecute !== false;
      await reply(chatId,
        `⚙️ <b>Execute Mode Saat Ini:</b> ${isAuto ? '⚡ AUTO' : '📋 MANUAL'}\n\n` +
        `/auto   — switch ke auto-execute\n` +
        `/manual — switch ke manual approval`
      );
      break;
    }

    // ── Screener ──────────────────────────────────────────────────────────────
    case '/long': {
      await reply(chatId, '🔍 Menjalankan Long screener...');
      callbacks.doLongScreening?.()
        .then(c => { if (!c?.length) reply(chatId, '⚠️ Tidak ada kandidat LONG.'); })
        .catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    case '/short': {
      await reply(chatId, '🔍 Menjalankan Short screener...');
      callbacks.doShortScreening?.()
        .then(c => { if (!c?.length) reply(chatId, '⚠️ Tidak ada kandidat SHORT.'); })
        .catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    case '/screen': {
      await reply(chatId, '🔍 Menjalankan Long + Short screener...');
      callbacks.doScreening?.().catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    // ── Approval (Manual Mode) ─────────────────────────────────────────────
    case '/approve': {
      // /approve BTCUSDT long
      if (!arg1 || !arg2) { await reply(chatId, '❓ Format: /approve SYMBOL long|short'); break; }
      if (!['long', 'short'].includes(arg2)) { await reply(chatId, '❓ Side harus "long" atau "short"'); break; }
      await reply(chatId, `⏳ Mengeksekusi ${arg2.toUpperCase()} ${arg1}...`);
      try {
        const result = await callbacks.doApprove?.(arg1, arg2);
        if (result?.ok) {
          await reply(chatId, `✅ <b>${arg2.toUpperCase()} ${arg1}</b> berhasil dieksekusi!`);
        } else {
          await reply(chatId, `❌ Gagal: ${result?.reason || 'Unknown error'}`);
        }
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    case '/skip': {
      // /skip BTCUSDT long
      if (!arg1 || !arg2) { await reply(chatId, '❓ Format: /skip SYMBOL long|short'); break; }
      const result = callbacks.doSkip?.(arg1, arg2);
      await reply(chatId, result?.ok ? `⏭ ${arg1} ${arg2} diskip.` : `❌ ${result?.reason}`);
      break;
    }

    case '/pending': {
      const pending = callbacks.getPendingQueue?.() ?? [];
      if (!pending.length) { await reply(chatId, '📭 Tidak ada kandidat pending.'); break; }
      let msg = `⏳ <b>Menunggu Approval (${pending.length}):</b>\n\n`;
      for (const p of pending) {
        const isLong = p.side === 'long';
        const chg    = p.candidate.change24h >= 0 ? `+${p.candidate.change24h?.toFixed(2)}%` : `${p.candidate.change24h?.toFixed(2)}%`;
        msg += `${isLong ? '📈' : '📉'} <b>${p.symbol}</b> ${p.side.toUpperCase()} (${chg})\n`;
        msg += `   SL ref: ${p.candidate.slPrice?.toFixed(6) ?? '—'}\n`;
        msg += `   Sisa: ${p.minsLeft} menit\n`;
        msg += `   /approve ${p.symbol} ${p.side}\n`;
        msg += `   /skip ${p.symbol} ${p.side}\n\n`;
      }
      await reply(chatId, msg);
      break;
    }

    // ── Manual Trade ──────────────────────────────────────────────────────────
    case '/buylong': {
      if (!arg1) { await reply(chatId, '❓ Format: /buylong SYMBOL\nContoh: /buylong BTCUSDT'); break; }
      await reply(chatId, `⏳ Open LONG <b>${arg1}</b>...`);
      try {
        const result = await callbacks.doManualLong?.(arg1);
        if (result?.success) {
          await reply(chatId, `✅ LONG ${arg1} @ ${result.entryPrice} | Size: ${result.size} | Liq: ${result.liqPrice?.toFixed(6)}`);
        } else { await reply(chatId, `❌ Gagal: ${result?.error}`); }
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    case '/buyshort': {
      if (!arg1) { await reply(chatId, '❓ Format: /buyshort SYMBOL\nContoh: /buyshort BTCUSDT'); break; }
      await reply(chatId, `⏳ Open SHORT <b>${arg1}</b>...`);
      try {
        const result = await callbacks.doManualShort?.(arg1);
        if (result?.success) {
          await reply(chatId, `✅ SHORT ${arg1} @ ${result.entryPrice} | Size: ${result.size} | Liq: ${result.liqPrice?.toFixed(6)}`);
        } else { await reply(chatId, `❌ Gagal: ${result?.error}`); }
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    // ── Close ─────────────────────────────────────────────────────────────────
    case '/close': {
      if (!arg1 || !arg2) { await reply(chatId, '❓ Format: /close SYMBOL long|short'); break; }
      if (!['long', 'short'].includes(arg2)) { await reply(chatId, '❓ Side harus "long" atau "short"'); break; }
      const pos = getAllPositions()[`${arg1}_${arg2}`];
      if (!pos) { await reply(chatId, `❌ Tidak ada posisi <b>${arg1} ${arg2}</b>`); break; }
      await reply(chatId, `🔄 Menutup ${arg2.toUpperCase()} ${arg1}...`);
      try {
        const result = await executeClose(arg1, arg2, { reason: 'manual_close', position: pos });
        if (result.success) {
          const sign = result.pnlPct >= 0 ? '+' : '';
          await reply(chatId,
            `${result.pnlPct >= 0 ? '🟢' : '🔴'} CLOSE ${arg2.toUpperCase()} ${arg1}\n` +
            `Entry: ${pos.entryPrice} → Exit: ${result.exitPrice}\n` +
            `PnL: ${sign}${result.pnlPct?.toFixed(2)}% (${sign}${result.pnlUsdt?.toFixed(2)} USDT)`
          );
        } else { await reply(chatId, `❌ Gagal: ${result.error}`); }
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    case '/closeall': {
      const positions = Object.values(getAllPositions());
      if (!positions.length) { await reply(chatId, '📭 Tidak ada posisi terbuka.'); break; }
      await reply(chatId, `🔄 Menutup ${positions.length} posisi...`);
      for (const pos of positions) {
        try {
          const result = await executeClose(pos.symbol, pos.side, { reason: 'manual_close', position: pos });
          if (result.success) {
            await notifyClose({ symbol: pos.symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice: result.exitPrice, pnlPct: result.pnlPct, pnlUsdt: result.pnlUsdt, reason: 'manual_close', leverage: pos.leverage });
          }
        } catch (err) { log('telegram_error', `Close ${pos.symbol}: ${err.message}`); }
      }
      await reply(chatId, '✅ Semua posisi ditutup.');
      break;
    }

    // ── Utility ───────────────────────────────────────────────────────────────
    case '/manage': {
      await reply(chatId, '⚙️ Management cycle...');
      callbacks.doManagement?.().then(() => reply(chatId, '✅ Selesai.'));
      break;
    }

    case '/stats': {
      const s    = getStats();
      const sign = s.totalPnlUsdt >= 0 ? '+' : '';
      await reply(chatId,
        `📊 <b>Statistik Futures</b>\n` +
        `📂 Open  : ${s.openPositions} (📈${s.openLong} | 📉${s.openShort})\n` +
        `✅ Closed: ${s.closedCount}\n` +
        `💰 PnL   : ${sign}${s.totalPnlUsdt?.toFixed(2)} USDT`
      );
      break;
    }

    case '/stop': {
      await reply(chatId, '🛑 Bot dihentikan.');
      callbacks.stopBot?.();
      break;
    }

    case '/help':
    default: {
      const isAuto = config.trading.autoExecute !== false;
      await reply(chatId,
        `🤖 <b>Futures Bot v1.0</b> — ${isAuto ? '⚡ AUTO' : '📋 MANUAL'}\n\n` +
        `<b>⚙️ Mode:</b>\n` +
        `/mode            — lihat mode saat ini\n` +
        `/auto            — switch ke auto-execute\n` +
        `/manual          — switch ke manual approval\n\n` +
        `<b>📡 Screening:</b>\n` +
        `/long            — scan kandidat LONG\n` +
        `/short           — scan kandidat SHORT\n` +
        `/screen          — Long + Short sekaligus\n\n` +
        `<b>✅ Approval (mode manual):</b>\n` +
        `/pending                — lihat antrian\n` +
        `/approve SYMBOL long    — approve LONG\n` +
        `/approve SYMBOL short   — approve SHORT\n` +
        `/skip SYMBOL long       — skip LONG\n` +
        `/skip SYMBOL short      — skip SHORT\n\n` +
        `<b>💰 Manual Trade:</b>\n` +
        `/buylong SYMBOL  — open LONG manual\n` +
        `/buyshort SYMBOL — open SHORT manual\n` +
        `/close SYMBOL long  — tutup LONG\n` +
        `/close SYMBOL short — tutup SHORT\n` +
        `/closeall           — tutup semua\n\n` +
        `<b>📊 Monitor:</b>\n` +
        `/status          — posisi + PnL\n` +
        `/manage          — cek TP/SL/trailing\n` +
        `/stats           — total statistik\n` +
        `/stop            — hentikan bot`
      );
      break;
    }
  }
}

export function startTelegramPolling(callbacks) {
  if (!getToken() || !getChatId()) { log('telegram', 'Telegram tidak dikonfigurasi'); return; }
  if (_polling) return;
  _polling = true;
  log('telegram', '✅ Futures bot Telegram polling aktif');

  async function poll() {
    if (!_polling) return;
    const updates = await getUpdates();
    for (const update of updates) {
      _offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text?.startsWith('/')) continue;
      try { await handleCommand(msg.chat.id, msg.text, callbacks); }
      catch (err) { log('telegram_error', `Handle: ${err.message}`); }
    }
    if (_polling) _pollTimer = setTimeout(poll, 1000);
  }
  poll();
}

export function stopTelegramPolling() {
  _polling = false;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  log('telegram', 'Polling dihentikan');
}
