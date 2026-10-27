/**
 * Qoder CN 凭证导入 —— 「已存在则更新、不存在则新增」的 upsert。
 *
 * 调用方：mod-checkin.js 的 `POST /api/checkin/qoder-import`
 *         （由 tools/qoder-export.ps1 在 Windows 上导出后调用，或面板里手动粘贴）。
 *
 * 账号身份用 **userId** 判定，不用 token —— token 每次续期都会轮换，userId 才稳定。
 *
 * 与 Trae 的差异：Qoder 的「凭证」不止 token，还有一组**设备风控身份**（UMID 三件套）。
 * 上游对设备身份是软校验（2026-10-27 实测最小四件套也能签），但导出时一并带上，
 * 既能贴合官方客户端流量，也方便用户换机后一键覆盖。
 */
import { loadTasks, addTask, updateTask } from './index.js';
import { getProvider } from '../providers/index.js';
import { parseCredential } from '../checkin/qoder-credential.js';

/** 从 provider 的 configSchema 收集所有带 default 的字段（表单默认值即服务端默认值） */
function schemaDefaults(providerId) {
  const p = getProvider(providerId);
  const out = {};
  for (const f of (p && p.configSchema) || []) {
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

/** 列出可作为导入目标的 Qoder 账号（脚本/面板据此让用户选「更新哪个 / 新建」） */
export function listQoderTargets() {
  return loadTasks()
    .filter((t) => t.providerId === 'qoder')
    .map((t) => ({
      id: t.id,
      name: t.name,
      enabled: t.enabled !== false,
      userId: (t.config && t.config.userId) || '',
      userName: (t.config && t.config.userName) || '',
      hasRefreshToken: !!(t.config && t.config.refreshToken),
      hasDeviceIdentity: !!(t.config && t.config.machineToken && t.config.machineCode && t.config.machineType),
      lastResult: t.lastResult || null,
    }));
}

/**
 * 依据导入串新增或更新一个 Qoder CN 账号。
 * @param {{importString:string, taskId?:string, name?:string, time?:string, timezone?:string}} input
 * @returns {{created:boolean, task:object, nameKept:boolean}}
 */
export function upsertQoderTask(input = {}) {
  const importString = String(input.importString || '').trim();
  if (!importString) throw new Error('缺少 importString');

  const cred = parseCredential(importString);
  if (!cred) throw new Error('导入串无法解析（既不是 QODER1.… 也不是 dt-/drt- 开头的 token）');
  if (!cred.token && !cred.refreshToken) throw new Error('导入串里没有可用的 token');

  const tasks = loadTasks();
  let existing = null;

  if (input.taskId) {
    existing = tasks.find((t) => t.id === input.taskId) || null;
    if (!existing) throw new Error('指定的账号不存在（可能已被删除），请重新选择');
    if (existing.providerId !== 'qoder') throw new Error('指定的账号不是 Qoder CN 账号');
  } else {
    existing = tasks.find((t) => {
      if (t.providerId !== 'qoder' || !t.config) return false;
      if (cred.userId && String(t.config.userId || '') === String(cred.userId)) return true;
      if (cred.token && t.config.token === cred.token) return true;
      if (cred.refreshToken && t.config.refreshToken === cred.refreshToken) return true;
      return false;
    }) || null;
  }

  // ★凭证 = token + refreshToken + 设备身份（这三类一起换，缺一个都可能被风控判成"换了设备"）
  const credentialPatch = {
    token: cred.token,
    refreshToken: cred.refreshToken,
    userId: cred.userId || '',
    userName: cred.userName || '',
    importedAt: Date.now(),
  };
  if (cred.machineId) credentialPatch.machineId = cred.machineId;
  if (cred.machineToken) credentialPatch.machineToken = cred.machineToken;
  if (cred.machineCode) credentialPatch.machineCode = cred.machineCode;
  if (cred.machineType) credentialPatch.machineType = cred.machineType;
  if (cred.machineOs) credentialPatch.machineOs = cred.machineOs;
  if (cred.clientVersion) credentialPatch.clientVersion = cred.clientVersion;

  const tokenExpiredAt = cred.tokenExpireAt || null;
  const refreshTokenExpiredAt = cred.refreshTokenExpireAt || null;

  // ── 已有账号：只更新凭证，名称/时间/时区/开关一律不碰 ──
  //   （换凭证即解除 credentialInvalid：updateTask 内部按 provider.sessionCredentialKeys 判定）
  if (existing) {
    const task = updateTask(existing.id, {
      config: credentialPatch,
      tokenExpiredAt,
      refreshTokenExpiredAt,
    });
    return { created: false, task, nameKept: true };
  }

  // ── 新账号：用 schema 默认值补齐必需字段 ──
  const defaults = schemaDefaults('qoder');
  const fallbackName = cred.userName
    ? `Qoder CN · ${cred.userName}`
    : (cred.userId ? `Qoder CN · ${String(cred.userId).slice(-4)}` : 'Qoder CN 账号');

  const task = addTask({
    providerId: 'qoder',
    name: input.name || fallbackName,
    enabled: true,
    tokenExpiredAt,
    refreshTokenExpiredAt,
    config: {
      ...defaults,
      ...credentialPatch,
      time: input.time || defaults.time || '10:05',
      timezone: input.timezone || defaults.timezone || 'Asia/Shanghai',
    },
  });
  return { created: true, task, nameKept: false };
}
