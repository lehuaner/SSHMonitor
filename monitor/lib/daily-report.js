/**
 * 每日日报（设备运行状况日报）。
 *
 * ── 定位 ──
 *   取代旧的「按账号、按到期批次逐封发」的积分过期提醒：每天在固定时刻（默认 23:30，
 *   设备时区 Asia/Shanghai）只发**一封**邮件，汇总当天设备整体运行状况。
 *
 * ── 为什么调度只跑在 gateway 进程 ──
 *   日报要同时读代理连通数据（notify.js / proxy_check.log，gateway 侧）与签到/积分
 *   数据（tasks / providers / checkin-stats，checkin 侧的 lib，但 gateway 也 import）。
 *   只有 gateway 能一站取全。故本模块的调度器**只在 server.js 启动一次**，mod-checkin
 *   不启动它 —— 从根上消除旧「双进程各跑一份 scheduler → 同一事件成倍发信」的问题。
 *
 * ── 七大块 ──
 *   ① 积分过期（过期额 / 总余额）   —— 复用 credit-expiry.fetchCreditExpiryBatches
 *   ② 代理连通（在线时长 / 连通率）  —— 读 proxy_check.log + node_switch.log
 *   ③ 签到情况（成功数 / 应签数）    —— 读 checkin-log + tasks
 *   ④ 凭证维护日历（该维护人的日子）  —— credential-expiry.getMaintenanceExpiry（★与面板卡片同一口径）
 *   ⑤ 设备健康（开机/内存/磁盘/电池/CPU）—— metrics()
 *   ⑥ 积分消耗与预估可用天数         —— checkin-stats.getUsageStatsWithEstimates()
 *   ⑦ 当日告警事件汇总               —— alert-events.getTodayAlerts()
 *   每块独立 try/catch：某块取数失败只在该段显示错误占位，绝不拖垮整封日报。
 *
 * ── 高危即时件仍单独发 ──
 *   凭证失效 / 所有候选节点失效 等仍由各自逻辑即时 sendMail（[告警] 前缀），
 *   并被 alert-events 记入第⑥块，日报里再做当日汇总。
 */
import { loadJSON, saveJSON, DATA_DIR, HOME, fetchJson, pickProxyNode } from './utils.js';
import { mailConfig, sendMail } from './notify.js';
import { getTasks } from './tasks/index.js';
import { getProvider } from './providers/index.js';
import { fetchCreditExpiryBatches, tzDayKey, diffDays } from './checkin/credit-expiry.js';
import { getMaintenanceExpiry } from './credential-expiry.js';
import { getLogs } from './checkin-log.js';
import { getUsageStatsWithEstimates } from './checkin-stats.js';
import { metrics } from './metrics.js';
import { getTodayAlerts } from './alert-events.js';
import { readLogTail } from './logger.js';
import { startScheduler } from './checkin/scheduler.js';

const DEFAULT_TZ = 'Asia/Shanghai';
const DEFAULT_REPORT = { enabled: true, time: '23:30', timezone: DEFAULT_TZ, lookahead_days: 30 };

/** 读取（合并默认后的）日报配置 */
export function readReportConfig() {
  const c = (mailConfig && mailConfig.daily_report) || {};
  const int = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
  };
  return {
    enabled: c.enabled !== false && c.enabled !== 'false',
    time: /^\d{1,2}:\d{2}$/.test(String(c.time || '')) ? String(c.time) : DEFAULT_REPORT.time,
    timezone: c.timezone || DEFAULT_TZ,
    lookahead_days: int(c.lookahead_days, DEFAULT_REPORT.lookahead_days, 1, 365),
  };
}

function fmtBeijing(ts, tz = DEFAULT_TZ) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 100) / 100;
  return r.toLocaleString('zh-CN');
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 分钟';
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} 天 ${h % 24} 小时`;
  if (h > 0) return `${h} 小时 ${min % 60} 分钟`;
  return `${min} 分钟`;
}

/** 北京时间自然日键 */
function beijingDayKey(ts, tz) {
  return tzDayKey(ts, tz || DEFAULT_TZ);
}

/** 指定时区的 HH:mm（区间展示用） */
function fmtClock(ts, tz = DEFAULT_TZ) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts));
  } catch {
    return '';
  }
}

/**
 * 把按时序排列的 [{t, ok}] 状态采样聚合成连续区间。
 * 相邻同状态合并；每段结束时刻取下一段开始时刻，最后一段结束到 now。
 * @returns {{ok:boolean,startT:number,endT:number,count:number}[]}
 */
function buildStateIntervals(samples, now) {
  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last.ok === s.ok) { last.endT = s.t; last.count++; }
    else runs.push({ ok: s.ok, startT: s.t, endT: s.t, count: 1 });
  }
  for (let i = 0; i < runs.length - 1; i++) runs[i].endT = runs[i + 1].startT;
  if (runs.length) runs[runs.length - 1].endT = now;
  return runs;
}

// ==================================================================
// 各数据块（每块返回若干文本行；异常由调用方 try/catch 兜底）
// ==================================================================

/** ① 积分过期（过期额 / 总余额） */
async function sectionCreditExpiry(cfg, now) {
  const lines = [];
  const tasks = getTasks().filter((t) => t.enabled && !t.credentialInvalid);
  if (!tasks.length) return ['（无启用账号）'];
  let totalRemaining = 0;
  let totalExpiring = 0;
  const perAccount = [];
  for (const t of tasks) {
    try {
      const { batches, total } = await fetchCreditExpiryBatches(t);
      const rem = Number.isFinite(total) ? total : (Number.isFinite(t.totalCredits) ? t.totalCredits : null);
      if (rem != null) totalRemaining += rem;
      const todayKey = beijingDayKey(now, cfg.timezone);
      const upcoming = [];
      for (const b of batches || []) {
        const daysLeft = diffDays(todayKey, b.key);
        if (daysLeft >= 0 && daysLeft <= cfg.lookahead_days) {
          upcoming.push({ key: b.key, amount: b.amount, daysLeft });
          totalExpiring += b.amount;
        }
      }
      upcoming.sort((a, b) => a.daysLeft - b.daysLeft);
      if (upcoming.length) {
        const acctExpiring = upcoming.reduce((s, x) => s + x.amount, 0);
        perAccount.push({ name: t.name, plat: (getProvider(t.providerId) || {}).name || t.providerId, rem, acctExpiring, upcoming });
      }
    } catch (e) {
      perAccount.push({ name: t.name, error: e && e.message });
    }
  }
  lines.push(`未来 ${cfg.lookahead_days} 天内将过期：${fmtNum(totalExpiring)} / 当前总余额 ${fmtNum(totalRemaining)}`);
  if (!perAccount.length) {
    lines.push('✓ 各账号在窗口内均无即将过期积分');
  } else {
    for (const a of perAccount) {
      if (a.error) { lines.push(`· ${a.name}：取数失败（${a.error}）`); continue; }
      lines.push(`· ${a.name}（${a.plat}）：过期 ${fmtNum(a.acctExpiring)} / 余额 ${fmtNum(a.rem)}`);
      for (const u of a.upcoming.slice(0, 5)) {
        lines.push(`    - ${u.key}（${u.daysLeft <= 0 ? '今天' : u.daysLeft + ' 天后'}）到期：${fmtNum(u.amount)}`);
      }
      if (a.upcoming.length > 5) lines.push(`    - …… 另有 ${a.upcoming.length - 5} 个到期批次`);
    }
  }
  return lines;
}

/** ② 代理连通（在线时长 / 连通率 / 按检测网站分别 / 按实际承载节点） */
async function sectionProxy(cfg, now) {
  const lines = [];
  const pc = (mailConfig && mailConfig.proxy_check) || {};
  const todayKey = beijingDayKey(now, cfg.timezone);
  const okCodes = new Set([200, 204, 301, 302, 307, 308, 401, 403]);
  const raw = readLogTail(HOME + '/logs/monitor/proxy_check.log', 5000);

  // 单次遍历：按轮(__start__..__done__)聚合，保留每轮各节点连通结果 nodeOkMap，同时统计节点级、网站级
  let nodeTotal = 0, nodeOk = 0;
  const siteStat = {};   // url -> { total, ok }
  const rounds = [];     // { t, anyOk, nodeOkMap }  —— anyOk=该轮是否有任一候选节点可用
  let cur = null;
  let lastOk = null, lastTs = null;
  const flushRound = (t) => { if (cur && cur.hasNode) rounds.push({ t, anyOk: cur.anyOk, nodeOkMap: cur.nodeOkMap }); cur = null; };

  for (const line of raw) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.timestamp) continue;
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (beijingDayKey(t, cfg.timezone) !== todayKey) continue;
    if (e.node === '__start__') { flushRound(t); cur = { anyOk: false, hasNode: false, nodeOkMap: {} }; continue; }
    if (e.node === '__done__') { flushRound(t); continue; }
    if (e.node === '__error__' || e.node === '__refresh__' || e.node === '__refresh_error__') continue;
    if (typeof e.ok !== 'boolean') continue;
    if (!cur) cur = { anyOk: false, hasNode: false, nodeOkMap: {} };
    cur.hasNode = true;
    cur.nodeOkMap[e.node] = e.ok;
    if (e.ok) cur.anyOk = true;
    nodeTotal++; if (e.ok) nodeOk++;
    lastOk = e.ok; lastTs = e.timestamp;
    for (const u of (e.urls || [])) {
      if (!u || !u.url) continue;
      const s = siteStat[u.url] || (siteStat[u.url] = { total: 0, ok: 0 });
      s.total++; if (okCodes.has(u.status)) s.ok++;
    }
  }
  flushRound(now);

  if (nodeTotal === 0) {
    lines.push('今日无连通性检测记录（代理检测未启用或尚无数据）');
    return lines;
  }
  rounds.sort((a, b) => a.t - b.t);

  // 读 node_switch 今日记录，为每轮关联「检测结束时实际停靠的承载节点」
  const swRaw = readLogTail(HOME + '/logs/monitor/node_switch.log', 3000);
  const sw = [];
  for (const line of swRaw) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.timestamp) continue;
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (beijingDayKey(t, cfg.timezone) !== todayKey) continue;
    sw.push({ t, current_node: e.current_node, decision: e.decision, new_node: e.new_node });
  }
  sw.sort((a, b) => a.t - b.t);

  // 每轮停靠节点 = 检测结束后「节点选择」实际选中的节点：A_keep_current→current_node，其余→new_node(无则 current_node)
  // 与 round 配对：取 t >= 本轮 done 时刻且最近的一条 switch（switch 紧随该轮之后写入）
  const docked = rounds.map(r => {
    let best = null;
    for (const s of sw) { if (s.t >= r.t - 1000 && (!best || s.t < best.t)) best = s; }
    let node = '';
    if (best) node = (best.decision === 'A_keep_current') ? best.current_node : (best.new_node || best.current_node);
    if (!node) node = '(未知)';
    const ok = r.nodeOkMap[node] === true;   // 停靠节点本轮明确通过才算该轮在线
    return { t: r.t, ok, node };
  });

  const roundTotal = rounds.length;
  const anyOkRounds = rounds.filter(r => r.anyOk).length;
  const availRate = roundTotal ? anyOkRounds / roundTotal : 0;   // 候选池可用率（保留对照）
  const dockedOkRounds = docked.filter(d => d.ok).length;
  const nodeRate = nodeOk / nodeTotal;

  // 连通区间：按 (停靠节点是否连通, 节点名) 分段——节点变化即断段，体现“不同时段不同节点”
  const runs = [];
  for (const s of docked) {
    const key = s.ok ? 'N:' + s.node : 'DOWN';
    const last = runs[runs.length - 1];
    if (last && last.key === key) { last.endT = s.t; last.count++; }
    else runs.push({ key, ok: s.ok, node: s.ok ? s.node : '', startT: s.t, endT: s.t, count: 1 });
  }
  for (let i = 0; i < runs.length - 1; i++) runs[i].endT = runs[i + 1].startT;
  if (runs.length) runs[runs.length - 1].endT = now;

  let onlineMs = 0, downMs = 0;
  const nodeCarry = {};   // node -> 承载(连通)时长 ms
  for (const r of runs) {
    const d = Math.max(0, r.endT - r.startT);
    if (r.ok) { onlineMs += d; nodeCarry[r.node] = (nodeCarry[r.node] || 0) + d; } else downMs += d;
  }

  lines.push(`今日检测 ${roundTotal} 轮 / ${nodeTotal} 次节点探测`);
  lines.push(`在线时长：${fmtDuration(onlineMs)}（按每轮实际停靠节点连通累计）　异常时长：${fmtDuration(downMs)}（该轮停靠节点不可用/全候选失效）`);
  lines.push(`实际停靠可用率 ${Math.round(dockedOkRounds / roundTotal * 100)}%（${dockedOkRounds}/${roundTotal} 轮停靠节点连通）　候选池可用率 ${Math.round(availRate * 100)}%（${anyOkRounds}/${roundTotal} 轮有可用节点，保留对照）`);
  lines.push(`节点级连通率 ${Math.round(nodeRate * 100)}%（通过 ${nodeOk}/${nodeTotal} 次；单节点任一网站可达即算通）`);
  lines.push(`最近一次检测：${fmtBeijing(Date.parse(lastTs), cfg.timezone)} ${lastOk ? '✓ 正常' : '✗ 异常'}`);

  // 按检测网站分别统计连通率
  const siteKeys = Object.keys(siteStat);
  if (siteKeys.length) {
    lines.push('各检测网站连通率（在所有节点探测中该网站可达占比）：');
    for (const url of siteKeys) {
      const s = siteStat[url];
      lines.push(`  · ${url}：${Math.round((s.ok / s.total) * 100)}%（${s.ok}/${s.total}）`);
    }
  }

  // 各节点承载（连通）时长
  const carryKeys = Object.keys(nodeCarry).sort((a, b) => nodeCarry[b] - nodeCarry[a]);
  if (carryKeys.length) {
    lines.push('今日各节点承载（连通）时长：');
    for (const n of carryKeys.slice(0, 8)) lines.push(`  · ${n}：${fmtDuration(nodeCarry[n])}`);
    if (carryKeys.length > 8) lines.push(`  · …… 另有 ${carryKeys.length - 8} 个节点`);
  }

  // 当前节点（修 GLOBAL：用 pickProxyNode 取「节点选择」组）
  try {
    const proxies = await fetchJson('http://127.0.0.1:9090/proxies');
    const node = pickProxyNode(proxies);
    if (node) lines.push(`当前节点：${node}`);
  } catch { /* 内核不可达则省略 */ }

  // 今日节点切换 / 候选全失效事件
  let switches = 0;
  for (const s of sw) { if (s.new_node && s.decision && String(s.decision).startsWith('C_') === false) switches++; }
  if (pc.candidate_nodes) lines.push(`候选节点：${pc.candidate_nodes.length} 个`);
  if (switches > 0) lines.push(`今日故障切换（含全失效）事件：${switches} 次`);

  // 连通区间展示（带实际承载节点）
  if (runs.length) {
    lines.push('连通时间区间（每轮实际停靠节点，节点变化即分段）：');
    const show = runs.slice(-14);
    if (runs.length > show.length) lines.push(`  （今日共 ${runs.length} 段，以下仅列最近 ${show.length} 段）`);
    for (const r of show) {
      const tag = r.ok ? `✓连通[${r.node}]` : '✗异常';
      lines.push(`  ${tag} ${fmtClock(r.startT, cfg.timezone)}–${fmtClock(r.endT, cfg.timezone)}（${fmtDuration(r.endT - r.startT)}）`);
    }
  }
  return lines;
}

/** ③ 签到情况（成功数 / 应签数） */
function sectionCheckin(cfg, now) {
  const lines = [];
  const tasks = getTasks();
  const enabled = tasks.filter((t) => t.enabled);
  const todayKey = beijingDayKey(now, cfg.timezone);
  const logs = getLogs({ days: 2 }).filter((l) => l.date === todayKey);
  const byTask = new Map();
  for (const l of logs) byTask.set(l.taskId, l); // 同日去重（日志本身也按天覆盖）
  let successCount = 0, creditsToday = 0;
  const failed = [], notChecked = [], invalid = [];
  for (const t of enabled) {
    if (t.credentialInvalid) { invalid.push(t.name); continue; }
    const l = byTask.get(t.id);
    if (l && l.status === 'success') {
      successCount++;
      if (Number.isFinite(l.credits)) creditsToday += l.credits;
    } else if (l && (l.status === 'fail' || l.status === 'invalid')) {
      failed.push(t.name);
    } else {
      notChecked.push(t.name);
    }
  }
  lines.push(`今日签到成功 ${successCount} / 应签 ${enabled.length}`);
  lines.push(`今日签到获得积分：${fmtNum(creditsToday)}`);
  if (invalid.length) lines.push(`凭证无效（暂停签到）：${invalid.join('、')}`);
  if (failed.length) lines.push(`今日签到失败：${failed.join('、')}`);
  if (notChecked.length) lines.push(`今日未签到/未到点：${notChecked.join('、')}`);
  if (!invalid.length && !failed.length && !notChecked.length && enabled.length) lines.push('✓ 全部启用账号今日均已成功签到');
  return lines;
}

/**
 * ④ 凭证维护日历（每个启用账号「到那天就再也签不了」的日子）。
 * ★与面板卡片、到期提醒邮件走同一个 credential-expiry 求值器，不另算一套。
 * 日报里全部列出（不止临期的），让“哪天该动手”一眼可见。
 */
function sectionCredMaintenance(cfg, now) {
  const lines = [];
  const enabled = getTasks().filter((t) => t.enabled);
  if (!enabled.length) { lines.push('✓ 无启用账号'); return lines; }
  const dated = [];
  const undated = [];
  for (const t of enabled) {
    const plat = (getProvider(t.providerId) || {}).name || t.providerId;
    const expMs = getMaintenanceExpiry(t) || t.maintenanceExpiresAt || null;
    if (!expMs) { undated.push(t.credentialInvalid ? `${t.name}（${plat}，已判失效）` : `${t.name}（${plat}）`); continue; }
    dated.push({ name: t.name, plat, expMs, days: Math.ceil((expMs - now) / 86400000) });
  }
  dated.sort((a, b) => a.expMs - b.expMs);
  const fmtBeijingDay = (ts) => new Intl.DateTimeFormat('zh-CN', {
    timeZone: cfg.timezone || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts));
  for (const d of dated) {
    const tag = d.days <= 0 ? '已到维护日' : `剩 ${d.days} 天`;
    lines.push(`· ${d.name}（${d.plat}）：${fmtBeijingDay(d.expMs)}（${tag}）`);
  }
  if (undated.length) lines.push(`· 无需人工维护 / 无可预知到期日：${undated.join('、')}`);
  return lines;
}

/** ⑤ 设备健康 */
async function sectionDevice() {
  const m = await metrics();
  const lines = [];
  lines.push(`开机时长：${m.uptime || '--'}　负载：${m.load || '--'}　CPU：${m.cpu ? m.cpu.usage : '--'}%`);
  if (m.mem) lines.push(`内存：${m.mem.used}/${m.mem.total} MB（${m.mem.pct}%），可用 ${m.mem.avail} MB`);
  const dp = m.disk && m.disk.dataPart;
  if (dp) lines.push(`磁盘 /data：已用 ${dp.used}/${dp.total}（${dp.pct}），剩余 ${dp.avail}`);
  const b = m.device && m.device.battery;
  if (b) lines.push(`电池：${b.percentage}%（${b.status}${b.temperature ? '，' + b.temperature + '°C' : ''}）`);
  const w = m.device && m.device.wifi;
  if (w) lines.push(`WiFi：${w.ssid || '--'}，信号 ${w.rssi} dBm，链路 ${w.linkSpeed || '--'} Mbps`);
  if (m.requests) lines.push(`今日 API 请求：${m.requests.today || 0} 次`);
  return lines;
}

/** ⑥ 积分消耗与预估可用天数 */
async function sectionUsage() {
  const s = await getUsageStatsWithEstimates();
  const lines = [];
  const t = s.total || {};
  const byDate = t.byDate || [];
  const last = byDate.length ? byDate[byDate.length - 1] : null;
  const remaining = t.remainingCredits;
  lines.push(`剩余总积分：${fmtNum(remaining)}`);
  if (last) lines.push(`最近有记录一日（${last.date}）消耗：${fmtNum(last.consumption)}`);
  lines.push(`净日均消耗：${fmtNum(t.netDailyAvgConsumption)}（近10日净日均 ${fmtNum(t.netDailyAvgConsumption10d)}）`);
  const est = (v) => (v === '充足' ? '充足（净消耗≤0）' : (v == null ? '—' : Math.round(v) + ' 天'));
  lines.push(`预估可用天数：${est(t.estimatedDays)}（近10日口径 ${est(t.estimatedDays10d)}）`);
  // 按平台一行
  for (const p of (s.byProvider || [])) {
    if (p.remainingCredits == null && (p.total && (p.total.byDate || []).length === 0)) continue;
    lines.push(`· ${p.providerName}：剩余 ${fmtNum(p.remainingCredits)}，预估 ${est(p.estimatedDays)}`);
  }
  return lines;
}

/** ⑦ 当日告警事件汇总 */
function sectionAlerts(cfg, now) {
  const lines = [];
  const todayKey = beijingDayKey(now, cfg.timezone);
  const { events } = getTodayAlerts(todayKey);
  if (!events.length) { lines.push('✓ 今日无告警 / 提醒事件'); return lines; }
  // 按主题（去掉账号名后的前缀标签）粗略归类
  const groups = new Map();
  for (const e of events) {
    const key = e.subject.replace(/^\[(告警|提醒)\]\s*/, '').replace(/[:：].*$/, '').trim() || e.subject;
    const g = groups.get(key) || { count: 0, sample: e.subject, lastTs: 0 };
    g.count++; g.lastTs = Math.max(g.lastTs, e.ts);
    groups.set(key, g);
  }
  lines.push(`今日共 ${events.length} 条告警 / 提醒：`);
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  for (const g of sorted.slice(0, 12)) {
    lines.push(`· [${g.count}×] ${g.sample}（最近 ${fmtBeijing(g.lastTs, cfg.timezone)}）`);
  }
  if (sorted.length > 12) lines.push(`· …… 另有 ${sorted.length - 12} 类事件`);
  return lines;
}

// ==================================================================
// 组装 + 发送
// ==================================================================

/**
 * 采集并组装日报。
 * @param {object} [opts] { now }
 * @returns {Promise<{subject:string, body:string}>}
 */
export async function buildDailyReport(opts = {}) {
  const now = opts.now || Date.now();
  const cfg = readReportConfig();
  const dayKey = beijingDayKey(now, cfg.timezone);

  const blocks = [
    { title: '① 积分过期', fn: () => sectionCreditExpiry(cfg, now) },
    { title: '② 代理连通', fn: () => sectionProxy(cfg, now) },
    { title: '③ 签到情况', fn: () => sectionCheckin(cfg, now) },
    { title: '④ 凭证维护日历', fn: () => sectionCredMaintenance(cfg, now) },
    { title: '⑤ 设备健康', fn: () => sectionDevice() },
    { title: '⑥ 积分消耗与预估', fn: () => sectionUsage() },
    { title: '⑦ 当日告警汇总', fn: () => sectionAlerts(cfg, now) },
  ];

  const out = [];
  out.push(`Honor10 设备运行日报 · ${dayKey}（${cfg.timezone}）`);
  out.push(`生成时刻：${fmtBeijing(now, cfg.timezone)}`);
  for (const b of blocks) {
    out.push('');
    out.push(`【${b.title}】`);
    try {
      const lines = await b.fn();
      out.push(...lines);
    } catch (e) {
      out.push(`（本段数据获取失败：${e && e.message}）`);
    }
  }
  out.push('');
  out.push('—— 本邮件为每日自动运行日报；第④块的日子 = 自动续期链断掉、再也签不了的那一天（与签到面板卡片同一口径）；凭证失效 / 代理全节点失效等高危事件仍会单独即时告警。');
  const body = out.join('\n');
  const subject = `[日报] Honor10 设备运行状况 ${dayKey}`;
  return { subject, body, dayKey };
}

/** 生成并发送日报；返回 { ok, skipped?, subject, body } */
export async function sendDailyReport(opts = {}) {
  const { subject, body } = await buildDailyReport(opts);
  const ok = await sendMail(subject, body);
  return { ok, subject, body };
}

/** 仅生成（供前端预览，不发信） */
export async function previewDailyReport(opts = {}) {
  return buildDailyReport(opts);
}

/**
 * 启动每日日报调度器（仅由 server.js 调用一次）。
 * @returns {{stop:Function,next:number}|null} 未启用返回 null
 */
export function startDailyReportScheduler() {
  const cfg = readReportConfig();
  if (!cfg.enabled) return null;
  return startScheduler({
    timeStr: cfg.time,
    timezone: cfg.timezone,
    onTick: async () => {
      try {
        const r = await sendDailyReport();
        console.log('[daily-report] 已发送:', r.subject, 'ok=', r.ok);
      } catch (e) {
        console.error('[daily-report] 发送失败:', e && e.message);
      }
    },
  });
}
