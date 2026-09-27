/**
 * Provider 共享的表单 schema 常量。
 *
 * ★ 背景（2026-09-12 补建）：`codearts.js` 从一开始就 `from './common.js'` 引用本模块，
 *   但文件一直没建 → server.js `import codeartsProvider` 直接崩（ERR_MODULE_NOT_FOUND），
 *   monitor 起不来。Trae/WorkBuddy 各持一份本地副本（值完全相同），暂不强制统一，
 *   只保证本模块与 trae.js 的副本逐值一致；改动时两处同步。
 */

// 常见时区（下拉候选，可自定义）
export const TIMEZONES = [
  ['Asia/Shanghai', '中国 上海 (Asia/Shanghai)'],
  ['Asia/Hong_Kong', '中国 香港 (Asia/Hong_Kong)'],
  ['Asia/Taipei', '中国 台湾 (Asia/Taipei)'],
  ['Asia/Tokyo', '日本 东京 (Asia/Tokyo)'],
  ['Asia/Seoul', '韩国 首尔 (Asia/Seoul)'],
  ['Asia/Singapore', '新加坡 (Asia/Singapore)'],
  ['Asia/Kolkata', '印度 (Asia/Kolkata)'],
  ['Asia/Dubai', '阿联酋 迪拜 (Asia/Dubai)'],
  ['Europe/London', '英国 伦敦 (Europe/London)'],
  ['Europe/Paris', '法国 巴黎 (Europe/Paris)'],
  ['Europe/Berlin', '德国 柏林 (Europe/Berlin)'],
  ['America/New_York', '美国 纽约 (America/New_York)'],
  ['America/Chicago', '美国 芝加哥 (America/Chicago)'],
  ['America/Los_Angeles', '美国 洛杉矶 (America/Los_Angeles)'],
  ['America/Toronto', '加拿大 多伦多 (America/Toronto)'],
  ['Australia/Sydney', '澳大利亚 悉尼 (Australia/Sydney)'],
  ['Pacific/Auckland', '新西兰 奥克兰 (Pacific/Auckland)'],
  ['UTC', 'UTC 协调世界时'],
];

// 签到时间（下拉候选，每小时一个）
export const TIMES = Array.from({ length: 24 }, (_, h) => {
  const hh = String(h).padStart(2, '0');
  return [hh + ':00', hh + ':00'];
});

// 连续失败告警阈值（下拉候选）
export const THRESHOLDS = [1, 2, 3, 5, 10].map((v) => [String(v), String(v) + ' 次']);

// Cookie/会话到期提前通知天数（下拉候选）
export const EXPIRY_DAYS = [1, 2, 3, 5, 7, 14].map((v) => [String(v), String(v) + ' 天前']);

// 积分到期提醒默认配置（credit-expiry.js readSettings 兜底用；
// ★自 2026-09-27 起「按账号积分到期提醒」已由「每日日报」取代，本常量仅供旧数据兼容/内部计算兜底，
//   不再暴露到任何账号表单。）
export const CREDIT_EXPIRY_DEFAULTS = {
  creditExpiryNotifyTime: '09:00',   // 默认每天 09:00 检查
  creditExpiryNotifyDays: 3,         // 默认提前 3 天通知
  creditExpiryMaxReminders: 3,       // 默认每个批次最多提醒 3 次
};
