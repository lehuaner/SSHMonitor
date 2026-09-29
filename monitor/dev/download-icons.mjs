// 下载签到平台真实 favicon → monitor/frontend/ico/<id>.<ext>
// 策略：官网 HTML 解析 <link rel="icon|apple-touch-icon"> → /favicon.ico → Google s2 兜底
// 用法: node monitor/dev/download-icons.mjs
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'ico');
mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const PLATFORMS = [
  { id: 'trae',      site: 'https://www.trae.cn' },
  { id: 'workbuddy', site: 'https://www.workbuddy.cn' },
  { id: 'codearts',  site: 'https://codearts.huaweicloud.com' },
  { id: 'officeace', site: 'https://www.huaweicloud.com' },   // OfficeAce：华为云 AgentArts 办公助手
  { id: 'autoclaw',  site: 'https://autoglm.zhipuai.cn' },    // AutoClaw：智谱 AutoGLM 系
];

async function get(url, opts = {}) {
  const r = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout || 15000),
    headers: { 'user-agent': UA, accept: '*/*', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}

// 魔数 → 扩展名
function extOf(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
  if (buf.slice(0, 4).toString() === 'RIFF') return 'webp';
  if (buf.slice(0, 5).toString() === '<?xml' || buf.slice(0, 4).toString() === '<svg') return 'svg';
  return null;
}

async function trySave(path, label) {
  const r = await get(path);
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = extOf(buf);
  if (!ext || buf.length < 100) throw new Error(`非图像(${ext}) 或过小(${buf.length}B)`);
  return { buf, ext, src: label };
}

for (const p of PLATFORMS) {
  const candidates = [];
  // 1. 解析官网 HTML 的 icon link（取最大尺寸优先）
  try {
    const html = await (await get(p.site, { timeout: 12000 })).text();
    const links = [...html.matchAll(/<link[^>]+rel="[^"]*(?:icon|shortcut icon)[^"]*"[^>]*>/gi)]
      .concat([...html.matchAll(/<link[^>]+apple-touch-icon[^>]*>/gi)]);
    for (const m of links) {
      const href = /href="([^"]+)"/.exec(m[0])?.[1];
      if (!href) continue;
      candidates.push(new URL(href, p.site).href);
    }
  } catch (e) { console.log(`  [${p.id}] HTML 解析失败: ${e.message}`); }
  // 2. 常规 favicon.ico
  try { candidates.unshift(new URL('/favicon.ico', p.site).href); } catch {}
  // 3. Google s2 兜底
  const host = (() => { try { return new URL(p.site).hostname; } catch { return ''; } })();
  if (host) candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=128`);

  let saved = null;
  for (const c of candidates) {
    try { saved = await trySave(c, c); break; } catch (e) { console.log(`  [${p.id}] 跳过 ${c.slice(0, 80)}: ${e.message}`); }
  }
  if (!saved) { console.log(`✗ ${p.id} 全部来源失败`); continue; }
  const file = join(OUT, `${p.id}.${saved.ext}`);
  writeFileSync(file, saved.buf);
  console.log(`✔ ${p.id} → ico/${p.id}.${saved.ext} (${saved.buf.length}B) 来源: ${saved.src.slice(0, 90)}`);
}
console.log('DONE');
