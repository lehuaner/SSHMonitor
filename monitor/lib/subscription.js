import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { run, loadJSON, saveJSON, fetchSb, DATA_DIR, HOME, SB_HOST, SB_PORT, SB_SECRET } from './utils.js';

// ====== Subscriptions State ======
const SUBSCRIPTIONS_FILE = DATA_DIR + '/subscriptions.json';
export let subscriptions = loadJSON(SUBSCRIPTIONS_FILE, []);

// ====== DNS Config ======
// DNS 模式持久化：用户可在订阅页面切换，避免"时好时坏"问题反复出现
const DNS_CONFIG_FILE = DATA_DIR + '/dns_config.json';

// DNS 模式预设：
//  - ip      IP 直连 DoH（免域名引导解析，最稳定，推荐）
//  - domain  域名 DoH（dns.alidns.com，需要先解析域名本身，可能时好时坏）
// 两种模式都保留 local 的 detour:direct（防止 DNS 查询打回 sing-box 形成 loopback）
// 以及新订阅专线节点域名（.byteprivatelink.com / .smartprivatelink.com）的 DNS rules
const DNS_PRESETS = {
  ip: {
    name: 'IP 直连 DoH',
    desc: 'https://223.5.5.5/dns-query（免域名引导解析，最稳定）',
    dns: {
      servers: [
        { tag: 'dns', address: 'https://223.5.5.5/dns-query', detour: 'direct' },
        { tag: 'local', address: '223.5.5.5', detour: 'direct' },
      ],
      rules: [
        { domain_suffix: ['.nekohub.xyz', '.google.com', '.openai.com', 'chatgpt.com', '.byteprivatelink.com', '.smartprivatelink.com'], server: 'dns' },
      ],
      final: 'local',
    },
  },
  domain: {
    name: '域名 DoH',
    desc: 'https://dns.alidns.com/dns-query（阿里云公共 DNS，需先引导解析域名）',
    dns: {
      servers: [
        { tag: 'dns', address: 'https://dns.alidns.com/dns-query', detour: 'direct' },
        { tag: 'local', address: '223.5.5.5', detour: 'direct' },
      ],
      rules: [
        { domain_suffix: ['.nekohub.xyz', '.google.com', '.openai.com', 'chatgpt.com', '.byteprivatelink.com', '.smartprivatelink.com'], server: 'dns' },
      ],
      final: 'local',
    },
  },
};

// 获取当前 DNS 配置（含模式列表与当前生效配置），未配置时默认 'ip'
export function getDnsConfig() {
  const saved = loadJSON(DNS_CONFIG_FILE, null);
  const mode = (saved && saved.mode && DNS_PRESETS[saved.mode]) ? saved.mode : 'ip';
  return {
    mode,
    current: DNS_PRESETS[mode].dns,
    presets: Object.fromEntries(Object.entries(DNS_PRESETS).map(([k, v]) => [k, { name: v.name, desc: v.desc }])),
  };
}

// 应用 DNS 模式：持久化 → 写入 sb-config.json 的 dns 段 → 重启 sing-box
export async function applyDnsConfig(mode) {
  if (!DNS_PRESETS[mode]) throw new Error('未知 DNS 模式: ' + mode);
  saveJSON(DNS_CONFIG_FILE, { mode });
  let config;
  try { config = JSON.parse(readFileSync(HOME + '/sb-config.json', 'utf-8')); } catch { throw new Error('无法读取 sb-config.json'); }
  config.dns = DNS_PRESETS[mode].dns;
  writeFileSync(HOME + '/sb-config.json', JSON.stringify(config, null, 2), 'utf-8');
  await run(`kill $(pgrep -x sing-box) 2>/dev/null; sleep 1; ENABLE_DEPRECATED_LEGACY_DNS_SERVERS=true ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER=true setsid sing-box run -c ${HOME}/sb-config.json &>/dev/null & disown`);
  return mode;
}
export let nodeStatusCache = { data: null, time: 0 };
// 节点内存缓存：按 sub.id 存储已解析的节点数组，避免 regenerateConfig 时重复下载所有订阅
const subNodesCache = {};

// ====== Subscription Parser ======
export async function parseSubscription(url) {
  const safeUrl = url.replace(/'/g, "'\\''");
  const hdrFile = DATA_DIR + '/_sub_hdr_tmp';

  const sbRaw = await run(`curl -sL --max-time 15 -H 'User-Agent: sing-box' -D '${hdrFile}' '${safeUrl}'`);

  let usage = null;
  let profileTitle = null;
  let updateInterval = null;
  let profileWebPageUrl = null;
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
    if (wp) profileWebPageUrl = wp[1].trim();
  } catch {}
  if (profileWebPageUrl) usage = usage || {}, usage.website = profileWebPageUrl;

  let nodes = [];
  const infoTags = [];

  if (sbRaw && sbRaw.trim()) {
    try {
      const data = JSON.parse(sbRaw.trim());
      const outs = Array.isArray(data) ? data : (data.outbounds || []);
      if (outs.length > 0) {
        const groupTypes = ['selector', 'urltest', 'direct', 'block', 'dns', 'compatibility', 'fallback', 'loadbalance'];
        const adKeywords = ['剩余流量', '到期', '重置', '失联', '套餐', '续费', '客服', '官网', '返利', '邀请', '教程', '软件', '下载新', '更新于', '请去', '请立即'];
        nodes = outs.filter(o => {
          if (!o.tag || !o.type) return false;
          if (groupTypes.includes(o.type)) return false;
          const srv = o.server || '';
          if (!srv || srv === '127.0.0.1' || srv === '0.0.0.0' || srv === 'localhost') { infoTags.push(o.tag); return false; }
          if (srv.includes(':')) return false;
          if (adKeywords.some(kw => o.tag.includes(kw))) { infoTags.push(o.tag); return false; }
          return true;
        });
      }
    } catch {}
  }

  if (nodes.length === 0) {
    const raw = sbRaw || await run(`curl -sL --max-time 15 '${safeUrl}'`);
    if (raw && raw.trim()) {
      let decoded;
      try {
        const buf = Buffer.from(raw.trim(), 'base64').toString();
        decoded = buf.includes('://') ? buf : raw;
      } catch { decoded = raw; }
      for (const line of decoded.split(/\r?\n/).filter(Boolean)) {
        const node = parseV2RayLink(line.trim());
        if (node) nodes.push(node);
      }
    }
  }

  const infoFromNodes = parseInfoTags(infoTags);
  if (infoFromNodes) {
    if (!usage) usage = {};
    for (const [k, v] of Object.entries(infoFromNodes)) {
      if (usage[k] === undefined) usage[k] = v;
    }
  }
  if (updateInterval) usage = usage || {}, usage.update_interval = updateInterval;

  return { nodes, usage, profileTitle };
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

// ====== Link Parsers ======
function parseV2RayLink(line) {
  try {
    if (line.startsWith('vmess://')) return parseVmessLink(line);
    if (line.startsWith('vless://')) return parseURLLink(line, 'vless', 'uuid');
    if (line.startsWith('trojan://')) return parseURLLink(line, 'trojan', 'password');
    if (line.startsWith('hysteria2://') || line.startsWith('hy2://')) return parseHysteria2Link(line);
    if (line.startsWith('ss://')) return parseSSLink(line);
  } catch {}
  return null;
}

function parseVmessLink(line) {
  const json = JSON.parse(Buffer.from(line.slice('vmess://'.length), 'base64').toString());
  const ob = {
    type: 'vmess', tag: (json.ps || json.add + ':' + json.port).replace(/\s+/g, '_').replace(/[｜|]/g, ''),
    server: json.add, server_port: parseInt(json.port),
    uuid: json.id, alter_id: parseInt(json.aid) || 0, security: json.scy || 'auto',
  };
  const net = json.net || 'tcp';
  if (net !== 'tcp') {
    ob.transport = { type: net };
    if (net === 'ws') {
      if (json.path) ob.transport.path = json.path;
      if (json.host) ob.transport.headers = { Host: json.host };
    } else if (net === 'grpc') {
      if (json.path) ob.transport.service_name = json.path;
    } else if (net === 'http' || net === 'h2') {
      if (json.host) ob.transport.host = [json.host];
      if (json.path) ob.transport.path = json.path;
    }
  }
  if (json.tls === 'tls') {
    ob.tls = { enabled: true };
    if (json.sni) ob.tls.server_name = json.sni;
    if (json.verify_cert === false) ob.tls.insecure = true;
  }
  return ob;
}

function parseURLLink(line, type, credField) {
  const hashIdx = line.indexOf('#');
  let name = hashIdx !== -1 ? decodeURIComponent(line.slice(hashIdx + 1)) : '';
  const withoutHash = hashIdx !== -1 ? line.slice(0, hashIdx) : line;
  const rest = withoutHash.slice(type.length + 3);
  const atIdx = rest.indexOf('@');
  if (atIdx === -1) return null;
  const cred = rest.slice(0, atIdx);
  const serverPart = rest.slice(atIdx + 1);
  const qIdx = serverPart.indexOf('?');
  let hostPort = (qIdx !== -1 ? serverPart.slice(0, qIdx) : serverPart).replace(/\/+$/, '');
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon === -1) return null;
  const server = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1));
  if (!server || !port || server.includes(':')) return null;
  const ob = { type, tag: (name || server + ':' + port).replace(/\s+/g, '_').replace(/[｜|]/g, ''), server, server_port: port };
  ob[credField] = cred;
  if (qIdx !== -1) {
    const params = new URLSearchParams(serverPart.slice(qIdx + 1));
    const security = params.get('security');
    if (security === 'tls' || security === 'reality') {
      ob.tls = { enabled: true };
      const sni = params.get('sni');
      if (sni) ob.tls.server_name = sni;
      const fp = params.get('fp');
      if (fp) ob.tls.utls = { enabled: true, fingerprint: fp };
      if (params.get('allowInsecure') === '1') ob.tls.insecure = true;
      if (security === 'reality') {
        ob.tls.reality = { enabled: true };
        const pbk = params.get('pbk');
        if (pbk) ob.tls.reality.public_key = pbk;
        const sid = params.get('sid');
        if (sid) ob.tls.reality.short_id = sid;
      }
    }
    const netType = params.get('type') || 'tcp';
    if (netType !== 'tcp') {
      ob.transport = { type: netType };
      if (netType === 'ws') {
        const path = params.get('path');
        if (path) ob.transport.path = decodeURIComponent(path);
        const host = params.get('host');
        if (host) ob.transport.headers = { Host: host };
      } else if (netType === 'grpc') {
        const sn = params.get('serviceName');
        if (sn) ob.transport.service_name = sn;
      } else if (netType === 'http' || netType === 'h2') {
        const host = params.get('host');
        if (host) ob.transport.host = [host];
        const path = params.get('path');
        if (path) ob.transport.path = path;
      }
    }
    if (type === 'vless') {
      const flow = params.get('flow');
      if (flow) ob.flow = flow;
    }
  }
  return ob;
}

function parseHysteria2Link(line) {
  const prefix = line.startsWith('hy2://') ? 'hy2://' : 'hysteria2://';
  const hashIdx = line.indexOf('#');
  let name = hashIdx !== -1 ? decodeURIComponent(line.slice(hashIdx + 1)) : '';
  const withoutHash = hashIdx !== -1 ? line.slice(0, hashIdx) : line;
  const rest = withoutHash.slice(prefix.length);
  const atIdx = rest.indexOf('@');
  if (atIdx === -1) return null;
  const password = rest.slice(0, atIdx);
  const serverPart = rest.slice(atIdx + 1);
  const qIdx = serverPart.indexOf('?');
  let hostPort = (qIdx !== -1 ? serverPart.slice(0, qIdx) : serverPart).replace(/\/+$/, '');
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon === -1) return null;
  const server = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1));
  if (!server || !port || server.includes(':')) return null;
  const ob = {
    type: 'hysteria2', tag: (name || server + ':' + port).replace(/\s+/g, '_').replace(/[｜|]/g, ''),
    server, server_port: port, password,
    tls: { enabled: true, server_name: 'www.bing.com', insecure: true },
  };
  if (qIdx !== -1) {
    const params = new URLSearchParams(serverPart.slice(qIdx + 1));
    const sni = params.get('sni');
    if (sni) ob.tls.server_name = sni;
    if (params.get('insecure') === '1') ob.tls.insecure = true;
  }
  return ob;
}

function parseSSLink(line) {
  const hashIdx = line.indexOf('#');
  let name = hashIdx !== -1 ? decodeURIComponent(line.slice(hashIdx + 1)) : '';
  const withoutHash = hashIdx !== -1 ? line.slice(0, hashIdx) : line;
  const rest = withoutHash.slice('ss://'.length);
  const atIdx = rest.lastIndexOf('@');
  if (atIdx !== -1) {
    const b64 = rest.slice(0, atIdx);
    const hostPort = rest.slice(atIdx + 1).replace(/\/+$/, '');
    const lastColon = hostPort.lastIndexOf(':');
    if (lastColon === -1) return null;
    const server = hostPort.slice(0, lastColon);
    const port = parseInt(hostPort.slice(lastColon + 1));
    if (!server || !port || server.includes(':')) return null;
    const decoded = Buffer.from(b64, 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      type: 'shadowsocks', tag: (name || server + ':' + port).replace(/\s+/g, '_').replace(/[｜|]/g, ''),
      server, server_port: port, method: decoded.slice(0, colonIdx), password: decoded.slice(colonIdx + 1),
    };
  }
  try {
    const decoded = Buffer.from(rest, 'base64').toString();
    const atIdx2 = decoded.lastIndexOf('@');
    if (atIdx2 === -1) return null;
    const methodPass = decoded.slice(0, atIdx2);
    const hostPort = decoded.slice(atIdx2 + 1);
    const lastColon = hostPort.lastIndexOf(':');
    if (lastColon === -1) return null;
    const server = hostPort.slice(0, lastColon);
    const port = parseInt(hostPort.slice(lastColon + 1));
    if (!server || !port || server.includes(':')) return null;
    const colonIdx = methodPass.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      type: 'shadowsocks', tag: (name || server + ':' + port).replace(/\s+/g, '_').replace(/[｜|]/g, ''),
      server, server_port: port, method: methodPass.slice(0, colonIdx), password: methodPass.slice(colonIdx + 1),
    };
  } catch { return null; }
}

// ====== Config Generation ======
export function generateSbConfig(allNodes) {
  let existing = {};
  try { existing = JSON.parse(readFileSync(HOME + '/sb-config.json', 'utf-8')); } catch {}
  const outbounds = allNodes.map(n => ({ ...n }));
  const tags = allNodes.map(n => n.tag);
  // default 节点选择策略（避免订阅刷新/sing-box 重启后 selector 重置为列表第一个，如"美国1"）：
  //   1. 优先保留当前正在用的节点（从 Clash API 读取 selector.now）
  //   2. 其次保留旧配置的 default
  //   3. 都不在新节点列表中时，才用 tags[0]
  // 注意：节点 tag 带订阅名前缀（如 "nekohub_日本 04"），订阅刷新后前缀不变但可能旧节点已不存在
  //       所以匹配时先精确匹配，再按后缀模糊匹配（处理前缀变化的情况）
  let defaultNode = tags[0];
  const findInTags = (name) => {
    if (!name) return null;
    if (tags.includes(name)) return name;
    // 模糊匹配：name 可能是去掉前缀的旧 tag，或带旧前缀的 tag
    // 例如 name="日本 04"，tags 含 "nekohub_日本 04" → 匹配
    // 例如 name="oldsub_日本 04"，tags 含 "nekohub_日本 04" → 按后缀匹配
    for (const t of tags) {
      const baseT = t.includes('_') ? t.slice(t.indexOf('_') + 1) : t;
      const baseN = name.includes('_') ? name.slice(name.indexOf('_') + 1) : name;
      if (baseT === baseN) return t;
    }
    return null;
  };
  // 尝试从 Clash API 读取当前 selector 实际选中的节点（最准确）
  try {
    const out = execSync(
      `curl -s --max-time 2 http://127.0.0.1:9090/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9 2>/dev/null`
    ).toString();
    const cur = JSON.parse(out)?.now;
    const matched = findInTags(cur);
    if (matched) defaultNode = matched;
  } catch {}
  // 回退：旧配置的 default
  if (defaultNode === tags[0]) {
    try {
      const oldSel = existing.outbounds?.find(o => o.type === 'selector' && o.tag === '节点选择');
      const matched = findInTags(oldSel?.default);
      if (matched) defaultNode = matched;
    } catch {}
  }
  outbounds.push({ type: 'selector', tag: '节点选择', outbounds: tags, default: defaultNode });
  outbounds.push({ type: 'direct', tag: 'direct' });
  // DNS：优先使用页面上已保存的 DNS 模式；未配置过则保留现有配置
  const dnsSaved = loadJSON(DNS_CONFIG_FILE, null);
  const dnsConfig = (dnsSaved && dnsSaved.mode && DNS_PRESETS[dnsSaved.mode]) ? DNS_PRESETS[dnsSaved.mode].dns
    : (existing.dns || { servers: [{ tag: 'local', address: 'local' }], rules: [{ outbound: 'any', server: 'local' }] });
  const config = {
    log: existing.log || { level: 'warn' },
    experimental: existing.experimental || {
      clash_api: {
        external_controller: SB_HOST + ':' + SB_PORT,
        secret: SB_SECRET,
        external_ui: HOME + '/sb-ui',
      },
    },
    dns: dnsConfig,
    inbounds: existing.inbounds || [{ type: 'mixed', tag: 'mixed-in', listen: '0.0.0.0', listen_port: 7890 }],
    outbounds,
    route: {
      rules: (existing.route && existing.route.rules) || [{ ip_is_private: true, outbound: 'direct' }],
      final: '节点选择',
    },
  };
  return JSON.stringify(config, null, 2);
}

// 重新生成 sing-box 配置
// refreshSubId: 指定要刷新的订阅 id（只重新下载该订阅）；其他订阅使用内存缓存的节点
// 若缓存不存在或 refreshSubId 为 null，则按需下载对应订阅
export async function regenerateConfig(refreshSubId = null) {
  const allNodes = [];
  for (const sub of subscriptions) {
    let nodes;
    // 只在指定 refreshSubId 时重新下载该订阅；其他订阅优先用缓存
    if (sub.id === refreshSubId || !subNodesCache[sub.id]) {
      const { nodes: parsedNodes, usage, profileTitle } = await parseSubscription(sub.url);
      nodes = parsedNodes;
      subNodesCache[sub.id] = parsedNodes; // 更新缓存
      sub.nodeCount = parsedNodes.length;
      sub.lastUpdate = new Date().toISOString();
      sub.usage = usage;
      if (profileTitle) sub.profileTitle = profileTitle;
    } else {
      nodes = subNodesCache[sub.id];
    }
    for (const n of nodes) {
      allNodes.push({ ...n, tag: sub.name + '_' + n.tag });
    }
  }
  // 清理已删除订阅的缓存
  for (const cachedId of Object.keys(subNodesCache)) {
    if (!subscriptions.find(s => s.id === cachedId)) delete subNodesCache[cachedId];
  }
  saveJSON(SUBSCRIPTIONS_FILE, subscriptions);
  if (allNodes.length > 0) {
    // generateSbConfig 会把 default 设为当前 selector 选中的节点，重启后 sing-box 会自动用该节点
    const config = generateSbConfig(allNodes);
    writeFileSync(HOME + '/sb-config.json', config, 'utf-8');
    await run(`kill $(pgrep -x sing-box) 2>/dev/null; sleep 1; ENABLE_DEPRECATED_LEGACY_DNS_SERVERS=true ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER=true setsid sing-box run -c ${HOME}/sb-config.json &>/dev/null & disown`);
  }
  return allNodes.length;
}
