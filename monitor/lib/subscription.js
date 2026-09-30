import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { run, loadJSON, saveJSON, DATA_DIR, HOME, SB_HOST, SB_PORT, SB_SECRET } from './utils.js';

// js-yaml 为 CommonJS 模块，ESM 下用 createRequire 加载（load/dump 齐全）
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

// ====== Subscriptions State ======
const SUBSCRIPTIONS_FILE = DATA_DIR + '/subscriptions.json';
export let subscriptions = loadJSON(SUBSCRIPTIONS_FILE, []);

// ====== Mihomo (内核) 路径与常量 ======
// 已从 sing-box 迁移到 mihomo（Clash Meta）内核。
// - 配置为 Clash YAML：~/mihomo/config.yaml
// - mihomo 原生提供 Clash API，端口沿用 SB_HOST:SB_PORT(9090)，mixed 代理端口 7897
export const MIHOMO_DIR = HOME + '/mihomo';
export const MIHOMO_CONFIG = MIHOMO_DIR + '/config.yaml';
export const MIHOMO_BIN = 'mihomo';
export const MIXED_PORT = 7897;
// Termux runit 服务目录（monitor 重启内核优先走 sv，与守护单一对齐）
export const RUNIT_SVC = '/data/data/com.termux/files/usr/var/service';

// 生成 mihomo 重启命令：优先让 runit 重启（单一守护源，避免与手动实例冲突）；
// 无 runit （如本地开发）时回退 pidof 杀旧 + setsid 直起。（Termux 上 pgrep -x 失效，一律用 pidof）
export function mihomoRunCmd() {
  return `mkdir -p ${MIHOMO_DIR}; sv restart ${RUNIT_SVC}/mihomo 2>/dev/null || (kill $(pidof mihomo) 2>/dev/null; sleep 1; setsid ${MIHOMO_BIN} -d ${MIHOMO_DIR} -f ${MIHOMO_CONFIG} >/dev/null 2>&1 & disown)`;
}

// ====== DNS Config ======
// DNS 模式持久化：用户可在订阅页面切换，避免"时好时坏"问题反复出现。
// mihomo DNS 模型：default-nameserver 必须是纯 IP（引导解析 DoH 域名本身，规避"鸡生蛋"），
// proxy-server-nameserver 解析节点域名，nameserver 业务解析。
const DNS_CONFIG_FILE = DATA_DIR + '/dns_config.json';

// mihomo DNS 模型：实测发现用 DoH(223.5.5.5) 解析节点域名会导致 Reality/WS 节点连不上
// （DoH 对 nekohub.xyz 返回的 IP 与系统解析不一致/失败），而系统解析全部正常。
// 故默认 system 模式关闭 mihomo 内置 DNS 走系统；doh 模式仅加密业务域名，节点域名仍用 system。
const DNS_PRESETS = {
  system: {
    name: '系统 DNS',
    desc: '使用系统/运营商 DNS 解析（实测对 Reality/WS/Hysteria2 节点最稳定，推荐）',
    dns: {
      enable: false,
    },
  },
  doh: {
    name: 'DoH 加密解析',
    desc: '223.5.5.5 DoH 解析业务域名；节点域名仍走系统解析以保证连通',
    dns: {
      enable: true,
      ipv6: false,
      'default-nameserver': ['223.5.5.5', '8.8.8.8'],
      'proxy-server-nameserver': ['system'],
      nameserver: ['https://223.5.5.5/dns-query'],
    },
  },
};

function currentDns() {
  const saved = loadJSON(DNS_CONFIG_FILE, null);
  const mode = (saved && saved.mode && DNS_PRESETS[saved.mode]) ? saved.mode : 'system';
  return DNS_PRESETS[mode].dns;
}

// 获取当前 DNS 配置（含模式列表与当前生效配置），未配置时默认 'ip'
export function getDnsConfig() {
  const saved = loadJSON(DNS_CONFIG_FILE, null);
  const mode = (saved && saved.mode && DNS_PRESETS[saved.mode]) ? saved.mode : 'system';
  return {
    mode,
    current: DNS_PRESETS[mode].dns,
    presets: Object.fromEntries(Object.entries(DNS_PRESETS).map(([k, v]) => [k, { name: v.name, desc: v.desc }])),
  };
}

// 应用 DNS 模式：持久化 → 改写 mihomo config.yaml 的 dns 段 → 重启 mihomo
export async function applyDnsConfig(mode) {
  if (!DNS_PRESETS[mode]) throw new Error('未知 DNS 模式: ' + mode);
  saveJSON(DNS_CONFIG_FILE, { mode });
  let cfg;
  try { cfg = yaml.load(readFileSync(MIHOMO_CONFIG, 'utf-8')); } catch { throw new Error('无法读取 mihomo 配置: ' + MIHOMO_CONFIG); }
  cfg.dns = DNS_PRESETS[mode].dns;
  writeFileSync(MIHOMO_CONFIG, yaml.dump(cfg, { lineWidth: -1, noRefs: true }), 'utf-8');
  await run(mihomoRunCmd());
  return mode;
}

export let nodeStatusCache = { data: null, time: 0 };
// 节点内存缓存：按 sub.id 存储已解析的 proxies 数组，避免 regenerateConfig 时重复下载所有订阅
const subNodesCache = {};

// 信息/广告节点关键词（订阅里指向官网/流量说明的伪节点，过滤掉不展示）
const AD_KEYWORDS = ['剩余流量', '到期', '重置', '失联', '套餐', '续费', '客服', '官网', '返利', '邀请', '教程', '软件', '下载新', '更新于', '请去', '请立即'];

// ====== Subscription Parser ======
// 用 clash UA 拉取机场原生 Clash YAML，解析出 proxies 数组；同时从 HTTP header 解析用量信息。
export async function parseSubscription(url) {
  const safeUrl = url.replace(/'/g, "'\\''");
  const hdrFile = DATA_DIR + '/_sub_hdr_tmp';

  const raw = await run(`curl -sL --max-time 20 -H 'User-Agent: clash-verge/v2.0.0' -D '${hdrFile}' '${safeUrl}'`);

  let usage = null;
  let profileTitle = null;
  let updateInterval = null;
  let website = null;
  try {
    const hdrContent = readFileSync(hdrFile, 'utf-8');
    unlinkSync(hdrFile);
    const m = hdrContent.match(/subscription-userinfo:\s*(.+)/i);
    if (m) {
      usage = {};
      m[1].trim().split(';').forEach(p => {
        const [k, v] = p.trim().split('=');
        if (k && v) usage[k.trim()] = parseInt(v) || v.trim();
      });
    }
    const ui = hdrContent.match(/profile-update-interval:\s*(\d+)/i);
    if (ui) updateInterval = parseInt(ui[1]);
    const pt = hdrContent.match(/profile-title:\s*base64:(.+)/i);
    if (pt) { try { profileTitle = Buffer.from(pt[1].trim(), 'base64').toString('utf-8'); } catch {} }
    const wp = hdrContent.match(/profile-web-page-url:\s*(\S+)/i);
    if (wp) website = wp[1].trim();
  } catch {}
  if (website) usage = usage || {}, usage.website = website;

  // 解析 YAML（可能整体 base64 编码）
  let doc = null;
  const text = (raw || '').trim();
  try {
    doc = yaml.load(text);
  } catch {
    try { doc = yaml.load(Buffer.from(text, 'base64').toString('utf-8')); } catch {}
  }

  let proxies = [];
  if (doc && Array.isArray(doc.proxies)) {
    proxies = doc.proxies.filter(p => p && p.name && p.type && p.server &&
      !AD_KEYWORDS.some(kw => String(p.name).includes(kw)) &&
      p.server !== '127.0.0.1' && p.server !== 'localhost' && p.server !== '0.0.0.0');
    // 从被过滤掉的信息节点名称里提取流量/到期等信息（部分机场把用量写成伪节点）
    const infoNames = doc.proxies.map(p => p && p.name).filter(Boolean);
    const infoFromNodes = parseInfoTags(infoNames);
    if (infoFromNodes) {
      usage = usage || {};
      for (const [k, v] of Object.entries(infoFromNodes)) if (usage[k] === undefined) usage[k] = v;
    }
  }
  if (updateInterval) usage = usage || {}, usage.update_interval = updateInterval;

  return { proxies, usage, profileTitle };
}

// ====== Info Tags Parser ======
function parseInfoTags(tags) {
  const info = {};
  for (const tag of tags) {
    let m = tag.match(/剩余流量[：:]\s*([\d.]+\s*[GMTK]?B?)/i);
    if (m) info.remaining_str = m[1];
    m = tag.match(/已用[流量]*[：:]\s*([\d.]+\s*[GMTK]?B?)/i);
    if (m) info.used_str = m[1];
    m = tag.match(/总流量[：:]\s*([\d.]+\s*[GMTK]?B?)/i);
    if (m) info.total_str = m[1];
    m = tag.match(/到期[时间]*[：:]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
    if (m) info.expire_str = m[1];
    m = tag.match(/(?:重置剩余|距.*?重置|下次重置.*?剩余)[：:\s]*(\d+)\s*天/);
    if (m) info.reset_days = parseInt(m[1]);
    else if ((m = tag.match(/(\d+)\s*天后?重?置?/)) && !info.reset_days) info.reset_days = parseInt(m[1]);
    m = tag.match(/(?:下次重置|重置日期|重置时间)[：:]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
    if (m) info.next_reset = m[1];
    m = tag.match(/(?:套餐|产品|方案)[：:]\s*([^\s,，]+)/);
    if (m) info.plan_name = m[1];
    m = tag.match(/官网[：:]\s*(https?:\/\/[^\s,，]+)/i);
    if (m) info.website = m[1];
  }
  return Object.keys(info).length > 0 ? info : null;
}

// ====== Config Generation (mihomo Clash YAML) ======
// allProxies: 已带订阅名前缀的 Clash proxy 对象数组（每个含 name/type/server/port/...）
export function generateMihomoConfig(allProxies) {
  let existing = {};
  try { existing = yaml.load(readFileSync(MIHOMO_CONFIG, 'utf-8')) || {}; } catch {}
  const names = allProxies.map(p => p.name);

  // 默认选中节点策略（避免订阅刷新/内核重启后 select 组回到列表第一个，如"美国 01"）：
  //   1. 优先保留当前正在用的节点（从 Clash API 读取 节点选择.now）
  //   2. 其次保留旧配置组的第一个（上次默认）
  //   3. 都不在新列表时，用 names[0]
  // mihomo 的 select 组重启后默认选 proxies 数组第一个，故把目标节点置于首位。
  let defNode = names[0];
  const findInNames = (name) => {
    if (!name) return null;
    if (names.includes(name)) return name;
    for (const t of names) {
      const baseT = t.includes('_') ? t.slice(t.indexOf('_') + 1) : t;
      const baseN = name.includes('_') ? name.slice(name.indexOf('_') + 1) : name;
      if (baseT === baseN) return t;
    }
    return null;
  };
  try {
    const out = execSync(`curl -s --max-time 2 http://${SB_HOST}:${SB_PORT}/proxies 2>/dev/null`).toString();
    const cur = JSON.parse(out)?.proxies?.['节点选择']?.now;
    const matched = findInNames(cur);
    if (matched) defNode = matched;
  } catch {}
  if (defNode === names[0]) {
    try {
      const oldGroup = (existing['proxy-groups'] || []).find(g => g.name === '节点选择');
      const matched = findInNames(oldGroup?.proxies?.[0]);
      if (matched) defNode = matched;
    } catch {}
  }
  const groupProxies = defNode ? [defNode, ...names.filter(n => n !== defNode)] : names;

  const config = {
    'mixed-port': MIXED_PORT,
    'allow-lan': true,
    'bind-address': '*',
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'unified-delay': true,
    'external-controller': `${SB_HOST}:${SB_PORT}`,
    secret: SB_SECRET || '',
    dns: currentDns(),
    proxies: allProxies,
    'proxy-groups': [
      { name: '节点选择', type: 'select', proxies: [...groupProxies, 'DIRECT'] },
    ],
    // 不使用 GEOIP/GEOSITE（避免下载 GeoDB）；仅私有网段直连，其余全部走「节点选择」
    rules: [
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR6,::1/128,DIRECT,no-resolve',
      'MATCH,节点选择',
    ],
  };
  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}

// 重新生成 mihomo 配置
// refreshSubId: 指定要刷新的订阅 id（只重新下载该订阅）；其他订阅使用内存缓存的节点
export async function regenerateConfig(refreshSubId = null) {
  const allProxies = [];
  for (const sub of subscriptions) {
    let proxies;
    if (sub.id === refreshSubId || !subNodesCache[sub.id]) {
      const { proxies: parsed, usage, profileTitle } = await parseSubscription(sub.url);
      proxies = parsed;
      subNodesCache[sub.id] = parsed;
      sub.nodeCount = parsed.length;
      sub.lastUpdate = new Date().toISOString();
      sub.usage = usage;
      if (profileTitle) sub.profileTitle = profileTitle;
    } else {
      proxies = subNodesCache[sub.id];
    }
    for (const p of proxies) {
      allProxies.push({ ...p, name: sub.name + '_' + p.name });
    }
  }
  // 清理已删除订阅的缓存
  for (const cachedId of Object.keys(subNodesCache)) {
    if (!subscriptions.find(s => s.id === cachedId)) delete subNodesCache[cachedId];
  }
  saveJSON(SUBSCRIPTIONS_FILE, subscriptions);
  if (allProxies.length > 0) {
    const config = generateMihomoConfig(allProxies);
    writeFileSync(MIHOMO_CONFIG, config, 'utf-8');
    await run(mihomoRunCmd());
  }
  return allProxies.length;
}
