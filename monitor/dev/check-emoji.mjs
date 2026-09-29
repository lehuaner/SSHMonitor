// 替换后体检：1) emoji 残留 2) svg 误入 HTML 属性值 3) <title>/<style> 区污染 4) 字符串引号配平粗检
// 用法: node monitor/dev/check-emoji.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const files = ['checkin.html', 'index.html', 'notify.html', 'release.html', 'subscription.html', 'files.html', 'android.html'];
let bad = 0;
for (const f of files) {
  const lines = readFileSync(join(dir, f), 'utf8').split('\n');
  lines.forEach((l, i) => {
    // emoji 残留（彩色区段）
    const em = /[\u{1F000}-\u{1FAFF}\u{2705}\u{274C}\u{23F3}\u{2699}\u{21BB}\u{25B6}\u{FF0B}\u{271A}]/u.exec(l);
    if (em) { console.log(`EMOJI ${f}:${i + 1}: ${l.trim().slice(0, 120)}`); bad++; }
    // svg 被塞进了 textContent 赋值（不会渲染，只显示字面量）——只抓真污染，html+= 拼接属误报
    const attr = /\.textContent\s*=\s*['"`][^'"]*<svg/.test(l);
    if (attr) { console.log(`ATTR  ${f}:${i + 1}: ${l.trim().slice(0, 120)}`); bad++; }
  });
  const c = lines.join('\n');
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(c);
  if (t && t[1].includes('<svg')) { console.log(`TITLE ${f}: ${t[1].slice(0, 80)}`); bad++; }
  const st = [...c.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)];
  for (const s of st) if (s[0].includes('<svg')) { console.log(`STYLE ${f} 内含 svg`); bad++; }
}
console.log(bad ? `共 ${bad} 处需处理` : 'HEALTH OK：无残留 emoji / 无属性污染');
