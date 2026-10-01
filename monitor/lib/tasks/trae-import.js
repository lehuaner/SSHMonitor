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
 * 依据导入串新增或更新一个 Trae 账号。
 * @param {{importString:string, name?:string, time?:string, timezone?:string}} input
 * @returns {{created:boolean, task:object}}
 * @throws {Error} 导入串无效 / 来源客户端不受支持
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
  const existing = tasks.find((t) => {
    if (t.providerId !== 'trae' || !t.config) return false;
    // ① 首选：userId 相同（稳定）
    if (cred.userId && t.config.refreshMeta
        && String(t.config.refreshMeta.userId) === String(cred.userId)) return true;
    // ② 兜底：导入串一字不差（同一份串重复提交，或旧任务还没跑过 resolveToken）
    return t.config.refreshToken === importString;
  }) || null;

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

  // ── 已有账号：只更新凭证，其余一律不碰 ──
  // name / time / timezone / enabled / 其它配置项全部保持原样。
  // （脚本每次都会问名称，但那是给「新增」用的；对已存在的账号改名字属于越界修改。）
  if (existing) {
    const task = updateTask(existing.id, { config: credentialPatch });
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
    config: {
      ...defaults,
      ...credentialPatch,
      time: input.time || defaults.time || '09:00',
      timezone: input.timezone || defaults.timezone || 'Asia/Shanghai',
    },
  });
  return { created: true, task, nameKept: false };
}
