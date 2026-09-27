/* ====== 全站统一导航（单一数据源） ======
 * 由 config.js 在每个页面自动注入加载（config.js 已在所有 *.html 引入）。
 * 目的：消除各页硬编码 <div class=nav>…</div> 的重复与漂移（曾导致「发布」按钮
 * 在 notify/files/subscription 等页缺失）。各页仅保留空的 <div class=nav></div>
 * 作为样式容器/占位；链接清单与高亮统一由本脚本按当前路径渲染。
 * 失败降级：若本脚本未加载，导航条为空但页面主体不受影响。
 */
(function () {
  'use strict';
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
  function build() {
    var html = NAV.map(function (it) {
      var cls = isActive(it.href) ? ' class=active' : '';
      var tgt = it.blank ? ' target=_blank' : '';
      return '<a href="' + it.href + '"' + tgt + cls + '>' + it.icon + ' ' + it.label + '</a>';
    }).join('');
    var nav = document.querySelector('.nav');
    if (!nav) {
      nav = document.createElement('div');
      nav.className = 'nav';
      var app = document.querySelector('.app') || document.body;
      app.insertBefore(nav, app.firstChild);
    }
    nav.innerHTML = html;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
