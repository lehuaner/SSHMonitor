/**
 * OfficeAce（华为云 AgentArts · Claw 个人版）Provider —— 包装 lib/checkin/officeace.js。
 *
 * 与其他 Provider 的关键差异（实现时务必注意）：
 *   1. **凭证是「一次性 AKSK + 单次有效 refresh_token」的组合**，不是 cookie：
 *      · `refresh_token` 30 天级，但**每用一次就轮换**（旧值立即作废，`STS5.1806 the refresh token has been used`）
 *      · 因此每次调用后必须把 `client.getState()` 回写 `task.config` 并由调用方落盘
 *        （本 provider 的每个方法都在 finally 里 `persist()`，与 CodeArts 的 cookies 回写同构）
 *      · `dpopJwk` 与 refresh_token **一一绑定**（jkt 校验），两者必须同生同死
 *   2. **无需用户粘贴任何凭证**：填华为账号 + 密码即可 —— `ensureCredentials()` 会走纯协议登录
 *      （华为 ID → CAS/OAuth 落地 → PKCE 授权码 → STS）自动签发 refresh_token + DPoP 密钥。
 *      与 CodeArts 共用 `hwid_cas_sid` 设备信任令牌（首次登录成功后自动回填，之后免新设备验证）。
 *   3. **探活不消耗凭证**：`probeSession` 只本地解 refresh_token 的 JWT exp，绝不 refresh（否则会把
 *      用户的 RT 白白用掉一次）。
 *   4. 签到接口在私有 V11 签名的业务网关上，与平台面（标准 SDK-HMAC）完全隔离；
 *      协议细节与坑位见 `../checkin/officeace.js` 文件头与 `examples/officeace_v11_algorithm.md`。
 *
 * 业务口径（2026-09-19 全链路实测）：
 *   · 每日签到 = `POST /v1/subscription/bonus/claim`（空 body），奖励 1000 积分，当日 23:59:59（北京）过期
 *   · 新用户首次签到还会同时拿到「新用户专属福利」4000 积分（30 天）
 *   · 幂等：当日重复 claim 返回 `200 {"bonus_skus":[]}`；已签判定看 `bonus_skus` 里当日 daily 批次
 */
import { OfficeAceClient, POINTS_ATTR } from '../checkin/officeace.js';
import { TIMEZONES, TIMES, THRESHOLDS, EXPIRY_DAYS } from './common.js';

// 验证会话缓存：requestVerifyCode 与 submitVerifyCode 之间必须复用同一个客户端
// （PKCE verifier / pageToken / authDevices 都在客户端内存里，换实例就失效）
const VERIFY_TTL_MS = 10 * 60 * 1000;
const pendingVerify = new Map(); // taskId -> { client, at }

function gcPending() {
  const now = Date.now();
  for (const [id, p] of pendingVerify) if (now - p.at > VERIFY_TTL_MS) pendingVerify.delete(id);
}

function buildClient(task) {
  const c = task.config || {};
  return new OfficeAceClient({
    account: c.account,
    password: c.password,
    hwidCasSid: c.hwidCasSid,
    localStorageId: c.localStorageId,
    refreshToken: c.refreshToken,
    dpopJwk: parseJwk(c.dpopJwk),
    accessKey: c.accessKey,
    secretKey: c.secretKey,
    securityToken: c.securityToken,
    credentialsExpMs: c.credentialsExpMs,
    projectId: c.projectId,
    modelAppKey: c.modelAppKey,
    modelAppSecret: c.modelAppSecret,
    fpSeed: c.fpSeed || 'officeace-checkin',
    verbose: !!c.debug,
  });
}

/** DPoP 私钥：表单里可能粘成 JSON 字符串，统一转对象 */
function parseJwk(v) {
  if (!v) return undefined;
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return undefined; }
}

/**
 * 把客户端的最新状态回写 task.config。
 * ★refresh_token 单次有效：轮换后的新值必须立刻落盘，否则下一次刷新必然失败（凭证自毁）。
 */
function persist(task, client) {
  try {
    const st = client.getState();
    for (const [k, v] of Object.entries(st)) task.config[k] = v;
    if (st.credentialsExpMs) task.tokenExpiredAt = st.credentialsExpMs;
    if (st.refreshToken) {
      const exp = client.refreshTokenExpMs();
      if (exp) task.config.refreshTokenExpiresAt = exp;
    }
  } catch { /* 回写失败不影响主流程 */ }
}

/** 归一化错误：保留客户端已标注的 kind，其余按凭证无效/临时失败分类 */
function classify(err) {
  const msg = (err && err.message ? err.message : String(err)).trim();
  const e = new Error(err && err.needVerify
    ? `${msg}（设备未受信，请在该任务上点「设备验证」完成一次验证）`
    : msg);
  if (err && err.kind) e.kind = err.kind;
  if (err && err.needVerify) { e.needVerify = true; e.authDevices = err.authDevices || []; }
  if (err && err.riskCaptcha) e.riskCaptcha = true;
  if (e.kind) return e;
  e.kind = /refresh token has been used|invalid jkt|STS5\.18|HTTP 401|HTTP 403|凭证|未配置|账号或密码/i.test(msg)
    ? 'invalid' : 'transient';
  return e;
}

/** 福利批次 + 套餐配额 → 统一的「权益包」结构（积分到期提醒的数据源） */
function toPackages(subscription) {
  const now = Date.now();
  const list = [];
  for (const b of subscription.bonus_skus || []) {
    const expMs = b.expired_time ? Date.parse(b.expired_time) : null;
    list.push({
      kind: 'credit',
      packageCode: b.cbc_resource_id || b.activity_id,
      packageName: b.activity_name || b.activity_id,
      remain: Math.max(0, (Number(b.points) || 0) - (Number(b.current_value) || 0)),
      size: Number(b.points) || null,
      used: Number(b.current_value) || 0,
      unit: 'points',
      cycleStart: b.effective_time ? new Date(b.effective_time).toISOString().slice(0, 10) : '',
      cycleEnd: expMs ? new Date(expMs).toISOString().slice(0, 10) : '',
      cycleEndMs: Number.isFinite(expMs) ? expMs : null,
    });
  }
  for (const sku of subscription.skus || []) {
    for (const q of sku.quotas || []) {
      if (q.sku_attr_code !== POINTS_ATTR) continue;
      const size = Number(q.sku_value) || 0;
      const used = Number(q.current_value) || 0;
      list.push({
        kind: 'credit',
        packageCode: `${sku.sku_code || 'sku'}:${POINTS_ATTR}`,
        packageName: `${sku.sku_name || sku.sku_code}（套餐配额）`,
        remain: Math.max(0, size - used),
        size,
        used,
        unit: 'points',
        cycleStart: '',
        cycleEnd: '',
        cycleEndMs: null,
      });
    }
  }
  return list.filter((p) => !p.cycleEndMs || p.cycleEndMs > now);
}

export default {
  id: 'officeace',
  name: 'OfficeAce',
  capabilities: ['checkin', 'credits', 'credentialTest', 'status', 'totalCredits', 'sessionProbe', 'packages', 'verifyCode'],
  // 会话到期巡检看的长期凭证 = refresh_token（DPoP 私钥与它绑定，一起声明避免被当空配置）
  sessionCredentialKeys: ['refreshToken', 'dpopJwk'],
  // ★卡片凭证行（维护链终点口径）：OfficeAce 的 AKSK（约 2h）是每次签到前必重签的派生腿，
  //   绝不能上卡片（一上就常驻「已到期」）；RT 到期后还有「华为账号+密码」自动纯协议重登重签，
  //   链条不断 —— 所以显示的 RT 到期日是**人工下界**（只有自动重登被设备验证挡住才真需要动手）。
  //   到期值：优先本地解 RT JWT 写入 config.refreshTokenExpiresAt；
  //   探活（probeSession）把同一个值写进 cookieExpiresAt（字段名叫 cookie，实为 RT 到期）。
  credDisplay: {
    ladder: [
      { label: 'Refresh Token', fields: ['refreshTokenExpiredAt', 'config.refreshTokenExpiresAt', 'cookieExpiresAt'], if: 'hasRefreshToken',
        title: 'OfficeAce 维护链终点（人工下界）：refresh_token 30 天且单次有效（每续一次即轮换并回写，所以剩余天数会复位）；到期时若配了华为账号密码会自动重登重签（链条不断、无需人工），只有自动重登被新设备验证挡住才要点「设备验证」。AKSK（2h）是每次签到前重签的派生腿，不是终点' },
    ],
  },
  namePlaceholder: '例：OfficeAce · 华为云主账号',
  configSchema: [
    { key: 'account', label: '华为账号（手机号/邮箱）', type: 'text', required: true,
      placeholder: '如 138xxxx0000',
      hint: '★只需填这一项 + 密码，首次签到时自动完成纯协议登录并签发 30 天凭证，无需从客户端粘贴任何东西（自动补 0086 前缀）。仅本地保存。' },
    { key: 'password', label: '密码', type: 'password', required: true,
      hint: '仅本地保存，用于凭证过期时自动重新登录。' },
    { key: 'hwidCasSid', label: 'hwid_cas_sid（设备信任令牌 · 可留空）', type: 'password', required: false,
      placeholder: '留空即可，首次登录成功后自动回填',
      hint: '华为侧「受信设备」令牌（约 10 年有效）。首次自动登录成功后系统会回填，之后重登跳过新设备验证码。与 CodeArts 任务是同一个值，可从 CodeArts 账号直接复制。' },
    { key: 'fpSeed', label: '指纹种子 (fpSeed)', type: 'text', default: 'officeace-checkin', required: true,
      hint: '设备指纹的唯一输入，同一部署固定即可。改动它等价于换设备，可能重新触发设备验证。' },
    { key: 'refreshToken', label: 'Refresh Token（可选 · 高级）', type: 'password', required: false,
      placeholder: '留空即可；仅在你想复用 OfficeAce 客户端已签发的凭证时填写',
      hint: '30 天长期凭证，**单次有效**（每次签到自动轮换并回写）。填写时必须同时填 DPoP 私钥，否则无法使用。' },
    { key: 'dpopJwk', label: 'DPoP 私钥 JWK（可选 · 高级）', type: 'password', required: false,
      placeholder: '形如 {"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…"}',
      hint: '与上面的 Refresh Token 一一绑定（服务端校验 jkt），两者必须成对填写。' },
    { key: 'projectId', label: 'Project ID（可选）', type: 'text', required: false,
      placeholder: '留空 = cn-southwest-2 默认项目',
      hint: '业务网关按项目定位订阅。一般无需填写；账号有多个项目且签到报「无福利批次」时才需要指定。' },
    { key: 'time', label: '签到时间', type: 'select', default: '09:00', required: true,
      options: TIMES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'timezone', label: '时区(IANA)', type: 'select', default: 'Asia/Shanghai', required: true,
      options: TIMEZONES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'failThreshold', label: '连续失败告警阈值', type: 'select', default: 3,
      options: THRESHOLDS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'cookieExpiryNotify', label: '凭证到期提前邮件通知', type: 'toggle', default: true,
      hint: 'refresh_token（30 天）临期时提醒；到期后需重新提供账号密码或再登录一次。' },
    { key: 'cookieExpiryNotifyDays', label: '凭证到期前何时通知', type: 'select', default: 3,
      options: EXPIRY_DAYS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'notifyOnSuccess', label: '成功也发通知', type: 'toggle', default: false },
  ],

  /** 执行一次签到（签到前自动续期/重登，并回写轮换后的凭证） */
  async checkin(task) {
    const client = buildClient(task);
    try {
      const res = await client.checkin();
      return {
        ok: true,
        alreadyCheckedIn: res.alreadyCheckedIn,
        credits: res.credits ?? null,
        reward: res.reward ?? null,
        streak: null,
      };
    } catch (err) {
      throw classify(err);
    } finally {
      persist(task, client);
    }
  },

  /** 当前积分余额（套餐配额剩余 + 未过期福利批次剩余） */
  async getCredits(task) {
    const client = buildClient(task);
    try {
      const c = await client.getCredits();
      return { ok: true, credits: c.credits ?? null };
    } catch (err) {
      throw classify(err);
    } finally {
      persist(task, client);
    }
  },

  /** 测试凭证有效性：订阅可读即视为有效 */
  async checkCredential(task) {
    const client = buildClient(task);
    try {
      const st = await client.getStatus();
      return { ok: true, subscribeStatus: st.subscribeStatus, credits: st.credits };
    } catch (err) {
      throw classify(err);
    } finally {
      persist(task, client);
    }
  },

  /** 查询今日签到状态 + 当前积分（不领取） */
  async checkStatus(task) {
    const client = buildClient(task);
    try {
      const st = await client.getStatus();
      const daily = (st.bonus || []).find((b) => b.activityId === 'bonus-daily-checkin-2026');
      return {
        ok: true,
        checked_in: !!st.checkedIn,
        credits: st.credits,
        statusDescription: st.checkedIn
          ? `每日签到 ${daily ? daily.points : 1000} 积分已领（${daily && daily.expiredTime ? new Date(daily.expiredTime).toISOString().slice(0, 10) : '今日'} 前有效）`
          : `未签到 · 当前 ${st.credits} 积分（${st.subscribeStatus === 'SUBSCRIBED' ? '已订阅' : '无套餐'}）`,
      };
    } catch (err) {
      throw classify(err);
    } finally {
      persist(task, client);
    }
  },

  /** 总积分（与 getCredits 同口径：OfficeAce 不分钱包/总额两套） */
  async getTotalCredits(task) {
    const client = buildClient(task);
    try {
      const c = await client.getCredits();
      return { ok: true, total: Number(c.credits) || 0 };
    } catch (err) {
      throw classify(err);
    } finally {
      persist(task, client);
    }
  },

  /** 权益包明细（每日/新用户福利批次各有独立到期时间） */
  async getPackages(task) {
    const client = buildClient(task);
    try {
      const sub = await client.getSubscription();
      const list = toPackages(sub);
      const total = list.reduce((s, p) => s + (p.remain || 0), 0);
      return {
        ok: true,
        total,
        capacity: null,
        used: null,
        list,
        free: list.length,
        paid: (sub.skus || []).length,
        perPackage: true,
        source: 'officeace-001/v1/subscription',
        summary: list.map((x) => ({ code: x.packageName, total: x.size, remain: x.remain, used: x.used })),
      };
    } catch (err) {
      throw classify(err);
    } finally {
      persist(task, client);
    }
  },

  /**
   * 探测凭证会话状态（供到期监控）。
   * 只本地解 refresh_token 的 JWT exp（30 天）——**绝不主动 refresh**（RT 单次有效，探活会烧掉它）。
   * 无 RT（首次使用前）时退回本地 AKSK 缓存判定；两者都没有才报未配置。
   * @returns {Promise<{ok:boolean, isLogin:boolean, expiresAt:number|null}>}
   */
  async probeSession(task) {
    const client = buildClient(task);
    try {
      const r = await client.probeSession();
      return r;
    } catch (err) {
      throw classify(err);
    } finally {
      persist(task, client);
    }
  },

  // ------------------------------------------------------------------
  // 设备验证接口（★仅当 hwid_cas_sid 也失效/换设备时才需人工填一次验证码）
  //   与 CodeArts 同源：同一套华为 ID 端点，成功后本机会受信，下次重登免验证。
  // ------------------------------------------------------------------

  /**
   * 「获取验证码」：尝试登录；设备已受信则直接签发凭证；否则触发下发验证码并返回设备列表。
   */
  async requestVerifyCode(task) {
    gcPending();
    const client = buildClient(task);
    try {
      const r = await client.requestVerifyCode();
      persist(task, client);   // 已受信时顺手签发的新 RT / hwid_cas_sid 也要存下来
      if (r.ok && r.alreadyTrusted) {
        task.credentialInvalid = false; task.failCount = 0; task.notifiedInvalid = false; // 已重签凭证，解除失效锁定
        return { ok: true, alreadyTrusted: true, message: '设备已受信（hwid_cas_sid 有效），无需验证码，已重新签发凭证' };
      }
      if (!r.ok) {
        return { ok: false, error: r.error || '获取验证码失败', errorCode: r.errorCode, riskCaptcha: r.riskCaptcha };
      }
      const devices = r.authDevices || [];
      pendingVerify.set(task.id, { client, at: Date.now() });
      const phoneOnly = devices.length > 0 && devices.every((d) => Number(d.accountType) === 2);
      return {
        ok: true,
        authDevices: devices,
        hint: phoneOnly
          ? '验证码已通过短信发送到绑定手机号，请填入收到的 6 位数字'
          : '验证码已下发至下列设备，请填入收到的 6 位数字',
      };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /**
   * 「提交验证码」：opType=1 重放 → 信任本机 → 换票签发 refresh_token（回写 task.config）。
   */
  async submitVerifyCode(task, code, deviceIndex = 0) {
    gcPending();
    const p = pendingVerify.get(task.id);
    if (!p) return { ok: false, error: '验证会话已过期，请重新点击「获取验证码」' };

    const r = await p.client.submitVerifyCode(code, deviceIndex);
    persist(task, p.client);
    if (r.ok) {
      pendingVerify.delete(task.id);
      // 验证成功已签发新凭证 → 解除失效锁定，让调度重新排期自动签到
      task.credentialInvalid = false;
      task.failCount = 0;
      task.notifiedInvalid = false;
      return { ok: true, message: '设备验证通过，凭证已签发' };
    }
    if (r.landingFailed) {
      return { ok: false, landingFailed: true, error: `验证码已通过，但凭证签发失败：${r.error}` };
    }
    return { ok: false, error: r.error || '验证码校验失败', errorCode: r.errorCode };
  },

  /** 丢弃当前验证会话（用户取消/超时） */
  cancelVerifyCode(task) {
    return { ok: pendingVerify.delete(task.id) };
  },
};
