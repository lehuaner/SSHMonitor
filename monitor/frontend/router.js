/* ====== 全站局部刷新路由（抓取换内容，不清浏览器、不整页 reload） ======
 * 由 config.js 注入加载（与 nav.js 同一挂载点；nav.js 仍作为无 router 时的降级）。
 * 目标：点击顶部标签只替换 <head> 样式 + <body> 内容并重跑目标页脚本，导航/主题保持；
 *      sing-box 等 _blank / 外域 / # 锚点维持原生跳转。
 * 防泄漏：各页 body 末尾脚本会起常驻 setTimeout/轮询与 window/document 监听，
 *      由 config.js 安装的 __spaLifecycle 按「代(gen)」登记，切换页面时清理上一页的定时器与监听。
 * 兜底：fetch/解析/替换任一环节异常 → 直接 location.href 整页跳转，功能绝不因 SPA 破坏。
 */
(function () {
  'use strict';
  var LIFE = window.__spaLifecycle;
  if (!LIFE) return; // 生命周期补丁未安装（异常环境）→ 不启用 SPA，维持原生整页跳转

  var NAV = [
    { href: '/', label: '监控', icon: '▼' },
    { href: '/sb/ui/', label: 'Sing-box', icon: '⚙', blank: true },
    { href: '/subscription', label: '订阅', icon: '📦' },
    { href: '/notify', label: '通知', icon: '🔔' },
    { href: '/files', label: '文件', icon: '📁' },
    { href: '/android', label: 'Android', icon: '📱' },
    { href: '/checkin', label: '签到', icon: '✅' },
    { href: '/release', label: '发布', icon: '🚀' }
  ];

  function currentPath() {
    var p = (location.pathname || '/').replace(/\/+$/, '');
    return p || '/';
  }
  function isActive(href) {
    var p = currentPath();
    if (href === '/') return p === '/';
    return p === href || p.indexOf(href + '/') === 0;
  }
  function renderNav() {
    var nav = document.querySelector('.nav');
    if (!nav) {
      nav = document.createElement('div');
      nav.className = 'nav';
      var app = document.querySelector('.app') || document.body;
      app.insertBefore(nav, app.firstChild);
    }
    nav.innerHTML = NAV.map(function (it) {
      var cls = isActive(it.href) ? ' class=active' : '';
      var tgt = it.blank ? ' target=_blank' : '';
      return '<a href="' + it.href + '"' + tgt + cls + '>' + it.icon + ' ' + it.label + '</a>';
    }).join('');
  }

  // 常驻脚本：切换内容时不重复加载（避免 fetch 拦截器/生命周期被二次包裹）
  function isResident(src) { return /(?:config|nav|router)\.js/.test(src || ''); }

  function swapBody(doc) {
    // 1) 清理上一页（当前 gen）登记的定时器/监听
    LIFE.endGeneration();
    // 2) 进入新的一代，供目标页脚本登记
    LIFE.beginGeneration();
    // 3) 样式：移除本站 spa 注入的旧样式，注入目标页 <style>（head 或 body 内）
    document.querySelectorAll('style[data-spa]').forEach(function (n) { n.parentNode && n.parentNode.removeChild(n); });
    var styles = doc.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      var c = styles[i].cloneNode(true);
      c.setAttribute('data-spa', '1');
      document.head.appendChild(c);
    }
    // 4) 摘出目标页所有脚本（含 head/body），其余内容整体搬入当前文档
    var scripts = Array.prototype.slice.call(doc.querySelectorAll('script'));
    scripts.forEach(function (s) { s.parentNode && s.parentNode.removeChild(s); });
    // 5) 清空并替换当前 body 内容
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) {
      document.body.appendChild(document.importNode(n, true));
    });
    // 6) 重跑目标页脚本：常驻脚本跳过；其余重建为新的 <script> 元素（内联即时执行、外链加载执行）
    scripts.forEach(function (s) {
      var src = s.getAttribute('src');
      if (isResident(src)) return;
      var n = document.createElement('script');
      if (src) n.src = src; else n.textContent = s.textContent;
      if (s.type) n.type = s.type;
      document.body.appendChild(n);
    });
  }

  var busy = false;
  async function navigate(href, push) {
    if (busy) return;
    var url;
    try { url = new URL(href, location.href); } catch (e) { return; }
    if (url.origin !== location.origin) { location.href = url.href; return; }
    busy = true;
    try {
      var res = await fetch(url.href, { headers: { 'x-spa': '1' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var html = await res.text();
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc || !doc.body) throw new Error('bad doc');
      swapBody(doc);
      if (push !== false) history.pushState({ spa: 1 }, '', url.href);
      if (doc.title) document.title = doc.title;
      renderNav();
      window.scrollTo(0, 0);
    } catch (e) {
      // 任一环节失败 → 原生整页跳转兜底
      busy = false;
      location.href = url.href;
      return;
    }
    busy = false;
  }

  function internalLink(el) {
    if (!el || el.tagName !== 'A') return null;
    var href = el.getAttribute('href');
    if (!href || href.charAt(0) === '#') return null;
    if (el.target === '_blank' || el.hasAttribute('download')) return null;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return null;
    try { if (new URL(href, location.href).origin !== location.origin) return null; } catch (e) { return null; }
    return href;
  }

  // 用「免登记」方式绑定路由自身的常驻监听，避免被 gen 清理掉
  LIFE.raw(function () {
    document.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      var href = internalLink(a);
      if (!href) return;
      ev.preventDefault();
      navigate(href, true);
    }, false);

    window.addEventListener('popstate', function () {
      navigate(location.pathname + location.search, false);
    }, false);
  });

  function init() { renderNav(); }
  if (document.readyState === 'loading') LIFE.raw(function () { document.addEventListener('DOMContentLoaded', init, false); });
  else init();
})();
