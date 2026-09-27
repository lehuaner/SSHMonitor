/**
 * lib/pages-deploy.js —— 设备端 Cloudflare Pages 直传客户端（方案 B，纯 fetch + blake3，不依赖 wrangler/workerd）。
 *
 * 复刻 wrangler@4 的 Pages Direct Upload 握手（源码 src/pages/upload.ts、deploy-helpers/hash.ts 实证）：
 *   1) hash = blake3( base64(fileBytes) + extWithoutDot ).hex[0:32]
 *   2) GET  /accounts/{acct}/pages/projects/{proj}/upload-token  → jwt（用 Pages:Write API token 鉴权）
 *   3) POST /pages/assets/check-missing  {hashes}                 → 需要上传的 hash（Bearer jwt）
 *   4) POST /pages/assets/upload         [{key,value(base64),metadata:{contentType},base64:true}]（Bearer jwt）
 *   5) manifest = { "/"+relPath: hash }
 *   6) POST /accounts/{acct}/pages/projects/{proj}/deployments    multipart：manifest + branch + commit_*
 *      + 特殊文件字段 _worker.js / _headers / _redirects / _routes.json（我们前端自带预编译 _worker.js）
 *   7) 轮询 GET /deployments/{id} 直到 ready/失败；失败可 POST /deployments/{id}/rollback 回滚上一版。
 *
 * 凭据来源：~/.monitor_data/frontend_deploy.json（cf_api_token / cf_account_id / pages_project_name /
 *   production_branch / mode）。密钥只存设备文件、绝不入仓库。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
import { blake3 } from '@noble/hashes/blake3';
import { installPublicDns } from './dnsfix.js';
installPublicDns(); // 独立调用时也保证公共 DNS（幂等）

const CF_API = 'https://api.cloudflare.com/client/v4';
const SPECIAL = new Set(['_worker.js', '_headers', '_redirects', '_routes.json', 'functions-filepath-routing-config.json']);

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};
const contentTypeFor = (name) => MIME[extname(name).toLowerCase()] || 'application/octet-stream';

/** 读部署配置；缺文件/缺字段一律回退到「本机模式、无凭据」，不抛 */
export function readPageDeployConfig(home) {
  const def = { mode: 'local', cf_api_token: '', cf_account_id: '', pages_project_name: 'honor10-monitor', production_branch: 'production' };
  try {
    const c = JSON.parse(readFileSync(join(home, '.monitor_data', 'frontend_deploy.json'), 'utf8'));
    return { ...def, ...c };
  } catch { return def; }
}

/** 计算单个文件的 Pages 哈希（blake3(base64(bytes)+ext).hex[0:32]） */
export function pagesHash(absPath) {
  const buf = readFileSync(absPath);
  const ext = extname(absPath).replace(/^\./, '');
  const input = buf.toString('base64') + ext;
  const digest = blake3(new TextEncoder().encode(input));
  return { hash: Buffer.from(digest).toString('hex').slice(0, 32), buf };
}

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) { walk(abs, base, out); continue; }
    if (st.isSymbolicLink()) continue;
    const rel = relative(base, abs).split(sep).join('/');
    out.push({ rel, abs, size: st.size });
  }
  return out;
}

async function cfFetch(path, cfg, { token, method = 'GET', body, headers = {}, raw = false, tries = 4 } = {}) {
  const h = { authorization: `Bearer ${token || cfg.cf_api_token}`, ...headers };
  let r, text, last;
  for (let i = 0; i < tries; i++) {
    try {
      r = await fetch(`${CF_API}${path}`, { method, headers: h, body, signal: AbortSignal.timeout(90000) });
      break;
    } catch (e) { last = e; if (i < tries - 1) await new Promise((res) => setTimeout(res, 800 * (2 ** i) + Math.floor(Math.random() * 400))); }
  }
  if (!r) throw new Error(`CF ${method} ${path.split('?')[0]} 网络失败：${last && last.message}`);
  text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok || (j && j.success === false)) {
    const err = j && j.errors && j.errors.length ? JSON.stringify(j.errors).slice(0, 300) : `HTTP ${r.status}`;
    throw new Error(`CF ${method} ${path.split('?')[0]} 失败：${err}`);
  }
  return raw ? text : j;
}

/**
 * 发布一个静态目录到 Cloudflare Pages（production 分支）。
 * @param {object} o { config, frontendDir, commitHash, commitMessage, log }
 * @returns {Promise<{ok:true, deploymentId:string, url:string}>}
 */
export async function publishPages({ config, frontendDir, commitHash = '', commitMessage = '', log = () => {} }) {
  const { cf_api_token, cf_account_id, pages_project_name } = config;
  if (!cf_api_token || !cf_account_id || !pages_project_name) throw new Error('Pages 配置缺少 cf_api_token/cf_account_id/pages_project_name');
  if (!existsSync(frontendDir)) throw new Error(`前端目录不存在：${frontendDir}`);

  const files = walk(frontendDir, frontendDir, []);
  const special = {};                       // _worker.js / _headers / _redirects / _routes.json
  const assets = [];
  for (const f of files) {
    if (SPECIAL.has(f.rel)) { special[f.rel] = readFileSync(f.abs); continue; }
    const { hash, buf } = pagesHash(f.abs);
    assets.push({ rel: f.rel, abs: f.abs, hash, buf, contentType: contentTypeFor(f.rel) });
  }

  // 1) upload-token → jwt
  const tokRes = await cfFetch(`/accounts/${cf_account_id}/pages/projects/${pages_project_name}/upload-token`, config, {});
  const jwt = tokRes.result && tokRes.result.jwt;
  if (!jwt) throw new Error('未取得 upload jwt');

  // 2) check-missing（失败不致命：当作全部需上传）
  let missing = assets.map((a) => a.hash);
  try {
    const cm = await cfFetch('/pages/assets/check-missing', config, {
      token: jwt, method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: missing }),
    });
    if (Array.isArray(cm.result)) missing = cm.result;
  } catch (e) { log(`check-missing 失败，按全量上传：${e.message}`); }

  // 3) upload（分批，单批 base64 总量 < 45MB；我们前端极小，基本一批）
  const need = assets.filter((a) => missing.includes(a.hash));
  const CHUNK = 48;
  for (let i = 0; i < need.length; i += CHUNK) {
    const batch = need.slice(i, i + CHUNK).map((a) => ({
      key: a.hash, value: a.buf.toString('base64'), metadata: { contentType: a.contentType }, base64: true,
    }));
    await cfFetch('/pages/assets/upload', config, {
      token: jwt, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch),
    });
    log(`已上传 ${Math.min(i + CHUNK, need.length)}/${need.length} 资源`);
  }

  // 4) manifest
  const manifest = {};
  for (const a of assets) manifest['/' + a.rel] = a.hash;

  // 5) 建 deployment（multipart，用 API token 而非 jwt）
  const fd = new FormData();
  fd.append('manifest', JSON.stringify(manifest));
  if (config.production_branch) fd.append('branch', config.production_branch);
  if (commitHash) fd.append('commit_hash', commitHash);
  if (commitMessage) fd.append('commit_message', String(commitMessage).slice(0, 200));
  fd.append('commit_dirty', 'true');
  for (const [name, bytes] of Object.entries(special)) fd.append(name, new Blob([bytes]), name);

  const dep = await cfFetch(`/accounts/${cf_account_id}/pages/projects/${pages_project_name}/deployments`, config, { method: 'POST', body: fd });
  const id = dep.result && dep.result.id;
  const url = dep.result && dep.result.url;
  if (!id) throw new Error('deployment 未返回 id');
  return { ok: true, deploymentId: id, url };
}

/** 轮询 deployment 至 ready / failed（Pages 直传通常很快）。就绪信号：latest_stage.name==='deploy' && status==='success'。超时返回 pending。 */
export async function waitPagesDeploy(config, deploymentId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const d = await cfFetch(`/accounts/${config.cf_account_id}/pages/projects/${config.pages_project_name}/deployments/${deploymentId}`, config, {});
      const r = d.result || {};
      const ls = r.latest_stage || {};
      const lsName = String(ls.name || '').toLowerCase();
      const lsStatus = String(ls.status || '').toLowerCase();
      const failedStage = (r.stages || []).find((s) => String(s.status || '').toLowerCase() === 'failed');
      if (lsName === 'deploy' && lsStatus === 'success') return { state: 'ready', url: r.url };
      if (failedStage || lsStatus === 'failed') return { state: 'failed', detail: JSON.stringify(failedStage || ls).slice(0, 200) };
    } catch { /* 轮询期间偶发错误继续 */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { state: 'pending' };
}

/** 回滚到指定 deployment（把其设为 current）。 */
export async function rollbackPages(config, deploymentId) {
  await cfFetch(`/accounts/${config.cf_account_id}/pages/projects/${config.pages_project_name}/deployments/${deploymentId}/rollback`, config, { method: 'POST' });
  return { ok: true };
}
