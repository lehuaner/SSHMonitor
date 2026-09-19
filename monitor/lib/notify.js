import { writeFileSync } from 'node:fs';
import { run, loadJSON, saveJSON, fetchJson, HOME, DATA_DIR, procKeyword } from './utils.js';
import { writeLog, readLogTail } from './logger.js';

// ====== Paths ======
const MAIL_FILE = DATA_DIR + '/mail_config.json';
const MARKED_FILE = DATA_DIR + '/marked_procs.json';
const LOG_PATH = HOME + '/logs/monitor/proxy_check.log';
// 软删除标记文件：存储已删除日志条目的 timestamp（不真正删除日志，只标记隐藏）
const DELETED_LOG_FILE = DATA_DIR + '/proxy_check_deleted.json';
// 节点切换决策日志
const SWITCH_LOG_PATH = HOME + '/logs/monitor/node_switch.log';
// 调度器心跳日志
const SCHEDULER_LOG_PATH = HOME + '/logs/monitor/scheduler.log';

// ====== Mail Config ======
const defaultConfig = {
  enabled: false, smtp_host: 'smtp.qq.com', smtp_port: '465',
  smtp_user: '', smtp_pass: '', to: '',
  monitored_procs: [],
  proxy_check: {
    enabled: false,
    test_urls: ['https://www.google.com', 'https://www.baidu.com'],
    retry_count: 2,
    retry_delay: 3000,
    check_interval: 10,
    candidate_nodes: [],
    excluded_subscriptions: [],                       // F102：排除订阅（地区展开时不纳入其节点）
    subscription_refresh: { enabled: false, interval_minutes: 180 },  // F102：订阅定时自动刷新
    refresh_on_all_failed: { enabled: false, after_failures: 3 },     // F102：全部失败触发刷新
  },
  device_alerts: {
    enabled: false,
    battery_low: 20,        // 电池电量低于此值告警
    battery_temp_high: 45,  // 电池温度高于此值告警
    wifi_rssi_weak: -75,    // WiFi 信号弱于此值告警
    disk_usage_high: 90,    // 磁盘使用率高于此值告警
    cpu_usage_high: 90,     // CPU 使用率高于此值告警（持续）
    mem_usage_high: 90,     // 内存使用率高于此值告警
    cooldown: 30,           // 同一告警冷却时间（分钟）
  },
};

export let mailConfig = loadJSON(MAIL_FILE, JSON.parse(JSON.stringify(defaultConfig)));

// Backward compatibility: ensure proxy_check fields exist
if (mailConfig.proxy_check) {
  // Convert old single test_url to test_urls array
  if (mailConfig.proxy_check.test_url && !mailConfig.proxy_check.test_urls) {
    mailConfig.proxy_check.test_urls = [mailConfig.proxy_check.test_url];
    delete mailConfig.proxy_check.test_url;
  }
  // Fill in defaults for missing fields
  const pc = mailConfig.proxy_check;
  if (!pc.test_urls) pc.test_urls = defaultConfig.proxy_check.test_urls;
  if (!pc.retry_count && pc.retry_count !== 0) pc.retry_count = defaultConfig.proxy_check.retry_count;
  if (!pc.retry_delay && pc.retry_delay !== 0) pc.retry_delay = defaultConfig.proxy_check.retry_delay;
  if (!pc.check_interval && pc.check_interval !== 0) pc.check_interval = defaultConfig.proxy_check.check_interval;
  if (!pc.candidate_nodes) pc.candidate_nodes = defaultConfig.proxy_check.candidate_nodes;
} else {
  mailConfig.proxy_check = { ...defaultConfig.proxy_check };
}
// F102 新字段兼容：旧配置文件缺键时填默认值
if (!Array.isArray(mailConfig.proxy_check.excluded_subscriptions)) mailConfig.proxy_check.excluded_subscriptions = [];
if (!mailConfig.proxy_check.subscription_refresh) mailConfig.proxy_check.subscription_refresh = { ...defaultConfig.proxy_check.subscription_refresh };
if (!mailConfig.proxy_check.refresh_on_all_failed) mailConfig.proxy_check.refresh_on_all_failed = { ...defaultConfig.proxy_check.refresh_on_all_failed };

// Backward compatibility: ensure device_alerts fields exist
if (!mailConfig.device_alerts) {
  mailConfig.device_alerts = { ...defaultConfig.device_alerts };
} else {
  const da = mailConfig.device_alerts;
  const def = defaultConfig.device_alerts;
  if (da.battery_low === undefined) da.battery_low = def.battery_low;
  if (da.battery_temp_high === undefined) da.battery_temp_high = def.battery_temp_high;
  if (da.wifi_rssi_weak === undefined) da.wifi_rssi_weak = def.wifi_rssi_weak;
  if (da.disk_usage_high === undefined) da.disk_usage_high = def.disk_usage_high;
  if (da.cpu_usage_high === undefined) da.cpu_usage_high = def.cpu_usage_high;
  if (da.mem_usage_high === undefined) da.mem_usage_high = def.mem_usage_high;
  if (da.cooldown === undefined) da.cooldown = def.cooldown;
}

// 设备告警冷却记录: { key: timestamp }
const deviceAlertCooldown = {};

export let markedProcs = loadJSON(MARKED_FILE, []);
export let procStatus = {};
// 已初始化的进程标记 - 防止首次检查误报
const initialized = new Set();

// ====== Send Mail ======
// 统一邮件头：所有邮件自动添加设备名称和时间前缀
const DEVICE_NAME = 'Honor10';
export async function sendMail(subject, body) {
  const c = mailConfig;
  if (!c.smtp_user || !c.smtp_pass || !c.to) return false;
  const header = `设备: ${DEVICE_NAME}\n时间: ${new Date().toLocaleString('zh-CN')}\n──────────────────────────\n`;
  const fullBody = header + body;
  const mail = `From: ${c.smtp_user}\r\nTo: ${c.to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${fullBody}`;
  // 注意：必须用 printf '%s' 把邮件内容作为数据参数传入，而不是作为格式字符串
  // 否则正文中的 %（如电池/磁盘/CPU 告警的 "90%"）会被 printf 当作格式符解析，导致发送失败
  const cmd = `printf '%s' '${mail.replace(/'/g, "'\\''")}' | curl -s --url 'smtps://${c.smtp_host}:${c.smtp_port}' --ssl-reqd --login-options 'AUTH=LOGIN' --mail-from '${c.smtp_user}' --mail-rcpt '${c.to}' --user '${c.smtp_user}:${c.smtp_pass}' -T - --max-time 15 2>&1`;
  const result = await run(cmd);
  return !result || (!result.includes('error') && !result.includes('Failed') && !result.includes('curl:'));
}

// ====== Process Monitoring ======
export async function checkProcs() {
  if (!mailConfig.enabled || mailConfig.monitored_procs.length === 0) return;
  const psOut = await run('ps -eo args 2>/dev/null');
  for (const proc of mailConfig.monitored_procs) {
    const running = psOut.includes(proc);
    const wasRunning = procStatus[proc];
    if (wasRunning === undefined) {
      // 首次检查：只记录状态，不发通知
      procStatus[proc] = running;
      initialized.add(proc);
      continue;
    }
    if (!initialized.has(proc)) {
      // 第二次检查：确认首次状态一致后再激活通知
      initialized.add(proc);
      if (wasRunning === running) continue; // 状态一致，跳过
      procStatus[proc] = running; // 状态变了，更新但不发通知（可能是首次误判）
      continue;
    }
    if (wasRunning && !running) {
      await sendMail(`[告警] 进程掉线: ${proc}`, `进程: ${proc}\n状态: 已停止运行\n\n请尽快检查！`);
      procStatus[proc] = false;
    } else if (!wasRunning && running) {
      await sendMail(`[恢复] 进程已恢复: ${proc}`, `进程: ${proc}\n状态: 已恢复运行`);
      procStatus[proc] = true;
    }
  }
}

// ====== Device Status Alerts ======
// 电池电量告警：记录上次发送告警时的电量，用于实现"每下降 1% 发送一次"
// 充电时跳过发送；电量回升到阈值以上后重置记录
let lastBatteryAlertPct = null;

// 带冷却的告警发送
async function sendDeviceAlert(key, subject, body) {
  const cfg = mailConfig.device_alerts;
  const now = Date.now();
  const cooldownMs = (cfg.cooldown || 30) * 60 * 1000;
  const lastAlert = deviceAlertCooldown[key];
  if (lastAlert && (now - lastAlert) < cooldownMs) return; // 冷却中，跳过
  const sent = await sendMail(subject, body);
  if (sent) deviceAlertCooldown[key] = now;
}

export async function checkDeviceAlerts() {
  const cfg = mailConfig.device_alerts;
  if (!mailConfig.enabled || !cfg || !cfg.enabled) return;

  // 采集设备数据
  const [memInfo, diskRaw, batteryRaw, wifiRaw, psAux] = await Promise.all([
    run('cat /proc/meminfo'),
    // 只取 /data 分区（Android 根分区 / 是只读系统分区，100% 是正常的，不需要监控）
    run("df -h | awk '$NF == \"/data\"'"),
    run('termux-battery-status 2>/dev/null'),
    run('termux-wifi-connectioninfo 2>/dev/null'),
    run('ps aux'),
  ]);

  const alerts = [];

  // 1. 电池电量
  if (cfg.battery_low > 0) {
    try {
      const batt = JSON.parse(batteryRaw);
      const pct = batt.percentage ?? batt.level ?? 0;
      const status = (batt.status || '').toUpperCase();
      const plugged = (batt.plugged || '').toUpperCase();
      // 充电中：不发送电量告警（温度告警仍单独处理）
      const charging = status === 'CHARGING' || status === 'FULL' || (plugged !== 'UNPLUGGED' && plugged !== '');
      if (charging) {
        // 充电中重置记录，电量回升后重新开始计数
        lastBatteryAlertPct = null;
      } else if (pct <= cfg.battery_low) {
        // 电量低于阈值：每下降 1% 发送一次
        if (lastBatteryAlertPct === null || pct < lastBatteryAlertPct) {
          lastBatteryAlertPct = pct;
          alerts.push({ key: 'battery_low', subject: `[告警] 电池电量低: ${pct}%`, body: `电池电量: ${pct}%\n阈值: ${cfg.battery_low}%\n状态: ${batt.status}\n温度: ${batt.temperature}°C\n\n请及时充电！` });
        }
      } else {
        // 电量高于阈值：重置记录
        lastBatteryAlertPct = null;
      }
    } catch {}
  }

  // 2. 电池温度
  if (cfg.battery_temp_high > 0) {
    try {
      const batt = JSON.parse(batteryRaw);
      const temp = parseFloat(batt.temperature) || 0;
      if (temp >= cfg.battery_temp_high) {
        alerts.push({ key: 'battery_temp', subject: `[告警] 电池温度过高: ${temp}°C`, body: `电池温度: ${temp}°C\n阈值: ${cfg.battery_temp_high}°C\n电量: ${batt.percentage}%\n\n请检查设备散热！` });
      }
    } catch {}
  }

  // 3. WiFi 信号
  if (cfg.wifi_rssi_weak < 0) {
    try {
      const wifi = JSON.parse(wifiRaw);
      const rssi = wifi.rssi ?? 0;
      if (rssi !== 0 && rssi <= cfg.wifi_rssi_weak) {
        alerts.push({ key: 'wifi_weak', subject: `[告警] WiFi 信号弱: ${rssi}dBm`, body: `WiFi 信号: ${rssi}dBm\n阈值: ${cfg.wifi_rssi_weak}dBm\nIP: ${wifi.ip || '--'}\n速率: ${wifi.link_speed_mbps || 0}Mbps\n\n请检查网络连接！` });
      }
    } catch {}
  }

  // 4. 磁盘使用率 - 逐行解析，找到百分比列（以 % 结尾），避免列索引错位
  if (cfg.disk_usage_high > 0) {
    const lines = diskRaw.trim().split('\n');
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      // 找到百分比列（以 % 结尾的列）
      const pctIdx = cols.findIndex(c => c.endsWith('%'));
      if (pctIdx >= 0) {
        const pct = parseInt(cols[pctIdx]) || 0;
        const mount = cols[cols.length - 1];
        if (pct >= cfg.disk_usage_high) {
          alerts.push({ key: 'disk_high', subject: `[告警] 磁盘空间不足: ${pct}%`, body: `挂载点: ${mount}\n磁盘使用: ${pct}%\n阈值: ${cfg.disk_usage_high}%\n\n请清理磁盘空间！` });
          break; // 只报告第一个超阈值的分区
        }
      }
    }
  }

  // 5. CPU 使用率
  if (cfg.cpu_usage_high > 0) {
    const psLines = psAux.trim().split('\n');
    let cpuSum = 0;
    const cores = 8;
    for (let i = 1; i < psLines.length; i++) {
      const cols = psLines[i].trim().split(/\s+/);
      const val = parseFloat(cols[2]);
      if (!isNaN(val)) cpuSum += val;
    }
    const cpuUsage = Math.round(cpuSum / cores * 10) / 10;
    if (cpuUsage >= cfg.cpu_usage_high) {
      alerts.push({ key: 'cpu_high', subject: `[告警] CPU 使用率过高: ${cpuUsage}%`, body: `CPU 使用率: ${cpuUsage}%\n阈值: ${cfg.cpu_usage_high}%\n核心数: ${cores}\n\n请检查高负载进程！` });
    }
  }

  // 6. 内存使用率
  if (cfg.mem_usage_high > 0) {
    const m = {};
    memInfo.replace(/(\w+):\s+(\d+)/g, (_, k, v) => { m[k] = +v; return ''; });
    const memT = m.MemTotal ? Math.round(m.MemTotal / 1024) : 0;
    const memA = m.MemAvailable ? Math.round(m.MemAvailable / 1024) : 0;
    const memU = memT - memA;
    const memPct = memT ? Math.round(memU / memT * 100) : 0;
    if (memPct >= cfg.mem_usage_high) {
      alerts.push({ key: 'mem_high', subject: `[告警] 内存使用率过高: ${memPct}%`, body: `内存使用: ${memU}MB / ${memT}MB (${memPct}%)\n阈值: ${cfg.mem_usage_high}%\n可用: ${memA}MB\n\n请检查内存占用进程！` });
    }
  }

  // 发送所有告警
  for (const a of alerts) {
    await sendDeviceAlert(a.key, a.subject, a.body);
  }
}

// ====== Proxy Connectivity Check - Helpers ======

/**
 * 获取当前 sing-box 代理节点（Selector 类型的 now 字段）
 */
async function getCurrentNode() {
  const proxies = await fetchJson('http://127.0.0.1:9090/proxies');
  if (proxies && proxies.proxies) {
    for (const [, p] of Object.entries(proxies.proxies)) {
      if (p.now && p.type === 'Selector') {
        return p.now;
      }
    }
  }
  return '';
}

/**
 * 通过 Clash API 切换节点
 */
export async function switchNode(nodeName) {
  const result = await run(`curl -s -X PUT -H 'Content-Type: application/json' -d '{"name":"${nodeName}"}' http://127.0.0.1:9090/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9 2>&1`);
  return !result || !result.includes('error');
}

/**
 * 测试单个 URL 通过代理（带重试）
 */
async function testNodeUrl(url, retryCount, retryDelay) {
  let lastCode = '0';
  let lastLatency = '0';
  let retries = 0;
  // 连通成功的状态码：200/301/302/307/308 正常重定向；401/403 表示能连上但被拒绝访问（代理本身是通的）
  // 403 常见于 ChatGPT 等对特定地区 IP 限制的网站，不代表代理有问题
  const okCodes = new Set([200, 204, 301, 302, 307, 308, 401, 403]);
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const result = await run(`curl -s -o /dev/null -w "%{http_code}:%{time_total}" --proxy http://127.0.0.1:7897 --max-time 10 '${url}' 2>/dev/null`);
    const [code, latency] = result.split(':');
    lastCode = code || '0';
    lastLatency = latency || '0';
    const codeNum = parseInt(lastCode);
    if (okCodes.has(codeNum)) {
      // curl time_total 返回秒，转为毫秒
      return { url, status: codeNum, latency: Math.round((parseFloat(lastLatency) || 0) * 1000), retries };
    }
    retries++;
    if (attempt < retryCount) await new Promise(r => setTimeout(r, retryDelay));
  }
  return { url, status: parseInt(lastCode), latency: Math.round((parseFloat(lastLatency) || 0) * 1000), retries };
}

/**
 * 从日志中获取节点 24h 滚动窗口统计
 * - 使用真正的 24 小时滚动窗口（now - 86400000），不按日历天重置
 * - 例如今天 11:00 与昨天 11:00 之间的数据都视为有效
 * @returns { successCount, totalChecks, avgLatency }
 */
function getNodeStats24h(nodeName) {
  const lines = readLogTail(LOG_PATH, 5000);
  const now = Date.now();
  const dayAgo = now - 86400000;
  let successCount = 0;
  let totalEntries = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.node === nodeName) {
        const t = new Date(entry.timestamp).getTime();
        if (t >= dayAgo && t <= now) {
          totalEntries++;
          if (entry.ok) successCount++;
          if (entry.urls) {
            for (const u of entry.urls) {
              if (u.latency > 0) {
                latencySum += u.latency;
                latencyCount++;
              }
            }
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return {
    successCount,
    totalChecks: totalEntries,
    avgLatency: latencyCount > 0 ? latencySum / latencyCount : 0,
  };
}

/**
 * 计算节点权重
 * Weight = (isCandidate ? 0.5 : 0) + (connectivityRate * 0.3) + (latencyScore * 0.2)
 * connectivityRate = successCount / totalChecks (基于 24 小时滚动窗口)
 * latencyScore = max(0, 1 - avgLatency / 2000)
 */
export function calculateNodeWeight(nodeName, candidates, stats24h) {
  const isCandidate = candidates.includes(nodeName) ? 0.5 : 0;
  const stats = stats24h[nodeName] || { successCount: 0, totalChecks: 0, avgLatency: 0 };
  const connectivityRate = stats.totalChecks > 0 ? stats.successCount / stats.totalChecks : 0;
  const latencyScore = Math.max(0, 1 - (stats.avgLatency || 0) / 2000);
  return isCandidate + (connectivityRate * 0.3) + (latencyScore * 0.2);
}

/**
 * 获取所有候选节点的权重列表（供前端排序展示）
 */
export function getNodeWeights() {
  const cfg = mailConfig.proxy_check || {};
  const candidates = cfg.candidate_nodes || [];
  const stats24h = {};
  for (const node of candidates) {
    stats24h[node] = getNodeStats24h(node);
  }
  return candidates.map(node => ({
    node,
    weight: calculateNodeWeight(node, candidates, stats24h),
    stats: stats24h[node],
  })).sort((a, b) => b.weight - a.weight);
}

// ====== Detection Log Soft Delete ======
// 软删除方案：不真正删除日志文件内容，而是把要隐藏的条目 timestamp 记录到单独文件
// 读取日志时过滤掉已标记的 timestamp，实现"已删除"效果

/**
 * 获取已删除的 timestamp 集合（用于日志读取时过滤）
 * @returns {Set<string>}
 */
export function getDeletedTimestamps() {
  return new Set(loadJSON(DELETED_LOG_FILE, []));
}

/**
 * 标记指定节点的所有日志条目为已删除（软删除）
 * @param {string} nodeName 节点名
 * @returns {number} 标记删除的条目数
 */
export function markNodeLogsDeleted(nodeName) {
  if (!nodeName) return 0;
  const lines = readLogTail(LOG_PATH, 5000);
  const deletedSet = getDeletedTimestamps();
  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.node === nodeName && entry.timestamp && !deletedSet.has(entry.timestamp)) {
        deletedSet.add(entry.timestamp);
        count++;
      }
    } catch { /* skip malformed lines */ }
  }
  if (count > 0) saveJSON(DELETED_LOG_FILE, [...deletedSet]);
  return count;
}

// ====== Main Proxy Check ======

/**
 * 运行完整的代理检查周期
 * 1. 获取当前节点
 * 2. 依次测试每个候选节点（切换 → 等待 → 测速 → 记录）
 * 3. 恢复当前节点
 * 4. 如果当前节点不 OK，按权重选择最佳候选节点切换
 *
 * @returns { ok, current_node, all_ok, switched, details, timestamp }
 */
export async function runProxyCheck(force = false) {
  const cfg = mailConfig.proxy_check;
  if (!cfg || (!cfg.enabled && !force)) {
    return { ok: false, error: '代理检测未启用（需在配置中启用或勾选自动检测）', current_node: '', all_ok: false, switched: false, details: [], timestamp: new Date().toISOString() };
  }

  const testUrls = cfg.test_urls || ['https://www.google.com'];
  const retryCount = cfg.retry_count ?? 2;
  const retryDelay = cfg.retry_delay ?? 3000;
  const candidates = cfg.candidate_nodes || [];

  const currentNode = await getCurrentNode();
  if (!currentNode) {
    return { ok: false, error: '无法获取当前节点（sing-box 可能未运行）', current_node: '', all_ok: false, switched: false, details: [], timestamp: new Date().toISOString() };
  }

  // ★展开地区候选（F102）：candidate_nodes 支持 "region:<关键词>" 形态（如 region:日本）。
  //   运行时把所有地区条目展开为当前 Clash API 节点列表里的实际节点（按名称包含关键词匹配），
  //   并排除 excludedSubscriptions 里命中的订阅前缀（tag 形如 "<订阅名>_<节点名>"）。
  //   好处：上游节点名变化（区02→区05、后缀变化）不影响候选有效性；地区作为稳定锚点。
  const expandCandidates = (cands, allNodes) => {
    const excluded = (cfg.excluded_subscriptions || []).map(s => String(s).trim()).filter(Boolean);
    const isExcluded = (tag) => excluded.some(name => tag === name || tag.startsWith(name + '_'));
    const out = [];
    const seen = new Set();
    for (const c of cands) {
      const entry = String(c || '').trim();
      if (!entry) continue;
      if (entry.startsWith('region:')) {
        const kw = entry.slice(7).trim();
        if (!kw) continue;
        for (const n of allNodes) {
          if (n.includes(kw) && !isExcluded(n) && !seen.has(n)) { seen.add(n); out.push(n); }
        }
      } else if (!isExcluded(entry) && !seen.has(entry)) {
        seen.add(entry); out.push(entry);   // 具名候选也做排除过滤（防手工选到被排除订阅的节点）
      }
    }
    return out;
  };

  // 取当前全部节点名（Clash API）；失败则退化为纯具名候选
  let allNodeNames = [];
  try {
    const px = await fetchJson('http://127.0.0.1:9090/proxies');
    const sel = px && px.proxies && Object.values(px.proxies).find(p => p.type === 'Selector' && p.all);
    allNodeNames = sel ? sel.all : [];
  } catch {}
  const nodesToTest = expandCandidates(candidates, allNodeNames);
  if (nodesToTest.length === 0) {
    return { ok: false, error: '候选节点展开后为空（检查 region 关键词/排除订阅配置）', current_node: currentNode, all_ok: false, switched: false, details: [], timestamp: new Date().toISOString() };
  }

  // 写入检测开始日志（让前端能实时看到进度）
  writeLog(LOG_PATH, JSON.stringify({
    timestamp: new Date().toISOString(),
    node: '__start__',
    urls: [],
    ok: false,
    retry_count: 0,
    switched: false,
    progress: `开始串行检测 ${nodesToTest.length} 个节点`,
  }));

  let allOk = true;
  let completed = 0;

  // 串行检测：逐个切换节点，用 curl --proxy 测试（流量经过 7897 入站，计入代理流量曲线）
  // 同一节点内 URL 可并发（走同一 selector），单 URL 的重试串行
  const details = [];
  for (const node of nodesToTest) {
    // 切换到该节点
    await switchNode(node);

    const nodeDetails = { node, urls: [], ok: true, delay: 0 };

    // 该节点内：URL 并发检测（都走当前 selector），单 URL 重试串行
    nodeDetails.urls = await Promise.all(
      testUrls.map(url => testNodeUrl(url, retryCount, retryDelay))
    );

    // 判断节点是否可用：至少一个 URL 返回成功状态码（与 testNodeUrl 的 okCodes 一致）
    const okCodes = new Set([200, 204, 301, 302, 307, 308, 401, 403]);
    const firstOk = nodeDetails.urls.find(r => okCodes.has(r.status));
    if (firstOk) {
      nodeDetails.delay = firstOk.latency;
    } else {
      nodeDetails.ok = false;
    }

    completed++;
    // 每个节点检测完立即写日志（实时反馈进度）
    writeLog(LOG_PATH, JSON.stringify({
      timestamp: new Date().toISOString(),
      node,
      urls: nodeDetails.urls,
      ok: nodeDetails.ok,
      delay: nodeDetails.delay,
      retry_count: retryCount,
      switched: false,
      progress: `检测中 ${completed}/${nodesToTest.length}`,
    }));

    details.push(nodeDetails);
  }

  for (const d of details) {
    if (!d.ok) allOk = false;
  }

  // 写入检测完成日志
  writeLog(LOG_PATH, JSON.stringify({
    timestamp: new Date().toISOString(),
    node: '__done__',
    urls: [],
    ok: allOk,
    retry_count: retryCount,
    switched: false,
    progress: `检测完成 ${details.filter(d => d.ok).length}/${details.length} 节点正常`,
  }));

  // 检测完成后：根据当前节点状态决定是否切换
  // 注意：串行检测过程中已切换到最后一个测试节点，必须显式切回/切到目标节点
  // 三种情况：
  //   A. 当前节点在候选列表且正常 → 切回原节点（不无谓切换）
  //   B. 当前节点在候选列表但失败 → 切到最佳候选节点
  //   C. 当前节点不在候选列表（如外部手动切换的美国1）→ 切到最佳候选节点
  //      （候选列表是用户明确要用的节点，非候选节点应被纠正）
  const currentInCandidates = candidates.includes(currentNode);
  let currentOk = true;
  let currentDetail = null;
  if (currentInCandidates) {
    currentDetail = details.find(d => d.node === currentNode);
    currentOk = currentDetail ? currentDetail.ok : true;
  }

  // ------ 节点切换决策日志（每次检测都记录完整上下文） ------
  const passingNodes = details.filter(d => d.ok).map(d => d.node);
  const failingNodes = details.filter(d => !d.ok).map(d => d.node);
  const switchLogEntry = {
    timestamp: new Date().toISOString(),
    current_node: currentNode,
    current_in_candidates: currentInCandidates,
    current_ok: currentOk,
    candidate_count: nodesToTest.length,
    passing: passingNodes,
    failing: failingNodes,
  };

  let switched = false;
  if (currentInCandidates && currentOk) {
    // 情况 A：当前节点在候选列表且正常 → 切回原节点
    await switchNode(currentNode);
    switchLogEntry.decision = 'A_keep_current';
    switchLogEntry.reason = '当前节点在候选列表且正常，无需切换';
  } else {
    // 情况 B/C：当前节点失败或不在候选列表 → 切到最佳候选节点
    if (passingNodes.length > 0) {
      const stats24h = {};
      for (const node of nodesToTest) {
        stats24h[node] = getNodeStats24h(node);
      }

      let bestNode = passingNodes[0];
      let bestWeight = -1;
      const allWeights = {};
      for (const node of passingNodes) {
        const w = calculateNodeWeight(node, candidates, stats24h);
        allWeights[node] = w;
        if (w > bestWeight) {
          bestWeight = w;
          bestNode = node;
        }
      }

      await switchNode(bestNode);
      switched = true;

      // 详细切换日志
      switchLogEntry.decision = currentInCandidates ? 'B_switch_failed' : 'C_switch_non_candidate';
      switchLogEntry.reason = currentInCandidates
        ? `原节点 ${currentNode} 连通性失败 → 切换到最佳候选节点 ${bestNode}`
        : `当前节点 ${currentNode} 不在候选列表中 → 纠正到最佳候选节点 ${bestNode}`;
      switchLogEntry.new_node = bestNode;
      switchLogEntry.best_weight = bestWeight;
      switchLogEntry.all_weights = allWeights;

      // 仅在原节点失败时发切换通知邮件（非候选节点切回候选不发邮件，避免噪音）
      if (currentInCandidates && !currentOk) {
        await sendMail(
          `[通知] 代理节点已自动切换`,
          `原节点: ${currentNode}\n新节点: ${bestNode}\n权重评分: ${bestWeight.toFixed(3)}\n原因: 当前节点连通性检测失败`
        );
      } else if (!currentInCandidates) {
        // 非候选节点切回候选节点：记录日志但不发邮件（用户知道的预期行为）
        switchLogEntry.mail_skipped = true;
        switchLogEntry.mail_skip_reason = '非候选→候选切换，按设计不发送邮件';
      }
    } else {
      // 所有候选节点都失败，切回原节点保持现状
      await switchNode(currentNode);
      switchLogEntry.decision = 'D_all_failed';
      switchLogEntry.reason = `所有 ${nodesToTest.length} 个候选节点均失效，切回原节点 ${currentNode}`;
      // 注意：候选节点失效不再在此单独发邮件（会与 checkProxy 的"连通性异常"重复发两封）。
      // 统一由 checkProxy() 结合状态机一次性发送，一个事件只发一封。
      // ★失败触发订阅刷新（F102）：连续 D_all_failed 达 refresh_after_failures 次时，
      //   自动刷新全部订阅并重启 sing-box；连续失败 ≥ refresh_after_failures + 3 次则熔断停止，发邮件告警。
      try {
        const rf = cfg.refresh_on_all_failed || {};
        if (rf.enabled) {
          const threshold = Math.max(1, Number(rf.after_failures) || 3);
          const maxRefresh = 3; // 刷新也救不回来的次数上限（每次刷新后仍 D_all_failed 计一次）
          const st = loadJSON(DATA_DIR + '/proxy_refresh_state.json', { failStreak: 0, refreshCount: 0 });
          st.failStreak = (st.failStreak || 0) + 1;
          if (st.failStreak >= threshold && st.refreshCount < maxRefresh) {
            st.refreshCount = (st.refreshCount || 0) + 1;
            saveJSON(DATA_DIR + '/proxy_refresh_state.json', st);
            writeLog(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), node: '__refresh__', urls: [], ok: false, retry_count: 0, switched: false, progress: `连续失败 ${st.failStreak} 次 → 第 ${st.refreshCount}/${maxRefresh} 次自动刷新订阅` }));
            const { regenerateConfig } = await import('./subscription.js');
            const count = await regenerateConfig(null);   // 全部订阅重新下载 + 重启 sing-box
            switchLogEntry.subscription_refreshed = true;
            switchLogEntry.refresh_round = `${st.refreshCount}/${maxRefresh}`;
            switchLogEntry.refresh_node_count = count;
            st.failStreak = 0;   // 刷新后重置连败计数（下一轮 D_all_failed 重新累计）
            saveJSON(DATA_DIR + '/proxy_refresh_state.json', st);
            await sendMail(`[动作] 连续检测失败，已自动刷新订阅（第 ${st.refreshCount}/${maxRefresh} 次）`, `全部候选节点连续失效 ${threshold} 次后触发订阅刷新。\n重新加载节点数: ${count}\n若本轮刷新后仍全部失效，将继续自动刷新；累计 ${maxRefresh} 次无效后将停止并告警。`);
          } else if (st.refreshCount >= maxRefresh) {
            // 熔断：刷新次数用尽仍失败 → 停止刷新，只告警一次（用 failStreak 增量避免重复发）
            if (st.failStreak === threshold + maxRefresh) {   // 只在越过阈值那一刻发一次
              await sendMail(`[告警] 代理候选全部失效且自动刷新无效`, `已自动刷新订阅 ${maxRefresh} 次仍全部候选失效，停止自动刷新。\n请人工检查订阅链接/机场状态。\n当前节点: ${currentNode}`);
            }
            saveJSON(DATA_DIR + '/proxy_refresh_state.json', st);
          } else {
            saveJSON(DATA_DIR + '/proxy_refresh_state.json', st);
          }
        }
      } catch (e) {
        writeLog(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), node: '__refresh_error__', urls: [], ok: false, retry_count: 0, switched: false, progress: '订阅刷新异常: ' + e.message }));
      }
    }
  }

  // 每次都写入切换决策日志
  writeLog(SWITCH_LOG_PATH, JSON.stringify(switchLogEntry));

  // 只要至少有一个候选节点可用，代理就算正常；全部失效才算异常
  const anyCandidateWorking = details.some(d => d.ok);
  return {
    ok: anyCandidateWorking,
    current_node: currentNode,
    all_ok: allOk,
    switched,
    details,
    timestamp: new Date().toISOString(),
  };
}

// 代理连通性通知状态持久化文件。
// 用磁盘状态做跨进程、跨重启去重：多实例或进程重启时，同一异常事件也只发一封邮件。
const PROXY_NOTIFY_STATE_FILE = DATA_DIR + '/proxy_notify_state.json';

/**
 * 读取代理通知持久化状态
 * @returns {{ seen_ok: boolean, alerted: boolean, last_fail_at: number }}
 * - seen_ok: 是否曾确认过代理连通（作为异常告警的基线，避免"启动即异常"误报）
 * - alerted: 当前是否处于"已发异常通知"状态（异常持续期间保持 true，收到恢复后置 false）
 * - last_fail_at: 最近一次发异常通知的时间戳（多实例并发时用作时间窗去重兜底）
 */
function loadProxyNotifyState() {
  const st = loadJSON(PROXY_NOTIFY_STATE_FILE, null) || {};
  return { seen_ok: !!st.seen_ok, alerted: !!st.alerted, last_fail_at: st.last_fail_at || 0 };
}
function saveProxyNotifyState(st) {
  saveJSON(PROXY_NOTIFY_STATE_FILE, { seen_ok: !!st.seen_ok, alerted: !!st.alerted, last_fail_at: st.last_fail_at || 0 });
}

/**
 * 订阅定时自动刷新（F102）：按配置的间隔分钟数刷新全部订阅并重启 sing-box。
 * 配置（mail_config.proxy_check.subscription_refresh）：
 *   enabled: false        开关（默认关）
 *   interval_minutes: 180 刷新间隔（分钟）
 * 状态落盘 proxy_subrefresh_state.json：{ lastRefreshAt }（跨重启计时）
 * 选择器保持：regenerateConfig 内部已实现「保留当前选中节点」，刷新不会改变用户正在用的节点。
 */
async function autoRefreshSubscriptions() {
  const cfg = mailConfig.proxy_check;
  const rc = cfg && cfg.subscription_refresh;
  if (!rc || !rc.enabled) return;
  const intervalMs = Math.max(5, Number(rc.interval_minutes) || 180) * 60 * 1000;
  const st = loadJSON(DATA_DIR + '/proxy_subrefresh_state.json', { lastRefreshAt: 0 });
  if (Date.now() - (st.lastRefreshAt || 0) < intervalMs) return;
  try {
    const { regenerateConfig } = await import('./subscription.js');
    const count = await regenerateConfig(null);
    st.lastRefreshAt = Date.now();
    saveJSON(DATA_DIR + '/proxy_subrefresh_state.json', st);
    writeLog(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), node: '__sub_refresh__', urls: [], ok: true, retry_count: 0, switched: false, progress: `定时刷新订阅完成: ${count} 节点` }));
  } catch (e) {
    writeLog(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), node: '__sub_refresh__', urls: [], ok: false, retry_count: 0, switched: false, progress: '定时刷新订阅失败: ' + e.message }));
  }
}

/**
 * 代理连通性检查（定时任务调用）
 * 包装 runProxyCheck()，用持久化状态做状态机去重：
 * - 仅"正常→异常"跳变发一封异常、仅"异常→恢复"跳变发一封恢复
 * - 状态跨进程/跨重启持久化，保证同一异常事件（含多实例并行）只发一封
 * - 启动时未确认过连通（seen_ok=false）不发异常，避免启动时序误报
 */
export async function checkProxy() {
  const cfg = mailConfig.proxy_check;
  if (!cfg || !cfg.enabled) return;

  const result = await runProxyCheck();
  const ok = result.ok;

  const st = loadProxyNotifyState();

  if (ok) {
    // 本次连通正常：若之前处于"已告警"，则发送一次恢复通知
    if (st.alerted) {
      await sendMail(`[恢复] 代理已恢复连通`, `当前节点: ${result.current_node || '未知'}\n状态: 代理已恢复连通`);
    }
    st.seen_ok = true;   // 已确认连通，之后异常可判定为真实异常
    st.alerted = false;
    st.last_fail_at = 0;
    saveProxyNotifyState(st);
    procStatus['__proxy__'] = true;
    // 恢复连通时同步清零「失败触发刷新」状态（F102）
    const rfSt = loadJSON(DATA_DIR + '/proxy_refresh_state.json', null);
    if (rfSt && (rfSt.failStreak || rfSt.refreshCount)) saveJSON(DATA_DIR + '/proxy_refresh_state.json', { failStreak: 0, refreshCount: 0 });
  } else {
    // 本次连通异常：仅当确认过基线 + 未处于告警 + 距上次告警超过一个检测周期 才发一封
    const intervalMs = (cfg.check_interval || 10) * 60 * 1000;
    const recentlyAlerted = st.last_fail_at > 0 && (Date.now() - st.last_fail_at) < intervalMs;
    if (st.seen_ok && !st.alerted && !recentlyAlerted) {
      const okCount = result.details ? result.details.filter(d => d.ok).length : 0;
      const total = result.details ? result.details.length : 0;
      const failingNodes = result.details ? result.details.filter(d => !d.ok).map(d => d.node).join(', ') : '';
      await sendMail(
        `[告警] 代理连通性异常`,
        `当前节点: ${result.current_node || '未知'}\n` +
        `可用节点: ${okCount}/${total}\n` +
        (failingNodes ? `失效候选节点: ${failingNodes}\n` : '') +
        `\nsing-box 代理可能已失效（候选节点均无法连通），请检查节点可用性或订阅配置！`
      );
      st.last_fail_at = Date.now();
    }
    st.alerted = true;
    saveProxyNotifyState(st);
    procStatus['__proxy__'] = false;
  }
}

// ====== 动态间隔的定时检查（每次读取最新配置） ======
async function runScheduledCheck() {
  let nextInterval;
  try {
    await checkProcs();
    await checkProxy();
    await checkDeviceAlerts();
    await autoRefreshSubscriptions();
    nextInterval = (mailConfig.proxy_check?.check_interval || 10) * 60 * 1000;
  } catch (err) {
    // **关键保护**：如果任何检查组件抛出未捕获异常，调度链不会断裂
    nextInterval = (mailConfig.proxy_check?.check_interval || 10) * 60 * 1000;
    const errorMsg = `${new Date().toISOString()} 调度异常 | ${err.message} | stack: ${(err.stack || '').split('\n').slice(0, 3).join(' <- ')}`;
    try {
      writeLog(SCHEDULER_LOG_PATH, errorMsg);
    } catch {}
    try {
      writeFileSync(HOME + '/.monitor_data/crash.log',
        `[scheduler] ${errorMsg}\n`, { flag: 'a' }
      );
    } catch {}
  }
  setTimeout(runScheduledCheck, nextInterval);
}

// 巡检调度器启动标志 + 显式启动入口。
// ★拆模块后（方案 B）：本模块会被多个进程 import（core 主进程、checkin 进程只用 sendMail），
//   import 副作用会在每个进程都拉起巡检调度器 → 双份告警邮件。改为由入口进程显式调用。
let schedulerStarted = false;
export function startNotifyScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  writeLog(SCHEDULER_LOG_PATH, `${new Date().toISOString()} 调度器启动 | checkProcs + checkProxy + checkDeviceAlerts`);
  runScheduledCheck();
  // 延迟 30 秒后执行第一次进程检查
  setTimeout(checkProcs, 30000);
}

// 重置进程状态（配置保存时调用）
export function resetProcStatus() {
  Object.keys(procStatus).forEach(k => delete procStatus[k]);
  initialized.clear();
}
