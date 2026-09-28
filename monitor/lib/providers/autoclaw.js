/**
 * AutoClaw（智谱 Z.ai）Provider —— 每日签到 + 积分钱包。
 *
 * 与 Trae/WorkBuddy Provider 同构（configSchema / checkin / getCredits / checkCredential /
 * checkStatus / getTotalCredits / getPackages / probeSession），差异只在协议：
 *
 * ★凭证形态（与 Trae/WorkBuddy 的 Cookie 形态不同）：
 *   - 用户粘贴 refresh_token（30 天有效，登录客户端后从抓包/日志获取，或用本项目的「验证码登录」流程换取）
 *   - provider 每次签到前自动用 refresh_token 换新 access_token（24h），并写回 task.config.token /
 *     task.tokenExpiredAt / task.config.refreshTokenExpiresAt（调用方 persistTask 持久化）
 *   - refresh_token 实测不轮换：30 天窗口固定，到期前邮件提醒（probeSession 按 refresh JWT exp 探测）
 *   - access_token 剩余 <6h 才刷新（JWT 本地即可判断，无需网络）
 *
 * 协议细节见 ../checkin/autoclaw.js 文件头；E2E 实测记录（2026-09-18）：
 *   - task-list: daily_signin status=completed = 今日已签
 *   - complete: 已签后返回 {already_completed:true, reward_points:0}（幂等）
 *   - 正常奖励 200 积分/天，签到积分批次 7 天后过期
 */
import { AutoClawClient, decodeJwtClaims, DAILY_SIGNIN_TASK_ID, describeWallet, deviceFingerprint } from '../checkin/autoclaw.js';
// 三个平台共用的表单常量与「积分过期提醒」配置片段
import { TIMEZONES, TIMES, THRESHOLDS, EXPIRY_DAYS } from './common.js';
import { loadJSON, DATA_DIR } from '../utils.js';

// access_token 剩余有效期低于该值时用 refresh_token 换新
const TOKEN_MIN_REMAINING_MS = 6 * 60 * 60 * 1000;

// 设备指纹解析：账号 config.deviceId > ~/.monitor_data/device_identity.json 的 autoclawDeviceId
// > 按账号稳定派生。注意：凭证与签发时的 device_id 绑定，换指纹需重新验证码登录。
let acIdentity;
function deviceIdFor(task) {
  const cfg = (task && task.config) || {};
  if (cfg.deviceId) return cfg.deviceId;
  if (acIdentity === undefined) {
    try { acIdentity = loadJSON(DATA_DIR + '/device_identity.json', {}) || {}; }
    catch { acIdentity = {}; }
  }
  if (acIdentity.autoclawDeviceId) return acIdentity.autoclawDeviceId;
  return deviceFingerprint((task && task.id) || 'autoclaw');
}

/** 归一化错误（直接复用客户端库的分类逻辑；这里兜底处理网络层裸错误） */
function classify(err) {
  if (err && err.kind) return err;
  const msg = (err && err.message ? err.message : String(err)).trim();
  const e = new Error(msg);
  const invalid = /HTTP 401|HTTP 403|token|凭证|登录|过期|失效|会话|unauthorized|expired|invalid/i.test(msg);
  e.kind = invalid ? 'invalid' : 'transient';
  return e;
}

/**
 * 解析当前应使用的 access_token，必要时用 refresh_token 刷新：
 * - 无 refresh_token：直接用 config.token（仅旧任务兼容，24h 后自然失效）
 * - 有 refresh_token：token 缺失/解析失败/剩余不足 6h 时刷新，
 *   并写回 task.config.token / task.tokenExpiredAt / task.config.refreshTokenExpiresAt
 */
async function resolveToken(task) {
  const { refreshToken, token } = task.config;
  const claims = token ? decodeJwtClaims(token) : null;
  const expMs = claims && claims.exp ? claims.exp * 1000 : null;
  const remainingMs = expMs ? expMs - Date.now() : -1;
  if (token && remainingMs > TOKEN_MIN_REMAINING_MS) return token;
  if (!refreshToken) {
    if (!token) throw classify(new Error('未配置 refresh_token 凭证'));
    return token; // 只剩 token 的旧任务：用到过期为止，由 probeSession 提醒
  }

  const client = new AutoClawClient({ refreshToken, deviceId: deviceIdFor(task) });
  const r = await client.refreshAccessToken();
  task.config.token = r.accessToken;
  task.config.refreshTokenExpiresAt = r.refreshExpMs;
  task.tokenExpiredAt = r.accessExpMs;
  return r.accessToken;
}

async function buildClient(task) {
  const accessToken = await resolveToken(task);
  return new AutoClawClient({
    accessToken,
    refreshToken: task.config.refreshToken,
    deviceId: deviceIdFor(task),
  });
}

export default {
  id: 'autoclaw',
  name: 'AutoClaw',
  capabilities: ['checkin', 'credits', 'credentialTest', 'status', 'totalCredits', 'sessionProbe', 'packages', 'smsLogin'],
  // 「可探活凭证」= refresh_token（30 天长期凭证）；token 是派生的 24h 短凭证
  sessionCredentialKeys: ['refreshToken'],
  namePlaceholder: '例：AutoClaw 主账号',
  configSchema: [
    {
      key: 'refreshToken', label: 'Refresh Token（30 天长期凭证）', type: 'password', required: false,
      placeholder: '留空 = 用「验证码登录」按钮自动获取；或直接粘贴 refresh_token',
      hint: '推荐方式：保存账号后点任务卡片上的「验证码登录」，手机收码即可自动填入 30 天凭证，全程无需粘贴。也可用 examples/autoclaw_probe.mjs 的 login 命令获取后手动粘贴。到期前会邮件提醒。',
    },
    {
      key: 'token', label: 'Access Token（可选，24 小时短凭证）', type: 'password', required: false,
      placeholder: '留空即可；配置了 Refresh Token 时自动换新',
      hint: '一般不用填。仅当你只有一次性的 access_token 时填写（24 小时后失效，需手动更新）。',
    },
    {
      key: 'deviceId', label: '设备 ID（可选）', type: 'text', required: false,
      hint: '设备指纹解析顺序：此处填写 > ~/.monitor_data/device_identity.json 的 autoclawDeviceId > 按账号自动派生。凭证与签发时的 device_id 绑定，换指纹后需重新验证码登录；一般留空即可。',
    },
    { key: 'time', label: '签到时间', type: 'select', default: '09:00', required: true,
      options: TIMES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'timezone', label: '时区(IANA)', type: 'select', default: 'Asia/Shanghai', required: true,
      options: TIMEZONES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'failThreshold', label: '连续失败告警阈值', type: 'select', default: 3,
      options: THRESHOLDS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'cookieExpiryNotify', label: '凭证到期提前邮件通知', type: 'toggle', default: true },
    { key: 'cookieExpiryNotifyDays', label: '凭证到期前何时通知', type: 'select', default: 3,
      options: EXPIRY_DAYS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'notifyOnSuccess', label: '成功也发通知', type: 'toggle', default: false },
  ],

  /**
   * 验证码登录 ①：发短信验证码。
   * 与 CodeArts 的 requestVerifyCode（设备二次验证）不同：这是**无凭证登录**——
   * 新建账号时无需粘贴任何 token，手机收码即可建立 30 天凭证。
   * 验证码有短时效（短信有效期，实测分钟级），request → submit 需在窗口内完成。
   * @param {object} task 现有任务（编辑场景；新建场景传 {config:{}} 即可）
   * @param {string} phone 11 位手机号（新建时用户在弹窗输入）
   * @returns {Promise<{ok:boolean, sent:boolean, phone:string, message:string}>}
   */
  async requestLoginCode(task, phone) {
    try {
      const client = new AutoClawClient({
        refreshToken: task.config && task.config.refreshToken,
        deviceId: deviceIdFor(task),
      });
      const r = await client.sendCode(phone);
      if (!r.result) throw new Error('上游未确认发送成功');
      return { ok: true, sent: true, phone: String(phone).trim(), message: '验证码已发送，请查收短信' };
    } catch (err) {
      throw classify(err);
    }
  },

  /**
   * 验证码登录 ②：用验证码换 token 并直接写入任务配置。
   * 成功后 config.refreshToken / token / refreshTokenExpiresAt 全部落盘（saveTasks 由路由层负责），
   * credentialInvalid 状态自动解除条件成立（下一次签到用新凭证即恢复）。
   * @returns {Promise<{ok:boolean, message:string, refreshExpMs:number|null, userId:string|null, userName:string|null}>}
   */
  async submitLoginCode(task, phone, code) {
    try {
      const client = new AutoClawClient({
        refreshToken: task.config && task.config.refreshToken,
        deviceId: deviceIdFor(task),
      });
      const r = await client.loginWithSmsCode(phone, code);
      if (!r.refreshToken) throw new Error('登录成功但未返回 refresh_token');
      task.config.refreshToken = r.refreshToken;
      task.config.token = r.accessToken;
      task.config.refreshTokenExpiresAt = r.refreshExpMs;
      task.tokenExpiredAt = r.accessExpMs;
      // 凭证曾失效的任务，换新后自动复位（与 updateTask 的失效解除逻辑对齐）
      task.credentialInvalid = false;
      task.notifiedInvalid = false;
      task.failCount = 0;
      return {
        ok: true,
        message: `登录成功：${r.userName || r.userId || '账号'}，凭证有效期至 ${r.refreshExpMs ? new Date(r.refreshExpMs).toISOString().slice(0, 10) : '30 天后'}`,
        refreshExpMs: r.refreshExpMs,
        userId: r.userId,
        userName: r.userName,
      };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 执行一次签到（签到前自动续期 access_token），返回结构化结果 */
  async checkin(task) {
    try {
      const client = await buildClient(task);
      const res = await client.checkin();
      return {
        ok: true,
        alreadyCheckedIn: res.alreadyCheckedIn,
        credits: res.credits,
        reward: res.reward || null,
        streak: res.streak || null,
      };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 查询当前积分余额（钱包 total_balance） */
  async getCredits(task) {
    try {
      const client = await buildClient(task);
      const credits = await client.totalBalance();
      return { ok: true, credits };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 测试凭证有效性：task-list 能拉到即视为有效 */
  async checkCredential(task) {
    try {
      const client = await buildClient(task);
      const tasks = await client.taskList();
      return { ok: true, tasks: tasks.length };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 查询今日签到状态 + 当前积分（不领取） */
  async checkStatus(task) {
    try {
      const client = await buildClient(task);
      const tasks = await client.taskList();
      const entry = tasks.find((t) => t && t.task_id === DAILY_SIGNIN_TASK_ID) || null;
      const credits = await client.totalBalance();
      return {
        ok: true,
        checked_in: !!(entry && entry.status === 'completed'),
        credits,
        statusDescription: entry ? entry.status_description || '' : '',
      };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 查询钱包总余额（各批次之和即 total_balance，单一口径无分包） */
  async getTotalCredits(task) {
    try {
      const client = await buildClient(task);
      const j = await client.wallet();
      const d = (j && j.data) || {};
      return { ok: true, total: Number(d.total_balance) || 0 };
    } catch (err) {
      throw classify(err);
    }
  },

  /**
   * 权益包明细（面板「权益包」浮层 + 积分过期提醒的数据源）。
   * AutoClaw 钱包每个 wallet_instance 就是一个有独立到期时间的批次：
   *   cycle_key=reward:daily:daily_signin:<uid>:<date> 的签到批次 7 天后过期
   * 归一成统一结构 { packageName, remain, size, used, cycleStart, cycleEnd, cycleEndMs }。
   */
  async getPackages(task) {
    try {
      const client = await buildClient(task);
      const j = await client.wallet();
      const d = (j && j.data) || {};
      const list = (d.wallet_instances || []).map((w) => {
        const expMs = w.expires_at ? Date.parse(w.expires_at) : null;
        const effMs = w.effective_at ? Date.parse(w.effective_at) : null;
        return {
          kind: 'credit',
          packageCode: w.wallet_id || w.cycle_key || 'autoclaw',
          packageName: describeWallet(w),
          remain: Number(w.balance) || 0,
          size: Number(w.balance) || null, // 钱包批次无 quota 概念，size=balance
          used: 0,
          unit: 'points',
          cycleStart: effMs ? new Date(effMs).toISOString().slice(0, 10) : '',
          cycleEnd: expMs ? new Date(expMs).toISOString().slice(0, 10) : '',
          // ★归一后的到期毫秒（积分过期提醒直接读这个）
          cycleEndMs: Number.isFinite(expMs) ? expMs : null,
        };
      });
      return {
        ok: true,
        total: Number(d.total_balance) || 0,
        capacity: null,
        used: null,
        list,
        free: list.length,
        paid: 0,
        perPackage: true,
        source: 'agent-assetmgr/wallet-instances',
        summary: list.map((x) => ({ code: x.packageName, total: x.size, remain: x.remain, used: 0 })),
      };
    } catch (err) {
      throw classify(err);
    }
  },

  /**
   * 探测凭证会话状态（供到期监控使用）。
   * access_token JWT 本地解 exp（24h），refresh_token JWT 本地解 exp（30 天）；
   * 两者取较早者作为 expiresAt（即 24h，但每天签到都会自动续，真正要盯的是 refresh 的 30 天）。
   * refresh_token 无法本地判定吊销，网络校验交给每日签到流程（失败即触发 invalid 告警）。
   * @returns {Promise<{ok:boolean, isLogin:boolean, expiresAt:number|null}>}
   */
  async probeSession(task) {
    const { refreshToken, token } = task.config;
    if (!refreshToken && !token) {
      return { ok: false, isLogin: false, expiresAt: null, error: '未配置凭证' };
    }
    // 主判定：refresh_token 的 JWT exp（无网络、与服务端一致）
    const rtClaims = refreshToken ? decodeJwtClaims(refreshToken) : null;
    const refreshExpMs = rtClaims && rtClaims.exp ? rtClaims.exp * 1000 : null;
    const atClaims = token ? decodeJwtClaims(token) : null;
    const accessExpMs = atClaims && atClaims.exp ? atClaims.exp * 1000 : null;
    if (refreshToken && !refreshExpMs) {
      // refresh_token 存在但解析不出 exp：可能格式不对，做一次网络校验兜底
      try {
        const client = new AutoClawClient({ refreshToken, deviceId: deviceIdFor(task) });
        await client.refreshAccessToken();
        return { ok: true, isLogin: true, expiresAt: null };
      } catch (err) {
        const e = classify(err);
        if (e.kind === 'invalid') {
          return { ok: false, isLogin: false, expiresAt: null, error: e.message };
        }
        throw e;
      }
    }
    if (refreshExpMs && refreshExpMs <= Date.now()) {
      return { ok: false, isLogin: false, expiresAt: refreshExpMs, error: 'refresh_token 已过期' };
    }
    // 有效：expiresAt 用 refresh 的 30 天窗口（access 每天自动续，不构成到期风险）
    return { ok: true, isLogin: true, expiresAt: refreshExpMs || accessExpMs || null };
  },
};
