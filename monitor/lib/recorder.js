import { run, fetchJson, fetchSb, loadJSON, saveJSON, DATA_DIR, SB_DISABLED } from './utils.js';

// ====== Data State ======
const RECORD_INTERVAL = 5000; // 5 seconds

const MAX_5S_SAMPLES = 2160;
export let history = { mem: [], ts: [] };
export let traffic5s = []; // [{ts, download, upload, proxyDownload, proxyUpload}]

export let trafficLog = { download: 0, upload: 0, total: 0, proxyDownload: 0, proxyUpload: 0 };

const MAX_MINUTE_SAMPLES = 1440;
export let trafficMinute = {}; // { "2026-07-15T14:30": { download, upload, proxyDownload, proxyUpload, apiDownload } }

export let hourlyBuckets = {}; // { "2026-07-15T14": { ... } }

export let dailyBuckets = {}; // { "2026-07-15": { bytes, download, upload, proxyDownload, proxyUpload } }

export let requestCount = {
  total: 0,
  today: 0,
  todayDate: new Date().toISOString().slice(0, 10),
};

// API 响应流量统计（独立计数器，不混入代理流量）
export let apiBytes = { download: 0, upload: 0 };
let apiDownloadCounter = 0;

export function addApiBytes(bytes) {
  apiDownloadCounter += bytes;
  apiBytes.download += bytes;
}

// 取出并清空当前累积的 API 字节数（供 recorder 定期归入分钟桶）
export function consumeApiBytes() {
  const n = apiDownloadCounter;
  apiDownloadCounter = 0;
  return n;
}

// ====== 从分钟数据计算时间段内上下行总量 ======
// 返回 6 组数据：代理下载/上传/总计 + 总计下载/上传/流量
export function getTrafficInPeriod(buckets, minutes) {
  const now = Date.now();
  const period = minutes * 60 * 1000;
  let download = 0, upload = 0, proxyDownload = 0, proxyUpload = 0;
  for (const [key, val] of Object.entries(buckets)) {
    const bucketTime = new Date(key + ':00Z').getTime();
    if (now - bucketTime <= period) {
      download += val.download || 0;
      upload += val.upload || 0;
      // 历史数据兼容：若无 proxyDownload 字段，代理部分默认为 0
      proxyDownload += val.proxyDownload || 0;
      proxyUpload += val.proxyUpload || 0;
    }
  }
  return {
    proxyDownload,
    proxyUpload,
    proxyTotal: proxyDownload + proxyUpload,
    download,
    upload,
    total: download + upload,
  };
}

// ====== 从5秒数据按步长采样（仅用于前端实时） ======
export function sampleTraffic5s(data, stepCount) {
  const result = { download: [], upload: [], proxyDownload: [], proxyUpload: [] };
  for (let i = 0; i < data.length; i += stepCount) {
    const chunk = data.slice(i, i + stepCount);
    result.download.push(chunk.reduce((s, v) => s + (v.download || 0), 0));
    result.upload.push(chunk.reduce((s, v) => s + (v.upload || 0), 0));
    result.proxyDownload.push(chunk.reduce((s, v) => s + (v.proxyDownload || 0), 0));
    result.proxyUpload.push(chunk.reduce((s, v) => s + (v.proxyUpload || 0), 0));
  }
  return result;
}

// ====== 从分钟数据按步长采样 ======
export function sampleTrafficMinute(data, stepCount) {
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  const result = { download: [], upload: [], proxyDownload: [], proxyUpload: [] };
  for (let i = 0; i < entries.length; i += stepCount) {
    const chunk = entries.slice(i, i + stepCount);
    result.download.push(chunk.reduce((s, [, v]) => s + (v.download || 0), 0));
    result.upload.push(chunk.reduce((s, [, v]) => s + (v.upload || 0), 0));
    result.proxyDownload.push(chunk.reduce((s, [, v]) => s + (v.proxyDownload || 0), 0));
    result.proxyUpload.push(chunk.reduce((s, [, v]) => s + (v.proxyUpload || 0), 0));
  }
  return result;
}

// ====== 从每日数据按步长采样 ======
export function sampleDailyBuckets(data, stepDays) {
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  const result = [];
  for (let i = 0; i < entries.length; i += stepDays) {
    const chunk = entries.slice(i, i + stepDays);
    // 聚合多天数据为一段，保留各分类流量
    const agg = { download: 0, upload: 0, proxyDownload: 0, proxyUpload: 0 };
    for (const [, v] of chunk) {
      agg.download += v.download || v.bytes || 0; // 兼容旧数据：无分类字段时用 bytes 作总量
      agg.upload += v.upload || 0;
      agg.proxyDownload += v.proxyDownload || 0;
      agg.proxyUpload += v.proxyUpload || 0;
    }
    // 旧数据只有 bytes 字段：download 已用 bytes，但 upload/proxy 为 0（无法回溯）
    // 新数据：value = download + upload（总流量）
    const value = agg.download + agg.upload;
    result.push({
      value,
      label: chunk[0]?.[0] || '',
      download: agg.download,
      upload: agg.upload,
      proxyDownload: agg.proxyDownload,
      proxyUpload: agg.proxyUpload,
      proxyTotal: agg.proxyDownload + agg.proxyUpload,
      total: value,
    });
  }
  return result;
}

// ====== Initialization ======
export function initRecorder() {
  hourlyBuckets = loadJSON(DATA_DIR + '/hourly.json', {});
  dailyBuckets = loadJSON(DATA_DIR + '/daily.json', {});
  trafficMinute = loadJSON(DATA_DIR + '/traffic_minute.json', {});
  const saved = loadJSON(DATA_DIR + '/history.json', null);
  if (saved) { history = saved; }

  // 持久化加载 requestCount（避免重启重置）
  const savedReq = loadJSON(DATA_DIR + '/request_count.json', null);
  if (savedReq) {
    requestCount.total = savedReq.total || 0;
    requestCount.today = savedReq.today || 0;
    requestCount.todayDate = savedReq.todayDate || new Date().toISOString().slice(0, 10);
    // 如果日期已跨天，重置今日计数
    const today = new Date().toISOString().slice(0, 10);
    if (today !== requestCount.todayDate) {
      requestCount.today = 0;
      requestCount.todayDate = today;
    }
  }

  // 持久化加载 traffic5s（5秒实时流量采样，重启后保持曲线连续）
  const saved5s = loadJSON(DATA_DIR + '/traffic_5s.json', null);
  if (saved5s && Array.isArray(saved5s)) {
    traffic5s.length = 0;
    traffic5s.push(...saved5s.slice(-MAX_5S_SAMPLES));
  }

  // 持久化加载 trafficLog（累计流量计数，重启后保持总量不归零）
  const savedLog = loadJSON(DATA_DIR + '/traffic_log.json', null);
  if (savedLog) {
    trafficLog.download = savedLog.download || 0;
    trafficLog.upload = savedLog.upload || 0;
    trafficLog.total = savedLog.total || 0;
    trafficLog.proxyDownload = savedLog.proxyDownload || 0;
    trafficLog.proxyUpload = savedLog.proxyUpload || 0;
  }

  let lastMinuteKey = '';
  let lastHourKey = '';
  let lastDownloadTotal; let lastUploadTotal;
  let lastSbDownload; let lastSbUpload;
  let sbRestartDetected = false;

  // 加载网卡/sing-box计数指针（重启后跳过第一周期差分避免毛刺）
  const savedCounters = loadJSON(DATA_DIR + '/counters.json', null);
  if (savedCounters) {
    lastDownloadTotal = savedCounters.lastDownloadTotal || 0;
    lastUploadTotal = savedCounters.lastUploadTotal || 0;
    lastSbDownload = savedCounters.lastSbDownload || 0;
    lastSbUpload = savedCounters.lastSbUpload || 0;
  }
  // 清空指针让首个周期跳过差分（避免因重启导致网卡计数跳变产生毛刺数据）
  lastDownloadTotal = 0;
  lastUploadTotal = 0;
  lastSbDownload = 0;
  lastSbUpload = 0;

  setInterval(async () => {
    try {
      const [memRaw, sbCon, netRaw] = await Promise.all([
        run('cat /proc/meminfo'),
        SB_DISABLED ? null : fetchSb('/connections'),
        run('ip -s link show wlan0 2>/dev/null'),
      ]);
      const m = {};
      memRaw.replace(/(\w+):\s+(\d+)/g, (_, k, v) => { m[k] = +v; return ''; });

      const ts = new Date();
      const timeKey5s = ts.toISOString();
      const minuteKey = timeKey5s.slice(0, 16);
      const hourKey = timeKey5s.slice(0, 13);
      const dayKey = timeKey5s.slice(0, 10);

      // ===== 总计流量：使用 wlan0 网卡 RX/TX 做差分 =====
      let curRx = 0, curTx = 0;
      const rxMatch = netRaw.match(/RX:\s*bytes\s+packets[\s\S]*?\n\s*(\d+)/);
      const txMatch = netRaw.match(/TX:\s*bytes\s+packets[\s\S]*?\n\s*(\d+)/);
      if (rxMatch) curRx = +rxMatch[1] || 0;
      if (txMatch) curTx = +txMatch[1] || 0;

      let totalDownloadDL = 0, totalUploadDL = 0;
      if (lastDownloadTotal > 0) {
        totalDownloadDL = Math.max(0, curRx - lastDownloadTotal);
        totalUploadDL = Math.max(0, curTx - lastUploadTotal);
      }
      lastDownloadTotal = curRx;
      lastUploadTotal = curTx;

      // ===== 代理流量：使用 sing-box downloadTotal/uploadTotal 做差分 =====
      // 注意：sing-box 重启后 downloadTotal 会重置为 0，需检测避免误判为负差分
      let proxyDownloadDL = 0, proxyUploadDL = 0;
      if (sbCon) {
        const curSbDownload = sbCon.downloadTotal || 0;
        const curSbUpload = sbCon.uploadTotal || 0;
        if (lastSbDownload > 0 && curSbDownload >= lastSbDownload) {
          proxyDownloadDL = curSbDownload - lastSbDownload;
          proxyUploadDL = curSbUpload - lastSbUpload;
        } else if (curSbDownload > 0 && lastSbDownload > 0 && curSbDownload < lastSbDownload) {
          // sing-box 重启，跳过本次差分
          sbRestartDetected = true;
        }
        if (curSbDownload > 0) {
          lastSbDownload = curSbDownload;
          lastSbUpload = curSbUpload;
        }
      }

      // === 第1层：5秒原始数据（内存，保留3小时） ===
      traffic5s.push({
        ts: Date.now(),
        download: totalDownloadDL,
        upload: totalUploadDL,
        proxyDownload: proxyDownloadDL,
        proxyUpload: proxyUploadDL,
      });
      if (traffic5s.length > MAX_5S_SAMPLES) traffic5s.shift();

      // === 第2层：分钟聚合 ===
      if (minuteKey !== lastMinuteKey) {
        lastMinuteKey = minuteKey;
      }
      if (!trafficMinute[minuteKey]) {
        trafficMinute[minuteKey] = { download: 0, upload: 0, proxyDownload: 0, proxyUpload: 0, apiDownload: 0 };
      }
      trafficMinute[minuteKey].download += totalDownloadDL;
      trafficMinute[minuteKey].upload += totalUploadDL;
      trafficMinute[minuteKey].proxyDownload = (trafficMinute[minuteKey].proxyDownload || 0) + proxyDownloadDL;
      trafficMinute[minuteKey].proxyUpload = (trafficMinute[minuteKey].proxyUpload || 0) + proxyUploadDL;
      // 将本周期内 API 响应字节数归入分钟桶
      const apiDl = consumeApiBytes();
      if (apiDl > 0) {
        trafficMinute[minuteKey].apiDownload = (trafficMinute[minuteKey].apiDownload || 0) + apiDl;
      }

      // 清理超过24小时的分钟数据
      const minuteCutoff = Date.now() - 25 * 60 * 60 * 1000;
      for (const k of Object.keys(trafficMinute)) {
        if (new Date(k + ':00Z').getTime() < minuteCutoff) delete trafficMinute[k];
      }

      // === 第3层：小时聚合 ===
      if (hourKey !== lastHourKey) {
        if (lastHourKey) {
          saveJSON(DATA_DIR + '/hourly.json', hourlyBuckets);
          aggregateToHourly(lastHourKey);
        }
        lastHourKey = hourKey;
        if (!hourlyBuckets[hourKey]) {
          hourlyBuckets[hourKey] = { download: 0, upload: 0, proxyDownload: 0, proxyUpload: 0, reqs: 0, memSamples: 0, memTotal: 0 };
        }
      }
      const hb = hourlyBuckets[hourKey];
      const avail = m.MemAvailable ? Math.round(m.MemAvailable / 1024) : 0;
      hb.memSamples++;
      hb.memTotal += avail;
      hb.download += totalDownloadDL;
      hb.upload += totalUploadDL;
      hb.proxyDownload = (hb.proxyDownload || 0) + proxyDownloadDL;
      hb.proxyUpload = (hb.proxyUpload || 0) + proxyUploadDL;
      hb.reqs = (hb.reqs || 0) + 1;

      const hourCutoff = Date.now() - 50 * 60 * 60 * 1000;
      for (const k of Object.keys(hourlyBuckets)) {
        if (new Date(k + ':00:00Z').getTime() < hourCutoff) delete hourlyBuckets[k];
      }

      // 每天聚合
      if (!dailyBuckets[dayKey]) dailyBuckets[dayKey] = { bytes: 0, download: 0, upload: 0, proxyDownload: 0, proxyUpload: 0 };
      dailyBuckets[dayKey].bytes += totalDownloadDL + totalUploadDL;
      dailyBuckets[dayKey].download = (dailyBuckets[dayKey].download || 0) + totalDownloadDL;
      dailyBuckets[dayKey].upload = (dailyBuckets[dayKey].upload || 0) + totalUploadDL;
      dailyBuckets[dayKey].proxyDownload = (dailyBuckets[dayKey].proxyDownload || 0) + proxyDownloadDL;
      dailyBuckets[dayKey].proxyUpload = (dailyBuckets[dayKey].proxyUpload || 0) + proxyUploadDL;

      // history
      history.ts.push(Date.now());
      history.mem.push(avail);
      if (history.ts.length > MAX_5S_SAMPLES) {
        history.ts.shift(); history.mem.shift();
      }

      trafficLog.total += (totalDownloadDL + totalUploadDL);
      trafficLog.download += totalDownloadDL;
      trafficLog.upload += totalUploadDL;
      trafficLog.proxyDownload += proxyDownloadDL;
      trafficLog.proxyUpload += proxyUploadDL;

      if (history.ts.length % 10 === 0) {
        saveJSON(DATA_DIR + '/history.json', history);
        saveJSON(DATA_DIR + '/hourly.json', hourlyBuckets);
        saveJSON(DATA_DIR + '/daily.json', dailyBuckets);
        saveJSON(DATA_DIR + '/traffic_minute.json', trafficMinute);
        saveJSON(DATA_DIR + '/request_count.json', requestCount);
        saveJSON(DATA_DIR + '/traffic_5s.json', traffic5s);
        saveJSON(DATA_DIR + '/traffic_log.json', trafficLog);
        saveJSON(DATA_DIR + '/counters.json', { lastDownloadTotal, lastUploadTotal, lastSbDownload, lastSbUpload });
      }
    } catch (e) { console.error('Recorder error:', e); }
  }, RECORD_INTERVAL);
}

function aggregateToHourly(hourKey) {
  let download = 0, upload = 0, proxyDownload = 0, proxyUpload = 0;
  for (const [mk, mv] of Object.entries(trafficMinute)) {
    if (mk.startsWith(hourKey)) {
      download += mv.download || 0;
      upload += mv.upload || 0;
      proxyDownload += mv.proxyDownload || 0;
      proxyUpload += mv.proxyUpload || 0;
    }
  }
  if (download || upload || proxyDownload || proxyUpload) {
    hourlyBuckets[hourKey] = hourlyBuckets[hourKey] || { download: 0, upload: 0, proxyDownload: 0, proxyUpload: 0, reqs: 0, memSamples: 0, memTotal: 0 };
    hourlyBuckets[hourKey].download = Math.max(hourlyBuckets[hourKey].download || 0, download);
    hourlyBuckets[hourKey].upload = Math.max(hourlyBuckets[hourKey].upload || 0, upload);
    hourlyBuckets[hourKey].proxyDownload = Math.max(hourlyBuckets[hourKey].proxyDownload || 0, proxyDownload);
    hourlyBuckets[hourKey].proxyUpload = Math.max(hourlyBuckets[hourKey].proxyUpload || 0, proxyUpload);
  }
}

function aggregateToDaily() {
  const daily = {};
  for (const [hk, hv] of Object.entries(hourlyBuckets)) {
    const dayKey = hk.slice(0, 10);
    if (!daily[dayKey]) daily[dayKey] = { download: 0, upload: 0, proxyDownload: 0, proxyUpload: 0 };
    daily[dayKey].download += hv.download || 0;
    daily[dayKey].upload += hv.upload || 0;
    daily[dayKey].proxyDownload += hv.proxyDownload || 0;
    daily[dayKey].proxyUpload += hv.proxyUpload || 0;
  }
  for (const [dk, dv] of Object.entries(daily)) {
    if (!dailyBuckets[dk]) dailyBuckets[dk] = { bytes: 0, download: 0, upload: 0, proxyDownload: 0, proxyUpload: 0 };
    // 用小时聚合结果覆盖（更准确）
    dailyBuckets[dk].download = Math.max(dailyBuckets[dk].download || 0, dv.download);
    dailyBuckets[dk].upload = Math.max(dailyBuckets[dk].upload || 0, dv.upload);
    dailyBuckets[dk].proxyDownload = Math.max(dailyBuckets[dk].proxyDownload || 0, dv.proxyDownload);
    dailyBuckets[dk].proxyUpload = Math.max(dailyBuckets[dk].proxyUpload || 0, dv.proxyUpload);
    // 兼容字段：bytes = download + upload
    dailyBuckets[dk].bytes = (dailyBuckets[dk].download || 0) + (dailyBuckets[dk].upload || 0);
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  for (const k of Object.keys(dailyBuckets)) {
    if (new Date(k).getTime() < cutoff.getTime()) delete dailyBuckets[k];
  }
  saveJSON(DATA_DIR + '/daily.json', dailyBuckets);
}

setInterval(() => {
  aggregateToDaily();
  const cutoff = Date.now() - 25 * 60 * 60 * 1000;
  for (const k of Object.keys(trafficMinute)) {
    if (new Date(k + ':00Z').getTime() < cutoff) delete trafficMinute[k];
  }
}, 60000);

// 每分钟检查日期切换并保存 requestCount
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== requestCount.todayDate) {
    requestCount.today = 0;
    requestCount.todayDate = today;
  }
  saveJSON(DATA_DIR + '/request_count.json', requestCount);
}, 60000);
