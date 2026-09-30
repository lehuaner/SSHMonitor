import { spawn } from 'node:child_process';
import { request as httpReq } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

// ====== Paths ======
export const BASH = '/data/data/com.termux/files/usr/bin/bash';
// MONITOR_HOME：本地开发/冒烟时覆盖数据目录（手机端不设此变量，行为不变）
export const HOME = process.env.MONITOR_HOME || '/data/data/com.termux/files/home';
export const DATA_DIR = HOME + '/.monitor_data';
export const SB_HOST = '127.0.0.1';
export const SB_PORT = 9090;
export const SB_SECRET = process.env.SB_SECRET || '';
export const SB_DISABLED = process.env.SB_DISABLED;

// ====== Services ======
export const PROTECTED_FILES = [
  'monitor/server.js', 'proxy-bridge/server.js', 'proxy-bridge/package.json',
  'mihomo/config.yaml', 'subscriber.sh', 'subscriber-loop.sh', 'start-all.sh',
  '.cloudflared/config.yml', '.cloudflared/cert.pem',
];

// 内置服务规则（不可删除）
export const SERVICE_CMDS = [
  { match: 'mihomo', label: '重启', action: 'restart-singbox' },
  { match: 'cloudflared tunnel run', label: '重启', action: 'restart-tunnel' },
  { match: 'proxy-bridge', label: '重启', action: 'restart-proxy' },
  { match: 'monitor/server.js', label: '重启', action: 'restart-monitor' },
  { match: 'node server.js', label: '重启', action: 'restart-monitor' },
];

// 自定义服务规则（从 ~/.monitor_data/service_rules.json 加载，可通过 API 热更新）
const SERVICE_RULES_FILE = DATA_DIR + '/service_rules.json';
let customServiceRules = loadJSON(SERVICE_RULES_FILE, []);

// 获取所有规则（内置 + 自定义），自定义优先匹配
export function getAllServiceRules() {
  return [...customServiceRules, ...SERVICE_CMDS];
}

// 重新加载自定义规则（API 修改后调用）
export function reloadServiceRules() {
  customServiceRules = loadJSON(SERVICE_RULES_FILE, []);
}

// 获取自定义规则列表（供 API 返回）
export function getCustomServiceRules() {
  return customServiceRules;
}

// 保存自定义规则并热加载
export function saveCustomServiceRules(rules) {
  customServiceRules = rules;
  saveJSON(SERVICE_RULES_FILE, rules);
}

export function findService(cmd) {
  // 自定义规则优先匹配（用户定义的更具体）
  const all = getAllServiceRules();
  return all.find(s => cmd.includes(s.match)) || null;
}

// ====== Shell ======
export function run(cmd) {
  return new Promise(r => {
    const p = spawn(BASH, ['-c', cmd]);
    let o = '', e = '';
    p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
    p.on('close', () => r(o || e)); p.on('error', () => r(''));
  });
}

export function fetchJson(url) {
  return new Promise(r => {
    // URL 必须用单引号包裹，否则 bash 会把 & 解释为后台运行符
    // --max-time 8 确保 delay API（timeout=5000）有足够时间返回
    const p = spawn(BASH, ['-c', `curl -s --connect-timeout 3 --max-time 8 '${url}'`]);
    let o = '';
    p.stdout.on('data', d => o += d);
    p.on('close', () => { try { r(JSON.parse(o)); } catch { r(null); } });
    p.on('error', () => r(null));
  });
}

// 原生 HTTP 请求 sing-box Clash API（避免 spawn curl，支持自定义超时）
export function fetchSb(path, timeoutMs = 5000) {
  return new Promise(r => {
    const opts = {
      hostname: SB_HOST, port: SB_PORT, path, method: 'GET',
      headers: {}, timeout: timeoutMs,
    };
    if (SB_SECRET) opts.headers['authorization'] = 'Bearer ' + SB_SECRET;
    const req = httpReq(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { r(JSON.parse(data)); } catch { r(null); } });
    });
    req.on('timeout', () => { req.destroy(); r(null); });
    req.on('error', () => r(null));
    req.end();
  });
}

// ====== 代理组工具 ======
// 从 Clash API 的 /proxies 结果中取「当前实际承载代理节点」。
// 关键：mihomo(Clash) 会额外暴露名为 GLOBAL 的伪 Selector 组（其 now 常为 DIRECT），
// 若简单取「第一个 Selector」会误取 GLOBAL→DIRECT。故优先取「节点选择」组，并排除 GLOBAL。
export const PROXY_GROUP = '节点选择';
export function pickProxyNode(proxies) {
  const px = proxies && proxies.proxies;
  if (!px) return '';
  if (px[PROXY_GROUP] && px[PROXY_GROUP].now) return px[PROXY_GROUP].now;
  for (const [name, p] of Object.entries(px)) {
    if (name === 'GLOBAL' || name === 'direct' || name === PROXY_GROUP) continue;
    if (p && p.now && p.type === 'Selector') return p.now;
  }
  return '';
}

// ====== JSON I/O ======
export function loadJSON(path, def) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return def; }
}
export function saveJSON(path, data) {
  try { writeFileSync(path, JSON.stringify(data), 'utf-8'); } catch {}
}

// ====== Formatting ======
export function fmtDuration(sec) {
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  if (sec < 86400) return Math.round(sec / 3600) + 'h ' + Math.round((sec % 3600) / 60) + 'm';
  return Math.round(sec / 86400) + 'd';
}

export function fmtDurationStr(s) {
  if (!s) return '--';
  let d = 0, h = 0, m = 0, sec = 0;
  if (s.includes('-')) { const p = s.split('-'); d = +p[0]; s = p[1]; }
  const parts = s.split(':');
  if (parts.length === 3) { h = +parts[0]; m = +parts[1]; sec = +parts[2]; }
  else if (parts.length === 2) { m = +parts[0]; sec = +parts[1]; }
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm';
  return sec + 's';
}

export function fmtBytes(b) {
  if (!b || b === 0) return '0B';
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + 'MB';
  return (b / 1073741824).toFixed(2) + 'GB';
}

export function fmtSpeed(b) {
  if (!b || b === 0) return '0';
  if (b < 1024) return b.toFixed(1);
  if (b < 1048576) return (b / 1024).toFixed(1);
  return (b / 1048576).toFixed(1);
}

export function fmtBytesSec(b) {
  return fmtSpeed(b) + (b < 1024 ? 'B/s' : b < 1048576 ? 'KB/s' : 'MB/s');
}

// ====== Process keyword extraction ======
export function procKeyword(cmd) {
  if (!cmd) return '';
  const shMatch = cmd.match(/(?:bash|sh)\s+\S*?([a-zA-Z0-9_-]+\.sh)\b/);
  if (shMatch) return shMatch[1];
  const pyMatch = cmd.match(/python3?\s+\S*?([a-zA-Z0-9_-]+\.py)\b/);
  if (pyMatch) return pyMatch[1];
  const parts = cmd.split(/\s+/);
  const name = parts[0].replace(/.*\//, '');
  if (parts.length > 1 && parts[1] && !parts[1].startsWith('-')) return name + ' ' + parts[1];
  return name;
}
