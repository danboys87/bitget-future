/**
 * Telegram Notifications — Futures Bot
 */
import { log }    from './logger.js';
import { config } from './config.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

export function isEnabled() { return !!(getToken() && getChatId()); }

async function send(text) {
  if (!isEnabled()) return;
  try {
    await fetch(`${getBase()}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: getChatId(), text, parse_mode: 'HTML' }),
    });
  } catch (err) { log('telegram_error', `Gagal kirim: ${err.message}`); }
}

async function sendLong(text) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) { await send(text); return; }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > LIMIT) { await send(chunk); chunk = line; await new Promise(r => setTimeout(r, 300)); }
    else { chunk = chunk ? chunk + '\n' + line : line; }
  }
  if (chunk) await send(chunk);
}

// ── Open Position ─────────────────────────────────────────────────────────────
export async function notifyOpen({ symbol, side, entryPrice, size, leverage, margin, slPrice, tp1Price, liqPrice, strategy, change24h }) {
  const isLong  = side === 'long';
  const emoji   = isLong ? '📈' : '📉';
  const sideStr = isLong ? 'LONG' : 'SHORT';
  const exposure = margin * leverage;
  const slPct    = isLong
    ? ((slPrice - entryPrice) / entryPrice * 100).toFixed(2)
    : ((entryPrice - slPrice) / entryPrice * 100).toFixed(2);
  const tp1Pct   = isLong
    ? ((tp1Price - entryPrice) / entryPrice * 100).toFixed(2)
    : ((entryPrice - tp1Price) / entryPrice * 100).toFixed(2);
  const chgStr   = change24h >= 0 ? `+${change24h?.toFixed(2)}%` : `${change24h?.toFixed(2)}%`;

  await send(
    `${emoji} <b>${sideStr} OPENED</b> — ${strategy}\n\n` +
    `Pair      : <b>${symbol}</b> (24h: ${chgStr})\n` +
    `Entry     : ${entryPrice}\n` +
    `Size      : ${size} contracts\n` +
    `Leverage  : ${leverage}x\n` +
    `Margin    : ${margin} USDT (exposure: ${exposure} USDT)\n` +
    `SL        : ${slPrice?.toFixed(6)} (-${Math.abs(slPct)}%)\n` +
    `TP1       : ${tp1Price?.toFixed(6)} (+${tp1Pct}%) → tutup 50%\n` +
    `Liq Price : ${liqPrice?.toFixed(6)} ⚠️`
  );
}

// ── Close Position ─────────────────────────────────────────────────────────────
export async function notifyClose({ symbol, side, entryPrice, exitPrice, pnlPct, pnlUsdt, reason, leverage }) {
  const isLong  = side === 'long';
  const isProfit = pnlPct >= 0;
  const emoji   = isProfit ? '🟢' : '🔴';
  const sign    = isProfit ? '+' : '';
  const labels  = {
    stop_loss:     '🛑 Stop Loss',
    break_even_sl: '🔁 Break Even SL',
    tp1_partial:   '🎯 TP1 — Partial Close 50%',
    trailing_stop: '🔻 Trailing Stop',
    max_hold_time: '⏰ Max Hold Time',
    manual_close:  '🖐 Manual Close',
  };
  const extra = reason === 'tp1_partial' ? '\n📌 Sisa 50% lanjut | Trailing aktif | SL → BEP'
    : reason === 'trailing_stop' ? '\n📈 Profit diamankan via trailing'
    : reason === 'break_even_sl' ? '\n✅ Modal dilindungi di BEP'
    : '';

  await send(
    `${emoji} <b>${side.toUpperCase()} CLOSED</b> — ${symbol}\n` +
    `📌 ${labels[reason] || reason}\n\n` +
    `Entry : ${entryPrice}\n` +
    `Exit  : ${exitPrice}\n` +
    `Lev   : ${leverage}x\n` +
    `PnL   : ${sign}${pnlPct?.toFixed(2)}% (${sign}${pnlUsdt?.toFixed(2)} USDT)` +
    extra
  );
}

// ── Liquidation Warning ────────────────────────────────────────────────────────
export async function notifyLiquidationWarning({ symbol, side, currentPrice, liqPrice, liqDist }) {
  await send(
    `⚠️ <b>LIQUIDATION WARNING!</b>\n\n` +
    `Pair     : <b>${symbol}</b> ${side.toUpperCase()}\n` +
    `Harga    : ${currentPrice}\n` +
    `Liq Price: ${liqPrice?.toFixed(6)}\n` +
    `Jarak    : ${liqDist?.toFixed(1)}% dari likuidasi!\n\n` +
    `⚡ Pertimbangkan tutup posisi manual:\n` +
    `/close ${symbol} ${side}`
  );
}

// ── Screening Summary ─────────────────────────────────────────────────────────
export async function notifyScreening({ found, side, symbols }) {
  if (found === 0) {
    await send(`🔍 Screening ${side.toUpperCase()} selesai — tidak ada kandidat`);
    return;
  }
  await send(
    `🔍 <b>Screening ${side.toUpperCase()} Selesai</b>\n` +
    `✅ ${found} kandidat: ${symbols.join(', ')}\n\n` +
    `Auto-execute dalam hitungan detik...`
  );
}

// ── Startup ───────────────────────────────────────────────────────────────────
export async function notifyStartup(dryRun) {
  const cfg  = config.trading;
  const mgmt = config.management;
  await send(
    `🚀 <b>Futures Bot v1.0 — USDT-M Perpetual</b>\n` +
    `Mode     : ${dryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}\n\n` +
    `💰 Budget    : ${cfg.budgetPerTrade} USDT/trade\n` +
    `⚡ Leverage  : ${cfg.leverage}x (exposure: ${cfg.budgetPerTrade * cfg.leverage} USDT)\n` +
    `🔒 Margin    : ${cfg.marginMode}\n` +
    `📈 Max Long  : ${cfg.maxLongPositions} posisi\n` +
    `📉 Max Short : ${cfg.maxShortPositions} posisi\n` +
    `🎯 TP1       : ${mgmt.takeProfitPct}%\n` +
    `🛑 SL        : ${mgmt.stopLossPct}%\n` +
    `🔻 Trail     : ${mgmt.trailingStop?.trailPct}% callback\n\n` +
    `Time: ${new Date().toLocaleString('id-ID')}`
  );
}

export async function notifyStats({ openPositions, openLong, openShort, closedCount, totalPnlUsdt }) {
  const sign = totalPnlUsdt >= 0 ? '+' : '';
  await send(
    `📊 <b>Futures Bot Status</b>\n` +
    `📂 Open   : ${openPositions} (📈 ${openLong} Long | 📉 ${openShort} Short)\n` +
    `✅ Closed : ${closedCount}\n` +
    `💰 PnL    : ${sign}${totalPnlUsdt?.toFixed(2)} USDT`
  );
}

export async function notifyError(message) {
  await send(`⚠️ <b>Error</b>\n${message}`);
}

// ── Approval Request (Manual Mode) ────────────────────────────────────────────
export async function notifyApprovalRequest({ candidate, timeoutMin }) {
  const c      = candidate;
  const isLong = c.side === 'long';
  const emoji  = isLong ? '📈' : '📉';
  const sideStr = isLong ? 'LONG' : 'SHORT';
  const chgStr  = c.change24h >= 0 ? `+${c.change24h?.toFixed(2)}%` : `${c.change24h?.toFixed(2)}%`;

  const signalLines = Object.entries(c.signals || {})
    .filter(([, v]) => v?.label)
    .map(([, v]) => `  • ${v.label}`)
    .join('\n');

  await sendLong(
    `🔔 <b>Signal Ditemukan!</b> — ${emoji} ${sideStr}\n\n` +
    `Pair    : <b>${c.symbol}</b>\n` +
    `Harga   : ${c.lastPrice}\n` +
    `Change  : ${chgStr}\n` +
    `Vol 24h : $${(c.vol24h / 1e6).toFixed(1)}M\n` +
    `SL ref  : ${c.slPrice?.toFixed(6) ?? '—'}\n` +
    (signalLines ? `\n<b>Sinyal:</b>\n${signalLines}\n` : '') +
    `\n<b>Aksi:</b>\n` +
    `/approve ${c.symbol} ${c.side}  → Execute ${sideStr}\n` +
    `/skip ${c.symbol} ${c.side}     → Lewati\n\n` +
    `⏰ Expired dalam ${timeoutMin} menit`
  );
}
