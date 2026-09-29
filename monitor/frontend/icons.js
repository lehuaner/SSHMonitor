/* ====== 全站 SVG 图标系统（lucide/feather 风格，24x24 stroke，MIT 规范几何） ======
 * 由 config.js 顶部注入，全站唯一。用法：
 *   HTML 模板串：ic('check')  →  <svg class="ic"><use href="#h10i-check"/></svg>
 *   <svg class="ic"><use href="#h10i-check"/></svg>（手写亦可）
 * defs 注入在 documentElement 上（body 之外）→ SPA swapBody 清空 body 不受影响；
 * 另暴露 window.__spaIcons() 供 router 切页兜底重注入（幂等）。
 */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var VB = '0 0 24 24';

  // name -> 子元素数组；['tag', {attrs}, ...] 递归
  var P = {
    activity:      [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
    'arrow-left':  [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
    ban:           [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm4.9 4.9 14.2 14.2' }]],
    'bar-chart':   [['line', { x1: 12, y1: 20, x2: 12, y2: 10 }], ['line', { x1: 18, y1: 20, x2: 18, y2: 4 }], ['line', { x1: 6, y1: 20, x2: 6, y2: 16 }]],
    bell:          [['path', { d: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9' }], ['path', { d: 'M10.3 21a1.94 1.94 0 0 0 3.4 0' }]],
    calendar:      [['rect', { x: 3, y: 4, width: 18, height: 18, rx: 2 }], ['line', { x1: 16, y1: 2, x2: 16, y2: 6 }], ['line', { x1: 8, y1: 2, x2: 8, y2: 6 }], ['line', { x1: 3, y1: 10, x2: 21, y2: 10 }]],
    'circle-check': [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm9 12 2 2 4-4' }]],
    'circle-x':    [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
    check:         [['path', { d: 'M20 6 9 17l-5-5' }]],
    clock:         [['circle', { cx: 12, cy: 12, r: 10 }], ['polyline', { points: '12 6 12 12 16 14' }]],
    download:      [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '7 10 12 15 17 10' }], ['line', { x1: 12, y1: 15, x2: 12, y2: 3 }]],
    eye:           [['path', { d: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    file:          [['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }], ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }], ['line', { x1: 16, y1: 13, x2: 8, y2: 13 }], ['line', { x1: 16, y1: 17, x2: 8, y2: 17 }]],
    'folder':      [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
    gem:           [['path', { d: 'M6 3h12l4 6-10 13L2 9Z' }], ['path', { d: 'M11 3 8 9l4 13 4-13-3-6' }], ['path', { d: 'M2 9h20' }]],
    globe:         [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }], ['path', { d: 'M2 12h20' }]],
    hourglass:     [['path', { d: 'M5 22h14' }], ['path', { d: 'M5 2h14' }], ['path', { d: 'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22' }], ['path', { d: 'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2' }]],
    info:          [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]],
    link:          [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
    mail:          [['rect', { x: 2, y: 4, width: 20, height: 16, rx: 2 }], ['path', { d: 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7' }]],
    package:       [['path', { d: 'M16.5 9.4 7.55 4.24' }], ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }], ['path', { d: 'M3.29 7 12 12l8.71-5' }], ['path', { d: 'M12 22V12' }]],
    pencil:        [['path', { d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5Z' }]],
    pin:           [['path', { d: 'M12 17v5' }], ['path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z' }]],
    play:          [['polygon', { points: '6 3 20 12 6 21 6 3', fill: 'currentColor', stroke: 'none' }]],
    plus:          [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
    refresh:       [['path', { d: 'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }], ['path', { d: 'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16' }], ['path', { d: 'M16 16h5v5' }]],
    rocket:        [['path', { d: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z' }], ['path', { d: 'm12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z' }], ['path', { d: 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0' }], ['path', { d: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5' }]],
    save:          [['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }], ['polyline', { points: '17 21 17 13 7 13 7 21' }], ['polyline', { points: '7 3 7 8 15 8' }]],
    satellite:     [['path', { d: 'M4 10a7.31 7.31 0 0 0 10 10Z' }], ['path', { d: 'm9 15 3-3' }], ['path', { d: 'M17 13a6 6 0 0 0-6-6' }], ['path', { d: 'M21 13A10 10 0 0 0 11 3' }]],
    settings:      [['line', { x1: 4, y1: 21, x2: 4, y2: 14 }], ['line', { x1: 4, y1: 10, x2: 4, y2: 3 }], ['line', { x1: 12, y1: 21, x2: 12, y2: 12 }], ['line', { x1: 12, y1: 8, x2: 12, y2: 3 }], ['line', { x1: 20, y1: 21, x2: 20, y2: 16 }], ['line', { x1: 20, y1: 12, x2: 20, y2: 3 }], ['line', { x1: 1, y1: 14, x2: 7, y2: 14 }], ['line', { x1: 9, y1: 8, x2: 15, y2: 8 }], ['line', { x1: 17, y1: 16, x2: 23, y2: 16 }]],
    smartphone:    [['rect', { x: 5, y: 2, width: 14, height: 20, rx: 2 }], ['line', { x1: 12, y1: 18, x2: 12.01, y2: 18 }]],
    terminal:      [['polyline', { points: '4 17 10 11 4 5' }], ['line', { x1: 12, y1: 19, x2: 20, y2: 19 }]],
    'trending-up': [['polyline', { points: '22 7 13.5 15.5 8.5 10.5 2 17' }], ['polyline', { points: '16 7 22 7 22 13' }]],
    trash:         [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }], ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }], ['line', { x1: 10, y1: 11, x2: 10, y2: 17 }], ['line', { x1: 14, y1: 11, x2: 14, y2: 17 }]],
    'triangle-alert': [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
    upload:        [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '17 8 12 3 7 8' }], ['line', { x1: 12, y1: 3, x2: 12, y2: 15 }]],
    'x':           [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    zap:           [['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2', fill: 'none' }]],
  };

  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function inject() {
    if (document.getElementById('h10-icon-defs')) return;
    var svg = el('svg', { id: 'h10-icon-defs', xmlns: NS });
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    for (var name in P) {
      var sym = el('symbol', { id: 'h10i-' + name, viewBox: VB });
      P[name].forEach(function (spec) { sym.appendChild(el(spec[0], spec[1])); });
      svg.appendChild(sym);
    }
    // 挂到 documentElement（body 之外）：SPA swapBody 清 body 时定义不丢
    document.documentElement.appendChild(svg);
  }

  // 模板字符串助手：ic('check') / ic('check','c-ok spin')
  window.ic = function (name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#h10i-' + name + '"></use></svg>';
  };
  window.__spaIcons = inject;

  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);
})();
