/**
 * mod-checkin —— 签到模块独立进程（方案 B / P1 阶段）。
 *
 * 职责：/api/checkin/* 全量路由 + 签到调度器 + 凭证到期监控 + 积分过期提醒 + 每日快照。
 * 与 core 的边界：只通过 gateway 反代对外服务；sendMail 直连（SMTP 出网，不走 core）。
 *
 * 新增能力（2026-09-19）：
 *   GET /api/checkin/tasks?provider=<id>  按 provider 筛选账号列表
 *   GET /api/checkin/providers 里各 provider 附 accountCount（前端筛选器角标）
 *
 * 停机：SIGTERM → 停全部调度器 → 排空在途请求 → exit；runit 拉起新实例。
 */
import { registerProvider, getProviderSchemas, getProvider } from './lib/providers/index.js';
import traeProvider from './lib/providers/trae.js';
import workbuddyProvider from './lib/providers/workbuddy.js';
import codeartsProvider from './lib/providers/codearts.js';
import autoclawProvider from './lib/providers/autoclaw.js';
import officeaceProvider from './lib/providers/officeace.js';
import {
  addTask, updateTask, deleteTask, runTaskNow, runAllNow, testCredential, getCredits,
  loadTasks, saveTasks, startAllTasks, stopAllTasks, startCookieExpiryWatcher,
  checkStatusForTask, autoCheckToday, getTotalCreditsForTask,
} from './lib/tasks/index.js';
import { getLogs } from './lib/checkin-log.js';
import { recordSnapshot, updateUsageStats, getUsageStatsWithEstimates, getTaskUsageDetail, startDailySnapshot, removeTaskStats } from './lib/checkin-stats.js';
import { createModuleServer, readBody } from './lib/module.js';

const VERSION = process.env.MONITOR_MODULE_VERSION || 'dev';

registerProvider(traeProvider);
registerProvider(workbuddyProvider);
registerProvider(codeartsProvider);
registerProvider(autoclawProvider);
registerProvider(officeaceProvider);

// ====== 调度器启动（延迟错峰，与旧版行为一致） ======
const startTimers = [];
startTimers.push(setTimeout(() => { try { startAllTasks(); } catch (e) { console.error('start checkin tasks:', e); } }, 4000));
startTimers.push(setTimeout(() => { try { startCookieExpiryWatcher(); } catch (e) { console.error('start cookie expiry watcher:', e); } }, 4000));
startTimers.push(setTimeout(() => { try { recordSnapshot(); } catch (e) { console.error('initial checkin snapshot:', e); } }, 7000));
startTimers.push(setTimeout(() => { try { startDailySnapshot(); } catch (e) { console.error('start checkin stats:', e); } }, 7000));

// ====== stats 快照（SWR）======
// 旧版 GET /api/checkin/stats 同步 await updateUsageStats()+getUsageStatsWithEstimates()，
// 两者逐账号串行拉上游（实测 6.7s），签到页因此卡死。现在：
//   • GET 只读内存快照立即返回；过期时先回旧快照、后台单飞重算。
//   • 启动 10s 后预构首次快照；此后每 30 分钟后台刷新一次（无人访问也有最新数据）。
//   • 手动「↻ 刷新」走 POST /api/checkin/stats/refresh 触发后台重算，不阻塞等待。
const STATS_TTL_MS = 10 * 60 * 1000;          // 快照有效期：超过则请求触发后台重算
const STATS_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 定时后台刷新
let statsCache = null;                        // { data, at }
let statsBuilding = null;                     // 单飞锁
function startStatsBuild() {
  if (statsBuilding) return false;            // 已有在途构建，不重复发起
  statsBuilding = (async () => {
    const t0 = Date.now();
    try {
      await updateUsageStats();
      const data = await getUsageStatsWithEstimates();
      statsCache = { data, at: Date.now() };
      console.log(`[checkin] stats 快照重建完成，耗时 ${Date.now() - t0}ms`);
    } catch (e) {
      console.error('[checkin] stats 快照构建失败(保留旧值):', e.message);
    } finally { statsBuilding = null; }
  })();
  return true;
}
startTimers.push(setTimeout(() => { startStatsBuild(); }, 10000));
const statsRefreshTimer = setInterval(() => { startStatsBuild(); }, STATS_REFRESH_INTERVAL_MS);

// ====== 路由 ======
/**
 * 列表接口的凭证脱敏键集。
 *
 * ★2026-09-19 补全：原来只遮 token/cookie，`password` / `hwidCasSid` / `cookies` 以及
 *   OfficeAce 的 `refreshToken` / `dpopJwk` / `secretKey` / `securityToken` 全部明文回传，
 *   而这些**等同于账号凭证**（refresh_token 单次有效、DPoP 私钥与它绑定，拿到即可签到与续期）。
 * ★只遮 schema 里声明为 password 的字段 + 不进表单的内部键：
 *   表单里 `text` 类型字段（如 CodeArts 的 localStorageId、projectId）不能遮——
 *   前端对非 password 字段会把看到的值原样回传，`***` 会覆盖掉真实值。
 */
const MASKED_CONFIG_KEYS = [
  'token', 'cookie', 'cookies', 'password', 'hwidCasSid',
  'refreshToken', 'dpopJwk', 'accessKey', 'secretKey', 'securityToken',
  'modelAppKey', 'modelAppSecret',
];
function maskTaskCredentials(t) {
  const config = { ...t.config };
  for (const k of MASKED_CONFIG_KEYS) {
    if (!(k in config)) continue;
    const v = config[k];
    const filled = v !== undefined && v !== null && v !== ''
      && !(Array.isArray(v) && !v.length)
      && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    config[k] = filled ? '***' : '';
  }
  return { ...t, config, hasToken: !!t.config.token, hasCookie: !!t.config.cookie };
}

async function router(url, q, r, send) {
  const p = url.pathname;
  if (!p.startsWith('/api/checkin') && p !== '/api/update/module') return false;

  // ---- 运维：本模块版本信息（gateway /healthz 汇总用） ----
  if (p === '/api/update/module' && q.method === 'GET') {
    send(200, JSON.stringify({ ok: true, module: 'checkin', version: VERSION }));
    return true;
  }

  // GET /api/checkin/providers - provider 注册表 + configSchema（附账号计数）
  if (p === '/api/checkin/providers' && q.method === 'GET') {
    const counts = {};
    for (const t of loadTasks()) counts[t.providerId] = (counts[t.providerId] || 0) + 1;
    send(200, JSON.stringify({
      ok: true,
      providers: getProviderSchemas().map((pr) => ({ ...pr, accountCount: counts[pr.id] || 0 })),
    }));
    return true;
  }

  // GET /api/checkin/tasks - 账号列表（★支持 ?provider= 按平台筛选；凭证脱敏）
  if (p === '/api/checkin/tasks' && q.method === 'GET') {
    const providerFilter = (url.searchParams.get('provider') || '').trim();
    let tasks = loadTasks();
    const totalBeforeFilter = tasks.length;
    if (providerFilter) tasks = tasks.filter((t) => t.providerId === providerFilter);
    tasks = tasks.map(maskTaskCredentials);
    send(200, JSON.stringify({ ok: true, tasks, total: totalBeforeFilter, filtered: tasks.length }));
    return true;
  }

  // POST /api/checkin/tasks - 新增账号
  if (p === '/api/checkin/tasks' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    if (!input.providerId || !input.name) { send(400, JSON.stringify({ ok: false, error: '缺少 providerId 或 name' })); return true; }
    const task = addTask(input);
    send(200, JSON.stringify({ ok: true, task }));
    return true;
  }

  // PUT /api/checkin/tasks?id=
  if (p === '/api/checkin/tasks' && q.method === 'PUT') {
    const id = url.searchParams.get('id');
    const patch = JSON.parse((await readBody(q)) || '{}');
    const task = updateTask(id, patch);
    if (!task) { send(404, JSON.stringify({ ok: false, error: '任务不存在' })); return true; }
    send(200, JSON.stringify({ ok: true, task }));
    return true;
  }

  // DELETE /api/checkin/tasks?id=
  if (p === '/api/checkin/tasks' && q.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    const removed = deleteTask(id);
    if (removed) removeTaskStats(id);
    send(200, JSON.stringify({ ok: removed }));
    return true;
  }

  if (p === '/api/checkin/run' && q.method === 'POST') {
    const res = await runTaskNow(url.searchParams.get('id') || '');
    send(res.ok ? 200 : 500, JSON.stringify(res));
    return true;
  }
  if (p === '/api/checkin/run-all' && q.method === 'POST') {
    send(200, JSON.stringify({ ok: true, results: await runAllNow() }));
    return true;
  }
  if (p === '/api/checkin/test' && q.method === 'POST') {
    const res = await testCredential(url.searchParams.get('id') || '');
    send(res.ok ? 200 : 500, JSON.stringify(res));
    return true;
  }
  if (p === '/api/checkin/credits' && q.method === 'GET') {
    const res = await getCredits(url.searchParams.get('id') || '');
    send(res.ok ? 200 : 500, JSON.stringify(res));
    return true;
  }
  if (p === '/api/checkin/credits/total' && q.method === 'GET') {
    const res = await getTotalCreditsForTask(url.searchParams.get('id') || '');
    send(res.ok ? 200 : 500, JSON.stringify(res));
    return true;
  }
  if (p === '/api/checkin/status' && q.method === 'GET') {
    const res = await checkStatusForTask(url.searchParams.get('id') || '');
    send(res.ok ? 200 : 500, JSON.stringify(res));
    return true;
  }
  if (p === '/api/checkin/auto-check' && q.method === 'GET') {
    send(200, JSON.stringify({ ok: true, results: await autoCheckToday() }));
    return true;
  }

  // GET /api/checkin/stats - 只读快照立即返回（重活全部后台化，见文件头 SWR 说明）
  if (p === '/api/checkin/stats' && q.method === 'GET') {
    const stale = !statsCache || Date.now() - statsCache.at > STATS_TTL_MS;
    if (stale) startStatsBuild();
    if (statsCache) {
      send(200, JSON.stringify({ ok: true, statsAt: statsCache.at, refreshing: !!statsBuilding, ...statsCache.data }));
    } else {
      // 冷启动首次快照未就绪：前端按 pending 延迟重试
      send(200, JSON.stringify({ ok: true, pending: true }));
    }
    return true;
  }

  // POST /api/checkin/stats/refresh - 手动触发后台重算（不阻塞，完成后前端轮询取回新快照）
  if (p === '/api/checkin/stats/refresh' && q.method === 'POST') {
    const started = startStatsBuild();
    send(200, JSON.stringify({ ok: true, started, ...(statsCache ? { statsAt: statsCache.at } : {}) }));
    return true;
  }

  // GET /api/checkin/logs - 30 天日志（本地 + provider 平台侧历史合并）
  if (p === '/api/checkin/logs' && q.method === 'GET') {
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    const taskId = url.searchParams.get('taskId') || undefined;
    const local = getLogs({ days, taskId }).map((l) => ({ ...l, source: 'local' }));
    let remote = [];
    let hasRemoteApi = false;
    let remoteError = null;
    let remoteLabel = null;
    const tasks = loadTasks();
    const task = taskId ? tasks.find((t) => t.id === taskId) : null;
    if (task) {
      const provider = getProvider(task.providerId);
      if (provider && typeof provider.getCheckinHistory === 'function') {
        hasRemoteApi = true;
        try {
          remote = (await provider.getCheckinHistory(task, { days })) || [];
          remoteLabel = remote.length ? remote[0].source : null;
          saveTasks(tasks);
        } catch (e) {
          remoteError = e.message || String(e);
        }
      }
    }
    const have = new Set(local.map((l) => l.date));
    const merged = local.concat(
      remote.filter((x) => x && x.date && !have.has(x.date)).map((x) => ({
        taskId: taskId || null,
        providerId: task ? task.providerId : '',
        date: x.date,
        status: 'success',
        credits: x.credits ?? null,
        reward: x.credits ?? null,
        error: null,
        source: 'remote',
        sourceLabel: x.source || null,
      }))
    ).sort((a, b) => (a.date < b.date ? -1 : 1));
    send(200, JSON.stringify({
      ok: true, logs: merged,
      localCount: local.length, remoteCount: merged.length - local.length,
      hasRemoteApi, remoteError, remoteLabel,
    }));
    return true;
  }

  // ★用量统计已改为上方「SWR 快照 + 后台定时重建」，GET 不再同步拉上游

  // POST /api/checkin/usage?id=
  if (p === '/api/checkin/usage' && q.method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const task = loadTasks().find((t) => t.id === id);
    if (!task) { send(404, JSON.stringify({ ok: false, error: '账号不存在' })); return true; }
    const provider = getProvider(task.providerId);
    if (!provider || typeof provider.getUsage !== 'function') {
      const detail = getTaskUsageDetail(id);
      if (detail) {
        send(200, JSON.stringify({ ok: true, fallback: 'daily', reason: 'provider_no_session_api', ...detail }));
      } else {
        send(501, JSON.stringify({ ok: false, error: '该账号的 provider 不支持用量查询，且暂无已落库的逐日数据' }));
      }
      return true;
    }
    let params = {};
    try { params = JSON.parse((await readBody(q)) || '{}'); } catch { params = {}; }
    try {
      send(200, JSON.stringify({ ok: true, data: await provider.getUsage(task, params) }));
    } catch (e) {
      send(200, JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // GET /api/checkin/packages?id=
  if (p === '/api/checkin/packages' && q.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const tasks = loadTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) { send(404, JSON.stringify({ ok: false, error: '账号不存在' })); return true; }
    const provider = getProvider(task.providerId);
    if (!provider || typeof provider.getPackages !== 'function') {
      send(501, JSON.stringify({ ok: false, error: '该 provider 不支持权益包查询' }));
      return true;
    }
    try {
      const res = await provider.getPackages(task);
      saveTasks(tasks);
      send(200, JSON.stringify({ ok: true, data: res }));
    } catch (e) {
      send(200, JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  // ★积分过期不再提供「逐账号预览 / 立即检查」端点：已统一改为 gateway 单进程的「每日日报」
  //   （见 lib/daily-report.js）。fetchCreditExpiryBatches 仍作为日报取数内部使用。

  // ---- 设备验证码（CodeArts） ----
  if (p === '/api/checkin/verify-code/request' && q.method === 'POST') {
    const id = url.searchParams.get('id') || '';
    const tasks = loadTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) { send(404, JSON.stringify({ ok: false, error: '账号不存在' })); return true; }
    const provider = getProvider(task.providerId);
    if (!provider || typeof provider.requestVerifyCode !== 'function') {
      send(501, JSON.stringify({ ok: false, error: '该 provider 不支持设备验证码' }));
      return true;
    }
    try {
      const res = await provider.requestVerifyCode(task);
      saveTasks(tasks);
      send(200, JSON.stringify(res));
    } catch (e) {
      saveTasks(tasks);
      send(200, JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }
  if (p === '/api/checkin/verify-code/submit' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const code = String(input.code || '').trim();
    if (!code) { send(400, JSON.stringify({ ok: false, error: '缺少验证码 code' })); return true; }
    const id = url.searchParams.get('id') || '';
    const tasks = loadTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) { send(404, JSON.stringify({ ok: false, error: '账号不存在' })); return true; }
    const provider = getProvider(task.providerId);
    if (!provider || typeof provider.submitVerifyCode !== 'function') {
      send(501, JSON.stringify({ ok: false, error: '该 provider 不支持设备验证码' }));
      return true;
    }
    try {
      const res = await provider.submitVerifyCode(task, code, Number(input.deviceIndex) || 0);
      saveTasks(tasks);
      send(200, JSON.stringify(res));
    } catch (e) {
      saveTasks(tasks);
      send(200, JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }
  if (p === '/api/checkin/verify-code/cancel' && q.method === 'POST') {
    const task = loadTasks().find((t) => t.id === (url.searchParams.get('id') || ''));
    const provider = task ? getProvider(task.providerId) : null;
    if (!task || !provider || typeof provider.cancelVerifyCode !== 'function') {
      send(200, JSON.stringify({ ok: false, error: '该 provider 不支持设备验证码' }));
      return true;
    }
    send(200, JSON.stringify(provider.cancelVerifyCode(task)));
    return true;
  }

  // ---- AutoClaw 短信登录 ----
  if (p === '/api/checkin/sms-login/request' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const phone = String(input.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) { send(400, JSON.stringify({ ok: false, error: '手机号格式不正确' })); return true; }
    const id = url.searchParams.get('id') || '';
    const tasks = loadTasks();
    const task = id ? tasks.find((t) => t.id === id) : null;
    if (id && !task) { send(404, JSON.stringify({ ok: false, error: '账号不存在' })); return true; }
    const provider = getProvider('autoclaw');
    if (!provider || typeof provider.requestLoginCode !== 'function') {
      send(501, JSON.stringify({ ok: false, error: '该 provider 不支持验证码登录' }));
      return true;
    }
    try {
      const res = await provider.requestLoginCode(task || { config: {} }, phone);
      if (id) saveTasks(tasks);
      send(200, JSON.stringify(res));
    } catch (e) {
      send(200, JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }
  if (p === '/api/checkin/sms-login/submit' && q.method === 'POST') {
    const input = JSON.parse((await readBody(q)) || '{}');
    const phone = String(input.phone || '').trim();
    const code = String(input.code || '').trim();
    if (!/^1\d{10}$/.test(phone)) { send(400, JSON.stringify({ ok: false, error: '手机号格式不正确' })); return true; }
    if (!/^\d{4,8}$/.test(code)) { send(400, JSON.stringify({ ok: false, error: '验证码格式不正确' })); return true; }
    const id = url.searchParams.get('id') || '';
    const tasks = loadTasks();
    const task = id ? tasks.find((t) => t.id === id) : null;
    if (id && !task) { send(404, JSON.stringify({ ok: false, error: '账号不存在' })); return true; }
    const provider = getProvider('autoclaw');
    if (!provider || typeof provider.submitLoginCode !== 'function') {
      send(501, JSON.stringify({ ok: false, error: '该 provider 不支持验证码登录' }));
      return true;
    }
    try {
      const target = task || { config: {} };
      const res = await provider.submitLoginCode(target, phone, code);
      if (id) {
        saveTasks(tasks);
      } else if (res.ok) {
        const cfg = target.config;
        const created = addTask({
          providerId: 'autoclaw',
          name: String(input.name || '').trim() || res.userName || phone,
          enabled: true,
          config: {
            refreshToken: cfg.refreshToken,
            token: cfg.token,
            refreshTokenExpiresAt: cfg.refreshTokenExpiresAt,
            time: String(input.time || '09:00'),
            timezone: String(input.timezone || 'Asia/Shanghai'),
            failThreshold: '3',
            notifyOnSuccess: false,
            cookieExpiryNotify: true,
            cookieExpiryNotifyDays: '3',
            creditExpiryNotify: true,
            creditExpiryNotifyDays: 3,
          },
        });
        res.taskId = created.id;
        res.taskName = created.name;
      }
      send(200, JSON.stringify(res));
    } catch (e) {
      send(200, JSON.stringify({ ok: false, error: e.message }));
    }
    return true;
  }

  return true; // 前缀命中但路由未匹配 → 404 由 module.js 兜底
}

await createModuleServer({
  name: 'checkin',
  version: VERSION,
  port: parseInt(process.env.MOD_PORT || '3083', 10),
  router,
  stopHooks: [
    () => { try { stopAllTasks(); } catch {} },   // 停签到/凭证/积分过期调度器
    () => { clearInterval(statsRefreshTimer); },   // 停 stats 定时重建
    () => startTimers.forEach(clearTimeout),       // 停启动延迟器
  ],
});
