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
      // t 域名已纳入 Cloudflare Access：Pages Function 内部回源必须带服务令牌才能过门禁。
      // 密钥来自 Pages 环境变量（CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET），绝不写死进源码/仓库。
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
        headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET);
      }
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
