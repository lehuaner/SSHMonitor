/**
 * 模块化基础设施（方案 B：gateway + 模块子进程）。
 *
 * 每个模块 = 一个独立 node 进程，只监听 127.0.0.1（安全：外部流量必须经 gateway 反代），
 * 暴露统一契约：
 *   GET /healthz         → { ok, module, version, uptimeMs, pid }
 *   POST /admin/shutdown → 优雅停机（gateway/workflow 用；token 校验）
 * 优雅停机流程：收到 SIGTERM / shutdown → stopHooks 依次执行（停定时器/调度器）
 *   → 等待在途请求（最多 drainTimeoutMs）→ process.exit(0)。runit 检测退出后自动拉起新实例。
 */
import { createServer } from 'node:http';

const START_MS = Date.now();

/**
 * 创建一个模块 HTTP server。
 * @param {object} opts
 * @param {string} opts.name        模块名（core / checkin）
 * @param {string} opts.version     模块版本（部署时写入）
 * @param {number} opts.port        监听端口（只绑 127.0.0.1）
 * @param {string} [opts.shutdownToken] /admin/shutdown 的 Bearer token（缺省从 MONITOR_SHUTDOWN_TOKEN 读取）
 * @param {(req:URL, req2:import('node:http').IncomingMessage, res:import('node:http').ServerResponse, send:Function)=>Promise<boolean>|boolean}
 *   opts.router  路由函数：返回 true 表示已处理；参数 (url, req, res, send)
 * @param {Array<()=>Promise|void>} [opts.stopHooks] 优雅停机钩子（停调度器等）
 * @param {number} [opts.drainTimeoutMs] 在途请求排空等待上限，默认 8000
 */
export function createModuleServer({ name, version = 'dev', port, shutdownToken = process.env.MONITOR_SHUTDOWN_TOKEN || '', router, stopHooks = [], drainTimeoutMs = 8000 }) {
  let shuttingDown = false;
  let inflight = 0;

  const server = createServer(async (req, res) => {
    if (shuttingDown) {
      res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ ok: false, error: 'shutting down' }));
      return;
    }
    inflight++;
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, data, ct) => {
      if (res.headersSent) return;
      const buf = Buffer.from(data || '', 'utf-8');
      res.writeHead(status, { 'Content-Type': ct || 'application/json', 'Content-Length': buf.length });
      res.end(buf);
    };
    try {
      // 统一健康检查
      if (url.pathname === '/healthz') {
        send(200, JSON.stringify({ ok: true, module: name, version, uptimeMs: Date.now() - START_MS, pid: process.pid }));
        return;
      }
      // 优雅停机端点（本机回环调用，带 token 才执行）
      if (url.pathname === '/admin/shutdown' && req.method === 'POST') {
        const auth = String(req.headers.authorization || '');
        if (shutdownToken && auth === `Bearer ${shutdownToken}`) {
          send(200, JSON.stringify({ ok: true, message: 'shutting down' }));
          setTimeout(() => gracefulShutdown('admin/shutdown'), 50);
          return;
        }
        send(403, JSON.stringify({ ok: false, error: 'invalid shutdown token' }));
        return;
      }
      // CORS（网关同机反代，宽松即可）
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        send(204, '');
        return;
      }
      const handled = await router(url, req, res, send);
      if (!handled) send(404, JSON.stringify({ ok: false, error: 'Not Found', module: name }));
    } catch (e) {
      try { send(500, JSON.stringify({ ok: false, error: e.message })); } catch {}
    } finally {
      inflight--;
    }
  });

  /** 优雅停机：stopHooks → 等待在途请求 → exit(0)（runit 会拉起新实例） */
  function gracefulShutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${name}] graceful shutdown: ${reason}`);
    const started = Date.now();
    (async () => {
      for (const hook of stopHooks) {
        try { await hook(); } catch (e) { console.error(`[${name}] stopHook error:`, e.message); }
      }
      // 上限等待在途请求归零
      while (inflight > 0 && Date.now() - started < drainTimeoutMs) {
        await new Promise(r2 => setTimeout(r2, 100));
      }
      server.close(() => process.exit(0));
      // close 等待长连接（SSE）超时则强退
      setTimeout(() => process.exit(0), Math.max(1000, drainTimeoutMs - (Date.now() - started))).unref();
    })();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // ★只绑 127.0.0.1：外部流量必须走 gateway，模块端口不可绕过
    server.listen(port, '127.0.0.1', () => {
      console.log(`[${name}] listening on 127.0.0.1:${port} v${version} pid=${process.pid}`);
      resolve({ server, gracefulShutdown });
    });
  });
}

/** 读取请求体的 Promise 包装（各模块路由复用） */
export function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(body));
  });
}
