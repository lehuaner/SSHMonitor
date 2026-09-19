import { createServer, request as httpReq } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { run, fetchJson, saveJSON, SB_DISABLED, SB_HOST, SB_PORT, SB_SECRET, HOME, DATA_DIR, findService, getCustomServiceRules, saveCustomServiceRules, SERVICE_CMDS } from './lib/utils.js';
import { initRecorder, history, hourlyBuckets, requestCount, apiBytes, addApiBytes } from './lib/recorder.js';
import { metrics } from './lib/metrics.js';
import { doAction } from './lib/actions.js';
import { listDir, readFileContent, writeFileContent, renameItem, deleteItem, makeDir, loadNotes, saveNotes, parseUpload } from './lib/files.js';
import { subscriptions, nodeStatusCache, parseSubscription, generateSbConfig, regenerateConfig, getDnsConfig, applyDnsConfig } from './lib/subscription.js';
import { mailConfig, markedProcs, resetProcStatus, sendMail, checkProcs, checkProxy, runProxyCheck, switchNode, getNodeWeights, checkDeviceAlerts, markNodeLogsDeleted, getDeletedTimestamps, startNotifyScheduler } from './lib/notify.js';
import { readLogTail, writeLog } from './lib/logger.js';
import { registerProvider, getProviderSchemas, getProvider } from './lib/providers/index.js';
import traeProvider from './lib/providers/trae.js';
import workbuddyProvider from './lib/providers/workbuddy.js';
import codeartsProvider from './lib/providers/codearts.js';
import autoclawProvider from './lib/providers/autoclaw.js';
import { addTask, updateTask, deleteTask, runTaskNow, runAllNow, testCredential, getCredits, loadTasks, saveTasks, startAllTasks, startCookieExpiryWatcher, checkStatusForTask, autoCheckToday, getTotalCreditsForTask, checkCreditExpiryNow } from './lib/tasks/index.js';
// 积分过期提醒：批次预览（只读）+ 手动立即检查
import { fetchCreditExpiryBatches } from './lib/checkin/credit-expiry.js';
import { getLogs } from './lib/checkin-log.js';
import { recordSnapshot, updateUsageStats, getUsageStats, getUsageStatsWithEstimates, getTaskUsageDetail, startDailySnapshot, removeTaskStats } from './lib/checkin-stats.js';

// ====== Init ======
initRecorder();
// ★显式启动告警巡检调度器（notify.js 已去除 import 副作用；只有 gateway 进程跑巡检，checkin 模块只用 sendMail）
startNotifyScheduler();

// 注册签到 Provider 并启动定时调度
registerProvider(traeProvider);
registerProvider(workbuddyProvider);
registerProvider(codeartsProvider);
registerProvider(autoclawProvider);
setTimeout(() => { try { startAllTasks(); } catch (e) { console.error('start checkin tasks:', e); } }, 5000);
setTimeout(() => { try { startCookieExpiryWatcher(); } catch (e) { console.error('start cookie expiry watcher:', e); } }, 5000);

// 签到积分每日零点快照：启动时先记录一次当前快照，之后每天零点记录
setTimeout(() => { try { recordSnapshot(); } catch (e) { console.error('initial checkin snapshot:', e); } }, 8000);
setTimeout(() => { try { startDailySnapshot(); } catch (e) { console.error('start checkin stats:', e); } }, 8000);

// 全局未捕获异常处理
process.on('uncaughtException', e => {
  try { writeFileSync(HOME+'/.monitor_data/crash.log', new Date().toISOString()+': '+e.stack+'\n', {flag:'a'}); } catch {}
});
process.on('unhandledRejection', (reason) => {
  try { writeFileSync(HOME+'/.monitor_data/crash.log', new Date().toISOString()+': unhandled: '+reason+'\n', {flag:'a'}); } catch {}
});

const PORT = parseInt(process.env.PORT || '3081');
const DASHBOARD_DIR = HOME + '/monitor/dashboard';

// ====== 模块反代（方案 B）：/api/checkin/* → mod-checkin (127.0.0.1:3083) ======
// 模块挂掉/重启中时返回 502 + 明确错误，前端 toast 可见；恢复后自动恢复正常。
const CHECKIN_UPSTREAM = { host: '127.0.0.1', port: parseInt(process.env.CHECKIN_PORT || '3083', 10) };
function proxyToCheckin(q, r) {
  const opts = {
    hostname: CHECKIN_UPSTREAM.host, port: CHECKIN_UPSTREAM.port,
    path: q.url, method: q.method, headers: { ...q.headers },
  };
  delete opts.headers['host'];
  delete opts.headers['connection'];
  const upstreamReq = httpReq(opts, (up) => {
    r.writeHead(up.statusCode, up.headers);
    up.pipe(r, { end: true });
  });
  upstreamReq.on('error', (e) => {
    if (!r.headersSent) {
      r.writeHead(502, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify({ ok: false, error: '签到模块不可用（正在重启或已停止）', detail: e.code || e.message }));
    } else { r.end(); }
  });
  q.pipe(upstreamReq, { end: true });
}

// MIME types
const MIME_MAP = {
  html: 'text/html; charset=utf-8', js: 'application/javascript', css: 'text/css',
  json: 'application/json', png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', xml: 'application/xml',
  txt: 'text/plain', map: 'application/octet-stream',
};

// ====== HTTP Server ======
const server = createServer(async (q, r) => {
  requestCount.total++;
  const today = new Date().toISOString().slice(0, 10);
  if (today === requestCount.todayDate) requestCount.today++;
  else { requestCount.today = 1; requestCount.todayDate = today; }

  r.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(q.url, 'http://localhost');
  const path = url.searchParams.get('path') || '';

  const send = (status, data, ct) => {
    if (r.headersSent) return;
    const buf = Buffer.from(data || '', 'utf-8');
    addApiBytes(buf.length);
    r.writeHead(status, { 'Content-Type': ct || 'application/json', 'Content-Length': buf.length });
    r.end(buf);
  };

  try {
    // ====== CORS preflight ======
    if (q.method === 'OPTIONS') {
      r.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      r.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      send(204, '');
      return;
    }

    // ====== Health：网关 + 各模块聚合健康（workflow/监控用） ======
    if (q.url === '/healthz') {
      const probe = (port) => new Promise((resolve) => {
        const req = httpReq({ hostname: '127.0.0.1', port, path: '/healthz', method: 'GET', timeout: 2000 }, (res) => {
          let body = ''; res.on('data', d => body += d); res.on('end', () => {
            try { resolve({ up: true, ...(JSON.parse(body)) }); } catch { resolve({ up: true }); }
          });
        });
        req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
        req.on('error', () => resolve({ up: false }));
        req.end();
      });
      const checkin = await probe(CHECKIN_UPSTREAM.port);
      const release = await probe(parseInt(process.env.RELEASE_PORT || '3084', 10));
      send(200, JSON.stringify({
        ok: true,
        gateway: { up: true, version: process.env.MONITOR_MODULE_VERSION || 'dev', uptimeMs: Math.round(process.uptime() * 1000), pid: process.pid },
        modules: { checkin, release },
      }));
      return;
    }

    // ====== Actions ======
    if (q.url.startsWith('/action')) {
      const cmd = url.searchParams.get('cmd') || '';
      const pid = url.searchParams.get('pid') || '';
      const result = await doAction(cmd, pid);
      send(result.ok ? 200 : 400, JSON.stringify(result));
      return;
    }

    // ====== Metrics API ======
    if (q.url === '/api') {
      const m = await metrics();
      m.procs.list.forEach(p => { const svc = findService(p.cmd); if (svc) p.svc = svc.action; });
      send(200, JSON.stringify(m));
      return;
    }

    // ====== SSE Stream (替代 3 秒轮询) ======
    if (q.url === '/api/stream') {
      r.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const tick = async () => {
        try {
          const m = await metrics();
          m.procs.list.forEach(p => { const svc = findService(p.cmd); if (svc) p.svc = svc.action; });
          r.write(`data: ${JSON.stringify(m)}\n\n`);
        } catch (e) {
          r.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        }
      };
      await tick(); // 立即推送首次数据
      const iv = setInterval(tick, 3000);
      const keepalive = setInterval(() => r.write(': heartbeat\n\n'), 15000); // 15s 心跳保活
      q.on('close', () => { clearInterval(iv); clearInterval(keepalive); });
      return;
    }

    // ====== History API ======
    if (q.url.startsWith('/api/history')) {
      send(200, JSON.stringify(history));
      return;
    }

    // ====== File API ======
    if (q.url.startsWith('/api/file') && q.method === 'GET') {
      const content = readFileContent(path);
      if (content === null) { send(404, JSON.stringify({ ok: false, error: '文件不存在' })); return; }
      send(200, JSON.stringify({ ok: true, content }));
      return;
    }
    if (q.url.startsWith('/api/file') && q.method === 'POST') {
      let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
      const ok = writeFileContent(path, body);
      send(ok ? 200 : 400, JSON.stringify(ok ? { ok: true, msg: '保存成功' } : { ok: false, error: '保存失败' }));
      return;
    }

    // ====== File Operations ======
    if (q.url.startsWith('/api/rename')) {
      const name = url.searchParams.get('name') || '';
      const result = renameItem(path, name);
      if (result === null) { send(404, JSON.stringify({ ok: false, error: '文件不存在' })); return; }
      if (result === 'exists') { send(409, JSON.stringify({ ok: false, error: '目标已存在' })); return; }
      send(200, JSON.stringify({ ok: true, msg: '重命名成功' }));
      return;
    }
    if (q.url.startsWith('/api/delete')) {
      const item = deleteItem(path);
      send(item ? 200 : 404, JSON.stringify(item ? { ok: true, msg: '删除成功' } : { ok: false, error: '删除失败' }));
      return;
    }
    if (q.url.startsWith('/api/mkdir')) {
      const ok = makeDir(path);
      send(ok ? 200 : 400, JSON.stringify(ok ? { ok: true, msg: '创建成功' } : { ok: false, error: '创建失败' }));
      return;
    }
    if (q.url.startsWith('/api/upload')) {
      const { fileName, data } = await parseUpload(q);
      writeFileSync(join(HOME, path || '', fileName), data);
      send(200, JSON.stringify({ ok: true, msg: '上传成功: ' + fileName }));
      return;
    }

    // ====== Directory Listing (JSON, for frontend) ======
    if (q.url.startsWith('/api/list-dir')) {
      const items = listDir(path);
      if (items === null) { send(404, JSON.stringify({ ok: false, error: '目录不存在' })); return; }
      const parent = path ? path.split('/').filter(Boolean).slice(0, -1).join('/') : '';
      const notes = loadNotes();
      send(200, JSON.stringify({ ok: true, path, parent, items, notes }));
      return;
    }

    // ====== Notes ======
    if (q.url.startsWith('/api/notes')) {
      const notes = loadNotes();
      if (q.method === 'GET') { send(200, JSON.stringify(notes)); return; }
      if (q.method === 'POST') {
        let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
        try {
          const { filePath, note } = JSON.parse(body);
          if (note) notes[filePath] = note; else delete notes[filePath];
          saveNotes(notes); send(200, JSON.stringify({ ok: true }));
        } catch { send(400, JSON.stringify({ ok: false })); }
        return;
      }
    }

    // ====== Save Hourly ======
    if (q.url.startsWith('/api/save-hourly')) {
      writeFileSync(DATA_DIR + '/hourly.json', JSON.stringify(hourlyBuckets));
      send(200, JSON.stringify({ ok: true }));
      return;
    }

    // ====== Subscriptions Management ======
    if (q.url.startsWith('/api/subscriptions')) {
      if (q.method === 'GET') {
        const list = subscriptions.map(s => ({ id: s.id, name: s.name, url: s.url, nodeCount: s.nodeCount || 0, lastUpdate: s.lastUpdate || null, usage: s.usage || null, profileTitle: s.profileTitle || null }));
        send(200, JSON.stringify({ ok: true, subscriptions: list }));
        return;
      }
      if (q.method === 'POST') {
        if (q.url.startsWith('/api/subscriptions/refresh')) {
          const id = url.searchParams.get('id') || '';
          const sub = subscriptions.find(s => s.id === id);
          if (!sub) { send(404, JSON.stringify({ ok: false, error: '订阅不存在' })); return; }
          // 只刷新指定订阅，其他订阅使用内存缓存的节点，不会重复下载
          const count = await regenerateConfig(sub.id);
          send(200, JSON.stringify({ ok: true, msg: `"${sub.name}" 已刷新，共 ${count} 个节点`, subscription: sub }));
          return;
        }
        let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
        let { name, url: subUrl } = JSON.parse(body);
        if (!name || !subUrl) { send(400, JSON.stringify({ ok: false, error: '缺少名称或订阅链接' })); return; }
        const sub = { id: Date.now().toString(36), name: name.trim(), url: subUrl.trim() };
        subscriptions.push(sub);
        // 添加后只刷新新订阅，其他用缓存
        const count = await regenerateConfig(sub.id);
        send(200, JSON.stringify({ ok: true, msg: `订阅已添加，共 ${count} 个节点`, subscription: sub }));
        return;
      }
      if (q.method === 'DELETE') {
        const id = url.searchParams.get('id') || '';
        const idx = subscriptions.findIndex(s => s.id === id);
        if (idx < 0) { send(404, JSON.stringify({ ok: false, error: '订阅不存在' })); return; }
        const removed = subscriptions.splice(idx, 1)[0];
        saveJSON(DATA_DIR + '/subscriptions.json', subscriptions);
        const count = await regenerateConfig();
        send(200, JSON.stringify({ ok: true, msg: `订阅 "${removed.name}" 已删除，剩余 ${count} 个节点` }));
        return;
      }
    }

    // ====== Legacy Single Subscription ======
    if (q.url.startsWith('/api/subscription')) {
      const SUB_FILE = HOME + '/.sub_url';
      if (q.method === 'GET') {
        let subUrl = '';
        try { subUrl = readFileSync(SUB_FILE, 'utf-8').trim(); } catch {}
        const sbProxies = SB_DISABLED ? null : await fetchJson('http://127.0.0.1:9090/proxies');
        const nodes = [];
        if (sbProxies?.proxies) {
          for (const [name, info] of Object.entries(sbProxies.proxies)) {
            const groupTypes = ['Selector', 'URLTest', 'Fallback', 'LoadBalance'];
            if (groupTypes.includes(info.type)) continue;
            if (name === 'GLOBAL' || name === 'direct') continue;
            let subName = '';
            for (const sub of subscriptions) {
              if (name.startsWith(sub.name + '_')) { subName = sub.name; break; }
            }
            nodes.push({ tag: name, type: info.type, subName });
          }
        }
        send(200, JSON.stringify({ ok: true, url: subUrl, nodes }));
        return;
      }
      if (q.method === 'POST') {
        let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
        let { url: subUrl } = JSON.parse(body);
        if (!subUrl) { send(400, JSON.stringify({ ok: false, error: '缺少订阅链接' })); return; }
        writeFileSync(SUB_FILE, subUrl, 'utf-8');
        const { nodes } = await parseSubscription(subUrl);
        if (!nodes || nodes.length === 0) { send(400, JSON.stringify({ ok: false, error: '未找到可用节点' })); return; }
        const config = generateSbConfig(nodes);
        writeFileSync(HOME + '/sb-config.json', config, 'utf-8');
        await run(`kill $(pgrep -x sing-box) 2>/dev/null; sleep 1; ENABLE_DEPRECATED_LEGACY_DNS_SERVERS=true ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER=true setsid sing-box run -c ${HOME}/sb-config.json &>/dev/null & disown`);
        send(200, JSON.stringify({ ok: true, msg: `成功加载 ${nodes.length} 个节点`, nodes: nodes.map(n => ({ tag: n.tag, server: n.server })) }));
        return;
      }
    }

    // ====== DNS Config ======
    if (q.url.startsWith('/api/dns-config')) {
      if (q.method === 'GET') {
        const dnsConfig = getDnsConfig();
        send(200, JSON.stringify({ ok: true, ...dnsConfig }));
        return;
      }
      if (q.method === 'POST') {
        let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
        let mode = '';
        try { ({ mode } = JSON.parse(body)); } catch { send(400, JSON.stringify({ ok: false, error: '请求体格式错误' })); return; }
        if (!mode) { send(400, JSON.stringify({ ok: false, error: '缺少 mode 参数' })); return; }
        try {
          const appliedMode = await applyDnsConfig(mode);
          send(200, JSON.stringify({ ok: true, mode: appliedMode, msg: 'DNS 模式已应用，sing-box 已重启' }));
        } catch (e) {
          send(400, JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }
    }

    // ====== Node Status ======
    if (q.url.startsWith('/api/node-status') && q.method === 'GET') {
      const force = url.searchParams.get('force') === '1';
      const now = Date.now();
      const CACHE_TTL = 3600000;
      if (!force && nodeStatusCache.data && (now - nodeStatusCache.time < CACHE_TTL)) {
        send(200, JSON.stringify({ ok: true, nodes: nodeStatusCache.data, cached: true, cacheTime: new Date(nodeStatusCache.time).toISOString() }));
        return;
      }
      const groupName = encodeURIComponent('节点选择');
      const [delays, sbProxies, sbCon] = await Promise.all([
        fetchJson(`http://127.0.0.1:9090/group/${groupName}/delay?url=https://www.google.com/generate_204&timeout=5000`),
        fetchJson('http://127.0.0.1:9090/proxies'),
        fetchJson('http://127.0.0.1:9090/connections'),
      ]);
      const trafficByNode = {};
      if (sbCon && sbCon.connections) {
        for (const c of sbCon.connections) {
          const dl = c.download || 0, ul = c.upload || 0;
          for (const node of (c.chains || [])) {
            if (!trafficByNode[node]) trafficByNode[node] = { download: 0, upload: 0, conns: 0 };
            trafficByNode[node].download += dl;
            trafficByNode[node].upload += ul;
            trafficByNode[node].conns++;
          }
        }
      }
      const nodes = [];
      if (sbProxies && sbProxies.proxies) {
        const groupTypes = ['Selector', 'URLTest', 'Fallback', 'LoadBalance'];
        for (const [name, info] of Object.entries(sbProxies.proxies)) {
          if (groupTypes.includes(info.type)) continue;
          if (name === 'GLOBAL' || name === 'direct') continue;
          let subName = '';
          for (const sub of subscriptions) {
            if (name.startsWith(sub.name + '_')) { subName = sub.name; break; }
          }
          const delay = delays && delays[name] !== undefined ? delays[name] : (info.history && info.history.length > 0 ? info.history[info.history.length - 1].delay : 0);
          const connected = delay > 0;
          const t = trafficByNode[name] || { download: 0, upload: 0, conns: 0 };
          nodes.push({ tag: name, type: info.type, subName, delay, connected, download: t.download, upload: t.upload, conns: t.conns });
        }
      }
      nodeStatusCache.data = nodes;
      nodeStatusCache.time = now;
      send(200, JSON.stringify({ ok: true, nodes, cached: false, cacheTime: new Date(now).toISOString() }));
      return;
    }

    // ====== Marked Processes ======
    if (q.url === '/api/marked-procs' && q.method === 'GET') {
      send(200, JSON.stringify({ ok: true, marked: markedProcs }));
      return;
    }
    if (q.url === '/api/marked-procs' && q.method === 'POST') {
      let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
      const data = JSON.parse(body);
      const kw = data.keyword;
      if (!kw) { send(400, JSON.stringify({ ok: false, error: '缺少 keyword' })); return; }
      const idx = markedProcs.indexOf(kw);
      if (idx >= 0) { markedProcs.splice(idx, 1); } else { markedProcs.push(kw); }
      saveJSON(DATA_DIR + '/marked_procs.json', markedProcs);
      send(200, JSON.stringify({ ok: true, marked: markedProcs, isMarked: idx < 0 }));
      return;
    }

    // ====== Service Rules（自定义服务识别规则，热加载） ======
    if (q.url.startsWith('/api/service-rules')) {
      if (q.method === 'GET') {
        // 返回内置规则和自定义规则
        send(200, JSON.stringify({ ok: true, builtin: SERVICE_CMDS, custom: getCustomServiceRules() }));
        return;
      }
      if (q.method === 'POST') {
        let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
        const { match, label, cmd } = JSON.parse(body);
        if (!match || !cmd) { send(400, JSON.stringify({ ok: false, error: '缺少 match 或 cmd' })); return; }
        const rules = getCustomServiceRules();
        const id = 'custom-' + Date.now().toString(36);
        rules.push({ match, label: label || '重启', action: id, cmd });
        saveCustomServiceRules(rules);
        send(200, JSON.stringify({ ok: true, msg: '规则已添加', rules }));
        return;
      }
      if (q.method === 'DELETE') {
        const action = url.searchParams.get('action') || '';
        const rules = getCustomServiceRules();
        const idx = rules.findIndex(r => r.action === action);
        if (idx < 0) { send(404, JSON.stringify({ ok: false, error: '规则不存在' })); return; }
        rules.splice(idx, 1);
        saveCustomServiceRules(rules);
        send(200, JSON.stringify({ ok: true, msg: '规则已删除', rules }));
        return;
      }
    }

    // ====== Email Notification ======
    if (q.url.startsWith('/api/notify')) {
      if (q.method === 'GET') {
        const psOut = await run('ps -eo args 2>/dev/null');
        const psLines = psOut.split('\n').map(l => l.trim()).filter(Boolean);
        // 进程监控列表只显示已标记的进程（markedProcs），不再回退到 monitored_procs
        const uniqueMarked = [...new Set(markedProcs)];
        // 按 kw 匹配到的实际进程去重：
        // 如果 sing-box 和 sing-box run 都匹配到同一进程行，只保留更具体的 kw（更长的）
        // 对于没匹配到任何进程的 kw，单独保留（未运行的进程也需要监控）
        const matchedLines = new Map(); // kw -> 匹配到的进程行
        for (const kw of uniqueMarked) {
          const lines = psLines.filter(l => l.includes(kw));
          if (lines.length) matchedLines.set(kw, lines);
        }
        // 按"匹配到的进程行集合"做签名去重：同一组进程行的多个 kw 只保留最长的
        const seenSignatures = new Set();
        const dedupedKws = [];
        // 先处理有匹配的 kw，按长度降序（更具体的优先）
        const matchedKws = [...matchedLines.keys()].sort((a, b) => b.length - a.length);
        for (const kw of matchedKws) {
          const lines = matchedLines.get(kw);
          // 签名：匹配到的进程行的排序拼接
          const sig = [...lines].sort().join('||');
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            dedupedKws.push(kw);
          }
        }
        // 未匹配到进程的 kw 单独保留（可能是未运行的服务，需要监控其掉线）
        for (const kw of uniqueMarked) {
          if (!matchedLines.has(kw)) dedupedKws.push(kw);
        }
        const candidates = dedupedKws.map(kw => {
          const running = psOut.includes(kw);
          return { cmd: kw, desc: running ? '运行中' : '未运行', running };
        });
        // monitored_procs 同步去重：短名称自动迁移到去重后的长名称
        // 例如 "sing-box" 被去重为 "sing-box run"，选中状态应迁移过去
        const dedupedSet = new Set(dedupedKws);
        const migratedMonitored = [];
        const seen = new Set();
        for (const p of (mailConfig.monitored_procs || [])) {
          if (dedupedSet.has(p)) {
            // 直接在去重列表里
            if (!seen.has(p)) { seen.add(p); migratedMonitored.push(p); }
          } else {
            // 不在去重列表里，可能是被去重的短名称，找对应的长名称
            // 短名称匹配到的进程行，是否被某个更长的 kw 也匹配到了
            const pLines = psLines.filter(l => l.includes(p));
            if (pLines.length) {
              const pSig = [...pLines].sort().join('||');
              // 找到签名相同的去重后 kw
              const mapped = dedupedKws.find(kw => {
                const kwLines = matchedLines.get(kw);
                if (!kwLines) return false;
                return [...kwLines].sort().join('||') === pSig;
              });
              if (mapped && !seen.has(mapped)) { seen.add(mapped); migratedMonitored.push(mapped); }
            }
          }
        }
        send(200, JSON.stringify({ ok: true, config: { ...mailConfig, monitored_procs: migratedMonitored, smtp_pass: mailConfig.smtp_pass ? '***' : '' }, candidates }));
        return;
      }
      if (q.url === '/api/notify/test' && q.method === 'POST') {
        const ok = await sendMail('[测试] Honor10 邮件通知', `这是一封测试邮件。\n如果你收到了这封邮件，说明邮件通知配置正确。`);
        send(ok ? 200 : 400, JSON.stringify(ok ? { ok: true, msg: '测试邮件已发送' } : { ok: false, error: '发送失败，请检查SMTP配置' }));
        return;
      }
      if (q.url === '/api/notify/test-device' && q.method === 'POST') {
        // 测试设备状况告警：实际采集设备数据并按当前阈值评估，强制发送（忽略冷却）
        try {
          const [memInfo, diskRaw, batteryRaw, wifiRaw, psAux] = await Promise.all([
            run('cat /proc/meminfo'),
            // 只取 /data 分区（Android 根分区 / 是只读系统分区，100% 是正常的，不需要监控）
            run("df -h | awk '$NF == \"/data\"'"),
            run('termux-battery-status 2>/dev/null'),
            run('termux-wifi-connectioninfo 2>/dev/null'),
            run('ps aux'),
          ]);
          const cfg = mailConfig.device_alerts || {};
          const lines = [];
          lines.push('=== 设备状况测试报告 ===');
          lines.push('');
          // 电池
          try {
            const batt = JSON.parse(batteryRaw);
            const pct = batt.percentage ?? batt.level ?? 0;
            const temp = parseFloat(batt.temperature) || 0;
            const _st = String(batt.status || '').toUpperCase();
            const _pl = String(batt.plugged || '').toUpperCase();
            const _charging = _st === 'CHARGING' || _st === 'FULL' || (_pl !== 'UNPLUGGED' && _pl !== '');
            const lowHit = pct <= (cfg.battery_low ?? 20) && !_charging;
            lines.push(`[电池] 电量: ${pct}% (阈值 < ${cfg.battery_low ?? 20}%) ${lowHit ? '⚠ 告警' : '✓ 正常'} ${_charging ? '(充电中,不告警)' : ''}`);
            lines.push(`[电池] 温度: ${temp}°C (阈值 > ${cfg.battery_temp_high ?? 45}°C) ${temp >= (cfg.battery_temp_high ?? 45) ? '⚠ 告警' : '✓ 正常'}`);
            lines.push(`[电池] 状态: ${batt.status || 'UNKNOWN'} / ${batt.plugged || 'UNKNOWN'} / 健康: ${batt.health || 'UNKNOWN'}`);
          } catch { lines.push('[电池] 数据获取失败（Termux:API 未安装或不可用）'); }
          // WiFi
          try {
            const wifi = JSON.parse(wifiRaw);
            const rssi = wifi.rssi ?? 0;
            lines.push(`[WiFi] 信号: ${rssi}dBm (阈值 < ${cfg.wifi_rssi_weak ?? -75}dBm) ${rssi !== 0 && rssi <= (cfg.wifi_rssi_weak ?? -75) ? '⚠ 告警' : '✓ 正常'}`);
            lines.push(`[WiFi] 速率: ${wifi.link_speed_mbps || 0}Mbps / 频率: ${wifi.frequency_mhz || 0}MHz`);
            lines.push(`[WiFi] IP: ${wifi.ip || '--'} / SSID: ${wifi.ssid || '--'}`);
          } catch { lines.push('[WiFi] 数据获取失败（Termux:API 未安装或不可用）'); }
          // 磁盘 - 逐行解析，找到百分比列（以 % 结尾），避免列索引错位
          const diskLines = diskRaw.trim().split('\n');
          for (const line of diskLines) {
            const cols = line.trim().split(/\s+/);
            const pctIdx = cols.findIndex(c => c.endsWith('%'));
            if (pctIdx >= 0) {
              const pct = parseInt(cols[pctIdx]) || 0;
              const mount = cols[cols.length - 1];
              lines.push(`[磁盘] ${mount} 使用率: ${pct}% (阈值 > ${cfg.disk_usage_high ?? 90}%) ${pct >= (cfg.disk_usage_high ?? 90) ? '⚠ 告警' : '✓ 正常'}`);
            }
          }
          // CPU
          const psLines = psAux.trim().split('\n');
          let cpuSum = 0;
          const cores = 8;
          for (let i = 1; i < psLines.length; i++) {
            const cols = psLines[i].trim().split(/\s+/);
            const val = parseFloat(cols[2]);
            if (!isNaN(val)) cpuSum += val;
          }
          const cpuUsage = Math.round(cpuSum / cores * 10) / 10;
          lines.push(`[CPU] 使用率: ${cpuUsage}% (阈值 > ${cfg.cpu_usage_high ?? 90}%) ${cpuUsage >= (cfg.cpu_usage_high ?? 90) ? '⚠ 告警' : '✓ 正常'}`);
          // 内存
          const m = {};
          memInfo.replace(/(\w+):\s+(\d+)/g, (_, k, v) => { m[k] = +v; return ''; });
          const memT = m.MemTotal ? Math.round(m.MemTotal / 1024) : 0;
          const memA = m.MemAvailable ? Math.round(m.MemAvailable / 1024) : 0;
          const memU = memT - memA;
          const memPct = memT ? Math.round(memU / memT * 100) : 0;
          lines.push(`[内存] 使用: ${memU}MB / ${memT}MB (${memPct}%, 阈值 > ${cfg.mem_usage_high ?? 90}%) ${memPct >= (cfg.mem_usage_high ?? 90) ? '⚠ 告警' : '✓ 正常'}`);
          lines.push('');
          lines.push('说明: 此邮件为手动触发的测试报告，展示当前设备状态及阈值评估结果。');
          const ok = await sendMail('[测试] Honor10 设备状况报告', lines.join('\n'));
          send(ok ? 200 : 400, JSON.stringify(ok ? { ok: true, msg: '设备状况测试报告已发送' } : { ok: false, error: '发送失败，请检查SMTP配置' }));
        } catch (e) {
          send(500, JSON.stringify({ ok: false, error: '测试失败: ' + e.message }));
        }
        return;
      }
      if (q.method === 'POST') {
        let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
        const data = JSON.parse(body);
        const newCfg = { ...mailConfig };
        for (const k of ['enabled', 'smtp_host', 'smtp_port', 'smtp_user', 'to', 'monitored_procs', 'proxy_check', 'device_alerts']) {
          if (data[k] !== undefined) newCfg[k] = data[k];
        }
        if (data.smtp_pass && data.smtp_pass !== '***') newCfg.smtp_pass = data.smtp_pass;
        Object.assign(mailConfig, newCfg);
        saveJSON(DATA_DIR + '/mail_config.json', mailConfig);
        // 重置进程状态（下次检查重新初始化，避免误报）
        resetProcStatus();
        send(200, JSON.stringify({ ok: true, msg: '配置已保存' }));
        return;
      }
    }

    // ====== Proxy Check API（供外部服务调用） ======
    if (q.url.startsWith('/api/proxy-check/run') && q.method === 'POST') {
      const force = url.searchParams.get('force') === '1';
      // 异步执行检测，立即返回，前端轮询日志看进度
      runProxyCheck(force).catch(e => {
        writeLog(HOME + '/logs/monitor/proxy_check.log', JSON.stringify({
          timestamp: new Date().toISOString(),
          node: '__error__',
          urls: [],
          ok: false,
          progress: '检测出错: ' + (e.message || String(e)),
        }));
      });
      send(200, JSON.stringify({ ok: true, msg: '检测已启动，请查看日志', started: true }));
      return;
    }
    if (q.url === '/api/proxy-check/status' && q.method === 'GET') {
      const proxyCheckLog = HOME + '/logs/monitor/proxy_check.log';
      let lastCheck = null;
      try {
        if (existsSync(proxyCheckLog)) {
          const lines = readFileSync(proxyCheckLog, 'utf-8').trim().split('\n').filter(Boolean);
          if (lines.length) lastCheck = JSON.parse(lines[lines.length - 1]);
        }
      } catch {}
      // 获取当前节点
      let currentNode = '';
      try {
        const proxies = await fetchJson('http://127.0.0.1:9090/proxies');
        if (proxies && proxies.proxies) {
          for (const [name, p] of Object.entries(proxies.proxies)) {
            if (p.now && p.type === 'Selector') { currentNode = p.now; break; }
          }
        }
      } catch {}
      send(200, JSON.stringify({
        ok: lastCheck?.ok ?? false,
        current_node: currentNode,
        last_check: lastCheck?.timestamp || null,
        candidate_nodes: mailConfig.proxy_check?.candidate_nodes || [],
        check_interval: mailConfig.proxy_check?.check_interval || 10,
      }));
      return;
    }
    if (q.url.startsWith('/api/proxy-check/set-node') && q.method === 'POST') {
      const nodeName = url.searchParams.get('node') || '';
      if (!nodeName) { send(400, JSON.stringify({ ok: false, error: '缺少 node 参数' })); return; }
      const ok = await switchNode(nodeName);
      send(ok ? 200 : 400, JSON.stringify({ ok, node: nodeName }));
      return;
    }
    if (q.url === '/api/proxy-check-logs' && q.method === 'GET') {
      const lines = readLogTail(HOME + '/logs/monitor/proxy_check.log', 500);
      // 软删除过滤：跳过已标记删除的条目
      const deletedSet = getDeletedTimestamps();
      const logs = lines.map(line => {
        try { return JSON.parse(line); } catch { return { node: '__error__', progress: line, timestamp: '', urls: [], ok: false }; }
      }).filter(entry => !entry.timestamp || !deletedSet.has(entry.timestamp));
      send(200, JSON.stringify({ ok: true, logs }));
      return;
    }
    if (q.url === '/api/proxy-check-logs/delete' && q.method === 'POST') {
      let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
      try {
        const { node } = JSON.parse(body || '{}');
        if (!node) { send(400, JSON.stringify({ ok: false, error: '缺少 node 参数' })); return; }
        const count = markNodeLogsDeleted(node);
        send(200, JSON.stringify({ ok: true, msg: `已删除 ${node} 的 ${count} 条日志`, deleted: count }));
      } catch (e) {
        send(400, JSON.stringify({ ok: false, error: '参数解析失败' }));
      }
      return;
    }
    if (q.url === '/api/proxy-check/weights' && q.method === 'GET') {
      const weights = getNodeWeights();
      send(200, JSON.stringify({ ok: true, weights }));
      return;
    }

    // ====== Android 进程管理 (通过 ADB) ======
    // ADB 设备序列号固定为本机 5555 端口（无线调试）
    const ADB_SERIAL = '127.0.0.1:5555';
    const ADB_ENV = `HOME=${HOME} ANDROID_SERIAL=${ADB_SERIAL}`;
    // ADB 检查连接，未连接时自动重连
    async function ensureAdb() {
      await run(`export ${ADB_ENV}; adb devices 2>/dev/null | grep -q "${ADB_SERIAL}\\s.*device" || (adb disconnect emulator-5554 2>/dev/null; adb connect ${ADB_SERIAL} 2>/dev/null; sleep 1)`);
      const out = await run(`export ${ADB_ENV}; adb devices 2>/dev/null`);
      return out.includes(`${ADB_SERIAL}\tdevice`);
    }

    // GET /api/android/processes - 列出所有 Android 进程
    if (q.url === '/api/android/processes' && q.method === 'GET') {
      const ok = await ensureAdb();
      if (!ok) { send(503, JSON.stringify({ ok: false, error: 'ADB 未连接，请检查手机无线调试是否开启' })); return; }
      // 用 top -n 1 -b 一次性快照，-o 指定输出列；TERM 过滤器避免 ANSI 干扰
      const out = await run(`export ${ADB_ENV}; adb shell top -n 1 -b 2>/dev/null | sed 's/\\x1b\\[[0-9;]*m//g'`);
      const lines = out.split('\n');
      const procs = [];
      let headerFound = false;
      let cols = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 跳过 Tasks/Mem/Swap/CPU 概览行
        if (/^(Tasks|Mem|Swap|[0-9]+%cpu)/i.test(trimmed)) continue;
        // 检测列头行（含 PID 和 ARGS 或 NAME）
        if (/PID/i.test(trimmed) && (/ARGS/i.test(trimmed) || /NAME/i.test(trimmed))) {
          cols = trimmed.split(/\s+/);
          headerFound = true;
          continue;
        }
        if (!headerFound) continue;
        // 解析数据行：PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ ARGS (12 列)
        const m = trimmed.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (m) {
          const pid = parseInt(m[1]);
          const user = m[2];
          // m[8]=S(状态), m[9]=%CPU, m[10]=%MEM, m[11]=TIME+, m[12]=ARGS
          const cpu = parseFloat(m[9]) || 0;
          const mem = parseFloat(m[10]) || 0;
          const timeStr = m[11];
          const args = m[12];
          // 跳过内核线程（args 以 [] 包裹）和本 adb 命令自身
          if (/^\[.+\]$/.test(args)) continue;
          if (args.includes('adb shell top')) continue;
          procs.push({ pid, user, cpu, mem, time: timeStr, args });
        }
      }
      // 按 CPU 降序排序
      procs.sort((a, b) => b.cpu - a.cpu);
      send(200, JSON.stringify({ ok: true, total: procs.length, processes: procs }));
      return;
    }

    // GET /api/android/apps - 列出第三方应用
    if (q.url === '/api/android/apps' && q.method === 'GET') {
      const ok = await ensureAdb();
      if (!ok) { send(503, JSON.stringify({ ok: false, error: 'ADB 未连接' })); return; }
      // 列出第三方包
      const out = await run(`export ${ADB_ENV}; adb shell pm list packages -3 2>/dev/null`);
      const packages = out.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
      // 获取运行中进程（用于标记是否在运行）
      const runOut = await run(`export ${ADB_ENV}; adb shell ps -A -o NAME 2>/dev/null`);
      const runningSet = new Set(runOut.split('\n').map(l => l.trim()).filter(Boolean));
      const apps = packages.map(pkg => ({
        package: pkg,
        running: runningSet.has(pkg),
      }));
      // 运行中的排前面
      apps.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || a.package.localeCompare(b.package));
      send(200, JSON.stringify({ ok: true, total: apps.length, apps }));
      return;
    }

    // POST /api/android/force-stop - 强制停止应用
    if (q.url === '/api/android/force-stop' && q.method === 'POST') {
      const ok = await ensureAdb();
      if (!ok) { send(503, JSON.stringify({ ok: false, error: 'ADB 未连接' })); return; }
      let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
      const { package: pkg } = JSON.parse(body || '{}');
      if (!pkg) { send(400, JSON.stringify({ ok: false, error: '缺少 package 参数' })); return; }
      const out = await run(`export ${ADB_ENV}; adb shell am force-stop ${pkg} 2>&1`);
      const success = !out || !out.toLowerCase().includes('exception');
      send(200, JSON.stringify({ ok: success, message: success ? `已强制停止 ${pkg}` : out }));
      return;
    }

    // POST /api/android/disable - 禁用应用
    if (q.url === '/api/android/disable' && q.method === 'POST') {
      const ok = await ensureAdb();
      if (!ok) { send(503, JSON.stringify({ ok: false, error: 'ADB 未连接' })); return; }
      let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
      const { package: pkg } = JSON.parse(body || '{}');
      if (!pkg) { send(400, JSON.stringify({ ok: false, error: '缺少 package 参数' })); return; }
      const out = await run(`export ${ADB_ENV}; adb shell pm disable-user --user 0 ${pkg} 2>&1`);
      const success = !out.toLowerCase().includes('exception') && !out.toLowerCase().includes('security');
      send(200, JSON.stringify({ ok: success, message: success ? `已禁用 ${pkg}` : out }));
      return;
    }

    // POST /api/android/enable - 启用应用
    if (q.url === '/api/android/enable' && q.method === 'POST') {
      const ok = await ensureAdb();
      if (!ok) { send(503, JSON.stringify({ ok: false, error: 'ADB 未连接' })); return; }
      let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
      const { package: pkg } = JSON.parse(body || '{}');
      if (!pkg) { send(400, JSON.stringify({ ok: false, error: '缺少 package 参数' })); return; }
      const out = await run(`export ${ADB_ENV}; adb shell pm enable ${pkg} 2>&1`);
      const success = !out.toLowerCase().includes('exception') && !out.toLowerCase().includes('security');
      send(200, JSON.stringify({ ok: success, message: success ? `已启用 ${pkg}` : out }));
      return;
    }

    // GET /api/android/status - ADB 连接状态
    if (q.url === '/api/android/status' && q.method === 'GET') {
      const ok = await ensureAdb();
      send(200, JSON.stringify({ ok: true, connected: ok }));
      return;
    }

    // POST /api/android/kill - 按 PID 终止进程 (adb shell kill -9)
    if (q.url === '/api/android/kill' && q.method === 'POST') {
      const ok = await ensureAdb();
      if (!ok) { send(503, JSON.stringify({ ok: false, error: 'ADB 未连接' })); return; }
      let body = ''; await new Promise(res => { q.on('data', d => body += d); q.on('end', res); });
      const { pid } = JSON.parse(body || '{}');
      if (!pid) { send(400, JSON.stringify({ ok: false, error: '缺少 pid 参数' })); return; }
      const out = await run(`export ${ADB_ENV}; adb shell kill -9 ${pid} 2>&1`);
      const fail = /Operation not permitted|No such process|Permission denied/i.test(out);
      send(200, JSON.stringify({ ok: !fail, message: fail ? out.trim() : `已终止 PID ${pid}` }));
      return;
    }

    // ====== Check-in (mod-checkin 独立进程，方案 B) ======
    // 整段 /api/checkin/* 反代到 127.0.0.1:3083 —— 签到模块独立更新/重启不影响其它功能。
    if (q.url.startsWith('/api/checkin/')) {
      proxyToCheckin(q, r);
      return;
    }

    // ====== Release worker (mod-release 独立进程, :3084) ======
    if (q.url.startsWith('/api/release/')) {
      const opts = { hostname: '127.0.0.1', port: parseInt(process.env.RELEASE_PORT || '3084', 10), path: q.url, method: q.method, headers: { ...q.headers } };
      delete opts.headers['host']; delete opts.headers['connection'];
      const rel = httpReq(opts, up => { r.writeHead(up.statusCode, up.headers); up.pipe(r, { end: true }); });
      rel.on('error', () => { if (!r.headersSent) { r.writeHead(502, {'Content-Type':'application/json'}); r.end(JSON.stringify({ ok:false, error:'发布模块不可用' })); } else r.end(); });
      q.pipe(rel, { end: true });
      return;
    }

    // ====== Sing-box Reverse Proxy ======
    if (q.url === '/dashboard' || q.url === '/sb' || q.url === '/dashboard/' || q.url === '/sb/') {
      r.writeHead(302, { Location: '/sb/ui/' });
      r.end();
      return;
    }
    // MetaCubeXD 静态资源优先匹配，避免被 /sb/ 反代规则误捕获
    if (q.url.startsWith('/sb/ui/') || q.url.startsWith('/dashboard/')) {
      let reqPath = q.url.replace(/^\/(sb\/ui|dashboard)/, '') || '/';
      // 标准化路径：去掉尾部斜杠和查询参数
      reqPath = reqPath.split('?')[0].replace(/\/+$/, '') || '/';
      let filePath = join(DASHBOARD_DIR, reqPath);
      // 如果路径是根目录或指向目录，优先返回 200.html（MetaCubeXD 真正的入口）
      // 注意：index.html 是 monitor 监控面板，不是 MetaCubeXD
      if (reqPath === '/' || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        const metaCubeEntry = join(DASHBOARD_DIR, '200.html');
        if (existsSync(metaCubeEntry)) {
          filePath = metaCubeEntry;
        } else {
          filePath = join(DASHBOARD_DIR, 'index.html');
        }
      }
      if (!filePath.startsWith(DASHBOARD_DIR) || !existsSync(filePath)) {
        send(404, 'Not Found', 'text/plain');
        return;
      }
      const ext = filePath.split('.').pop().toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      try {
        const content = readFileSync(filePath);
        send(200, content, mime);
      } catch { send(500, 'Internal Error', 'text/plain'); }
      return;
    }
    if (q.url.startsWith('/sb-api/') || q.url.startsWith('/sb/')) {
      const sbPath = q.url.startsWith('/sb-api/') ? q.url.slice(7) : q.url.slice(3);
      const sbOpts = {
        hostname: SB_HOST, port: SB_PORT, path: sbPath,
        method: q.method, headers: { ...q.headers },
      };
      delete sbOpts.headers['host'];
      delete sbOpts.headers['connection'];
      if (SB_SECRET) sbOpts.headers['authorization'] = 'Bearer ' + SB_SECRET;
      const sbReq = httpReq(sbOpts, sbRes => {
        r.writeHead(sbRes.statusCode, sbRes.headers);
        sbRes.pipe(r, { end: true });
      });
      sbReq.on('error', () => { if (!r.headersSent) r.writeHead(502); r.end('Bad Gateway'); });
      q.pipe(sbReq, { end: true });
      return;
    }

    // ====== Default: 404 (页面路由已迁移到 Cloudflare Pages) ======
    send(404, JSON.stringify({ error: 'Not Found', message: '页面已迁移到 Cloudflare Pages' }));
  } catch (e) {
    try { writeFileSync(HOME+'/.monitor_data/req_error.log', new Date().toISOString()+': '+e.stack+'\n', {flag:'a'}); } catch {}
    send(500, JSON.stringify({ error: e.message }));
  }
}).listen(PORT, '0.0.0.0', () => console.log('Monitor: 0.0.0.0:' + PORT));

// ====== WebSocket Upgrade for /sb/ (MetaCubeXD real-time) ======
server.on('upgrade', (req, socket, head) => {
  if (req.url && (req.url.startsWith('/sb-api/') || req.url.startsWith('/sb/'))) {
    const wsPath = req.url.startsWith('/sb-api/') ? req.url.slice(7) : req.url.slice(3);
    const wsHeaders = { ...req.headers, host: SB_HOST + ':' + SB_PORT };
    if (SB_SECRET) wsHeaders['authorization'] = 'Bearer ' + SB_SECRET;
    const wsReq = httpReq({
      hostname: SB_HOST, port: SB_PORT, path: wsPath,
      method: req.method, headers: wsHeaders,
    });
    wsReq.on('upgrade', (wsRes, wsSocket, wsHead) => {
      const respLines = ['HTTP/1.1 101 Switching Protocols'];
      for (const [k, v] of Object.entries(wsRes.headers)) respLines.push(k + ': ' + v);
      socket.write(respLines.join('\r\n') + '\r\n\r\n');
      if (wsHead && wsHead.length) socket.write(wsHead);
      wsSocket.pipe(socket);
      socket.pipe(wsSocket);
      wsSocket.on('error', () => socket.destroy());
      socket.on('error', () => wsSocket.destroy());
    });
    wsReq.on('error', () => socket.destroy());
    wsReq.end();
  } else {
    socket.destroy();
  }
});

// ====== Save hourly data periodically ======
setInterval(() => { writeFileSync(DATA_DIR + '/hourly.json', JSON.stringify(hourlyBuckets)); }, 60000);
