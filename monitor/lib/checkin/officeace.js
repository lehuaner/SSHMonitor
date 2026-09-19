/**
 * OfficeAce（华为云 AgentArts · Claw 个人版）签到客户端 —— 零第三方依赖（node:https + node:crypto）。
 *
 * 协议还原来源：`examples/officeace.saz` / `officeace2.saz` 抓包 + OfficeAce 客户端 JS 逆向，
 * 完整字段级目录见 `examples/analyze_officeace.md`，V11 签名算法见 `examples/officeace_v11_algorithm.md`。
 *
 * 两条凭证路径（本客户端都支持，Provider 侧优先 refresh_token）：
 *   A. **纯协议账号密码登录**（本文件 `login()`）：华为云 ID → CAS/OAuth 落地 → PKCE 授权码
 *      → STS 换 AKSK + refresh_token。全程无浏览器、无客户端，与 CodeArts 的自动重登同源
 *      （复用 `codearts.js` 的 HttpClient / buildFp / 登录链常量）。
 *   B. **refresh_token 续期**（`refresh()`）：日常签到走这条，30 天级长期凭证。
 *
 * ★★ 四条必须遵守的实测结论（2026-09-19 全链路验证）★★
 *   1. **refresh_token 单次有效**：每次刷新都会下发新 RT，旧 RT 立即作废
 *      （`STS5.1806 the refresh token has been used`）。调用方必须在每次刷新后立刻持久化
 *      `task.config.refreshToken`（本客户端通过 `getState()` 暴露）。
 *   2. **RT 与 DPoP 密钥绑定**（jkt 校验）：换 key 报 `STS5.1806 invalid jkt`。
 *      因此 DPoP 私钥（EC P-256 JWK，含 `d`）必须与 RT 一起持久化、一起沿用。
 *   3. **V11-HMAC-SHA256 私有签名**：`officeace-001…` 网关订阅面只认 V11
 *      （标准 `SDK-HMAC-SHA256` 被拒 `APIG.0624`）。密钥派生是**两轮 HMAC + 尾字节 \x01**，
 *      且 `canonicalUri` 强制补尾部 `/`（少一个斜杠就是 `verify ak sk signature failed`）。
 *   4. **请求头名大小写敏感**：网关 WAF 会拒绝被小写化的头名（`APIG.0301 format is incorrect`）。
 *      `node:https` 的 HTTP/1.1 会原样保留 keys 的大小写，因此签名头必须用
 *      `X-Sdk-Date` / `X-Security-Token` / `X-Project-ID` 这种原始大小写发送（见 `_v11Headers`）。
 *
 * 业务口径：
 *   · 每日签到 = `POST /v1/subscription/bonus/claim`（空 body），奖励 1000 积分，当日 23:59:59（北京）过期
 *   · 已签判定 = `GET /v1/subscription` 的 `bonus_skus[]` 中存在 `activity_id=bonus-daily-checkin-2026`
 *     且 `cbc_resource_id` 内嵌**北京日期**
 *   · 幂等 = 当日重复 claim 返回 `200 {"bonus_skus":[]}`
 */
import crypto from 'node:crypto';
import { HttpClient, buildFp, parseHwidConfig, CodeArtsClient } from './codearts.js';

// ==========================================================================
// 常量
// ==========================================================================

/** AgentArts 平台面（标准 SDK-HMAC-SHA256） */
export const AGENTARTS = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';
/** OfficeAce 业务网关（订阅面 = 私有 V11；模型面 = Basic） */
export const GATEWAY = 'https://officeace-001.cn-southwest-2.huaweicloud-agentarts.com';
export const GATEWAY_HOST = 'officeace-001.cn-southwest-2.huaweicloud-agentarts.com';
export const STS_TOKENS = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
export const IAM_PROJECTS = 'https://iam.myhuaweicloud.com/v3/projects';
export const IAM_SECURITY_TOKENS = 'https://iam.myhuaweicloud.com/v3.0/OS-CREDENTIAL/securitytokens';

export const OAUTH_CLIENT_ID = 'pdp5_for_agentarts';
export const REDIRECT_URI = `${AGENTARTS}/v1/claw/auth/callback`;
export const REGION = 'cn-southwest-2';
/** cn-southwest-2 项目 id（抓包/实测值；可用 `discoverProjectId()` 重新发现） */
export const DEFAULT_PROJECT_ID = '01a0ae69e2a57c2e82016d356fbc2ba7';

/** 每日签到活动 id（`activity_name=每日签到有礼`，points=1000） */
export const DAILY_ACTIVITY_ID = 'bonus-daily-checkin-2026';
/** 新用户一次性福利（首签时与 daily 一起返回，4000 积分 / 30 天） */
export const NEW_USER_ACTIVITY_ID = 'bonus-new-user-2026';
/** 积分配额字段名 */
export const POINTS_ATTR = 'officeace_points';

// 华为云登录链（与 codearts.js 同源，只是 service 换成 AgentArts 的 PKCE authorize）
const AUTHUI = 'https://auth.huaweicloud.com/authui';
const ID1 = 'https://id1.cloud.huawei.com';
const AJAX_NEW = `${ID1}/UnifiedIDMPortal/ajaxHandler`;
const OAUTH_LOGIN = 'https://oauth-login1.cloud.huawei.com';
const REQ_CLIENT_TYPE = '88';
const LOGIN_CHANNEL = '88000000';
const HW_CLIENT_ID = '103493351';          // 华为 ID 侧 clientID（与 OAuth 的 pdp5_for_agentarts 不同层）
const LANG = 'zh-cn';
const REGION_CODE = 'cn';
const HW_SCOPE = 'https://www.huawei.com/auth/account/unified.profile'
  + '+https://www.huawei.com/auth/account/risk.idstate'
  + '+LoginState';

/** STS 错误码：RT 已被使用 / jkt 不匹配 —— 都属于「凭证已失效」，不可重试 */
export const INVALID_CREDENTIAL_CODES = ['STS5.1806'];

// ==========================================================================
// DPoP（EC P-256 + dpop+jwt，RFC 9449 子集）
// ==========================================================================

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export class DpopKey {
  /** @param {{kty:string,crv:string,x:string,y:string,d:string}} jwk 私有 JWK */
  constructor(jwk) {
    this.jwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
    this.privateJwk = { ...this.jwk, d: jwk.d };
    this._keyObject = crypto.createPrivateKey({ key: this.privateJwk, format: 'jwk' });
  }

  static generate() {
    const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const j = k.privateKey.export({ format: 'jwk' });
    return new DpopKey(j);
  }

  static fromJwk(jwk) {
    if (!jwk || !jwk.d || !jwk.x || !jwk.y) return null;
    try { return new DpopKey(jwk); } catch { return null; }
  }

  /** RFC 7638 thumbprint（服务端 `invalid jkt` 报错里回显的就是它） */
  thumbprint() {
    const canon = JSON.stringify({ crv: 'P-256', kty: 'EC', x: this.jwk.x, y: this.jwk.y });
    return crypto.createHash('sha256').update(canon).digest('base64url');
  }

  /** 生成 DPoP proof JWT（htm/htu 必须与本次请求完全一致） */
  proof({ htm, htu, nonce }) {
    const header = b64u(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: this.jwk }));
    const payload = b64u(JSON.stringify({
      htm, htu, iat: Math.floor(Date.now() / 1000), jti: crypto.randomBytes(16).toString('hex'),
      ...(nonce ? { nonce } : {}),
    }));
    const signingInput = `${header}.${payload}`;
    const der = crypto.sign('sha256', Buffer.from(signingInput), this._keyObject);
    // ES256 要求 raw r||s（各 32 字节），Node 给的是 DER（含 0x00 符号位）
    const rs = derEcdsaToRaw64(der);
    return `${signingInput}.${rs.toString('base64url')}`;
  }
}

/** DER(SEQUENCE{INTEGER r, INTEGER s}) → 定长 64 字节 raw 签名 */
function derEcdsaToRaw64(der) {
  let i = 2;                                     // 0x30 <len>
  if ((der[1] & 0x80) !== 0) i = 2 + (der[1] & 0x7f);   // 长形式长度（P-256 不会出现，兼容兼顾）
  const rl = der[i + 1];
  const r = der.subarray(i + 2, i + 2 + rl);
  const j = i + 2 + rl;                          // 0x02 <sl> <s>
  const sl = der[j + 1];
  const s = der.subarray(j + 2, j + 2 + sl);
  const pad = (b) => (b.length >= 32
    ? b.subarray(b.length - 32)
    : Buffer.concat([Buffer.alloc(32 - b.length), b]));
  return Buffer.concat([pad(r), pad(s)]);
}

// ==========================================================================
// 签名：V11-HMAC-SHA256（网关私有）与 SDK-HMAC-SHA256（华为云标准）
// ==========================================================================

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

/** 每段 decode→encode，等价前端 `uriEncode`（保留 `/` 分隔） */
function uriEncodePath(path) {
  return path.split('/').map((seg) => {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { /* 原样 */ }
    return encodeURIComponent(decoded).replace(/!/g, '%21').replace(/'/g, '%27')
      .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
  }).join('/');
}

function canonicalQuery(searchParams) {
  const entries = [...searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)));
  return entries.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * V11 签名（两轮 HMAC）。返回 `{ authorization, headers }`。
 *
 * @param {object} p
 * @param {'GET'|'POST'} p.method
 * @param {string} p.url           完整 URL（含 query）
 * @param {object} p.headers       参与签名的头（**键名大小写随意**，内部按小写名排序）
 * @param {string} p.body          请求体原文（无体传 ''）
 * @param {string} p.accessKey
 * @param {string} p.secretKey
 * @param {string} p.sdkDate       yyyyMMddTHHmmssZ
 */
export function signV11({ method, url, headers, body = '', accessKey, secretKey, sdkDate }) {
  const u = new URL(url);
  const signed = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = {};
  for (const k of signed) lower[k] = String(headers[Object.keys(headers).find((x) => x.toLowerCase() === k)]);
  let cu = uriEncodePath(u.pathname);
  if (!cu.endsWith('/')) cu += '/';                       // ★坑：强制尾斜杠
  const canonicalRequest = [
    method.toUpperCase(), cu, canonicalQuery(u.searchParams),
    signed.map((k) => `${k}:${lower[k]}\n`).join(''),
    signed.join(';'), sha256hex(body),
  ].join('\n');
  const scope = `${sdkDate.slice(0, 8)}/${REGION}/apic`;
  const stringToSign = ['V11-HMAC-SHA256', sdkDate, scope, sha256hex(canonicalRequest)].join('\n');
  const k1 = hmac(Buffer.from(accessKey, 'utf8'), Buffer.from(secretKey, 'utf8'));
  const k2 = hmac(k1, Buffer.from(scope + '\x01', 'utf8')).toString('hex');
  const signature = hmac(Buffer.from(k2, 'utf8'), Buffer.from(stringToSign, 'utf8')).toString('hex');
  return {
    scope,
    authorization: `V11-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
    canonicalRequest, stringToSign,
  };
}

/** 标准 SDK-HMAC-SHA256（IAM / agentarts 平台面，单轮 HMAC） */
export function signSdkHmac({ method, url, headers, body = '', accessKey, secretKey, sdkDate, region = REGION }) {
  const u = new URL(url);
  const signed = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = {};
  for (const k of signed) lower[k] = String(headers[Object.keys(headers).find((x) => x.toLowerCase() === k)]);
  let cu = uriEncodePath(u.pathname);
  if (!cu.endsWith('/')) cu += '/';                       // ★同 V11：APIG 侧规范化带尾斜杠
  const canonicalRequest = [
    method.toUpperCase(), cu, canonicalQuery(u.searchParams),
    signed.map((k) => `${k}:${lower[k]}\n`).join(''),
    signed.join(';'), sha256hex(body),
  ].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', sdkDate, sha256hex(canonicalRequest)].join('\n');
  const signature = hmac(Buffer.from(secretKey, 'utf8'), Buffer.from(stringToSign, 'utf8')).toString('hex');
  return {
    authorization: `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
    canonicalRequest, stringToSign,
  };
}

/** UTC 时间戳（yyyyMMddTHHmmssZ） */
export function sdkDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** 北京时间「YYYYMMDD」—— 每日签到批次的日期口径 */
export function beijingYmd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
}

/**
 * 解 JWT claims（无需验签，只读 exp / cnf.jkt / user_profile）。
 * refresh_token 就是 JWT：`exp` 为 30 天窗口，`cnf.jkt` 是绑定的 DPoP 密钥指纹。
 */
export function decodeJwtClaims(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof claims.user_profile === 'string') {
      try { claims.user_profile = JSON.parse(Buffer.from(claims.user_profile, 'base64url').toString('utf8')); } catch { /* 保留原串 */ }
    }
    return claims;
  } catch { return null; }
}

// ==========================================================================
// OfficeAce 客户端
// ==========================================================================

export class OfficeAceClient {
  /**
   * @param {object} opts
   * @param {string} [opts.account]        华为账号/手机号（纯协议登录用）
   * @param {string} [opts.password]
   * @param {string} [opts.hwidCasSid]     ★设备信任令牌（约 10 年），有则免新设备验证
   * @param {string} [opts.refreshToken]   长期凭证（30 天，单次有效需轮换）
   * @param {object} [opts.dpopJwk]        与 RT 绑定的 DPoP 私有 JWK（含 d）
   * @param {string} [opts.accessKey]      缓存的 STS AK
   * @param {string} [opts.secretKey]
   * @param {string} [opts.securityToken]
   * @param {number|string} [opts.credentialsExpMs] 上述三元组的到期毫秒
   * @param {string} [opts.projectId]
   * @param {string} [opts.fpSeed]
   * @param {boolean} [opts.verbose]
   */
  constructor(opts = {}) {
    this.account = opts.account || '';
    this.password = opts.password || '';
    this.hwidCasSid = opts.hwidCasSid || '';
    this.localStorageId = opts.localStorageId || '';
    this.refreshToken = opts.refreshToken || '';
    this.dpop = DpopKey.fromJwk(opts.dpopJwk) || null;
    this.creds = {
      accessKey: opts.accessKey || '',
      secretKey: opts.secretKey || '',
      securityToken: opts.securityToken || '',
      expMs: Number(opts.credentialsExpMs) || 0,
    };
    this.projectId = opts.projectId || DEFAULT_PROJECT_ID;
    this.fpSeed = opts.fpSeed || 'officeace-checkin';
    this.modelAppKey = opts.modelAppKey || '';
    this.modelAppSecret = opts.modelAppSecret || '';
    this.verbose = !!opts.verbose;
    this.http = new HttpClient({ timeout: opts.timeout || 25000 });
    this.base = {};
    this._fp = null;
    if (this.hwidCasSid) this.http.restoreCookies({ hwid_cas_sid: this.hwidCasSid });
    if (opts.cookies) this.http.restoreCookies(opts.cookies);
  }

  _log(msg) { if (this.verbose) console.log(`[officeace] ${msg}`); }

  /** 可持久化状态（Provider 每次操作后回写 task.config） */
  getState() {
    const st = {
      hwidCasSid: this.hwidCasSid || undefined,
      localStorageId: this.localStorageId || undefined,
      refreshToken: this.refreshToken || undefined,
      dpopJwk: this.dpop
        ? { kty: 'EC', crv: 'P-256', x: this.dpop.privateJwk.x, y: this.dpop.privateJwk.y, d: this.dpop.privateJwk.d }
        : undefined,
      accessKey: this.creds.accessKey || undefined,
      secretKey: this.creds.secretKey || undefined,
      securityToken: this.creds.securityToken || undefined,
      credentialsExpMs: this.creds.expMs || undefined,
      projectId: this.projectId || undefined,
      modelAppKey: this.modelAppKey || undefined,
      modelAppSecret: this.modelAppSecret || undefined,
    };
    for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
    return st;
  }

  _credsFresh() {
    return !!(this.creds.accessKey && this.creds.secretKey && this.creds.securityToken
      && this.creds.expMs > Date.now() + 5 * 60 * 1000);
  }

  /** refresh_token 的到期毫秒（本地解 JWT，不消耗网络与单次有效的 RT） */
  refreshTokenExpMs() {
    const cl = decodeJwtClaims(this.refreshToken);
    return cl && cl.exp ? cl.exp * 1000 : null;
  }

  /** 华为云账号名（从 RT claims 的 user_profile 取，供面板展示） */
  accountName() {
    const cl = decodeJwtClaims(this.refreshToken);
    const up = cl && typeof cl.user_profile === 'object' ? cl.user_profile : null;
    return (up && up.account_name) || null;
  }

  static normalizeAccount(account) { return CodeArtsClient.normalizeAccount(account); }

  // ------------------------------------------------------------------
  // 凭证：确保有一副可用的 STS AKSK
  // ------------------------------------------------------------------

  /**
   * 有缓存且未过期 → 直接用；否则 refresh_token 续期；再不行 → 账号密码登录。
   * @returns {Promise<{via:string}>}
   */
  async ensureCredentials() {
    if (this._credsFresh()) return { via: 'cache' };
    if (this.refreshToken) {
      if (!this.dpop) {
        throw credentialError('refresh_token 缺少配套的 DPoP 私钥（dpopJwk），无法续期；请用「账号密码登录」重新签发一副完整凭证');
      }
      await this.refresh();
      return { via: 'refresh' };
    }
    if (this.account && this.password) {
      await this.login();
      return { via: 'login' };
    }
    throw credentialError('未配置凭证：需要 refresh_token + dpopJwk，或华为账号密码');
  }

  /** DPoP + refresh_token 换新 AKSK。★响应里的新 RT 必须立刻持久化（旧 RT 用后即废） */
  async refresh() {
    const j = await this._tokens({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
    this._applyTokens(j);
    this._log(`refresh ok，新凭证到期 ${new Date(this.creds.expMs).toISOString()}`);
    return { accessKey: this.creds.accessKey, expMs: this.creds.expMs, refreshToken: this.refreshToken };
  }

  // ------------------------------------------------------------------
  // ★纯协议登录：华为账号密码 → PKCE 授权码 → STS 凭证
  // ------------------------------------------------------------------

  /**
   * 全流程登录。与 CodeArts 的 `login()` 同源（同一套 id1/CAS 端点），差异只在：
   *   · service 包的是 AgentArts 的 `authui/v1/oauth2/authorize`（带 PKCE + state + redirect_uri）
   *   · 落地链末端不是业务站点票据，而是 OAuth `code`，要拿去 STS 换 AKSK + refresh_token
   *
   * @returns {Promise<{ok:boolean, refreshToken:string, expMs:number, jkt:string|null}>}
   */
  async login() {
    if (!this.account || !this.password) throw credentialError('未配置华为账号或密码');

    // ① OAuth 引导：state + PKCE
    const st = await this.http.postRawJson(`${AGENTARTS}/v1/claw/auth/state`, {},
      { headers: { 'Content-Type': 'application/json' } });
    let state = '';
    try { state = JSON.parse(st.text).state; } catch { /* 下面统一判 */ }
    if (!state) throw credentialError(`claw/auth/state 失败（HTTP ${st.status}）`);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorize = `${AUTHUI}/v1/oauth2/authorize?client_id=${OAUTH_CLIENT_ID}`
      + `&code_challenge=${challenge}&code_challenge_method=SHA-256&state=${state}`
      + `&scope=openid&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
    const casService = `${AUTHUI}/casLogin?service=${encodeURIComponent(authorize)}`;
    this._log('OAuth state 就绪');

    // ② 华为云登录链（与 codearts.js 步骤 ①~⑦ 逐一对应）
    await this.http.get(`${AUTHUI}/login.html?service=${encodeURIComponent(casService)}`);
    const info = await this._stepSdkBaseInfo(authorize);
    if (Number(info.isSuccess) !== 1 || !info.pageToken) {
      throw credentialError(`getSDKBaseInfo 失败：${info.errorDesc || info.errorCode || 'no pageToken'}`);
    }
    await this._stepDev();
    const ids = await this._stepLoginIds();
    const accountInfo = (ids.accountInfoList || [])[0] || {};
    const loginRes = await this._stepUnionLogin(casService, accountInfo);

    if (Number(loginRes.isSuccess) !== 1) {
      const code = String(loginRes.errorCode || '');
      if (code === '10002080' || code === '10002081') {
        const e = new Error('需要新设备验证（短信/邮箱验证码）：请补充 hwid_cas_sid 设备信任令牌，或在 OfficeAce 客户端登录一次本机');
        e.kind = 'invalid';
        e.needVerify = true;
        e.detail = loginRes.errorDesc;
        throw e;
      }
      if (code === '10000706') {
        const e = new Error('触发图片验证码风控（10000706），协议层无法继续，判定失败');
        e.kind = 'invalid';
        e.riskCaptcha = true;
        throw e;
      }
      const e = new Error(`密码登录失败：${loginRes.errorDesc || loginRes.errorCode || '未知'}`);
      e.kind = code === '10000400' ? 'invalid' : 'transient';
      throw e;
    }
    if (loginRes.localStorageID) this.localStorageId = loginRes.localStorageID;
    if (loginRes.needPopTrust) await this._stepTrustBrowser(accountInfo);
    this._log('华为 ID 登录成功，进入 OAuth 落地链');

    // ③ OAuth 落地：oauth-login1 authorize(HTML) → getLoginWay → remoteLogin → loginCallback
    //    → ajax/login 拿 code URL → casLogin 种 SSOTGC → 逐跳到 redirect_uri 取 code
    const oauthCode = await this._finishOauth(loginRes.callbackURL);
    this._log(`拿到 OAuth code：${String(oauthCode).slice(0, 8)}…`);

    // ④ 授权码 + PKCE verifier → STS 换 AKSK + refresh_token
    const j = await this._tokens({
      grant_type: 'authorization_code',
      code: oauthCode,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });
    this._applyTokens(j);
    this._log(`登录换票成功，凭证到期 ${new Date(this.creds.expMs).toISOString()}`);

    // ⑤ ★平台面注册：身份校验 + 客户端订阅（不跑则网关侧 UNSUBSCRIBED，claim 拿不到积分）
    try {
      await this.permissionValidate();
      await this.clientSubscription();
      this._log('客户端订阅注册完成');
    } catch (err) {
      this._log(`订阅注册失败（不阻断登录）：${err.message}`);
    }

    return {
      ok: true, refreshToken: this.refreshToken, expMs: this.creds.expMs,
      jkt: this.dpop ? this.dpop.thumbprint() : null,
    };
  }

  async _stepSdkBaseInfo(authorize) {
    const r = await this.http.get(`${AUTHUI}/getSDKBaseInfo?flowType=unionLogin`
      + `&service=${encodeURIComponent(authorize)}&site=mainland`);
    let info;
    try { info = JSON.parse(r.text); } catch { return { isSuccess: 0, _raw: String(r.text).slice(0, 200) }; }
    const cfg = parseHwidConfig(info.hwidConfig);
    this.base = {
      pageToken: info.pageToken || '', pageTokenKey: info.pageTokenKey || '',
      reqClientType: REQ_CLIENT_TYPE, loginChannel: LOGIN_CHANNEL, clientID: HW_CLIENT_ID,
      lang: LANG, languageCode: LANG, state: info.state || '',
    };
    if (cfg.cookieVersion) this.http.cversion = cfg.cookieVersion;
    if (cfg.localStorageID) this.localStorageId = cfg.localStorageID;
    return info;
  }

  async _stepDev() {
    if (!this._fp) this._fp = buildFp(this.fpSeed);
    const data = { ...this.base, fp: this._fp, localStorageID: this.localStorageId };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    const res = await this.http.postJson(
      `${AJAX_NEW}/common/dev?reflushCode=${Math.random().toFixed(15)}&cVersion=${this.http.cversion}`, data);
    if (res && res.sid) {
      this.hwidCasSid = res.sid;
      this.http.restoreCookies({ hwid_cas_sid: res.sid });
    }
    if (res && res.localStorageID) this.localStorageId = res.localStorageID;
    return res || {};
  }

  async _stepLoginIds() {
    const data = {
      ...this.base, userAccount: OfficeAceClient.normalizeAccount(this.account),
      password: this.password, localStorageID: this.localStorageId,
    };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    return this.http.postJson(
      `${AJAX_NEW}/login/getLoginIdsByPwd?reflushCode=${Math.random().toFixed(15)}&cVersion=${this.http.cversion}`, data);
  }

  async _stepUnionLogin(casService, accountInfo = {}) {
    const data = {
      ...this.base,
      userAccount: OfficeAceClient.normalizeAccount(this.account),
      password: this.password,
      service: casService,
      bsAcctService: casService.replace('/casLogin?', '/casLoginAPP?'),
      hwmeta: '', localLogin: 'false', quickAuth: 'false', isThirdBind: '0',
      opType: '0', scope: HW_SCOPE, access_type: 'offline',
      // ★必须是裸匿名账号（不能拼 anonymousEncryption），否则 10000000 loginFlowContext is empty
      anonymousLoginID: accountInfo.anonymousAccount || '',
      registerCountry: REGION_CODE, serial: String(accountInfo.serial ?? 0),
      localStorageID: this.localStorageId,
    };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    const res = await this.http.postJson(
      `${AJAX_NEW}/login/unionLoginByPwd?reflushCode=${Math.random().toFixed(15)}&cVersion=${this.http.cversion}`, data);
    if (res && res.localStorageID) this.localStorageId = res.localStorageID;
    return res;
  }

  async _stepTrustBrowser(accountInfo = {}) {
    const data = {
      ...this.base, userAccount: OfficeAceClient.normalizeAccount(this.account),
      operType: '1', trustBrowser: '1',
      anonymousLoginID: accountInfo.anonymousAccount || '',
      localStorageID: this.localStorageId,
    };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    return this.http.postJson(
      `${AJAX_NEW}/login/updateTrustBrowser?reflushCode=${Math.random().toFixed(15)}&cVersion=${this.http.cversion}`, data);
  }

  /**
   * ③ OAuth 落地链（与抓包 codearts首次登录 [115]~[141] 同构，service 换成 AgentArts authorize）。
   *
   *   callbackURL = oauth-login1/oauth2/v3/authorize?ticket=1ST-…      （200 HTML）
   *   → POST oauth2/ajax/getLoginWay（表单=authorize 的全部 query 参数）→ signatureInfo + casLoginRedirectUrl
   *   → GET  casLoginRedirectUrl（id1/CAS/remoteLogin）→ 302 loginCallback
   *   → GET  loginCallback（必须访问，建立 ticket 状态）
   *   → POST oauth2/ajax/login（signatureInfo + ticket）→ { code: casLogin?…&code=… }
   *   → 逐跳跟随：casLogin（★种 SSOTGC）→ authui/login?service=authorize → authorize?ticket=ST → redirect_uri?code=…
   *
   * @param {string} callbackUrl unionLoginByPwd 返回的 callbackURL
   * @returns {Promise<string>} OAuth 授权码（PKCE 的那一个）
   */
  async _finishOauth(callbackUrl) {
    if (!callbackUrl) throw credentialError('登录成功但 callbackURL 为空');
    const r0 = await this.http.get(callbackUrl);
    const au = new URL(r0.url || callbackUrl);
    const params = Object.fromEntries(au.searchParams.entries());

    const gw = await this.http.postJson(
      `${OAUTH_LOGIN}/oauth2/ajax/getLoginWay?reflushCode=${Math.random().toFixed(15)}&display=page`,
      params,
      { headers: { origin: OAUTH_LOGIN, interfaceVersion: 'v3', fromLoginAuth: 'false' } },
    );
    if (String(gw.isSuccess) !== 'true') {
      throw transientError(`getLoginWay 失败：${gw.errorDesc || gw.errorCode || JSON.stringify(gw).slice(0, 120)}`);
    }
    const sig = gw.signatureInfo || {};
    const casRedirect = (((gw.loginInteractInfo || {}).cas) || {}).casLoginRedirectUrl;
    if (!casRedirect) throw transientError('未取到 casLoginRedirectUrl');

    const r1 = await this.http.get(casRedirect);
    const loginCallback = (r1.status === 302 && r1.headers.location)
      ? new URL(r1.headers.location, casRedirect).href : r1.url;
    await this.http.get(loginCallback);
    const cb = Object.fromEntries(new URL(loginCallback).searchParams.entries());
    if (!cb.ticket) throw transientError(`loginCallback 缺少 ticket：${loginCallback.slice(0, 160)}`);

    const lr = await this.http.postJson(
      `${OAUTH_LOGIN}/oauth2/ajax/login?reflushCode=${Math.random().toFixed(15)}&display=page`,
      { ...sig, ticket: cb.ticket, siteID: cb.siteID || '1', countryCode: cb.countryCode || 'CN' },
      { headers: { origin: OAUTH_LOGIN, interfaceVersion: 'v3', fromLoginAuth: 'false' } },
    );
    if (String(lr.isSuccess) !== 'true') {
      throw transientError(`oauth2/ajax/login 失败：${lr.errorDesc || lr.errorCode || ''}`);
    }
    if (!lr.code) throw transientError('oauth2/ajax/login 未返回 code');

    // 逐跳跟随 code URL，直到落在 redirect_uri 上（带 code）
    let cur = lr.code;
    for (let hop = 0; hop < 12; hop += 1) {
      if (cur.startsWith(REDIRECT_URI)) {
        const code = new URL(cur).searchParams.get('code');
        if (code) return code;
        break;
      }
      const r = await this.http.get(cur, { follow: false });
      const loc = r.headers.location;
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        cur = new URL(loc, cur).href;
        continue;
      }
      throw transientError(`OAuth 落地链中断于 ${cur.slice(0, 140)}（HTTP ${r.status}，无 location）`);
    }
    throw transientError('跟随 OAuth 落地链后未拿到 code');
  }

  // ------------------------------------------------------------------
  // STS 令牌端点（authorization_code / refresh_token 共用）
  // ------------------------------------------------------------------

  async _tokens(form) {
    if (!this.dpop) {
      if (form.grant_type === 'authorization_code') this.dpop = DpopKey.generate();
      else throw credentialError('缺少 DPoP 私钥，无法刷新凭证');
    }
    const body = new URLSearchParams({ client_id: OAUTH_CLIENT_ID, ...form }).toString();
    const res = await this.http.request('POST', STS_TOKENS, {
      rawBody: body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: this.dpop.proof({ htm: 'POST', htu: STS_TOKENS }),
      },
    });
    let j;
    try { j = JSON.parse(res.text); } catch { j = { _raw: String(res.text).slice(0, 300) }; }
    if (res.status !== 200 || !j.credentials) {
      const msg = String(j.error_description || j.error || j.message || j._raw || res.text || '').slice(0, 200);
      const e = new Error(`STS ${form.grant_type} 失败（HTTP ${res.status}）：${msg}`);
      e.kind = /token has been used|invalid jkt|invalid_grant|expired|revoked|STS5\.18/i.test(msg) ? 'invalid' : 'transient';
      throw e;
    }
    return j;
  }

  _applyTokens(j) {
    const c = j.credentials || {};
    this.creds = {
      accessKey: c.access_key_id,
      secretKey: c.secret_access_key,
      securityToken: c.security_token,
      expMs: Date.parse(c.expires_at || c.expiration) || (Date.now() + 24 * 3600 * 1000),
    };
    if (j.refresh_token) this.refreshToken = j.refresh_token;   // ★单次有效，必须回写
  }

  // ------------------------------------------------------------------
  // 业务面：V11 签名调用
  // ------------------------------------------------------------------

  /**
   * 发一个 V11 请求（网关订阅面）。
   * @param {'GET'|'POST'} method
   * @param {string} path       如 '/v1/subscription'
   * @param {object} [opts]     { query, body, extraHeaders }
   */
  async v11Call(method, path, { query = '', body = '', extraHeaders = {} } = {}) {
    const url = `${GATEWAY}${path}${query}`;
    const sd = sdkDate();
    // 参与签名的头（小写名）必须与实际发出的头值逐字节一致
    const forSign = {
      host: GATEWAY_HOST,
      'x-sdk-date': sd,
      'x-security-token': this.creds.securityToken,
      'x-project-id': this.projectId,
      ...lowerKeys(extraHeaders),
    };
    const { authorization } = signV11({
      method, url, headers: forSign, body,
      accessKey: this.creds.accessKey, secretKey: this.creds.secretKey, sdkDate: sd,
    });
    const sendHeaders = {
      'X-Sdk-Date': sd,
      'X-Security-Token': this.creds.securityToken,
      'X-Project-ID': this.projectId,
      Authorization: authorization,
      accept: 'application/json',
      ...extraHeaders,
    };
    const res = await this.http.request(method, url, { rawBody: body || null, headers: sendHeaders });
    let json;
    try { json = JSON.parse(res.text); } catch { json = { _raw: String(res.text).slice(0, 300) }; }
    return { status: res.status, json };
  }

  /**
   * 平台面（agentarts / IAM）标准 SDK-HMAC-SHA256 调用。
   *
   * ★参与签名的头集必须与抓包一致（多一个少一个都是验签失败）：
   *   · `client-permission-validate` 只带 host/x-sdk-date/x-security-token/x-subscription-type（**无 x-project-id**）
   *   · `client-subscription` / `/v1/skus` 带 x-project-id
   * @param {'GET'|'POST'} method
   * @param {string} url  完整 URL（含 query）
   * @param {object} [opts] { body, extraHeaders, project=true }
   */
  async sdkCall(method, url, { body = '', extraHeaders = {}, project = true } = {}) {
    const u = new URL(url);
    const sd = sdkDate();
    const forSign = {
      host: u.hostname,
      'x-sdk-date': sd,
      'x-security-token': this.creds.securityToken,
      ...(project ? { 'x-project-id': this.projectId } : {}),
      ...lowerKeys(extraHeaders),
    };
    if (body) forSign['content-type'] = (extraHeaders['Content-Type'] || extraHeaders['content-type'] || 'application/json');
    const { authorization } = signSdkHmac({
      method, url, headers: forSign, body,
      accessKey: this.creds.accessKey, secretKey: this.creds.secretKey, sdkDate: sd, region: REGION,
    });
    // ★实发头必须与参与签名的头集**完全一致**（多一个 x-project-id 就会被网关当成
    //   项目级校验，报 `APIGW.0301 get token error,status:400`）
    const sendHeaders = {
      'X-Sdk-Date': sd,
      'X-Security-Token': this.creds.securityToken,
      Authorization: authorization,
      accept: 'application/json',
      ...extraHeaders,
    };
    if (project) sendHeaders['X-Project-ID'] = this.projectId;
    const res = await this.http.request(method, url, { rawBody: body || null, headers: sendHeaders });
    let json;
    try { json = JSON.parse(res.text); } catch { json = { _raw: String(res.text).slice(0, 300) }; }
    return { status: res.status, json };
  }

  /** 身份校验（平台面）：返回 account_id / principal_urn / subscription */
  async permissionValidate() {
    const { status, json } = await this.sdkCall('GET', `${AGENTARTS}/v1/claw/client-permission-validate`, {
      project: false, extraHeaders: { 'X-Subscription-Type': 'v2' },
    });
    if (status !== 200) throw apiError(status, json, 'GET /v1/claw/client-permission-validate');
    return json;
  }

  /**
   * 客户端订阅注册（平台面）——★首次登录链的第 9 步，不可省：
   * 不跑这一步，网关侧 `subscribe_status` 会是 `UNSUBSCRIBED`，
   * `bonus/claim` 拿不到每日积分（实测：注册后立刻变 SUBSCRIBED + 可签）。
   * 响应含 `model_info.model_auth_info{model_app_key, model_app_secret}`（模型面 Basic 凭证）。
   * ★`/v1/claw/*` 一律不能带 x-project-id（带了会被当作项目级鉴权，报 `get token error,status:400`）。
   */
  async clientSubscription() {
    const { status, json } = await this.sdkCall('POST', `${AGENTARTS}/v1/claw/client-subscription`, {
      body: '{}',
      extraHeaders: { 'Content-Type': 'application/json;charset=utf8', 'X-Subscription-Type': 'v2' },
      project: false,
    });
    if (status !== 200) throw apiError(status, json, 'POST /v1/claw/client-subscription');
    const auth = ((json || {}).model_info || {}).model_auth_info || {};
    if (auth.model_app_key) { this.modelAppKey = auth.model_app_key; this.modelAppSecret = auth.model_app_secret; }
    return json;
  }

  /** 发现 cn-southwest-2 的 project id（IAM 标准签名，可选） */
  async discoverProjectId() {
    const { status, json } = await this.sdkCall('GET', IAM_PROJECTS);
    if (status !== 200) throw apiError(status, json, 'GET /v3/projects');
    const p = ((json || {}).projects || []).find((x) => x.name === REGION || x.region_name === REGION);
    if (p) this.projectId = p.id;
    return this.projectId;
  }

  /** 订阅总览（含 bonus_skus / skus[].quotas） */
  async getSubscription() {
    const { status, json } = await this.v11Call('GET', '/v1/subscription',
      { query: '?is_count_down_info=true', extraHeaders: { 'X-Subscription-Type': 'v2' } });
    if (status !== 200) throw apiError(status, json, 'GET /v1/subscription');
    return json;
  }

  /** 每日签到（空 body POST）。幂等：当日重复调用返回空 bonus_skus */
  async claimBonus() {
    const { status, json } = await this.v11Call('POST', '/v1/subscription/bonus/claim',
      { extraHeaders: { 'Content-Type': 'application/json;charset=utf8' } });
    if (status !== 200) throw apiError(status, json, 'POST /v1/subscription/bonus/claim');
    return json;
  }

  /** 积分用量（day/hour 聚合） */
  async getUsage({ skuAttrCode = POINTS_ATTR, aggregation = 'day', startTime, endTime, limit = 100 } = {}) {
    const q = new URLSearchParams({ sku_attr_code: skuAttrCode, aggregation, limit: String(limit) });
    if (startTime) q.set('start_time', startTime);
    if (endTime) q.set('end_time', endTime);
    const { status, json } = await this.v11Call('GET', '/v1/subscription/usage', { query: `?${q}` });
    if (status !== 200) throw apiError(status, json, 'GET /v1/subscription/usage');
    return json;
  }

  /** 模型面探活（Basic 鉴权，与订阅面完全隔离） */
  async listModels() {
    if (!this.modelAppKey || !this.modelAppSecret) return null;
    const basic = Buffer.from(`${this.modelAppKey}:${this.modelAppSecret}`).toString('base64');
    const res = await this.http.request('GET', `${GATEWAY}/v2/models`, {
      headers: { Authorization: `Basic ${basic}`, accept: 'application/json' },
    });
    try { return JSON.parse(res.text); } catch { return null; }
  }

  // ------------------------------------------------------------------
  // 签到主流程
  // ------------------------------------------------------------------

  /** 今日是否已签（北京日期口径：`cbc_resource_id` 内嵌 yyyymmdd） */
  static isTodayCheckedIn(subscription, now = new Date()) {
    const ymd = beijingYmd(now);
    return (subscription.bonus_skus || []).some((b) => b && b.activity_id === DAILY_ACTIVITY_ID
      && String(b.cbc_resource_id || '').includes(ymd));
  }

  /**
   * 积分余额 = 套餐配额剩余 + 未过期福利批次剩余。
   *   · 套餐：`skus[].quotas[officeace_points]` 的 `sku_value - current_value`
   *   · 福利（签到/新用户）：`bonus_skus[]` 的 `points - current_value`，按 `expired_time` 过滤
   *     （未订阅套餐的账号只有福利批次，实测新账号 claim 后 skus 为空）
   */
  static pointsOf(subscription, now = new Date()) {
    let total = 0;
    for (const sku of subscription.skus || []) {
      for (const q of sku.quotas || []) {
        if (q.sku_attr_code !== POINTS_ATTR) continue;
        const size = Number(q.sku_value) || 0;
        const used = Number(q.current_value) || 0;
        total += Math.max(0, size - used);
      }
    }
    for (const b of subscription.bonus_skus || []) {
      const exp = b.expired_time ? Date.parse(b.expired_time) : Infinity;
      if (Number.isFinite(exp) && exp <= now.getTime()) continue;
      total += Math.max(0, (Number(b.points) || 0) - (Number(b.current_value) || 0));
    }
    return total;
  }

  /**
   * 执行一次签到：确保凭证 → 查状态 → 未签则领 → 回读校验。
   * @returns {Promise<{ok:boolean, alreadyCheckedIn:boolean, credits:number, reward:number|null, bonus:Array}>}
   */
  async checkin() {
    await this.ensureCredentials();
    let before = await this.getSubscription();
    // 未注册（新登录/换机）时补一次客户端订阅，否则 claim 永远空
    if (before.subscribe_status === 'UNSUBSCRIBED') {
      try {
        await this.clientSubscription();
        before = await this.getSubscription();
      } catch { /* 交给下面的判定 */ }
    }
    const creditsBefore = OfficeAceClient.pointsOf(before);
    if (OfficeAceClient.isTodayCheckedIn(before)) {
      return { ok: true, alreadyCheckedIn: true, credits: creditsBefore, reward: null, bonus: [] };
    }
    const res = await this.claimBonus();
    const bonus = res.bonus_skus || [];
    const reward = bonus.reduce((s, b) => s + (Number(b.points) || 0), 0);
    let credits = creditsBefore + reward;
    try {
      credits = OfficeAceClient.pointsOf(await this.getSubscription());
    } catch { /* 回读失败不影响签到结论 */ }
    return { ok: true, alreadyCheckedIn: false, credits, reward, bonus };
  }

  /** 当前积分余额 */
  async getCredits() {
    await this.ensureCredentials();
    const sub = await this.getSubscription();
    return { credits: OfficeAceClient.pointsOf(sub), subscribeStatus: sub.subscribe_status || null };
  }

  /** 今日签到状态（不领取） */
  async getStatus() {
    await this.ensureCredentials();
    const sub = await this.getSubscription();
    return {
      checkedIn: OfficeAceClient.isTodayCheckedIn(sub),
      credits: OfficeAceClient.pointsOf(sub),
      subscribeStatus: sub.subscribe_status || null,
      bonus: (sub.bonus_skus || []).map((b) => ({
        activityId: b.activity_id, name: b.activity_name, points: Number(b.points) || 0,
        resourceId: b.cbc_resource_id, expiredTime: b.expired_time || null,
      })),
    };
  }

  /**
   * 会话/凭证探活（供到期监控）。
   * ★不主动 refresh：refresh_token 单次有效，探活不能消耗它。改为本地解 RT 的 JWT exp（30 天）；
   *   真正的失效由每日签到流程撞上 `STS5.1806` 时报 invalid。
   * @returns {Promise<{ok:boolean, isLogin:boolean, expiresAt:number|null}>}
   */
  async probeSession() {
    const rtExp = this.refreshTokenExpMs();
    if (this.refreshToken) {
      if (rtExp && rtExp <= Date.now()) {
        return { ok: false, isLogin: false, expiresAt: rtExp, error: 'refresh_token 已过期' };
      }
      return { ok: true, isLogin: true, expiresAt: rtExp || this.creds.expMs || null };
    }
    if (this._credsFresh()) return { ok: true, isLogin: true, expiresAt: this.creds.expMs };
    if (this.account && this.password) {
      try {
        await this.login();
        return { ok: true, isLogin: true, expiresAt: this.refreshTokenExpMs() || this.creds.expMs };
      } catch (err) {
        if (err && err.kind === 'invalid') {
          return { ok: false, isLogin: false, expiresAt: null, error: err.message };
        }
        throw err;
      }
    }
    return { ok: false, isLogin: false, expiresAt: null, error: '未配置凭证' };
  }
}

// ==========================================================================
// 工具
// ==========================================================================

function lowerKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k.toLowerCase()] = v;
  return out;
}

function credentialError(message) {
  const e = new Error(message);
  e.kind = 'invalid';
  return e;
}

function transientError(message) {
  const e = new Error(message);
  e.kind = 'transient';
  return e;
}

/** 网关错误归一：401/403 与签名/token 类错误判 invalid（需重登），其余 transient */
function apiError(status, json, where) {
  const code = String((json && (json.error_code || json.errorCode || json.error)) || '');
  const msg = `${where} -> HTTP ${status} ${code} ${(json && (json.error_msg || json.message || json._raw)) || ''}`.trim();
  const e = new Error(msg);
  e.status = status;
  e.apiCode = code;
  const invalid = status === 401 || status === 403
    || /APIG\.0301|APIG\.0605|signature|SecurityToken|token.*(expired|invalid)|InvalidAuth/i.test(msg);
  e.kind = invalid ? 'invalid' : 'transient';
  return e;
}
