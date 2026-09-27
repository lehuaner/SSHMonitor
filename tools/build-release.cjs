#!/usr/bin/env node
/**
 * tools/build-release.cjs —— 由 .github/workflows/release.yml 在 tag 触发时调用（也可本地跑）。
 *
 * 职责：按 monitor/release-manifest.json 收集「核心部署文件」并打包成设备端可自拉的产物：
 *   1) backend  = 各模块中 remotePath !== 'CF_PAGES' 的仓库文件（设备 apply 复制进 ~/monitor 运行）
 *      frontend = remotePath === 'CF_PAGES' 的仓库文件（设备端 apply 后置钩子直传 Cloudflare Pages）
 *   2) 存在性校验：manifest 声明的文件必须真实在仓库（防清单与实际漂移）
 *   3) 语法门禁：所有 backend .js + 前端 _worker.js 过 node --check
 *   4) 各自打 tar（tar 内保持 monitor/... 相对路径，设备解包到 releases/<tag>/files/ 后即为 files/monitor/...）
 *   5) 逐文件 sha256 → honor10-build.json（设备下载资产后据此校验完整性）
 *
 * 产物落在当前工作目录（repo 根）：honor10-backend.tar.gz / honor10-frontend.tar.gz / honor10-build.json / honor10-manifest.json
 * 本工具不是运行时代码，不进 release-manifest 的文件集，因此不会被部署到设备。
 */
'use strict';
const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');

const MANIFEST_PATH = 'monitor/release-manifest.json';
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fail = (msg) => { console.error('::error::' + msg); process.exit(1); };

const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// 归集去重
const backend = new Set();
const frontend = new Set();
for (const mod of Object.values(MANIFEST.modules || {})) {
  for (const [repoPath, remote] of Object.entries(mod.files || {})) {
    if (remote === 'CF_PAGES') frontend.add(repoPath);
    else backend.add(repoPath);
  }
}
const be = [...backend].sort();
const fe = [...frontend].sort();
if (!be.length) fail('backend 文件集为空（检查 manifest.modules.*.files）');

// 存在性
const miss = [...be, ...fe].filter((p) => !fs.existsSync(p));
if (miss.length) fail('manifest 指向的仓库文件缺失:\n' + miss.join('\n'));

// 语法门禁（backend 全部 .js + 前端 _worker.js）
const jsToCheck = be.filter((p) => p.endsWith('.js'));
if (fs.existsSync('monitor/frontend/_worker.js')) jsToCheck.push('monitor/frontend/_worker.js');
for (const p of jsToCheck) {
  try { cp.execFileSync('node', ['--check', p], { stdio: 'pipe' }); }
  catch (e) { fail(`node --check 失败 ${p}\n${(e.stderr && e.stderr.toString()) || e.message}`); }
}
console.log(`门禁通过：backend ${be.length} 文件（含 .js ${jsToCheck.length}）、frontend ${fe.length} 文件`);

// 打 tar（相对路径，tar 内保持 monitor/...）
fs.writeFileSync('be.list', be.join('\n') + '\n');
fs.writeFileSync('fe.list', fe.join('\n') + '\n');
try {
  cp.execFileSync('tar', ['czf', 'honor10-backend.tar.gz', '-T', 'be.list'], { stdio: 'inherit' });
  cp.execFileSync('tar', ['czf', 'honor10-frontend.tar.gz', '-T', 'fe.list'], { stdio: 'inherit' });
} finally {
  try { fs.unlinkSync('be.list'); fs.unlinkSync('fe.list'); } catch {}
}
fs.copyFileSync(MANIFEST_PATH, 'honor10-manifest.json');

// build.json：逐文件 sha256（设备据此校验解包内容完整性）
let commit = '';
try { commit = cp.execSync('git rev-parse HEAD').toString().trim(); } catch {}
const build = {
  tag: process.env.GITHUB_REF_NAME || (commit ? 'local' : 'local'),
  commit,
  generated_at: new Date().toISOString(),
  backend: { asset: 'honor10-backend.tar.gz', files: be.map((p) => ({ path: p, sha256: sha256(p) })) },
  frontend: { asset: 'honor10-frontend.tar.gz', files: fe.map((p) => ({ path: p, sha256: sha256(p) })) },
};
fs.writeFileSync('honor10-build.json', JSON.stringify(build, null, 2));
console.log(`wrote honor10-build.json (commit=${commit.slice(0, 7)}, backend=${build.backend.files.length}, frontend=${build.frontend.files.length})`);
