/**
 * Trae「方案一」凭证（导入串）的解析/构造 —— provider 与 HTTP 路由共用。
 *
 * 导入串格式（tools/trae-export.ps1 产出）：
 *   TRAE1.<base64url(JSON)>
 *   JSON = { v:1, rt, did, mid, uid, host, brand, at }
 *     rt    refreshToken（61 字符，与 ClientID ono9krqynydwx5 绑定）
 *     did   aha 设备 ID（纯数字，签到 claim 的 x-device-id 必须用它）
 *     mid   telemetry.machineId
 *     uid   userId（服务端不校验，仅用于识别"是哪个账号"）
 *     host  接口域名（api.trae.cn）
 *     brand 来源客户端（Trae CN / TRAE SOLO CN …）
 *     at    导出时间
 *
 * ★ 为什么要 uid：实现「新增账号 or 更新已有账号」的自动判定。
 *   服务端拿它去比对已有 trae 任务的 refreshMeta.userId —— 这比比对 refreshToken 可靠得多：
 *   refreshToken 是滚动轮换的，同一个账号每次续期后值都不同。
 */

export const IMPORT_PREFIX = 'TRAE1.';

/**
 * 解析导入串；也接受直接粘贴的裸 refreshToken。
 *
 * ★以 `TRAE1.` 开头 ⇒ 一定被当作导入串：解码失败返回 **null**（而不是回落成裸 token）。
 *   否则一串被截断/改坏的导入串会被静默当成"长度很奇怪的 refreshToken"，
 *   一路带到续期时才报 20101，排查成本高得多。
 *
 * @param {string} raw
 * @returns {{refreshToken:string, deviceId:string, machineId:string, userId:string,
 *            host:string, brand:string, at:string, isImportString:boolean}|null}
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
        deviceId: o.did ? String(o.did) : '',
        machineId: o.mid ? String(o.mid) : '',
        userId: o.uid ? String(o.uid) : '',
        host: o.host ? String(o.host) : '',
        brand: o.brand ? String(o.brand) : '',
        at: o.at ? String(o.at) : '',
        isImportString: true,
      };
    } catch {
      return null;
    }
  }

  return {
    refreshToken: s, deviceId: '', machineId: '', userId: '',
    host: '', brand: '', at: '', isImportString: false,
  };
}

/** 该字符串是否"看起来是导入串"（用于把格式错误与裸 token 区分开报错） */
export function looksLikeImportString(raw) {
  return String(raw || '').trim().startsWith(IMPORT_PREFIX);
}

/**
 * 构造导入串（与 tools/trae-export.ps1 的输出格式逐字段一致，便于互测）。
 * @param {{refreshToken:string, deviceId?:string, machineId?:string, userId?:string,
 *          host?:string, brand?:string, at?:string}} o
 */
export function buildImportString(o) {
  const blob = {
    v: 1,
    rt: o.refreshToken,
    did: o.deviceId || '',
    mid: o.machineId || '',
    uid: o.userId || '',
    host: o.host || 'https://api.trae.cn',
    brand: o.brand || '',
    at: o.at || new Date().toISOString().slice(0, 19),
  };
  const b64 = Buffer.from(JSON.stringify(blob), 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return IMPORT_PREFIX + b64;
}

/** 脱敏显示用的账号标签（不泄露凭证） */
export function credentialLabel(cred, fallback = 'Trae 账号') {
  if (!cred) return fallback;
  if (cred.userId) return `${cred.brand || 'Trae'} · ${cred.userId}`;
  return fallback;
}
