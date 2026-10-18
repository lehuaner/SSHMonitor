/**
 * WorkBuddy 桌面端凭证导入 —— 「已存在则更新、不存在则新增」的 upsert。
 *
 * 调用方：mod-checkin.js 的 `POST /api/checkin/wb-import`
 *         （由 tools/wb-export.ps1 生成的 wb-export.bat 直接调用）。
 *
 * 账号身份用 **uid**（= JWT sub）判定，不用 refreshToken ——
 * 因为 refreshToken 是滚动轮换的，同一账号每次续期后值都不同；uid 才稳定。
 * uid 由导入串携带（脚本从桌面端 .info 解出来）；
 * 老任务的 uid 可能没落库（config.userId 为空），这里从其 config.refreshToken
 * 解 JWT sub 兜底 —— 两条路都能认出"是哪个账号"。
 *
 * 所有默认值都取自 provider 的 configSchema（`default` 字段），
 * 因此这里【不硬编码】任何时间 / 时区 / 接口地址 —— 改 schema 即自动跟随。
 */
import { loadTasks, addTask, updateTask } from './index.js';
import { getProvider } from '../providers/index.js';
import { parseCredential, IMPORT_PREFIX } from '../checkin/wb-credential.js';

/** 从 provider 的 configSchema 收集所有带 default 的字段（表单默认值即服务端默认值） */
function schemaDefaults(providerId) {
  const p = getProvider(providerId);
  const out = {};
  for (const f of (p && p.configSchema) || []) {
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

/** 从 JWT（refreshToken / accessToken）解出 payload.sub（uid）——老任务没存 userId 时兜底 */
function jwtSub(token) {
  try {
    const raw = String(token || '').trim();
    if (!raw || raw.startsWith(IMPORT_PREFIX)) return '';
    const seg = raw.replace(/^Bearer\s+/i, '').split('.')[1];
    if (!seg) return '';
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).sub || '');
  } catch { return ''; }
}

/** 任务的稳定身份 uid：config.userId 优先，其次从其 refreshToken 解 JWT sub */
export function taskUid(task) {
  const cfg = (task && task.config) || {};
  let uid = String(cfg.userId || '');
  if (!uid && cfg.refreshToken) uid = jwtSub(cfg.refreshToken);
  return uid;
}

/**
 * 列出可作为「凭证导入目标」的 WorkBuddy 账号（供脚本交互选择用）。
 * 返回里的 userId 是从存储凭证落库/解出的稳定 uid，用于自动识别"同一账号"。
 */
export function listWorkbuddyTargets() {
  return loadTasks()
    .filter((t) => t.providerId === 'workbuddy')
    .map((t) => {
      const cfg = t.config || {};
      const mode = cfg.refreshToken ? 'refresh' : (cfg.cookie ? 'cookie' : 'bearer');
      return {
        id: t.id,
        name: t.name,
        enabled: t.enabled !== false,
        mode,
        userId: taskUid(t),
        phone: (cfg.refreshMeta && cfg.refreshMeta.phone) || '',
      };
    });
}

/**
 * 依据导入串新增或更新一个 WorkBuddy 账号。
 * @param {{importString:string, taskId?:string, name?:string, time?:string, timezone?:string}} input
 *        taskId 显式指定"更新哪一个"；不传则自动匹配（uid 相同，或裸 refreshToken 一字不差），
 *        再匹配不到才新建。
 * @returns {{created:boolean, task:object, nameKept:boolean}}
 * @throws {Error} 导入串无效 / 指定的账号不存在
 */
export function upsertWorkbuddyTask(input = {}) {
  const importString = String(input.importString || '').trim();
  if (!importString) throw new Error('缺少 importString');

  const cred = parseCredential(importString);
  if (!cred || !cred.refreshToken) throw new Error('导入串无法解析或缺少 refreshToken（应形如 WB1.…）');

  const tasks = loadTasks();
  let existing = null;

  if (input.taskId) {
    // ① 用户显式指定 → 严格按它来，不做任何猜测
    existing = tasks.find((t) => t.id === input.taskId) || null;
    if (!existing) throw new Error('指定的账号不存在（可能已被删除），请重新选择');
    if (existing.providerId !== 'workbuddy') throw new Error('指定的账号不是 WorkBuddy 账号');
  } else {
    // ② 自动匹配：优先 uid（稳定），其次裸 refreshToken 一字不差
    existing = tasks.find((t) => {
      if (t.providerId !== 'workbuddy' || !t.config) return false;
      const uid = taskUid(t);
      if (cred.userId && uid && String(cred.userId) === String(uid)) return true;
      const raw = String(t.config.refreshToken || '').trim();
      return raw !== '' && raw === cred.refreshToken;
    }) || null;
  }

  // ── 凭证本体：refreshToken（★存裸值，provider 直接用）+ 稳定身份 uid ──
  // authMode 固定切到 auto：有 refreshToken 时它优先走静默续期链（桌面端同款协议），
  // 这正是导入凭证的目的 —— 不切的话用户此前选的 web/bearer 会让新凭证躺着不生效。
  const credentialPatch = {
    refreshToken: cred.refreshToken,
    authMode: 'auto',
    refreshMeta: {
      uid: cred.userId || '',
      uin: cred.uin || '',
      nickname: cred.nickname || '',
      phone: cred.phone || '',
      exportedAt: cred.at || '',
      importedAt: Date.now(),
      via: 'script',
    },
  };
  if (cred.userId) credentialPatch.userId = cred.userId;

  // 导入串若自带 access token（脚本实测续期时刚换到的），一并落库。
  // ★这样服务端首次使用就不必立刻再调刷新端点 —— 每次续期都会推进 refreshToken
  //   轮换链，少推一代就少一次与桌面端产生分歧的机会。
  let tokenExpiredAt = null;
  if (cred.token) {
    credentialPatch.token = cred.token;
    tokenExpiredAt = cred.tokenExpireAt || null;
  }
  // refreshToken 自身到期（约 30 天）—— 账号卡片按它显示"凭证"还剩多久
  const refreshTokenExpiredAt = cred.refreshTokenExpireAt || null;

  // ── 已有账号：只更新凭证相关字段，其余一律不碰 ──
  // name / time / timezone / enabled / Cookie / UA 等全部保持原样。
  // （脚本每次都会问名称，但那是给「新增」用的；对已存在的账号改名字属于越界修改。）
  if (existing) {
    const task = updateTask(existing.id, {
      config: credentialPatch,
      ...(tokenExpiredAt ? { tokenExpiredAt } : {}),
      ...(refreshTokenExpiredAt ? { refreshTokenExpiredAt } : {}),
    });
    return { created: false, task, nameKept: true };
  }

  // ── 新账号：用 schema 默认值补齐必需字段 ──
  // 时间/时区等必须有值，否则调度器 parseTime(undefined) 会抛。全部取自 schema 默认值，不写死。
  const defaults = schemaDefaults('workbuddy');
  const fallbackName = cred.nickname
    ? `WorkBuddy 成长签到 · ${cred.nickname}`
    : (cred.phone ? `WorkBuddy 成长签到 · ${cred.phone}` : 'WorkBuddy 账号');

  const task = addTask({
    providerId: 'workbuddy',
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
