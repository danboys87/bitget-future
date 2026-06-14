import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'user-config.json');

function load() {
  const base = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Override dari environment variables
  if (process.env.LEVERAGE)    base.trading.leverage         = parseFloat(process.env.LEVERAGE);
  if (process.env.BUDGET)      base.trading.budgetPerTrade   = parseFloat(process.env.BUDGET);
  if (process.env.TP)          base.management.takeProfitPct = parseFloat(process.env.TP);
  if (process.env.SL)          base.management.stopLossPct   = parseFloat(process.env.SL);
  if (process.env.MAX_POS)     base.trading.maxOpenPositions = parseInt(process.env.MAX_POS);
  if (process.env.MARGIN_MODE) base.trading.marginMode       = process.env.MARGIN_MODE;

  return base;
}

export let config = load();

export function saveConfig(updates) {
  const merged = deepMerge(load(), updates);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  config = merged;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
