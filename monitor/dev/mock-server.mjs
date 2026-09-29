/* ====== 本地前端开发服务器（mock 数据，零依赖） ======
 * 用途：不连手机、不发生产，即可在局域网内多设备预览全站前端。
 * 数据：dev/mock/*.json —— 由 dev/get-mock.phone.mjs 从手机端真实接口抓取并脱敏。
 * 路由：
 *   GET /api/**  → 命中 mock（键=路径 '/'→'_'，忽略 query）→ 未命中回 {ok:true,__mock}
 *   其它方法     → 通用 {ok:true,__mock:'stub'} 放行（UI 流程不报错）；release/task 特判 done
 *   GET /action  → {ok:true}
 *   页面/静态    → ../frontend（clean URL：/checkin → checkin.html；/api 前缀优先）
 * 启动：node monitor/dev/mock-server.mjs [--port 8090]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..', 'frontend');
const MOCK = join(HERE, 'mock');
const argPort = (() => { const i = process.argv.indexOf('--port'); return i > -1 ? +process.argv[i + 1] : 0; })();
const PORT = argPort || +(process.env.DEV_PORT || 8090);
const HOST = process.env.DEV_HOST || '0.0.0.0'; // 局域网可访问

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/octet-stream', '.txt': 'text/plain',
};

function keyOf(pathname) {
  return pathname.replace(/^\//, '').replace(/\//g, '_') + '.json';
}
function readMock(pathname) {
  const p = join(MOCK, keyOf(pathname));
  if (!p.startsWith(MOCK) || !existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

/* ---- 交互式写操作的 mock 特判：让前端流程走通且可观察 ---- */
function stubFor(pathname, method) {
  if (pathname.startsWith('/api/release/task')) return { ok: true, task: { id: 'mock', state: 'done', step: 'mock 完成', logs: ['[mock] 操作已模拟完成'] }, __mock: 'stub' };
  if (pathname === '/api/release/apply' || pathname === '/api/release/rollback') return { ok: true, taskId: 'mock-task', __mock: 'stub' };
  if (pathname === '/api/release/upstream/check') return { ok: true, ...(readMock('/api/release/upstream') || {}), __mock: 'stub' };
  if (pathname.startsWith('/api/checkin/run') || pathname.startsWith('/api/checkin/test') || pathname.startsWith('/api/checkin/status') || pathname.startsWith('/api/checkin/sms-login') || pathname.startsWith('/api/checkin/verify-code'))
    return { ok: true, msg: '[mock] 操作已模拟', __mock: 'stub' };
  if (method === 'GET' || method === 'HEAD') return null;
  return { ok: true, msg: '[mock] 已接受（无真实后端）', __mock: 'stub' };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ====== API / action → mock ======
  if (p === '/api' || p.startsWith('/api/') || p === '/action') {
    if (p === '/action') return json(res, 200, { ok: true, __mock: 'stub' });
    const data = readMock(p);
    if (data != null) return json(res, 200, data);
    const stub = stubFor(p, req.method);
    if (stub != null) return json(res, 200, stub);
    return json(res, 200, { ok: true, __mock: 'empty', note: 'mock 无此端点数据: ' + p });
  }

  // ====== sing-box 面板等外链：本地无后端，给出明确提示页 ======
  if (p.startsWith('/sb') || p.startsWith('/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><meta charset=utf-8><title>mock</title><body style="font:14px system-ui;padding:40px;color:#94a3b8;background:#0b1120">sing-box 面板不在本地 mock 范围内（生产由反向代理提供）。请从顶部导航切换到其它页面。</body>');
    return;
  }

  // ====== 静态：frontend 目录（clean URL 补 .html） ======
  let rel = decodeURIComponent(p);
  if (rel === '/') rel = '/index.html';
  let file = join(FRONTEND, normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(FRONTEND)) { res.writeHead(403); return res.end('forbidden'); }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (existsSync(file + '.html')) file += '.html';
    else {
      // SPA 路由兜底：未知路径回首页
      const idx = join(FRONTEND, 'index.html');
      if (existsSync(idx)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(readFileSync(idx)); }
      res.writeHead(404); return res.end('not found');
    }
  }
  const ext = extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});

function lanIP() {
  for (const list of Object.values(networkInterfaces()))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) return n.address;
  return '127.0.0.1';
}

/* ====== 端口占用自愈：EADDRINUSE → 找到 LISTENING 该端口的 PID → taskkill → 重试 ======
 * 保护：只杀 node 进程（历史残留的 mock 实例）；非 node 占用（系统/其它服务）仅提示不杀，
 * 避免端口撞上重要服务时被误杀。 */
function killPortOccupant(port) {
  let out = '';
  try { out = execSync('netstat -ano -p tcp', { encoding: 'utf8' }); } catch { return 0; }
  let killed = 0;
  for (const line of out.split('\n')) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    // 格式：TCP  本地地址  远程地址  状态  PID —— 本地地址列尾部 :PORT 精确匹配
    if (!new RegExp(':' + port + '$').test(cols[1] || '')) continue;
    const pid = +cols[cols.length - 1];
    if (!pid || pid === process.pid) continue;
    let name = '';
    try { name = (execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8' }).trim().split(/\s+/)[0] || '').toLowerCase(); } catch {}
    if (name !== 'node.exe') {
      console.log(`[端口] ${port} 被非 node 进程占用（PID ${pid}: ${name || '?'}），为安全不杀掉。请用 run-dev.bat 8123 换端口。`);
      continue;
    }
    try { execSync(`taskkill /PID ${pid} /F`); console.log(`[端口] 已杀掉残留 mock 实例 PID=${pid}（占用 ${port}）`); killed++; } catch {}
  }
  return killed;
}

function listenWithRetry(retry) {
  const onListening = () => {
    const ip = lanIP();
    console.log('SSHMonitor 前端 dev（mock 数据，勿用于生产）');
    console.log(`  本机:     http://localhost:${PORT}`);
    console.log(`  局域网:   http://${ip}:${PORT}   ← 手机/其它设备访问此地址`);
    console.log(`  mock 数据: ${MOCK}`);
    console.log(`  前端目录: ${FRONTEND}`);
  };
  const onError = (err) => {
    server.removeListener('error', onError);
    // listen(port,host,cb) 的 cb 实为 once('listening')，失败时不会自动摘除；
    // 不手动移除会在重试成功后把 banner 打两遍
    server.removeListener('listening', onListening);
    if (err.code !== 'EADDRINUSE') { console.error(err); process.exit(1); }
    if (retry <= 0 || !killPortOccupant(PORT)) {
      console.error(`[端口] ${PORT} 仍被占用，启动失败。可换端口：run-dev.bat 8123`);
      process.exit(1);
    }
    setTimeout(() => listenWithRetry(retry - 1), 400);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(PORT, HOST);
}

listenWithRetry(2);
