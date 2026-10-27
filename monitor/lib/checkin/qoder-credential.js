/**
 * Qoder CN 凭证（导入串）的解析/构造 —— provider、HTTP 路由、导出脚本三方共用。
 *
 * 导入串格式（tools/qoder-export.ps1 产出）：
 *   QODER1.<base64url(JSON)>
 *   JSON = { v:1, tk, rt, uid, name, mid, mtok, mcode, mtype, mos, host, cli, at, texp, rexp }
 *     tk    access token（dt-…，约 30 天）
 *     rt    refresh token（drt-…，约 360 天，每次续期轮换）
 *     uid   账号 userId（稳定，用于「新增 or 更新」判定）
 *     name  昵称（仅展示）
 *     mid   Cosy-MachineId（客户端 ~/.qoder-cn/.auth/machine_id）
 *     mtok/mcode/mtype  UMID 设备风控三件套（runtime-info.exe 产出）
 *     mos   Cosy-MachineOS（形如 x86_64_win32）
 *     host  接口域名（固定 https://openapi.qoder.com.cn）
 *     cli   Cosy-Version（客户端 UMID manifest 的 qoderCliVersion）
 *     at    导出时间；texp/rexp 为两个 token 的到期毫秒
 *
 * ★为什么带 uid：refresh token 每次续期都会换新值，用它做账号匹配必然重复建号；
 *   userId 才是稳定身份。
 * ★为什么带设备三件套：Qoder 的签到在严格风控下会看 UMID 身份。2026-10-27 实测
 *   最小四件套也能签，但带上设备头与官方客户端流量一致，遇到风控升级时更稳。
 */

export const IMPORT_PREFIX = 'QODER1.';
export const DEFAULT_HOST = 'https://openapi.qoder.com.cn';

/**
 * 解析导入串；也接受裸的 `dt-…` access token 或 `drt-…` refresh token。
 * 以 `QODER1.` 开头却解析失败 ⇒ 返回 null（不回落成裸 token，避免"怪 token"一路带到 401 才报错）。
 *
 * @param {string} raw
 * @returns {object|null}
 */
export function parseCredential(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  if (s.startsWith(IMPORT_PREFIX)) {
    try {
      const b64 = s.slice(IMPORT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
      const o = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      if (!o || (!o.tk && !o.rt)) return null;
      return {
        token: o.tk ? String(o.tk) : '',
        refreshToken: o.rt ? String(o.rt) : '',
        userId: o.uid ? String(o.uid) : '',
        userName: o.name ? String(o.name) : '',
        machineId: o.mid ? String(o.mid) : '',
        machineToken: o.mtok ? String(o.mtok) : '',
        machineCode: o.mcode ? String(o.mcode) : '',
        machineType: o.mtype ? String(o.mtype) : '',
        machineOs: o.mos ? String(o.mos) : '',
        host: o.host ? String(o.host) : DEFAULT_HOST,
        clientVersion: o.cli ? String(o.cli) : '',
        exportedAt: o.at ? String(o.at) : '',
        tokenExpireAt: Number(o.texp) || 0,
        refreshTokenExpireAt: Number(o.rexp) || 0,
        isImportString: true,
      };
    } catch {
      return null;
    }
  }

  // 裸 token：带 rt 前缀的当 refresh token，其余当 access token
  if (s.startsWith('drt-') || s.startsWith('jrt-')) {
    return {
      token: '', refreshToken: s, userId: '', userName: '', machineId: '',
      machineToken: '', machineCode: '', machineType: '', machineOs: '',
      host: DEFAULT_HOST, clientVersion: '', exportedAt: '',
      tokenExpireAt: 0, refreshTokenExpireAt: 0, isImportString: false,
    };
  }
  if (s.startsWith('dt-')) {
    return {
      token: s, refreshToken: '', userId: '', userName: '', machineId: '',
      machineToken: '', machineCode: '', machineType: '', machineOs: '',
      host: DEFAULT_HOST, clientVersion: '', exportedAt: '',
      tokenExpireAt: 0, refreshTokenExpireAt: 0, isImportString: false,
    };
  }
  return null;
}

/** 该字符串是否"看起来是导入串"（用于把格式错误与裸 token 区分开报错） */
export function looksLikeImportString(raw) {
  return String(raw || '').trim().startsWith(IMPORT_PREFIX);
}

/**
 * 构造导入串（与 tools/qoder-export.ps1 的输出逐字段一致，便于互测）。
 * @param {object} o
 */
export function buildImportString(o = {}) {
  const blob = {
    v: 1,
    tk: o.token || '',
    rt: o.refreshToken || '',
    uid: o.userId || '',
    name: o.userName || '',
    mid: o.machineId || '',
    mtok: o.machineToken || '',
    mcode: o.machineCode || '',
    mtype: o.machineType || '',
    mos: o.machineOs || '',
    host: o.host || DEFAULT_HOST,
    cli: o.clientVersion || '',
    at: o.exportedAt || new Date().toISOString().slice(0, 19),
  };
  if (o.tokenExpireAt) blob.texp = Number(o.tokenExpireAt);
  if (o.refreshTokenExpireAt) blob.rexp = Number(o.refreshTokenExpireAt);
  const b64 = Buffer.from(JSON.stringify(blob), 'utf8').toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return IMPORT_PREFIX + b64;
}

/** 脱敏账号标签 */
export function credentialLabel(cred, fallback = 'Qoder CN 账号') {
  if (!cred) return fallback;
  if (cred.userName && cred.userId) return `${cred.userName} · ${String(cred.userId).slice(-6)}`;
  if (cred.userId) return `Qoder CN · ${String(cred.userId).slice(-6)}`;
  return fallback;
}
