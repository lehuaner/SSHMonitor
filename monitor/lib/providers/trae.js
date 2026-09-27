/**
 * Trae Provider —— 包装 vendored 的 CheckinClient。
 * 职责：
 *   - 定义前端动态表单的 configSchema
 *   - 实现 checkin / getCredits / checkCredential / probeSession
 *   - 用 Cookie 自动刷新 Cloud-IDE-JWT（8 小时效）并写回 task.config.token
 *   - 把 CheckinClient 抛出的错误归一化分类（invalid=凭证无效 / transient=临时失败）
 */
import { CheckinClient, decodeJwtClaims, parseSidGuardExpiry, deriveDevice } from '../checkin/checkin.js';
// 三个平台共用的表单常量与「积分过期提醒」配置片段
import { TIMEZONES, TIMES, THRESHOLDS, EXPIRY_DAYS } from './common.js';

// JWT 剩余有效期低于该值时用 Cookie 换新 token
const TOKEN_MIN_REMAINING_MS = 60 * 60 * 1000;

// 每个账号使用独立且稳定的设备标识（上游按设备对当日签到做约束，
// 共享同一设备会导致后签到账号报「操作太过频繁」）。以 taskId 为种子派生，
// 若账号配置了 deviceId（config.deviceId）则优先使用该值，否则回落默认真实设备标识。
function deviceFor(task) {
  const dev = deriveDevice(task.id + '|trae');
  const cfgDeviceId = task.config && task.config.deviceId;
  if (cfgDeviceId) dev.deviceId = cfgDeviceId;
  return dev;
}

/** 归一化错误：优先识别上游保护码「操作太过频繁(9074)」，其余按凭证无效/临时失败分类 */
function classify(err) {
  const msg = (err && err.message ? err.message : String(err)).trim();
  const e = new Error(msg);
  // 上游对签到领取(claim)的保护码：HTTP 200 + code 9074「操作太过频繁，请稍后尝试」。
  // 属服务端对该账号短时的保护，重试会刷新窗口，需退避等待，不能当作普通失败连续硬撞。
  if (/操作太过频繁|太频繁|操作频繁|频率过快|稍后再试/i.test(msg)) {
    e.kind = 'throttle';
    return e;
  }
  const invalid =
    /HTTP 401|HTTP 403/.test(msg) ||
    /cookie|token|凭证|未授权|登录|过期|会话|invalid|expired|unauthorized|sign.?in/i.test(msg);
  e.kind = invalid ? 'invalid' : 'transient';
  return e;
}

/**
 * 解析当前应使用的 JWT，必要时用 Cookie 刷新：
 * - 无 Cookie：直接用 config.token（仅旧任务兼容，8 小时后自然失效）
 * - 有 Cookie：token 缺失或剩余不足 1 小时时调 GetUserToken 换新，
 *   并写回 task.config.token / task.tokenExpiredAt（由调用方负责持久化）
 */
async function resolveToken(task) {
  const { cookie, token, baseUrl } = task.config;
  if (!cookie) {
    if (!token) throw new Error('未配置 Cookie 凭证');
    return token;
  }
  const claims = token ? decodeJwtClaims(token) : null;
  const remainingMs = claims && claims.exp ? claims.exp * 1000 - Date.now() : -1;
  if (token && remainingMs > TOKEN_MIN_REMAINING_MS) return token;

  const client = new CheckinClient({ baseUrl, token: '', cookie, device: deviceFor(task), appVersion: task.config.appVersion });
  const r = await client.getUserToken();
  task.config.token = r.Token;
  const newClaims = decodeJwtClaims(r.Token);
  task.tokenExpiredAt =
    newClaims && newClaims.exp ? newClaims.exp * 1000 : Date.parse(r.ExpiredAt) || null;
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
  sessionCredentialKeys: ['cookie'],
  // ★用量能力声明：Trae 会话明细（usageGroupBySession）的 extra_info 含 input_token/output_token
  usageMeta: {
    tokens: true,
    tokenNote: null,
  },
  // 「新增账号 → 名称」输入框的占位提示（各平台命名习惯不同）
  namePlaceholder: '例：Trae 主账号',
  configSchema: [
    { key: 'cookie', label: 'Cookie (网页登录凭证)', type: 'password', required: true,
      placeholder: '粘贴浏览器请求头 cookie: 后的整段原值',
      hint: '登录 www.trae.cn 后，F12 → 网络 → 任一 api.trae.cn 请求 → 复制请求头 cookie: 的整段值（核心是 X-Cloudide-Session 与 sessionid）。系统会用 Cookie 自动换取并刷新签到所需的 JWT（JWT 每 8 小时过期，无需手动维护）。Cookie 有效期约 14~60 天，到期前会邮件提醒。' },
    { key: 'baseUrl', label: '接口地址', type: 'select', default: 'https://api.trae.cn', required: true,
      options: [
        { value: 'https://api.trae.cn', label: 'Trae (api.trae.cn)' },
        { value: 'https://api.trae.com', label: 'Trae 国际 (api.trae.com)' },
      ] },
    { key: 'appVersion', label: 'App 版本 (app-version)', type: 'text', default: '0.1.51', required: true,
      hint: '请求头 app-version。服务端会随 IDE 版本更新的风控策略变化，若签到报「操作太过频繁」可尝试改为最新抓包中的版本号。' },
    { key: 'deviceId', label: '设备 ID (x-device-id)', type: 'text', default: '3798161405005257', required: true,
      hint: '请求头 x-device-id（独立参数，不在 Cookie 中）。默认值为真实抓包中的设备标识；若多个账号共享导致签到报「操作太过频繁」，可为每个账号配置独立的设备 ID。' },
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