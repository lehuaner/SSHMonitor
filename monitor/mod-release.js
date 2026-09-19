/**
 * mod-release —— 发布 worker（方案 B / P2）：手机侧的「应用 / 回滚」执行器。
 *
 * 职责（B 模式两段式的"段二"）：
 *   GET  /api/release/status    当前部署状态（deployed-version.json + releases/ 目录 + staging 状态）
 *   POST /api/release/apply     应用一个已 staging 的 release：按 manifest 复制文件 → 按模块重启服务 → 健康验证 → 记账
 *   POST /api/release/rollback  回滚到上一 release（切上一目录的文件 → 重启 → 验证）
 *
 * staging 有两种来源：
 *   （旧）PC 侧 release-watch.ps1：把 tag 的文件树按 manifest 落到
 *     ~/releases/<tag>/files/<仓库相对路径>  + meta.json；
 *   （方案A / 新）手机侧 stageFromGithub()：apply 时若无本地档案，直接按 manifest 从
 *     GitHub Contents API 拉取到同一目录结构（复用上游检测的只读 Contents PAT）。
 * 两种都落到同一布局，apply 按 manifest 逐文件复制到运行位置 → 重启受影响 runit 服务
 *   → /healthz 验证 → 失败自动回滚本次变更。
 *
 * 安全：只监听 127.0.0.1（gateway 反代）；apply/rollback 需 Bearer token（MONITOR_SHUTDOWN_TOKEN 复用）；
 *       文件操作全部限制在 ~/monitor 与 ~/releases 内（路径归一化校验）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, normalize, resolve } from 'node:path';
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

// ====== 上游版本检测（手机直连 GitHub API） ======
// 职责边界：Windows 侧只负责发布（commit/tag/push + staging 把文件推上来），
// 「有没有新版本」由手机端自己拉 tag 并缓存，前端展示。私有仓库需只读 PAT。
const UPSTREAM_CONFIG_FILE = join(HOME, '.monitor_data', 'release_config.json');
const UPSTREAM_CACHE_FILE = join(HOME, '.monitor_data', 'upstream-version.json');
const DEFAULT_UPSTREAM = {
  enabled: true,
  repo: 'lehuaner/SSHMonitor',
  token: '',                            // fine-grained PAT，权限 Contents: Read-only 即可
  tagPattern: '^v[0-9]+(\\.[0-9]+)*$',
  intervalMin: 30,
  listSize: 20,                         // 最多保留/比对最近 N 个 tag
};

function readUpstreamConfig() {
  const raw = readJson(UPSTREAM_CONFIG_FILE, {});
  return { ...DEFAULT_UPSTREAM, ...(raw.upstream || {}) };
}

/** 合并写入（只接受白名单键；token 传空或含 * 视为「不修改」） */
function writeUpstreamConfig(patch) {
  const cur = readUpstreamConfig();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULT_UPSTREAM)) {
    if (patch[k] === undefined) continue;
    if (k === 'token') {
      const v = String(patch[k] ?? '').trim();
      if (v && !v.includes('*')) next.token = v;   // 掩码值/空串 → 保留原 token
      else if (v === '' && patch.clearToken) next.token = '';
      continue;
    }
    if (k === 'enabled') next.enabled = !!patch[k];
    else if (k === 'intervalMin') next.intervalMin = Math.min(1440, Math.max(5, Number(patch[k]) || DEFAULT_UPSTREAM.intervalMin));
    else if (k === 'listSize') next.listSize = Math.min(100, Math.max(1, Number(patch[k]) || DEFAULT_UPSTREAM.listSize));
    else if (k === 'tagPattern') { try { new RegExp(String(patch[k])); next.tagPattern = String(patch[k]); } catch { /* 非法正则 → 保持原值 */ } }
    else next[k] = String(patch[k] ?? '').trim() || cur[k];
  }
  const raw = readJson(UPSTREAM_CONFIG_FILE, {});
  raw.upstream = next;
  mkdirSync(join(HOME, '.monitor_data'), { recursive: true });
  writeFileSync(UPSTREAM_CONFIG_FILE, JSON.stringify(raw, null, 2));
  return next;
}

function maskToken(tok) {
  const s = String(tok || '');
  if (!s) return '';
  return s.length <= 6 ? '***' : '•'.repeat(Math.min(24, s.length - 4)) + s.slice(-4);
}

/** v1.2.3 / 1.2.3 → [1,2,3]；解析不出给 [-1,-1,-1]（排到最后） */
function tagParts(t) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(t || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}
function cmpTag(a, b) {
  const A = tagParts(a), B = tagParts(b);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return String(a).localeCompare(String(b));
}

/** 基准版本 = 各模块已部署 tag 的最低值（任一模块落后就认为有更新） */
function baseTag(deployed) {
  const tags = Object.values((deployed && deployed.modules) || {}).map((m) => m && m.tag).filter(Boolean);
  if (!tags.length) return 'v0.0.0';
  return tags.sort(cmpTag)[0];
}

async function ghFetch(pathname, cfg) {
  const headers = {
    'user-agent': 'honor10-monitor',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const r = await fetch(`https://api.github.com${pathname}`, { headers, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON（如代理劫持页） */ }
  if (!r.ok) {
    let msg = data && (data.message || data.error) ? String(data.message || data.error) : `HTTP ${r.status}`;
    if (r.status === 404) msg = cfg.token ? '404：token 无该仓库读取权限，或 repo 名称不对' : '404：仓库不可匿名访问（私有仓库需在设置里填只读 token）';
    else if (r.status === 401) msg = '401：token 无效或已过期';
    else if (r.status === 403) msg = '403：触发 GitHub 速率限制（配 token 可解除）';
    else if (!data) msg += `（响应非 JSON，可能被代理/网络拦截：${text.slice(0, 60)}）`;
    throw new Error(`${pathname.split('?')[0]} → ${msg}`);
  }
  return data;
}

let upstreamPromise = null;
/** 拉取上游 tag → 写缓存 ~/.monitor_data/upstream-version.json（并发共享同一次检测，不能回退旧缓存） */
function checkUpstream() {
  if (!upstreamPromise) {
    upstreamPromise = doCheckUpstream().finally(() => { upstreamPromise = null; });
  }
  return upstreamPromise;
}

async function doCheckUpstream() {
  const cfg = readUpstreamConfig();
  const prev = readJson(UPSTREAM_CACHE_FILE, null);
  const out = { checkedAt: Date.now(), ok: false, error: null, repo: cfg.repo, tokenSet: !!cfg.token, tags: [], latest: null };
  try {
    const list = await ghFetch(`/repos/${cfg.repo}/tags?per_page=100`, cfg);
    let re;
    try { re = new RegExp(cfg.tagPattern); } catch { re = /^v\d+(\.\d+)*$/; }
    let tags = (Array.isArray(list) ? list : [])
      .filter((x) => x && x.name && re.test(x.name))
      .map((x) => ({ tag: x.name, sha: (x.commit && x.commit.sha) || '' }));
    tags.sort((a, b) => cmpTag(b.tag, a.tag));
    tags = tags.slice(0, cfg.listSize);
    // 提交说明只补最近 6 个，省请求；失败不影响检测结果
    for (const t of tags.slice(0, Math.min(6, tags.length))) {
      try {
        const c = await ghFetch(`/repos/${cfg.repo}/commits/${t.sha}`, cfg);
        t.subject = String((c && c.commit && c.commit.message) || '').split('\n')[0].slice(0, 200);
        t.date = (c && c.commit && c.commit.committer && c.commit.committer.date) || '';
      } catch { /* ignore */ }
    }
    out.tags = tags;
    out.latest = tags.length ? tags[0].tag : null;
    out.ok = tags.length > 0;
    if (!out.latest) out.error = `仓库 ${cfg.repo} 里没有匹配 ${cfg.tagPattern} 的 tag`;
  } catch (e) {
    out.error = e.message;
    // 失败时沿用上次结果供展示，但**仓库换了就不能继承**（否则会把别的仓库的 tag 当成上游最新）
    if (prev && prev.repo === cfg.repo) {
      out.tags = (prev && prev.tags) || [];
      out.latest = (prev && prev.latest) || null;
    }
  }
  const deployed = readJson(VERSION_FILE, { modules: {} });
  out.base = baseTag(deployed);
  out.behind = out.tags.filter((t) => cmpTag(t.tag, out.base) > 0).map((t) => t.tag);
  mkdirSync(join(HOME, '.monitor_data'), { recursive: true });
  writeFileSync(UPSTREAM_CACHE_FILE, JSON.stringify(out, null, 2));
  // 审计只在「发现新版本」时记一条，避免每 30 分钟刷屏
  if (out.ok && out.latest && (!prev || prev.latest !== out.latest)) audit('upstream:new-tag', { latest: out.latest, base: out.base, behind: out.behind.length });
  return out;
}

/** 缓存 + 本地状态（staged / applied）合成前端视图 */
function upstreamView() {
  const cfg = readUpstreamConfig();
  const cache = readJson(UPSTREAM_CACHE_FILE, null);
  const deployed = readJson(VERSION_FILE, { modules: {} });
  const modTags = (deployed && deployed.modules) || {};
  const stagedMap = new Map(listReleases().map((x) => [x.tag, x]));
  const base = baseTag(deployed);
  // 是否已应用：看该 release **真正影响的模块**（只统计有部署记录的模块，
  // frontend/CF_PAGES 不参与）。否则像“只发 release 模块”的版本会永远被当成可应用。
  const isApplied = (tag, stagedMeta) => {
    const names = stagedMeta && Array.isArray(stagedMeta.affectedModules) && stagedMeta.affectedModules.length
      ? stagedMeta.affectedModules.filter((m) => modTags[m] && modTags[m].tag)
      : Object.keys(modTags).filter((m) => modTags[m] && modTags[m].tag);   // 未 staging 的 tag 不知道影响面 → 保守按全部
    if (!names.length) return Object.keys(modTags).length > 0 && Object.values(modTags).every((m) => cmpTag(m.tag, tag) >= 0);
    return names.every((m) => cmpTag(modTags[m].tag, tag) >= 0);
  };
  const items = ((cache && cache.tags) || []).map((t) => {
    const st = stagedMap.get(t.tag);
    const applied = isApplied(t.tag, st);
    const currentLine = cmpTag(t.tag, base) >= 0;      // 比最低模块版本还老的一律当旧版本
    let state = 'old';
    if (currentLine && !applied) state = st ? 'new-staged' : 'new-unstaged';
    else if (currentLine && applied) state = 'deployed';
    return { ...t, newer: currentLine && !applied, staged: !!st, applied, state,
      affectedModules: (st && st.affectedModules) || [], fileCount: st ? st.fileCount : 0 };
  });
  const behind = items.filter((x) => x.newer);
  return {
    configured: !!(cfg.repo),
    enabled: !!cfg.enabled,
    repo: cfg.repo,
    tokenSet: !!cfg.token,
    intervalMin: cfg.intervalMin,
    tagPattern: cfg.tagPattern,
    listSize: cfg.listSize,
    checkedAt: (cache && cache.checkedAt) || 0,
    checkError: (cache && cache.error) || null,
    never: !cache,
    base,
    latest: (cache && cache.latest) || null,
    behindCount: behind.length,
    pendingStaging: behind.filter((x) => !x.staged).length,
    items,
  };
}

// 定时器：启动 12s 后首检，之后按 intervalMin 轮询（改配置后重新排程）
let upstreamTimer = null;
function scheduleUpstream() {
  if (upstreamTimer) clearInterval(upstreamTimer);
  const cfg = readUpstreamConfig();
  if (!cfg.enabled) return;
  const ms = Math.min(1440, Math.max(5, Number(cfg.intervalMin) || 30)) * 60 * 1000;
  upstreamTimer = setInterval(() => { checkUpstream().catch((e) => console.error('[upstream] check failed:', e.message)); }, ms);
  if (upstreamTimer.unref) upstreamTimer.unref();
}

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
    if (!mod || !mod.service) { return { skipped: true, reason: 'no service (frontend? 走 GitHub Actions CI)' }; }
    const copied = applyFiles(releaseDir, moduleName);
    step(t, `${moduleName}: 复制 ${copied.length} 文件 → 重启 ${mod.service}`);
    const ok = await restartService(mod.service, healthByService[mod.service] || 3081);
    if (!ok) throw new Error(`${moduleName} 重启后健康检查未通过`);
    step(t, `${moduleName}: healthy ✓`);
    return { copied: copied.length, files: copied, healthy: true };
  }

  /** 后台执行 apply。t.needStage=true 时先按方案A从 GitHub 自拉 staging（不触碰运行中代码，失败直接终止） */
  async function runApply(t) {
    console.log(`[release-task] runApply start ` + t.id);
    const tag = t.tag;
    const releaseDir = join(RELEASES_DIR, tag);
    if (t.needStage) {
      try {
        await stageFromGithub(tag, t);
        audit('stage:done', { tag, source: 'apply-auto' });
      } catch (e) {
        t.state = 'failed'; t.error = `GitHub staging 失败: ${e.message}`;
        step(t, t.error); audit('stage:fail', { tag, error: e.message });
        return;   // 尚未复制/重启任何文件，无需回滚
      }
    }
    const meta = readJson(join(releaseDir, 'meta.json'), null);
    if (!meta) { t.state = 'failed'; t.error = `release 未 staging: ${tag}`; return; }
    if (!t.modules || !t.modules.length) t.modules = Array.isArray(meta.affectedModules) ? meta.affectedModules : [];
    if (!t.modules.length) { t.state = 'failed'; t.error = 'affected 为空且未显式指定 modules'; step(t, t.error); return; }
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
    if (remotePath === 'CF_PAGES') continue; // 前端由 GitHub Actions CI 发布
    const src = safeJoin(releaseDir, join('files', repoPath));
    if (!existsSync(src)) continue; // release 里没有该文件（未变更且未全量）→ 跳过
    const dst = safeJoin(HOME, remotePath.replace(/^~\//, ''));
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(src, dst);
    copied.push(remotePath);
  }
  return copied;
}

// ====== 方案A：设备端从 GitHub 自主拉取 staging ======
function manifestRepoFiles() {
  const set = new Set();
  for (const mod of Object.values(MANIFEST.modules)) {
    for (const [repoPath, remote] of Object.entries(mod.files || {})) {
      if (remote !== 'CF_PAGES') set.add(repoPath);   // CF_PAGES 前端不参与设备部署（走 CI）
    }
  }
  return [...set];
}
function modulesOwning(repoPath) {
  const out = [];
  for (const [name, mod] of Object.entries(MANIFEST.modules)) {
    if (mod.files && Object.prototype.hasOwnProperty.call(mod.files, repoPath)) out.push(name);
  }
  return out;
}
async function resolveTagSha(repo, tag, cfg) {
  try {
    const cache = readJson(UPSTREAM_CACHE_FILE, null);
    const hit = cache && Array.isArray(cache.tags) && cache.tags.find((x) => x.tag === tag);
    if (hit && hit.sha) return hit.sha;
  } catch { /* 缓存不可用则回退 API */ }
  const c = await ghFetch(`/repos/${repo}/commits/${encodeURIComponent(tag)}`, cfg);
  if (!c || !c.sha) throw new Error(`无法解析 tag ${tag} 的 commit sha`);
  return c.sha;
}
async function ghDownloadFile(repo, ref, repoPath, cfg) {
  const api = `/repos/${repo}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  const data = await ghFetch(api, cfg);
  if (data && typeof data.content === 'string') {
    return Buffer.from(data.content.replace(/\s+/g, ''), 'base64');
  }
  if (data && data.download_url) {   // >1MB 文件 Contents API 不给 inline，走 download_url
    const headers = { 'user-agent': 'honor10-monitor' };
    if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
    const r = await fetch(data.download_url, { headers, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`下载失败 ${repoPath}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error(`Contents API 未返回内容：${repoPath}`);
}

/**
 * 从 GitHub 按 manifest 下载 tag 文件到 ~/releases/<tag>/files/，跑 node --check 门禁，写 meta.json。
 * 复用上游检测已配置的只读 Contents PAT。失败只抛错，不触碰正在运行的代码。
 * @returns meta.json 对象
 */
async function stageFromGithub(tag, t) {
  const cfg = readUpstreamConfig();
  if (!cfg.repo) throw new Error('未配置上游仓库（release_config.json.repo）');
  if (!cfg.token) throw new Error('未配置 GitHub token（私有仓库需只读 Contents PAT）');
  const st = t ? (m) => step(t, m) : () => {};
  const sha = await resolveTagSha(cfg.repo, tag, cfg);
  st(`GitHub staging ${tag} → ${String(sha).slice(0, 7)}`);

  const releaseDir = join(RELEASES_DIR, tag);
  const filesDir = join(releaseDir, 'files');
  if (existsSync(filesDir)) rmSync(filesDir, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true });

  const repoFiles = manifestRepoFiles();
  let wrote = 0; const missing = [];
  for (const repoPath of repoFiles) {
    try {
      const buf = await ghDownloadFile(cfg.repo, sha, repoPath, cfg);
      const dst = safeJoin(releaseDir, join('files', repoPath));
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, buf);
      wrote++;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/404|Not Found/i.test(msg)) { missing.push(repoPath); continue; }   // 该 tag 无此文件
      throw new Error(`下载 ${repoPath} 失败: ${msg}`);
    }
  }
  if (!wrote) throw new Error('未下载到任何 manifest 文件（检查 token 权限 / 仓库名 / 该 tag 是否含这些文件）');
  st(`下载 ${wrote} 文件${missing.length ? `（缺失 ${missing.length}）` : ''}`);

  // 语法门禁：任一 .js 不过即中止（此时尚未触碰运行目录，安全）
  for (const repoPath of repoFiles) {
    if (!repoPath.endsWith('.js')) continue;
    const abs = safeJoin(releaseDir, join('files', repoPath));
    if (!existsSync(abs)) continue;
    const chk = await run(`node --check '${abs}' 2>&1`);
    if (chk && chk.trim()) throw new Error(`语法门禁未通过 ${repoPath}: ${chk.trim().slice(0, 300)}`);
  }
  st('node --check 门禁通过');

  // affected：与已部署 sha 比对（compare API）交集 manifest 模块；拿不到基线 → 全量
  let affected = [];
  const deployed = readJson(VERSION_FILE, { modules: {} });
  const baseSha = deployed.lastApply && deployed.lastApply.sha;
  try {
    if (baseSha && baseSha !== sha) {
      const cmp = await ghFetch(`/repos/${cfg.repo}/compare/${baseSha}...${sha}`, cfg);
      const mods = new Set();
      for (const f of (cmp.files || [])) for (const m of modulesOwning(f.filename)) if (MANIFEST.modules[m] && MANIFEST.modules[m].service) mods.add(m);
      affected = [...mods];
    } else if (!baseSha) {
      affected = Object.keys(MANIFEST.modules).filter((m) => MANIFEST.modules[m].service);
      st('无部署基线 → 保守按全部模块');
    } else {
      st('与当前部署同 sha → affected 空，apply 需显式 modules');
    }
  } catch (e) { st(`compare 失败（affected 交显式指定）: ${e.message}`); }
  st(`affected: ${affected.join(', ') || '(空)'}`);

  const meta = { tag, sha, stagedAt: Date.now(), affectedModules: affected, fileCount: wrote, source: 'github' };
  writeFileSync(join(releaseDir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

async function router(url, q, r, send) {
  const p = url.pathname;
  if (!p.startsWith('/api/release')) return false;

  // ---- 状态：当前版本 + 待应用 releases + 上游摘要 ----
  if (p === '/api/release/status' && q.method === 'GET') {
    const deployed = readJson(VERSION_FILE, { modules: {} });
    const up = upstreamView();
    send(200, JSON.stringify({
      ok: true,
      deployed,
      releases: listReleases(),
      manifestModules: Object.keys(MANIFEST.modules),
      upstream: {
        enabled: up.enabled, repo: up.repo, tokenSet: up.tokenSet, never: up.never,
        checkedAt: up.checkedAt, checkError: up.checkError, base: up.base,
        latest: up.latest, behindCount: up.behindCount, pendingStaging: up.pendingStaging,
      },
    }));
    return true;
  }

  // ---- 上游版本检测 ----
  if (p === '/api/release/upstream' && q.method === 'GET') {
    send(200, JSON.stringify({ ok: true, ...upstreamView() }));
    return true;
  }
  if (p === '/api/release/upstream/check' && q.method === 'POST') {
    const cache = await checkUpstream();          // 失败不抛，错因在 cache.error
    const v = upstreamView();
    send(200, JSON.stringify({ ok: !v.checkError, ...v, detail: cache && cache.tags ? `${cache.tags.length} tags` : '' }));
    return true;
  }

  // ---- 检测配置（token 永远脱敏输出） ----
  if (p === '/api/release/config' && q.method === 'GET') {
    const c = readUpstreamConfig();
    send(200, JSON.stringify({ ok: true, upstream: { ...c, token: maskToken(c.token), tokenSet: !!c.token } }));
    return true;
  }
  if (p === '/api/release/config' && (q.method === 'PUT' || q.method === 'POST')) {
    let input;
    try { input = JSON.parse((await readBody(q)) || '{}'); } catch { send(400, JSON.stringify({ ok: false, error: 'body 不是合法 JSON' })); return true; }
    const patch = (input.upstream && typeof input.upstream === 'object') ? input.upstream : input;
    if (patch.repo && !/^[\w.-]+\/[\w.-]+$/.test(String(patch.repo).trim())) {
      send(400, JSON.stringify({ ok: false, error: 'repo 需为 owner/name 形式' })); return true;
    }
    const saved = writeUpstreamConfig(patch);
    scheduleUpstream();
    send(200, JSON.stringify({ ok: true, upstream: { ...saved, token: maskToken(saved.token), tokenSet: !!saved.token }, timerArmed: !!upstreamTimer }));
    if (saved.enabled) checkUpstream().catch((e) => console.error('[upstream] post-config check failed:', e.message));
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

  // ---- 仅从 GitHub 拉取并 staging（不应用），供“先拉后审再应用” ----
  if (p === '/api/release/stage' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const tag = String(input.tag || '').trim();
    if (!/^[\w.\-]+$/.test(tag)) { send(400, JSON.stringify({ ok: false, error: 'tag 格式不合法' })); return true; }
    const running = [...tasks.values()].find(x => x.state === 'running');
    if (running) { send(409, JSON.stringify({ ok: false, error: `已有任务进行中（${running.kind} ${running.tag || ''}），请稍候` })); return true; }
    const t = newTask('stage', tag, []);
    audit('stage:start', { tag, taskId: t.id });
    (async () => {
      try { const meta = await stageFromGithub(tag, t); t.state = 'done'; t.results = { meta }; step(t, `staged ${tag} → ${meta.fileCount} 文件`); audit('stage:done', { tag, sha: meta.sha }); }
      catch (e) { t.state = 'failed'; t.error = e.message; step(t, e.message); audit('stage:fail', { tag, error: e.message }); }
    })();
    send(202, JSON.stringify({ ok: true, taskId: t.id, statusUrl: `/api/release/tasks?id=${t.id}`, tag }));
    return true;
  }

  // ---- 应用一个 release（202 异步）。未 staging 时按方案A自动从 GitHub 拉取后再应用 ----
  if (p === '/api/release/apply' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const tag = String(input.tag || '').trim();
    if (!/^[\w.\-]+$/.test(tag)) { send(400, JSON.stringify({ ok: false, error: 'tag 格式不合法' })); return true; }
    const releaseDir = join(RELEASES_DIR, tag);
    const meta = readJson(join(releaseDir, 'meta.json'), null);
    const needStage = !meta;                          // 方案A：无本地档案 → apply 内自拉
    // 并发互斥：同一时间只允许一个 running 任务
    const running = [...tasks.values()].find(x => x.state === 'running');
    if (running) { send(409, JSON.stringify({ ok: false, error: `已有任务进行中（${running.kind} ${running.tag || ''}），请稍候` })); return true; }
    // 模块来源：显式传入 > meta.affectedModules。needStage 时可为空（staging 后由 affected 解析）。
    let modules = (Array.isArray(input.modules) && input.modules.length) ? input.modules : null;
    if (!modules && meta && Array.isArray(meta.affectedModules) && meta.affectedModules.length) modules = meta.affectedModules;
    if (!modules && !needStage) { send(400, JSON.stringify({ ok: false, error: `${tag} 的 meta.affectedModules 为空（与已部署内容无差异或基线丢失），请显式传 modules` })); return true; }
    const known = Object.keys(MANIFEST.modules);
    if (modules) {
      const unknown = modules.filter((m) => !known.includes(m));
      if (unknown.length) { send(400, JSON.stringify({ ok: false, error: `未知模块: ${unknown.join(', ')}（manifest 只有 ${known.join(', ')}）` })); return true; }
    }
    const t = newTask('apply', tag, modules || []);
    t.needStage = needStage;
    audit('apply:start', { tag, modules: modules || '(自拉后解析)', needStage, taskId: t.id });
    runApply(t).then(() => console.log('[release-task] runApply finished', t.id, t.state)).catch(e => { console.error('[release-task] runApply throw:', e.message); t.state = 'failed'; t.error = e.message; });
    send(202, JSON.stringify({ ok: true, taskId: t.id, statusUrl: `/api/release/tasks?id=${t.id}`, tag, modules: modules || [], autoStage: needStage }));
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

scheduleUpstream();
// 启动首检（延后 12s，不与开机其它服务抢网络）；失败不致命，只记日志
setTimeout(() => { checkUpstream().then((c) => { if (c && c.error) console.log('[upstream] ' + c.error); }).catch((e) => console.error('[upstream] startup check failed:', e.message)); }, 12000).unref?.();

await createModuleServer({
  name: 'release',
  version: VERSION,
  port: parseInt(process.env.RELEASE_PORT || '3084', 10),
  router,
  stopHooks: [],
});
