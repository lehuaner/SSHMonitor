/**
 * WorkBuddy 桌面端凭证（导入串）的解析/构造 —— provider 与 HTTP 路由共用。
 *
 * 导入串格式（tools/wb-export.ps1 产出）：
 *   WB1.<base64url(JSON)>
 *   JSON = { v:1, rt, tk, uid, uin, nick, phone, at, texp, rexp }
 *     rt    refreshToken（Keycloak Offline JWT，698 字符；滚动轮换，每次续期必回写）
 *     tk    脚本实测续期时刚换到的 accessToken（可选；带上则服务端首次使用无需立刻续期）
 *     uid   account.uid（= JWT sub；用于识别"是哪个账号"，服务端不校验）
 *     uin   account.uin（Tencent 数字 ID，仅展示）
 *     nick  昵称（如「乐幻」，仅展示/默认命名）
 *     phone 手机号（如 173****7416，仅展示/默认命名）
 *     at    导出时间
 *     texp  access token 到期（epoch 毫秒）
 *     rexp  refreshToken 自身到期（epoch 毫秒，约 +30 天，每次续期滚动）
 *
 * ★ 为什么要 uid：实现「新增账号 or 更新已有账号」的自动判定。
 *   服务端拿它去比对已有 workbuddy 任务的 config.userId（或从其 refreshToken 解出的 sub）——
 *   这比比对 refreshToken 可靠得多：refreshToken 是滚动轮换的，同一账号每次续期后值都不同。
 */

export const IMPORT_PREFIX = 'WB1.';

/**
 * 解析导入串；也接受直接粘贴的裸 refreshToken。
 *
 * ★以 `WB1.` 开头 ⇒ 一定被当作导入串：解码失败返回 **null**（而不是回落成裸 token）。
 *   否则一串被截断/改坏的导入串会被静默当成"长度很奇怪的 refreshToken"，
 *   一路带到续期时才报 401，排查成本高得多。
 *
 * @param {string} raw
 * @returns {{refreshToken:string, token:string, userId:string, uin:string, nickname:string,
 *            phone:string, at:string, tokenExpireAt:number, refreshTokenExpireAt:number,
 *            isImportString:boolean}|null}
 */
export function parseCredential(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (s.startsWith(IMPORT_PREFIX)) {
    try {
      const b64 = s.slice(IMPORT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
      const o = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      if (!o || !o.rt) return null;
      return {
        refreshToken: String(o.rt),
        token: o.tk ? String(o.tk) : '',
        userId: o.uid ? String(o.uid) : '',
        uin: o.uin ? String(o.uin) : '',
        nickname: o.nick ? String(o.nick) : '',
        phone: o.phone ? String(o.phone) : '',
        at: o.at ? String(o.at) : '',
        tokenExpireAt: Number(o.texp) || 0,
        refreshTokenExpireAt: Number(o.rexp) || 0,
        isImportString: true,
      };
    } catch {
      return null;
    }
  }

  return {
    refreshToken: s, token: '', userId: '', uin: '', nickname: '', phone: '',
    at: '', tokenExpireAt: 0, refreshTokenExpireAt: 0, isImportString: false,
  };
}

/** 该字符串是否"看起来是导入串"（用于把格式错误与裸 token 区分开报错） */
export function looksLikeImportString(raw) {
  return String(raw || '').trim().startsWith(IMPORT_PREFIX);
}

/**
 * 构造导入串（与 tools/wb-export.ps1 的输出格式逐字段一致，便于互测）。
 * @param {{refreshToken:string, token?:string, userId?:string, uin?:string, nickname?:string,
 *          phone?:string, at?:string, tokenExpireAt?:number, refreshTokenExpireAt?:number}} o
 */
export function buildImportString(o) {
  const blob = {
    v: 1,
    rt: o.refreshToken,
    uid: o.userId || '',
    uin: o.uin || '',
    nick: o.nickname || '',
    phone: o.phone || '',
    at: o.at || new Date().toISOString().slice(0, 19),
  };
  if (o.token) blob.tk = o.token;
  if (o.tokenExpireAt) blob.texp = Number(o.tokenExpireAt);
  if (o.refreshTokenExpireAt) blob.rexp = Number(o.refreshTokenExpireAt);
  const b64 = Buffer.from(JSON.stringify(blob), 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return IMPORT_PREFIX + b64;
}

/** 脱敏显示用的账号标签（不泄露凭证） */
export function credentialLabel(cred, fallback = 'WorkBuddy 账号') {
  if (!cred) return fallback;
  if (cred.nickname) return `WorkBuddy · ${cred.nickname}`;
  if (cred.phone) return `WorkBuddy · ${cred.phone}`;
  if (cred.userId) return `WorkBuddy · ${String(cred.userId).slice(-4)}`;
  return fallback;
}
