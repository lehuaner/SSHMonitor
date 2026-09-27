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
import { createHash } from 'node:crypto';
import { createModuleServer, readBody } from './lib/module.js';
import { readPageDeployConfig, publishPages, waitPagesDeploy, rollbackPages } from './lib/pages-deploy.js';

const HOME = process.env.MONITOR_HOME || '/data/data/com.termux/files/home';
const MONITOR_DIR = join(HOME, 'monitor');
const RELEASES_DIR = join(HOME, 'releases');
const VERSION_FILE = join(HOME, '.monitor_data', 'deployed-version.json');
const AUDIT_LOG = join(HOME, '.monitor_data', 'release_audit.jsonl');
// Pages 发布状态：lastGood（可用于回滚/版本比对）+ 最近一次尝试的失败过程落库
const PAGES_STATE_FILE = join(HOME, '.monitor_data', 'pages_deploy_state.json');
const PAGES_FAIL_FILE = join(HOME, '.monitor_data', 'pages_deploy_last.json');
const SVDIR = '/data/data/com.termux/files/usr/var/service';
const VERSION = process.env.MONITOR_MODULE_VERSION || 'dev';
// ★数据快照：应用(apply)前整份备份 ~/.monitor_data 到 ~/.monitor_data_bak/<tag>_<时间>，保留最近 N 份
const MONITOR_DATA_DIR = join(HOME, '.monitor_data');
const DATA_BAK_ROOT = join(HOME, '.monitor_data_bak');
const DATA_BAK_KEEP = 10;

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
  const r = await fetchWithRetry(`https://api.github.com${pathname}`, { headers, timeoutMs: 20000 });
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

  /** 解析「最新版本」：优先上游缓存 latest，无则现拉一次。供 apply tag=latest/空 使用 */
  async function resolveLatestTag() {
    const c = readJson(UPSTREAM_CACHE_FILE, null);
    if (c && c.latest) return c.latest;
    try { const out = await checkUpstream(); return (out && out.latest) || null; } catch { return null; }
  }

  /** 整份快照 ~/.monitor_data 下所有文件到 ~/.monitor_data_bak/<tag>_<时间>；裁剪保留最近 DATA_BAK_KEEP 份 */
  function backupMonitorData(tag) {
    if (!existsSync(MONITOR_DATA_DIR)) return { skipped: '数据目录不存在' };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTag = String(tag || 'pre').replace(/[^\w.\-]/g, '_');
    const dir = join(DATA_BAK_ROOT, `${safeTag}_${stamp}`);
    mkdirSync(dir, { recursive: true });
    let files = 0;
    for (const ent of readdirSync(MONITOR_DATA_DIR, { withFileTypes: true })) {
      if (!ent.isFile()) continue;                       // 只备份文件（均为 json/jsonl/txt 配置），跳过子目录
      const from = join(MONITOR_DATA_DIR, ent.name);
      try { cpSync(from, join(dir, ent.name)); files++; } catch { /* 单文件复制失败不致命 */ }
    }
    // 裁剪：按目录名（含时间戳，字典序=时间序）保留最近 N 份
    try {
      const all = readdirSync(DATA_BAK_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      for (const old of all.slice(0, Math.max(0, all.length - DATA_BAK_KEEP))) { try { rmSync(join(DATA_BAK_ROOT, old), { recursive: true, force: true }); } catch {} }
    } catch {}
    return { dir: `.monitor_data_bak/${safeTag}_${stamp}`, files };
  }

  /** apply 成功后的前端部署后置钩子：本机模式→复制前端到 ~/monitor/frontend；Pages 模式→设备端直传发布（失败回滚+告警+落库）。绝不阻断后端部署。 */
  async function deployFrontend(t, tag, meta, releaseDir) {
    const cfg = readPageDeployConfig(HOME);
    const srcDir = join(releaseDir, 'files', 'monitor', 'frontend');
    if (cfg.mode === 'local') {
      if (!meta.frontendChanged) { if (t) step(t, '本次无前端改动，跳过本机前端更新'); return; }
      if (!existsSync(srcDir)) { if (t) step(t, '本机模式：release 无前端文件，跳过'); return; }
      const dst = join(HOME, 'monitor', 'frontend');
      mkdirSync(dst, { recursive: true });
      let n = 0; for (const f of readdirSync(srcDir)) { try { cpSync(join(srcDir, f), join(dst, f)); n++; } catch { /* ignore */ } }
      audit('frontend:local', { tag, files: n });
      if (t) step(t, `前端已复制到本机 ${dst}（${n} 文件）`);
      return;
    }
    if (cfg.mode !== 'pages') { if (t) step(t, `前端部署模式未知(${cfg.mode})，跳过`); return; }
    if (!meta.frontendChanged) { if (t) step(t, '本次无前端改动，跳过 Pages 发布'); return; }
    if (!existsSync(srcDir)) { await recordPagesFail(tag, null, `前端目录缺失 ${srcDir}`, readJson(PAGES_STATE_FILE, {}).lastGood); return; }
    const prevGood = readJson(PAGES_STATE_FILE, {}).lastGood || null;
    if (t) step(t, '开始发布 Pages（设备端直传）…');
    let res;
    try {
      res = await publishPages({ config: cfg, frontendDir: srcDir, commitHash: meta.sha || '', commitMessage: tag, log: (m) => { if (t) step(t, 'Pages: ' + m); } });
    } catch (e) { await recordPagesFail(tag, null, 'publish 抛错: ' + e.message, prevGood); return; }
    const w = await waitPagesDeploy(cfg, res.deploymentId);
    if (w.state === 'ready') {
      const st = readJson(PAGES_STATE_FILE, {});
      st.lastGood = { tag, deploymentId: res.deploymentId, url: res.url, at: Date.now() };
      st.lastAttempt = { tag, ok: true, at: Date.now() };
      try { writeFileSync(PAGES_STATE_FILE, JSON.stringify(st, null, 2)); } catch { /* ignore */ }
      audit('pages:ok', { tag, deploymentId: res.deploymentId, url: res.url });
      if (t) step(t, `Pages 发布成功 ✓ ${res.url}`);
    } else {
      await recordPagesFail(tag, res.deploymentId, `deployment ${w.state}${w.detail ? ': ' + w.detail : ''}`, prevGood);
    }
  }

  /** Pages 发布失败统一处理：回滚上一 good deployment、落库失败过程、邮件告警、审计。 */
  async function recordPagesFail(tag, deploymentId, reason, prevGood) {
    let rolledBackTo = null;
    try {
      if (prevGood && prevGood.deploymentId) {
        await rollbackPages(readPageDeployConfig(HOME), prevGood.deploymentId);
        rolledBackTo = prevGood.tag || prevGood.deploymentId;
      }
    } catch (e) { reason += '；回滚也失败: ' + e.message; }
    const rec = { tag, at: new Date().toISOString(), ok: false, reason: String(reason), deploymentId: deploymentId || null, rolledBackTo };
    try { writeFileSync(PAGES_FAIL_FILE, JSON.stringify(rec, null, 2)); } catch { /* ignore */ }
    audit('pages:fail', { tag, reason: String(reason).slice(0, 300), rolledBackTo });
    try {
      const { sendMail } = await import('./lib/notify.js');
      if (typeof sendMail === 'function') {
        await sendMail(`[告警] Pages 发布失败 ${tag}`, `原因：${reason}\ndeploymentId：${deploymentId || '-'}\n已回滚到：${rolledBackTo || '无（保留现网）'}\n后端部署已完成，仅前端 Pages 未更新，请检查。`);
      }
    } catch { /* 告警失败不致命 */ }
  }

  /** 后台执行 apply。t.needStage=true 时先按方案A从 GitHub 自拉 staging（不触碰运行中代码，失败直接终止） */
  async function runApply(t) {
    console.log(`[release-task] runApply start ` + t.id);
    const tag = t.tag;
    const releaseDir = join(RELEASES_DIR, tag);
    if (t.needStage) {
      try {
        await stageFromRelease(tag, t);
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
    // 旧 meta（本次改造前 staging）或未扩展的档案 → 按 staging 档案里的变更文件补一次消费方扩展
    if (t.modules.length && typeof meta.expanded !== 'boolean') {
      let changed = [];
      try { changed = JSON.parse(readFileSync(join(releaseDir, 'changed-files.json'), 'utf8')); } catch {}
      const exp = expandAffected(t.modules, changed);
      if (exp.length !== t.modules.length) step(t, `消费方扩展: ${t.modules.join(',')} → ${exp.join(',')}`);
      t.modules = exp;
    }
    if (!t.modules.length) { t.state = 'failed'; t.error = 'affected 为空且未显式指定 modules'; step(t, t.error); return; }
    const results = {};
    const done = [];
    // ★应用前整份备份 ~/.monitor_data（含 checkin_tasks.json 等），误清空/回退时可一键还原；备份失败不阻断应用
    try {
      const bk = backupMonitorData(tag);
      if (bk && !bk.skipped) { step(t, `已备份数据 ${bk.files} 个文件 → ${bk.dir}`); audit('apply:backup', { tag, dir: bk.dir, files: bk.files }); }
      else if (bk && bk.skipped) step(t, `跳过数据备份：${bk.skipped}`);
    } catch (e) { step(t, `数据备份失败（不影响应用）：${e && e.message}`); }
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
    // 后置：前端部署（本机复制 / Pages 直传）——失败不回滚后端、不阻断任务，仅告警+落库
    try { await deployFrontend(t, tag, meta, releaseDir); } catch (e) { step(t, `前端部署钩子异常（不影响后端）：${e && e.message}`); audit('frontend:hook_error', { tag, error: e && e.message }); }
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

/** 带指数退避的 fetch 重试：设备上行链路偶发掉连（fetch failed / 超时），重试可稳。 */
async function fetchWithRetry(url, { timeoutMs = 30000, ...rest } = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (2 ** i) + Math.floor(Math.random() * 400)));
    }
  }
  const c = last && last.cause;
  const host = (c && (c.hostname || c.address)) || (url && String(url).replace(/^https?:\/\//, '').split('/')[0]);
  console.error(`[fetchWithRetry] 失败 host=${host} syscall=${c && c.syscall} code=${c && c.code} url=${url}`);
  throw new Error(`fetch failed host=${host} code=${c && c.code}: ${last && last.message}${c ? ` [cause=${c.code || c.message || c.errno || c.syscall || JSON.stringify(c).slice(0, 120)}]` : ''}`);
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
/**
 * 共享库消费方扩展：变更文件除拥有方模块外，还须重启 manifest.consumers 声明的消费模块。
 * 否则像“只发 checkin 的 lib 修复”永远不重启 gateway，长驻进程继续用旧代码（2026-09-21 误报邮件根因）。
 * 排序按 manifest.applyOrder（先 gateway 后 checkin，与 shared two-phase 约定一致）。
 */
function expandAffected(mods, changedFiles) {
  const set = new Set(mods || []);
  for (const f of changedFiles || []) {
    for (const c of ((MANIFEST.consumers || {})[f] || [])) {
      if (c !== '$comment' && MANIFEST.modules[c] && MANIFEST.modules[c].service) set.add(c);
    }
  }
  const order = Array.isArray(MANIFEST.applyOrder) && MANIFEST.applyOrder.length ? MANIFEST.applyOrder : Object.keys(MANIFEST.modules);
  return [...set].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
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

  // affected：与已部署 sha 比对（compare API）交集 manifest 模块，再按 consumers 扩展消费方；拿不到基线 → 全量
  let affected = [];
  let changedFiles = [];
  const deployed = readJson(VERSION_FILE, { modules: {} });
  const baseSha = deployed.lastApply && deployed.lastApply.sha;
  try {
    if (baseSha && baseSha !== sha) {
      const cmp = await ghFetch(`/repos/${cfg.repo}/compare/${baseSha}...${sha}`, cfg);
      const mods = new Set();
      changedFiles = (cmp.files || []).map((f) => f.filename);
      for (const fn of changedFiles) for (const m of modulesOwning(fn)) if (MANIFEST.modules[m] && MANIFEST.modules[m].service) mods.add(m);
      affected = expandAffected(mods, changedFiles);   // 共享 lib → 所有消费模块一并重启
    } else if (!baseSha) {
      affected = Object.keys(MANIFEST.modules).filter((m) => MANIFEST.modules[m].service);
      st('无部署基线 → 保守按全部模块');
    } else {
      st('与当前部署同 sha → affected 空，apply 需显式 modules');
    }
  } catch (e) { st(`compare 失败（affected 交显式指定）: ${e.message}`); }
  st(`affected: ${affected.join(', ') || '(空)'}`);

  const meta = { tag, sha, stagedAt: Date.now(), affectedModules: affected, fileCount: wrote, source: 'github', expanded: true };
  try { writeFileSync(join(releaseDir, 'changed-files.json'), JSON.stringify(changedFiles || [])); } catch {}
  writeFileSync(join(releaseDir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

// ====== 设备端从 GitHub Release 产物拉取 staging（唯一来源，无逐文件回退） ======
const ASSET_BACKEND = 'honor10-backend.tar.gz';
const ASSET_FRONTEND = 'honor10-frontend.tar.gz';
const ASSET_BUILD = 'honor10-build.json';

/** 前端（CF_PAGES）仓库相对路径集合，用于判定本次是否含前端改动 */
function frontendRepoPaths() {
  const s = new Set();
  for (const mod of Object.values(MANIFEST.modules)) {
    for (const [repoPath, remote] of Object.entries(mod.files || {})) if (remote === 'CF_PAGES') s.add(repoPath);
  }
  return [...s];
}

/** 下载 GitHub 端点为二进制 Buffer（Release 资产：json / octet-stream 跟随重定向） */
async function ghFetchBuffer(assetUrlOrPath, cfg, accept) {
  const headers = { 'user-agent': 'honor10-monitor', authorization: `Bearer ${cfg.token}` };
  headers.accept = accept || 'application/vnd.github+json';
  const url = /^https?:\/\//i.test(assetUrlOrPath) ? assetUrlOrPath : `https://api.github.com${assetUrlOrPath}`;
  const r = await fetchWithRetry(url, { headers, timeoutMs: 90000, redirect: 'follow' }, 4);
  if (!r.ok) throw new Error(`${url.split('?')[0]} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * 从 tag 对应的 GitHub Release 下载产物（honor10-build.json + backend/frontend tar.gz），
 * 解包到 ~/releases/<tag>/files/（tar 内 monitor/... → files/monitor/...），逐文件 sha256 校验，
 * 用 compare(base...commit) 得受影响模块并按 consumers 扩展。失败只抛错，不触碰运行代码。
 * 无任何逐文件回退：Release/资产缺失即失败（release.yml 尚未产出时属预期，稍后重试）。
 */
async function stageFromRelease(tag, t) {
  const cfg = readUpstreamConfig();
  if (!cfg.repo) throw new Error('未配置上游仓库（release_config.json.repo）');
  if (!cfg.token) throw new Error('未配置 GitHub token（私有仓库 Release 资产需 Contents: Read-only）');
  const st = t ? (m) => step(t, m) : () => {};

  let rel;
  try { rel = await ghFetch(`/repos/${cfg.repo}/releases/tags/${encodeURIComponent(tag)}`, cfg); }
  catch (e) { throw new Error(`拉取 Release ${tag} 失败：${e.message}（可能 release.yml 产物尚未生成，稍后重试）`); }
  const byName = {}; for (const a of (rel.assets || [])) byName[a.name] = a;
  for (const need of [ASSET_BUILD, ASSET_BACKEND]) if (!byName[need]) throw new Error(`Release ${tag} 缺少必需资产 ${need}`);

  const build = JSON.parse((await ghFetchBuffer(byName[ASSET_BUILD].url, cfg, 'application/octet-stream')).toString('utf8'));
  const sha = String(build.commit || '');
  if (!sha) throw new Error('build.json 无 commit');
  st(`Release ${tag} → commit ${sha.slice(0, 7)}，backend ${build.backend?.files?.length || 0}、frontend ${build.frontend?.files?.length || 0} 文件`);

  const releaseDir = join(RELEASES_DIR, tag);
  const filesDir = join(releaseDir, 'files');
  if (existsSync(filesDir)) rmSync(filesDir, { recursive: true, force: true });
  mkdirSync(filesDir, { recursive: true });
  const tmp = join(RELEASES_DIR, `.dl_${tag}_${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const btar = join(tmp, ASSET_BACKEND);
    writeFileSync(btar, await ghFetchBuffer(byName[ASSET_BACKEND].url, cfg, 'application/octet-stream'));
    const exB = await run(`tar xzf '${btar}' -C '${filesDir}' 2>&1`);
    if (exB && /error|cannot|No such/i.test(exB)) throw new Error(`解包 backend 失败：${exB.trim().slice(0, 200)}`);
    if (byName[ASSET_FRONTEND]) {
      const ftar = join(tmp, ASSET_FRONTEND);
      writeFileSync(ftar, await ghFetchBuffer(byName[ASSET_FRONTEND].url, cfg, 'application/octet-stream'));
      const exF = await run(`tar xzf '${ftar}' -C '${filesDir}' 2>&1`);
      if (exF && /error|cannot|No such/i.test(exF)) throw new Error(`解包 frontend 失败：${exF.trim().slice(0, 200)}`);
    }
    // 逐文件 sha256 校验（完整性）
    const verify = (list) => { const bad = []; for (const f of (list || [])) { const abs = safeJoin(releaseDir, join('files', f.path)); if (!existsSync(abs)) { bad.push(f.path + '(缺失)'); continue; } const h = createHash('sha256').update(readFileSync(abs)).digest('hex'); if (h !== f.sha256) bad.push(f.path + '(sha不符)'); } return bad; };
    const bad = [...verify(build.backend.files), ...verify(build.frontend && build.frontend.files)];
    if (bad.length) throw new Error(`产物完整性校验失败：${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` …共 ${bad.length}` : ''}`);
    st(`sha256 校验通过`);
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }

  // affected：与已部署 commit 比对（compare API，纯元数据）→ 模块 + 消费方扩展
  let affected = []; let changedFiles = [];
  const deployed = readJson(VERSION_FILE, { modules: {} });
  const baseSha = deployed.lastApply && deployed.lastApply.sha;
  try {
    if (baseSha && baseSha !== sha) {
      const cmp = await ghFetch(`/repos/${cfg.repo}/compare/${baseSha}...${sha}`, cfg);
      changedFiles = (cmp.files || []).map((f) => f.filename);
      const mods = new Set(); for (const fn of changedFiles) for (const m of modulesOwning(fn)) if (MANIFEST.modules[m] && MANIFEST.modules[m].service) mods.add(m);
      affected = expandAffected(mods, changedFiles);
    } else if (!baseSha) {
      affected = Object.keys(MANIFEST.modules).filter((m) => MANIFEST.modules[m].service);
      st('无部署基线 → 保守按全部模块');
    } else { st('与当前部署同 commit → affected 空'); }
  } catch (e) { st(`compare 失败（affected 交显式指定）: ${e.message}`); }

  const fePaths = frontendRepoPaths();
  const frontendChanged = changedFiles.length ? changedFiles.some((f) => fePaths.includes(f)) : ((build.frontend && build.frontend.files) || []).length > 0;
  st(`affected: ${affected.join(', ') || '(空)'}；前端变更: ${frontendChanged ? '有' : '无'}`);

  const meta = { tag, sha, stagedAt: Date.now(), affectedModules: affected, fileCount: (build.backend.files || []).length, source: 'release-asset', expanded: true, frontendChanged };
  try { writeFileSync(join(releaseDir, 'changed-files.json'), JSON.stringify(changedFiles || [])); } catch { /* ignore */ }
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

  // ---- 前后端版本一致性（后端已部署 vs Pages 已发布） ----
  if (p === '/api/release/version-status' && q.method === 'GET') {
    const deployed = readJson(VERSION_FILE, { modules: {} });
    const st = readJson(PAGES_STATE_FILE, {});
    const fail = readJson(PAGES_FAIL_FILE, null);
    const cfg = readPageDeployConfig(HOME);
    const backend = (deployed.lastApply && deployed.lastApply.tag) || null;
    const pages = (st.lastGood && st.lastGood.tag) || null;
    const mismatch = cfg.mode === 'pages' && !!backend && !!pages && backend !== pages;
    send(200, JSON.stringify({ ok: true, mode: cfg.mode, backend, pages, mismatch,
      pagesUrl: (st.lastGood && st.lastGood.url) || null, lastFail: fail && !fail.ok ? fail : null }));
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
      try { const meta = await stageFromRelease(tag, t); t.state = 'done'; t.results = { meta }; step(t, `staged ${tag} → ${meta.fileCount} 文件`); audit('stage:done', { tag, sha: meta.sha }); }
      catch (e) { t.state = 'failed'; t.error = e.message; step(t, e.message); audit('stage:fail', { tag, error: e.message }); }
    })();
    send(202, JSON.stringify({ ok: true, taskId: t.id, statusUrl: `/api/release/tasks?id=${t.id}`, tag }));
    return true;
  }

  // ---- 应用一个 release（202 异步）。未 staging 时按方案A自动从 GitHub 拉取后再应用 ----
  if (p === '/api/release/apply' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    let tag = String(input.tag || '').trim();
    if (!tag || tag === 'latest') tag = (await resolveLatestTag()) || '';   // ★一键更新：tag 为 latest/空 → 解析上游最新 tag
    if (!tag) { send(400, JSON.stringify({ ok: false, error: '无法确定最新版本（上游检测无结果，请先「立即检测」或显式指定 tag）' })); return true; }
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
