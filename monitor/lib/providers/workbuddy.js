/**
 * WorkBuddy（成长中心）Provider —— 每日签到 + 档位领奖。
 *
 * 与 Trae Provider 1:1 同构（configSchema / checkin / getCredits / checkCredential /
 * checkStatus / getTotalCredits / probeSession），差异只在域名、鉴权形态与端点。
 *
 * 端点（依据 checkin平台全流程方案.md §2.2 / §7，均为实测确认）：
 *   POST /v2/billing/meter/daily-checkin            每日签到打卡（空请求体；code:10001 = 今日已签）
 *   POST /v2/billing/meter/checkin-activity-status  签到活动全量状态（今日已签 / 累计天数 / 累计积分）
 *   GET  /activity/growth/streak                    连续签到（严格连续，断签归零）
 *   GET  /activity/growth/energy                    能量余额
 *   GET  /activity/growth/heatmap                   打卡日历
 *   POST /activity/growth/redeem{tier,client_token} 领取 7d/14d/28d 档位奖励（与每日签到是两个动作）
 *
 * 鉴权三形态（同一后端，返回体逐字段一致）：
 *   auto   : ★Cookie 自动换取 Bearer（推荐）—— 只需填 Cookie，服务端自动换出 60 天 Bearer
 *   web    : Cookie  —— ★必须同时携带 session + session_2，缺一即 401
 *   bearer : Authorization: Bearer <Keycloak JWT>（实测约 60 天，手填）
 *
 * ★★cookie → Bearer 换票链路（2026-09-10 依据 workbuddy5 抓包 + 实测确认，用户无需再抓包）：
 *   ① POST https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy   （完全无需鉴权）
 *        → { data: { state, authUrl } }
 *   ② POST https://www.workbuddy.cn/console/login/enterprise?state=<state>       （带站点 Cookie）
 *        → { data: { accessToken, expiresIn:5184000, refreshToken, refreshExpiresIn:7776000, tokenType } }
 *   实测要点：
 *     a) 最小凭证 = Cookie 里的 session + session_2 两项；只有一项 → 401。
 *     b) 站点会话**绑定登录时的 User-Agent**：换一个同样合法的完整 Chrome UA 也 401，
 *        必须用登录浏览器那一个（与业务请求的 UA 校验是同一套网关策略）。
 *     c) 可重复换票（非一次性），但**有速率限制**：短时间连续换 8 次左右开始 401，
 *        等 45~60 秒即恢复 ⇒ 因此换出的 token 必须缓存，只在临期时才再换。
 *     d) refreshToken 暂不可用：标准 Keycloak 端点
 *        POST https://copilot.tencent.com/auth/realms/copilot/protocol/openid-connect/token
 *        （grant_type=refresh_token / client_id=console）返回 401 unauthorized_client
 *        （client_id=account-console 则报 invalid_grant「Token client and authorized client don't match」），
 *        ⇒ 续期只能靠「Cookie 再换一次」，故 Cookie 才是需要人工维护的凭证。
 *     e) 换出的 Bearer 在 www.workbuddy.cn 与 copilot.tencent.com 上均可直接使用（实测均 200）。
 *
 * ★关键坑（务必保留，否则会把会话自己搞失效）：
 *   1) WorkBuddy 几乎所有 growth/billing 响应都会回 `set-cookie: session=; Max-Age=0` 主动清 session。
 *      请求里携带的才是有效 session —— 本实现**只读取配置里的凭证，绝不接受响应 cookie 覆盖**。
 *   2) ★★ APISIX 前置网关会校验 User-Agent：同一份 cookie，
 *      UA 用 `Chrome/151…Edg/151` → 全部 HTTP 401；换成登录浏览器的 `Chrome/152…Edg/152` → 全部 200。
 *      实测（2026-09-10）：旧抓包 cookie 配抓包 UA 至今仍 200，证明当时判定的「会话已被吊销」其实是 UA 不匹配。
 *      ⇒ UA 必须可配置，且默认值取抓包/登录浏览器的真实 UA。
 */
import { randomUUID } from 'node:crypto';

const BASES = {
  web: 'https://www.workbuddy.cn',
  bearer: 'https://copilot.tencent.com',
};

// ★注意路径前缀不统一（实测 2026-09-10）：
//   /v2/billing/meter/*   → 签到活动类（daily-checkin / checkin-activity-status）
//   /billing/meter/*      → 计费资源类（get-user-resource-summary / get-user-request-usage）
//   给后者加 v1/v2 前缀会直接 404 Route Not Found。
const ENDPOINTS = {
  dailyCheckin: '/v2/billing/meter/daily-checkin',
  checkinStatus: '/v2/billing/meter/checkin-activity-status',
  resourceSummary: '/billing/meter/get-user-resource-summary',
  requestUsage: '/billing/meter/get-user-request-usage',
  freePackages: '/billing/meter/get-user-resource-free-packages',
  paidPackages: '/billing/meter/get-user-resource-paid-packages',
  compensationStatus: '/billing/meter/compensation-status',
  giftClaimed: '/billing/meter/check-gift-claimed',
  streak: '/activity/growth/streak',
  heatmap: '/activity/growth/heatmap',
  energy: '/activity/growth/energy',
  redeem: '/activity/growth/redeem',
  redeemSummary: '/activity/growth/redeem/summary',
  profile: '/v2/activity/growth/profile',
};

// ★实测：APISIX 会校验 UA。此默认值取自真实登录浏览器（workbuddy3 抓包，2026-09-10）；
// 用 Chrome/151 之类旧 UA 会被网关直接 401（与 cookie 是否有效无关）。
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

function uaOf(task) {
  const ua = task.config && task.config.userAgent;
  return (ua && String(ua).trim()) || DEFAULT_UA;
}

// ============ Cookie → Bearer 换票（见文件头 ★★） ============
const EXCHANGE = {
  // ① 申请 state：无鉴权的公开端点（注意在 copilot 域）
  stateUrl: 'https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy',
  // ② 用站点 Cookie 换票：★必须打 www.workbuddy.cn（Cookie 属于该域，发到 copilot 必 401）
  loginUrl: 'https://www.workbuddy.cn/console/login/enterprise',
};

// 换出的 Bearer 剩余有效期低于该阈值时才重新换票（默认 6 小时）。
// ★换票有速率限制（见文件头 c），必须尽量少换，故阈值取大。
const TOKEN_MIN_REMAINING_MS = 6 * 60 * 60 * 1000;

// 换票失败后的冷却（模块级，不入 tasks JSON）：避免同一轮签到里每个请求都去撞限流
const exchangeCooldown = new Map(); // taskId -> untilMs
const EXCHANGE_COOLDOWN_MS = 60 * 1000;

// 三个平台共用的表单常量与「积分过期提醒」配置片段
import { TIMEZONES, TIMES, THRESHOLDS, EXPIRY_DAYS } from './common.js';

/** 鉴权形态：显式声明优先；否则按「有 cookie 走 web，否则走 bearer」推断（保持旧任务行为不变） */
function authMode(task) {
  const c = task.config || {};
  if (c.authMode === 'bearer' || c.authMode === 'web' || c.authMode === 'auto') return c.authMode;
  return c.cookie ? 'web' : 'bearer';
}

/** 业务请求的基础域：bearer 两域皆可（尊重用户配置），web 只能是 www（Cookie 属于该域） */
function baseUrlOf(task, resolvedMode) {
  const cfg = String((task.config && task.config.baseUrl) || '').trim().replace(/\/$/, '');
  if (resolvedMode === 'bearer') {
    // ★实测：www.workbuddy.cn 与 copilot.tencent.com 都接受 Bearer 且返回逐字段一致
    return cfg || BASES.bearer;
  }
  return BASES.web;
}

function cookieOf(task) {
  return String((task.config && task.config.cookie) || '').trim();
}
function tokenOf(task) {
  return String((task.config && task.config.token) || '').trim();
}

/** 宽松 JSON 解析（上游失败时会回 HTML 错误页） */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * ★用站点 Cookie 换取 Bearer accessToken（详见文件头 ★★ 换票链路）。
 * 成功后写回 task.config.token / task.tokenExpiredAt（由调用方持久化）。
 *
 * @returns {Promise<string>} accessToken
 */
async function exchangeTokenFromCookie(task) {
  const cookie = cookieOf(task);
  if (!cookie) throw credError('未配置 Cookie，无法换取 Bearer Token');
  const ua = uaOf(task);       // ★必须是登录浏览器的 UA，否则网关 401
  const timeout = Number(task.config && task.config.timeout) || 25000;

  // ① 申请 state（无鉴权）
  const stRes = await httpJson(EXCHANGE.stateUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-domain': 'copilot.tencent.com',
      'x-no-authorization': 'true',
      'x-no-user-id': 'true',
      'x-no-enterprise-id': 'true',
      'x-no-department-info': 'true',
      'x-product': 'SaaS',
      'user-agent': ua,
    },
    body: '{}',
  }, timeout);
  const stJson = safeJson(stRes.text);
  const state = stJson && stJson.data && stJson.data.state;
  if (!state) {
    const e = new Error(`申请换票 state 失败（HTTP ${stRes.status}）`);
    e.kind = stRes.status >= 500 ? 'transient' : 'invalid';
    throw e;
  }

  // ② 带站点 Cookie 换票
  const exRes = await httpJson(`${EXCHANGE.loginUrl}?state=${encodeURIComponent(state)}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'x-domain': 'www.workbuddy.cn',
      'x-product-code': 'workbuddy',
      origin: 'https://www.workbuddy.cn',
      referer: `https://www.workbuddy.cn/login/?platform=workbuddy&state=${state}&version=5.5.3`,
      'user-agent': ua,
      cookie,
    },
  }, timeout);

  const exJson = safeJson(exRes.text);
  const d = exJson && exJson.data;
  if (!d || !d.accessToken) {
    // ★HTTP 401 的三种成因（实测均表现为 401 + HTML 错误页），提示里逐一列出便于用户自查
    const e = new Error(exRes.status === 401
      ? 'Cookie 换 Bearer 被拒（HTTP 401）：请检查 ①「User-Agent」是否与登录浏览器完全一致；'
        + '② Cookie 是否同时含 session 与 session_2；③ 是否换票过频（等待约 1 分钟后自动恢复）。'
      : `Cookie 换 Bearer 失败（HTTP ${exRes.status}）：${String(exRes.text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    e.kind = exRes.status === 401 ? 'invalid' : 'transient';
    throw e;
  }

  task.config.token = d.accessToken;
  const expiresInSec = Number(d.expiresIn);
  task.tokenExpiredAt = expiresInSec > 0 ? Date.now() + expiresInSec * 1000 : jwtExp(d.accessToken);
  return d.accessToken;
}

/**
 * 解析本次请求实际使用的凭证形态（Trae `resolveToken` 同构）。
 *
 *   auto   ：有 Cookie → 换 Bearer 后用 Bearer；换取失败则本轮回落到 Cookie 直连（不中断签到）
 *   web    ：始终 Cookie 直连
 *   bearer ：始终手填 token
 *
 * @returns {Promise<{mode:'web'|'bearer', cred:string, exchanged?:boolean, fallback?:Error}>}
 */
async function resolveCredential(task) {
  const mode = authMode(task);
  const cookie = cookieOf(task);
  const token = tokenOf(task);

  if (mode === 'web') {
    if (!cookie) throw credError('未配置 Cookie（需 session + session_2 成对）');
    return { mode: 'web', cred: cookie };
  }
  if (mode === 'bearer') {
    if (!token) throw credError('未配置 Bearer Token（桌面端凭证）');
    return { mode: 'bearer', cred: token };
  }

  // ---- auto ----
  if (!cookie) {
    if (!token) throw credError('未配置 Cookie（用于换取 Bearer）或 Bearer Token');
    return { mode: 'bearer', cred: token };   // 只填了 token 时按 bearer 用
  }
  const remaining = (task.tokenExpiredAt || jwtExp(token) || 0) - Date.now();
  if (token && remaining > TOKEN_MIN_REMAINING_MS) return { mode: 'bearer', cred: token };

  const blockedUntil = exchangeCooldown.get(task.id) || 0;
  if (Date.now() < blockedUntil) {
    const e = new Error('换票处于冷却期（此前刚被限流）');
    e.kind = 'transient';
    if (token) return { mode: 'bearer', cred: token };
    return { mode: 'web', cred: cookie, fallback: e };
  }

  try {
    const fresh = await exchangeTokenFromCookie(task);
    exchangeCooldown.delete(task.id);
    return { mode: 'bearer', cred: fresh, exchanged: true };
  } catch (err) {
    exchangeCooldown.set(task.id, Date.now() + EXCHANGE_COOLDOWN_MS);
    // 旧 token 还在有效期内则继续用；否则回落到 Cookie 直连（auto 模式的兜底）
    if (token && jwtExp(token) > Date.now()) return { mode: 'bearer', cred: token, fallback: err };
    return { mode: 'web', cred: cookie, fallback: err };
  }
}

/** 统一响应信封：{ ok, code, message, requestId, data, raw, status } */
function envelope(res) {
  let json = null;
  try { json = JSON.parse(res.text); } catch { json = null; }
  if (!json || typeof json !== 'object') {
    return {
      ok: false, code: null, status: res.status, requestId: null, data: null,
      message: res.status === 401 ? '登录态失效（HTTP 401）' : `HTTP ${res.status}`,
      raw: String(res.text || '').slice(0, 200),
    };
  }
  const code = json.code !== undefined ? json.code : json.Code;
  return {
    ok: code === 0,
    code: code === undefined ? null : code,
    status: res.status,
    message: json.msg || json.message || '',
    requestId: json.requestId,
    data: json.data !== undefined ? json.data : null,
    raw: json,
  };
}

/** 归一化错误：会话失效 → invalid（触发重新配置），其余 → transient */
function classify(r) {
  const code = r && r.code;
  const msg = (r && r.message) || '请求失败';
  const e = new Error(code !== null && code !== undefined ? `${msg}（code ${code}）` : msg);
  const invalid =
    (r && (r.status === 401 || r.status === 403))
    || code === 20310 || code === 20311 || code === 401
    || /登录态失效|未登录|未授权|unauthorized|invalid|expired|会话/i.test(msg);
  e.kind = invalid ? 'invalid' : 'transient';
  e.code = code;
  return e;
}

/** 凭证缺失/形态不符的错误（属配置问题，按 invalid 提示用户去改） */
function credError(msg) {
  const e = new Error(msg);
  e.kind = 'invalid';
  return e;
}

async function httpJson(url, opts, timeoutMs = 25000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, redirect: 'manual' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 发一个业务请求（★不回写任何响应 cookie）
 * @param {object} [opts] { referer } —— 上游按 referer 区分页面来源（growth-center / plans-usage）
 */
async function request(task, method, path, body, opts = {}) {
  const rc = await resolveCredential(task);
  const base = baseUrlOf(task, rc.mode).replace(/\/$/, '');

  const headers = { accept: 'application/json', 'user-agent': uaOf(task) };
  if (rc.mode === 'bearer') {
    headers.authorization = `Bearer ${String(rc.cred).replace(/^Bearer\s+/i, '')}`;
  } else {
    headers.cookie = rc.cred;
    headers['x-client-platform'] = 'web';
    headers['x-requested-with'] = 'XMLHttpRequest';
    headers.referer = `${base}${opts.referer || '/profile/growth-center'}`;
  }
  const opts2 = { method, headers };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    opts2.body = JSON.stringify(body ?? {});
  }

  let res;
  try {
    res = await httpJson(`${base}${path}`, opts2, Number(task.config && task.config.timeout) || 25000);
  } catch (err) {
    const e = new Error(`网络请求失败：${err && err.message ? err.message : err}`);
    e.kind = 'transient';
    throw e;
  }
  return envelope(res);
}

/** 解析 JWT 的 exp（bearer 模式） */
function jwtExp(token) {
  try {
    const seg = String(token || '').replace(/^Bearer\s+/i, '').split('.')[1];
    if (!seg) return null;
    const payload = JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

async function fetchStatus(task) {
  const r = await request(task, 'POST', ENDPOINTS.checkinStatus, {});
  if (!r.ok) throw classify(r);
  const d = r.data || {};
  return {
    ok: true,
    active: !!d.active,
    checkedInToday: !!d.today_checked_in,
    streakDays: d.streak_days ?? null,          // 活动期累计签到天数
    totalCredits: d.total_credits ?? null,      // 活动累计积分
    dailyCredit: d.daily_credit ?? null,
    todayCredit: d.today_credit ?? null,
    isStreakDay: !!d.is_streak_day,
    checkinDates: d.checkin_dates || [],
    // 签到记录（date → 当日发放积分）。上游只给日期数组 + 统一的 daily_credit，
    // 这里按活动规则折算成 {date, credits}，供「预估可用天数」扣减签到所得。
    checkinRecords: (d.checkin_dates || []).map((date) => ({ date, credits: d.daily_credit ?? 0 })),
    weekCheckinDays: d.week_checkin_days ?? null,
    weekProgress: d.week_progress || [],
    nextStreakDay: d.next_streak_day ?? null,
    streakBonusDays: d.streak_bonus_days ?? null,
    streakBonusCredit: d.streak_bonus_credit ?? null,
    activityName: d.activity_name ?? null,
    season: d.season ?? null,
    themeName: d.theme_name ?? null,
    startTime: d.start_time ?? null,
    endTime: d.end_time ?? null,
    claimButtonText: d.claim_button_text ?? null,
    actionButton: d.action_button ?? null,
  };
}

/**
 * 账户真实可用积分（★这才是面板主展示值）。
 *
 * 端点：POST /billing/meter/get-user-resource-summary
 * 返回：data.Packages[] = [{ PackageCode, CycleTotalCapacity, CycleRemainCapacity,
 *                            CycleUsedCapacity, CycleFrozenCapacity, CapacityUnit }]
 * 总可用 = Σ CycleRemainCapacity（实测 2026-09-10：TCACA_code_007 剩 1722.11/总 6400，
 *          code_008 剩 0/总 500 ⇒ 1722.11）。
 *
 * ★为什么不用 checkin-activity-status.total_credits：
 *   那个字段是「签到活动累计发放积分」（实测仅 200/300 量级），与账户可用余额无关；
 *   用户反馈的「只显示 300 分而不是 1700 分左右」就是这个字段用错了。
 *   ⇒ total_credits 保留为 activityCredits（活动累计），余额一律走本接口。
 */
async function fetchBalance(task) {
  const r = await request(task, 'POST', ENDPOINTS.resourceSummary, {});
  if (!r.ok) throw classify(r);
  const raw = r.data || {};
  const list = Array.isArray(raw.Packages) ? raw.Packages : [];
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const packs = list.map((p) => ({
    code: p.PackageCode || '',
    total: num(p.CycleTotalCapacity),
    remain: num(p.CycleRemainCapacity),
    used: num(p.CycleUsedCapacity),
    frozen: num(p.CycleFrozenCapacity),
    unit: p.CapacityUnit || 'credits',
  }));
  const sum = (k) => packs.reduce((a, p) => a + p[k], 0);
  return {
    ok: true,
    total: sum('remain'),        // ★账户可用积分
    capacity: sum('total'),      // 本周期总配额
    used: sum('used'),
    packs,
    isPaidUser: !!raw.IsPaidUser,
    protectedPrice: !!raw.IsProtectedPriceUser,
  };
}

/** 毫秒时间戳 → 「YYYY-MM-DD HH:mm:ss」（Asia/Shanghai）—— ★上游要求这个字面格式 */
function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  // 用 Asia/Shanghai 的日历字段（en-CA → YYYY-MM-DD）
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  const t = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return `${day} ${t}`;
}
/** 「YYYY-MM-DD HH:mm:ss」(Asia/Shanghai) → epoch 秒 */
function parseDateTime(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000) - 8 * 3600;
}

/**
 * 该接口的保留窗口：★实测只保留近 30 天。
 *   2026-09-10 实测（同一 cookie、同一账号）：
 *     start=2026-09-01, end=2026-09-09 → total=101（有数据）
 *     start=2026-08-01, end=2026-09-09 → total=0   （无数据，且 HTTP 200 / code 0，不报错）
 *     start=2026-06-01, end=2026-09-09 → total=0
 *   ⇒ 起点早于窗口会**静默返回空列表**，调用方极易误判为「该账号无消耗」。
 *     因此这里把起点收敛到近 30 天（更早的数据上游本就不提供，收敛不丢信息）。
 */
const MAX_LOOKBACK_DAYS = 30;

/**
 * 逐条请求消耗（★真实远端接口，面板「积分消耗明细」与逐日统计的数据来源）。
 *
 * 端点：POST /billing/meter/get-user-request-usage
 * 参数：{ startTime, endTime, pageNum, pageSize }
 *   ★★ startTime/endTime 必须是「YYYY-MM-DD HH:mm:ss」字符串（Asia/Shanghai）！
 *      传 epoch 毫秒（数字或数字字符串）→ code 10001「cannot unmarshal number … of type string」；
 *      传 pageNumber/PageSize 这类键名 → 静默返回 total:0 空列表（不报错，极易误判为「无数据」）。
 *   ★ 起点超过 30 天前 → 同样静默返回空列表（见 MAX_LOOKBACK_DAYS）。
 * 返回：data = { total, data: [{ requestId, credit, model, client, requestTime, inputTrunc, input, agentPurpose }] }
 *
 * @returns {Promise<{total:number, items:Array}>}
 */
async function fetchUsage(task, { startMs, endMs, pageNum = 1, pageSize = 100 } = {}) {
  const lookback = MAX_LOOKBACK_DAYS * 86400000;
  const from = Math.max(Number(startMs) || 0, Date.now() - lookback);
  const to = Number(endMs) || Date.now();
  if (!(from <= to)) return { total: 0, items: [] };   // 查询区间完全落在保留窗口之外

  const body = {
    startTime: fmtDateTime(from),
    endTime: fmtDateTime(to),
    pageNum,
    pageSize,
  };
  const r = await request(task, 'POST', ENDPOINTS.requestUsage, body, { referer: '/profile/plans-usage' });
  if (!r.ok) throw classify(r);
  const d = r.data || {};
  return { total: Number(d.total) || 0, items: Array.isArray(d.data) ? d.data : [] };
}

/**
 * 权益包明细（免费包 + 付费包），字段含包名 / 剩余 / 总量 / 周期起止。
 * 端点：
 *   POST /billing/meter/get-user-resource-free-packages
 *   POST /billing/meter/get-user-resource-paid-packages
 * ★★ PackageCodes 是必填参数：不传 → HTTP 200 + Accounts:[] （静默空结果，不报错）。
 *    取值链路：get-user-resource-summary → data.Packages[].PackageCode → 传给本接口。
 * ★返回的是「资源实例」级明细（同一 PackageCode 可有多条不同 ResourceId/周期），
 *   与 get-user-resource-summary 的 Packages[] 是「按 PackageCode 汇总」的关系。
 *
 * @param {string[]} codes PackageCodes（来自 get-user-resource-summary）
 */
async function fetchPackages(task, kind, codes) {
  const path = kind === 'paid' ? ENDPOINTS.paidPackages : ENDPOINTS.freePackages;
  if (!codes || !codes.length) return [];
  const body = kind === 'paid'
    ? { PageNumber: 1, PageSize: 200, Status: [0, 3], PackageCodes: codes, NeedRenewInfo: true }
    : { PageNumber: 1, PageSize: 200, Status: [0], PackageCodes: codes, NeedInUsage: true };
  const r = await request(task, 'POST', path, body, { referer: '/profile/plans-usage' });
  if (!r.ok) throw classify(r);
  const list = (r.data && Array.isArray(r.data.Accounts)) ? r.data.Accounts : [];
  return list.map((a) => ({
    kind,
    packageCode: a.PackageCode || '',
    packageName: a.PackageName || '',
    productName: a.ProductName || '',
    subProductName: a.SubProductName || '',
    remain: Number(a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain) || 0,
    size: Number(a.CycleCapacitySizePrecise ?? a.CycleCapacitySize) || 0,
    used: Number(a.CycleCapacityUsedPrecise ?? a.CycleCapacityUsed) || 0,
    unit: a.CapacityUnit || 'credits',
    cycleStart: a.CycleStartTime || '',
    cycleEnd: a.CycleEndTime || '',
    // ★归一后的到期毫秒（积分过期提醒直接读这个）。
    //   CycleEndTime 是「YYYY-MM-DD HH:mm:ss」的北京时间字面量，parseDateTime 按 UTC+8 解析。
    cycleEndMs: (() => { const s = parseDateTime(a.CycleEndTime); return s ? s * 1000 : null; })(),
  }));
}

export default {
  id: 'workbuddy',
  name: 'WorkBuddy 成长签到',
  capabilities: ['checkin', 'credits', 'credentialTest', 'status', 'totalCredits', 'sessionProbe', 'usage', 'packages'],
  sessionCredentialKeys: ['cookie', 'token'],
  // ★用量能力声明：面板「Token / 积分」单位切换与「无数据原因」提示都读这里。
  //   WorkBuddy 的用量接口（get-user-request-usage）只有积分与请求条数，没有 token 明细，
  //   所以 Token 视图下该平台必然为空 —— 必须把原因显式告知用户，而不是显示 0 或「—」。
  usageMeta: {
    tokens: false,
    tokenNote: 'WorkBuddy 用量接口（get-user-request-usage）只返回「积分 / 请求条数 / 模型 / 时间」，不返回 token 输入输出明细，故该平台 Token 视图无原始数据。积分数据完整可用。',
  },
  // 「新增账号 → 名称」输入框的占位提示（各平台命名习惯不同）
  namePlaceholder: '例：WorkBuddy 成长签到 · 乐幻',
  configSchema: [
    { key: 'authMode', label: '鉴权方式', type: 'select', default: 'auto', required: true,
      options: [
        { value: 'auto', label: '★Cookie 自动换取 Bearer（推荐，只需填 Cookie）' },
        { value: 'web', label: '仅网页 Cookie（session + session_2，直连）' },
        { value: 'bearer', label: '桌面端 Bearer Token（手填，寿命约 60 天）' },
      ],
      hint: '★推荐 auto：只填 Cookie 即可，服务端会用 Cookie 自动换出约 60 天的 Bearer 并缓存复用，'
        + '到期前自动再换一次 —— 无需抓包取 Token。三种方式同一后端、返回体逐字段一致。' },
    { key: 'cookie', label: 'Cookie（auto / web 方式填这里）', type: 'password', required: false,
      placeholder: 'session=xxx; session_2=yyy',
      hint: '登录 www.workbuddy.cn 后，F12 → 网络 → 任一 workbuddy.cn 请求 → 复制请求头 cookie 中的 '
        + 'session 与 session_2 两项（★两者缺一即 401）。换票与签到都用它，有效期约 7 天，到期前会邮件提醒。'
        + '注意：任意一次退出登录都会即时吊销会话，Cookie 里的时间戳不可信。' },
    { key: 'token', label: 'Bearer Token（bearer 方式填这里；auto 方式留空即可）', type: 'password', required: false,
      placeholder: 'eyJhbGciOi...',
      hint: 'auto 模式下由服务端自动写入（用 Cookie 换取），无需手工填。'
        + '若采用 bearer 模式，则填桌面端请求头 Authorization: Bearer 后的整段值（Keycloak JWT，实测约 60 天有效）。' },
    { key: 'baseUrl', label: '接口地址', type: 'select', default: 'https://www.workbuddy.cn', required: true,
      options: [
        { value: 'https://www.workbuddy.cn', label: 'WorkBuddy 官网 (www.workbuddy.cn)' },
        { value: 'https://copilot.tencent.com', label: '桌面端同后端 (copilot.tencent.com)' },
      ],
      hint: '两域路径完全一致、返回体逐字段一致，仅鉴权形态不同；留默认即可。' },
    { key: 'userAgent', label: 'User-Agent（★必须与登录浏览器一致）', type: 'text', default: DEFAULT_UA, required: true,
      hint: '★实测坑：www.workbuddy.cn 的 APISIX 网关会校验 UA，且**站点会话绑定登录时的 UA**——同一份 cookie 用 Chrome/151 的 UA 请求全部 401，换成登录浏览器的 UA（Chrome/152）立刻 200；换票接口（console/login/enterprise）同样如此，换一个合法的完整 Chrome UA 也会 401。若报「登录态失效（HTTP 401）」或换票 401，而 cookie 明明是刚登录的，先检查这里与浏览器是否一致（F12 → 网络 → 任一 workbuddy.cn 请求 → 请求头 user-agent 整段复制）。' },
    { key: 'time', label: '签到时间', type: 'select', default: '09:00', required: true,
      options: TIMES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'timezone', label: '时区(IANA)', type: 'select', default: 'Asia/Shanghai', required: true,
      options: TIMEZONES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'failThreshold', label: '连续失败告警阈值', type: 'select', default: 3,
      options: THRESHOLDS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'cookieExpiryNotify', label: '凭证到期提前邮件通知', type: 'toggle', default: true },
    { key: 'cookieExpiryNotifyDays', label: '凭证到期前何时通知', type: 'select', default: 1,
      options: EXPIRY_DAYS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'notifyOnSuccess', label: '成功也发通知', type: 'toggle', default: false },
  ],

  /**
   * 每日签到打卡。
   * 先读 checkin-activity-status 判断今日是否已签（省一次写请求），未签则 POST daily-checkin；
   * `code:10001 / 今天已签到` 视为正常态（alreadyCheckedIn=true），不报错。
   *
   * ★credits 上报的是「账户可用余额」（get-user-resource-summary 汇总），不是活动累计积分——
   *   活动累计积分（checkin-activity-status.total_credits，3 天仅 300）单独放在 activityCredits。
   */
  async checkin(task) {
    // 状态读失败不阻塞签到，但「凭证失效」必须立刻抛出（否则会拿失效凭证继续发写请求）
    let before = null;
    try {
      before = await fetchStatus(task);
    } catch (e) {
      if (e.kind === 'invalid') throw e;
    }
    const balBefore = await fetchBalance(task).catch(() => null);

    if (before && before.checkedInToday) {
      const bal = balBefore || await fetchBalance(task).catch(() => null);
      return {
        ok: true, alreadyCheckedIn: true,
        credits: bal ? bal.total : null,
        activityCredits: before.totalCredits,
        reward: null,
      };
    }

    const r = await request(task, 'POST', ENDPOINTS.dailyCheckin, {});
    const afterStatus = () => fetchStatus(task).catch(() => null);
    const afterBal = () => fetchBalance(task).catch(() => null);

    if (r.code === 10001 || /今天已签到|已签到/i.test(r.message || '')) {
      const [st, bal] = [await afterStatus(), await afterBal()];
      return {
        ok: true, alreadyCheckedIn: true,
        credits: (bal && bal.total) ?? (balBefore && balBefore.total) ?? null,
        activityCredits: st ? st.totalCredits : (before && before.totalCredits) ?? null,
        reward: null,
      };
    }
    if (!r.ok) throw classify(r);

    const reward = (r.data && r.data.credit) ?? null;
    const [st, bal] = [await afterStatus(), await afterBal()];
    const credits = (bal && bal.total !== null && bal.total !== undefined)
      ? bal.total
      : (balBefore && reward !== null ? balBefore.total + reward : null);
    return {
      ok: true, alreadyCheckedIn: false,
      credits,
      activityCredits: st ? st.totalCredits : null,
      reward,
    };
  },

  /** 当前积分：★账户可用余额（真实计费口径），非活动累计积分 */
  async getCredits(task) {
    const bal = await fetchBalance(task);
    return { ok: true, credits: bal.total };
  },

  /** 测试凭证有效性：签到活动状态可读即视为有效 */
  async checkCredential(task) {
    await fetchStatus(task);
    return { ok: true };
  },

  /** 今日签到状态 + 账户可用余额（不领取） */
  async checkStatus(task) {
    const st = await fetchStatus(task);
    let credits = null;
    try {
      const bal = await fetchBalance(task);
      credits = bal.total;
    } catch { /* 余额查询失败不影响签到状态 */ }
    return { ok: true, checked_in: st.checkedInToday, credits };
  },

  /**
   * 账户总可用积分 + 明细。
   *   total        —— ★Σ Packages[].CycleRemainCapacity（真实可用余额）
   *   packs.list   —— 逐 PackageCode 汇总（剩余/总量/已用）
   *   packs.energy / streakDays —— 成长中心能量与累计签到天数
   *   checkins     —— 签到记录 [{date, credits}]（供「预估可用天数」扣减签到所得）
   *   activity     —— 签到活动状态（活动累计积分等）
   */
  async getTotalCredits(task) {
    const bal = await fetchBalance(task);
    const st = await fetchStatus(task).catch(() => null);
    let energy = null;
    try {
      const r = await request(task, 'GET', ENDPOINTS.energy);
      if (r.ok && r.data) energy = r.data.balance ?? null;
    } catch { /* 附加信息失败忽略 */ }
    return {
      ok: true,
      total: bal.total,
      packs: {
        list: bal.packs,
        capacity: bal.capacity,
        used: bal.used,
        energy,
        streakDays: st ? st.streakDays : null,
      },
      checkins: st ? st.checkinRecords : [],
      activityCredits: st ? st.totalCredits : null,
      status: st,
    };
  },

  /**
   * ★远端签到历史（补「近30天」日历里本机没跑过的那些天）。
   *
   * 数据源：checkin-activity-status 的 `checkin_dates`（平台侧活动期签到日期数组）
   *   + `daily_credit`（当日统一发放积分）—— 与「预估可用天数」使用的是同一份数据。
   * 本机 checkin_logs.json 只记录本部署真正执行过的天，新接入账号/换机后需要靠这里补历史。
   *
   * @returns {Promise<Array<{date:string, credits:?number, source:string}>>} 按日期升序
   */
  async getCheckinHistory(task, { days = 30 } = {}) {
    const st = await fetchStatus(task);
    const cutoff = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(Date.now() - (days - 1) * 86400000));
    const seen = new Set();
    const out = [];
    for (const r of (st && st.checkinRecords) || []) {
      if (!r || !r.date || r.date < cutoff || seen.has(r.date)) continue;
      seen.add(r.date);
      out.push({ date: r.date, credits: r.credits ?? null, source: 'workbuddy checkin_dates' });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  },

  /**
   * 逐条请求消耗（Trae 同构）。
   *
   * ★参数契约与 Trae 不同，这里做一层转换：
   *   Trae   ：start_time/end_time 为 epoch 秒 + usage_type:[7]
   *   WB     ：startTime/endTime 为「YYYY-MM-DD HH:mm:ss」+ pageNum（★不是 pageNumber）
   * 返回体统一映射为 Trae 的 user_usage_group_by_sessions 形状，使
   * checkin-stats.fetchSessions / 前端「积分消耗明细」无需为 WorkBuddy 特判。
   *
   * ★WorkBuddy 该接口不返回 token 数，故 extra_info 恒为 {input_token:0,output_token:0}。
   *
   * @param {object} task
   * @param {{start_time:number,end_time:number,page_size?:number,page_num?:number}} params epoch 秒
   */
  async getUsage(task, params = {}) {
    const startSec = Number(params.start_time);
    const endSec = Number(params.end_time);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      const e = new Error('getUsage 需要 start_time / end_time（epoch 秒）');
      e.kind = 'invalid';
      throw e;
    }
    const pageSize = Math.min(Number(params.page_size) || 50, 200);
    const pageNum = Number(params.page_num) || 1;
    const { total, items } = await fetchUsage(task, {
      startMs: startSec * 1000,
      endMs: endSec * 1000,
      pageNum,
      pageSize,
    });
    return {
      total,
      user_usage_group_by_sessions: items.map((x) => ({
        usage_time: parseDateTime(x.requestTime) ?? null,
        model_name: x.model || '未知模型',
        credits_float: Number(x.credit) || 0,
        extra_info: { input_token: 0, output_token: 0 },   // 上游不提供 token 明细
        user_input_preview: x.inputTrunc || '',
        request_id: x.requestId || '',
        client: x.client || '',
        agent_purpose: x.agentPurpose || '',
      })),
      request_id: undefined,
      provider: 'workbuddy',
    };
  },

  /** 权益包明细（免费 + 付费），面板「权益包」浮层数据源 */
  async getPackages(task) {
    // ★PackageCodes 必填：先从 summary 拿 code 列表
    const sum = await fetchBalance(task);
    const codes = sum.packs.map((p) => p.code).filter(Boolean);
    const [free, paid] = await Promise.all([
      fetchPackages(task, 'free', codes).catch(() => []),
      fetchPackages(task, 'paid', codes).catch(() => []),
    ]);
    const list = free.concat(paid).sort((a, b) => b.remain - a.remain);
    return {
      ok: true,
      total: sum.total,
      capacity: sum.capacity,
      used: sum.used,
      list,
      free: free.length,
      paid: paid.length,
      // 逐 PackageCode 汇总（summary 口径），用于与明细对账
      summary: sum.packs,
    };
  },

  /** 奖励/补偿领取状态（只读；WorkBuddy 侧活动礼包与补偿包是否已领） */
  async getRewardStatus(task) {
    const [comp, gift] = await Promise.all([
      request(task, 'POST', ENDPOINTS.compensationStatus, {}).catch(() => null),
      request(task, 'POST', ENDPOINTS.giftClaimed, {}).catch(() => null),
    ]);
    return {
      ok: true,
      compensation: comp && comp.ok ? comp.data : null,
      gift: gift && gift.ok ? gift.data : null,
    };
  },

  /**
   * 凭证探活（供到期监控使用）。
   *
   * ★需要人工维护的永远是 **Cookie**（Bearer 是它换来的派生物，可凭 Cookie 反复续换 60 天 Bearer）。
   *   到期通知的唯一目的：提醒用户「手动更新凭证」。对 WorkBuddy 而言，只有 Cookie 被服务端
   *   拒绝（探活 401 / isLogin=false）才是真正需要人工更新的时候：
   *   有 Cookie → 一律不返回名义到期（expiresAt:null）。session=<id>|<expiry>|<hash> 里的名义
   *     时间不可作有效性判据（实测可被 logout 即时吊销；且只要服务端还接受 Cookie 就能自动续换
   *     Bearer、签到照常）。若拿它当到期判据，会误报「Cookie 名义过期 < Bearer 仍有效」的假告警
   *     （2026-09 实测复现：账号仍可签到，却因 cookie 名义到期发了「凭证已失效」邮件）。
   *     真正的失效信号交给探活 isLogin=false → 调度层据此触发「凭证已失效」告警。
   *   只填了 token（bearer 模式，无 Cookie 可续换）→ JWT exp 是硬性到期，保留到期提前提醒。
   * 同时附带 tokenExpiresAt（换出的 Bearer 何时到期），便于排查「为何突然要重换」。
   * @returns {Promise<{ok:boolean, isLogin:boolean, expiresAt:number|null, tokenExpiresAt?:number|null}>}
   */
  async probeSession(task) {
    const cookie = cookieOf(task);
    const token = tokenOf(task);
    if (!cookie && !token) return { ok: false, isLogin: false, expiresAt: null, error: '未配置凭证' };

    // 有 Cookie 时不按名义 session 到期发通知（见上 ★），仅在无 Cookie 的纯 bearer 模式下用 JWT exp。
    const expiresAt = cookie ? null : jwtExp(token);
    const tokenExpiresAt = task.tokenExpiredAt || jwtExp(token) || null;
    let r;
    try {
      r = await request(task, 'GET', ENDPOINTS.streak);
    } catch (err) {
      throw err; // 网络类错误按 transient 抛出，由调度层静默跳过
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, isLogin: false, expiresAt: null, tokenExpiresAt, error: '凭证已失效（HTTP 401）' };
    }
    if (!r.ok) throw classify(r);
    return { ok: true, isLogin: true, expiresAt, tokenExpiresAt };
  },

  /** 领取连续签到档位奖励（7d/14d/28d）—— 与每日签到是两个不同动作 */
  async redeem(task, tier) {
    const t = String(tier || '').trim();
    if (!['7d', '14d', '28d'].includes(t)) {
      const e = new Error('tier 必须是 7d / 14d / 28d 之一');
      e.kind = 'invalid';
      throw e;
    }
    const r = await request(task, 'POST', ENDPOINTS.redeem, { tier: t, client_token: `redeem-${t}-${randomUUID()}` });
    if (!r.ok) throw classify(r);
    return { ok: true, tier: t, data: r.data };
  },

  /** 签到活动状态明细（面板展示用，供 /api/checkin/status 之外的自定义展示消费） */
  async getStatus(task) {
    return await fetchStatus(task);
  },
};
