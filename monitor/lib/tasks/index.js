/**
 * 任务调度中心。
 * 遍历 checkin_tasks.json 中已启用的任务，按各自时区/签到时间定时触发，
 * 调用对应 provider 执行签到，写日志并按规则发通知。
 * 单个任务失败不断链，凭证无效时跳过执行（等凭证更新后自动恢复）。
 */
import { randomUUID } from 'node:crypto';
import { loadJSON, saveJSON, DATA_DIR } from '../utils.js';
import { sendMail } from '../notify.js';
import { getProvider } from '../providers/index.js';
import { getMaintenanceExpiry, needsSessionProbe } from '../credential-expiry.js';
import { startScheduler, nextTriggerMs } from '../checkin/scheduler.js';
import { appendLog } from '../checkin-log.js';

const TASKS_FILE = DATA_DIR + '/checkin_tasks.json';

// 上游「操作太过频繁(9074)」保护：退避等待时长。保护窗口内自动签到跳过，
// 避免连续重试刷新窗口；手动「立即签到」仍可强制尝试。
const THROTTLE_BACKOFF_MS = 20 * 60 * 1000;

// transient（非凭证、非限流）失败的短时退避重试：先重试几次，
// 只有重试仍失败才升级为“今日签到失败”告警（消除瞬时抖动导致的“先失败再恢复”）。
const MAX_TRANSIENT_RETRY = 2;
const TRANSIENT_RETRY_DELAY_MS = 5 * 60 * 1000;
// taskId -> retry setTimeout handle（防叠加）
const retryTimers = new Map();

// taskId -> { checkin: handle }
// ★一个任务一套调度：签到（config.time）。
//   旧的「按账号积分到期提醒」调度已移除，改为 gateway 单进程的「每日日报」（lib/daily-report.js）。
const timers = new Map();

export function loadTasks() {
  return loadJSON(TASKS_FILE, []);
}
export function saveTasks(tasks) {
  saveJSON(TASKS_FILE, tasks);
}

export function getTasks() {
  return loadTasks();
}

/**
 * 该 Provider 的「可探活凭证」配置键。
 * Provider 可选声明 sessionCredentialKeys（Trae/WorkBuddy=cookie/token；CodeArts=hwidCasSid/cookies）；
 * 未声明时回落 Trae 时代的 cookie/token，保证旧行为不变。
 */
function providerCredKeys(providerId) {
  const p = getProvider(providerId);
  const keys = p && Array.isArray(p.sessionCredentialKeys) ? p.sessionCredentialKeys : ['cookie', 'token'];
  return [...new Set([...keys, 'cookie', 'token'])];
}

function todayStr(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 判断当前是否已过某任务今天的签到点（用于"当天失败必通知"） */
function isPastTodayTime(timeStr, timezone) {
  try {
    const next = nextTriggerMs(Date.now(), timeStr, timezone);
    const fmt = (ts) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
    return fmt(next) > fmt(Date.now());
  } catch {
    return false;
  }
}

/** transient 失败后安排一次性重试（同任务只保留最新一个定时器） */
function scheduleTransientRetry(task) {
  if (retryTimers.has(task.id)) clearTimeout(retryTimers.get(task.id));
  const to = setTimeout(async () => {
    retryTimers.delete(task.id);
    try {
      await executeTaskCheckin(task);
      saveTasks(getTasks().map((t) => (t.id === task.id ? task : t)));
    } catch { /* 重试内部已自行处理失败 */ }
  }, TRANSIENT_RETRY_DELAY_MS);
  if (to.unref) to.unref();
  retryTimers.set(task.id, to);
}

/** 执行一次签到 + 日志 + 通知（供定时与手动共用） */
export async function executeTaskCheckin(task) {
  const provider = getProvider(task.providerId);
  if (!provider) return { ok: false, error: `未知 provider: ${task.providerId}` };
  if (task.credentialInvalid) {
    return { ok: false, skipped: true, reason: 'credentialInvalid' };
  }

  try {
    const res = await provider.checkin(task);
    // 仅当此前确实告过警（凭证无效/连续阈值/今日失败）才发“恢复”，
    // 避免被抑制的瞬时重试失败触发多余的 [恢复] 邮件。
    const wasFailing = !!task.notifiedInvalid || !!task.notifiedThreshold || task.notifiedTodayFail === todayStr();
    task.failCount = 0;
    task.credentialInvalid = false;
    task.notifiedInvalid = false;
    task.notifiedThreshold = false;
    task.notifiedTodayFail = null;
    task.transientRetries = 0;
    task.lastResult = 'success';
    task.lastError = null;
    task.credits = res.credits;
    task.lastRun = Date.now();
    appendLog({ taskId: task.id, providerId: task.providerId, status: 'success', credits: res.credits, reward: res.reward });

    if (wasFailing) {
      await sendMail(`[恢复] ${task.name} 签到恢复`, `账号 ${task.name} 签到已恢复正常。\n积分: ${res.credits ?? '未知'}`);
    } else if (task.config.notifyOnSuccess) {
      await sendMail(`[签到] ${task.name} 签到成功`, `账号 ${task.name} 今日签到成功${res.alreadyCheckedIn ? '（今日此前已签到）' : ''}。\n积分: ${res.credits ?? '未知'}`);
    }
    res.ok = true;
    return res;
  } catch (err) {
    // 上游保护(9074 操作太过频繁)：退避等待，不记为连续失败、不告警，避免硬撞刷新窗口
    if (err.kind === 'throttle') {
      task.lastResult = 'throttle';
      task.lastError = err.message;
      task.lastRun = Date.now();
      task.throttledUntil = Date.now() + THROTTLE_BACKOFF_MS;
      appendLog({ taskId: task.id, providerId: task.providerId, status: 'throttle', error: err.message });
      saveTasks(getTasks().map((t) => (t.id === task.id ? task : t)));
      return { ok: false, error: err.message, kind: 'throttle' };
    }
    const invalid = err.kind === 'invalid';
    task.failCount = (task.failCount || 0) + 1;
    task.lastResult = 'fail';
    task.lastError = err.message;
    task.lastRun = Date.now();

    if (invalid) {
      task.credentialInvalid = true;
      task.transientRetries = 0;
      appendLog({ taskId: task.id, providerId: task.providerId, status: 'invalid', error: err.message });
      if (!task.notifiedInvalid) {
        task.notifiedInvalid = true;
        await sendMail(`[告警] ${task.name} 签到凭证无效`, `账号 ${task.name} 的凭证已失效，请更新。\n原因: ${err.message}`);
      }
    } else {
      appendLog({ taskId: task.id, providerId: task.providerId, status: 'fail', error: err.message });
      // transient / 未知失败：先退避重试，未耗尽重试预算前不发“今日签到失败”
      const retries = task.transientRetries || 0;
      if (retries < MAX_TRANSIENT_RETRY) {
        task.transientRetries = retries + 1;
        saveTasks(getTasks().map((t) => (t.id === task.id ? task : t)));
        scheduleTransientRetry(task);
        return { ok: false, error: err.message, kind: err.kind || 'transient', retrying: true, attempt: task.transientRetries };
      }
      // 重试仍失败 → 走原有“今日签到失败 / 连续阈值”告警
      const threshold = Number(task.config.failThreshold) || 3;
      const today = todayStr();
      if (isPastTodayTime(task.config.time, task.config.timezone) && task.notifiedTodayFail !== today) {
        task.notifiedTodayFail = today;
        task.transientRetries = 0;
        await sendMail(`[告警] ${task.name} 今日签到失败`, `账号 ${task.name} 今日签到失败（已重试 ${MAX_TRANSIENT_RETRY} 次仍未成功），今天可能无法再补签。\n原因: ${err.message}`);
      } else if (task.failCount >= threshold && !task.notifiedThreshold) {
        task.notifiedThreshold = true;
        task.transientRetries = 0;
        await sendMail(`[告警] ${task.name} 签到失败（连续 ${task.failCount} 次）`, `账号 ${task.name} 连续 ${task.failCount} 次签到失败。\n原因: ${err.message}`);
      }
    }
    saveTasks(getTasks().map((t) => (t.id === task.id ? task : t)));
    return { ok: false, error: err.message, kind: err.kind };
  }
}

/** 启动单个任务的定时调度（签到） */
export function startTask(task) {
  stopTask(task.id);
  if (!task.enabled || task.credentialInvalid) return;
  const checkin = startScheduler({
    timeStr: task.config.time,
    timezone: task.config.timezone,
    onTick: async () => {
      // 上游保护退避期内：跳过自动签到，等窗口过后再试
      if (task.throttledUntil && task.throttledUntil > Date.now()) return;
      await executeTaskCheckin(task);
      saveTasks(getTasks().map((t) => (t.id === task.id ? task : t)));
    },
  });
  timers.set(task.id, { checkin });
}

export function stopTask(taskId) {
  const handles = timers.get(taskId);
  if (handles) {
    for (const h of Object.values(handles)) {
      if (h && typeof h.stop === 'function') { try { h.stop(); } catch {} }
    }
    timers.delete(taskId);
  }
}

/** 启动全部启用任务 */
export function startAllTasks() {
  for (const task of getTasks()) startTask(task);
}

/** 停止全部 */
export function stopAllTasks() {
  for (const id of [...timers.keys()]) stopTask(id);
}

/** 增删改后重载调度 */
export function resyncTask(task) {
  startTask(task);
}

// ====== CRUD ======
export function addTask(input) {
  const tasks = getTasks();
  const task = {
    id: randomUUID(),
    providerId: input.providerId,
    name: input.name || '未命名',
    config: input.config || {},
    enabled: input.enabled !== false,
    createdAt: Date.now(),
    failCount: 0,
    credentialInvalid: false,
    lastResult: null,
    lastError: null,
    credits: null,
    totalCredits: null,
    lastRun: null,
    todayCheckedIn: null,
    lastStatusCheck: null,
    cookieExpiresAt: null,
    cookieProbedAt: 0,
    notifiedCookieExpiry: null,
    ...(input.tokenExpiredAt ? { tokenExpiredAt: input.tokenExpiredAt } : {}),
    ...(input.refreshTokenExpiredAt ? { refreshTokenExpiredAt: input.refreshTokenExpiredAt } : {}),
  };
  tasks.push(task);
  saveTasks(tasks);
  startTask(task);
  return task;
}

export function updateTask(id, patch) {
  const tasks = getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  if (patch.name !== undefined) task.name = patch.name;
  if (patch.config !== undefined) Object.assign(task.config, patch.config);
  if (patch.enabled !== undefined) task.enabled = patch.enabled;
  // 凭证更新后重置无效/失败状态，让任务自动恢复
  // 凭证键按 Provider 声明取（Trae/WorkBuddy=cookie/token；CodeArts=hwidCasSid/cookies），
  // 否则改了 CodeArts 的 hwid_cas_sid 也不会解除 credentialInvalid，任务会被一直跳过。
  if (patch.config && providerCredKeys(task.providerId).some((k) => patch.config[k] !== undefined)) {
    task.credentialInvalid = false;
    task.failCount = 0;
    task.notifiedInvalid = false;
    task.notifiedThreshold = false;
  }
  // Cookie 换新后重置到期监控状态，触发立即重新探测并重新武装通知
  if (patch.config && patch.config.cookie !== undefined) {
    task.cookieExpiresAt = null;
    task.cookieProbedAt = 0;
    task.notifiedCookieExpiry = null;
    // 关键修复：清除缓存的新旧 JWT 与到期时间。
    // 否则 resolveToken 会因旧 token 仍在 8h 有效期内而直接复用，忽略新 Cookie，
    // 导致编辑改 Cookie 后所有接口仍走旧账号凭证（表现为“测试凭证失效”）。
    // 清空后下一次调用必走 getUserToken() 用新 Cookie 换取全新 token。
    delete task.config.token;
    task.tokenExpiredAt = null;
    task.credentialInvalid = false;
  }
  // ★方案一凭证（refreshToken）换新后同理：必须清掉缓存 JWT。
  //   否则 resolveToken 第一步「现成 token 没临期就直接用」会命中旧 token，
  //   新导入的凭证要等旧 token 过期才生效 —— 表现为「导入后测试凭证仍报旧错误」。
  //   ★例外：若本次 patch 自己就带了新 token（导入串常带脚本刚换到的 access token），
  //     那就用新的、别清 —— 这样首次使用无需立刻续期，少推进一代 refreshToken 轮换链。
  if (patch.config && patch.config.refreshToken !== undefined && patch.config.token === undefined) {
    delete task.config.token;
    task.tokenExpiredAt = null;
    task.credentialInvalid = false;
    task.failCount = 0;
  }
  if (patch.tokenExpiredAt !== undefined) task.tokenExpiredAt = patch.tokenExpiredAt;
  if (patch.refreshTokenExpiredAt !== undefined) task.refreshTokenExpiredAt = patch.refreshTokenExpiredAt;
  saveTasks(tasks);
  resyncTask(task);
  return task;
}

export function deleteTask(id) {
  stopTask(id);
  const tasks = getTasks();
  const next = tasks.filter((t) => t.id !== id);
  saveTasks(next);
  return next.length !== tasks.length;
}

export async function runTaskNow(id) {
  const task = getTasks().find((t) => t.id === id);
  if (!task) return { ok: false, error: '任务不存在' };
  const res = await executeTaskCheckin(task);
  saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
  return res;
}

export async function runAllNow() {
  const results = [];
  for (const task of getTasks()) {
    if (!task.enabled) continue;
    if (task.throttledUntil && task.throttledUntil > Date.now()) {
      results.push({ id: task.id, name: task.name, skipped: true, reason: 'throttle' });
      continue;
    }
    const res = await executeTaskCheckin(task);
    saveTasks(getTasks().map((t) => (t.id === task.id ? task : t)));
    results.push({ id: task.id, name: task.name, ...res });
  }
  return results;
}

export async function testCredential(id) {
  const task = getTasks().find((t) => t.id === id);
  if (!task) return { ok: false, error: '任务不存在' };
  const provider = getProvider(task.providerId);
  // 测试凭证：直接获取总积分。能取到即凭证有效，同时刷新积分缓存。
  const testFn = (provider && provider.getTotalCredits) ? provider.getTotalCredits.bind(provider) : (provider ? provider.checkCredential.bind(provider) : null);
  if (!testFn) return { ok: false, error: '该 provider 不支持凭证测试' };
  try {
    const res = await testFn(task);
    if (res.ok !== false && typeof res.total === 'number') {
      task.totalCredits = res.total;
      saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
      return { ok: true, total: res.total, valid: true };
    }
    return { ok: res.ok !== false, ...res };
  } catch (err) {
    // provider 可能已用 Cookie 刷新了 token，失败也要落盘
    saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
    return { ok: false, error: err.message, kind: err.kind };
  }
}

export async function getCredits(id) {
  const task = getTasks().find((t) => t.id === id);
  if (!task) return { ok: false, error: '任务不存在' };
  const provider = getProvider(task.providerId);
  if (!provider || !provider.getCredits) return { ok: false, error: '该 provider 不支持查询积分' };
  try {
    const res = await provider.getCredits(task);
    task.credits = res.credits;
    saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
    return res;
  } catch (err) {
    saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
    return { ok: false, error: err.message, kind: err.kind };
  }
}

/** 查询今日签到状态（不领取），更新 todayCheckedIn / credits */
export async function checkStatusForTask(id) {
  const task = getTasks().find((t) => t.id === id);
  if (!task) return { ok: false, error: '任务不存在' };
  const provider = getProvider(task.providerId);
  if (!provider || !provider.checkStatus) return { ok: false, error: '该 provider 不支持查询状态' };
  try {
    const res = await provider.checkStatus(task);
    task.todayCheckedIn = res.checked_in;
    task.credits = res.credits;
    task.lastStatusCheck = Date.now();
    if (res.checked_in) task.lastResult = 'success';
    saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
    return { ok: true, ...res };
  } catch (err) {
    saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
    return { ok: false, error: err.message, kind: err.kind };
  }
}

/** 查询账户总可用积分（所有权益包剩余之和），并把返回的历史签到日期同步进签到日志 */
export async function getTotalCreditsForTask(id) {
  const task = getTasks().find((t) => t.id === id);
  if (!task) return { ok: false, error: '任务不存在' };
  const provider = getProvider(task.providerId);
  if (!provider || !provider.getTotalCredits) return { ok: false, error: '该 provider 不支持查询总积分' };
  try {
    const res = await provider.getTotalCredits(task);
    task.totalCredits = res.total;
    saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
    // 把上游返回的历史签到日期（checkins）回填到 30 天签到日志
    if (Array.isArray(res.checkins)) {
      let appended = 0;
      for (const c of res.checkins) {
        if (!c.date) continue;
        appendLog({ taskId: id, providerId: task.providerId, date: c.date, status: 'success', credits: c.credits ?? null, reward: null, error: null, ts: Date.parse(c.date) || Date.now() });
        appended++;
      }
      if (appended) res.syncedLogs = appended;
    }
    return res;
  } catch (err) {
    saveTasks(getTasks().map((t) => (t.id === id ? task : t)));
    return { ok: false, error: err.message, kind: err.kind };
  }
}

/** 对所有启用账号执行"今日首次检测"：当天已检/已签则跳过，否则检测一次。
 *  ★并发版：旧版逐账号串行 await，每个远端探活 5~8s 超时，N 账号就是 N 倍耗时。
 *  现在小并发(3)执行；同时在途请求共享一次检测（单飞），结果顺序与账号顺序一致。 */
const AUTO_CHECK_CONCURRENCY = 3;
let autoCheckInflight = null;

export function autoCheckToday() {
  if (autoCheckInflight) return autoCheckInflight;
  autoCheckInflight = runAutoCheck().finally(() => { autoCheckInflight = null; });
  return autoCheckInflight;
}

async function runAutoCheck() {
  const tasks = getTasks();
  const today = todayStr();
  const results = new Array(tasks.length);
  const pendingIdx = [];
  tasks.forEach((task, i) => {
    if (!task.enabled || task.credentialInvalid) {
      results[i] = { id: task.id, name: task.name, skipped: true, reason: 'disabled_or_invalid' };
      return;
    }
    // 当天已检测过或已签到，跳过
    if (task.lastStatusCheck && todayStr(task.lastStatusCheck) === today) {
      results[i] = { id: task.id, name: task.name, skipped: true, reason: 'already_checked_today' };
      return;
    }
    if (task.todayCheckedIn === true) {
      results[i] = { id: task.id, name: task.name, skipped: true, reason: 'already_signed_in' };
      return;
    }
    pendingIdx.push(i);
  });
  let cursor = 0;
  async function worker() {
    while (cursor < pendingIdx.length) {
      const i = pendingIdx[cursor++];
      const task = tasks[i];
      try {
        const res = await checkStatusForTask(task.id);
        results[i] = { id: task.id, name: task.name, ...res };
      } catch (e) {
        // 单账号异常不拖垮整批（原本未捕获时整个 auto-check 会 500）
        results[i] = { id: task.id, name: task.name, ok: false, error: e.message || String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(AUTO_CHECK_CONCURRENCY, pendingIdx.length) }, () => worker()));
  return results.filter(Boolean);
}

// ====== 凭证维护日监控（旧名「Cookie 到期监控」）======
// 每小时巡检一次启用任务：会话有效期缓存超过 24h（或无缓存）时重探；
// ★提醒基准 = 「维护链终点」（lib/credential-expiry.js，与面板卡片同一口径），
//   不再是 cookieExpiresAt 这个探活槽 —— 否则 Trae 方案一（应看 RT）、
//   WorkBuddy（应看最后一次换票后的 Bearer）都会提醒错对象。
//   终点未知/无固定维护日 → 不提（避开旧版那类假告警），到日由探活失败走「凭证已失效」。

const COOKIE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 巡检间隔：1 小时
const COOKIE_PROBE_TTL_MS = 24 * 60 * 60 * 1000; // 探测结果有效期：24 小时

function fmtBeijing(ts) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ts)) + '（北京时间）';
  } catch {
    return new Date(ts).toISOString();
  }
}

export function persistTask(task) {
  saveTasks(getTasks().map((t) => (t.id === task.id ? task : t)));
}

async function checkCookieExpiryOnce() {
  const today = todayStr();
  for (const task of getTasks()) {
    if (!task.enabled || !task.config) continue;
    if (task.config.cookieExpiryNotify === false) continue;
    // 已判凭证失效：签到已暂停，不再探测、不再每日重发「凭证已失效」邮件
    //   （失效账号由日报③「凭证无效（暂停签到）」与日报⑦告警汇总承担）
    if (task.credentialInvalid) continue;
    // ★方案一（refreshToken）不再整段跳过：以前因为拿 cookieExpiresAt 当基准而直接跳过，
    //   导致 180 天的 refreshToken 到期前一封提醒都没有。现在按维护链终点算：
    //   终点已知 → 提前 N 天提醒；终点未知（还未首次续期）→ 自然不提。
    const provider = getProvider(task.providerId);
    if (!provider || typeof provider.probeSession !== 'function') continue;
    // 该 provider 有哪些「可探活凭证」配置键（见 providerCredKeys）
    if (!providerCredKeys(task.providerId).some((k) => task.config[k])) continue;

    // 探测会话有效性（CodeArts 业务 cookie 为会话态、hwid_cas_sid 为长期令牌，
    //   probeSession 恒返回 expiresAt:null —— 只能靠 isLogin 判定有效与否）
    // ★命中档声明了 probe:false（如 Trae 方案一，到期值由续期自己写）→ 不跑探活，
    //   既避开旧版「拿兜底 Cookie 误报失效」，也少一次无网络意义的会话探测。
    if (!needsSessionProbe(task)) {
      const maintExp0 = getMaintenanceExpiry(task);
      if (maintExp0 !== task.maintenanceExpiresAt) {
        task.maintenanceExpiresAt = maintExp0 || null;
        persistTask(task);
      }
      continue;
    }
    if (!task.cookieExpiresAt || Date.now() - (task.cookieProbedAt || 0) > COOKIE_PROBE_TTL_MS) {
      try {
        const r = await provider.probeSession(task);
        if (r.isLogin) {
          // 凭证有效：有明确到期时间就更新，没有（CodeArts 恒 null）就清除旧值，
          //   避免之前误判写入的 cookieExpiresAt 残留 → 每天重复发"凭证已失效"邮件
          task.cookieExpiresAt = r.expiresAt || null;
        } else {
          // 凭证已确认失效：视为立即到期（当天走一封通知）并暂停后续签到，不再每日重试
          task.cookieExpiresAt = Date.now();
          task.credentialInvalid = true;
          task.failCount = task.failCount || 0;
        }
        task.cookieProbedAt = Date.now();
        persistTask(task);
      } catch (err) {
        if (err.kind === 'invalid') {
          // 凭证已被服务端拒绝：视为已到期并暂停签到（当天走一封通知）
          task.cookieExpiresAt = Date.now();
          task.credentialInvalid = true;
          task.cookieProbedAt = Date.now();
          persistTask(task);
        }
        // 网络等临时失败：静默跳过，沿用旧缓存
      }
    }

    // ★落盘的值只取「维护链终点」（与卡片/日报同一个函数），**不拿 cookieExpiresAt 凑数**：
    //   OfficeAce / CodeArts 这类「有账号密码自动重登」的档根本不该有维护日，
    //   回落探活槽会把旧值（如 RT 到期）长期挂回卡片上。
    const ladderExp = getMaintenanceExpiry(task);
    if (ladderExp !== (task.maintenanceExpiresAt || null)) {
      task.maintenanceExpiresAt = ladderExp || null;   // 落盘，供日报直接读
      persistTask(task);
    }
    // 提醒基准：阶梯有值用阶梯；provider 没声明阶梯的老任务回落到探活槽；
    // 命中了阶梯但该类无到期值（fields:[]）= 确实没有维护日 → 不发临期提醒。
    const hasLadder = !!(getProvider(task.providerId) || {}).credDisplay;
    const maintExp = ladderExp || (hasLadder ? null : task.cookieExpiresAt);
    if (!maintExp) continue;
    const daysLeft = Math.ceil((maintExp - Date.now()) / 86400000);
    const threshold = Number(task.config.cookieExpiryNotifyDays) || 1;
    if (daysLeft > threshold || task.notifiedCookieExpiry === today) continue;

    task.notifiedCookieExpiry = today;
    persistTask(task);
    const expStr = fmtBeijing(maintExp);
    const platName = (getProvider(task.providerId) || {}).name || '账号';
    if (daysLeft <= 0) {
      await sendMail(
        `[告警] ${task.name} 凭证已失效`,
        `账号 ${task.name} 的 ${platName} 凭证维护日已到（${expStr}），自动签到将无法进行。\n` +
        `请重新登录后导出新的凭证，并在签到页编辑该账号更新。`
      );
    } else {
      await sendMail(
        `[提醒] ${task.name} 凭证将于 ${daysLeft} 天后到期`,
        `账号 ${task.name} 的 ${platName} 需维护日期：${expStr}，剩余约 ${daysLeft} 天。\n` +
        `这是自动续期链能撑到的最后一天（面板卡片显的就是同一个日子），到期后签到将失败。\n` +
        `请在此日期前重新导出/换发凭证并更新账号配置。\n\n如不想收到此提醒，可在账号编辑页关闭「凭证到期提前邮件通知」。`
      );
    }
  }
}

/** 启动 Cookie 到期监控（server.js 启动时调用一次） */
export function startCookieExpiryWatcher() {
  const run = () => { checkCookieExpiryOnce().catch(() => {}); };
  setTimeout(run, 30 * 1000); // 启动 30 秒后先跑一次
  setInterval(run, COOKIE_CHECK_INTERVAL_MS);
}