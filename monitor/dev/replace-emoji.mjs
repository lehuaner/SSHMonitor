// 一次性脚本：全站 emoji → SVG 图标（ic() 片段 / 内联 svg）
// 用法: node monitor/dev/replace-emoji.mjs
// 映射原则：彩色 emoji 全替换；单色文本符号（→ ▸ ▾ ▼ ✓ ✗ ✕ ★ ☑ ◈ ✎ ⇒ ≥ ①-⑥ ⬆ ⬇ ⚠）保留。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const SVG = (n) => `<svg class="ic"><use href="#h10i-${n}"></use></svg>`;

// 码点 → 图标名（同时覆盖字面字符与 &#DDD;/&#xHH; 实体两种写法）
const MAP = {
  0x2705: 'circle-check', // ✅
  0x274c: 'circle-x',     // ❌
  0x23f3: 'hourglass',    // ⏳
  0x2139: 'info',         // ℹ（连同后面的 FE0F）
  0x1f4c8: 'trending-up', // 📈
  0x1f4ca: 'bar-chart',   // 📊
  0x1f4f1: 'smartphone',  // 📱
  0x1f48e: 'gem',         // 💎
  0x1f4c5: 'calendar',    // 📅
  0x1f5d1: 'trash',       // 🗑
  0x1f6f0: 'satellite',   // 🛰
  0x1f4c4: 'file',        // 📄
  0x1f6ab: 'ban',         // 🚫
  0x21bb: 'refresh',      // ↻
  0x25b6: 'play',         // ▶（连同 FE0F）
  0xff0b: 'plus',         // ＋
  0x2699: 'settings',     // ⚙
  0x1f503: 'refresh',     // 🔃
  0x1f504: 'refresh',     // 🔄
  0x1f4be: 'save',        // 💾
  0x2709: 'mail',         // ✉
  0x1f30d: 'globe',       // 🌍
  0x1f441: 'eye',         // 👁
  0x1f517: 'link',        // 🔗
  0x1f551: 'clock',       // 🕑
  0x1f4e6: 'package',     // 📦
  0x1f514: 'bell',        // 🔔
  0x1f4c1: 'folder',      // 📁
  0x1f680: 'rocket',      // 🚀
  0x1f519: 'arrow-left',  // 🔙
  0x1f4dd: 'pencil',      // 📝
  0x271a: 'plus',         // ✚
};

const files = ['checkin.html', 'index.html', 'notify.html', 'release.html', 'subscription.html', 'files.html', 'android.html'];
for (const f of files) {
  const p = join(dir, f);
  let c = readFileSync(p, 'utf8');
  const before = c;
  // 1) 字面字符（含跟随的变体选择符 FE0F）
  for (const [cp, name] of Object.entries(MAP)) {
    const ch = String.fromCodePoint(+cp);
    c = c.split(ch + '\uFE0F').join(SVG(name));
    c = c.split(ch).join(SVG(name));
  }
  // 2) HTML 实体（十进/十六进制）
  c = c.replace(/&#(\d+);|&#x([0-9a-fA-F]+);/g, (m, d, h) => {
    const code = d ? +d : parseInt(h, 16);
    return MAP[code] ? SVG(MAP[code]) : m;
  });
  if (c !== before) {
    writeFileSync(p, c, 'utf8');
    console.log(`✔ ${f} 已替换`);
  } else console.log(`- ${f} 无匹配`);
}
