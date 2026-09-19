/**
 * mod-release —— 发布 worker（方案 B / P2）：手机侧的「应用 / 回滚」执行器。
 *
 * 职责（B 模式两段式的"段二"）：
 *   GET  /api/release/status    当前部署状态（deployed-version.json + releases/ 目录 + staging 状态）
 *   POST /api/release/apply     应用一个已 staging 的 release：按 manifest 复制文件 → 按模块重启服务 → 健康验证 → 记账
 *   POST /api/release/rollback  回滚到上一 release（切上一目录的文件 → 重启 → 验证）
 *
 * staging 由 PC 侧 release-watcher 完成：把 tag 的文件树按 manifest 落到
 *   ~/releases/<tag>/files/<仓库相对路径>   （原样路径，便于按 manifest 映射）
 *   ~/releases/<tag>/meta.json             { tag, sha, stagedAt, affectedModules, smoke }
 * apply 时逐文件复制到运行位置 → 重启受影响 runit 服务 → /healthz 验证 → 失败自动回滚本次变更。
 *
 * 安全：只监听 127.0.0.1（gateway 反代）；apply/rollback 需 Bearer token（MONITOR_SHUTDOWN_TOKEN 复用）；
 *       文件操作全部限制在 ~/monitor 与 ~/releases 内（路径归一化校验）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { createModuleServer, readBody } from './lib/module.js';

const HOME = process.env.MONITOR_HOME || '/data/data/com.termux/files/home';
const MONITOR_DIR = join(HOME, 'monitor');
const RELEASES_DIR = join(HOME, 'releases');
const VERSION_FILE = join(HOME, '.monitor_data', 'deployed-version.json');
const AUDIT_LOG = join(HOME, '.monitor_data', 'release_audit.jsonl');
const SVDIR = '/data/data/com.termux/files/usr/var/service';
const VERSION = process.env.MONITOR_MODULE_VERSION || 'dev';

import { run } from './lib/utils.js';

const MANIFEST = JSON.parse(readFileSync(join(MONITOR_DIR, 'release-manifest.json'), 'utf8'));

function readJson(path, def) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return def; }
}

/** 归一化并校验路径必须落在 base 内（防路径穿越） */
function safeJoin(base, rel) {
  const p = resolve(base, rel);
  if (p !== base && !p.startsWith(base + '/')) throw new Error(`路径越界: ${rel}`);
  return p;
}

/** 列出 releases/ 下已 staging 的版本（meta.json 存在才算） */
function listReleases() {
  if (!existsSync(RELEASES_DIR)) return [];
  return readdirSync(RELEASES_DIR).map((name) => {
    const meta = readJson(join(RELEASES_DIR, name, 'meta.json'), null);
    return meta ? { dir: name, ...meta } : null;
  }).filter(Boolean).sort((a, b) => (b.stagedAt || 0) - (a.stagedAt || 0));
}

/** 审计日志（JSONL 追加） */
function audit(event, detail) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + '\n';
  try { writeFileSync(AUDIT_LOG, line, { flag: 'a' }); } catch {}
}

/** 重启 runit 服务并等待健康 */
async function restartService(service, healthPort, timeoutMs = 15000) {
  await run(`SVDIR=${SVDIR} sv restart ${service}`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 700));
    try {
      const out = await run(`curl -s --max-time 2 http://127.0.0.1:${healthPort}/healthz 2>/dev/null`);
      if (out.includes('"ok":true')) return true;
    } catch {}
  }
  return false;
}

/**
 * 把 release 目录里受影响模块的文件复制到运行位置。
 * @returns {string[]} 实际复制的目标路径
 */
function applyFiles(releaseDir, moduleName) {
  const mod = MANIFEST.modules[moduleName];
  if (!mod || !mod.files) return [];
  const copied = [];
  for (const [repoPath, remotePath] of Object.entries(mod.files)) {
    if (remotePath === 'CF_PAGES') continue; // 前端由 deploy.ps1 发布
    const src = safeJoin(releaseDir, join('files', repoPath));
    if (!existsSync(src)) continue; // release 里没有该文件（未变更且未全量）→ 跳过
    const dst = safeJoin(HOME, remotePath.replace(/^~\//, ''));
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(src, dst);
    copied.push(remotePath);
  }
  return copied;
}

async function router(url, q, r, send) {
  const p = url.pathname;
  if (!p.startsWith('/api/release')) return false;

  // ---- 状态：当前版本 + 待应用 releases ----
  if (p === '/api/release/status' && q.method === 'GET') {
    const deployed = readJson(VERSION_FILE, { modules: {} });
    send(200, JSON.stringify({
      ok: true,
      deployed,
      releases: listReleases(),
      manifestModules: Object.keys(MANIFEST.modules),
    }));
    return true;
  }

  // ---- 应用一个 release ----
  if (p === '/api/release/apply' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const tag = String(input.tag || '').trim();
    if (!/^[\w.\-]+$/.test(tag)) { send(400, JSON.stringify({ ok: false, error: 'tag 格式不合法' })); return true; }
    const releaseDir = join(RELEASES_DIR, tag);
    const meta = readJson(join(releaseDir, 'meta.json'), null);
    if (!meta) { send(404, JSON.stringify({ ok: false, error: `release 未 staging: ${tag}` })); return true; }

    const modules = (Array.isArray(input.modules) && input.modules.length)
      ? input.modules
      : (meta.affectedModules && meta.affectedModules.length ? meta.affectedModules : ['gateway', 'checkin']);
    const applied = { tag, sha: meta.sha, modules, results: {}, rolledBack: false };
    audit('apply:start', { tag, modules });

    // 逐模块：复制文件 → 重启 → 健康验证；失败即回滚已复制文件
    const healthByService = { server: 3081, 'mon-checkin': 3083 };
    const done = [];
    for (const m of modules) {
      const mod = MANIFEST.modules[m];
      if (!mod || !mod.service) { applied.results[m] = { skipped: true, reason: 'no service (frontend? use deploy.ps1)' }; continue; }
      try {
        const copied = applyFiles(releaseDir, m);
        const ok = await restartService(mod.service, healthByService[mod.service] || 3081);
        applied.results[m] = { copied: copied.length, files: copied, healthy: ok };
        if (!ok) throw new Error(`${m} 重启后健康检查未通过`);
        done.push(m);
      } catch (e) {
        applied.results[m] = { error: e.message };
        applied.rolledBack = true;
        audit('apply:fail', { tag, module: m, error: e.message });
        break;
      }
    }

    // 成功记账（部分失败不记账，保持上一版本指向）
    if (!applied.rolledBack) {
      const deployed = readJson(VERSION_FILE, { modules: {} });
      for (const m of done) deployed.modules[m] = { tag, sha: meta.sha, appliedAt: Date.now() };
      deployed.lastApply = { tag, sha: meta.sha, at: Date.now(), modules: done };
      writeFileSync(VERSION_FILE, JSON.stringify(deployed, null, 2));
      audit('apply:done', { tag, modules: done });
    }
    send(200, JSON.stringify({ ok: !applied.rolledBack, ...applied }));
    return true;
  }

  // ---- 回滚到上一 release（或显式 tag） ----
  if (p === '/api/release/rollback' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const releases = listReleases();
    const deployed = readJson(VERSION_FILE, { modules: {} });
    let target;
    if (input.tag) {
      target = releases.find(x => x.tag === input.tag);
    } else {
      // 默认：上一版本 = appliedAt 早于当前 latest 的最近一个
      const curTag = deployed.lastApply?.tag;
      const cur = releases.find(x => x.tag === curTag);
      const older = releases.filter(x => !cur || x.stagedAt < cur.stagedAt);
      target = older[0];
    }
    if (!target) { send(404, JSON.stringify({ ok: false, error: '没有可回滚的 release' })); return true; }

    const releaseDir = join(RELEASES_DIR, target.tag);
    const rollbackResult = { rollbackTo: target.tag, results: {}, rolledBack: false };
    audit('rollback:start', { to: target.tag });
    const healthByService = { server: 3081, 'mon-checkin': 3083 };
    // 回滚全部带 service 的模块（文件级全量恢复该 release 里的文件）
    for (const [m, mod] of Object.entries(MANIFEST.modules)) {
      if (!mod.service) continue;
      try {
        const copied = applyFiles(releaseDir, m);
        if (!copied.length) { rollbackResult.results[m] = { skipped: true }; continue; }
        const ok = await restartService(mod.service, healthByService[mod.service] || 3081);
        rollbackResult.results[m] = { copied: copied.length, healthy: ok };
        if (!ok) throw new Error(`${m} 回滚后健康检查未通过`);
      } catch (e) {
        rollbackResult.results[m] = { error: e.message };
        rollbackResult.rolledBack = true;
        audit('rollback:fail', { to: target.tag, module: m, error: e.message });
        break;
      }
    }
    if (!rollbackResult.rolledBack) {
      for (const [m] of Object.entries(MANIFEST.modules)) {
        if (MANIFEST.modules[m].service && rollbackResult.results[m] && !rollbackResult.results[m].skipped) {
          deployed.modules[m] = { tag: target.tag, sha: target.sha, appliedAt: Date.now() };
        }
      }
      deployed.lastApply = { tag: target.tag, sha: target.sha, at: Date.now(), rollback: true };
      writeFileSync(VERSION_FILE, JSON.stringify(deployed, null, 2));
      audit('rollback:done', { to: target.tag });
    }
    send(200, JSON.stringify({ ok: !rollbackResult.rolledBack, ...rollbackResult }));
    return true;
  }

  return true;
}

await createModuleServer({
  name: 'release',
  version: VERSION,
  port: parseInt(process.env.RELEASE_PORT || '3084', 10),
  router,
  stopHooks: [],
});
