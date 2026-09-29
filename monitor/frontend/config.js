/* ====== SPA 生命周期：按「代(gen)」登记 setTimeout/setInterval 与事件监听，切页时清理上一页 ======
 * 必须在任何页面脚本之前安装（config.js 位于每个页面顶部，天然先执行）。 */
window.__spaLifecycle = (function () {
  var gen = 1, active = true;
  var timers = [], listeners = [];
  var rawST = window.setTimeout, rawCT = window.clearTimeout;
  var rawSI = window.setInterval, rawCI = window.clearInterval;
  var ET = (typeof EventTarget !== 'undefined' && EventTarget.prototype) ? EventTarget.prototype : (window.Node && window.Node.prototype);
  var rawAEL = ET && ET.addEventListener, rawREL = ET && ET.removeEventListener;
  window.setTimeout = function () { var id = rawST.apply(window, arguments); if (active) timers.push({ gen: gen, id: id, kind: 't' }); return id; };
  window.setInterval = function () { var id = rawSI.apply(window, arguments); if (active) timers.push({ gen: gen, id: id, kind: 'i' }); return id; };
  if (rawAEL) {
    ET.addEventListener = function (type, fn, opts) { if (active && fn) listeners.push({ gen: gen, t: this, type: type, fn: fn, opts: opts }); return rawAEL.call(this, type, fn, opts); };
    ET.removeEventListener = function (type, fn, opts) { if (fn) { for (var i = listeners.length - 1; i >= 0; i--) { var L = listeners[i]; if (L.t === this && L.type === type && L.fn === fn) { listeners.splice(i, 1); break; } } } return rawREL.call(this, type, fn, opts); };
  }
  function clearGen(g) {
    for (var i = timers.length - 1; i >= 0; i--) { var T = timers[i]; if (T.gen === g) { try { (T.kind === 'i' ? rawCI : rawCT).call(window, T.id); } catch (e) {} timers.splice(i, 1); } }
    for (var j = listeners.length - 1; j >= 0; j--) { var L = listeners[j]; if (L.gen === g) { try { rawREL.call(L.t, L.type, L.fn, L.opts); } catch (e) {} listeners.splice(j, 1); } }
  }
  return {
    beginGeneration: function () { gen++; },
    endGeneration: function () { clearGen(gen); },
    raw: function (fn) { var p = active; active = false; try { return fn(); } finally { active = p; } }
  };
})();

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

// ====== 全站 SVG 图标系统：先于 router.js 注入 icons.js（提供 ic()/defs，常驻不重加载） ======
(function () {
  function inject() {
    if (document.querySelector('script[data-icons]')) return;
    var s = document.createElement('script');
    s.src = '/icons.js';
    s.async = false;
    s.setAttribute('data-icons', '1');
    (document.head || document.body).appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();

// ====== 全站统一导航 + 局部刷新路由：加载 router.js（内含导航渲染 + 抓取换内容 + 按代清理） ======
// config.js 已在所有 *.html 顶部引入，故在此单点挂载。router.js 内部会渲染/高亮 .nav 并拦截同源的导航。
(function () {
  function inject() {
    if (document.querySelector('script[data-routerjs]')) return;
    var s = document.createElement('script');
    s.src = '/router.js';
    s.async = false;
    s.setAttribute('data-routerjs', '1');
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
