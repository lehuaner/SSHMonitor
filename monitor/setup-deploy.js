#!/usr/bin/env node
/**
 * monitor/setup-deploy.js —— 首次运行 / 切换前端部署位置的命令行向导。
 *
 * 用法（设备上）：cd ~/monitor && node setup-deploy.js
 * 作用：选择前端部署位置（本机 :3080 / Cloudflare Pages），Pages 模式下可设 account_id / 项目名 / Pages:Write token。
 * 写入 ~/.monitor_data/frontend_deploy.json（chmod 600）。密钥只存设备本地文件。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { question } from 'node:readline/promises';
import os from 'node:os';

const HOME = process.env.MONITOR_HOME || os.homedir();
const DIR = join(HOME, '.monitor_data');
const FILE = join(DIR, 'frontend_deploy.json');
const out = (s) => process.stdout.write(s + '\n');
const mask = (t) => !t ? '(未设置)' : (t.length <= 6 ? '***' : t.slice(0, 4) + '…' + t.slice(-4));

let cfg = { mode: 'local', cf_account_id: '', cf_api_token: '', pages_project_name: 'honor10-monitor', production_branch: 'production' };
try { cfg = { ...cfg, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { /* 首次 */ }

out('=== 前端部署设置 (honor10-monitor) ===');
out(`当前：mode=${cfg.mode}  项目=${cfg.pages_project_name}  account=${cfg.cf_account_id || '(空)'}  token=${mask(cfg.cf_api_token)}`);
out('');
const sel = (await question('[1] 本机（设备 :3080 服务前端）   [2] Cloudflare Pages（设备端直传发布）\n选择部署方式 (1/2): ')).trim();
if (sel === '2' || /pages/i.test(sel)) {
  cfg.mode = 'pages';
  const acct = (await question(`account_id [回车保留 ${cfg.cf_account_id || '(空)'}]: `)).trim();
  if (acct) cfg.cf_account_id = acct;
  const proj = (await question(`Pages 项目名 [回车保留 ${cfg.pages_project_name}]: `)).trim();
  if (proj) cfg.pages_project_name = proj;
  const br = (await question(`production 分支 [回车保留 ${cfg.production_branch}]: `)).trim();
  if (br) cfg.production_branch = br;
  const tok = (await question(`CF Pages API Token（Pages:Edit 权限；回车保留 ${mask(cfg.cf_api_token)}，输入 * 清除）: `)).trim();
  if (tok === '*') cfg.cf_api_token = '';
  else if (tok) cfg.cf_api_token = tok;
} else {
  cfg.mode = 'local';
}

cfg.updated_at = new Date().toISOString();
mkdirSync(DIR, { recursive: true });
writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
out('');
out(`已保存 ${FILE}（600）→ mode=${cfg.mode}`);
if (cfg.mode === 'pages' && (!cfg.cf_api_token || !cfg.cf_account_id)) {
  out('⚠ Pages 模式但 token 或 account_id 为空：apply 时 Pages 发布将失败并告警，请重新运行本向导补全。');
}
process.exit(0);
