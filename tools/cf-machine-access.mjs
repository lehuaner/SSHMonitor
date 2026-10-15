#!/usr/bin/env node
/**
 * tools/cf-machine-access.mjs —— honor10 机器访问通道：可复现的 Cloudflare Access 配置脚本
 *
 * 用途：在「新机 / 迁移 / 误删」后，一键把机器（非浏览器）访问通道重建到目标状态，
 *       与浏览器邮箱 OTP 并存、互不影响。纯 Node fetch，零依赖，跨 Windows/Linux/Termux。
 *
 * 它会（全部幂等：已存在则跳过/复用，不重复创建）：
 *   1) 确保存在服务令牌 Service Token（默认名 honor10-machine，无期限）
 *   2) 确保 Access 应用（按域名匹配，默认 honor10.lehuan.vip）存在；不存在可创建
 *   3) 确保应用上有一条 Service Auth「Allow」策略，包含该服务令牌
 *   4) 确保应用的「公共主机名目标」含隧道域名（默认 t.honor10.lehuan.vip）——封旁路
 *   5) 确保 Pages 项目 production 环境变量含 CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
 *      （供 monitor/frontend/_worker.js 回源时携带，过隧道域名的 Access）
 *
 * 安全：密钥只在「新建服务令牌」那一刻由 Cloudflare 返回一次并打印；此后本脚本不再持有明文，
 *       需要从设备 ~/.monitor_data/machine_access.json 读取（或经环境变量传入）。绝不写进仓库。
 *
 * 权限：API Token 需具备 ——  Access:Service Tokens:Edit、Access:Policies:Edit、
 *       Access:Applications:Edit、Zone:Read、（可选）Cloudflare Pages:Edit。
 *
 * 用法：
 *   $env:CF_API_TOKEN="xxxx"      # Windows PowerShell
 *   node tools/cf-machine-access.mjs                 # 只读校验 + 需要时才创建（dry 之外）
 *   node tools/cf-machine-access.mjs --check          # 只检查现状，不做任何写操作
 *   node tools/cf-machine-access.mjs --create-pages-env  # 同时写 Pages 环境变量（需提供 secret）
 *
 * 可选环境变量（或改下方常量）：
 *   CF_ACCOUNT_ID  默认 2374927b5eab88cecbdcdb3c837b6aa2
 *   APP_DOMAIN     默认 honor10.lehuan.vip
 *   TUNNEL_DOMAIN  默认 t.honor10.lehuan.vip
 *   TOKEN_NAME     默认 honor10-machine
 *   POLICY_NAME    默认 machine-service-token
 *   PAGES_PROJECT  默认 honor10-monitor
 *   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET  仅 --create-pages-env 时需要（用于写 Pages env）
 */

const API = 'https://api.cloudflare.com/client/v4';

const CFG = {
  account: process.env.CF_ACCOUNT_ID || '2374927b5eab88cecbdcdb3c837b6aa2',
  appDomain: process.env.APP_DOMAIN || 'honor10.lehuan.vip',
  tunnelDomain: process.env.TUNNEL_DOMAIN || 't.honor10.lehuan.vip',
  tokenName: process.env.TOKEN_NAME || 'honor10-machine',
  policyName: process.env.POLICY_NAME || 'machine-service-token',
  pagesProject: process.env.PAGES_PROJECT || 'honor10-monitor',
};

const ARGS = process.argv.slice(2);
const CHECK_ONLY = ARGS.includes('--check');
const CREATE_PAGES_ENV = ARGS.includes('--create-pages-env');

const token = process.env.CF_API_TOKEN || '';
if (!token) {
  console.error('缺少 CF_API_TOKEN（需 Access:Edit + Zone:Read；--create-pages-env 还需 Pages:Edit）。');
  process.exit(2);
}

async function cf(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
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

const ok = (m) => console.log(`  ✓ ${m}`);
const skip = (m) => console.log(`  • ${m}（已存在，跳过）`);
const warn = (m) => console.log(`  ⚠ ${m}`);

/** 1) 服务令牌：找到就复用 id；--check 或未建则报告；否则创建（仅一次返回 secret） */
async function ensureServiceToken() {
  const list = await cf(`/accounts/${CFG.account}/access/service_tokens`);
  const arr = Array.isArray(list) ? list : (list && list.result) || [];
  const found = arr.find((t) => t.name === CFG.tokenName);
  if (found) { skip(`服务令牌 ${CFG.tokenName}（id=${found.id}，client_id=${found.client_id}）`); return found; }
  if (CHECK_ONLY) { warn(`服务令牌 ${CFG.tokenName} 不存在（--check 模式不创建）`); return null; }
  const created = await cf(`/accounts/${CFG.account}/access/service_tokens`, {
    method: 'POST', body: { name: CFG.tokenName, duration: 'never' },
  });
  ok(`已创建服务令牌 ${CFG.tokenName}`);
  console.log('    ── 下面两行是【一次性密钥】，请立即存入设备 ~/.monitor_data/machine_access.json，切勿入库 ──');
  console.log(`    CF-Access-Client-Id:     ${created.client_id}`);
  console.log(`    CF-Access-Client-Secret: ${created.client_secret}`);
  return created;
}

/** 2) Access 应用：按 domain 匹配 */
async function findApp() {
  const apps = await cf(`/accounts/${CFG.account}/access/apps`);
  const arr = Array.isArray(apps) ? apps : (apps && apps.result) || [];
  return arr.find((a) => (a.domain || (a.aud_session ? '' : '')) === CFG.appDomain
    || (Array.isArray(a.domains) && a.domains.includes(CFG.appDomain))) || null;
}

/** 3) Service Auth 策略：应用上是否已有含该 token 的 allow 策略 */
async function ensurePolicy(app, tokenId) {
  const pols = await cf(`/accounts/${CFG.account}/access/apps/${app.id}/policies`);
  const arr = Array.isArray(pols) ? pols : (pols && pols.result) || [];
  const has = arr.find((p) => p.name === CFG.policyName);
  if (has) { skip(`策略 ${CFG.policyName}（id=${has.id}）`); return has; }
  if (CHECK_ONLY) { warn(`策略 ${CFG.policyName} 不存在（--check 模式不创建）`); return null; }
  const created = await cf(`/accounts/${CFG.account}/access/apps/${app.id}/policies`, {
    method: 'POST',
    body: {
      name: CFG.policyName,
      decision: 'allow',
      action: 'allow',
      include: [{ service_token: { token_id: tokenId } }],
      exclude: [],
      require: [],
    },
  });
  ok(`已在应用 ${CFG.appDomain} 上新增 Allow 策略 ${CFG.policyName}（包含服务令牌 ${CFG.tokenName}）`);
  return created;
}

/** 4) 把隧道域名加进应用「公共主机名目标」（封旁路；需配合 _worker.js 带 token 才不断链） */
async function ensureTunnelDomain(app) {
  const full = await cf(`/accounts/${CFG.account}/access/apps/${app.id}`);
  const domains = new Set(
    Array.isArray(full.domains) && full.domains.length ? full.domains : [full.domain].filter(Boolean)
  );
  if (domains.has(CFG.tunnelDomain)) { skip(`目标域名已含 ${CFG.tunnelDomain}`); return; }
  if (CHECK_ONLY) { warn(`目标域名缺 ${CFG.tunnelDomain}（--check 模式不修改）`); return; }
  domains.add(CFG.tunnelDomain);
  const merged = { ...full, domains: [...domains] };
  delete merged.domain; // 用 domains 数组取代单值，避免 PUT 冲突
  ['id', 'uid', 'created_at', 'updated_at', 'policies'].forEach((k) => delete merged[k]);
  await cf(`/accounts/${CFG.account}/access/apps/${app.id}`, { method: 'PUT', body: merged });
  ok(`已把隧道域名 ${CFG.tunnelDomain} 纳入应用保护目标`);
  warn('  别忘了：monitor/frontend/_worker.js 已在回源时附带 CF-Access-Client-Id/Secret；且需在 Pages 设这两个环境变量（见步骤 5）。');
}

/** 5) Pages production 环境变量：CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET */
async function ensurePagesEnv() {
  if (!CREATE_PAGES_ENV) {
    warn('未指定 --create-pages-env：跳过 Pages 环境变量写入。若要让 _worker.js 过隧道 Access，请设置该项目的 CF_ACCESS_CLIENT_ID/SECRET 环境变量。');
    return;
  }
  const id = process.env.CF_ACCESS_CLIENT_ID, secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) { console.error('  --create-pages-env 需要环境变量 CF_ACCESS_CLIENT_ID 与 CF_ACCESS_CLIENT_SECRET。'); return; }
  if (CHECK_ONLY) { warn('--check 模式不写 Pages 环境变量'); return; }
  const body = {
    deployment_configs: {
      production: {
        env: {
          CF_ACCESS_CLIENT_ID: { type: 'plain_text', value: id },
          CF_ACCESS_CLIENT_SECRET: { type: 'secret_text', value: secret },
        },
      },
    },
  };
  await cf(`/accounts/${CFG.account}/pages/projects/${CFG.pagesProject}`, { method: 'PATCH', body });
  ok(`已写入 Pages 项目 ${CFG.pagesProject} production 环境变量（ID=plain_text，Secret=secret_text）`);
}

async function main() {
  console.log(`== honor10 机器访问通道（${CHECK_ONLY ? 'CHECK' : 'APPLY'}）==`);
  console.log(`account=${CFG.account}  app=${CFG.appDomain}  tunnel=${CFG.tunnelDomain}`);
  console.log('');

  console.log('[1] 服务令牌');
  const t = await ensureServiceToken();
  const tokenId = t && t.id;
  const clientId = t && t.client_id;

  console.log('[2] Access 应用');
  const app = await findApp();
  if (!app) {
    console.error(`  ✗ 未找到域名 ${CFG.appDomain} 的 Access 应用。请先在控制台创建自托管应用（本脚本不自动建 app，避免误配登录方式）。`);
    process.exit(1);
  }
  ok(`应用 ${CFG.appDomain}（id=${app.id}）`);

  if (tokenId) {
    console.log('[3] Service Auth 策略');
    await ensurePolicy(app, tokenId);
    console.log('[4] 隧道域名纳入目标');
    await ensureTunnelDomain(app);
  } else {
    warn('服务令牌不存在或未创建，跳过策略/域名步骤。');
  }

  console.log('[5] Pages 环境变量');
  await ensurePagesEnv();

  console.log('');
  console.log('完成。客户端调用样例见 tools/machine-access-client.mjs / README 片段。');
  if (clientId) console.log(`（client_id=${clientId}）`);
}

main().catch((e) => { console.error('✗ 出错：', e.message); process.exit(1); });
