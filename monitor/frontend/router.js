/* ====== 全站局部刷新路由（抓取换内容，不整页 reload；导航/主题保持） ======
 * 由 config.js 注入加载。点击顶部标签：fetch 目标页 → 只替换 <head> 样式 + <body> 内容 →
 * 按文档顺序「串行」重放脚本：外链(chart.js 等)已加载则跳过、未加载则 await onload 后再放下一个，
 * 内联逻辑在其依赖的外链就绪后执行 → 修复“切页数据不加载(外链异步抢跑)”问题。
 * sing-box / 外域 / _blank / # 维持原生跳转；任一环节异常 → location.href 整页兜底。
 * 定时器/监听泄漏由 config.js 安装的 __spaLifecycle 按「代(gen)」在切页时清理。
 */
(function () {
  'use strict';
  var LIFE = window.__spaLifecycle;
  if (!LIFE) return; // 未安装生命周期补丁 → 不启用 SPA，维持原生整页跳转

  var NAV = [
    { href: '/', label: '监控', icon: 'activity' },
    { href: '/sb/ui/', label: '内核面板', icon: 'settings', blank: true },
    { href: '/subscription', label: '订阅', icon: 'package' },
    { href: '/notify', label: '通知', icon: 'bell' },
    { href: '/files', label: '文件', icon: 'folder' },
    { href: '/android', label: 'Android', icon: 'smartphone' },
    { href: '/checkin', label: '签到', icon: 'circle-check' },
    { href: '/release', label: '发布', icon: 'rocket' }
  ];

  // 常驻脚本：切换内容时永不重复加载
  function isResident(src) { return /(?:config|nav|icons|router|site)\.js|site\.css/.test(src || ''); }
  // 已加载的外部脚本 src（绝对化），避免每次切页重复拉取 CDN（chart.js）
  var loadedSrcs = new Set();
  function absSrc(u) { try { return new URL(u, location.href).href; } catch (e) { return String(u); } }

  function currentPath() { var p = (location.pathname || '/').replace(/\/+$/, ''); return p || '/'; }
  function isActive(href) { var p = currentPath(); if (href === '/') return p === '/'; return p === href || p.indexOf(href + '/') === 0; }
  function renderNav() {
    var nav = document.querySelector('.nav');
    if (!nav) {
      nav = document.createElement('div'); nav.className = 'nav';
      var app = document.querySelector('.app') || document.body;
      app.insertBefore(nav, app.firstChild);
    }
    nav.innerHTML = NAV.map(function (it) {
      var cls = isActive(it.href) ? ' class=active' : '';
      var tgt = it.blank ? ' target=_blank' : '';
      var ico = window.ic ? ic(it.icon, 'ic-nav') : '';
      return '<a href="' + it.href + '"' + tgt + cls + '>' + ico + ' ' + it.label + '</a>';
    }).join('');
  }

  // 串行加载一个外链脚本，等待其 onload/onerror 后再返回（保证后续内联依赖就绪）
  function loadExternal(src, type) {
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      if (type) s.type = type;
      s.src = src;
      var done = false; var finish = function () { if (done) return; done = true; resolve(); };
      s.addEventListener('load', finish); s.addEventListener('error', finish);
      document.body.appendChild(s);
      setTimeout(finish, 8000); // 兜底：外链超时也不卡死流程
    });
  }

  async function swapBody(doc) {
    // 1) 清理上一页定时/监听，进入新一代
    LIFE.endGeneration();
    LIFE.beginGeneration();
    // 2) 样式：移除上次注入的 spa 样式，注入目标页 <style>（追加到 head 末尾，就近覆盖）
    document.querySelectorAll('style[data-spa]').forEach(function (n) { n.parentNode && n.parentNode.removeChild(n); });
    doc.querySelectorAll('style').forEach(function (st) {
      var c = st.cloneNode(true); c.setAttribute('data-spa', '1'); document.head.appendChild(c);
    });
    // 3) 摘出目标页所有脚本（文档顺序），其余内容整体搬入当前 body
    var scripts = Array.prototype.slice.call(doc.querySelectorAll('script'));
    scripts.forEach(function (s) { s.parentNode && s.parentNode.removeChild(s); });
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) {
      document.body.appendChild(document.importNode(n, true));
    });
    // 4) 按文档顺序串行重放脚本：外链 await、内联立即执行；已加载外链与常驻脚本跳过
    renderNav();
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var src = s.getAttribute('src');
      if (src) {
        if (isResident(src)) continue;
        var key = absSrc(src);
        if (loadedSrcs.has(key)) continue;
        await loadExternal(src, s.type);
        loadedSrcs.add(key);
      } else {
        var n = document.createElement('script');
        if (s.type) n.type = s.type;
        n.textContent = s.textContent;
        document.body.appendChild(n); // 内联脚本即时执行（其依赖的外链已在其之前加载）
      }
    }
  }

  var busy = false;
  async function navigate(href, push) {
    if (busy) return;
    var url; try { url = new URL(href, location.href); } catch (e) { return; }
    if (url.origin !== location.origin) { location.href = url.href; return; }
    busy = true;
    try {
      var res = await fetch(url.href, { headers: { 'x-spa': '1' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var html = await res.text();
      var doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc || !doc.body) throw new Error('bad doc');
      await swapBody(doc);
      if (push !== false) history.pushState({ spa: 1 }, '', url.href);
      if (doc.title) document.title = doc.title;
      renderNav();
      window.scrollTo(0, 0);
    } catch (e) {
      busy = false; location.href = url.href; return; // 任一异常 → 原生整页兜底
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

  // 路由自身常驻监听：免登记（不被 gen 清理）
  LIFE.raw(function () {
    document.addEventListener('click', function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      var href = internalLink(a);
      if (!href) return;
      ev.preventDefault();
      navigate(href, true);
    }, false);
    window.addEventListener('popstate', function () { navigate(location.pathname + location.search, false); }, false);
  });

  function init() {
    // 种子：当前文档已存在的外部脚本视为已加载，避免首屏后切页重复拉取
    document.querySelectorAll('script[src]').forEach(function (s) {
      var src = s.getAttribute('src'); if (src && !isResident(src)) loadedSrcs.add(absSrc(src));
    });
    renderNav();
  }
  if (document.readyState === 'loading') LIFE.raw(function () { document.addEventListener('DOMContentLoaded', init, false); });
  else init();
})();
