/**
 * Trae 每日签到客户端。
 * 基于抓包分析的接口：
 *   - POST /trae/api/v2/ug/checkin_credits/status （查询今日是否已签到）
 *   - POST /trae/api/v2/ug/checkin_credits/claim  （领取今日签到奖励）
 *   两者需要请求头 authorization: Cloud-IDE-JWT <token>。
 *   claim 底层是向 commerce 下一笔 0 元订单，必须携带完整 IDE 客户端上下文头
 *   （package-type / app-version / x-user-region / 设备与市场标识等），
 *   缺失时服务端返回 code 9004「The submitted order parameters are incorrect」。
 *   status 仅查询、不校验这些头；claim（0 元下单）则会被上游风控校验设备标识——
 *   自造的假设备标识时返回 code 9004「The submitted order parameters are incorrect」，
 *   或报「操作太过频繁」。必须使用真实 IDE 抓包里的固定设备标识（REAL_DEVICE）才能通过。
 *   - POST /cloudide/api/v3/common/GetUserToken   （用网页 Cookie 换取新的 8 小时 JWT）
 *   - POST /cloudide/api/v3/trae/CheckLogin       （查询网页会话状态与到期时间）
 *   两者均无请求鉴权头，完全靠 Cookie（核心为 X-Cloudide-Session 与 sessionid 族）。
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto';

// 网页端 User-Agent（GetUserToken/CheckLogin 按网页请求特征发送，不能用 IDE 的 UA）
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

// 真实 IDE 成功签到抓包里使用的固定设备身份（2026-08-15 与 2026-08-18 两处抓包同值）。
// 实测：程序自造的假设备标识会被上游风控识别、claim 报「操作太过频繁」；
// 使用这一套真实设备标识 + app-version 0.1.51 时 claim 返回 code 0（同一设备当日多次 claim 均通过）。
const REAL_DEVICE = {
  vscodeSessionId: '0ec2815d877a858e8e735d7c63cfd406d5f7456e417eecf3a3003f0983560b51',
  marketUserId: '27d676f6-393e-4bc7-833c-2dc7a0da0dc2',
  deviceId: '3798161405005257',
};

const DEVICE = { ...REAL_DEVICE };

/**
 * 返回已知可用的固定设备标识。
 * 之前按 seed 捏造独立设备标识会导致 claim 报「操作太过频繁」；
 * 已验证多个账号复用这一套真实设备标识均可正常签到，故这里一律返回固定值。
 * @param {string} _seed 保留参数，仅用于兼容旧调用
 */
export function deriveDevice(_seed) {
  return { ...REAL_DEVICE };
}

export class CheckinClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.token  Cloud-IDE-JWT 凭证（可由 cookie 自动刷新获得）
   * @param {string} [opts.cookie]  网页端整段 Cookie（长期凭证，用于换取 JWT）
   * @param {(path:string, opts:object)=>Promise<Response>} [opts.fetchImpl]
   */
  constructor({ baseUrl, token, cookie = '', fetchImpl = fetch, device, appVersion = '0.1.51' }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.cookie = cookie;
    this.fetch = fetchImpl;
    this.device = device || { ...DEVICE };
    this.appVersion = appVersion;
    // 网页端 origin/referer：国内 api.trae.cn → www.trae.cn，国际 api.trae.com → www.trae.com
    this.webOrigin = /\.cn($|\/)/.test(this.baseUrl) || this.baseUrl.includes('trae.cn')
      ? 'https://www.trae.cn'
      : 'https://www.trae.com';
  }

  _headers() {
    return {
      'authorization': `Cloud-IDE-JWT ${this.token}`,
      'content-type': 'application/json',
      'accept': '*/*',
      'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
      // IDE 客户端上下文头：claim（0 元下单）必需，其余 /trae/api/* 接口照发无害
      'vscode-sessionid': this.device.vscodeSessionId,
      'x-market-client-id': 'VSCode 1.107.1',
      'x-market-user-id': this.device.marketUserId,
      'x-user-region': 'CN',
      'x-device-brand': '82JW',
      'x-device-id': this.device.deviceId,
      'x-device-type': 'windows',
      'x-lgw-req-sdk-type': '3',
      'package-type': 'stable_cn',
      'x-request-id': randomUUID(),
      'x-lscbd-aid': '787976',
      'x-lscbd-platform': 'windows',
      'app-version': this.appVersion,
    };
  }

  async _post(pathname, body = {}) {
    const res = await this.fetch(`${this.baseUrl}${pathname}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${pathname}`);
    }
    return res.json();
  }

  /** 网页端请求头：Cookie 鉴权（无 authorization），带浏览器 UA 与 origin/referer */
  _webHeaders(extra = {}) {
    return {
      'accept': 'application/json, text/plain, */*',
      'user-agent': BROWSER_UA,
      'origin': this.webOrigin,
      'referer': this.webOrigin + '/',
      'cookie': this.cookie,
      ...extra,
    };
  }

  /**
   * 用网页 Cookie 换取全新的 Cloud-IDE-JWT（8 小时有效，有效期内调用幂等返回同一 token）。
   * 空请求体，鉴权完全靠 Cookie；响应 Result 含 Token / ExpiredAt / UserID / TenantID。
   * @returns {Promise<{Token:string, ExpiredAt:string, UserID:string, TenantID:string}>}
   */
  async getUserToken() {
    if (!this.cookie) throw new Error('未配置 Cookie，无法刷新凭证');
    const res = await this.fetch(`${this.baseUrl}/cloudide/api/v3/common/GetUserToken`, {
      method: 'POST',
      headers: this._webHeaders(),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for GetUserToken（Cookie 可能已失效）`);
    }
    const data = await res.json();
    const r = data && data.Result;
    if (!r || !r.Token) {
      const msg = (data && (data.Message || data.message)) || JSON.stringify(data).slice(0, 200);
      throw new Error(`GetUserToken 未返回 Token（Cookie 凭证可能无效）: ${msg}`);
    }
    return r;
  }

  /**
   * 查询网页会话状态（Cookie 鉴权）。
   * @returns {Promise<{IsLogin:boolean, ExpiredAt:number, UserID:string, Region:string}>}
   *   ExpiredAt 为毫秒时间戳，是 X-Cloudide-Session 会话的精确到期时间（约 14 天，使用中滑动续期）。
   */
  async checkLoginSession() {
    if (!this.cookie) throw new Error('未配置 Cookie，无法查询会话状态');
    const res = await this.fetch(`${this.baseUrl}/cloudide/api/v3/trae/CheckLogin`, {
      method: 'POST',
      headers: this._webHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ GetNickNameEditStatus: true }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for CheckLogin（Cookie 可能已失效）`);
    }
    const data = await res.json();
    const r = data && data.Result;
    if (!r) {
      const msg = (data && (data.Message || data.message)) || JSON.stringify(data).slice(0, 200);
      throw new Error(`CheckLogin 响应异常: ${msg}`);
    }
    return r;
  }

  /** 查询今日签到状态 */
  async status() {
    const data = await this._post('/trae/api/v2/ug/checkin_credits/status');
    if (data.code !== 0) {
      throw new Error(`查询签到状态失败: ${data.message}`);
    }
    return data;
  }

  /** 领取今日签到奖励 */
  async claim() {
    const data = await this._post('/trae/api/v2/ug/checkin_credits/claim');
    if (data.code !== 0) {
      throw new Error(`领取签到奖励失败: ${data.message}`);
    }
    return data;
  }

  /** 一次完整签到：若今日尚未签到则领取，返回结果 */
  async checkin() {
    const st = await this.status();
    if (st.checked_in) {
      return { alreadyCheckedIn: true, status: st, claimed: null };
    }
    const claimed = await this.claim();
    return { alreadyCheckedIn: false, status: st, claimed };
  }

  /**
   * 查询账户全部权益包（含各包积分额度与已用量）。
   * 响应无 code 包装，直接返回数据结构。
   */
  async entitlements() {
    return this._post('/trae/api/v2/pay/user_current_entitlement_list', {
      require_usage: true,
      full_data: true,
    });
  }

  /**
   * 查询账户全部权益包（含各包积分额度与已用量），并从中提取每日签到记录。
   * @returns {Promise<{total:number, packs:Array, checkins:Array}>}
   */
  async totalCredits() {
    const data = await this.entitlements();
    const checkins = [];
    const packs = (data.user_entitlement_pack_list || []).map((p) => {
      const info = p.entitlement_base_info || {};
      const limit = info.quota?.credits_limit;
      const used = p.usage?.credits_amount ?? 0;
      const pack = {
        desc: p.display_desc,
        group: p.group_name,
        limit,
        used,
        // 无 credits_limit 的包（如订阅）不计入积分
        remaining: limit == null ? null : limit - used,
      };
      // 每日签到记录：entitlement_id 形如 checkin_YYYYMMDD_<userId>
      const m = /^checkin_(\d{8})(?:_|$)/.exec(info.entitlement_id || '');
      if (m) {
        checkins.push({
          date: formatDate(m[1]),
          startTime: info.start_time,
          endTime: info.end_time,
          credits: limit ?? 0,
          used,
        });
      }
      return pack;
    });
    const total = packs.reduce((sum, p) => sum + (p.remaining || 0), 0);
    // 按日期升序排列
    checkins.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { total, packs, checkins };
  }

  /**
   * 查询用户按会话分组的用量记录（原样转发，不做任何整理）。
   * @param {object} params 请求体，如 { start_time, end_time, page_size, page_num, usage_type }
   * @returns {Promise<object>} 上游原样返回的 JSON
   */
  async usageGroupBySession(params = {}) {
    return this._post('/trae/api/v1/pay/query_user_usage_group_by_session', params);
  }
}

/** 将 YYYYMMDD 格式化为 YYYY-MM-DD */
function formatDate(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/**
 * 解码 JWT payload，返回 claims（含秒级 exp/iat）；非 JWT 或解析失败返回 null。
 */
export function decodeJwtClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * 从整段 Cookie 字符串解析 sid_guard 的有效期（毫秒时间戳），解析不出返回 null。
 * sid_guard 格式：value|签发秒级时间戳|有效秒数|到期GMT时间串
 * 它标注的是字节 passport 会话（sessionid）的寿命（约 60 天）。
 */
export function parseSidGuardExpiry(cookieStr) {
  try {
    const m = /(?:^|;\s*)sid_guard=([^;]+)/.exec(String(cookieStr || ''));
    if (!m) return null;
    const parts = decodeURIComponent(m[1]).split('|');
    if (parts.length >= 4) {
      const t = Date.parse(parts[3].trim());
      if (!Number.isNaN(t)) return t;
    }
    if (parts.length >= 3 && Number(parts[1]) > 0 && Number(parts[2]) > 0) {
      return (Number(parts[1]) + Number(parts[2])) * 1000;
    }
    return null;
  } catch {
    return null;
  }
}