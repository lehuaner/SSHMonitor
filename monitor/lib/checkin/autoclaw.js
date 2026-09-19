/**
 * AutoClaw（智谱 Z.ai 积分体系）每日签到客户端。
 *
 * 协议来源（2026-09-18）：
 *   - AutoClaw 桌面客户端 app.asar 逆向还原（渲染层 window.electronAPI.auth.* → 主进程 HTTP）
 *   - examples/autoclaw_解析结果 抓包（autoclaw/1.18.4 客户端真实流量）
 *   - examples/autoclaw_probe.mjs 用真实账号全链路 E2E 实测通过
 *
 * 端点（prod = https://autoglm-api.zhipuai.cn）：
 *   POST /userapi/v1/agent-send-code    发送短信验证码 {source_id, device_id, phone}
 *   POST /userapi/v1/agent-login/       手机验证码登录 {source_id, device_id, phone, code:Number}
 *                                       → data.access_token(24h) / data.refresh_token(30天)
 *   POST /userapi/v1/agent-refresh      用 refresh_token 换新 access_token {source_id, device_id, refresh_token}
 *                                       （/userapi/v1/refresh 是 web 端变体，会报 400002 Middleware sign error，
 *                                         客户端在 400002 时回落 agent-refresh —— 本实现直接打 agent-refresh）
 *   GET  /autoclaw-proxy/proxy/autoclaw-task-list?lang=zh-CN
 *                                       任务（签到）列表；daily_signin 条目 status=completed 即今日已签
 *   POST /autoclaw-proxy/proxy/autoclaw-task-complete
 *                                       完成任务 {task_id:"daily_signin"} → data.reward_points / data.already_completed
 *   GET  /agent-assetmgr/api/v1/wallet-instances?biz_app_id=autoclaw
 *                                       积分钱包明细（total_balance + 各钱包批次余额/到期）
 *   GET  /agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw
 *                                       即将过期积分
 *
 * 鉴权：
 *   - authorization: Bearer <access_token>（服务端返回的 token 自带 "Bearer " 前缀，原样携带即可）
 *   - 业务请求头带 x-version / x-request-id（uuid）与客户端 UA（网关未实测强校验 UA，但保持一致最稳）
 *   - refresh_token 实测不轮换（30 天固定窗口，exp 由 JWT 声明），每日刷新 access_token 即可免维护
 *   - access_token JWT claims: user_id / device_id / jti=手机号 / exp(24h)
 *
 * 签到行为（2026-09-18 实测）：
 *   - task-list 的 daily_signin：status=completed 表示今日已签（客户端已于 21:17 签到过）
 *   - complete 在已签后返回 {already_completed:true, reward_points:0, success:false}（幂等，不报错）
 *   - 正常签到奖励 200 积分/天，钱包批次 7 天后过期（cycle_key 含日期，expires_at=effective_at+7d）
 */
import { randomUUID } from 'node:crypto';

export const AUTOCLAW_BASE = 'https://autoglm-api.zhipuai.cn';

// AutoClaw 桌面客户端 1.18.4 的 UA（examples/autoclaw_解析结果/083 抓包原值）
export const AUTOCLAW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) autoclaw/1.18.4 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36';

// 渲染层 DAILY_SIGNIN_TASK_ID 常量（app.asar 原值）
export const DAILY_SIGNIN_TASK_ID = 'daily_signin';

// 本机 AutoClaw 客户端设备指纹（%APPDATA%\AutoClaw\identity\device.json 的 deviceId，
// 与 2026-09-18 登录抓包 device_id 一致）。多账号共用同一设备指纹无冲突（token 按 user 区分）。
export const DEFAULT_DEVICE_ID = '47ca87c861fdaade01292bea57dde5f7cb1457360f3acc31967afa3048e4709d';

/** 构造 authorization 头：token 自带 "Bearer " 前缀则原样，否则补上（与客户端 tokenPrefix 一致） */
export function bearerToken(token) {
  const t = String(token || '').trim();
  return t.startsWith('Bearer ') ? t : `Bearer ${t}`;
}

/** 解码 JWT payload（自动剥 "Bearer " 前缀）；解析失败返回 null */
export function decodeJwtClaims(token) {
  try {
    const raw = String(token || '').replace(/^Bearer\s+/i, '');
    const parts = raw.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** 归一化错误分类：invalid=凭证无效 / throttle=限流 / transient=临时失败 */
function classifyError(message, code) {
  const e = new Error(message);
  if (code === 400002 || code === 400003 || code === 401) {
    e.kind = 'invalid'; // refresh_token 失效 / 未授权
    return e;
  }
  if (/操作太过频繁|太频繁|频率|稍后再试|throttle/i.test(message)) {
    e.kind = 'throttle';
    return e;
  }
  const invalid = /HTTP 401|HTTP 403/.test(message)
    || /token|凭证|登录|过期|失效|会话|unauthorized|expired|invalid/i.test(message);
  e.kind = invalid ? 'invalid' : 'transient';
  return e;
}

export class AutoClawClient {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]     默认 https://autoglm-api.zhipuai.cn
   * @param {string} [opts.refreshToken] 长期凭证（30 天）；提供后可 refreshAccessToken()
   * @param {string} [opts.accessToken]  短期凭证（24h）；业务请求用
   * @param {string} [opts.deviceId]     设备指纹（须与凭证签发时一致）
   * @param {number} [opts.timeout]      请求超时毫秒，默认 20000
   * @param {(url:string, opts:object)=>Promise<Response>} [opts.fetchImpl]
   */
  constructor({ baseUrl = AUTOCLAW_BASE, refreshToken = '', accessToken = '', deviceId = DEFAULT_DEVICE_ID, timeout = 20000, fetchImpl = fetch } = {}) {
    this.baseUrl = String(baseUrl || AUTOCLAW_BASE).replace(/\/$/, '');
    this.refreshToken = String(refreshToken || '').trim();
    this.accessToken = String(accessToken || '').trim();
    this.deviceId = String(deviceId || DEFAULT_DEVICE_ID).trim();
    this.timeout = timeout;
    this.fetch = fetchImpl;
  }

  _headers(token) {
    const headers = {
      'content-type': 'application/json',
      'user-agent': AUTOCLAW_UA,
      'accept-language': 'zh-CN',
      'x-version': '1.18.4',
      'x-request-id': randomUUID(),
    };
    if (token) headers.authorization = bearerToken(token);
    return headers;
  }

  async _request(method, path, { body, token } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout);
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this._headers(token),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 上游异常时可能回 HTML */ }
      if (!res.ok) {
        const msg = `HTTP ${res.status} ${res.statusText} for ${path}${json && json.msg ? `: ${json.msg}` : ''}`;
        throw classifyError(msg, res.status);
      }
      if (json && typeof json.code === 'number' && json.code !== 0) {
        throw classifyError(`AutoClaw API ${path} code=${json.code}: ${json.msg || '未知错误'}`, json.code);
      }
      return json;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw classifyError(`请求超时（${this.timeout}ms）: ${path}`, null);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发送短信验证码（无需任何鉴权）。
   * @param {string} phone 11 位手机号
   * @returns {Promise<{result:boolean, trace:string}>}
   */
  async sendCode(phone) {
    const p = String(phone || '').trim();
    if (!/^1\d{10}$/.test(p)) throw classifyError(`手机号格式不正确: ${p}`, null);
    const j = await this._request('POST', '/userapi/v1/agent-send-code', {
      body: { source_id: 'autoclaw', device_id: this.deviceId, phone: p },
    });
    const d = (j && j.data) || {};
    return { result: !!d.result, trace: d.code || (j && j.trace) || '' };
  }

  /**
   * 手机验证码登录（与 agent-login 同参数；★code 必须是数字）。
   * 成功返回完整 token 对，由调用方决定持久化位置。
   * @returns {Promise<{accessToken:string, refreshToken:string, accessExpMs:number|null, refreshExpMs:number|null, userId:string|null, userName:string|null, firstLogin:boolean}>}
   */
  async loginWithSmsCode(phone, code) {
    const p = String(phone || '').trim();
    const c = Number(String(code || '').trim());
    if (!/^1\d{10}$/.test(p)) throw classifyError(`手机号格式不正确: ${p}`, null);
    if (!Number.isSafeInteger(c) || c <= 0) throw classifyError(`验证码格式不正确: ${code}`, null);
    const j = await this._request('POST', '/userapi/v1/agent-login/', {
      body: { source_id: 'autoclaw', device_id: this.deviceId, phone: p, code: c },
    });
    const d = (j && j.data);
    if (!d || !d.access_token) {
      throw classifyError(`登录未返回 access_token: ${JSON.stringify(j).slice(0, 200)}`, null);
    }
    const accessClaims = decodeJwtClaims(d.access_token);
    const refreshClaims = decodeJwtClaims(d.refresh_token || '');
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token || '',
      accessExpMs: accessClaims && accessClaims.exp ? accessClaims.exp * 1000 : null,
      refreshExpMs: refreshClaims && refreshClaims.exp ? refreshClaims.exp * 1000 : null,
      userId: d.user_id ? String(d.user_id) : null,
      userName: d.user_name ? String(d.user_name) : null,
      firstLogin: !!d.first_login,
    };
  }

  /**
   * 用 refresh_token 换新 access_token。
   * 实测（2026-09-18）：返回的 access_token / refresh_token 均自带 "Bearer " 前缀；
   * refresh_token 不轮换（iat/exp 不变），但这里仍把响应里的 refresh_token 原样带回，
   * 万一服务端未来开始轮换，调用方可持久化新值跟随。
   * @returns {Promise<{accessToken:string, refreshToken:string, accessExpMs:number|null, refreshExpMs:number|null, userId:string|null}>}
   */
  async refreshAccessToken() {
    if (!this.refreshToken) throw classifyError('未配置 refresh_token，无法刷新凭证', null);
    const j = await this._request('POST', '/userapi/v1/agent-refresh', {
      body: { source_id: 'autoclaw', device_id: this.deviceId, refresh_token: this.refreshToken },
    });
    const d = j && j.data;
    if (!d || !d.access_token) {
      throw classifyError(`agent-refresh 未返回 access_token: ${JSON.stringify(j).slice(0, 200)}`, null);
    }
    const refreshTk = d.refresh_token || this.refreshToken;
    const accessClaims = decodeJwtClaims(d.access_token);
    const refreshClaims = decodeJwtClaims(refreshTk);
    return {
      accessToken: d.access_token,
      refreshToken: refreshTk,
      accessExpMs: accessClaims && accessClaims.exp ? accessClaims.exp * 1000 : null,
      refreshExpMs: refreshClaims && refreshClaims.exp ? refreshClaims.exp * 1000 : null,
      userId: (d.user_id || accessClaims?.user_id || null) != null ? String(d.user_id || accessClaims.user_id) : null,
    };
  }

  /** 任务（签到）列表：GET /autoclaw-proxy/proxy/autoclaw-task-list（响应无 code 包装，直接 {data:[...]}） */
  async taskList(lang = 'zh-CN') {
    const j = await this._request('GET', `/autoclaw-proxy/proxy/autoclaw-task-list?lang=${encodeURIComponent(lang)}`, {
      token: this.accessToken,
    });
    return (j && Array.isArray(j.data)) ? j.data : [];
  }

  /** 完成客户端任务：POST /autoclaw-proxy/proxy/autoclaw-task-complete（响应无 code 包装） */
  async completeTask(taskId) {
    return this._request('POST', '/autoclaw-proxy/proxy/autoclaw-task-complete', {
      token: this.accessToken,
      body: { task_id: taskId },
    });
  }

  /** 积分钱包明细：total_balance + wallet_instances[]（balance / expires_at / cycle_key） */
  async wallet() {
    return this._request('GET', '/agent-assetmgr/api/v1/wallet-instances?biz_app_id=autoclaw', {
      token: this.accessToken,
    });
  }

  /** 钱包总余额（total_balance），失败返回 null（不影响签到主流程） */
  async totalBalance() {
    try {
      const j = await this.wallet();
      const n = Number(j && j.data && j.data.total_balance);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /** 即将过期积分（原样返回 data） */
  async expiring() {
    const j = await this._request('GET', '/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw', {
      token: this.accessToken,
    });
    return (j && j.data) || null;
  }

  /**
   * 一次完整签到：
   *   1) task-list 查 daily_signin；status=completed → alreadyCheckedIn（幂等，不重复打 complete）
   *   2) 否则 complete；data.already_completed=true 也视为已签（服务端兜底幂等）
   *   3) 查钱包余额一并返回
   * @returns {Promise<{alreadyCheckedIn:boolean, reward:number, credits:number|null, streak:string, raw:object}>}
   */
  async checkin() {
    const tasks = await this.taskList();
    const entry = tasks.find((t) => t && t.task_id === DAILY_SIGNIN_TASK_ID) || null;
    if (entry && entry.status === 'completed') {
      return {
        alreadyCheckedIn: true,
        reward: 0,
        credits: await this.totalBalance(),
        streak: entry.status_description || '',
        raw: { source: 'task-list', entry },
      };
    }
    const j = await this.completeTask(DAILY_SIGNIN_TASK_ID);
    const d = (j && j.data) || {};
    return {
      alreadyCheckedIn: !!d.already_completed,
      reward: Number(d.reward_points) || 0,
      credits: await this.totalBalance(),
      streak: entry ? entry.status_description || '' : '',
      raw: { source: 'task-complete', data: d },
    };
  }
}

/**
 * 把钱包批次转成人类可读名称（cycle_key 样例）：
 *   reward:daily:daily_signin:625714:2026-09-18  → 每日签到奖励 2026-09-18
 *   activity:autoclaw_user_login_autotyper_...:300:2026-09-15 → 活动奖励（至 2026-09-23）
 *   permanent → 长期余额（permanent）
 */
export function describeWallet(w) {
  const ck = String((w && w.cycle_key) || '');
  if (ck === 'permanent') return '长期余额（permanent）';
  const parts = ck.split(':');
  const date = parts.length >= 2 ? parts[parts.length - 1] : '';
  if (parts.includes('daily_signin')) return `每日签到奖励 ${date}`.trim();
  if (parts[0] === 'activity') return `活动奖励（至 ${date}）`.trim();
  if (parts[0] === 'reward') return `签到奖励 ${date}`.trim();
  return `${(w && (w.wallet_name || w.wallet_type)) || '积分钱包'} ${date}`.trim();
}
