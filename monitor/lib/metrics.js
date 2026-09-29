import { run, fetchJson, fetchSb, findService, procKeyword, fmtDurationStr, SB_DISABLED } from './utils.js';
import { history, trafficLog, hourlyBuckets, dailyBuckets, traffic5s, trafficMinute, requestCount, apiBytes, getTrafficInPeriod, sampleTraffic5s, sampleTrafficMinute, sampleDailyBuckets } from './recorder.js';

// ====== 采集结果缓存（SWR：stale-while-revalidate）======
// 前端每 3s 轮询 /api；旧版每个请求都现场 spawn 十几个子进程重算一遍（~500ms）。
// 现在：TTL 内直接复用快照；过期先回旧快照、后台单飞重算，无人访问时零开销。
export const METRICS_TTL_MS = 3000;
let snapshot = null;    // { data, json, at }
let building = null;    // 单飞锁：进行中的重算 Promise

// ====== 慢数据 TTL 缓存 ======
// du：Termux 全目录扫 8.6GB 要 ~50s（2026-09-19 实测）→ 缓存 1 小时 + 到期后台刷新，
//     任何情况下都不会阻塞采集流程。
const duCache = { value: null, at: 0 };
const DU_CACHE_TTL_MS = 60 * 60 * 1000;
function refreshDu() {
  if (duCache.value !== null && Date.now() - duCache.at < DU_CACHE_TTL_MS) return;
  run('du -sh /data/data/com.termux/files 2>/dev/null')
    .then(v => { if (v) { duCache.value = v; duCache.at = Date.now(); } })
    .catch(() => {});
}

// battery / wifi：termux-api 经应用桥接，单次可达秒级；变化慢，缓存 60s。
const batteryCache = { value: null, at: 0 };
const wifiCache = { value: null, at: 0 };
const DEVICE_TTL_MS = 60 * 1000;

export async function metrics() {
  // du 到期则后台刷，本次仍用旧值（~50s 的全量扫盘永不阻塞响应）
  refreshDu();
  const needDevice = !batteryCache.value || Date.now() - batteryCache.at > DEVICE_TTL_MS;
  const needWifi = !wifiCache.value || Date.now() - wifiCache.at > DEVICE_TTL_MS;
  // 进程表：一次 ps 同时取 CPU/内存/RSS/运行时长（旧版 ps aux + ps -eo etime 扫两遍）
  const [mem, diskRaw, diskDataRaw, termuxSizeRaw, up, psMerged, netRaw, nprocRaw, sbVer, sbCon, sbProxies, watchdogRaw, batteryRaw, wifiRaw] = await Promise.all([
    run('cat /proc/meminfo'),
    run("df -h | awk '$NF == \"/\"'"),
    run("df -h | awk '$NF == \"/data\"'"),
    Promise.resolve(duCache.value),
    run('uptime'),
    run('ps -eo user,pid,%cpu,%mem,rss,etime,args 2>/dev/null'),
    run('cat /proc/net/dev 2>/dev/null'),
    run('nproc 2>/dev/null'),
    ...(SB_DISABLED
      ? [Promise.resolve(null), Promise.resolve(null), Promise.resolve(null)]
      : [
          fetchSb('/version'),
          fetchSb('/connections'),
          fetchSb('/proxies'),
        ]),
    run('pgrep -af watchdog.sh 2>/dev/null'),
    needDevice ? run('termux-battery-status 2>/dev/null').then(v => { if (v && v.trim()) { batteryCache.value = v; batteryCache.at = Date.now(); } return v; }) : Promise.resolve(batteryCache.value),
    needWifi ? run('termux-wifi-connectioninfo 2>/dev/null').then(v => { if (v && v.trim()) { wifiCache.value = v; wifiCache.at = Date.now(); } return v; }) : Promise.resolve(wifiCache.value),
  ]);
  // 兼容兜底：ps -eo 不可用时回退旧写法（列序 USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND + 单独 etime 查询）
  let psFallback = false, psAgeRaw = '';
  if (!psMerged || !/PID/.test(psMerged.split('\n', 1)[0])) {
    psFallback = true;
    [psMerged, psAgeRaw] = await Promise.all([
      run('ps aux'),
      run('ps -eo pid,etime=,args= 2>/dev/null'),
    ]);
  }

  const m = {};
  mem.replace(/(\w+):\s+(\d+)/g, (_, k, v) => { m[k] = +v; return ''; });
  const memT = m.MemTotal ? Math.round(m.MemTotal / 1024) : 0;
  const memF = m.MemFree ? Math.round(m.MemFree / 1024) : 0;
  const memA = m.MemAvailable ? Math.round(m.MemAvailable / 1024) : 0;
  const memU = memT - memF;
  const cac = m.Cached ? Math.round(m.Cached / 1024) : 0;
  const swT = m.SwapTotal ? Math.round(m.SwapTotal / 1024) : 0;
  const swU = swT - (m.SwapFree ? Math.round(m.SwapFree / 1024) : 0);

  // 从 ps 累加 Termux 进程 CPU（/proc/stat 在 Android 上被限制）；两种格式 %CPU 都在第 3 列
  const psLines = psMerged.trim().split('\n');
  // nproc 返回 Android 暴露给 Termux 的核心数（Honor 10 实际 4 核，非 8 核）
  const cores = parseInt((nprocRaw || '').trim()) || 4;
  let cpuSum = 0;
  for (let i = 1; i < psLines.length; i++) {
    const cols = psLines[i].trim().split(/\s+/);
    const val = parseFloat(cols[2]);
    if (!isNaN(val)) cpuSum += val;
  }
  // Termux 进程 CPU 占用（相对于 Termux 可见核心数）
  const usage = Math.max(0, Math.round(cpuSum / cores * 10) / 10);

  const u = up.match(/up\s+(.+?),\s+load average:\s+(.+)/);

  // 进程运行时间 etime：合并模式下直接取自同一行；兜底模式解析单独的 pid,etime 表
  const ageMap = {};
  if (psFallback && psAgeRaw) {
    psAgeRaw.split('\n').forEach(line => {
      const m = line.trim().match(/^(\d+)\s+([\d:-]+)\s+(.*)/);
      if (m) ageMap[m[1]] = fmtDurationStr(m[2]);
    });
  }

  const lines = psLines;
  const list = lines.slice(1).filter(Boolean).map(l => {
    const p = l.trim().split(/\s+/);
    // 列序：合并 user,pid,%cpu,%mem,rss,etime,args / 兜底 ps aux（RSS 第 6 列、etime 查表、args 从第 11 列起）
    const fullCmd = psFallback ? p.slice(10).join(' ') : p.slice(6).join(' ');
    return {
      pid: p[1], user: p[0], cpu: p[2], memPct: p[3],
      rssMb: Math.round((parseInt(psFallback ? p[5] : p[4]) || 0) / 1024),
      cmd: fullCmd.slice(0, 80),
      kw: procKeyword(fullCmd),
      svc: findService(fullCmd)?.action || '',
      age: psFallback ? (ageMap[p[1]] || '--') : (fmtDurationStr(p[5]) || '--'),
    };
  });
  const topMem = [...list].sort((a, b) => b.rssMb - a.rssMb).slice(0, 10);

  const d = diskRaw.trim().split(/\s+/);
const disk = d[1] ? { total: d[1], used: d[2], avail: d[3], pct: d[4] } : { total: '--', used: '--', avail: '--', pct: '--' };
// 用户数据分区 /data（真实总容量，53G）
const dd = diskDataRaw.trim().split(/\s+/);
const dataPart = dd[1] ? { total: dd[1], used: dd[2], avail: dd[3], pct: dd[4] } : null;
// Termux 占用
const termuxSize = (termuxSizeRaw || '').trim().split(/\s+/)[0] || '';
// 计算用户占用（非 Termux 的 /data 分区占用）
let userUsed = '';
let userPct = 0;
if (dataPart && termuxSize) {
  const parseSize = (s) => {
    if (!s) return 0;
    const m = s.match(/^([\d.]+)([KMGTP]?)/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    const unit = (m[2] || '').toUpperCase();
    const mult = { '': 1, K: 1024, M: 1024*1024, G: 1024*1024*1024, T: 1024**4, P: 1024**5 }[unit] || 1;
    return num * mult;
  };
  const dataUsedBytes = parseSize(dataPart.used);
  const termuxBytes = parseSize(termuxSize);
  const userBytes = Math.max(0, dataUsedBytes - termuxBytes);
  if (userBytes >= 1024*1024*1024) {
    userUsed = (userBytes / (1024*1024*1024)).toFixed(1) + 'G';
  } else if (userBytes >= 1024*1024) {
    userUsed = (userBytes / (1024*1024)).toFixed(0) + 'M';
  } else {
    userUsed = Math.round(userBytes / 1024) + 'K';
  }
  const dataTotalBytes = parseSize(dataPart.total);
  userPct = dataTotalBytes > 0 ? Math.round(userBytes / dataTotalBytes * 100) : 0;
}
disk.dataPart = dataPart;
disk.termux = termuxSize;
disk.userUsed = userUsed;
disk.userPct = userPct;

  // Network interfaces
  const netIfaces = {};
  for (const line of (netRaw.trim().split('\n').slice(2))) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 10) { const n = p[0].replace(':', ''); netIfaces[n] = { rx: +p[1] || 0, tx: +p[9] || 0 }; }
  }

  const sb = {
    version: sbVer?.version || null,
    connections: sbCon?.connections?.length ?? 0,
    dl: Math.round((sbCon?.downloadTotal ?? 0) / 1024 / 1024 * 10) / 10,
    ul: Math.round((sbCon?.uploadTotal ?? 0) / 1024 / 1024 * 10) / 10,
    downloadSpeed: sbCon?.downloadSpeed ?? 0,
    uploadSpeed: sbCon?.uploadSpeed ?? 0,
    connectionsDetail: (sbCon?.connections || []).slice(0, 20).map(c => ({
      host: c.metadata?.host || c.metadata?.destinationIP || '--',
      network: c.metadata?.network || '--',
      type: c.metadata?.type || '--',
      rule: c.metadata?.rule || '--',
      rulePayload: c.metadata?.rulePayload || '--',
      dl: c.download || 0,
      ul: c.upload || 0,
      dlSpeed: c.downloadSpeed || 0,
      ulSpeed: c.uploadSpeed || 0,
      chains: c.chains?.join(', ') || '--',
    })),
    proxies: trimProxies(sbProxies?.proxies),
  };

  const now = Date.now();
  // 分时数据（6组：代理下载/上传/总计 + 总计下载/上传/流量）
  const trafficTime = {
    '10m': getTrafficInPeriod(trafficMinute, 10),
    '30m': getTrafficInPeriod(trafficMinute, 30),
    '1h': getTrafficInPeriod(trafficMinute, 60),
    '2h': getTrafficInPeriod(trafficMinute, 120),
    '3h': getTrafficInPeriod(trafficMinute, 180),
    '12h': getTrafficInPeriod(trafficMinute, 720),
    '24h': getTrafficInPeriod(trafficMinute, 1440),
    total: {
      proxyDownload: trafficLog.proxyDownload || 0,
      proxyUpload: trafficLog.proxyUpload || 0,
      proxyTotal: (trafficLog.proxyDownload || 0) + (trafficLog.proxyUpload || 0),
      download: trafficLog.download || 0,
      upload: trafficLog.upload || 0,
      total: trafficLog.total || 0,
    },
  };

  // 分日数据
  const trafficDay = {
    day: sampleDailyBuckets(dailyBuckets, 1).slice(-24),
    week: sampleDailyBuckets(dailyBuckets, 7).slice(-24),
    month: sampleDailyBuckets(dailyBuckets, 30).slice(-12),
    year: sampleDailyBuckets(dailyBuckets, 365).slice(-12),
  };

  // 解析电池和 WiFi 数据
  let battery = null;
  try { if (batteryRaw && batteryRaw.trim()) battery = JSON.parse(batteryRaw); } catch {}
  let wifi = null;
  try { if (wifiRaw && wifiRaw.trim()) wifi = JSON.parse(wifiRaw); } catch {}

  const device = {
    battery: battery ? {
      percentage: battery.percentage ?? battery.level ?? 0,
      temperature: parseFloat(battery.temperature) || 0,
      status: battery.status || 'UNKNOWN',
      plugged: battery.plugged || 'UNKNOWN',
      health: battery.health || 'UNKNOWN',
      voltage: battery.voltage || 0,
      current: battery.current || 0,
      technology: battery.technology || '',
    } : null,
    wifi: wifi ? {
      rssi: wifi.rssi ?? 0,
      linkSpeed: wifi.link_speed_mbps ?? 0,
      frequency: wifi.frequency_mhz ?? 0,
      ip: wifi.ip || '',
      ssid: wifi.ssid || '',
    } : null,
  };

  return {
    ts: Date.now(), uptime: u?.[1]?.trim() || '--', load: u?.[2] || '--', // load 为 Android 全局负载（含系统进程）
    cpu: { cores, usage, cpuSum, termuxPct: Math.min(100, usage) },
    mem: { total: memT, used: memU, free: memF, avail: memA, pct: memT ? Math.round(memU / memT * 100) : 0, cached: cac, swapT: swT, swapU: swU },
    disk, netIfaces,
    procs: { total: Math.max(0, lines.length - 1), list, topMem },
    sb, traffic5s: traffic5s.slice(-360),
    trafficMinute: Object.fromEntries(Object.entries(trafficMinute).sort(([a],[b])=>a.localeCompare(b))),
    trafficTime, trafficDay, apiBytes,
    history: { mem: history.mem.slice(-120), ts: history.ts.slice(-120) },
    requests: requestCount,
    watchdog: { running: !!watchdogRaw && watchdogRaw.trim().length > 0 },
    device,
  };
}

// 只保留前端代理卡片渲染需要的字段（now/type/alt），剔除 history/udp/all 等冗余大字段
function trimProxies(proxies) {
  const out = {};
  for (const [name, p] of Object.entries(proxies || {})) {
    const e = { type: p.type, now: p.now };
    if (Array.isArray(p.alt) && p.alt.length) e.alt = p.alt.slice(0, 12);
    out[name] = e;
  }
  return out;
}

// ====== SWR 快照入口（/api 与 /api/stream 统一走这里）======
export async function getMetricsSnapshot() {
  const now = Date.now();
  if (snapshot && now - snapshot.at < METRICS_TTL_MS) return snapshot;
  if (!snapshot) {
    // 冷启动：没有旧数据可回退，同步采一次
    const data = await metrics();
    snapshot = { data, json: JSON.stringify(data), at: Date.now() };
    return snapshot;
  }
  // 过期：立即回旧快照，后台单飞重算（重算失败保留旧值，下次请求再触发）
  if (!building) {
    building = metrics().then(data => {
      snapshot = { data, json: JSON.stringify(data), at: Date.now() };
    }).catch(() => {}).finally(() => { building = null; });
  }
  return snapshot;
}
