/**
 * 积分过期提醒（跨平台）。
 *
 * ── 能拿到到期时间吗？能，三个平台都有（2026-09-10 真机实测确认）──
 *   Trae      ：POST /trae/api/v2/pay/user_current_entitlement_list
 *               → user_entitlement_pack_list[].entitlement_base_info.{start_time,end_time}（epoch 秒）
 *   WorkBuddy ：POST /billing/meter/get-user-resource-{free,paid}-packages
 *               → data.Accounts[].CycleStartTime / CycleEndTime（"YYYY-MM-DD HH:mm:ss"，北京时间）
 *   CodeArts  ：POST /portal/snap-manager/v1/package/credit/page
 *               → list[].expiredTime / createdTime（ISO 带偏移，如 2026-10-10T15:59:59.000+00:00）
 *   三者都已在各自 provider 的 getPackages() 里归一成 { cycleStart, cycleEnd, cycleEndMs }，
 *   ★本模块只消费归一后的字段，不关心平台差异。
 *
 * ── 提醒语义 ──
 *   从「到期前第 N 天」进入提醒窗口，之后每天在「提醒时间」发一封，最多发 M 封。
 *   例：提前 6 天 + 最多 1 次 → 只在到期前第 6 天发一封，第 5~1 天不再发。
 *   例：提前 6 天 + 最多 3 次 → 在到期前第 6 / 5 / 4 天各发一封。
 *   天数一律按「账号所在时区的自然日」计算，不用毫秒差取整（避免跨时区差一天）。
 *
 * ── 依赖方向 ──
 *   本模块**不** import lib/tasks/index.js（那边会 import 本模块的 startCreditExpiryScheduler，
 *   反向 import 会成环）。落盘与取任务都通过参数注入：
 *     startCreditExpiryScheduler(task, { persist })
 *     runCreditExpiryCheck(task, { now, persist, send })
 */
import { sendMail } from '../notify.js';
import { getProvider } from '../providers/index.js';
import { CREDIT_EXPIRY_DEFAULTS } from '../providers/common.js';
import { startScheduler } from './scheduler.js';

const DAY_MS = 86400000;

// ==================================================================
// 纯函数区（可单测，不碰网络 / 不碰磁盘）
// ==================================================================

/** 取某时刻在指定时区的自然日键「YYYY-MM-DD」 */
export function tzDayKey(ts, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** 取某时刻在指定时区的墙上时钟「HH:mm」（24 小时制，可直接字符串比较大小） */
export function tzClock(ts, timezone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

/** 两个自然日键相差几天（b - a） */
export function diffDays(aDayKey, bDayKey) {
  const a = Date.parse(`${aDayKey}T00:00:00Z`);
  const b = Date.parse(`${bDayKey}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / DAY_MS);
}

/**
 * 把各种形态的到期时间归一成 epoch 毫秒，解析不出返回 null。
 *  - number：≥1e12 视为毫秒，否则视为秒
 *  - 纯数字字符串：同上
 *  - "YYYY-MM-DD HH:mm:ss" / "YYYY-MM-DDTHH:mm:ss"：**不带时区时按 +08:00 解析**
 *    （WorkBuddy 的 CycleEndTime 就是北京时间字面量，与其请求侧 fmtDateTime 的口径一致）
 *  - "YYYY-MM-DD"：按 +08:00 当日 00:00:00
 *  - 带 Z / +08:00 等偏移的：直接 Date.parse
 */
export function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value >= 1e12 ? value : value * 1000;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n <= 0) return null;
    return n >= 1e12 ? n : n * 1000;
  }
  // 只有日期：补零点，按 +08:00
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00+08:00`) || null;
  // 有时刻但没时区标记 → 视为北京时间（UTC+8）
  if (/\d{2}:\d{2}/.test(s) && !/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(s)) {
    return Date.parse(`${s.replace(' ', 'T')}+08:00`) || null;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** 归一一个权益包条目 → { name, remain, size, expireAtMs }；无到期时间或已无余额则返回 null */
export function normalizePack(item) {
  if (!item || typeof item !== 'object') return null;
  const expireAtMs = toEpochMs(
    item.cycleEndMs ?? item.endMs ?? item.expireAtMs ?? item.cycleEnd ?? item.endTime
  );
  if (!expireAtMs) return null;                       // 没有到期时间 → 无从提醒
  let remain = Number(item.remain ?? item.remaining);
  if (!Number.isFinite(remain)) {
    const size = Number(item.size ?? item.limit);
    const used = Number(item.used);
    remain = Number.isFinite(size) && Number.isFinite(used) ? size - used : NaN;
  }
  if (!Number.isFinite(remain) || remain <= 0) return null;  // 已用完的包不提醒
  return {
    name: item.packageName || item.desc || item.group || '权益包',
    remain,
    size: Number(item.size ?? item.limit) || null,
    expireAtMs,
  };
}

/**
 * 把归一后的权益包按「到期自然日」聚合成批次。
 * 同一天到期的多个包合成一封邮件（WorkBuddy 单账号曾出现 17 个同日到期包，
 * 逐包发信等于轰炸）。
 * @returns {{key:string, expireAtMs:number, amount:number, packs:Array}[]}
 */
export function groupBatches(packs, timezone) {
  const map = new Map();
  for (const p of packs) {
    const key = tzDayKey(p.expireAtMs, timezone);
    let b = map.get(key);
    if (!b) {
      b = { key, expireAtMs: p.expireAtMs, amount: 0, packs: [] };
      map.set(key, b);
    }
    b.amount += p.remain;
    // 批次到期时刻取当天最晚的那个，展示上更贴近「最后可用时刻」
    if (p.expireAtMs > b.expireAtMs) b.expireAtMs = p.expireAtMs;
    b.packs.push(p);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 计算「今天该给哪些批次发提醒」——纯函数，提醒策略的唯一出处。
 *
 * @param {object} args
 * @param {Array}  args.batches      groupBatches() 的产物
 * @param {string} args.todayKey     今天的自然日键（账号时区）
 * @param {number} args.advanceDays  提前几天
 * @param {number} args.maxReminders 最多提醒几次
 * @param {object} args.state        已发记录：{ [batchKey]: { count, lastDay } }
 * @returns {{batch:object, daysLeft:number, index:number}[]} index 从 1 开始（第几次提醒）
 */
export function planReminders({ batches, todayKey, advanceDays, maxReminders, state = {} }) {
  const out = [];
  for (const b of batches) {
    const daysLeft = diffDays(todayKey, b.key);
    if (!Number.isFinite(daysLeft)) continue;
    if (daysLeft > advanceDays) continue;   // 还没进入提醒窗口
    if (daysLeft < 0) continue;             // 已过期，不再打扰
    const st = state[b.key] || { count: 0 };
    if (st.count >= maxReminders) continue;      // 次数用尽
    if (st.lastDay === todayKey) continue;       // 同一天不重复发
    out.push({ batch: b, daysLeft, index: st.count + 1 });
  }
  return out;
}

/** 读取配置（前端 select 存的是字符串，统一在这里转数字 + 兜底默认） */
export function readSettings(config = {}) {
  const d = CREDIT_EXPIRY_DEFAULTS;
  const int = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  return {
    enabled: config.creditExpiryNotify !== false && config.creditExpiryNotify !== 'false',
    time: /^\d{1,2}:\d{2}$/.test(String(config.creditExpiryNotifyTime || ''))
      ? String(config.creditExpiryNotifyTime) : d.creditExpiryNotifyTime,
    advanceDays: int(config.creditExpiryNotifyDays, d.creditExpiryNotifyDays, 0, 365),
    maxReminders: int(config.creditExpiryMaxReminders, d.creditExpiryMaxReminders, 1, 100),
  };
}

// ==================================================================
// 取数区（只读远端）
// ==================================================================

/**
 * 拉取某账号的「到期批次」。
 * 数据源优先级：provider.getPackages()（三个平台都已实现）→ getTotalCredits()（老 Trae 兜底）。
 * @returns {Promise<{source:string, batches:Array, packs:Array, total:number}>}
 */
export async function fetchCreditExpiryBatches(task, { timezone } = {}) {
  const provider = getProvider(task.providerId);
  if (!provider) throw new Error(`未知 provider: ${task.providerId}`);
  const tz = timezone || (task.config && task.config.timezone) || 'Asia/Shanghai';

  let items = [];
  let source = '';
  let total = null;
  if (typeof provider.getPackages === 'function') {
    const r = (await provider.getPackages(task)) || {};
    items = Array.isArray(r.list) ? r.list : [];
    total = typeof r.total === 'number' ? r.total : null;
    source = 'getPackages';
  } else if (typeof provider.getTotalCredits === 'function') {
    const r = (await provider.getTotalCredits(task)) || {};
    items = Array.isArray(r.packs) ? r.packs : [];
    total = typeof r.total === 'number' ? r.total : null;
    source = 'getTotalCredits';
  } else {
    const e = new Error('该平台未提供权益包/积分明细接口，无法计算到期时间');
    e.kind = 'transient';
    throw e;
  }

  const packs = [];
  for (const it of items) {
    const p = normalizePack(it);
    if (p) packs.push(p);
  }
  return { source, batches: groupBatches(packs, tz), packs, total };
}

// ==================================================================
// 执行区
// ==================================================================

function fmtLocal(ts, timezone) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}

function fmtAmount(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

/** 组装一封提醒邮件（导出以便单测断言内容） */
export function buildReminderMail({ task, platName, batch, daysLeft, index, maxReminders, advanceDays, timezone }) {
  const left = daysLeft <= 0 ? '今天就到期' : `还有 ${daysLeft} 天`;
  const subject = `[提醒] ${task.name} 有积分将于 ${batch.key} 过期（${left}）`;
  const lines = [];
  lines.push(`账号 ${task.name}（${platName}）有 ${fmtAmount(batch.amount)} 积分将于 ${batch.key} 到期，${left}。`);
  lines.push('');
  lines.push('到期明细：');
  const shown = batch.packs.slice(0, 20);
  for (const p of shown) {
    lines.push(`  - ${p.name}：${fmtAmount(p.remain)}${p.size ? ` / ${fmtAmount(p.size)}` : ''}`);
  }
  if (batch.packs.length > shown.length) {
    lines.push(`  - …… 另有 ${batch.packs.length - shown.length} 个同日到期的小包`);
  }
  lines.push('');
  lines.push(`到期时刻：${fmtLocal(batch.expireAtMs, timezone)}（账号时区 ${timezone}）`);
  lines.push(`提醒设置：提前 ${advanceDays} 天开始，最多提醒 ${maxReminders} 次（这是第 ${index} 次）。`);
  if (index >= maxReminders) lines.push('已达提醒次数上限，该批次后续不再提醒。');
  lines.push('');
  lines.push('请在此之前使用，避免额度过期作废。');
  lines.push('如不想收到此提醒，可在签到页编辑该账号 →「积分过期提醒」里关闭。');
  return { subject, body: lines.join('\n') };
}

/**
 * 对单个任务跑一次积分过期检查（到点才发信）。
 *
 * @param {object} task
 * @param {object} [opts]
 * @param {number} [opts.now]     注入当前时间（单测用）
 * @param {Function} [opts.send]  注入发信函数（单测用）
 * @param {Function} [opts.persist] 注入落盘函数（单测用）
 * @returns {Promise<{skipped?:string, sent:Array, batches?:Array, error?:string}>}
 */
export async function runCreditExpiryCheck(task, opts = {}) {
  const now = opts.now || Date.now();
  const send = opts.send || sendMail;
  const persist = opts.persist || (() => {});
  const cfg = task.config || {};
  const st = readSettings(cfg);

  if (!st.enabled) return { skipped: 'notify_off', sent: [] };
  if (task.enabled === false) return { skipped: 'disabled', sent: [] };
  if (task.credentialInvalid) return { skipped: 'credential_invalid', sent: [] };

  const timezone = cfg.timezone || 'Asia/Shanghai';
  // 未到今天的提醒时刻不发（调度器本来就按点触发，这层是防止手动调用时提前发）
  if (opts.ignoreTime !== true && tzClock(now, timezone) < st.time) {
    return { skipped: 'before_time', sent: [] };
  }

  let fetched;
  try {
    fetched = await fetchCreditExpiryBatches(task, { timezone });
  } catch (err) {
    return { skipped: 'fetch_failed', error: err && err.message, kind: err && err.kind, sent: [] };
  }

  const todayKey = tzDayKey(now, timezone);
  const state = (task.creditExpiryState && typeof task.creditExpiryState === 'object')
    ? task.creditExpiryState
    : (task.creditExpiryState = {});

  const plan = planReminders({
    batches: fetched.batches,
    todayKey,
    advanceDays: st.advanceDays,
    maxReminders: st.maxReminders,
    state,
  });

  const platName = (getProvider(task.providerId) || {}).name || '该平台';
  const sent = [];
  for (const item of plan) {
    const mail = buildReminderMail({
      task, platName, batch: item.batch, daysLeft: item.daysLeft, index: item.index,
      maxReminders: st.maxReminders, advanceDays: st.advanceDays, timezone,
    });
    try {
      await send(mail.subject, mail.body);
    } catch {
      // 发信失败不推进计数，下次到点重试
      continue;
    }
    state[item.batch.key] = {
      count: item.index,
      lastDay: todayKey,
      lastSentAt: now,
      amount: item.batch.amount,
    };
    sent.push({ key: item.batch.key, daysLeft: item.daysLeft, index: item.index, amount: item.batch.amount });
  }

  // 清理：已过期 / 已消失的批次不再占位（否则新周期的同日期包会被旧计数卡住）
  const live = new Set(fetched.batches.map((b) => b.key));
  for (const k of Object.keys(state)) if (!live.has(k)) delete state[k];

  if (sent.length) persist(task);
  return { sent, batches: fetched.batches, source: fetched.source, todayKey, settings: st };
}

/**
 * 为单个任务启动「每天固定时刻检查积分过期」的调度器。
 * 复用 lib/checkin/scheduler.js 的 startScheduler（与时区无关的按天触发，签到调度也用它）。
 *
 * @param {object} task
 * @param {object} [opts]
 * @param {Function} [opts.persist] 落盘回调（由 lib/tasks/index.js 注入，避免本模块反向依赖它）
 * @returns {{stop:Function, next:number}|null} 未启用时返回 null
 */
export function startCreditExpiryScheduler(task, opts = {}) {
  const st = readSettings(task.config || {});
  if (!st.enabled) return null;
  const persist = opts.persist || (() => {});
  const timezone = (task.config && task.config.timezone) || 'Asia/Shanghai';
  return startScheduler({
    timeStr: st.time,
    timezone,
    onTick: async () => {
      try {
        await runCreditExpiryCheck(task, { persist, ignoreTime: true });
      } catch {
        // 单次失败不影响后续调度（startScheduler 内部会继续排下一次）
      }
    },
  });
}
