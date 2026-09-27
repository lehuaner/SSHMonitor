// ====== API Base URL ======
// 本地开发: 留空（同源）
// Cloudflare Pages: 替换为你的后端地址
//   例: 'https://your-tunnel-domain.com' 或 'https://your-server-ip:3081'
window.API_BASE = '';
// Cloudflare Pages 同源模式（_worker.js 代理 API 请求到后端）
// 本地测试时保持空字符串即可

// ====== Fetch interceptor: 自动给相对路径 API 请求加上前缀 ======
(function() {
  const base = window.API_BASE;
  if (!base) return; // 同源时不用拦截

  const origFetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) {
      url = base + url;
    }
    return origFetch.call(this, url, opts);
  };
})();

// ====== 全站统一导航注入：加载 nav.js（单一数据源，消除各页硬编码导航漂移） ======
// config.js 已在所有 *.html 引入，故在此单点挂载；nav.js 按当前路径渲染并高亮 .nav。
(function () {
  function inject() {
    if (document.querySelector('script[data-navjs]')) return;
    var s = document.createElement('script');
    s.src = '/nav.js';
    s.async = false;
    s.setAttribute('data-navjs', '1');
    (document.head || document.body).appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
