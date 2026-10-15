#!/usr/bin/env node
/**
 * tools/machine-access-client.mjs —— honor10 后端「机器/多端」访问客户端（脱离浏览器）
 *
 * 认证方式：一把共享 Bearer 凭证，打后端 API 网关 Worker。
 *   Base： https://api.lehuan.vip/honor10/     （二级域 + 路径前缀，Universal SSL 覆盖，外部可达）
 *   头：   Authorization: Bearer <gw_token>
 *   网关链路： client → api.lehuan.vip/honor10/<path> → [honor10-gw Worker: 校验Bearer+剥前缀]
 *             → t.honor10.lehuan.vip → Cloudflare Tunnel → 127.0.0.1:3081 后端
 *
 * 说明：旧的「Cloudflare Access Service Token + honor10(Pages)」方式已被实测证伪
 *       （Pages 自定义域名不认 service token，带全新令牌仍 service_token_status:false→302），故弃用。
 *       浏览器面板仍走 honor10.lehuan.vip（Pages + 邮箱 OTP），与本入口互不影响。
 *
 * 凭证来源（按优先级，绝不写死进仓库）：
 *   1) 环境变量 GW_TOKEN / GW_BASE
 *   2) 设备文件 ~/.monitor_data/machine_access.json 的 gw_token 字段（部署脚本 cf-honor10-gw.mjs 生成）
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  其它语言等价写法（都是「带 Authorization: Bearer 请求 BASE/...」）：
 *
 *  curl:
 *    curl -sS -H "Authorization: Bearer $GW_TOKEN" https://api.lehuan.vip/honor10/healthz
 *
 *  Python (requests):
 *    import os, requests
 *    H = {"Authorization": "Bearer " + os.environ["GW_TOKEN"]}
 *    r = requests.get("https://api.lehuan.vip/honor10/api/checkin/tasks", headers=H, timeout=20)
 *    print(r.json())
 *
 *  iOS URLSession / Android OkHttp：
 *    request.setValue("Bearer <gw_token>", forHTTPHeaderField: "Authorization")
 *    ⚠️ 若 App 分发给不可信用户，切勿把 gw_token 打进安装包；应由你自己的中转层注入，
 *       或改用“每客户端独立 key + scope”。自用可信环境才直接把 token 放安全存储。
 * ────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE = 'https://api.lehuan.vip/honor10';

function loadCreds() {
  let token = process.env.GW_TOKEN || '';
  let base = process.env.GW_BASE || '';
  if (!token) {
    const f = join(homedir(), '.monitor_data', 'machine_access.json');
    if (existsSync(f)) {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      token = c.gw_token || '';
    }
  }
  base = base || DEFAULT_BASE;
  if (!token) throw new Error('缺少 gw_token：设环境变量 GW_TOKEN 或写 ~/.monitor_data/machine_access.json');
  return { base, token };
}

/**
 * 调后端 API。path 以 / 开头（如 '/healthz'、'/api/checkin/tasks'），网关会剥掉 /honor10 前缀透传后端。
 * method/body 全量透传（含高危写接口，按自用可信环境口径）。
 */
export async function api(path, { method = 'GET', body, headers = {} } = {}, creds = loadCreds()) {
  const opts = {
    method,
    headers: {
      authorization: `Bearer ${creds.token}`,
      accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(30000),
  };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    opts.headers['content-type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const url = creds.base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (res.status === 401) throw new Error('网关鉴权失败(401)：gw_token 不对或缺失');
  return { status: res.status, ok: res.ok, json, text };
}

// ── CLI 冒烟：node tools/machine-access-client.mjs [路径] ────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = process.argv[2] || '/healthz';
  api(p).then((r) => {
    console.log(`GET ${p} -> ${r.status}`);
    console.log(r.text.slice(0, 400));
  }).catch((e) => { console.error('✗ ', e.message); process.exit(1); });
}
