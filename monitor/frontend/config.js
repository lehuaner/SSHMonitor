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

// ====== 前后端版本一致性提示（Pages 异步发布可能滞后/失败） ======
(function () {
  function bar() {
    var el = document.getElementById('honor10-verbar');
    if (!el) {
      el = document.createElement('div');
      el.id = 'honor10-verbar';
      el.style.cssText = 'position:sticky;top:0;z-index:9999;padding:8px 14px;font:13px/1.5 system-ui,-sans-serif;color:#7a2b2b;background:#ffe8e8;border-bottom:1px solid #f0b9b9;display:none;';
      if (document.body) document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }
  async function check() {
    try {
      var r = await fetch('/api/release/version-status', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      var j = await r.json();
      var show = false, msg = '';
      if (j.mode === 'pages') {
        if (j.lastFail) {
          show = true;
          msg = '⚠ 上次 Pages 发布失败：' + String(j.lastFail.reason || '').slice(0, 140) + (j.lastFail.rolledBackTo ? ('（已回滚到 ' + j.lastFail.rolledBackTo + '，现网为旧版）') : '（保留现网旧版）');
        } else if (j.mismatch) {
          show = true;
          msg = '⚠ 前端(Pages) ' + (j.pages || '未发布') + ' 落后于后端 ' + (j.backend || '?') + '，Pages 异步更新中…';
        }
      }
      var el = bar();
      if (show) { el.textContent = msg; el.style.display = 'block'; } else { el.style.display = 'none'; }
    } catch (e) { /* 静默降级 */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
