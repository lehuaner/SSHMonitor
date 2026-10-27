/**
 * Qoder CN（qoder.com.cn）每日积分签到客户端 —— 零依赖（fetch + node:crypto）。
 *
 * 协议来源（2026-10-27 全链路 E2E 实测，证据见 examples/qoder-cn-checkin-e2e/runs/）：
 *   - 本机 Qoder CN 客户端 0.4.8（Electron）的 auth.v1.dat 解密出 token/refreshToken
 *   - resources/umid/runtime-info.exe 生成设备风控三件套
 *   - 逐条打真实上游接口，claim 返回 replayed=true（= 今天已在客户端领过）
 *
 * 端点（base = https://openapi.qoder.com.cn）：
 *   GET  /sash/api/v1/me/campaigns                活动投放列表
 *        每日签到 = actionType=CLAIM_BENEFIT + benefit.kind=CREDITS 的那一行
 *        claimStatus=CLAIMABLE 今日可领 / CLAIMED 今日已领（客户端领过也是它）
 *        ★每日 10:00（UTC+8）刷新；今天领过之后该行仍会保留（不是消失）
 *   POST /sash/api/v1/me/campaigns/{campaignId}/claim   领取（空 JSON body）
 *        → { status:"CLAIMED", replayed:true|false, grantId, benefit, claimedAt, expiresAt }
 *        幂等：重复领取 replayed=true、不重复发积分、仍返回 200
 *   GET  /api/v2/quota/usage                      额度：userQuota{total,used,remaining}(credits) + addOnQuota
 *   POST /api/v1/deviceToken/refresh              {refresh_token} → {device_token, refresh_token, expires_at, refresh_token_expires_at}
 *        ★两个 token 都会轮换：调用方必须无条件回写持久化
 *   GET  /api/v1/deviceToken/poll                 设备授权登录轮询（配合网页 /device/selectAccounts?challenge=…）
 *
 * 鉴权（实测）：Authorization: Bearer dt-… + cosy-clienttype:10 + user-agent:Qoder
 *   这四件套（再加 content-type）即可读写签到；
 *   Cosy-Machine* 是设备风控身份（客户端同款），带上更贴近官方流量，缺失不影响本次实测结论。
 *
 * 错误的三种分类（与 tasks/index.js 的告警策略对齐）：
 *   invalid   凭证失效（HTTP 401/403、code=105/10019901001）→ 立即告警并暂停该任务
 *   throttle  限流（HTTP 429 / 文案含「频繁」）→ 退避重试，不计失败
 *   transient 其它临时失败 → 退避重试
 */

export const QODER_BASE = 'https://openapi.qoder.com.cn';
export const QODER_WEB = 'https://qoder.com.cn';
export const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
export const QUOTA_PATH = '/api/v2/quota/usage';
export const REFRESH_PATH = '/api/v1/deviceToken/refresh';
export const DEVICE_POLL_PATH = '/api/v1/deviceToken/poll';

/** Qoder 客户端的 Cosy-ClientType（非浏览器 = 10，设备授权登录 = 5） */
export const CLIENT_TYPE = '10';
/** Cosy-Version 取客户端 resources/umid/manifest.json 的 qoderCliVersion */
export const DEFAULT_CLIENT_VERSION = '1.1.69';
/** 业务接口 UA（实测就是这个词） */
export const DEFAULT_UA = 'Qoder';

/** 每日签到活动窗口：10:00（UTC+8）开窗 */
export const DAILY_WINDOW_HOUR_CST = 10;

/** 掩码（日志/错误信息里绝不出现完整 token） */
export function maskToken(token, keep = 8) {
  const s = String(token || '');
  if (!s) return '';
  if (s.length <= keep + 4) return '*'.repeat(s.length);
  return `${s.slice(0, keep)}…${s.slice(-4)}`;
}

/** 由 refresh token 前缀判断该用哪个续期端点（drt-/dt- = 设备 token；jrt- = job token） */
export function refreshPathFor(refreshToken) {
  return String(refreshToken || '').trim().startsWith('jrt-') ? '/api/v1/jobToken/refresh' : REFRESH_PATH;
}

/** 归一化错误分类 */
export function classifyError(message, status, payload) {
  const e = new Error(message);
  const code = payload && (payload.code || payload.errorCode);
  const text = `${message} ${payload && (payload.errorMessage || payload.msg || payload.message) || ''}`;
  if (status === 401 || status === 403 || code === 105 || code === '105' || code === '10019901001') {
    e.kind = 'invalid';
    return e;
  }
  if (status === 429 || /频繁|太频繁|稍后再试|throttle|rate.?limit/i.test(text)) {
    e.kind = 'throttle';
    return e;
  }
  e.kind = 'transient';
  return e;
}

/**
 * 从 campaigns 响应体里挑出「每日签到」那一行。
 * 判定顺序：actionType=CLAIM_BENEFIT → benefit.kind=CREDITS → 排除 VIEW_DETAILS / 兑换码类活动。
 * @returns {{row:object|null, claimable:object|null, claimed:object|null, rows:Array}}
 */
export function pickDailyCampaign(payload) {
  const rows = (payload && (payload.campaigns || (payload.data && payload.data.campaigns))) || [];
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const claimBenefit = list.filter((r) => String(r.actionType || '').toUpperCase() === 'CLAIM_BENEFIT');
  const credits = claimBenefit.filter((r) => String((r.benefit && r.benefit.kind) || '').toUpperCase() === 'CREDITS');
  const pool = credits.length ? credits : claimBenefit;
  const claimable = pool.find((r) => String(r.claimStatus || '').toUpperCase() === 'CLAIMABLE') || null;
  const claimed = pool.find((r) => String(r.claimStatus || '').toUpperCase() === 'CLAIMED') || null;
  return { row: claimable || claimed || null, claimable, claimed, rows: list };
}

/** 活动的中文标题（取 placements[].content.zh.title） */
export function campaignTitle(row) {
  if (!row) return '';
  for (const p of row.placements || []) {
    const zh = p && p.content && p.content.zh;
    if (zh && zh.title) return String(zh.title);
  }
  for (const p of row.placements || []) {
    const en = p && p.content && p.content.en;
    if (en && en.title) return String(en.title);
  }
  return String(row.campaignKey || row.campaignId || '');
}

/** 奖励描述：100 credits / 30 天有效 */
export function describeBenefit(benefit) {
  if (!benefit || typeof benefit !== 'object') return '';
  const amount = benefit.amount != null ? Number(benefit.amount) : null;
  const kind = String(benefit.kind || '').toUpperCase();
  const days = benefit.validity && benefit.validity.days ? Number(benefit.validity.days) : null;
  const unit = kind === 'CREDITS' ? 'credits' : kind === 'REDEMPTION_CODE' ? '兑换券' : kind.toLowerCase();
  let text = amount != null ? `${amount} ${unit}` : unit;
  if (days) text += `，${days} 天有效`;
  else if (benefit.validity && benefit.validity.fixedEnd) text += `，至 ${String(benefit.validity.fixedEnd).slice(0, 10)}`;
  return text;
}

/** 当前是否已过今日 10:00（UTC+8）开窗 */
export function dailyWindowOpen(now = Date.now()) {
  const cst = new Date(now + 8 * 3600 * 1000);
  return cst.getUTCHours() >= DAILY_WINDOW_HOUR_CST;
}

/**
 * 可用积分口径（与面板一致）：userQuota.remaining + addOnQuota.remaining。
 * 上游 /api/v2/quota/usage 把「套餐额度」和「加油包」分开返回，这里统一成一个数。
 */
export function remainingCredits(quota) {
  if (!quota || typeof quota !== 'object') return null;
  const q = quota.userQuota || {};
  const addon = quota.addOnQuota || {};
  const a = Number.isFinite(Number(q.remaining)) ? Number(q.remaining) : null;
  const b = Number.isFinite(Number(addon.remaining)) ? Number(addon.remaining) : null;
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

export class QoderClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]        默认 https://openapi.qoder.com.cn
   * @param {string} [opts.token]          access token（dt-…）
   * @param {string} [opts.refreshToken]   refresh token（drt-… / jrt-…）
   * @param {string} [opts.machineId]      Cosy-MachineId（客户端 ~/.qoder-cn/.auth/machine_id）
   * @param {string} [opts.machineToken]   设备风控三件套（runtime-info 产出）
   * @param {string} [opts.machineCode]
   * @param {string} [opts.machineType]
   * @param {string} [opts.machineOs]      Cosy-MachineOS，形如 x86_64_win32
   * @param {string} [opts.hostname]       Cosy-MachineHostname
   * @param {string} [opts.clientVersion]  Cosy-Version
   * @param {number} [opts.timeout]        毫秒，默认 20000
   * @param {Function} [opts.fetchImpl]
   */
  constructor({
    baseUrl = QODER_BASE,
    token = '',
    refreshToken = '',
    machineId = '',
    machineToken = '',
    machineCode = '',
    machineType = '',
    machineOs = '',
    hostname = '',
    clientVersion = DEFAULT_CLIENT_VERSION,
    timeout = 20000,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = String(baseUrl || QODER_BASE).replace(/\/$/, '');
    this.token = String(token || '').trim();
    this.refreshToken = String(refreshToken || '').trim();
    this.machineId = String(machineId || '').trim();
    this.machineToken = String(machineToken || '').trim();
    this.machineCode = String(machineCode || '').trim();
    this.machineType = String(machineType || '').trim();
    this.machineOs = String(machineOs || '').trim();
    this.hostname = String(hostname || '').trim();
    this.clientVersion = String(clientVersion || DEFAULT_CLIENT_VERSION).trim();
    this.timeout = timeout;
    this.fetch = fetchImpl;
  }

  /** 是否配置了完整设备风控三件套 */
  hasDeviceIdentity() {
    return !!(this.machineToken && this.machineCode && this.machineType);
  }

  _headers({ token, json = false, origin = false } = {}) {
    const t = token === undefined ? this.token : token;
    const headers = {
      authorization: `Bearer ${String(t || '').replace(/^Bearer\s+/i, '')}`,
      'cosy-clienttype': CLIENT_TYPE,
      'user-agent': DEFAULT_UA,
      accept: 'application/json',
      'accept-language': 'zh-CN',
    };
    if (json) headers['content-type'] = 'application/json';
    if (origin) headers.origin = this.baseUrl;
    if (this.hasDeviceIdentity()) {
      headers['Cosy-Version'] = this.clientVersion;
      if (this.machineOs) headers['Cosy-MachineOS'] = this.machineOs;
      if (this.machineId) headers['Cosy-MachineId'] = this.machineId;
      if (this.hostname) headers['Cosy-MachineHostname'] = this.hostname;
      headers['Cosy-MachineToken'] = this.machineToken;
      headers['Cosy-MachineCode'] = this.machineCode;
      headers['Cosy-MachineType'] = this.machineType;
    }
    return headers;
  }

  async _request(method, path, { body, token, json, origin, extraHeaders } = {}) {
    const url = `${this.baseUrl}${path}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout);
    try {
      const res = await this.fetch(url, {
        method,
        headers: { ...this._headers({ token, json, origin }), ...(extraHeaders || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* 上游异常时可能回 HTML */ }
      if (!res.ok) {
        const payload = data || {};
        const msg = payload.errorMessage || payload.message || payload.msg
          || `HTTP ${res.status} ${res.statusText}`;
        throw classifyError(`${method} ${path} → ${msg}`, res.status, payload);
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error(`${method} ${path} 请求超时（${this.timeout}ms）`);
        e.kind = 'transient';
        throw e;
      }
      if (err && err.kind) throw err;
      const e = new Error(`${method} ${path} 网络异常：${err && err.message ? err.message : err}`);
      e.kind = 'transient';
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 活动投放列表 */
  async campaigns() {
    return this._request('GET', CAMPAIGNS_PATH);
  }

  /** 额度用量（credits 余额口径） */
  async quota() {
    return this._request('GET', QUOTA_PATH);
  }

  /**
   * 今日签到状态（只读，不领取）
   * @returns {Promise<{checkedIn:boolean, claimable:object|null, campaign:object|null, rows:Array, payload:object}>}
   */
  async status() {
    const payload = await this.campaigns();
    const { row, claimable, claimed, rows } = pickDailyCampaign(payload);
    return {
      checkedIn: !!claimed,
      claimable,
      campaign: row,
      rows,
      payload,
      showCampaign: payload && payload.showCampaign,
    };
  }

  /** 领取某个活动（幂等；已领过返回 replayed=true） */
  async claim(campaignId) {
    const id = String(campaignId || '').trim();
    if (!id) {
      const e = new Error('缺少 campaignId');
      e.kind = 'transient';
      throw e;
    }
    return this._request('POST', `${CAMPAIGNS_PATH}/${encodeURIComponent(id)}/claim`, {
      body: {},
      json: true,
      origin: true,
    });
  }

  /**
   * 用 refresh_token 换新 token（★两个 token 都会轮换，调用方必须回写）
   * @returns {Promise<{token:string, refreshToken:string, rotated:boolean, expiresAt:string|null, refreshExpiresAt:string|null, raw:object}>}
   */
  async refresh() {
    if (!this.refreshToken) {
      const e = new Error('未配置 refresh_token，无法续期');
      e.kind = 'invalid';
      throw e;
    }
    const raw = await this._request('POST', refreshPathFor(this.refreshToken), {
      body: { refresh_token: this.refreshToken },
      json: true,
      extraHeaders: { 'user-agent': 'qoder-local-proxy' },
    });
    const d = (raw && typeof raw.data === 'object' && raw.data) ? raw.data : (raw || {});
    const token = d.device_token || d.deviceToken || d.token || d.access_token || d.accessToken || '';
    const refreshToken = d.refresh_token || d.refreshToken || '';
    if (!token) {
      const e = new Error('续期响应缺少 access token');
      e.kind = 'transient';
      throw e;
    }
    const rotated = !!refreshToken && refreshToken !== this.refreshToken;
    this.token = token;
    if (refreshToken) this.refreshToken = refreshToken;
    return {
      token,
      refreshToken: refreshToken || this.refreshToken,
      rotated,
      expiresAt: d.expires_at || d.expiresAt || null,
      refreshExpiresAt: d.refresh_token_expires_at || d.refreshTokenExpiresAt || null,
      raw,
    };
  }

  /**
   * 一次完整签到：查状态 → 可领则领 → 返回结构化结果。
   * 语义与其它 provider 对齐：
   *   - 今日已领（含客户端领过）→ { alreadyCheckedIn:true }
   *   - 领成功                   → { alreadyCheckedIn:false, credits: 面值 }
   *   - 活动未下发（窗口未开等） → 抛 transient/invalid
   * @returns {Promise<{alreadyCheckedIn:boolean, claimed:boolean, credits:number|null, reward:object|null, campaign:object|null, claim:object|null, quota:object|null}>}
   */
  async checkin() {
    const st = await this.status();
    let quota = null;
    try { quota = await this.quota(); } catch { /* 余额查询失败不影响签到结论 */ }
    const remaining = remainingCredits(quota);

    if (st.checkedIn) {
      return {
        alreadyCheckedIn: true,
        claimed: false,
        credits: Number.isFinite(remaining) ? remaining : null,
        reward: st.campaign && st.campaign.benefit ? st.campaign.benefit : null,
        campaign: st.campaign,
        claim: null,
        quota,
      };
    }
    if (!st.claimable) {
      const open = dailyWindowOpen();
      const e = new Error(open
        ? '上游未下发可领取的签到活动（可能今日已领但状态未回显，稍后重试）'
        : `签到活动窗口未开：每日 10:00（UTC+8）后才会下发，当前未到点`);
      e.kind = open ? 'transient' : 'transient';
      throw e;
    }
    const campaign = st.claimable;
    const claim = await this.claim(campaign.campaignId);
    const amount = claim && claim.benefit && claim.benefit.amount != null
      ? Number(claim.benefit.amount)
      : (campaign.benefit && campaign.benefit.amount != null ? Number(campaign.benefit.amount) : null);
    return {
      alreadyCheckedIn: claim ? claim.replayed === true : false,
      claimed: !(claim && claim.replayed === true),
      credits: Number.isFinite(remaining) ? remaining : amount,
      reward: (claim && claim.benefit) || campaign.benefit || null,
      campaign,
      claim,
      quota,
    };
  }
}
