// 手机端 mock 数据抓取器：批量调本机 gateway(:3081) 的 GET 接口，
// 递归脱敏（token/cookie/password/secret/key/url 凭证类字段）后写 ~/mock_out/<key>.json。
// 用法: node get-mock.mjs   （输出 tar: mock_out.tar.gz）
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const OUT = '/data/data/com.termux/files/home/mock_out';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// pathname → mock 文件名键（与 dev/mock-server.mjs 的 keyOf 一致：去头/、/→_、去 .json）
const ROUTES = [
  '/api',
  '/api/checkin/providers',
  '/api/checkin/tasks',
  '/api/checkin/stats',
  '/api/checkin/auto-check',
  '/api/release/status',
  '/api/release/audit',
  '/api/release/upstream',
  '/api/release/tasks',
  '/api/release/version-status',
  '/api/notify',
  '/api/node-status',
  '/api/subscriptions',
  '/api/proxy-check/status',
  '/api/proxy-check/weights',
  '/api/proxy-check-logs',
  '/api/daily-report/preview',
  '/api/marked-procs',
  '/api/service-rules',
  '/api/dns-config',
  '/api/notes',
  '/api/list-dir',        // 带 query ?path= 抓取，存为通用键
  '/api/android/status',
  '/api/android/processes',
  '/api/android/apps',
];
const QUERIED = {
  '/api/list-dir': '?path=%2Fdata%2Fdata%2Fcom.termux%2Ffiles%2Fhome',
};

// 凭证脱敏：命中键名的字符串值替换；订阅/代理 url 整体打码
const SENSITIVE = /(token|password|passwd|cookie|secret|apikey|api_key|accesskey|refresh|dpop|securitytoken|authorization|fingerprint|privatekey)/i;
function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (SENSITIVE.test(k) && typeof val === 'string' && val) o[k] = 'mock-' + k.toLowerCase();
      else if ((k === 'url' || k === 'link' || k === 'uri') && typeof val === 'string' && /^https?:/.test(val)) o[k] = val.replace(/[?#].*$/, '?mock=query');
      else o[k] = scrub(val);
    }
    return o;
  }
  return v;
}

let ok = 0, fail = 0;
for (const r of ROUTES) {
  const url = 'http://127.0.0.1:3081' + r + (QUERIED[r] || '');
  const key = (r.replace(/^\//, '').replace(/\//g, '_') || 'api') + '.json';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { __nonjson: true, sample: text.slice(0, 200) }; }
    writeFileSync(`${OUT}/${key}`, JSON.stringify(scrub(data), null, 1), 'utf8');
    ok++;
    console.log(`OK  ${r} → ${key} (${text.length}B)`);
  } catch (e) {
    fail++;
    console.log(`ERR ${r}: ${e.message}`);
  }
}
// 签到日志：取一个真实任务 id 拉 30 天日志
try {
  const tasks = JSON.parse(await (await fetch('http://127.0.0.1:3081/api/checkin/tasks')).text());
  const t0 = tasks.tasks && tasks.tasks[0];
  if (t0) {
    const logs = await (await fetch(`http://127.0.0.1:3081/api/checkin/logs?taskId=${t0.id}`)).json();
    writeFileSync(`${OUT}/api_checkin_logs.json`, JSON.stringify(scrub(logs), null, 1), 'utf8');
    console.log(`OK  /api/checkin/logs (taskId=${t0.id}) ${logs.logs ? logs.logs.length : 0} 条`);
    ok++;
  }
} catch (e) { fail++; console.log('ERR logs: ' + e.message); }

execSync(`cd ${OUT} && tar czf ../mock_out.tar.gz .`);
console.log(`DONE ok=${ok} fail=${fail} → /data/data/com.termux/files/home/mock_out.tar.gz`);
