/**
 * 30 天滚动签到日志。
 * 每条记录按 (taskId, date) 去重（同一天多次只保留最新），滚动裁剪保留最近 30 天。
 */
import { loadJSON, saveJSON, DATA_DIR } from './utils.js';

const LOG_FILE = DATA_DIR + '/checkin_logs.json';
const MAX_DAYS = 30;

function todayStr(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 追加一条日志（同一天同一任务覆盖） */
export function appendLog(entry) {
  const logs = loadJSON(LOG_FILE, []);
  const date = entry.date || todayStr(entry.ts || Date.now());
  const idx = logs.findIndex((l) => l.taskId === entry.taskId && l.date === date);
  const rec = { taskId: entry.taskId, providerId: entry.providerId || '', date, status: entry.status, credits: entry.credits ?? null, reward: entry.reward ?? null, error: entry.error || null, ts: entry.ts || Date.now() };
  if (idx >= 0) logs[idx] = rec;
  else logs.push(rec);
  saveJSON(LOG_FILE, prune(logs));
  return rec;
}

/** 裁剪：只保留最近 MAX_DAYS 天 */
function prune(logs) {
  const cutoff = todayStr(Date.now() - MAX_DAYS * 86400000);
  return logs.filter((l) => l.date >= cutoff);
}

/**
 * 查询日志。
 * @param {object} opts { days=30, taskId? }
 * @returns {Array} 按 date 升序
 */
export function getLogs({ days = MAX_DAYS, taskId } = {}) {
  const logs = loadJSON(LOG_FILE, []);
  const cutoff = todayStr(Date.now() - days * 86400000);
  return logs
    .filter((l) => l.date >= cutoff && (!taskId || l.taskId === taskId))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}