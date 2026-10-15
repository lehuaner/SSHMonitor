#!/usr/bin/env node
/**
 * tools/cf-honor10-gw.mjs —— honor10 后端 API 网关（Cloudflare Worker）部署脚本
 *
 * 目标：在 api.lehuan.vip/honor10/* 上暴露一个「非浏览器」后端入口，供其它端（机器/移动端/桌面）
 *       用一把 Bearer 凭证访问后端全部接口（含高危，按用户口径）。浏览器面板维持 honor10(Pages+Access) 不变。
 *
 * 链路：client → https://api.lehuan.vip/honor10/<path>  → [本 Worker] 校验 Bearer → 剥前缀
 *        → fetch https://t.honor10.lehuan.vip/<path> → Cloudflare Tunnel → 127.0.0.1:3081 后端
 *
 * 设计要点：
 *   - 只处理带 /honor10 前缀的路径；剥掉前缀后原样透传（method/body/query/流式）。
 *   - 鉴权：必须携带 `Authorization: Bearer <GW_TOKEN>`，与 Worker secret `GW_TOKEN` 比对；不符直接 401，不回源。
 *   - GW_TOKEN 只在设备本地生成、写入 ~/.monitor_data/machine_access.json（600），并以 secret_text binding 注入 Worker；
 *     绝不写进仓库、绝不打印明文。
 *   - 纯 Node fetch，零依赖，跨 Windows/Linux/Termux。
 *
 * 权限：API Token 需 Workers Scripts:Edit + Zone:Workers Routes:Edit（本项目创建的 Full 令牌即可）。
 *
 * 用法：
 *   $env:CF_API_TOKEN="xxxx"                    # PowerShell
 *   node tools/cf-honor10-gw.mjs                 # 生成/复用 gw_token + 部署 Worker + 挂 route
 *   node tools/cf-honor10-gw.mjs --check         # 只读：核对 token 是否就位、worker/route 是否存在
 *
 * 可选环境变量：CF_ACCOUNT_ID / CF_ZONE_ID / GW_WORKER_NAME / GW_ROUTE / GW_BACKEND / MONITOR_DATA_JSON
 */

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4';

const CFG = {
  account: process.env.CF_ACCOUNT_ID || '2374927b5eab88cecbdcdb3c837b6aa2',
  zone: process.env.CF_ZONE_ID || '392b994235b3ffb2fdb55f39661c59e1',
  workerName: process.env.GW_WORKER_NAME || 'honor10-gw',
  routePattern: process.env.GW_ROUTE || 'api.lehuan.vip/honor10/*',
  backend: process.env.GW_BACKEND || 'https://t.honor10.lehuan.vip',
  prefix: '/honor10',
  credFile: process.env.MONITOR_DATA_JSON || (os.homedir() + '/.monitor_data/machine_access.json'),
};

const ARGS = process.argv.slice(2);
const CHECK_ONLY = ARGS.includes('--check');
const TOKEN = process.env.CF_API_TOKEN || '';

if (!CHECK_ONLY && !TOKEN) {
  console.error('缺少 CF_API_TOKEN（需 Workers Scripts:Edit + Zone Workers Routes:Edit）。');
  process.exit(2);
}

async function cf(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body || raw ? { authorization: `Bearer ${TOKEN}`, ...(!raw ? { 'content-type': 'application/json' } : {}) } : { authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok || (json && json.success === false)) {
    const err = json && json.errors && json.errors.length ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new Error(`${method} ${path} 失败：${err}`);
  }
  return json ? json.result : null;
}

/** 读/生成共享密钥 gw_token（只落设备文件，600；绝不打印） */
function ensureGwToken() {
  let cred = {};
  try { cred = JSON.parse(fs.readFileSync(CFG.credFile, 'utf8')); } catch { /* 首次/损坏 */ }
  if (cred.gw_token) return { cred, created: false };
  cred.gw_token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(CFG.credFile, JSON.stringify(cred, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CFG.credFile, 0o600); } catch { /* windows noop */ }
  return { cred, created: true };
}

/** Worker 源码（模块）。env.GW_TOKEN 由 secret_text binding 注入。 */
function workerSource() {
  const BACKEND = JSON.stringify(CFG.backend);
  const PREFIX = JSON.stringify(CFG.prefix);
  const PLEN = CFG.prefix.length;
  return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.startsWith(${PREFIX})) path = path.slice(${PLEN});
    if (path === '') path = '/';
    const auth = request.headers.get('authorization') || '';
    if (auth !== ('Bearer ' + env.GW_TOKEN)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    const target = ${BACKEND} + path + url.search;
    const h = new Headers(request.headers);
    h.delete('host'); h.delete('cf-connecting-ip'); h.delete('cf-ray');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const resp = await fetch(target, {
      method: request.method,
      headers: h,
      body: hasBody ? request.body : undefined,
      duplex: 'half',
      cf: { cacheTtl: 0 },
    });
    const oh = new Headers(resp.headers);
    oh.delete('content-encoding'); oh.delete('content-length'); oh.delete('transfer-encoding');
    return new Response(resp.body, { status: resp.status, headers: oh });
  }
};`;
}

async function deployWorker(gwToken) {
  const meta = {
    main_module: 'index.js',
    compatibility_date: '2024-12-01',
    bindings: [{ name: 'GW_TOKEN', type: 'secret_text', text: gwToken }],
  };
  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  fd.append('index.js', new Blob([workerSource()], { type: 'application/javascript+module' }), 'index.js');
  const res = await fetch(`${API}/accounts/${CFG.account}/workers/scripts/${CFG.workerName}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: fd,
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (!json.success) throw new Error('部署 Worker 失败：' + JSON.stringify(json.errors));
  return json.result;
}

async function ensureRoute() {
  const list = await cf(`/zones/${CFG.zone}/workers/routes`);
  const arr = Array.isArray(list) ? list : [];
  const found = arr.find((r) => r.pattern === CFG.routePattern);
  if (found && found.script === CFG.workerName) { console.log(`  • route ${CFG.routePattern} 已存在且指向 ${CFG.workerName}（跳过）`); return found; }
  if (found) { await cf(`/zones/${CFG.zone}/workers/routes/${found.id}`, { method: 'DELETE' }); }
  const created = await cf(`/zones/${CFG.zone}/workers/routes`, { method: 'POST', body: { pattern: CFG.routePattern, script: CFG.workerName } });
  console.log(`  ✓ 已挂 route ${CFG.routePattern} -> ${CFG.workerName}`);
  return created;
}

async function check() {
  console.log(`== honor10-gw 校验（只读）==`);
  let cred = {};
  try { cred = JSON.parse(fs.readFileSync(CFG.credFile, 'utf8')); } catch { }
  console.log(cred.gw_token ? '  ✓ gw_token 就位（设备文件，未打印）' : '  ⚠ 设备文件无 gw_token（运行部署时会生成）');
  const w = await cf(`/accounts/${CFG.account}/workers/scripts/${CFG.workerName}`).catch(() => null);
  console.log(w ? `  ✓ Worker ${CFG.workerName} 已部署（${w.created_on ? w.created_on : ''}）` : `  ⚠ Worker ${CFG.workerName} 不存在`);
  const routes = await cf(`/zones/${CFG.zone}/workers/routes`).catch(() => []);
  const r = (routes || []).find((x) => x.pattern === CFG.routePattern);
  console.log(r ? `  ✓ route ${CFG.routePattern} -> ${r.script}` : `  ⚠ route ${CFG.routePattern} 未挂`);
}

async function main() {
  if (CHECK_ONLY) { await check(); return; }
  console.log(`== honor10-gw 部署 ==`);
  console.log(`worker=${CFG.workerName}  route=${CFG.routePattern}  backend=${CFG.backend}  prefix=${CFG.prefix}`);
  console.log('');
  console.log('[1] 共享密钥');
  const { cred, created } = ensureGwToken();
  console.log(created
    ? `  ✓ 已生成新 gw_token 并写入 ${CFG.credFile}（600，未打印；用其它端时从该文件读 gw_token）`
    : `  • 复用 ${CFG.credFile} 中的既有 gw_token`);
  console.log('[2] 部署 Worker');
  await deployWorker(cred.gw_token);
  console.log(`  ✓ 已部署 ${CFG.workerName}（GW_TOKEN 作为 secret_text binding）`);
  console.log('[3] 挂载路由');
  await ensureRoute();
  console.log('');
  console.log('完成。客户端：Authorization: Bearer <gw_token>，Base URL = https://' + CFG.routePattern.split('/')[0] + CFG.prefix + '/');
  console.log('冒烟： node tools/cf-honor10-gw.mjs --check ；再带/不带 Bearer 打 /healthz 验证 401/200。');
}

main().catch((e) => { console.error('✗ 出错：', e.message); process.exit(1); });
