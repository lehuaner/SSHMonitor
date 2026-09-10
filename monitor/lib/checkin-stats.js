/**
 * 每日积分快照与消耗统计。
 * 每天零点记录每个账号当前的"总积分"（所有权益包剩余之和），
 * 据此计算每个账号的每日消耗与平均每日消耗，以及所有账号的总每日消耗。
 */
import { loadJSON, saveJSON, DATA_DIR } from './utils.js';
import { getTasks, getTotalCreditsForTask } from './tasks/index.js';
import { getProvider } from './providers/index.js';
import { startScheduler } from './checkin/scheduler.js';

const STATS_FILE = DATA_DIR + '/checkin_stats.json';
const MAX_DAYS = 30;
// 积分功能今年6月上线，用量统计从当年6月1日（或近200天）开始回溯
const USAGE_MAX_DAYS = 200;

function todayStr(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function loadStats() {
  return loadJSON(STATS_FILE, { snapshots: [] });
}
export function saveStats(stats) {
  saveJSON(STATS_FILE, stats);
}

/**
 * 记录一次快照（当天去重，覆盖）。逐个账号查询总积分，失败/无效的账号跳过。
 * @returns {object} 本次写入的快照 { date, ts, tasks }
 */
export async function recordSnapshot() {
  const stats = loadStats();
  const date = todayStr();
  stats.snapshots = stats.snapshots.filter((s) => s.date !== date);
  const entry = { date, ts: Date.now(), tasks: {} };
  for (const task of getTasks()) {
    if (!task.enabled || task.credentialInvalid) continue;
    try {
      const res = await getTotalCreditsForTask(task.id);
      if (res.ok && typeof res.total === 'number') {
        entry.tasks[task.id] = { name: task.name, total: res.total };
      }
    } catch {
      // 网络/上游异常：跳过该账号，保留历史快照
    }
  }
  stats.snapshots.push(entry);
  const cutoff = todayStr(Date.now() - MAX_DAYS * 86400000);
  stats.snapshots = stats.snapshots.filter((s) => s.date >= cutoff);
  saveStats(stats);
  return entry;
}

/**
 * 计算统计：
 *   - 每个账号：每日消耗序列（相邻快照的净减少，取非负）+ 平均每日消耗
 *   - 总计：按日期聚合所有账号消耗 + 平均每日总消耗
 */
export function getStats() {
  const stats = loadStats();
  const snapshots = [...stats.snapshots].sort((a, b) => (a.date < b.date ? -1 : 1));

  // 聚合所有账号
  const accounts = new Map(); // taskId -> { id, name, points:[] }
  for (const s of snapshots) {
    for (const [id, t] of Object.entries(s.tasks)) {
      if (!accounts.has(id)) accounts.set(id, { id, name: t.name, points: [] });
      accounts.get(id).points.push({ date: s.date, total: t.total });
    }
  }

  const resultAccounts = [];
  const totalByDate = {};
  for (const acc of accounts.values()) {
    acc.points.sort((a, b) => (a.date < b.date ? -1 : 1));
    const deltas = [];
    for (let i = 1; i < acc.points.length; i++) {
      const prev = acc.points[i - 1].total;
      const cur = acc.points[i].total;
      const consumption = Math.max(0, prev - cur);
      deltas.push({ date: acc.points[i].date, consumption });
    }
    const sum = deltas.reduce((a, d) => a + d.consumption, 0);
    resultAccounts.push({
      id: acc.id,
      name: acc.name,
      points: acc.points,
      deltas,
      avgDailyConsumption: deltas.length ? sum / deltas.length : null,
    });
    for (const d of deltas) totalByDate[d.date] = (totalByDate[d.date] || 0) + d.consumption;
  }

  const totalDeltas = Object.entries(totalByDate)
    .map(([date, consumption]) => ({ date, consumption }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const totalSum = totalDeltas.reduce((a, d) => a + d.consumption, 0);

  return {
    accounts: resultAccounts,
    total: {
      byDate: totalDeltas,
      avgDailyConsumption: totalDeltas.length ? totalSum / totalDeltas.length : null,
    },
  };
}

/** 启动每日零点快照（Asia/Shanghai），返回 { stop } */
export function startDailySnapshot() {
  return startScheduler({
    timeStr: '00:00',
    timezone: 'Asia/Shanghai',
    onTick: async () => {
      try {
        const entry = await recordSnapshot();
        console.log('[checkin-stats] 零点快照完成:', entry.date, Object.keys(entry.tasks).length, '个账号');
      } catch (e) {
        console.error('[checkin-stats] 零点快照失败:', e.message);
      }
      // 自动补齐昨日消耗（昨天已成为过去日期）
      try {
        const r = await updateUsageStats();
        console.log('[checkin-stats] 零点用量落库完成:', JSON.stringify(r));
      } catch (e) {
        console.error('[checkin-stats] 零点用量落库失败:', e.message);
      }
    },
  });
}

// ====== 基于实际消耗查询的每日统计（落库） ======
// 直接调用上游按会话口（usage_type=[7]）拉取每个过去日期的实际消耗，
// 按 日期 + 模型 聚合后落库。当天不落库。

const USAGE_STATS_FILE = DATA_DIR + '/checkin_usage_stats.json';
const TZ = 'Asia/Shanghai';

function loadUsageStats() {
  return loadJSON(USAGE_STATS_FILE, { updatedAt: 0, accounts: {} });
}
function saveUsageStats(stats) {
  saveJSON(USAGE_STATS_FILE, stats);
}

/** 时间戳(ms) -> YYYY-MM-DD（Asia/Shanghai） */
function fmtDate(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}
/** YYYY-MM-DD -> 上海当天 0 点的 epoch 秒 */
function dateToSec(str) {
  const [y, m, d] = str.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) - 8 * 3600;
}
/** 秒级时间戳 -> YYYY-MM-DD（Asia/Shanghai） */
function secToDate(sec) {
  return fmtDate((sec || 0) * 1000);
}

/** 从会话对象中取出消耗的 token 数。上游将 token 放在 extra_info 子对象中（可能为对象或 JSON 字符串）。 */
function sessionTokens(s) {
  let ei = s && s.extra_info;
  if (!ei) return 0;
  if (typeof ei === 'string') {
    try { ei = JSON.parse(ei); } catch { return 0; }
  }
  return (ei.input_token || 0) + (ei.output_token || 0);
}

/**
 * 拉取账号在 [startSec, endSec] 内的全部会话（分页，page_size=50）。
 * @returns {Promise<Array>} 会话列表
 */
async function fetchSessions(provider, task, startSec, endSec) {
  const pageSize = 50;
  const sessions = [];
  let pageNum = 1, total = 0;
  for (;;) {
    const res = await provider.getUsage(task, {
      start_time: startSec,
      end_time: endSec,
      page_size: pageSize,
      page_num: pageNum,
      usage_type: [7],
    });
    const list = (res && res.user_usage_group_by_sessions) || [];
    sessions.push(...list);
    total = res ? (res.total ?? list.length) : list.length;
    if (sessions.length >= total || list.length < pageSize) break;
    pageNum++;
  }
  return sessions;
}

/**
 * 更新每日消耗统计：对每个账号，只查询落库中缺失且已过去的日期（不含当天），
 * 用最大范围一次拉取 + 分页，本地按 日期+模型 聚合后落盘。
 * @returns {{collected:number, noSupport:number, errors:number}}
 */
export async function updateUsageStats() {
  const TOKEN_VERSION = 2;
  // 旧落库数据无 token 信息：强制全量重拉（重建 accounts），以支持 token 消耗展示
  let stats = loadUsageStats();
  if (stats.tokenVersion !== TOKEN_VERSION) {
    stats = { updatedAt: 0, tokenVersion: TOKEN_VERSION, accounts: {} };
  }
  const tasks = getTasks();
  const now = Date.now();
  const today = fmtDate(now);
  // 回溯起点：当年6月1日（功能上线）与「近 USAGE_MAX_DAYS 天」取较晚者
  const curYear = fmtDate(now).slice(0, 4);
  const june1 = Date.parse(`${curYear}-06-01T00:00:00`);
  const startMs = now <= june1 ? now - USAGE_MAX_DAYS * 86400000 : june1;

  let collected = 0, noSupport = 0, errors = 0;

  for (const task of tasks) {
    if (!task.enabled || task.credentialInvalid) continue;
    const provider = getProvider(task.providerId);
    if (!provider || typeof provider.getUsage !== 'function') { noSupport++; continue; }

    const acc = stats.accounts[task.id] || (stats.accounts[task.id] = { name: task.name, days: {} });
    acc.name = task.name;

    // 需要补数据的过去日期（当天不补）
    const missing = [];
    for (let t = startMs; t < now; t += 86400000) {
      const d = fmtDate(t);
      if (d >= today) continue;
      if (!acc.days[d]) missing.push(d);
    }
    if (!missing.length) continue;

    const startSec = dateToSec(missing[0]);
    const endSec = dateToSec(missing[missing.length - 1]) + 86400 - 1;
    let sessions;
    try {
      sessions = await fetchSessions(provider, task, startSec, endSec);
    } catch (e) {
      errors++;
      continue; // 保留该账号已有数据，跳过本次
    }

    // 按 日期+模型 聚合积分与 token；仅处理缺失日期，当天不落
    const byDate = {}; // date -> model -> {credits, tokens}
    for (const s of sessions) {
      const d = secToDate(s.usage_time);
      if (d >= today || acc.days[d]) continue;
      const models = byDate[d] || (byDate[d] = {});
      const model = s.model_name || '未知模型';
      const mm = models[model] || (models[model] = { credits: 0, tokens: 0 });
      mm.credits += s.credits_float || 0;
      mm.tokens += sessionTokens(s);
    }
    for (const d of missing) {
      const byModel = byDate[d] || {};
      const models = {}, modelTokens = {};
      let totalC = 0, totalT = 0;
      for (const [m, v] of Object.entries(byModel)) {
        models[m] = v.credits;
        modelTokens[m] = v.tokens;
        totalC += v.credits;
        totalT += v.tokens;
      }
      acc.days[d] = { total: totalC, tokens: totalT, models, modelTokens };
      if (totalC > 0 || totalT > 0) collected++;
    }
  }

  stats.updatedAt = Date.now();
  saveUsageStats(stats);
  return { collected, noSupport, errors };
}

/**
 * 计算结果：
 *   - 每个账号：平均每日消耗（总）+ 各模型平均每日消耗 + 最近一日消耗
 *   - 总计：按日期聚合所有账号消耗 + 平均每日总消耗
 */
export function getUsageStats() {
  const stats = loadUsageStats();
  const accounts = [];
  const now = Date.now();
  const curYear = fmtDate(now).slice(0, 4);
  const curMonth = fmtDate(now).slice(0, 7); // YYYY-MM

  // 全账号按日聚合（含积分与 token）
  const dayAgg = {}; // date -> {total, tokens, models:{model:{credits,tokens}}}
  for (const [id, acc] of Object.entries(stats.accounts || {})) {
    for (const [date, d] of Object.entries(acc.days || {})) {
      const t = dayAgg[date] || (dayAgg[date] = { total: 0, tokens: 0, models: {} });
      t.total += d.total || 0;
      t.tokens += d.tokens || 0;
      for (const [model, v] of Object.entries(d.models || {})) {
        const m = t.models[model] || (t.models[model] = { credits: 0, tokens: 0 });
        m.credits += v;
        m.tokens += (d.modelTokens && d.modelTokens[model]) || 0;
      }
    }
  }
  const byDate = Object.entries(dayAgg)
    .map(([date, t]) => ({
      date,
      consumption: t.total,
      tokens: t.tokens,
      models: Object.fromEntries(Object.entries(t.models).map(([m, x]) => [m, { consumption: x.credits, tokens: x.tokens }])),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // 按月聚合（含积分与 token）
  const monthAgg = {}; // month -> {total, tokens, models:{model:{credits,tokens}}}
  for (const d of byDate) {
    const m = d.date.slice(0, 7);
    const t = monthAgg[m] || (monthAgg[m] = { total: 0, tokens: 0, models: {} });
    t.total += d.consumption;
    t.tokens += d.tokens;
    for (const [model, v] of Object.entries(d.models)) {
      const mm = t.models[model] || (t.models[model] = { credits: 0, tokens: 0 });
      mm.credits += v.consumption;
      mm.tokens += v.tokens;
    }
  }
  const months = Object.entries(monthAgg)
    .map(([month, t]) => ({
      month,
      total: t.total,
      tokens: t.tokens,
      models: Object.fromEntries(Object.entries(t.models).map(([m, x]) => [m, { consumption: x.credits, tokens: x.tokens }])),
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  // 各账号：年/月（积分+token） + 模型聚合
  for (const [id, acc] of Object.entries(stats.accounts || {})) {
    const days = Object.entries(acc.days || {})
      .map(([date, d]) => ({
        date,
        consumption: d.total || 0,
        tokens: d.tokens || 0,
        models: Object.fromEntries(Object.entries(d.models || {}).map(([m, v]) => [m, { consumption: v, tokens: (d.modelTokens && d.modelTokens[m]) || 0 }])),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    let yearTotal = 0, monthTotal = 0, tokensYear = 0, tokensMonth = 0, sumC = 0, sumT = 0, dayCount = 0;
    let netCDays = 0, netTDays = 0; // 有积分/token 消耗的天数
    const netCMonths = new Set(), netTMonths = new Set(); // 有积分/token 消耗的月份
    const modelAgg = {};
    for (const [date, d] of Object.entries(acc.days || {})) {
      const total = d.total || 0, tokens = d.tokens || 0;
      dayCount++;
      sumC += total;
      sumT += tokens;
      if (total > 0) { netCDays++; netCMonths.add(date.slice(0, 7)); }
      if (tokens > 0) { netTDays++; netTMonths.add(date.slice(0, 7)); }
      if (date.slice(0, 4) === curYear) { yearTotal += total; tokensYear += tokens; }
      if (date.slice(0, 7) === curMonth) { monthTotal += total; tokensMonth += tokens; }
      for (const [model, v] of Object.entries(d.models || {})) {
        const m = modelAgg[model] || (modelAgg[model] = { credits: 0, tokens: 0, cYear: 0, cMonth: 0, tYear: 0, tMonth: 0, cDays: 0, tDays: 0, cMonths: new Set(), tMonths: new Set() });
        const tv = (d.modelTokens && d.modelTokens[model]) || 0;
        m.credits += v; m.tokens += tv;
        if (v > 0) { m.cDays++; m.cMonths.add(date.slice(0, 7)); }
        if (tv > 0) { m.tDays++; m.tMonths.add(date.slice(0, 7)); }
        if (date.slice(0, 4) === curYear) { m.cYear += v; m.tYear += tv; }
        if (date.slice(0, 7) === curMonth) { m.cMonth += v; m.tMonth += tv; }
      }
    }
    const models = Object.entries(modelAgg)
      .map(([model, d]) => ({
        model,
        consumption: d.credits,
        tokens: d.tokens,
        yearTotal: d.cYear, monthTotal: d.cMonth,
        tokensYearTotal: d.tYear, tokensMonthTotal: d.tMonth,
        avgDailyConsumption: dayCount ? d.credits / dayCount : null,
        avgDailyTokens: dayCount ? d.tokens / dayCount : null,
        netDailyConsumption: d.cDays ? d.credits / d.cDays : null,
        netDailyTokens: d.tDays ? d.tokens / d.tDays : null,
        netMonthlyConsumption: d.cMonths.size ? d.credits / d.cMonths.size : null,
        netMonthlyTokens: d.tMonths.size ? d.tokens / d.tMonths.size : null,
      }))
      .sort((a, b) => b.consumption - a.consumption);

    const lastDay = days.length ? days[days.length - 1] : null;
    accounts.push({
      id,
      name: acc.name,
      days,
      yearTotal,
      monthTotal,
      tokensYearTotal: tokensYear,
      tokensMonthTotal: tokensMonth,
      avgDailyConsumption: dayCount ? sumC / dayCount : null,
      avgDailyTokens: dayCount ? sumT / dayCount : null,
      netDailyAvgConsumption: netCDays ? sumC / netCDays : null,
      netDailyAvgTokens: netTDays ? sumT / netTDays : null,
      netMonthlyAvgConsumption: netCMonths.size ? sumC / netCMonths.size : null,
      netMonthlyAvgTokens: netTMonths.size ? sumT / netTMonths.size : null,
      lastConsumption: lastDay ? { date: lastDay.date, total: lastDay.consumption, tokens: lastDay.tokens } : null,
      models,
    });
  }

  const totalSum = byDate.reduce((a, d) => a + d.consumption, 0);
  const totalTokens = byDate.reduce((a, d) => a + d.tokens, 0);
  // 净日均/净月均：只统计有消耗的天/月
  const netDaysC = byDate.filter((d) => d.consumption > 0).length;
  const netDaysT = byDate.filter((d) => d.tokens > 0).length;
  const netMonthsC = new Set(byDate.filter((d) => d.consumption > 0).map((d) => d.date.slice(0, 7))).size;
  const netMonthsT = new Set(byDate.filter((d) => d.tokens > 0).map((d) => d.date.slice(0, 7))).size;
  const yearTotal = byDate.filter((d) => d.date.slice(0, 4) === curYear).reduce((a, d) => a + d.consumption, 0);
  const yearTokens = byDate.filter((d) => d.date.slice(0, 4) === curYear).reduce((a, d) => a + d.tokens, 0);
  const monthTotal = byDate.filter((d) => d.date.slice(0, 7) === curMonth).reduce((a, d) => a + d.consumption, 0);
  const monthTokens = byDate.filter((d) => d.date.slice(0, 7) === curMonth).reduce((a, d) => a + d.tokens, 0);

  // 跨账号汇总模型（积分/token 年/月/总）
  const totalModelAgg = {};
  for (const a of accounts) {
    for (const m of a.models) {
      const t = totalModelAgg[m.model] || (totalModelAgg[m.model] = { cYear: 0, cMonth: 0, credits: 0, tYear: 0, tMonth: 0, tokens: 0 });
      t.credits += m.consumption;
      t.tokens += m.tokens;
      t.cYear += m.yearTotal; t.cMonth += m.monthTotal;
      t.tYear += m.tokensYearTotal; t.tMonth += m.tokensMonthTotal;
    }
  }
  const totalModels = Object.entries(totalModelAgg)
    .map(([model, d]) => ({ model, consumption: d.credits, tokens: d.tokens, yearTotal: d.cYear, monthTotal: d.cMonth, tokensYearTotal: d.tYear, tokensMonthTotal: d.tMonth }))
    .sort((a, b) => b.consumption - a.consumption);

  return {
    accounts,
    total: {
      byDate,
      months,
      yearTotal,
      monthTotal,
      tokensYearTotal: yearTokens,
      tokensMonthTotal: monthTokens,
      avgDailyConsumption: byDate.length ? totalSum / byDate.length : null,
      avgDailyTokens: byDate.length ? totalTokens / byDate.length : null,
      netDailyAvgConsumption: netDaysC ? totalSum / netDaysC : null,
      netDailyAvgTokens: netDaysT ? totalTokens / netDaysT : null,
      netMonthlyAvgConsumption: netMonthsC ? totalSum / netMonthsC : null,
      netMonthlyAvgTokens: netMonthsT ? totalTokens / netMonthsT : null,
      models: totalModels,
    },
  };
}

/**
 * 在 getUsageStats() 基础上叠加"预估可用天数"：
 *   预估可用天数 = 剩余可用积分 / (平均每日使用积分 − 平均每日签到积分)
 * 数据来源（均为实时，单次调用 provider.getTotalCredits 顺带取得）：
 *   - 剩余可用积分：res.total（所有权益包剩余之和）
 *   - 每日签到记录：res.checkins[] = { date, credits, ... }
 * 平均每日签到积分：近 checkinDays 天中「有签到（credits>0）」的天数作分母求均值，
 *   签到积分为 0 的日子不计入分母，避免稀释均值。
 * 单账号：净日耗(使用−签到) > 0 时 est=剩余/净日耗；≤0 时 est='充足'；缺数据 est=null。
 * 总账号：Σ剩余 / Σ(平均每日使用 − 平均每日签到)。
 */
export async function getUsageStatsWithEstimates(checkinDays = 30, recentDays = 10) {
  const base = getUsageStats();
  const tasks = getTasks();
  let totalRemaining = 0;
  let totalNetRate = 0;       // 全尺度净日耗汇总
  let totalNetRate10 = 0;     // 近 N 天尺度净日耗汇总
  let totalCheckinAccs = 0;
  let totalCheckinSum = 0;
  let totalCheckin10Accs = 0;
  let totalCheckin10Sum = 0;

  // 近 N 天「有消耗日」的净日均（窗口内可能不足 N 天，按实际有消耗日求均值）
  const netDailyLastN = (days, n) => {
    const tail = (days || []).slice(-n).filter((d) => d.consumption > 0);
    if (!tail.length) return null;
    return tail.reduce((s, d) => s + d.consumption, 0) / tail.length;
  };

  for (const a of base.accounts) {
    const task = tasks.find((t) => t.id === a.id);
    let remaining = null;
    let avgCheckin = null;
    let avgCheckin10 = null;
    if (task && task.enabled && !task.credentialInvalid) {
      try {
        const res = await getTotalCreditsForTask(a.id);
        if (res && res.ok !== false && typeof res.total === 'number') {
          remaining = res.total;
          // 签到积分：仅统计「有签到（credits>0）」的日子，0 分签到不计入分母
          const cs = (res.checkins || [])
            .filter((c) => c.date && typeof c.credits === 'number' && c.credits > 0)
            .sort((x, y) => (x.date < y.date ? -1 : 1));
          const csAll = cs.slice(-checkinDays);
          if (csAll.length) {
            avgCheckin = csAll.reduce((s, c) => s + c.credits, 0) / csAll.length;
            totalCheckinAccs += 1;
            totalCheckinSum += avgCheckin;
          }
          const cs10 = cs.slice(-recentDays);
          if (cs10.length) {
            avgCheckin10 = cs10.reduce((s, c) => s + c.credits, 0) / cs10.length;
            totalCheckin10Accs += 1;
            totalCheckin10Sum += avgCheckin10;
          }
        }
      } catch {
        // 网络/上游异常：保留该账号其余统计，预估字段置 null
      }
    }

    // 全尺度：分母「平均每日使用」用净日均(netDailyAvgConsumption)
    const avgUsage = a.netDailyAvgConsumption;
    let est = null;
    if (remaining != null && avgUsage != null) {
      const net = avgUsage - (avgCheckin || 0);
      est = net > 0 ? remaining / net : '充足';
    }
    // 近 N 天尺度
    const avgUsage10 = netDailyLastN(a.days, recentDays);
    let est10 = null;
    if (remaining != null && avgUsage10 != null) {
      const net10 = avgUsage10 - (avgCheckin10 || 0);
      est10 = net10 > 0 ? remaining / net10 : '充足';
    }

    a.remainingCredits = remaining;
    a.avgDailyCheckin = avgCheckin;
    a.avgDailyCheckin10d = avgCheckin10;
    a.estimatedDays = est;
    a.estimatedDays10d = est10;

    // 总账号：净日均为 null 时按 0 计（用户要求，避免无消耗账号被排除而失真）
    if (remaining != null) {
      totalRemaining += remaining;
      totalNetRate += (avgUsage || 0) - (avgCheckin || 0);
      totalNetRate10 += (avgUsage10 || 0) - (avgCheckin10 || 0);
    }
  }

  base.total.remainingCredits = totalRemaining;
  base.total.avgDailyCheckin = totalCheckinAccs ? totalCheckinSum / totalCheckinAccs : null;
  base.total.avgDailyCheckin10d = totalCheckin10Accs ? totalCheckin10Sum / totalCheckin10Accs : null;
  base.total.netDailyAvgConsumption10d = netDailyLastN(base.total.byDate, recentDays);
  base.total.estimatedDays =
    totalNetRate > 0 ? totalRemaining / totalNetRate : totalRemaining > 0 ? '充足' : null;
  base.total.estimatedDays10d =
    totalNetRate10 > 0 ? totalRemaining / totalNetRate10 : totalRemaining > 0 ? '充足' : null;
  return base;
}

/**
 * 删除某个账号的全部统计落库数据（消耗统计 + 每日积分快照）。
 * 账号被删除后，若不清除这些数据，浮层/统计面板仍会展示该账号残留记录。
 */
export function removeTaskStats(id) {
  if (!id) return;
  // 消耗统计（checkin_usage_stats.json）
  let usage = loadUsageStats();
  if (usage.accounts && usage.accounts[id]) {
    delete usage.accounts[id];
    saveUsageStats(usage);
  }
  // 每日积分快照（checkin_stats.json）
  const stats = loadStats();
  let changed = false;
  for (const s of stats.snapshots) {
    if (s.tasks && s.tasks[id]) {
      delete s.tasks[id];
      changed = true;
    }
  }
  if (changed) saveStats(stats);
}