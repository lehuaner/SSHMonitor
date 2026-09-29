// 收集前端各页面调用的 /api 与 /action 端点（mock 数据清单用）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
for (const f of readdirSync(dir)) {
  const p = join(dir, f);
  if (!statSync(p).isFile() || !/\.(html|js)$/.test(f)) continue;
  const c = readFileSync(p, 'utf8');
  const eps = new Set();
  for (const m of c.matchAll(/['"`](\/api\/[A-Za-z0-9_\/-]*)/g)) eps.add(m[1]);
  for (const m of c.matchAll(/['"`](\/action[^'"`?]*)/g)) eps.add(m[1]);
  if (!eps.size) continue;
  console.log('=== ' + f);
  [...eps].sort().forEach((e) => console.log('  ' + e));
}
