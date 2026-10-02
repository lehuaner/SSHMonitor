/**
 * Trae「方案一」凭证导入 —— 「已存在则更新、不存在则新增」的 upsert。
 *
 * 调用方：mod-checkin.js 的 `POST /api/checkin/trae-import`
 *         （由 tools/trae-export.ps1 生成的 trae-export.bat 直接调用）。
 *
 * 账号身份用 **userId** 判定，不用 refreshToken ——
 * 因为 refreshToken 是滚动轮换的，同一账号每次续期后值都不同；userId 才稳定。
 * userId 由导入串携带（脚本从客户端 storage.json 解出来）。
 *
 * 所有默认值都取自 provider 的 configSchema（`default` 字段），
 * 因此这里【不硬编码】任何时间 / 时区 / 接口地址 —— 改 schema 即自动跟随。
 */
import { loadTasks, addTask, updateTask } from './index.js';
import { getProvider } from '../providers/index.js';
import { parseCredential } from '../checkin/trae-credential.js';

/** 从 provider 的 configSchema 收集所有带 default 的字段（表单默认值即服务端默认值） */
function schemaDefaults(providerId) {
  const p = getProvider(providerId);
  const out = {};
  for (const f of (p && p.configSchema) || []) {
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

/**
 * 列出可作为「方案一凭证导入目标」的 Trae 账号（供脚本交互选择用）。
 *
 * ★为什么不只靠自动匹配：老账号是方案二（Cookie）建起来的，**没有 refreshMeta.userId**，
 *   而 userId 只能从新导入串里得到 —— 自动匹配必然落空，结果会凭空多出一个重复账号。
 *   所以让用户明确选「更新哪一个 / 新建」，比猜错安全。
 * 返回里的 deviceId 是机器标识（非凭证），用于帮用户认出是哪台设备上的账号。
 */
export function listTraeTargets() {
  return loadTasks()
    .filter((t) => t.providerId === 'trae')
    .map((t) => ({
      id: t.id,
      name: t.name,
      enabled: t.enabled !== false,
      mode: (t.config && t.config.refreshToken) ? 'refreshToken' : 'cookie',
      userId: (t.config && t.config.refreshMeta && t.config.refreshMeta.userId) || '',
      deviceId: (t.config && t.config.deviceId) || '',
    }));
}

/**
 * 依据导入串新增或更新一个 Trae 账号。
 * @param {{importString:string, taskId?:string, name?:string, time?:string, timezone?:string}} input
 *        taskId 显式指定"更新哪一个"；不传则自动匹配（userId 相同，或导入串一字不差），
 *        再匹配不到才新建。
 * @returns {{created:boolean, task:object, nameKept:boolean}}
 * @throws {Error} 导入串无效 / 来源客户端不受支持 / 指定的账号不存在
 */
export function upsertTraeTask(input = {}) {
  const importString = String(input.importString || '').trim();
  if (!importString) throw new Error('缺少 importString');

  const cred = parseCredential(importString);
  if (!cred || !cred.refreshToken) throw new Error('导入串无法解析或缺少 refreshToken');

  // 来源校验：只有 Trae CN 系凭证能用方案一。
  // TRAE SOLO CN 的续期会被上游强制要求 DeviceProof（20405/20403），必然失败，
  // 与其让用户等到签到报错，不如在导入这一刻就说清楚。
  if (cred.brand && /solo/i.test(cred.brand)) {
    throw new Error(
      `该凭证来自「${cred.brand}」，方案一不支持（上游要求设备签名）。` +
      '请在 Trae CN 客户端登录该账号后重新导出。',
    );
  }

  const tasks = loadTasks();
  let existing = null;

  if (input.taskId) {
    // ① 用户显式指定 → 严格按它来，不做任何猜测
    existing = tasks.find((t) => t.id === input.taskId) || null;
    if (!existing) throw new Error('指定的账号不存在（可能已被删除），请重新选择');
    if (existing.providerId !== 'trae') throw new Error('指定的账号不是 Trae 账号');
  } else {
    // ② 自动匹配：优先 userId（稳定），其次导入串一字不差
    existing = tasks.find((t) => {
      if (t.providerId !== 'trae' || !t.config) return false;
      if (cred.userId && t.config.refreshMeta
          && String(t.config.refreshMeta.userId) === String(cred.userId)) return true;
      return t.config.refreshToken === importString;
    }) || null;
  }

  // ★ 只有这两样算「凭证」：refreshToken 本身，以及它与之一体的设备绑定。
  //   x-device-id 必须与 refreshToken 绑定的设备一致，claim 才不会被判 9074，
  //   所以 deviceId 必须跟着凭证一起换 —— 它们是一对，不是"另外的配置"。
  const credentialPatch = {
    refreshToken: importString,
    refreshMeta: {
      userId: cred.userId || '',
      brand: cred.brand || '',
      host: cred.host || '',
      exportedAt: cred.at || '',
      importedAt: Date.now(),
      via: 'script',
    },
  };
  if (cred.deviceId) credentialPatch.deviceId = cred.deviceId;

  // 导入串若自带 access token（脚本实测续期时刚换到的），一并落库。
  // ★这样服务端首次使用就不必立刻再调 ExchangeToken —— 每次续期都会推进
  //   refreshToken 轮换链，而客户端手里那份只宽限一代，少推一代就少一次把它顶下线。
  let tokenExpiredAt = null;
  if (cred.token) {
    credentialPatch.token = cred.token;
    tokenExpiredAt = cred.tokenExpireAt || null;
  }
  // refreshToken 自身到期（约 180 天）—— 账号卡片按它显示"方案一凭证"还剩多久
  const refreshTokenExpiredAt = cred.refreshTokenExpireAt || null;

  // ── 已有账号：只更新凭证，其余一律不碰 ──
  // name / time / timezone / enabled / 其它配置项全部保持原样。
  // （脚本每次都会问名称，但那是给「新增」用的；对已存在的账号改名字属于越界修改。）
  if (existing) {
    const task = updateTask(existing.id, { config: credentialPatch, tokenExpiredAt, refreshTokenExpiredAt });
    return { created: false, task, nameKept: true };
  }

  // ── 新账号：用 schema 默认值补齐必需字段 ──
  // 时间/时区等必须有值，否则调度器 parseTime(undefined) 会抛。全部取自 schema 默认值，不写死。
  const defaults = schemaDefaults('trae');
  const fallbackName = cred.userId
    ? `Trae · ${String(cred.userId).slice(-4)}`
    : 'Trae 账号';

  const task = addTask({
    providerId: 'trae',
    name: input.name || fallbackName,
    enabled: true,
    tokenExpiredAt,
    refreshTokenExpiredAt,
    config: {
      ...defaults,
      ...credentialPatch,
      time: input.time || defaults.time || '09:00',
      timezone: input.timezone || defaults.timezone || 'Asia/Shanghai',
    },
  });
  return { created: true, task, nameKept: false };
}
