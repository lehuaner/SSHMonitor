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
  // ====== 异步任务模型（202）：apply/rollback 全部后台执行，响应立即返回任务 ID ======
  // 解决：apply 含 gateway 时响应被自身重启切断（假失败）；同时提供逐步进度与并发互斥。
const tasks = new Map();   // taskId -> { id, kind: 'apply'|'rollback', tag, modules, state, steps, error, createdAt, updatedAt }
const TASK_TTL_MS = 30 * 60 * 1000;
const FINISHED_KEEP = 20;

function newTask(kind, tag, modules) {
    const id = Math.random().toString(36).slice(2, 8);
    const t = { id, kind, tag: tag || null, modules, state: 'running', steps: [], error: null, createdAt: Date.now(), updatedAt: Date.now() };
    tasks.set(id, t);
    // 清理：只保留最近 FINISHED_KEEP 个已完成任务
    const finished = [...tasks.values()].filter(x => x.state !== 'running').sort((a, b) => b.updatedAt - a.updatedAt);
    for (const x of finished.slice(FINISHED_KEEP)) tasks.delete(x.id);
    for (const x of tasks.values()) if (x.state === 'running' && Date.now() - x.createdAt > TASK_TTL_MS) { x.state = 'failed'; x.error = 'task timeout (stale)'; }
    return t;
  }
function step(t, msg) { t.steps.push({ at: Date.now(), msg }); t.updatedAt = Date.now(); }

  const healthByService = { server: 3081, 'mon-checkin': 3083, 'mon-release': 3084 };

  /** 复制某模块文件并重启其服务 → 健康验证。返回 {copied, healthy}，失败抛错 */
  async function applyModule(t, releaseDir, moduleName) {
    const mod = MANIFEST.modules[moduleName];
    if (!mod || !mod.service) { return { skipped: true, reason: 'no service (frontend? use deploy.ps1)' }; }
    const copied = applyFiles(releaseDir, moduleName);
    step(t, `${moduleName}: 复制 ${copied.length} 文件 → 重启 ${mod.service}`);
    const ok = await restartService(mod.service, healthByService[mod.service] || 3081);
    if (!ok) throw new Error(`${moduleName} 重启后健康检查未通过`);
    step(t, `${moduleName}: healthy ✓`);
    return { copied: copied.length, files: copied, healthy: true };
  }

  /** 后台执行 apply（原同步逻辑迁移） */
  async function runApply(t) {
    console.log(`[release-task] runApply start ` + t.id);
    const tag = t.tag;
    const releaseDir = join(RELEASES_DIR, tag);
    const meta = readJson(join(releaseDir, 'meta.json'), null);
    if (!meta) { t.state = 'failed'; t.error = `release 未 staging: ${tag}`; return; }
    const results = {};
    const done = [];
    try {
      for (const m of t.modules) {
        const r = await applyModule(t, releaseDir, m);
        results[m] = r;
        if (!r.skipped) done.push(m);
      }
    } catch (e) {
      t.state = 'failed';
      t.error = e.message;
      step(t, `失败 → 自动回滚本次变更: ${e.message}`);
      audit('apply:fail', { tag, error: e.message });
      // 回滚本次已复制的文件：从当前 deployed 记录的上一 release 恢复
      try {
        const deployed = readJson(VERSION_FILE, { modules: {} });
        const prevTag = deployed.lastApply && deployed.lastApply.tag;
        const prevDir = prevTag && prevTag !== tag ? join(RELEASES_DIR, prevTag) : null;
        if (prevDir && existsSync(prevDir)) {
          for (const m of done) {
            if (MANIFEST.modules[m] && MANIFEST.modules[m].service) {
              await applyFiles(prevDir, m);
              await restartService(MANIFEST.modules[m].service, healthByService[MANIFEST.modules[m].service] || 3081);
              step(t, `回滚 ${m} → ${prevTag} ✓`);
            }
          }
        } else {
          step(t, '无上一 release 可回滚（保留当前失败状态，人工介入）');
        }
      } catch (e2) {
        step(t, `自动回滚也失败: ${e2.message}（需人工介入）`);
        audit('apply:rollback_fail', { tag, error: e2.message });
      }
      return;
    }
    // 成功记账
    const deployed = readJson(VERSION_FILE, { modules: {} });
    for (const m of done) deployed.modules[m] = { tag, sha: meta.sha, appliedAt: Date.now() };
    deployed.lastApply = { tag, sha: meta.sha, at: Date.now(), modules: done };
    writeFileSync(VERSION_FILE, JSON.stringify(deployed, null, 2));
    t.state = 'done';
    t.results = results;
    step(t, `全部完成：${done.join(', ')}`);
    audit('apply:done', { tag, modules: done });
  }

  /** 后台执行 rollback（原同步逻辑迁移） */
  async function runRollback(t) {
    const releases = listReleases();
    const deployed = readJson(VERSION_FILE, { modules: {} });
    let target;
    if (t.tag) {
      target = releases.find(x => x.tag === t.tag);
    } else {
      const curTag = deployed.lastApply && deployed.lastApply.tag;
      const cur = releases.find(x => x.tag === curTag);
      const older = releases.filter(x => !cur || x.stagedAt < cur.stagedAt);
      target = older[0];
    }
    if (!target) { t.state = 'failed'; t.error = '没有可回滚的 release'; return; }
    t.rollbackTo = target.tag;
    const releaseDir = join(RELEASES_DIR, target.tag);
    const results = {};
    const doneModules = [];
    try {
      for (const [m, mod] of Object.entries(MANIFEST.modules)) {
        if (!mod.service) continue;
        const copied = applyFiles(releaseDir, m);
        if (!copied.length) { results[m] = { skipped: true }; continue; }
        step(t, `${m}: 恢复 ${copied.length} 文件 → 重启 ${mod.service}`);
        const ok = await restartService(mod.service, healthByService[mod.service] || 3081);
        if (!ok) throw new Error(`${m} 回滚后健康检查未通过`);
        results[m] = { copied: copied.length, healthy: true };
        doneModules.push(m);
      }
    } catch (e) {
      t.state = 'failed';
      t.error = e.message;
      audit('rollback:fail', { to: target.tag, error: e.message });
      return;
    }
    for (const m of doneModules) {
      deployed.modules[m] = { tag: target.tag, sha: target.sha, appliedAt: Date.now() };
    }
    deployed.lastApply = { tag: target.tag, sha: target.sha, at: Date.now(), rollback: true };
    writeFileSync(VERSION_FILE, JSON.stringify(deployed, null, 2));
    t.state = 'done';
    t.results = results;
    step(t, `回滚完成 → ${target.tag}`);
    audit('rollback:done', { to: target.tag });
  }



function readJson(path, def) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return def; }
}

/** 归一化并校验路径必须落在 base 内（防路径穿越） */
function safeJoin(base, rel) {
  const p = resolve(base, rel);
  const normBase = resolve(base);
  // Windows 兼容：反斜杠分隔符也放行（手机端为 POSIX，此处仅冒烟环境）
  if (p !== normBase && !p.startsWith(normBase + '/') && !p.startsWith(normBase + '\\')) throw new Error(`路径越界: ${rel}`);
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

  // ---- 审计日志（最近 N 条，倒序） ----
  if (p === '/api/release/audit' && q.method === 'GET') {
    let events = [];
    try {
      const raw = readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean);
      events = raw.slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch {}
    send(200, JSON.stringify({ ok: true, events }));
    return true;
  }

  // ---- 任务查询 ----
  if (p === '/api/release/tasks' && q.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (id) {
      const t = tasks.get(id);
      if (!t) { send(404, JSON.stringify({ ok: false, error: '任务不存在' })); return true; }
      send(200, JSON.stringify({ ok: true, task: t }));
      return true;
    }
    send(200, JSON.stringify({ ok: true, tasks: [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20) }));
    return true;
  }

  // ---- 应用一个 release（202 异步） ----
  if (p === '/api/release/apply' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const tag = String(input.tag || '').trim();
    if (!/^[\w.\-]+$/.test(tag)) { send(400, JSON.stringify({ ok: false, error: 'tag 格式不合法' })); return true; }
    const releaseDir = join(RELEASES_DIR, tag);
    const meta = readJson(join(releaseDir, 'meta.json'), null);
    if (!meta) { send(404, JSON.stringify({ ok: false, error: `release 未 staging: ${tag}` })); return true; }
    // 并发互斥：同一时间只允许一个 running 任务
    const running = [...tasks.values()].find(x => x.state === 'running');
    if (running) { send(409, JSON.stringify({ ok: false, error: `已有任务进行中（${running.kind} ${running.tag || ''}），请稍候` })); return true; }
    const modules = (Array.isArray(input.modules) && input.modules.length)
      ? input.modules
      : (meta.affectedModules && meta.affectedModules.length ? meta.affectedModules : ['gateway', 'checkin']);
    const t = newTask('apply', tag, modules);
    audit('apply:start', { tag, modules, taskId: t.id });
    runApply(t).then(() => console.log('[release-task] runApply finished', t.id, t.state)).catch(e => { console.error('[release-task] runApply throw:', e.message); t.state = 'failed'; t.error = e.message; });
    send(202, JSON.stringify({ ok: true, taskId: t.id, statusUrl: `/api/release/tasks?id=${t.id}`, tag, modules }));
    return true;
  }

  // ---- 回滚（202 异步，同任务模型） ----
  if (p === '/api/release/rollback' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const running = [...tasks.values()].find(x => x.state === 'running');
    if (running) { send(409, JSON.stringify({ ok: false, error: `已有任务进行中（${running.kind} ${running.tag || ''}），请稍候` })); return true; }
    const t = newTask('rollback', String(input.tag || '').trim() || null, []);
    audit('rollback:start', { to: t.tag || '(auto)', taskId: t.id });
    runRollback(t).catch(e => { t.state = 'failed'; t.error = e.message; });
    send(202, JSON.stringify({ ok: true, taskId: t.id, statusUrl: `/api/release/tasks?id=${t.id}` }));
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
