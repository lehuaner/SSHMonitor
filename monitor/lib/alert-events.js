/**
 * 当日告警事件记录（供「每日日报」的「当日告警事件汇总」段消费）。
 *
 * ── 为什么放在 sendMail 这个总漏斗里 ──
 *   系统里所有告警邮件（代理异常 / 进程掉线 / 磁盘 / 凭证失效 / 签到失败 / 到期提醒…）
 *   都经 notify.js 的 sendMail 出口。在这里按主题前缀落一条当日事件，
 *   就能零侵入地聚合「今天到底发了哪些告警」，不必去每个发信点单独埋点。
 *
 * ── 只记「告警 / 提醒」，不记「恢复 / 测试 / 日报」本身 ──
 *   [告警] 与 [提醒] 前缀才入账；[恢复]/[签到]/[测试] 等好消息或噪声不入账。
 *
 * ── 落盘 ──
 *   ~/.monitor_data/alert_events.json = { "YYYY-MM-DD": [ {ts, subject}, ... ] }
 *   按自然日分桶，滚动保留最近 KEEP_DAYS 天。低频（每天数条），读改写竞态可忽略。
 */
import { loadJSON, saveJSON, DATA_DIR } from './utils.js';

const EVENTS_FILE = DATA_DIR + '/alert_events.json';
const KEEP_DAYS = 8;
const MAX_PER_DAY = 200; // 单日封顶，防异常刷屏撑爆文件

function dayKeyBeijing(ts = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** 主题是否属于「需要进日报汇总」的告警/提醒 */
function isAlertSubject(subject) {
  const s = String(subject || '');
  return s.startsWith('[告警]') || s.startsWith('[提醒]');
}

/**
 * 记一条告警事件（由 notify.js sendMail 在判定为告警/提醒时调用）。
 * 不抛异常——记录失败绝不能影响发信主流程。
 */
export function recordAlertEvent(subject) {
  try {
    if (!isAlertSubject(subject)) return;
    const now = Date.now();
    const day = dayKeyBeijing(now);
    const store = loadJSON(EVENTS_FILE, {});
    const list = Array.isArray(store[day]) ? store[day] : [];
    list.push({ ts: now, subject: String(subject).slice(0, 200) });
    store[day] = list.slice(-MAX_PER_DAY);
    // 滚动裁剪：只留最近 KEEP_DAYS 天
    const cutoff = dayKeyBeijing(now - (KEEP_DAYS - 1) * 86400000);
    for (const k of Object.keys(store)) if (k < cutoff) delete store[k];
    saveJSON(EVENTS_FILE, store);
  } catch {
    // 静默：埋点失败不影响邮件发送
  }
}

/**
 * 取指定自然日（默认今天，北京时间）的告警事件。
 * @returns {{day:string, events:Array<{ts:number, subject:string}>}}
 */
export function getTodayAlerts(dayKey) {
  const day = dayKey || dayKeyBeijing();
  const store = loadJSON(EVENTS_FILE, {});
  const events = Array.isArray(store[day]) ? store[day] : [];
  return { day, events };
}
