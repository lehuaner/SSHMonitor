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
 *   或报「操作太过频繁」。部分上游风控会校验设备标识，若派生值被拒，可将一套
 *   真实 IDE 抓包的设备标识写入 ~/.monitor_data/device_identity.json 或账号配置（见 deriveDevice）。
 *   - POST /cloudide/api/v3/common/GetUserToken   （用网页 Cookie 换取新的 8 小时 JWT）
 *   - POST /cloudide/api/v3/trae/CheckLogin       （查询网页会话状态与到期时间）
 *   两者均无请求鉴权头，完全靠 Cookie（核心为 X-Cloudide-Session 与 sessionid 族）。
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto';

// 网页端 User-Agent（GetUserToken/CheckLogin 按网页请求特征发送，不能用 IDE 的 UA）
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

// 设备标识三级来源（公开仓库不内置任何真实抓包值）：
//   1) 账号配置覆盖：provider 层以 task.config.deviceId 优先注入（trae 表单「设备 ID」）；
//   2) 部署级真实标识：~/.monitor_data/device_identity.json
//      { "vscodeSessionId": "...", "marketUserId": "...", "deviceId": "..." }（可选，需自行抓包）；
//   3) 兜底：按 seed 稳定派生（每账号一套、重启不变）。
// 历史实测：同一部署固定一套标识 + app-version 0.1.51 时 claim 可通过；若派生值
// 被上游风控拒绝（报「操作太过频繁」/code 9004），按 2) 提供真实抓包值即可。
import { loadJSON, DATA_DIR } from '../utils.js';

const IDENTITY_FILE = DATA_DIR + '/device_identity.json';
let identityCache;
function fileIdentity() {
  if (identityCache === undefined) {
    try {
      const j = loadJSON(IDENTITY_FILE, {});
      identityCache = (j && (j.deviceId || j.vscodeSessionId || j.marketUserId)) ? j : null;
    } catch { identityCache = null; }
  }
  return identityCache;
}

// 由 seed 稳定派生十六进制串（同一账号始终得到同一套标识）
function hexFrom(seed, len) {
  let out = '';
  let i = 0;
  while (out.length < len) out += createHash('sha256').update(seed + '#' + i++).digest('hex');
  return out.slice(0, len);
}

/**
 * 返回该任务应使用的设备标识。
 * 优先 ~/.monitor_data/device_identity.json 的部署级真实标识；无则按 seed 派生。
 * @param {string} seed 通常为 taskId + '|trae'，保证每账号独立且稳定
 */
export function deriveDevice(seed) {
  const file = fileIdentity();
  if (file) {
    return {
      vscodeSessionId: file.vscodeSessionId || hexFrom(String(seed) + '|sid', 64),
      marketUserId: file.marketUserId || hexFrom(String(seed) + '|uid', 8) + '-' +
        hexFrom(String(seed) + '|uid', 12).slice(0, 4) + '-' +
        hexFrom(String(seed) + '|uid', 12).slice(4, 8) + '-' +
        hexFrom(String(seed) + '|uid', 12).slice(8, 12) + '-' + hexFrom(String(seed) + '|uid', 24),
      deviceId: file.deviceId || hexFrom(String(seed), 16).replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10)).replace(/^0/, '7'),
    };
  }
  const s = String(seed || 'default');
  const uuid = hexFrom(s + '|u', 32);
  return {
    vscodeSessionId: hexFrom(s + '|s', 64),
    marketUserId: uuid.slice(0, 8) + '-' + uuid.slice(8, 12) + '-4' + uuid.slice(13, 16) + '-' + uuid.slice(16, 20) + '-' + uuid.slice(20, 32),
    deviceId: hexFrom(s, 16).replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10)).replace(/^0/, '7'),
  };
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
    this.device = device || deriveDevice('default');
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
   *
   * ★start_time / end_time 是上游原样给的 epoch 秒（实测：签到包 start→end 恰为 31 天，
   *   如 checkin_20260814 → start 1786745857 / end 1789424257）。
   *   这里一并把 endMs（epoch 毫秒）带上，供「积分过期提醒」直接消费，避免下游再猜单位。
   *
   * @returns {Promise<{total:number, packs:Array, checkins:Array}>}
   */
  async totalCredits() {
    const data = await this.entitlements();
    const checkins = [];
    const packs = (data.user_entitlement_pack_list || []).map((p) => {
      const info = p.entitlement_base_info || {};
      const limit = info.quota?.credits_limit;
      const used = p.usage?.credits_amount ?? 0;
      const startSec = Number(info.start_time) || null;
      const endSec = Number(info.end_time) || null;
      const pack = {
        desc: p.display_desc,
        group: p.group_name,
        limit,
        used,
        // 无 credits_limit 的包（如订阅）不计入积分
        remaining: limit == null ? null : limit - used,
        // ★到期时间：积分过期提醒的数据源（endMs 为 null 表示该包无到期概念）
        startTime: startSec,
        endTime: endSec,
        endMs: endSec && endSec > 0 ? endSec * 1000 : null,
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