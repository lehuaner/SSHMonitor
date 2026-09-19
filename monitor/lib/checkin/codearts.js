/**
 * CodeArts（码道 / CodeArts Agent）签到客户端 —— 零依赖，仅用 node:https + node:crypto。
 *
 * 与 `examples/codearts_login.py` 1:1 对应（Python 版已用真实账号全链路实测通过）：
 *   · 设备指纹 fp：XOR（key 滚动为密文字节）→ base64；`cs = SHA1(serialized)`
 *   · 登录链：authui → UnifiedIDMPortal ①~⑦ → OAuth 换票 → 业务 cookie
 *   · 设备信任：hwid_cas_sid（10 年有效）—— ★本项目主方案，登录时携带即免设备验证
 *   · 设备验证（requestVerifyCode / submitVerifyCode）：★ 2026-09-12 已按抓包改走
 *     **UnifiedIDMPortal 同端点重试**（`opType=1` + 验证码），不再走 CAS 命名空间，
 *     详见下面「★ 2026-09-12 抓包订正」。
 *
 * ★ 三条必须遵守的实测结论（否则会静默失败）：
 *   1. 登录态失效**不改 HTTP 状态码**：HTTP 200 + 空体 + 响应头 `HW-AJAX-REDIRECT`。
 *   2. ①③④⑤⑥⑦ 与设备验证同属 `/UnifiedIDMPortal/ajaxHandler/`
 *      （`/CAS/IDM_W/ajaxHandler/` 那套是**另一个命名空间**，不共享登录态，勿再使用）；
 *      旧 CAS 分支 `dev` / `analysisHealth` 无 `common/` 前缀，已无调用方。
 *   3. 路径坑：积分总览是 `.../v1/package/overview`、套餐是 `.../v1/package/info`（**有斜杠**），
 *      写成 `package_overview` 会返回 400 `TM.00001001`。
 *
 * ★★ 2026-09-12 抓包订正（examples/codearts首次登录与二次登录_解析结果）★★
 *   a. `unionLoginByPwd` 的 `anonymousLoginID` 必须是**裸匿名账号**（`l****an`）。
 *      带上 `|anonymousEncryption` 会让服务端查不到登录流程上下文，报
 *      `10000000 loginFlowContext is empty!` —— 即长期的「密码重登链失效」根因。
 *   b. 落地业务站点必须**逐跳手动跟随并保留 `?ticket=ST-…`**：链路的第 2 跳就跨域，
 *      而 `follow` 默认仅同源，旧实现会丢掉 ticket，拿不到 `…agencyID` / `…tcftk`。
 *   c. `needPopTrust=true` 时要补 `login/updateTrustBrowser`（`operType=1&trustBrowser=1`）。
 *   d. 设备验证 = 同端点第二次调用 + `opType=1` + `verifyUserAccount`/`verifyAccountType`
 *      + `twoStepVerifyCode`；`10002080` 响应的 `errorDesc` 里就带 `authCodeSentList`。
 *   e. 中途可能出现「绑定 MFA」提示页（`loginBindMfa.html`）：`IAMCSRF` 取自
 *      `authui/getAntiPhishingInfo`，POST `authui/validateUser`（`step=afterBindMfa`,
 *      `isConfirmed=false`）即可放行，并回种 30 天抑制 cookie。
 */
import { createHash } from 'node:crypto';
import https from 'node:https';

// ==========================================================================
// 常量
// ==========================================================================
export const HOST = 'https://codearts.huaweicloud.com';
const SERVICE = `${HOST}/portal/settings/personal-usage?locale=zh-cn`;
const CAS_SERVICE = `https://auth.huaweicloud.com/authui/casLogin?service=${encodeURIComponent(SERVICE)}`;
const LOGIN_PAGE = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(SERVICE)}`;

const ID1 = 'https://id1.cloud.huawei.com';
const AJAX_NEW = `${ID1}/UnifiedIDMPortal/ajaxHandler`; // 登录阶段
const AJAX_CAS = `${ID1}/CAS/IDM_W/ajaxHandler`;        // 设备验证阶段

const REQ_CLIENT_TYPE = '88';
const LOGIN_CHANNEL = '88000000';
const CLIENT_ID = '103493351';
const LANG = 'zh-cn';
const REGION_CODE = 'cn';
const THEME_NAME = 'lightred';
const SCOPE = 'https://www.huawei.com/auth/account/unified.profile'
  + '+https://www.huawei.com/auth/account/risk.idstate'
  + '+LoginState';
const CVERSION_FALLBACK = 'UP_CAS_6.26.2.100_blue';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

/** 业务会话 cookie（登录成功的判据） */
export const SESSION_COOKIES = [
  'devclouddevuibjJ_SESSION_ID',
  'devclouddevuibjagencyID',
  'devclouddevuibjtcftk',
];

/** 登录态失效信号（响应头名，小写） */
export const EXPIRY_HEADER = 'hw-ajax-redirect';

/** unionLoginByPwd 以 isSuccess=0 + 该错误码要求设备验证 */
export const NEED_VERIFY_CODES = ['10002080'];

/**
 * 业务端点（★ package 与 overview/info 之间有斜杠）
 *
 * ★★ 2026-09-12 重大变更：每日签到已从「套餐积分」接口迁移到「运营活动中心」接口 ★★
 *   旧：GET /portal/snap-manager/v1/credit/has-claimed  +  POST .../credit/claim
 *   新：GET /portal/promptcenter/v1/ops/delivery?channel=PORTAL  +  POST .../ops/claim
 *
 *   上游把前端从 126.8.310 升级到 126.9.107 时一并切换（新前端里已搜不到
 *   `credit/claim` / `has-claimed` 字样，只调 promptcenter/ops/*）。
 *   旧路由**仍然保留但已不再服务**：HTTP 200 + **完全空响应体**（无 content-type、
 *   无 HW-AJAX-REDIRECT），空体被判成 `false` ⇒ 表现为「凭证有效但签到失败」。
 *   ⚠️ 排查记录见 monitor/_ca_probe_v*.mjs 与 codearts_checkin平台全流程方案.md §13。
 */
export const ENDPOINTS = {
  // ---- 已废弃（仅保留常量以便回归对照，勿再用于签到判定）----
  hasClaimed: '/portal/snap-manager/v1/credit/has-claimed',
  claim: '/portal/snap-manager/v1/credit/claim',
  // ---- ★现行：运营活动中心（活动福利 / 每日签到）----
  opsDelivery: '/portal/promptcenter/v1/ops/delivery',
  opsClaim: '/portal/promptcenter/v1/ops/claim',
  opsCreditOverview: '/portal/promptcenter/v1/ops/credit/overview',
  opsCreditCampaign: '/portal/promptcenter/v1/ops/credit/campaign',   // + `/{campaignId}`
  packageOverview: '/portal/snap-manager/v1/package/overview',
  packageInfo: '/portal/snap-manager/v1/package/info',
  restMe: '/portal/rest/me',
  memberRoles: '/portal/snap-manager/v1/member_roles',
  ssoUser: '/portal/snap-manager/v1/sso_user',
  // 用量分析（个人用量页 /portal/settings/personal-usage 的数据源）
  usageCharts: '/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/charts',
  usageStats: '/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/stats',
  usageHeatmap: '/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/heatmap',
  // 用量筛选选项（★可选日期范围：startDate/endDate 即「近 N 天」的入口）
  usageFilters: '/portal/dataflywheel/datapreprocess/v1/analytics/filters/options',
  // ★权益包明细分页（比 package/overview 的 4 个聚合桶更细：逐包 金额/已用/到期时间）
  creditPage: '/portal/snap-manager/v1/package/credit/page',
};

const CREDIT_TYPE = 'daily_bonus';   // 旧接口入参（已废弃，见 ENDPOINTS 注释）

/** 运营活动的 channel（前端常量 `IZn = "PORTAL"`） */
export const OPS_CHANNEL = 'PORTAL';
/** 每日签到活动的 type（前端 `npc.DAILY_CLAIM`，实际下发为 `USER_LOGIN`） */
export const OPS_DAILY_TYPES = ['USER_LOGIN', 'DAILY_CLAIM'];
const REFERER_USAGE = `${HOST}/portal/settings/personal-usage?locale=zh-cn`;

// ==========================================================================
// 指纹算法（与前端 JS / Python 版逐字节等价）
// ==========================================================================

const FP_PROFILE = {
  bsh: 856, bsw: 1496,
  devs: '', ips: '',
  epl: 5,
  ett: 0,               // 每次生成时填当前毫秒
  etz: -480,            // UTC+8
  nacn: 'Mozilla', nan: 'Netscape', nce: 'true',
  nlg: 'zh-CN', npf: 'Win32',
  sah: 1032, saw: 1920, sh: 1080, sw: 1920,
};

export function sha1Hex(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex');
}

/**
 * 明文 → 密文字节。key 初值 211；每步 `c = p ^ (key-1)`，随后 `key ← c`（密文字节）。
 * @returns {Buffer}
 */
export function xorEncrypt(data) {
  let key = 211;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const c = (data.charCodeAt(i) ^ (key - 1)) & 0xff;
    out[i] = c;
    key = c;
  }
  return out;
}

/** 密文字节 → 明文（★不是 xorEncrypt 的自反调用，key 同样滚动为密文字节） */
export function xorDecrypt(buf) {
  let key = 211;
  let out = '';
  for (const c of buf) {
    out += String.fromCharCode((c ^ (key - 1)) & 0xff);
    key = c;
  }
  return out;
}

/** 按键名升序序列化为 `k=v&k=v`，key/value 都做 encodeURIComponent 风格编码 */
export function serializePairs(pairs) {
  return Object.keys(pairs).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(pairs[k])}`)
    .join('&');
}

/**
 * 生成合法设备指纹 fp。
 * 服务端只校验 `cs = SHA1(serialized)` 的完整性，故用 seed 派生稳定的伪哈希字段：
 * 同一 seed 每次生成完全一致，天然满足「设备指纹稳定」要求。
 */
export function buildFp(seed = 'codearts-checkin', nowMs = Date.now()) {
  const pairs = { ...FP_PROFILE, ett: nowMs };
  const h = (tag) => sha1Hex(`${seed}|${tag}`);
  pairs.canvas = h('canvas');
  pairs.webgl = h('webgl');
  pairs.fonts = h('fonts');
  pairs.ep = h('ep');
  pairs.epls = ['P', 'C', 'M', 'W'].map((p) => p + h(p)).join(',');
  const serialized = serializePairs(pairs);
  const body = `${serialized}&cs=${sha1Hex(serialized)}`;
  return Buffer.from(xorEncrypt(body)).toString('base64');
}

/** 反解 fp（自检 / 调试用） */
export function decodeFp(fp) {
  return xorDecrypt(Buffer.from(String(fp), 'base64'));
}

/**
 * 从 `errorDesc`（JSON 字符串或对象）里抽出 `authCodeSentList`。
 * 不携带受信 sid 时，服务端把「已下发验证码的设备列表」塞在这里。
 */
export function parseAuthCodeSentList(raw) {
  if (!raw) return [];
  let desc = raw;
  if (typeof desc === 'string') {
    try { desc = JSON.parse(desc); } catch { return []; }
  }
  if (!desc || typeof desc !== 'object') return [];
  const list = desc.authCodeSentList || [];
  return Array.isArray(list) ? list.filter((d) => d && typeof d === 'object') : [];
}

/**
 * 图片验证码风控门错误码集合。
 * 命中即 fail-fast：不尝试过码（用户规则；过码依赖网易私有协议，不稳定且违反判定约定）。
 */
export const RISK_CAPTCHA_CODES = ['10000706'];

/** 验证方式：手机号（accountType=2）。设备验证为 -1。 */
export const VERIFY_TYPE_PHONE = 2;

/**
 * 是否命中「图片验证码风控门」。
 * 双通道判定：errorCode=10000706，或 errorDesc 文案含 `need picture authcode`
 * （orgErrorCode 70002082）。命中即 fail-fast，调用方不得重试。
 * @param {object} res 任一登录链响应
 * @returns {boolean}
 */
export function isRiskCaptcha(res) {
  if (!res || typeof res !== 'object') return false;
  if (RISK_CAPTCHA_CODES.includes(String(res.errorCode || ''))) return true;
  const desc = res.errorDesc
    || (res.localInfo && res.localInfo.errorDesc) || '';
  return /picture\s+authcode/i.test(String(desc));
}

/**
 * 解析 `getSDKBaseInfo` 的 `hwidConfig`。
 *
 * ★ 它是**一层 URL 编码的 JSON 字符串**（实测 14k+ 字符、解码后 87 个键），
 *   不是对象。把它当对象用会静默拿不到任何字段 —— `cookieVersion` 会一直退回
 *   常量兜底，`localStorageID` 会一直是空串（与抓包不一致）。
 *   解码后关心的键：`cookieVersion` / `localStorageID` / `service` / `loginUrl`。
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>} 解析失败返回空对象
 */
export function parseHwidConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;          // 兼容上游将来直接回对象
  try {
    const parsed = JSON.parse(decodeURIComponent(String(raw)));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

// ==========================================================================
// HTTP 客户端（自建 cookie jar：需要精确控制 redirect / set-cookie / 域清理）
// ==========================================================================

export class HttpClient {
  constructor({ timeout = 25000 } = {}) {
    this.timeout = timeout;
    /** Map<name, {value, domain}> */
    this.jar = new Map();
    this.cversion = CVERSION_FALLBACK;
  }

  // ---------------- cookie ----------------
  cookies() {
    const out = {};
    for (const [name, c] of this.jar) if (c.value) out[name] = c.value;
    return out;
  }

  /** 灌入已保存的 cookie（无域信息，一律发送） */
  restoreCookies(obj) {
    for (const [name, value] of Object.entries(obj || {})) {
      if (value) this.jar.set(name, { value: String(value), domain: '' });
    }
  }

  /** 按域匹配生成 Cookie 请求头（域为空 = 通用，一律发送） */
  cookieHeader(url) {
    const host = new URL(url).hostname;
    const out = [];
    for (const [name, c] of this.jar) {
      if (!c.value) continue;
      const d = (c.domain || '').replace(/^\./, '');
      if (!d || host === d || host.endsWith(`.${d}`)) out.push(`${name}=${c.value}`);
    }
    return out.join('; ');
  }

  _absorbSetCookie(res, url) {
    const raw = res.headers['set-cookie'];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [raw];
    const host = new URL(url).hostname;
    for (const line of list) {
      const seg = String(line).split(';')[0];
      const idx = seg.indexOf('=');
      if (idx <= 0) continue;
      const name = seg.slice(0, idx).trim();
      const value = seg.slice(idx + 1).trim();
      if (!name) continue;
      if (!value) this.jar.delete(name);           // Max-Age=0 → 显式清除
      else this.jar.set(name, { value, domain: host });
    }
  }

  /** 清除 OAuth 域遗留 cookie，避免二次走 OAuth 时串状态 */
  clearOauthCookies() {
    for (const [name, c] of [...this.jar]) {
      const d = (c.domain || '').replace(/^\./, '');
      if (d.endsWith('oauth-login.cloud.huawei.com') || d.endsWith('oauth-login1.cloud.huawei.com')) {
        this.jar.delete(name);
      }
    }
  }

  /**
   * 清空 jar，仅保留 `keep` 列表里的 cookie。
   *
   * ★ 重登前的必经步骤（2026-09-12 v21 定位）：脏 jar 里的旧业务会话 cookie
   *   （`devclouddevuibj*` 等）会被原样带到 OAuth 落地跳，业务站点把票换进
   *   **旧（已失效）会话**而不是签发新会话 —— 症状是 `login()` 返回 ok:true、
   *   jar 里 3/3 业务 cookie「齐」（其实是旧的），而业务接口仍返回
   *   `HW-AJAX-REDIRECT`（=「重登后会话仍无效」）。
   *   实测：脏 jar 重登 → 仍失效；只带 `hwid_cas_sid` 的干净 jar → `code:0` 正常。
   *
   * @param {string[]} keep 要保留的 cookie 名（信任令牌 `hwid_cas_sid`）
   */
  resetKeeping(keep = []) {
    const kept = [];
    for (const [name, c] of this.jar) {
      if (keep.includes(name) && c.value) kept.push([name, c]);
    }
    this.jar = new Map(kept);
  }

  // ---------------- request ----------------
  /**
   * ★会话失效判定：只看响应头 `HW-AJAX-REDIRECT`，**不看 HTTP 状态码**
   * （失效时上游仍返回 200 + 空体 + 该重定向头）。
   */
  static isExpired(headers) {
    if (!headers) return false;
    const v = headers[EXPIRY_HEADER];
    return !!(v && String(v).trim());
  }

  /**
   * @param {'GET'|'POST'} method
   * @param {object} [opts]
   * @param {object} [opts.form]    urlencoded 表单体
   * @param {object} [opts.json]    JSON 体（与 form 互斥）
   * @param {string} [opts.rawBody] 原文请求体（与 form/json 互斥；签名场景必须逐字节可控）
   * @param {object} [opts.headers]
   * @param {boolean} [opts.follow] 自动跟随 3xx（默认 false，需读 Location）
   * @param {number} [opts.maxHops]
   * @param {boolean} [opts.samehostOnly] follow 时仅跟随同源（默认 true，避免被带去外站）
   * @returns {Promise<{status:number,url:string,headers:object,text:string}>}
   */
  async request(method, url, opts = {}) {
    const { form, json, rawBody, headers = {}, follow = false, maxHops = 10 } = opts;
    let body = null;
    if (rawBody !== undefined && rawBody !== null) body = rawBody;
    else if (form) body = new URLSearchParams(form).toString();
    else if (json !== undefined) body = JSON.stringify(json);

    let current = url;
    const origin = new URL(url).origin;

    for (let hop = 0; hop <= maxHops; hop += 1) {
      const u = new URL(current);
      const h = {
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        accept: 'application/json, text/plain, */*',
        referer: 'https://auth.huaweicloud.com/',
        ...headers,
      };
      const cookie = this.cookieHeader(current);
      if (cookie) h.cookie = cookie;
      if (body) {
        // ★调用方自带 content-type（任意大小写）时不再补默认值：
        //   网关签名把 content-type 计入 SignedHeaders，重复头名会让验签/ WAF 判定失败。
        const hasCT = Object.keys(h).some((k) => k.toLowerCase() === 'content-type');
        if (!hasCT) h['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
        h['content-length'] = Buffer.byteLength(body);
      }

      const res = await new Promise((resolve) => {
        const req = https.request({
          method, hostname: u.hostname, port: u.port || 443,
          path: `${u.pathname}${u.search}`, headers: h, timeout: this.timeout,
        }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({
            status: r.statusCode, headers: r.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ status: -1, headers: {}, text: `<${e.message}>` }));
        if (body) req.write(body);
        req.end();
      });

      this._absorbSetCookie(res, current);
      const loc = res.headers.location;
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && !!loc;
      if (follow && isRedirect) {
        const next = new URL(loc, current).href;
        if (opts.samehostOnly !== false && new URL(next).origin !== origin) {
          return { status: res.status, url: current, headers: res.headers, text: res.text, stoppedAt: next };
        }
        current = next;
        if (res.status === 302 || res.status === 303) body = null; // 浏览器行为：转 GET
        continue;
      }
      return { status: res.status, url: current, headers: res.headers, text: res.text };
    }
    return { status: -1, url: current, headers: {}, text: '<too many redirects>' };
  }

  get(url, opts) { return this.request('GET', url, opts); }

  post(url, form, opts) { return this.request('POST', url, { ...opts, form }); }

  postRawJson(url, obj, opts) { return this.request('POST', url, { ...opts, json: obj ?? {} }); }

  async postJson(url, form, opts) {
    const r = await this.post(url, form, opts);
    return parseJsonOr(r);
  }

  async postJsonRaw(url, obj, opts) {
    const r = await this.postRawJson(url, obj, opts);
    return parseJsonOr(r);
  }

  ajax(prefix, path) {
    return `${prefix}/${path}?reflushCode=${Math.random().toFixed(15)}&cVersion=${this.cversion}`;
  }
}

/** 尽力解析 JSON；失败时给出带 _raw/_http 的占位对象（便于诊断） */
function parseJsonOr(res) {
  try { return JSON.parse(res.text); } catch {
    return { isSuccess: 0, _raw: String(res.text).slice(0, 400), _http: res.status };
  }
}

// ==========================================================================
// CodeArts 客户端
// ==========================================================================

export class CodeArtsClient {
  /**
   * @param {object} opts
   * @param {string} [opts.account]      手机号/华为账号（自动重登需要）
   * @param {string} [opts.password]
   * @param {string} [opts.hwidCasSid]   ★设备信任令牌（主方案，10 年有效）
   * @param {string} [opts.localStorageId]
   * @param {string} [opts.fpSeed]       设备指纹种子，同一部署固定即可
   * @param {object} [opts.cookies]      已保存的业务 cookie
   * @param {boolean} [opts.verbose]
   */
  constructor(opts = {}) {
    this.account = opts.account || '';
    this.password = opts.password || '';
    this.hwidCasSid = opts.hwidCasSid || '';
    this.localStorageId = opts.localStorageId || '';
    this.fpSeed = opts.fpSeed || 'codearts-checkin';
    this.verbose = !!opts.verbose;
    this.http = new HttpClient({ timeout: opts.timeout || 25000 });
    this.fp = null;
    this.base = {};
    this.authBase = {};
    this.authDevices = [];
    /** 最近一次 `getLoginIdsByPwd` 的 accountInfo（设备验证二次提交时要复用） */
    this._lastAccountInfo = {};
    if (opts.cookies) this.http.restoreCookies(opts.cookies);
    if (opts.hwidCasSid) this.http.restoreCookies({ hwid_cas_sid: opts.hwidCasSid });
  }

  _log(msg) { if (this.verbose) console.log(`[codearts] ${msg}`); }

  /** 导出可持久化的会话状态（写回 task.config） */
  getState() {
    return {
      hwidCasSid: this.hwidCasSid,
      localStorageId: this.localStorageId,
      cookies: this.http.cookies(),
    };
  }

  _ensureFp() {
    if (!this.fp) this.fp = buildFp(this.fpSeed);
    return this.fp;
  }

  _fmtNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  static normalizeAccount(account) {
    const a = String(account || '').trim();
    return /^1\d{10}$/.test(a) ? `0086${a}` : a;
  }

  // ------------------------------------------------------------------
  // 登录链步骤
  // ------------------------------------------------------------------

  /** ① 打开登录页（建立 WAF 会话）+ ② getSDKBaseInfo */
  async _bootstrap() {
    await this.http.get(LOGIN_PAGE);
    // ★ 抓包（第 29 条）里 `service` 用的是**业务地址本身**（不是 casLogin 包裹串），
    //   并带 `site=mainland`；casLogin 包裹串由服务端在 hwidConfig.service 里回吐。
    const url = 'https://auth.huaweicloud.com/authui/getSDKBaseInfo?flowType=unionLogin'
      + `&service=${encodeURIComponent(SERVICE)}&site=mainland`;
    const r = await this.http.get(url);
    let info;
    try { info = JSON.parse(r.text); } catch { return { isSuccess: 0, _raw: r.text.slice(0, 200) }; }
    const cfg = parseHwidConfig(info.hwidConfig);
    this.base = {
      pageToken: info.pageToken || '', pageTokenKey: info.pageTokenKey || '',
      reqClientType: REQ_CLIENT_TYPE, loginChannel: LOGIN_CHANNEL, clientID: CLIENT_ID,
      lang: LANG, languageCode: LANG, state: info.state || '',
    };
    if (cfg.cookieVersion) this.http.cversion = cfg.cookieVersion;
    // ★ `localStorageID` 只存在于 hwidConfig（顶层没有）。取不到就会一直以空串发送，
    //   与抓包不一致 —— 服务端每次 getSDKBaseInfo 会新发一个（每个流程一个）。
    if (cfg.localStorageID) this.localStorageId = cfg.localStorageID;
    return info;
  }

  /** ③ jsRemoteLogin 预热（抓包中固定返回 10006003，属正常） */
  async _stepJsRemoteLogin() {
    return this.http.postJson(this.http.ajax(AJAX_NEW, 'login/jsRemoteLogin'), {
      ...this.base,
      loginUrl: 'https://auth.huaweicloud.com/authui/login.html#/hwIDLogin',
      service: CAS_SERVICE, themeName: THEME_NAME, jsSiteID: '1',
      scope: SCOPE, client_id: this.base.clientID, access_type: 'offline',
      regionCode: REGION_CODE, localStorageID: this.localStorageId,
    });
  }

  /**
   * ④ 设备指纹上报 → sid。
   * ★ `{CAS}/dev` 无 `common/` 前缀；`{NEW}` 下是 `common/dev`（写错会静默返回空 sid）。
   */
  async _stepDev(prefix, base) {
    const path = prefix === AJAX_CAS ? 'dev' : 'common/dev';
    const data = { ...base, fp: this._ensureFp(), localStorageID: this.localStorageId };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    const res = await this.http.postJson(this.http.ajax(prefix, path), data);
    if (res && res.sid) {
      this.hwidCasSid = res.sid;
      this.http.restoreCookies({ hwid_cas_sid: res.sid });
    }
    if (res && res.localStorageID) this.localStorageId = res.localStorageID;
    if (res && res.cookieVersion) this.http.cversion = res.cookieVersion;
    return res || {};
  }

  /** ⑤ 健康上报（CAS 下无 `common/` 前缀） */
  async _stepHealth(prefix, base, currentUri) {
    const path = prefix === AJAX_CAS ? 'analysisHealth' : 'common/analysisHealth';
    const message = {
      currentUri: currentUri || (prefix === AJAX_CAS
        ? '/CAS/portal/authIdentify.html'
        : '/UnifiedIDMPortal/unionLogin/portal/index.html'),
      isOpenCookie: 'true', isOpenPerformance: true, isSupportES6: true,
      dNSTake: '0', tCPTake: '0', reqRespTake: '41', totalTake: '642',
      whiteScreenTake: '78', resourceDataSize: 594103, domDisplayTake: '287',
      reqReadyTake: '39', currentLocaleTime: this._fmtNow(),
      resources: [], extInfo: { isSwitchWiseContent2SLB: false },
    };
    const data = {
      ...base, operType: '1000', message: JSON.stringify(message),
      illnessType: '0', localStorageID: this.localStorageId,
    };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    return this.http.postJson(this.http.ajax(prefix, path), data);
  }

  /** ⑥ 账号识别 */
  async _stepLoginIds() {
    const data = {
      ...this.base, userAccount: CodeArtsClient.normalizeAccount(this.account),
      password: this.password, localStorageID: this.localStorageId,
    };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    return this.http.postJson(this.http.ajax(AJAX_NEW, 'login/getLoginIdsByPwd'), data);
  }

  /**
   * ⑦ 密码登录。
   *   · 携带受信 `hwid_cas_sid` → 直接 `isSuccess=1`（跳过设备验证）
   *   · 未受信 → `isSuccess=0 + errorCode=10002080`，`errorDesc` 里带 `authCodeSentList`
   *     （验证码此时已下发）；再用本方法带 `extra` 调第二次即可通过。
   *
   * @param {object} accountInfo `getLoginIdsByPwd` 的 `accountInfoList[0]`
   * @param {string} hwmeta 风控 hwmeta（实测空串也被接受）
   * @param {object} [extra] 设备验证二次提交：
   *        `{twoStepVerifyCode, verifyUserAccount, verifyAccountType}`（内部自动置 `opType=1`）
   */
  async _stepUnionLogin(accountInfo = {}, hwmeta = '', extra = {}) {
    const verifying = extra.twoStepVerifyCode !== undefined && extra.twoStepVerifyCode !== '';
    const data = {
      ...this.base,
      userAccount: CodeArtsClient.normalizeAccount(this.account),
      password: this.password,
      service: CAS_SERVICE,
      bsAcctService: CAS_SERVICE.replace('/casLogin?', '/casLoginAPP?'),
      hwmeta,
      localLogin: 'false', quickAuth: 'false', isThirdBind: '0',
      opType: verifying ? '1' : '0',
      scope: SCOPE, access_type: 'offline',
      // ★★ 必须是「裸匿名账号」（如 `l****an`），**不能**拼 `|anonymousEncryption`。
      //    曾经写成 `${anonymousAccount}|${anonymousEncryption}`（把 JWT 一起带上），
      //    服务端据此查不到登录流程上下文 → `10000000 loginFlowContext is empty!`，
      //    表现为「凭证有效、但自动重登永远失败」。抓包
      //    （examples/codearts首次登录与二次登录_解析结果，第 96/108/279 条）里
      //    三次 `unionLoginByPwd` 全都是 `anonymousLoginID=l****an`，无任何后缀；
      //    实测改回裸账号后立刻 `isSuccess=1`（探针 _ca_probe_v13.mjs V2/V3）。
      anonymousLoginID: accountInfo.anonymousAccount || '',
      registerCountry: REGION_CODE, serial: String(accountInfo.serial ?? 0),
      localStorageID: this.localStorageId,
    };
    if (verifying) {
      data.verifyUserAccount = String(extra.verifyUserAccount || '');
      data.verifyAccountType = String(extra.verifyAccountType ?? -1);
      data.twoStepVerifyCode = String(extra.twoStepVerifyCode);
    }
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    const res = await this.http.postJson(this.http.ajax(AJAX_NEW, 'login/unionLoginByPwd'), data);
    // ★ 登录成功时服务端会下发**新的 localStorageID**（抓包第 110 条响应：
    //   `AqadBXxTb14y…` → `6XL8nfDBem7…`）。后续 `updateTrustBrowser`（第 113 条）
    //   必须用这个新值，否则服务端找不到登录流程上下文。
    //   10002080（需验证）响应不换 localStorageID，此句为空操作，安全。
    if (res && res.localStorageID) this.localStorageId = res.localStorageID;
    return res;
  }

  /**
   * ⑦b 信任本浏览器（抓包第 111 条）。
   * `unionLoginByPwd` 成功响应带 `needPopTrust:true` 时调用；成功后 OAuth 才能正常换票。
   */
  async _stepTrustBrowser(accountInfo = {}, operType = '1') {
    const data = {
      ...this.base,
      userAccount: CodeArtsClient.normalizeAccount(this.account),
      operType,
      trustBrowser: '1',
      anonymousLoginID: accountInfo.anonymousAccount || '',
      localStorageID: this.localStorageId,
    };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    return this.http.postJson(this.http.ajax(AJAX_NEW, 'login/updateTrustBrowser'), data);
  }

  /**
   * ⑧ 手机号验证支线：显式请求下发短信（2026-09-12 抓包第 137 条，实测 isSuccess=1）。
   *
   * ★★ 与设备分支的本质差异：设备项 `sent=1` —— 10002080 响应到达时验证码
   *    **已自动下发**；手机号项 `sent=0` —— **不会自动发**，必须调本方法。
   *    逐字段对齐抓包：`accountType=2`、`mobilePhone=打码值原样回传`
   *    （postJson 的表单序列化会自动编码成 `191%2A%2A...75`）、
   *    `operType=8`、`smsReqType=6`；**不带 authcode**（无图片验证码门时）。
   *
   * @param {object} item `authCodeSentList` 里的手机号项
   */
  async _stepGetSmsCodeV3(item = {}) {
    const data = {
      ...this.base,
      userAccount: CodeArtsClient.normalizeAccount(this.account),
      accountType: String(item.accountType ?? VERIFY_TYPE_PHONE),
      mobilePhone: String(item.name || ''),
      operType: '8',
      smsReqType: '6',
      localStorageID: this.localStorageId,
    };
    if (this.hwidCasSid) data.hwid_cas_sid = this.hwidCasSid;
    return this.http.postJson(this.http.ajax(AJAX_NEW, 'login/getSMSCodeV3'), data);
  }

  /**
   * 确保「手机号验证项」的短信真的发出去了（幂等：成功即置 `sent=1`，可重入）。
   * 设备项（sent=1）不在此列 —— 它的验证码早已自动下发，重复发 SMS 反而多余。
   * @returns {Promise<{ok:boolean, skipped?:boolean, error?:string, detail?:object}>}
   */
  async _ensureSmsSent() {
    const phone = this.authDevices
      .find((d) => Number(d.accountType) === VERIFY_TYPE_PHONE && d.sent !== 1);
    if (!phone) return { ok: true, skipped: true };
    const sms = await this._stepGetSmsCodeV3(phone);
    if (Number(sms.isSuccess) === 1) {
      phone.sent = 1;                    // 供 submitVerifyCode 的 sent===1 选取逻辑生效
      return { ok: true };
    }
    return {
      ok: false,
      error: `短信下发失败：${sms.errorDesc || sms.errorCode || '未知'}`,
      detail: sms,
    };
  }

  /** ⑨ OAuth 换票 → 落地业务 cookie */
  async _finishOauth(callbackUrl) {
    if (!callbackUrl) return { ok: false, error: 'callbackURL 为空' };

    const r0 = await this.http.get(callbackUrl);
    let authorizeUrl = callbackUrl;
    if ([301, 302, 303, 307, 308].includes(r0.status) && r0.headers.location) {
      authorizeUrl = new URL(r0.headers.location, callbackUrl).href;
    }
    await this.http.get(authorizeUrl);

    const au = new URL(authorizeUrl);
    const params = Object.fromEntries(au.searchParams.entries());
    if (!params.ticket) {
      return { ok: false, error: 'authorize URL 缺少 ticket', detail: authorizeUrl.slice(0, 200) };
    }

    const gw = await this.http.postJson(
      `https://${au.host}/oauth2/ajax/getLoginWay?reflushCode=${Math.random().toFixed(15)}&display=page`,
      params,
      { headers: { origin: `https://${au.host}`, interfaceVersion: 'v3', fromLoginAuth: 'false' } },
    );
    if (String(gw.isSuccess) !== 'true') return { ok: false, error: 'getLoginWay 失败', detail: gw };

    const sig = gw.signatureInfo || {};
    const casRedirect = (((gw.loginInteractInfo || {}).cas) || {}).casLoginRedirectUrl;
    if (!casRedirect) return { ok: false, error: '未取到 casLoginRedirectUrl', detail: gw };

    // CAS remoteLogin → loginCallback（★必须访问该页以建立 OAuth ticket 状态，不可跳过）
    const r1 = await this.http.get(casRedirect);
    const loginCallback = (r1.status === 302 && r1.headers.location)
      ? new URL(r1.headers.location, casRedirect).href : r1.url;
    if (!loginCallback) return { ok: false, error: 'CAS 未返回 loginCallback', detail: r1.status };
    await this.http.get(loginCallback);

    const cb = Object.fromEntries(new URL(loginCallback).searchParams.entries());
    if (!cb.ticket) {
      return { ok: false, error: 'loginCallback 缺少 ticket', detail: loginCallback.slice(0, 200) };
    }

    const payload = {
      ...sig, ticket: cb.ticket, siteID: cb.siteID || '1', countryCode: cb.countryCode || 'CN',
    };
    const lr = await this.http.postJson(
      `https://${au.host}/oauth2/ajax/login?reflushCode=${Math.random().toFixed(15)}&display=page`,
      payload,
      { headers: { origin: `https://${au.host}`, interfaceVersion: 'v3', fromLoginAuth: 'false' } },
    );
    if (String(lr.isSuccess) !== 'true') return { ok: false, error: 'oauth2/ajax/login 失败', detail: lr };
    if (!lr.code) return { ok: false, error: 'oauth2/ajax/login 未返回 code', detail: lr };

    // ★ 落地必须**手动逐跳**跟随，且每一跳都保留地址里的 `?ticket=ST-…`。
    //   `HttpClient` 的 `follow` 默认只在**同源**内跟随（`samehostOnly`），而这条链的
    //   第 2 跳就跨到了 `codearts.huaweicloud.com`：旧实现跟到跨域即停，
    //   随后直接 GET `SERVICE`（**把 ticket 丢了**），于是只拿到 `J_SESSION_ID`，
    //   `…agencyID` / `…tcftk` 全缺 → 业务请求依旧「200 + 空体」。
    //   实测见 _ca_probe_v14.mjs：方式 A（旧）=1/3 个 cookie，方式 B（本实现）=3/3。
    const land = await this._landBusinessSession(lr.code);
    if (!land.ok) {
      const missing = SESSION_COOKIES.filter((n) => !this.http.cookies()[n]);
      return {
        ok: false,
        error: `业务会话 cookie 缺失：${missing.join(', ')}`,
        detail: { trail: land.trail },
        cookies: this.http.cookies(),
      };
    }
    return { ok: true, cookies: this.http.cookies() };
  }

  /**
   * ⑨b 带着 `?ticket=ST-…` 逐跳落到业务站点，直到业务 cookie 齐备。
   *
   * 实测链路（抓包第 140~141 条 / 292~307 条）：
   *   authui/casLogin?…&code=…  → 302 login?service=…          （种 SSOJTC/SSOTGC/user_tag/domain_tag）
   *   authui/login?service=…    → 302 codearts…?ticket=ST-…     （种 devclouddevuibjJ_SESSION_ID）
   *   codearts…?ticket=ST-…     → 302 codearts…                 （种 …agencyID）
   *   codearts…                 → 200                           （种 …tcftk）
   * 中途可能插入「绑定 MFA」提示页（`loginBindMfa.html`），需 POST `validateUser` 才能继续。
   *
   * @returns {Promise<{ok:boolean, trail:string[], reached?:string}>}
   */
  async _landBusinessSession(codeUrl, { maxHops = 10 } = {}) {
    const trail = [];
    let cur = codeUrl;
    for (let hop = 0; hop < maxHops; hop += 1) {
      const r = await this.http.get(cur, { follow: false });
      trail.push(`${r.status} ${cur}`);
      if (SESSION_COOKIES.every((n) => this.http.cookies()[n])) {
        return { ok: true, trail, reached: cur };
      }
      const loc = r.headers.location;
      if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
        cur = new URL(loc, cur).href;
        continue;
      }
      const next = await this._dismissBindMfa(cur);   // 非重定向 = 可能是 HTML 中间页
      if (!next) break;
      cur = next;
    }
    return { ok: SESSION_COOKIES.every((n) => this.http.cookies()[n]), trail };
  }

  /**
   * 处理登录中途的「绑定 MFA」提示页（抓包第 293~305 条）。
   * 提示页本身不带令牌，`IAMCSRF` 要从 `getAntiPhishingInfo` 取；提交
   * `isConfirmed=false`（= 暂不绑定）即可放行，服务端回种 30 天的
   * `rememberPromptMFA_*`，此后 30 天不再出现该提示。
   *
   * @returns {Promise<string|null>} 继续跟随的地址；无法处理时返回 null
   */
  async _dismissBindMfa(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.hostname !== 'auth.huaweicloud.com') return null;
    if (!(u.pathname.includes('loginBindMfa') || u.pathname.includes('/authui/login'))) return null;

    const anti = await this.http.get(
      'https://auth.huaweicloud.com/authui/getAntiPhishingInfo?isSupport=true&isBindMfa=true',
    );
    let info = {};
    try { info = JSON.parse(anti.text); } catch { return null; }
    if (!info || !info.IAMCSRF) return null;

    const r = await this.http.post(
      `https://auth.huaweicloud.com/authui/validateUser?isFromID=1&service=${encodeURIComponent(SERVICE)}`,
      {
        step: 'afterBindMfa', IAMCSRF: info.IAMCSRF, isConfirmed: 'false',
        type: 'console_vmfa', rememberPromptMFA: 'true', isSupport: 'true', isFromID: '1',
      },
      { follow: false },
    );
    const loc = r.headers && r.headers.location;
    return (r.status === 302 && loc) ? new URL(loc, url).href : null;
  }

  /**
   * 完整登录。携带已保存的 hwidCasSid 时**跳过设备验证**（★主方案）。
   * @returns {Promise<{ok:boolean, needVerify?:boolean, authDevices?:Array, error?:string, detail?:any}>}
   */
  async login({ hwmeta = '' } = {}) {
    if (!this.account || !this.password) return { ok: false, error: '未配置账号或密码' };

    // ★★★ 重登前清空旧业务会话，只留信任令牌（2026-09-12 v21 定位）。
    // 脏 jar 会让 OAuth 落地把票换进旧（已失效）会话：login() 假成功（cookie「齐」
    // 但全是旧的），业务接口仍 HW-AJAX-REDIRECT —— 即「重登后仍失效」。
    // 实测干净 jar（只带 hwid_cas_sid）重登后 ops/delivery 立即 code:0。
    this.http.resetKeeping(['hwid_cas_sid']);

    const info = await this._bootstrap();
    if (Number(info.isSuccess) !== 1) return { ok: false, error: 'getSDKBaseInfo 失败', detail: info };
    if (!this.base.pageToken) return { ok: false, error: '未取到 pageToken', detail: info };

    await this._stepJsRemoteLogin();                 // 失败属正常
    await this._stepDev(AJAX_NEW, this.base);        // 上报指纹 → sid
    await this._stepHealth(AJAX_NEW, this.base);

    const ids = await this._stepLoginIds();
    let accountInfo = {};
    if (Number(ids.isSuccess) === 1 && Array.isArray(ids.accountInfoList) && ids.accountInfoList.length) {
      [accountInfo] = ids.accountInfoList;
    } else {
      const code = String(ids.errorCode || '');
      if (code === '10000400') return { ok: false, error: '账号或密码错误', detail: ids };
      if (code === '10000201') return { ok: false, error: '需要图片验证码（10000201），需人工/浏览器介入', detail: ids };
      // 其它错误（风控等）不阻断，继续尝试 ⑦
    }
    this._lastAccountInfo = accountInfo;             // 供设备验证二次提交复用

    const login = await this._stepUnionLogin(accountInfo, hwmeta);

    if (Number(login.isSuccess) !== 1) {
      const code = String(login.errorCode || '');
      // ★ 图片验证码风控门：协议层死路，fail-fast（规则：触发即判失败，禁止重试）
      if (isRiskCaptcha(login)) {
        return {
          ok: false,
          riskCaptcha: true,
          error: '触发图片验证码风控（10000706 need picture authcode risk），协议层无法继续，判定失败',
          detail: login,
        };
      }
      if (NEED_VERIFY_CODES.includes(code)) {
        // ★ 新设备分支：设备列表内嵌在 errorDesc 的 JSON 串里（此时验证码已下发）。
        //   注意手机号项 sent=0 —— 此时短信尚未下发，由 requestVerifyCode/submitVerifyCode
        //   的 _ensureSmsSent() 补发。
        this.authDevices = parseAuthCodeSentList(login.errorDesc);
        return { ok: true, needVerify: true, authDevices: this.authDevices, detail: login };
      }
      const err = login.errorDesc || login.errorCode || '未知错误';
      return { ok: false, error: `密码登录失败：${err}`, detail: login };
    }

    // ★ 设备刚被信任时服务端要求「信任本浏览器」（抓包第 108→111 条），
    //   必须先补这一步，OAuth 才能正常换票；旧实现只是把它当成 needVerify 上报，
    //   登录其实并没走完。
    if (login.needPopTrust) await this._stepTrustBrowser(accountInfo);

    const fin = await this._finishOauth(login.callbackURL || '');
    if (!fin.ok) return fin;
    return { ok: true, cookies: fin.cookies };
  }

  // ------------------------------------------------------------------
  // 设备验证接口（★保留 —— 将来接浏览器方案或协议变化时直接复用）
  // ------------------------------------------------------------------

  /**
   * ① 取得验证设备列表。
   *
   * ★★ 与旧实现的关键差异：**不再走 `/CAS/IDM_W/ajaxHandler/*`**。
   *    抓包（`examples/codearts首次登录与二次登录_解析结果` 第 96/108 条）证明设备验证
   *    完全发生在同一个端点上：
   *      第 1 次 `login/unionLoginByPwd`（`opType=0`）→ `10002080`，
   *      `errorDesc` 内嵌 `authCodeSentList`（**验证码此刻已下发，重复调用会重发**）；
   *      第 2 次同端点（`opType=1` + `twoStepVerifyCode`）→ `isSuccess=1`。
   *    旧实现跑去 CAS 命名空间调 `cloudAuthLogin`，两套命名空间不共享登录态，
   *    必然返回 `10000600 cloudLoginBean is null` —— 这正是方案文档 §1.9 记的「已知限制」，
   *    现在可判定为**路径选错**，而非上游不支持纯 HTTP。
   */
  async requestVerifyCode() {
    if (this.authDevices.length) {
      // ★ 缓存命中也要保证短信真的发出：手机号分支 sent=0 **不会自动发**
      //   （设备分支 sent=1 已自动发，_ensureSmsSent 对其天然空操作，幂等可重入）。
      if (!this.authDevices.some((d) => d.sent === 1)) {
        const sms = await this._ensureSmsSent();
        if (!sms.ok) {
          return { ok: false, error: sms.error, detail: sms.detail, authDevices: this.authDevices };
        }
      }
      return {
        ok: true,
        authDevices: this.authDevices,
        phoneOnly: this.authDevices.every((d) => Number(d.accountType) === VERIFY_TYPE_PHONE),
      };
    }
    if (!this.account || !this.password) return { ok: false, error: '未配置账号或密码' };

    const info = await this._bootstrap();
    if (Number(info.isSuccess) !== 1 || !this.base.pageToken) {
      return { ok: false, error: 'getSDKBaseInfo 失败', detail: info };
    }
    await this._stepJsRemoteLogin();                 // 失败属正常
    await this._stepDev(AJAX_NEW, this.base);
    await this._stepHealth(AJAX_NEW, this.base);

    const ids = await this._stepLoginIds();
    const accountInfo = (ids.accountInfoList || [])[0] || {};
    this._lastAccountInfo = accountInfo;

    const login = await this._stepUnionLogin(accountInfo);
    if (Number(login.isSuccess) === 1) {
      // 设备已受信（hwid_cas_sid 生效），无需验证码 —— 顺手把会话走完
      if (login.needPopTrust) await this._stepTrustBrowser(accountInfo);
      const fin = await this._finishOauth(login.callbackURL || '');
      return { ok: true, alreadyTrusted: true, authDevices: [], session: fin.ok };
    }
    // ★ 图片验证码风控门：fail-fast（规则：触发即判失败）
    if (isRiskCaptcha(login)) {
      return {
        ok: false,
        riskCaptcha: true,
        error: '触发图片验证码风控（10000706 need picture authcode risk），判定失败',
        detail: login,
      };
    }
    if (!NEED_VERIFY_CODES.includes(String(login.errorCode || ''))) {
      return { ok: false, error: `登录失败：${login.errorDesc || login.errorCode || '未知'}`, detail: login };
    }
    this.authDevices = parseAuthCodeSentList(login.errorDesc);
    if (!this.authDevices.length) return { ok: false, error: '上游未返回可用的验证设备', detail: login };
    // ★ 手机号分支（2026-09-12 抓包第 120→137 条）：账号无受信设备时
    //   authCodeSentList 只含 `{accountType:2, name:'191******75', sent:0}` ——
    //   短信**不会自动下发**，必须显式调 getSMSCodeV3；设备项（sent=1）保持原状。
    if (!this.authDevices.some((d) => d.sent === 1)) {
      const sms = await this._ensureSmsSent();
      if (!sms.ok) {
        return { ok: false, error: sms.error, detail: sms.detail, authDevices: this.authDevices };
      }
    }
    return {
      ok: true,
      authDevices: this.authDevices,
      phoneOnly: this.authDevices.every((d) => Number(d.accountType) === VERIFY_TYPE_PHONE),
    };
  }

  /**
   * ② 提交设备验证码 → 信任本机 → 落地业务会话。
   *
   * 抓包第 108 条：**同一端点** `login/unionLoginByPwd`，带
   * `opType=1` + `verifyUserAccount`（设备名，如 `Honor 10`）
   * + `verifyAccountType`（设备项为 `-1`）+ `twoStepVerifyCode`；
   * 成功后响应含 `callbackURL` 与 `needPopTrust:true`，第 111 条随即信任本浏览器。
   */
  async submitVerifyCode(code, deviceIndex = 0) {
    if (!this.base.pageToken) {
      return { ok: false, error: '验证会话已失效（缺少 pageToken），请重新点击「获取验证码」' };
    }
    // ★ 手机号分支兜底：短信若尚未真正下发（sent=0，如直接从 login() 的 needVerify
    //   状态进入而非 requestVerifyCode()），先补发；_ensureSmsSent 幂等可重入。
    if (!this.authDevices.some((d) => d.sent === 1)) {
      const sms = await this._ensureSmsSent();
      if (!sms.ok) return { ok: false, error: sms.error, detail: sms.detail };
    }
    // ★ 必须尊重调用方指定的 deviceIndex：多设备时用户选的是哪台就发给哪台。
    //   （曾写成 `find(d => d.sent === 1) || [deviceIndex]`，导致 index 被忽略、
    //     永远发给列表里第一台 sent=1 的设备。）
    const picked = this.authDevices[deviceIndex];
    const device = (picked && picked.sent === 1)
      ? picked
      : (this.authDevices.find((d) => d.sent === 1) || picked);
    if (!device) return { ok: false, error: '没有可用的验证设备，请先调用 requestVerifyCode()' };

    const res = await this._stepUnionLogin(this._lastAccountInfo || {}, '', {
      twoStepVerifyCode: String(code),
      verifyUserAccount: String(device.name || ''),
      verifyAccountType: device.accountType == null ? -1 : device.accountType,
    });
    if (Number(res.isSuccess) !== 1) {
      return {
        ok: false,
        error: `验证码校验失败：${res.errorDesc || res.errorCode || '未知'}`,
        errorCode: res.errorCode,
        detail: res,
      };
    }
    if (res.needPopTrust) await this._stepTrustBrowser(this._lastAccountInfo || {});
    this.http.clearOauthCookies();                   // 避免 OAuth 域遗留 cookie 串状态
    if (!res.callbackURL) return { ok: true, cookies: this.http.cookies() };
    const fin = await this._finishOauth(res.callbackURL);
    return fin.ok ? fin : { ...fin, landingFailed: true };   // 区分「验证码错」与「落地失败」
  }

  // ------------------------------------------------------------------
  // 业务接口
  // ------------------------------------------------------------------

  _bizHeaders() {
    const cks = this.http.cookies();
    const h = {
      'x-requested-with': 'XMLHttpRequest',
      language: LANG, 'x-language': LANG, referer: REFERER_USAGE,
      accept: 'application/json, text/plain, */*',
    };
    if (cks.devclouddevuibjtcftk) h.cftk = cks.devclouddevuibjtcftk;  // ★与 cookie 双写
    return h;
  }

  /** 统一业务请求：自动带 cftk / 复用 cookie / 标注 HW-AJAX-REDIRECT */
  async _biz(method, path, { json, query = true } = {}) {
    const url = `${HOST}${path}${query ? `?_=${Date.now()}` : ''}`;
    const headers = this._bizHeaders();
    let r;
    if (method === 'GET') r = await this.http.get(url, { headers });
    else r = await this.http.postRawJson(url, json ?? {}, { headers });
    let data = null;
    try { data = JSON.parse(r.text); } catch { data = null; }
    return {
      status: r.status, headers: r.headers, text: r.text, data,
      expired: HttpClient.isExpired(r.headers),
    };
  }

  // ---------------- 运营活动中心（★现行签到接口） ----------------

  /**
   * 活动投放列表：`GET /portal/promptcenter/v1/ops/delivery?channel=PORTAL`
   *
   * 响应信封 `{code:0, message:'ok', data:{channel, serverTime, items:[...]}}`，
   * items[] 里每一项：`{campaignId, title, type, benefitAmount, claimable, status,
   * pendingCount, pendingTotalAmount, extra:{startTime,endTime,triggerEvent,triggerMode}}`
   * 每日签到那项：`type='USER_LOGIN'`、`claimable` 即「今天还能不能领」。
   *
   * ⚠️ 该接口**参数校验极严**：只认 `channel`，多传任何参数（如 `?_=`、`?channel=&_=`）
   *    直接 400 `HDN.1000 ... unknown exception`。所以 `_` 要拼进 path 而不是另加 query。
   */
  async opsDelivery() {
    const path = `${ENDPOINTS.opsDelivery}?channel=${OPS_CHANNEL}&_=${Date.now()}`;
    const r = await this._biz('GET', path, { query: false });
    const env = r.data || null;
    const items = (env && env.data && env.data.items) || [];
    return {
      expired: r.expired, status: r.status,
      code: env ? env.code : null, message: env ? env.message : r.text.slice(0, 120),
      serverTime: env && env.data ? env.data.serverTime : null,
      items, raw: env,
    };
  }

  /** 投放列表里的「每日签到」活动项（找不到返回 null） */
  async dailyCampaign() {
    const d = await this.opsDelivery();
    const it = d.items.find((x) => OPS_DAILY_TYPES.includes(x.type)) || null;
    return { ...d, campaign: it };
  }

  /**
   * 领取活动奖励：`POST /portal/promptcenter/v1/ops/claim`  body `{campaignId, channel}`
   * 成功响应：`{code:0, data:{id, status:'CLAIMED', totalAmount, remainingAmount,
   *   claimedAt, expireAt, pointBucket:'GENERAL', bucketLabel:'通用积分'}}`
   * ★ 幂等：同一 campaign 当天重复领取会被上游拒绝（`code!=0` 或 status 仍是已领）。
   */
  async opsClaim(campaignId) {
    const r = await this._biz('POST', ENDPOINTS.opsClaim,
      { query: false, json: { campaignId, channel: OPS_CHANNEL } });
    const env = r.data || null;
    const d = (env && env.data) || null;
    const ok = !!(env && env.code === 0 && d
      && (d.status === 'CLAIMED' || d.status === 'CONFIRMED'));
    return { expired: r.expired, ok, status: r.status, data: d, env };
  }

  /** 活动积分总览：`GET /ops/credit/overview`（★同样只认无参） */
  async opsCreditOverview() {
    const r = await this._biz('GET', `${ENDPOINTS.opsCreditOverview}?_=${Date.now()}`, { query: false });
    const env = r.data || null;
    return { expired: r.expired, status: r.status, code: env ? env.code : null, data: env ? env.data : null };
  }

  /**
   * 单个活动的领取流水：`GET /ops/credit/campaign/{id}`
   * → `{campaignId, campaignTitle, expirePolicy:{strategy,duration,durationUnit},
   *     benefits:[{benefitId, status, claimedAmount, claimedAt, expireAt}]}`
   * `benefits[].claimedAt` 就是**平台侧权威的逐次领取时间**，可当签到历史用。
   */
  async opsCampaignCredit(campaignId) {
    const r = await this._biz('GET',
      `${ENDPOINTS.opsCreditCampaign}/${campaignId}?_=${Date.now()}`, { query: false });
    const env = r.data || null;
    const d = (env && env.data) || null;
    return { expired: r.expired, status: r.status, code: env ? env.code : null, campaign: d, benefits: (d && d.benefits) || [] };
  }

  // ---------------- 签到判定（走上面的运营活动接口） ----------------

  /**
   * 今日是否已领取。
   * @returns {Promise<{expired:boolean, claimed:?boolean, status:number, campaign?:object, broken?:boolean}>}
   *   `broken=true` 表示活动接口本身异常（非登录态问题）——调用方应视为**临时故障**，
   *   绝不能像旧实现那样把「空响应」当成 `false` 去发写请求。
   */
  async hasClaimed() {
    const d = await this.dailyCampaign();
    if (d.expired) return { expired: true, claimed: null, status: d.status };
    if (d.code !== 0) return { expired: false, claimed: null, broken: true, status: d.status, message: d.message };
    if (!d.campaign) return { expired: false, claimed: null, missing: true, status: d.status };
    return {
      expired: false,
      claimed: d.campaign.claimable === false,
      status: d.status,
      campaign: d.campaign,
    };
  }

  /** 领取每日签到积分（内部先取 campaignId，再调 ops/claim） */
  async claim(campaignId) {
    let id = campaignId;
    if (id === undefined) {
      const d = await this.dailyCampaign();
      if (d.expired) return { expired: true, ok: null, status: d.status };
      if (!d.campaign) return { expired: false, ok: false, missing: true, status: d.status, message: d.message };
      id = d.campaign.campaignId;
    }
    const r = await this.opsClaim(id);
    return r.expired ? { expired: true, ok: null, status: r.status } : r;
  }

  async packageOverview() {
    const r = await this._biz('GET', ENDPOINTS.packageOverview);
    return { expired: r.expired, status: r.status, data: r.data };
  }

  async packageInfo() {
    const r = await this._biz('GET', ENDPOINTS.packageInfo);
    return { expired: r.expired, status: r.status, data: r.data };
  }

  async restMe() {
    const r = await this._biz('GET', ENDPOINTS.restMe);
    return { expired: r.expired, status: r.status, data: r.data };
  }

  /**
   * 会话探活：请求只读的运营活动投放接口，按 HW-AJAX-REDIRECT 判定。
   * ⚠️ `valid` 仍只看「有没有 HW-AJAX-REDIRECT」（保持会话巡检语义不变，
   *    避免接口故障被误判成「凭证失效」而误发邮件）；`apiOk` 单独暴露接口健康度。
   */
  async checkSession() {
    const d = await this.opsDelivery();
    return {
      valid: !d.expired, apiOk: d.code === 0, code: d.code,
      status: d.status, hwAjaxRedirect: d.expired ? 'HW-AJAX-REDIRECT' : undefined,
    };
  }

  /**
   * 确保有可用会话：先探活已保存 cookie，失效则用账号密码 + hwid_cas_sid 自动重登。
   * @returns {Promise<{ok:boolean, relogined?:boolean, needVerify?:boolean, authDevices?:Array, error?:string}>}
   */
  async ensureSession() {
    if (Object.keys(this.http.cookies()).length) {
      const probe = await this.checkSession();
      if (probe.valid) return { ok: true, relogined: false };
    }
    if (!this.account || !this.password) {
      return { ok: false, error: '会话已失效，且未配置账号密码，无法自动重登' };
    }
    const r = await this.login();
    if (!r.ok) return r;
    if (r.needVerify) {
      return { ok: false, needVerify: true, authDevices: r.authDevices, error: '新设备需要验证码' };
    }
    const probe = await this.checkSession();
    return probe.valid ? { ok: true, relogined: true } : { ok: false, error: '重登后会话仍无效' };
  }

  /**
   * 一次完整签到（★2026-09-12 起走运营活动接口）。
   *
   * 流程：探活 → `ops/delivery` 读每日签到活动 → `claimable=false` 则跳过写请求
   *       → 否则 `ops/claim` → 归一化结果。
   *
   * ★ 与旧实现的三点关键差异（都是踩过的坑）：
   *   1. **绝不用「响应体判真假」**：旧接口废弃后返回 HTTP 200 + 空体，
   *      `/true/i.test('')` 恒为 false ⇒ 被当成「未领取」→ 发写请求 → 又失败，
   *      且错误信息误导成「claim 返回 false」。现在只认信封里的 `code` 与 `status`。
   *   2. **接口异常必须抛 transient**：`code!=0` 属于上游故障，不能标成凭证失效
   *      （否则会发「凭证失效」邮件并停掉任务），调用方会按阈值重试。
   *   3. **当日所得不能再用余额差**：活动积分进入独立的「通用积分」桶
   *      （`pointBucket=GENERAL`），`snap-manager/package/overview` 的套餐积分**不会**变，
   *      所以 reward 直接取活动返回的 `totalAmount` / `benefitAmount`。
   */
  async checkin() {
    const ens = await this.ensureSession();
    if (!ens.ok) throw markInvalid(ens.error || '会话不可用', ens);

    const d = await this.dailyCampaign();
    if (d.expired) throw markInvalid('登录态失效（ops/delivery 返回 HW-AJAX-REDIRECT）');
    if (d.code !== 0) {
      const e = new Error(`签到活动接口异常（ops/delivery code=${d.code} message=${d.message}）`);
      e.kind = 'transient';
      throw e;
    }
    if (!d.campaign) {
      const e = new Error('未在活动投放列表中找到「每日签到」活动（type=USER_LOGIN）');
      e.kind = 'transient';
      throw e;
    }

    const alreadyCheckedIn = d.campaign.claimable === false;
    let claimOk = null;
    let reward = null;
    if (!alreadyCheckedIn) {
      const c = await this.opsClaim(d.campaign.campaignId);
      if (c.expired) throw markInvalid('登录态失效（ops/claim 返回 HW-AJAX-REDIRECT）');
      if (!c.ok) {
        const e = new Error(`领取失败（ops/claim 未返回 CLAIMED：${JSON.stringify(c.env)}）`);
        e.kind = 'transient';
        throw e;
      }
      claimOk = true;
      reward = Number(c.data.totalAmount) || Number(d.campaign.benefitAmount) || null;
    }

    // 展示用余额仍是「套餐积分」（面板口径不变）；活动积分单独带出，失败不影响签到结论
    let credits = null;
    let overview = null;
    try {
      const o = await this.packageOverview();
      overview = o ? o.data : null;
      credits = overview ? ((overview.all_credit_package || {}).package_credit_remain ?? null) : null;
    } catch { /* 余额查询失败不影响签到结论 */ }

    let opsCredits = null;
    try {
      const ov = await this.opsCreditOverview();
      const t = ov && ov.data ? ov.data.total : null;
      if (t) {
        opsCredits = {
          claimCount: t.claimCount,
          claimed: t.totalClaimed,
          consumed: t.totalConsumed,
          expired: t.totalExpired,
          remaining: Number(((Number(t.totalClaimed) || 0) - (Number(t.totalConsumed) || 0)
            - (Number(t.totalExpired) || 0)).toFixed(2)),
        };
      }
    } catch { /* 活动积分总览失败不影响签到结论 */ }

    return {
      ok: true,
      alreadyCheckedIn,
      claimOk,
      credits,
      reward: alreadyCheckedIn ? null : (reward !== null ? reward : 0),
      opsCredits,
      campaign: {
        campaignId: d.campaign.campaignId,
        title: d.campaign.title,
        status: d.campaign.status,
        benefitAmount: d.campaign.benefitAmount,
      },
      overview,
    };
  }

  /** 查询积分（package/overview 主展示值） */
  async getCredits() {
    const ens = await this.ensureSession();
    if (!ens.ok) throw markInvalid(ens.error, ens);
    const o = await this.packageOverview();
    if (o.expired || !o.data) throw markInvalid('登录态失效');
    const all = o.data.all_credit_package || {};
    return {
      remain: all.package_credit_remain ?? null,
      amount: all.package_credit_amount ?? null,
      used: all.package_credit_used ?? null,
      userRemain: all.package_credit_user_remain ?? null,
      expiring: all.expiring_credit_amount ?? null,
      breakdown: {
        basic: (o.data.basic_package || {}).package_credit_remain ?? null,
        bonus: (o.data.bonus_credit_package || {}).package_credit_remain ?? null,
      },
      raw: o.data,
    };
  }

  /** 今日签到状态（不领取） */
  async getStatus() {
    const ens = await this.ensureSession();
    if (!ens.ok) throw markInvalid(ens.error, ens);
    const hc = await this.hasClaimed();
    if (hc.expired) throw markInvalid('登录态失效');
    if (hc.broken) {
      const e = new Error(`签到活动接口异常（${hc.message}）`);
      e.kind = 'transient';
      throw e;
    }
    if (hc.missing) {
      const e = new Error('未找到「每日签到」活动');
      e.kind = 'transient';
      throw e;
    }
    let credits = null;
    try {
      const c = await this.getCredits();
      credits = c.remain;
    } catch { /* 积分查询失败不影响签到状态 */ }
    const cp = hc.campaign;
    return {
      checkedInToday: hc.claimed === true,
      credits,
      // 只回必要字段（campaign 原始项带 displayConfig 大字符串，别整包透出）
      campaign: cp ? {
        campaignId: cp.campaignId, title: cp.title, type: cp.type,
        claimable: cp.claimable, status: cp.status, benefitAmount: cp.benefitAmount,
      } : null,
    };
  }

  // ------------------------------------------------------------------
  // 用量分析（★真实远端端点，个人用量页同源）
  // ------------------------------------------------------------------

  /**
   * 用量分析图表。
   *
   * 端点：POST /portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/charts
   * 入参：{ startDate, endDate, metrics:[...], xDimension }
   *   - startDate/endDate 为「YYYY-MM-DD」
   *   - metrics 支持 TOTAL_CREDITS / TOKEN_TOTAL / REQUEST_COUNT / ACTIVE_DAYS
   *   - xDimension：DATE_DAY（逐日）/ MODEL（按模型）
   *   ★xDimension=MODEL 时 cells[].xLabel 是模型名（如 GLM-5.2）；
   *     DATE_DAY 时 xLabel 是日期。yDimension=MODEL 虽返回 200，但 yLabel 恒为 null
   *     （拿不到「日期×模型」矩阵），需要两维数据只能分别调两次再自行合并。
   *
   * @returns {Promise<Object<string, Array<{xLabel:string, yLabel:?string, value:number}>>>}
   *          metric 名 → cells 数组
   */
  async usageChart({ startDate, endDate, metrics = ['TOTAL_CREDITS'], xDimension = 'DATE_DAY' } = {}) {
    const ens = await this.ensureSession();
    if (!ens.ok) throw markInvalid(ens.error || '会话不可用', ens);

    const r = await this._biz('POST', ENDPOINTS.usageCharts, {
      query: true,
      json: { startDate, endDate, metrics, xDimension },
    });
    if (r.expired) throw markInvalid('登录态失效（用量分析返回 HW-AJAX-REDIRECT）');
    if (r.status === 401 || r.status === 403) throw markInvalid(`用量分析未授权（HTTP ${r.status}）`);
    // ★该接口响应是双层信封：{ code:200, data:{ code:200, data:{ series:[...] } } }
    //   _biz 已把整个 body 解析为 r.data，故这里要再下钻一层。
    const env = r.data && r.data.data !== undefined ? r.data.data : r.data;
    if (env && env.code !== undefined && env.code !== 200 && env.code !== 0) {
      const e = new Error(`用量分析失败（code ${env.code}）`);
      e.kind = 'transient';
      throw e;
    }
    if (!env || !Array.isArray(env.series)) {
      const e = new Error(`用量分析响应异常（HTTP ${r.status}）`);
      e.kind = 'transient';
      throw e;
    }
    const out = {};
    for (const s of env.series) {
      if (s && s.name) out[s.name] = Array.isArray(s.cells) ? s.cells : [];
    }
    return out;
  }

  /** 用量汇总指标（区间累计） */
  async usageStats({ startDate, endDate, metrics = ['TOTAL_CREDITS', 'TOKEN_TOTAL', 'REQUEST_COUNT'] } = {}) {
    const ens = await this.ensureSession();
    if (!ens.ok) throw markInvalid(ens.error || '会话不可用', ens);
    const r = await this._biz('POST', ENDPOINTS.usageStats, {
      query: true,
      json: { startDate, endDate, metrics },
    });
    if (r.expired) throw markInvalid('登录态失效（用量汇总返回 HW-AJAX-REDIRECT）');
    const env = r.data && r.data.data !== undefined ? r.data.data : r.data;
    const list = Array.isArray(env) ? env : [];
    const out = {};
    for (const x of list) if (x && x.id) out[x.id] = Number(x.value) || 0;
    return out;
  }

  /**
   * 用量筛选选项 —— ★「近 N 天」的日期范围入口。
   * 端点：GET /portal/dataflywheel/datapreprocess/v1/analytics/filters/options
   * 入参：startDate/endDate（YYYY-MM-DD）+ isPersonal=true
   * 返回：{teams, models, serviceFunctions, dataLastUpdateTime}
   *   —— 说明该平台的区间完全是**参数**（页面上「近7天 / 近30天 / 自定义」只是换这两个日期），
   *      并不存在单独的「近30天端点」。
   */
  async usageFilters({ startDate, endDate } = {}) {
    const ens = await this.ensureSession();
    if (!ens.ok) throw markInvalid(ens.error || '会话不可用', ens);
    const q = `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&isPersonal=true`;
    const r = await this._biz('GET', ENDPOINTS.usageFilters + q, { query: false });
    if (r.expired) throw markInvalid('登录态失效（用量筛选项返回 HW-AJAX-REDIRECT）');
    const env = r.data && r.data.data !== undefined ? r.data.data : r.data;
    return env || null;
  }

  /**
   * 权益包明细分页 —— ★比 package/overview 的 4 个聚合桶更细（逐包一条）。
   * 端点：POST /portal/snap-manager/v1/package/credit/page
   * 入参：{pageNum, pageSize, sortField, sortOrder}
   * 响应（★单层、无 code 包裹）：{list:[{packageType,resourceSpec,creditAmount,creditUsed,expiredTime,...}],total,pageNum,pageSize}
   */
  async creditPage({ pageNum = 1, pageSize = 20, sortField = 'created_time', sortOrder = 'desc' } = {}) {
    const ens = await this.ensureSession();
    if (!ens.ok) throw markInvalid(ens.error || '会话不可用', ens);
    const r = await this._biz('POST', ENDPOINTS.creditPage, {
      query: false,
      json: { pageNum, pageSize, sortField, sortOrder },
    });
    if (r.expired) throw markInvalid('登录态失效（权益包明细返回 HW-AJAX-REDIRECT）');
    if (r.status === 401 || r.status === 403) throw markInvalid(`权益包明细未授权（HTTP ${r.status}）`);
    const d = r.data;
    if (!d || !Array.isArray(d.list)) {
      const e = new Error(`权益包明细响应异常（HTTP ${r.status}）`);
      e.kind = 'transient';
      throw e;
    }
    return { list: d.list, total: Number(d.total) || d.list.length, pageNum: Number(d.pageNum) || pageNum, pageSize: Number(d.pageSize) || pageSize };
  }
}

/** 生成 kind=invalid 的错误（供上游 tasks 判定为凭证失效） */
export function markInvalid(message, extra = {}) {
  const e = new Error(message);
  e.kind = 'invalid';
  Object.assign(e, extra);
  return e;
}
