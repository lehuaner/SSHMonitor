/**
 * Trae Provider —— 包装 vendored 的 CheckinClient。
 *
 * 两种凭证模式（并存，**方案一优先、失败自动回落方案二**）：
 *
 *   ┌ 方案一（首选）refreshToken 服务端静默续期
 *   │   · 凭证来自 tools/trae-export.ps1 导出的「导入串」（TRAE1.<base64url>）
 *   │   · 走 POST /cloudide/api/v3/trae/oauth/ExchangeToken（ClientID ono9krqynydwx5）
 *   │   · **不需要 DeviceProof**，只要凭证来自 Trae CN 客户端（不是 TRAE SOLO CN）
 *   │   · refreshToken 滚动轮换 ⇒ 每次成功都必须回写 task.config.refreshToken
 *   │   · 有效期 ~7~14 天，refreshToken 本身 ~180 天 ⇒ 基本免维护
 *   └ 方案二（兜底）网页 Cookie → GetUserToken
 *       · 用户粘贴整段 Cookie，8 小时 JWT 自动刷新
 *       · X-Cloudide-Session 约 14 天 ⇒ 需要人工重贴（这是它当初的痛点，故降为兜底）
 *
 * 职责：
 *   - 定义前端动态表单的 configSchema（含方案一的「下载提取脚本」入口）
 *   - 实现 checkin / getCredits / checkCredential / probeSession / usage / packages
 *   - 把 CheckinClient 抛出的错误归一化分类（invalid=凭证无效 / transient=临时失败 / throttle=限流）
 */
import { CheckinClient, decodeJwtClaims, parseSidGuardExpiry, deriveDevice } from '../checkin/checkin.js';
// 导入串（方案一凭证）的解析 —— 与 HTTP 路由共用同一份实现，避免两处漂移
import { parseCredential, looksLikeImportString } from '../checkin/trae-credential.js';
// 三个平台共用的表单常量与「积分过期提醒」配置片段
import { TIMEZONES, TIMES, THRESHOLDS, EXPIRY_DAYS } from './common.js';
// 降级事件只记档、不发信，由「每日日报」第⑥块汇总（2026-09-27 起的既有约定）
import { recordAlertEvent } from '../alert-events.js';

// JWT 剩余有效期低于该值时换新 token。
// ★ 刻意取小值：方案一每次续期都会【推进 refreshToken 的轮换链】，
//   而客户端手里那份只宽限一代 —— 续得太勤会把客户端顶下线。
//   1 小时 ⇒ 理论上约每 7~14 天才续一次，与客户端自然续期同频。
const TOKEN_MIN_REMAINING_MS = 60 * 60 * 1000;

// 导入串前缀（tools/trae-export.ps1 产出；解析实现见 lib/checkin/trae-credential.js）

// 设备标识解析（优先级）：账号配置（config.deviceId / config.vscodeSessionId / config.marketUserId）
// > ~/.monitor_data/device_identity.json（部署级）> 按 taskId 稳定派生。
// 上游按设备对签到做约束：claim 会校验 x-device-id 必须与该 token 绑定的 aha 设备 ID 一致，
// 不一致会返回 9074「当前参与用户太多」（伪装成限流）或 code 9004。
// 方案一的导入串自带真实 aha ID，resolveToken() 会自动落到 task.config.deviceId。
function deviceFor(task) {
  const dev = deriveDevice(task.id + '|trae');
  const cfg = task.config || {};
  if (cfg.deviceId) dev.deviceId = cfg.deviceId;
  if (cfg.vscodeSessionId) dev.vscodeSessionId = cfg.vscodeSessionId;
  if (cfg.marketUserId) dev.marketUserId = cfg.marketUserId;
  return dev;
}

/**
 * 归一化错误：优先识别上游保护码「操作太过频繁(9074)」，其余按凭证无效/临时失败分类 */
function classify(err) {
  const msg = (err && err.message ? err.message : String(err)).trim();
  const e = new Error(msg);
  // 上游对签到领取(claim)的保护码：HTTP 200 + code 9074「操作太过频繁，请稍后尝试」。
  // 属服务端对该账号短时的保护，重试会刷新窗口，需退避等待，不能当作普通失败连续硬撞。
  if (/操作太过频繁|太频繁|操作频繁|频率过快|稍后再试/i.test(msg)) {
    e.kind = 'throttle';
    return e;
  }
  // 2026-10-01 补：以下都是「重试也不会好」的确定性失败，必须归为 invalid 而不是 transient。
  //   20101 refresh token is invalid        —— 方案一凭证已被轮换链淘汰（需重新导出）
  //   10101 refresh token is not matched    —— 凭证不属于该 ClientID（拿了 SOLO 的凭证）
  //   20403/20405 Device (proof) mismatch   —— SOLO 系凭证要求设备签名
  //   code=1001 "not able to authenticate"  —— access token 过期（旧正则匹配不到 authenticate）
  const invalid =
    /HTTP 401|HTTP 403/.test(msg) ||
    /code[=:]\s*(?:20101|20403|20405|10101)\b/.test(msg) ||
    /not able to authenticate/i.test(msg) ||
    /cookie|token|凭证|未授权|登录|过期|会话|invalid|expired|unauthorized|sign.?in/i.test(msg);
  e.kind = invalid ? 'invalid' : 'transient';
  return e;
}

/**
 * 解析当前应使用的 JWT。三条腿，按优先级：
 *   ① 现成 token 还没临期          → 直接用（**不主动续期**，避免无谓推进轮换链）
 *   ② config.refreshToken 存在      → ExchangeToken 静默续期（方案一）
 *   ③ config.cookie 存在            → GetUserToken 换 8h JWT（方案二）
 * 方案一失败时：记一条[提醒]事件（不发信，进日报）后**自动回落**到方案二。
 */
async function resolveToken(task) {
  const cfg = task.config || {};
  const device = deviceFor(task);

  // ① 现成 token 仍可用 → 直接返回
  const claims = cfg.token ? decodeJwtClaims(cfg.token) : null;
  const remainingMs = claims && claims.exp ? claims.exp * 1000 - Date.now() : -1;
  if (cfg.token && remainingMs > TOKEN_MIN_REMAINING_MS) return cfg.token;

  // ② 方案一：refreshToken 静默续期
  const rawCred = String(cfg.refreshToken || '').trim();
  if (rawCred && !parseCredential(rawCred)) {
    // 以 TRAE1. 开头却解不出来 ⇒ 多半是复制被截断。直接说是凭证问题，
    // 不要落到方案二去偷偷用 Cookie（那会掩盖"导入串坏了"这个可修的事实）。
    throw classify(new Error('导入串格式错误（TRAE1. 前缀但内容无法解析），请重新运行提取脚本'));
  }
  const cred = rawCred ? parseCredential(rawCred) : null;
  if (cred) {
    // 导入串自带的真实 aha 设备 ID 落到账号配置（只补空值，不覆盖用户显式填的）
    if (cred.deviceId && !cfg.deviceId) cfg.deviceId = cred.deviceId;
    cfg.refreshMeta = {
      brand: cred.brand || '',
      exportedAt: cred.at || '',
      userId: cred.userId || '',
      host: cred.host || '',
    };
    try {
      const client = new CheckinClient({
        baseUrl: cfg.baseUrl, token: '', device: deviceFor(task), appVersion: cfg.appVersion,
      });
      const r = await client.exchangeToken(cred.refreshToken, { userId: cred.userId });
      cfg.token = r.Token;
      // ★ refreshToken 是滚动轮换的：不回写，下一次续期必然 20101。
      //   回写的是【裸 token】而非导入串 —— deviceId 已经落进 config.deviceId，不会丢。
      cfg.refreshToken = r.RefreshToken;
      const nc = decodeJwtClaims(r.Token);
      task.tokenExpiredAt =
        (nc && nc.exp ? nc.exp * 1000 : null) || r.TokenExpireAt || null;
      return r.Token;
    } catch (err) {
      // 自动回落：只记档（进日报），不发即时邮件；同一小时内不重复记。
      const now = Date.now();
      if (!cfg.refreshTokenFailedAt || now - cfg.refreshTokenFailedAt > 3600000) {
        cfg.refreshTokenFailedAt = now;
        recordAlertEvent(`[提醒] Trae 方案一凭证失效，已降级用 Cookie：${task.name || task.id}`);
      }
      if (!cfg.cookie) throw classify(err); // 没有 Cookie 可回落 → 本身就是凭证失效
    }
  }

  // ③ 方案二：Cookie → GetUserToken
  if (!cfg.cookie) {
    if (cfg.token) return cfg.token; // 仅配了裸 token 的旧任务，8 小时后自然失效
    throw classify(new Error('未配置凭证：需要「导入串」或 Cookie'));
  }
  const client = new CheckinClient({
    baseUrl: cfg.baseUrl, token: '', cookie: cfg.cookie, device, appVersion: cfg.appVersion,
  });
  const r = await client.getUserToken();
  cfg.token = r.Token;
  const newClaims = decodeJwtClaims(r.Token);
  task.tokenExpiredAt =
    (newClaims && newClaims.exp ? newClaims.exp * 1000 : null) || Date.parse(r.ExpiredAt) || null;
  return r.Token;
}

async function buildClient(task) {
  const token = await resolveToken(task);
  return new CheckinClient({ baseUrl: task.config.baseUrl, token, device: deviceFor(task), appVersion: task.config.appVersion });
}

export default {
  id: 'trae',
  name: 'Trae',
  capabilities: ['checkin', 'credits', 'credentialTest', 'status', 'totalCredits', 'sessionProbe', 'usage', 'packages'],
  // 会话巡检 / 「改凭证即解除失效」都按这个声明取键（不声明会回落 cookie/token，
  // 但显式写出来才与 WorkBuddy/CodeArts 一致，也被自检覆盖）
  sessionCredentialKeys: ['cookie', 'refreshToken'],
  // ★用量能力声明：Trae 会话明细（usageGroupBySession）的 extra_info 含 input_token/output_token
  usageMeta: {
    tokens: true,
    tokenNote: null,
  },
  // 「新增账号 → 名称」输入框的占位提示（各平台命名习惯不同）
  namePlaceholder: '例：Trae 主账号',
  configSchema: [
    // ── 方案一（首选）──────────────────────────────────────────────
    // 纯展示字段：渲染一个下载按钮，不参与取值/提交（无 data-k，前端 collectFields 自动跳过）。
    // 面板在下载时会把脚本里的 __API_BASE__ 替换成 location.origin，
    // 于是脚本既能「只输出导入串」，也能直接写回本服务端 —— 全程不硬编码任何地址。
    { key: '__exportScript', label: '① 提取凭证', type: 'download',
      href: '/trae-export.bat', text: '下载 Windows 提取脚本',
      hint: '在装有 Trae CN 客户端的 Windows 上双击运行：自动解密本机登录态 → 实测一次续期 → 输出「导入串」，并可直接写回本面板（新增 or 更新自动判断）。只读客户端文件，不会改动它。' },
    { key: 'refreshToken', label: '② 导入串 / refreshToken', type: 'password', required: false,
      placeholder: '粘贴提取脚本产出的 TRAE1.… 导入串',
      hint: '方案一：服务端用 refreshToken 静默续期，有效期约 180 天，无需人工重贴。凭证必须来自 Trae CN 客户端（TRAE SOLO CN 的会被上游拒绝）。脚本写回时本字段会自动填好，不用手抄。' },
    // ── 方案二（兜底）──────────────────────────────────────────────
    { key: 'cookie', label: '方案二 · Cookie (网页登录凭证)', type: 'password', required: false,
      placeholder: '粘贴浏览器请求头 cookie: 后的整段原值',
      hint: '兜底方案：方案一凭证失效时自动降级用它。登录 www.trae.cn 后，F12 → 网络 → 任一 api.trae.cn 请求 → 复制请求头 cookie: 的整段值（核心是 X-Cloudide-Session 与 sessionid）。系统会用 Cookie 自动换取并刷新签到所需的 JWT（JWT 每 8 小时过期，无需手动维护）。Cookie 有效期约 14~60 天，到期前会邮件提醒。' },
    { key: 'baseUrl', label: '接口地址', type: 'select', default: 'https://api.trae.cn', required: true,
      options: [
        { value: 'https://api.trae.cn', label: 'Trae (api.trae.cn)' },
        { value: 'https://api.trae.com', label: 'Trae 国际 (api.trae.com)' },
      ] },
    { key: 'appVersion', label: 'App 版本 (app-version)', type: 'text', default: '0.1.51', required: true,
      hint: '请求头 app-version。服务端会随 IDE 版本更新的风控策略变化，若签到报「操作太过频繁」可尝试改为最新抓包中的版本号。' },
    { key: 'deviceId', label: '设备 ID (x-device-id)', type: 'text', required: false,
      placeholder: '留空则按账号自动派生',
      hint: '请求头 x-device-id（独立参数，不在 Cookie 中）。留空时系统按账号 ID 稳定派生一套；若上游风控拒绝派生值（报「操作太过频繁」），可从自己 IDE 的抓包中复制真实 x-device-id 填入，也可为每个账号配置独立值。部署级公共标识可写 ~/.monitor_data/device_identity.json。' },
    { key: 'vscodeSessionId', label: 'vscode-sessionId（可选）', type: 'text', required: false,
      placeholder: '留空则自动派生',
      hint: '请求头 vscode-sessionid，一般无需填写；需整套复用真实抓包设备标识时才填。' },
    { key: 'marketUserId', label: 'x-market-user-id（可选）', type: 'text', required: false,
      placeholder: '留空则自动派生',
      hint: '请求头 x-market-user-id，一般无需填写；需整套复用真实抓包设备标识时才填。' },
    { key: 'time', label: '签到时间', type: 'select', default: '09:00', required: true,
      options: TIMES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'timezone', label: '时区(IANA)', type: 'select', default: 'Asia/Shanghai', required: true,
      options: TIMEZONES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'failThreshold', label: '连续失败告警阈值', type: 'select', default: 3,
      options: THRESHOLDS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'cookieExpiryNotify', label: 'Cookie 到期提前邮件通知', type: 'toggle', default: true },
    { key: 'cookieExpiryNotifyDays', label: 'Cookie 到期前何时通知', type: 'select', default: 1,
      options: EXPIRY_DAYS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'notifyOnSuccess', label: '成功也发通知', type: 'toggle', default: false },
  ],

  /** 执行一次签到，返回结构化结果 */
  async checkin(task) {
    try {
      const client = await buildClient(task);
      const res = await client.checkin();
      return {
        ok: true,
        alreadyCheckedIn: res.alreadyCheckedIn,
        credits: (res.status && res.status.credits) ?? null,
        reward: (res.claimed && (res.claimed.credits ?? res.claimed.reward)) ?? null,
      };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 查询当前积分余额 */
  async getCredits(task) {
    try {
      const client = await buildClient(task);
      const st = await client.status();
      return { ok: true, credits: st.credits ?? null };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 测试凭证有效性：status 成功即视为有效 */
  async checkCredential(task) {
    try {
      const client = await buildClient(task);
      await client.status();
      return { ok: true };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 查询今日签到状态 + 当前积分（不领取） */
  async checkStatus(task) {
    try {
      const client = await buildClient(task);
      const st = await client.status();
      return { ok: true, checked_in: !!st.checked_in, credits: st.credits ?? null };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 查询账户总可用积分（所有权益包剩余之和） */
  async getTotalCredits(task) {
    try {
      const client = await buildClient(task);
      const tc = await client.totalCredits();
      return { ok: true, total: tc.total, packs: tc.packs, checkins: tc.checkins };
    } catch (err) {
      throw classify(err);
    }
  },

  /**
   * 权益包明细（面板「权益包」浮层 + 积分过期提醒 的数据源）。
   *
   * ★完全复用 getTotalCredits()（底层是同一个 user_current_entitlement_list 端点），
   *   只是把 packs 映射成各平台统一的 { packageName, remain, size, used, cycleStart, cycleEnd, cycleEndMs }。
   *   Trae 的 start_time / end_time 是 epoch 秒，cycleEndMs 直接给毫秒，下游无需再猜单位。
   */
  async getPackages(task) {
    try {
      // 走 buildClient（含 Cookie→JWT 自动刷新），不打 this，避免调用方未绑定 this 时炸掉
      const client = await buildClient(task);
      const tc = await client.totalCredits();
      const packs = tc.packs || [];
      const list = packs.map((p) => ({
        kind: /^checkin_/i.test(String(p.desc || '')) ? 'credit' : 'credit',
        packageCode: p.desc || p.group || 'trae',
        packageName: [p.group, p.desc].filter(Boolean).join(' · ') || '权益包',
        remain: p.remaining == null ? 0 : p.remaining,
        size: p.limit == null ? null : p.limit,
        used: p.used || 0,
        unit: 'credits',
        // 展示用：本地时间串（下游只按天聚合，精度够用）
        cycleStart: p.startTime ? new Date(p.startTime * 1000).toISOString().slice(0, 10) : '',
        cycleEnd: p.endTime ? new Date(p.endTime * 1000).toISOString().slice(0, 10) : '',
        // ★归一后的到期毫秒（积分过期提醒直接读这个）
        cycleEndMs: p.endMs || null,
      }));
      return {
        ok: true,
        total: tc.total,
        capacity: null,
        used: null,
        list,
        free: list.length,
        paid: 0,
        perPackage: true,
        source: 'user_current_entitlement_list',
        summary: list.map((x) => ({ code: x.packageName, total: x.size, remain: x.remain, used: x.used })),
      };
    } catch (err) {
      throw classify(err);
    }
  },

  /**
   * 用 Cookie 探测网页会话状态（供 Cookie 到期监控使用）。
   * 到期时间取 CheckLogin 的会话 ExpiredAt（约 14 天，滑动续期）与
   * sid_guard 静态解析（passport 会话约 60 天）中较早者。
   * @returns {Promise<{ok:boolean, isLogin:boolean, expiresAt:number|null}>}
   */
  async probeSession(task) {
    const cookie = task.config.cookie;
    if (!cookie) return { ok: false, isLogin: false, expiresAt: null, error: '未配置 Cookie' };
    const client = new CheckinClient({ baseUrl: task.config.baseUrl, token: '', cookie, device: deviceFor(task), appVersion: task.config.appVersion });
    try {
      const r = await client.checkLoginSession();
      if (!r.IsLogin) {
        return { ok: false, isLogin: false, expiresAt: null, error: 'Cookie 会话已失效（CheckLogin IsLogin=false）' };
      }
      const sidExpiry = parseSidGuardExpiry(cookie);
      const sessionExpiry = typeof r.ExpiredAt === 'number' && r.ExpiredAt > 0 ? r.ExpiredAt : null;
      const expiresAt = sidExpiry && sessionExpiry ? Math.min(sidExpiry, sessionExpiry) : (sessionExpiry || sidExpiry);
      return { ok: true, isLogin: true, expiresAt };
    } catch (err) {
      throw classify(err);
    }
  },

  /**
   * 查询账户按会话分组的积分消耗记录。原样转发上游返回，不做任何整理聚合。
   * @param {object} task
   * @param {object} params 透传给 usageGroupBySession 的请求体，如 { start_time, end_time, page_size, page_num, usage_type }
   * @returns {Promise<object>} 上游原样返回的 JSON
   */
  async getUsage(task, params = {}) {
    try {
      const client = await buildClient(task);
      return await client.usageGroupBySession(params);
    } catch (err) {
      throw classify(err);
    }
  },
};