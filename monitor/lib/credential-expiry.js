/**
 * 「维护链终点」计算 —— 面板卡片、到期提醒邮件、每日日报共用的唯一口径。
 *
 * 口径（2026-10-02 定稿）：显示/提醒的那一天 = 自动续期链彻底断掉、从那天起再也签不了的时间。
 *   · 有确定到期日的人工腿直接取（Trae refreshToken / AutoClaw refresh_token / web 模式 Cookie）；
 *   · 人工腿没有确定到期日时（WorkBuddy 的 Cookie 只能靠探活），取「最后一次自动续期成功后的
 *     派生凭证到期」（换票成功即 +60 天，会随每次续期滚动）；
 *   · 短命且每次签到必重签的派生腿（OfficeAce 的 2h AKSK）永不作为终点，否则常驻「已到期」。
 *
 * 阶梯由 provider 自己声明（lib/providers/<id>.js 的 credDisplay.ladder），本模块只负责求值：
 *   { label, fields:[字段路径…], if:'条件表达式', also:{label,fields}, title, probe:布尔 }
 *   probe=false 表示该档的到期值不来自探活（如 Trae 方案一看 refreshToken 自己写的值），
 *   巡检因此【跳过 probeSession 的网络探测】，但仍照常算维护日、发提醒。
 *   条件语法：hasCookie / hasToken / hasRefreshToken / noCookie / noRefreshToken /
 *             authMode=web（config 字段等值）/ 裸 config 键（有值即为真），可用 ' && ' 组合。
 *   字段路径：refreshTokenExpiredAt / tokenExpiredAt / cookieExpiresAt（任务顶层）
 *             config.refreshTokenExpiresAt / config.tokenExpiresAt
 *   ★入参必须是【未脱敏的原始 task】（config 里的凭证值本模块不读，但布尔判定需要原值）。
 */
import { getProvider } from './providers/index.js';

/** 单个条件求值 */
function oneCond(raw, t, cfg) {
  const c = String(raw).trim();
  if (c === 'hasCookie') return !!t.hasCookie || truthy(cfg.cookie);
  if (c === 'hasToken') return !!t.hasToken || truthy(cfg.token);
  if (c === 'hasRefreshToken') return !!t.hasRefreshToken || truthy(cfg.refreshToken);
  if (c === 'noCookie') return !(t.hasCookie || truthy(cfg.cookie));
  if (c === 'noRefreshToken') return !(t.hasRefreshToken || truthy(cfg.refreshToken));
  const eq = /^(\w+)=([\w-]+)$/.exec(c);
  if (eq) return String(cfg[eq[1]]) === eq[2];
  if (c in cfg) return truthy(cfg[c]);
  return true;
}

function truthy(v) {
  return v !== undefined && v !== null && v !== ''
    && !(Array.isArray(v) && !v.length)
    && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
}

/** 取任务上的字段路径值（数值型到期毫秒） */
function fieldOf(path, t) {
  switch (path) {
    case 'cookieExpiresAt': return t.cookieExpiresAt;
    case 'refreshTokenExpiredAt': return t.refreshTokenExpiredAt;
    case 'tokenExpiredAt': return t.tokenExpiredAt;
    case 'config.refreshTokenExpiresAt': return t.config && t.config.refreshTokenExpiresAt;
    case 'config.tokenExpiresAt': return t.config && t.config.tokenExpiresAt;
    default: return null;
  }
}

function pickExp(fields, t) {
  for (const f of fields || []) {
    const v = Number(fieldOf(f, t));
    if (v) return v;
  }
  return null;
}

/**
 * 该任务是否需要「探活探测」（probeSession）。
 * 命中档 probe===false → 不需要（它的到期值不来自探活），避免白烧一次网络会话探测。
 * @returns {{need:boolean, label:string|null, expMs:number|null, step:object|null}}
 */
export function evaluateCredentialExpiry(task) {
  const provider = task && task.providerId ? getProvider(task.providerId) : null;
  const ladder = (provider && provider.credDisplay && provider.credDisplay.ladder) || DEFAULT_LADDER;
  const cfg = (task && task.config) || {};
  for (const s of ladder) {
    const cond = s.if;
    const hit = !cond || String(cond).split('&&').every((c) => oneCond(c, task, cfg));
    if (!hit) continue;
    return {
      need: s.probe !== false,
      label: s.label,
      expMs: pickExp(s.fields, task),
      step: s,
      provider,
    };
  }
  return { need: true, label: null, expMs: null, step: null, provider };
}

/** 只要到期毫秒（日报/邮件最常用的形态） */
export function getMaintenanceExpiry(task) {
  return evaluateCredentialExpiry(task).expMs;
}

/** 只要「要不要跑 probeSession 探活」 */
export function needsSessionProbe(task) {
  return evaluateCredentialExpiry(task).need;
}

/**
 * 把阶梯渲染成一行文案 + 说明（邮件与日报共用，避免各处再各写一套 if）。
 * @returns {{text:string, title:string}}
 */
export function describeCredentialExpiry(task, now = Date.now()) {
  const { label, expMs, step } = evaluateCredentialExpiry(task);
  const name = (task && task.name) || '未命名';
  if (!expMs) {
    const unknown = label && (task.config || {}).refreshToken; // 有主凭证但值未知
    return {
      text: `· ${name}：${unknown ? `${label} 到期未知` : '无固定维护日'}`,
      title: unknown
        ? '首次服务端续期后才会知道长期凭证的到期时间，本期不发送到期提醒'
        : '自动续期链未断（会话态/可自动重登），只在探活失败时告警',
    };
  }
  const daysLeft = Math.ceil((expMs - now) / 86400000);
  const when = fmtDate(expMs);
  return {
    text: `· ${name}：${label} ${when}（${daysLeft <= 0 ? '已到期' : `剩 ${daysLeft} 天`}）`,
    title: (step && step.title) || '',
  };
}

function fmtDate(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 兜底：未声明 credDisplay 的 provider 走通用阶梯（不提及任何平台专属文案） */
const DEFAULT_LADDER = [
  { label: '凭证', fields: ['refreshTokenExpiredAt', 'config.refreshTokenExpiresAt'], if: 'hasRefreshToken' },
  { label: 'Cookie', fields: ['cookieExpiresAt'], if: 'hasCookie' },
  { label: 'Token', fields: ['tokenExpiredAt', 'config.tokenExpiresAt'], if: 'hasToken' },
];
