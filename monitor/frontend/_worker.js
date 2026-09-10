// Cloudflare Pages Worker - 统一入口
// - API/Action/Sing-box 请求 → 代理到后端（t.honor10.lehuan.vip 隧道）
// - 其他请求 → Pages 静态资源

const BACKEND = 'https://t.honor10.lehuan.vip';
const PROXY_PATHS = ['/api', '/action', '/sb', '/sb-api', '/dashboard'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ====== API / Action / Sing-box → 代理到后端 ======
    if (PROXY_PATHS.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) {
      const targetUrl = BACKEND + path + url.search;
      const headers = new Headers(request.headers);
      headers.delete('Host');
      headers.delete('content-length');
      let body;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = await request.text();
      }
      const proxyReq = new Request(targetUrl, {
        method: request.method,
        headers,
        body,
      });
      try {
        return await fetch(proxyReq);
      } catch (e) {
        return new Response(JSON.stringify({ error: '代理请求失败: ' + e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // ====== 静态文件 → Pages 正常处理 ======
    return env.ASSETS.fetch(request);
  }
};
