# AGENT.md — Honor10 Monitor 系统维护手册

> 目标读者：后续接手此项目的 AI / 开发者。读完本文你应该能理解整个监控系统的运行机制、已知陷阱和 2026-08 的修复内容。

---

## 一、项目概览

```
Honor 10/                         # 部署工具
└── monitor/                      # 监控系统主体
    ├── server.js                 # HTTP 服务 (端口 3081)
    ├── lib/
    │   ├── notify.js             # ★ 核心：邮件通知 + 代理检测 + 节点自动切换 + 调度器
    │   ├── utils.js              # 工具函数 (SSH、配置、进程管理)
    │   ├── actions.js            # 动作执行 (重启服务)
    │   ├── logger.js             # 日志写入 + 按日轮转 (writeLog, readLogTail)
    │   ├── metrics.js            # 系统指标采集
    │   ├── recorder.js           # 流量记录
    │   ├── subscription.js       # 订阅解析
    │   ├── checkin/              # ★ vendor 自 AutoCheckinTrae（零依赖）
    │   │   ├── checkin.js        #   CheckinClient（签到核心）
    │   │   └── scheduler.js      #   startScheduler / nextTriggerMs
    │   ├── providers/            # ★ Provider 抽象层（多平台签到）
    │   │   ├── index.js          #   注册中心 registerProvider/getProvider
    │   │   └── trae.js           #   Trae provider（第一个，schema 驱动前端表单）
    │   ├── tasks/index.js        # ★ 任务调度中心（统一调度所有 provider）
    │   └── checkin-log.js        # ★ 30 天滚动签到日志
    └── frontend/                 # Cloudflare Pages 前端
```

**运行环境**：Android Termux (Honor10 手机)，Node.js HTTP 服务，无额外依赖。

**外部依赖**：
- sing-box (端口 9090 Clash API / 7890 代理) — 提供节点管理和代理出站
- cloudflared tunnel — 连接 Cloudflare 边缘网络
- SMTP 服务器 — 发送告警邮件

---

## 二、代理节点切换机制（notify.js 核心逻辑）

### 2.1 调度器

```javascript
// runScheduledCheck() — setTimeout 链式调度（notify.js 末尾）
async function runScheduledCheck() {
  try {
    await checkProcs();          // 进程监控
    await checkProxy();          // ★ 代理检测 + 节点切换
    await checkDeviceAlerts();   // 设备告警
  } catch (err) {
    // ★ 2026-08 修复：try/catch 保护，异常不断链
    writeLog(SCHEDULER_LOG_PATH, errorMsg);
  }
  const interval = (mailConfig.proxy_check?.check_interval || 10) * 60 * 1000;
  setTimeout(runScheduledCheck, interval);
}
```

**关键点**：调度间隔由 `proxy_check.check_interval` 控制（默认 10 分钟，前端可设）。

### 2.2 检测与切换流程

```
checkProxy()
  └─ runProxyCheck()
       ├─ 获取当前 selector 指向的节点 (currentNode)
       ├─ 读取 candidate_nodes（用户选中的候选节点）
       ├─ 串行测试候选节点连通性（切换 → 检测 → 记录延迟/成功/失败）
       ├─ 按权重算法选择最佳可用候选节点
       └─ 切换决策（4 种）：
           A: 当前节点在候选列表且正常     → 保持不动
           B: 当前节点在候选列表但失败     → 切到最佳候选（不发实时邮件，v1.0.47 起统一进日报统计）
           C: 当前节点不在候选列表         → 纠正到最佳候选（不发邮件）
           D: 所有候选节点都失败           → 切回原节点 + 发告警邮件
```

### 2.3 权重算法

| 因子 | 权重 | 说明 |
|------|------|------|
| 用户选中 | 0.5 | 候选节点统一加 0.5 |
| 近 24h 连通率 | 0.3 | 成功次数 / 总检测次数 |
| 平均延迟 | 0.2 | `max(0, 1 - latency/2000)` |

---

## 三、2026-08-11 修复记录（第 2 次修复）

### 背景

2026-07-29 第一次修复（"重启后恢复节点"）：当时发现 sing-box 重启后 selector 被重置为配置文件 `sb-config.json` 的 `default` 值（通常是 "美国 1｜联通电信推荐"），导致切出候选节点。修复方法是让 proxy_check 检测后自动纠正。

但 2026-08-11 再次出现问题：节点又切到了"美国 1"且无邮件通知。

### 根因分析（两层问题）

**Bug 1 — 调度器静默死亡**（最严重）：

`checkProcs()` 或 `checkProxy()` 中任何一个 `await` 抛出未捕获异常，`setTimeout` 永远不再被调用，整个调度链静默停止。

证据：远程 `proxy_check.log` 的 `last_check` 停在 2026-08-07 14:45，之后 4 天无任何检测。`sb-config.json` 于 2026-08-11 16:33 被 `subscriber.sh` 刷新，sing-box 重启后 default 切到"美国 1"（非候选节点），但 proxy_check 已死，无法纠正。

**Bug 2 — `result.ok` 逻辑错误**（第一次修复遗漏）：

`runProxyCheck()` 返回的 `result.ok` 使用 `currentOk || switched`。当当前节点不在候选列表时，`currentOk` 默认为 `true` 且不会被覆盖，导致即使所有候选节点都失败，`ok` 仍为 `true`。`checkProxy()` 拿到 `ok=true` 认为一切正常，不发邮件。

### 修复内容

1. **调度器 try/catch 保护**（notify.js 末尾）：
   - `runScheduledCheck()` 内部所有 await 包裹在 try/catch 中
   - 异常写入 `scheduler.log` 和 `crash.log`
   - **调度链永不中断**

2. **result.ok 修正**（notify.js 第 599-602 行）：
   ```
   旧：ok: currentOk || switched
   新：ok: details.some(d => d.ok)  // 有任何候选节点可用就算 ok
   ```

3. **情况 D 增加邮件告警**（notify.js 第 583-592 行）：
   - 所有候选节点失效时，`sendMail("[告警] 所有候选节点均已失效", ...)`

---

## 四、2026-08-11 新增日志

为方便下次排查，新增三类日志：

| 日志文件 | 内容 | 用途 |
|----------|------|------|
| `~/logs/monitor/scheduler.log` | 调度器启动、每次异常信息 | 判断调度器是否活着 |
| `~/logs/monitor/node_switch.log` | 每次检测的完整决策上下文 (JSON) | 复现切换决策过程 |
| `~/logs/monitor/proxy_check.log` | （已有）每次检测的 URL 级结果 | 连通性详情 |

**node_switch.log 格式示例**：
```json
{
  "timestamp": "2026-08-11T09:05:36.049Z",
  "current_node": "美国 1｜联通电信推荐",
  "current_in_candidates": false,
  "current_ok": true,
  "candidate_count": 6,
  "passing": ["日本 02", "香港 03", ...],
  "failing": [],
  "decision": "C_switch_non_candidate",
  "reason": "当前节点 美国1 不在候选列表中 → 纠正到最佳候选节点 日本 02",
  "new_node": "日本 02",
  "best_weight": 0.924575,
  "all_weights": { "日本 02": 0.925, ... }
}
```

---

## 五、2026-08-18 修复记录（第 3 次修复：DNS 根因）

### 背景

2026-08-18 排查"sign 所有节点均失效"：`proxy_check.log` 里 google/chatgpt 全部失败，sing-box 日志大量 `lookup *.nekohub.xyz: empty result`、`connection refused`、`context deadline exceeded`。手机 VPN 实测正常（排除网络/代理链路问题），定位为 **sing-box 内部 DNS 解析故障**。

### 根因（两层）

1. **DoH 服务器返回陈旧/空结果**：原配置 `https://1.12.12.12/dns-query` 对节点域名返回了**迁移前的陈旧 IP**（hkt1→59.153.167.132、hkt2→117.55.193.146），导致 hysteria2 节点 UDP `connection refused`；对 `cf-no.nekohub.xyz` 直接返回**空**，VLESS 节点 `empty result` 无法连接。对照组实测：`223.5.5.5` / `114.114.114.114` 均返回正确 IP（hkt1→58.152.130.173、hkt2→112.120.213.169、cf-no→104.25.48.230/104.27.85.235）。

2. **DoH 用域名地址触发"鸡生蛋"**：中途把 DoH 换成 `https://dns.alidns.com/dns-query` 后，sing-box 需先解析 `dns.alidns.com` 域名本身才能发起 DoH 请求，但内部引导解析一直 `lookup dns.alidns.com: context deadline exceeded`（即使加了 `detour:direct`）。curl 能通是因为走系统解析，sing-box 内部走的是自己的 DNS 栈。

### 修复

改用 **IP 直连 DoH**，彻底免去域名引导解析，并保留 `detour:direct` 防止 DNS 请求打回代理造成环路：

```json
{
  "servers": [
    { "tag": "dns", "address": "https://223.5.5.5/dns-query", "detour": "direct" },
    { "tag": "local", "address": "223.5.5.5" }
  ]
}
```

- 修改脚本：项目根目录 `fix_dns.py`（改地址 → 校验 JSON → `sv restart sing-box`）
- 诊断脚本：`diag_dns_servers.py`（对比 IP-DoH / 域名-DoH / UDP DNS 对节点域名的解析结果）
- 原配置备份：`/data/data/com.termux/files/home/sb-config.json.bak_dnsfix2`

> **持久性**：`monitor/lib/subscription.js` 的 `generateSbConfig()` 用 `dns: existing.dns` 保留现有 DNS 段（约第 347 行），订阅刷新（subscriber 每 30 分钟）不会覆盖此修复。

### 验证

- 代理访问 google/cloudflare → 204（0.2s 级）
- monitor 节点健康检测 6/6 全部正常
- 多节点延迟：香港 166ms、新加坡 202ms、日本 336ms、美国 1205ms
- `POST /api/checkin/run-all` 两账号 `ok:true`（credits 200）
- sing-box 日志无 ERROR

### 运维提醒

- 节点全挂时**先查 sing-box DNS 段**（`grep -A4 dns ~/sb-config.json`），再用 `diag_dns_servers.py` 对比各 DoH 的解析结果
- DoH 地址务必用 **IP**（如 `https://223.5.5.5/dns-query`、`https://119.29.29.29/dns-query`），不要用域名，避免引导解析死循环；`detour:direct` 必须保留
- 不同 DoH 对同一域名可能返回不同结果（存在缓存/陈旧记录），切换后以 `curl` 实际解析为准

### 补充（2026-08-18）：DNS 模式开关

> 域名 DoH 存在"引导解析依赖"，会时好时坏（新专线节点 `.byteprivatelink.com` / `.smartprivatelink.com` 曾因此失联）。为此实现**前端 DNS 模式开关**，避免再反复手改配置：

- 预设两种模式（`monitor/lib/subscription.js` 的 `DNS_PRESETS`）：
  - `ip`（默认/推荐）：`https://223.5.5.5/dns-query` IP 直连，免域名引导解析，最稳定
  - `domain`（备用）：`https://dns.alidns.com/dns-query` 域名 DoH，需先引导解析域名
- 两种模式的 `local` 服务器均保留 `detour:direct`（防 loopback），DNS rules 均包含新旧节点域名
- 持久化：`~/.monitor_data/dns_config.json` 存 `{ "mode": "ip" | "domain" }`
- API：`GET/POST /api/dns-config`（POST 需传 `{ "mode": ... }`，会写入 sb-config.json 的 dns 段并重启 sing-box）
- 前端：订阅页新增「DNS 解析模式」卡片，选中后点「应用 DNS 模式」
- `generateSbConfig()` 优先使用已保存的 DNS 模式生成 dns 段；未配置过则保留现有配置
- 运维：节点时好时坏时先在订阅页切换 DNS 模式，避免手动改配置

### 补充（2026-08-19）：代理通知去重

> 修复"同一异常事件收到两封邮件 / 恢复成功连发多次"：
>
> 1. **合并通知**：原候选节点全失效（`runProxyCheck`）和代理连通性异常（`checkProxy`）各发一封，实际是一个事件。现删除 `runProxyCheck` 内 `D_all_failed` 分支的邮件，候选失效信息统一并入 `checkProxy` 的「[告警] 代理连通性异常」一封（邮件里带 `失效候选节点` 列表）。
> 2. **状态机去重**：`checkProxy` 按 `procStatus['__proxy__']` 状态跳变判断，仅「正常→异常」发一封异常、「异常→恢复」发一封恢复，状态持续期间一律不发，保证同一事件不连续发送。
> 3. **修复首检 bug**：原首次检查仅在 `ok=true` 时初始化，`ok=false` 时状态永远为 undefined，导致后续状态跟踪错乱。现首检无论结果都初始化（但不发通知），确保之后能可靠且不重复地触发。

### 补充（2026-08-20）：状态持久化去重（跨进程/跨重启）

> 背景：08-19 的状态机把「已告警」状态放在**进程内内存** `procStatus['__proxy__']`，一旦 monitor 进程重启或出现多实例（crash.log 里多次 `EADDRINUSE` 即历史双开证据），内存状态即丢失。scheduler.log 显示今天进程重启了 5 次，叠加代理不稳定窗口，导致同一异常事件又连发多封「连通性异常」邮件（用户实测 18/16/15 分钟前各 2/2/4 封）。
>
> 修复：`notify.js` 把代理通知状态持久化到 `~/.monitor_data/proxy_notify_state.json`，用磁盘状态做去重，跨进程/跨重启同一异常事件只发一封：
> - `seen_ok`：是否曾确认连通（异常告警的可靠基线，避免「启动即异常」误报）。
> - `alerted`：当前是否处于「已发异常通知」状态；异常持续期间保持 `true`，收到恢复才置 `false`。
> - `last_fail_at`：最近一次发异常通知的时间戳，作多实例并发的时间窗兜底（小于 `check_interval` 不重复发）。
> - 判断逻辑：仅当 `seen_ok && !alerted && 距上次告警>=check_interval` 才发「异常」，且仅在 `alerted` 为真且本次正常时才发「恢复」。
> - `resetProcStatus()`（配置保存时调用）不清除该持久化文件，避免失效期间保存配置导致重新告警。
>
> 运维：清空去重状态可删除 `~/.monitor_data/proxy_notify_state.json` 后重启 monitor（不推荐，除非想立即重发一次异常）。

---

## 六、运维要点

### 6.1 排查"节点异常"的标准流程

1. **看调度器是否活着**：`cat ~/logs/monitor/scheduler.log`
2. **看最近切换决策**：`tail -20 ~/logs/monitor/node_switch.log`
3. **看连通性详情**：`tail -20 ~/logs/monitor/proxy_check.log`
4. **看当前 selector 值**：`curl -s http://127.0.0.1:9090/proxies | python3 -c "..."`（见下方命令）
5. **看 sing-box 配置的 default**：`grep default ~/sb-config.json`
6. **全节点同时失效时优先查 DNS**：`grep -A6 '"dns"' ~/sb-config.json`，并用 `diag_dns_servers.py` 对比各 DoH 对节点域名的解析结果（见第五节运维提醒）

### 6.2 常用远程命令

```bash
# 查看当前节点
curl -s --max-time 3 http://127.0.0.1:9090/proxies | python3 -c "
import sys,json
d=json.load(sys.stdin)
for n,p in d.get('proxies',{}).items():
    if p.get('type')=='Selector' and p.get('now'):
        print(f'当前节点: {p.get(\"now\")}')
"

# 查看 proxy_check 状态
curl -s http://127.0.0.1:3081/api/proxy-check/status

# 手动触发一次检测
curl -s -X POST http://127.0.0.1:3081/api/proxy-check/check

# 重启 monitor
kill $(pgrep -f 'node server.js') && cd ~/monitor && nohup node server.js > ~/logs/monitor/monitor.log 2>&1 &
```

### 6.3 为什么节点会切到"美国 1"

**根因**：`sb-config.json` 中 selector 的 `"default"` 字段值是 "美国 1｜联通电信推荐"。当以下任一事件发生且 proxy_check 恰好在此时失效，节点就停在美国 1：
- `subscriber.sh` 刷新配置 → sing-box 重启 → selector 重置为 default
- sing-box crash 后被 auto-recovery 重启
- 系统重启

**正常流程**：proxy_check 检测到当前节点不在候选列表（决策 C），自动纠正到最佳候选节点。

**注意**：决策 C 按设计**不发邮件**，因为这是正常的纠正行为，不是异常。只有在候选节点故障切换（B）或全部候选失效（D）时才发邮件。

---

## 七、AutoCheckIn 自动签到模块（2026-08 新增）

### 7.1 架构

采用 **Provider 抽象**：签到核心 = 本地维护的 CheckinClient；Trae 专属逻辑 = provider 适配层；调度/日志/通知 = 通用框架。

```
server.js → /api/checkin/* 路由
  lib/tasks/index.js     任务调度中心（遍历启用任务 → 派发 + Cookie 到期监控）
  lib/providers/index.js Provider 注册中心
    lib/providers/trae.js  Trae provider（方案一 refreshToken 静默续期 + 方案二 Cookie 回落）
      lib/checkin/checkin.js          签到核心客户端（GetUserToken / CheckLogin / exchangeToken）
      lib/checkin/trae-credential.js  导入串解析（provider 与 HTTP 路由共用）
      lib/tasks/trae-import.js        方案一凭证导入 upsert（POST /api/checkin/trae-import）
      lib/checkin/scheduler.js 定时调度器
  lib/checkin-log.js     30 天滚动日志（~/.monitor_data/checkin_logs.json）
  lib/notify.js          sendMail（复用）
```

### 7.2 新增 Provider 的步骤

1. 新建 `lib/providers/xxx.js`，实现 `checkin` / `checkCredential` / `getCredits`，并定义 `configSchema`（前端动态表单据此渲染）。
2. 在 `server.js` 里 `registerProvider(xxxProvider)` 一行注册。
3. 前端 `checkin.html` 无需改动 —— schema 驱动渲染。

### 7.3 configSchema 字段类型（前端动态表单）

| type | 渲染 | 说明 |
|------|------|------|
| `text` / `number` / `time` | 文本输入 | 通用输入框 |
| `password` | 密码框 | 编辑时留空或仍为掩码值（`首4…尾4`）= 不修改旧值；`hint` 字段可附加说明文字 |
| `select` | 下拉菜单 | 需附 `options:[{value,label}]`；支持「自定义…」选项（选中后显示输入框） |
| `toggle` | 开关 | 布尔值 |

新增/编辑时默认值取自 `f.default`（新建账号也会回填）。

> **Trae 凭证说明（2026-10-01 起为「双方案」）**
>
> **方案一（首选）refreshToken 服务端静默续期**
> 用户在 Windows 上从面板下载 `trae-export.bat`（源 `tools/trae-export.ps1`，由
> `tools/build-trae-export.mjs` 打包成纯 ASCII 外壳 + base64 载荷）双击运行：
> 只读本机 Trae 客户端 `%APPDATA%\Trae CN\User\globalStorage\storage.json`，
> 解密 `iCubeAuthInfo://icube.cloudide`（tc 信封）→ 实测一次续期 → 产出「导入串」，
> 并可直接写回面板（`POST /api/checkin/trae-import`，按 userId 自动「新增 or 更新」）。
> 服务端用 `POST /cloudide/api/v3/trae/oauth/ExchangeToken`（ClientID `ono9krqynydwx5`）
> 续期，**不需要 DeviceProof**；refreshToken 滚动轮换 ⇒ 每次成功必须回写
> `task.config.refreshToken`。refreshToken 本身约 180 天有效。
>
> ⚠️ **只有 Trae CN 客户端的授权能用方案一**。`TRAE SOLO CN` 签发的凭证续期会被上游
> 强制要求设备签名（`20405 Device proof required` / `20403 Token device not match`），
> 或换 ClientID 时被拒（`10101 refresh token is not matched to the client`）。
> 同一账号只要在 Trae CN 里登录过一次就永久满足条件（换出客户端也不影响）。
>
> **方案二（兜底）网页 Cookie → GetUserToken**
> `Cloud-IDE-JWT` 由系统自动用 Cookie 调 `GetUserToken` 换取（8 小时过期，使用前不足
> 1 小时自动刷新并落盘）。Cookie 有效期约 14~60 天，到期前按用户配置提前 X 天邮件提醒。
>
> **优先级与回落**：`resolveToken()` 三条腿 —— ① 现成 token 没临期就直接用（**不主动续期**，
> 避免无谓推进轮换链）→ ② refreshToken 续期 → ③ Cookie 换 JWT。
> 方案一失败时**自动降级**到方案二，并记一条 `[提醒]` 事件（**不发即时邮件**，进每日日报第⑥块），
> 同一小时内不重复记。

### 7.4 凭证刷新与 Cookie 到期监控

**刷新链路**（trae.js `resolveToken()`）：
1. `config.token` 存在且剩余 > 1 小时 → 直接用（**不主动续期**；
   方案一每次续期都会推进 refreshToken 轮换链，而客户端手里那份只宽限一代，续太勤会把客户端顶下线）；
2. 否则 `config.refreshToken`（导入串或裸 token）→ `CheckinClient.exchangeToken()`：
   `POST /cloudide/api/v3/trae/oauth/ExchangeToken`，体
   `{ClientID:"ono9krqynydwx5", ClientSecret:"-", RefreshToken}`（UserID 可省），
   头不带 `authorization`、`x-cloudide-token` 为空串、无 DeviceInfo/DeviceProof；
   成功后**回写 `config.refreshToken`（轮换后的新值）与 `task.tokenExpiredAt`**；
3. 方案一失败 → 记 `[提醒]` 事件（进日报，不发信）→ 若配了 Cookie 则自动降级走 `GetUserToken`；
4. 都没有 → 报「未配置凭证」，按凭证无效处理。

**Cookie 到期监控**（tasks/index.js `startCookieExpiryWatcher()`）：仅对**配了 Cookie** 的账号生效。
- 启动后 30 秒首次巡检，之后每 1 小时检查一次；
- 调 `POST /cloudide/api/v3/trae/CheckLogin`（Cookie 鉴权）探测会话存活状态与精确到期时间，结合 `sid_guard` 静态解析（取较早者）；
- 探测结果缓存 24 小时避免频繁请求；
- 剩余天数 ≤ 用户配置的提前量时发邮件（当天去重）；会话已失效时发告警邮件；
- 用户可在账号编辑页关闭通知（`cookieExpiryNotify` 开关）或调整提前天数（`cookieExpiryNotifyDays`：1~14 天可选）。

**凭证寿命**：Cookie（14~60 天）→ GetUserToken（每次换新 8h JWT）→ 签到/查询用 JWT。用户只需在 Cookie 过期或失效后重新抓取一次。

### 7.5 数据与 API

- 任务存储：`~/.monitor_data/checkin_tasks.json`（多账号，含 `failCount`/`credentialInvalid`/`credits`/`totalCredits`/`cookieExpiresAt`/`tokenExpiredAt`）。
- 日志存储：`~/.monitor_data/checkin_logs.json`（按 `(taskId,date)` 去重，滚动保留 30 天）。
- API：`GET/POST/PUT/DELETE /api/checkin/tasks`、`POST /api/checkin/run?id=`、`POST /api/checkin/run-all`、`POST /api/checkin/test?id=`（通过获取**总积分**确认凭证有效并刷新 `totalCredits`）、`GET /api/checkin/credits?id=`、`GET /api/checkin/credits/total?id=`（查询账户各权益包总可用积分）、`GET /api/checkin/status?id=`、`GET /api/checkin/auto-check`、`GET /api/checkin/logs`、`GET /api/checkin/providers`。
- **方案一凭证导入专用**（供 `trae-export.bat` 调用，地址由面板在下载时注入，因此前端可跨域名/本地部署）：
  - `GET /api/checkin/trae-targets` —— 已有 Trae 账号清单（id/名称/方案/deviceId），脚本据此让用户选「更新哪个 / 新建」
  - `POST /api/checkin/trae-import` —— `{importString, taskId?, name?}`；`taskId` 指定则更新它，否则按 `userId` 自动匹配，再匹配不到才新建。
    ★更新路径**只替换凭证**（refreshToken / refreshMeta / deviceId），名称、时间、时区、开关、Cookie 一律不动。
  - 响应头显式带 `charset=utf-8`：PowerShell 5.1 的 `Invoke-RestMethod` 在无 charset 时按 ISO-8859-1 解码，中文会乱码。

### 7.6 通知规则

- 凭证无效（HTTP 401/403，或 `20101 refresh token is invalid` / `10101 not matched to the client` /
  `20403`/`20405` 设备签名类错误 / `code=1001 not able to authenticate` 等）→ 立即通知 +
  `credentialInvalid=true` 暂停该任务轮询。
- **方案一降级到方案二 → 不发即时邮件**，只记一条 `[提醒]` 事件进**每日日报第⑥块**
  （「Trae 方案一凭证失效，已降级用 Cookie：<账号>」）。理由：Cookie 兜住一次会让可修的信号被吃掉，
  但单独发信又太吵——放日报里既不丢信号也不打扰。同一小时内不重复记。
- Cookie 到期预警 → 提前 X 天发邮件（`cookieExpiryNotifyDays` 可配，1~14 天，默认 1 天；`cookieExpiryNotify` 开关控制；当天去重）。
- Cookie 会话已失效 → 告警邮件，提醒重新抓取 Cookie。
- 当天签到窗口已过且失败 → 立即通知（不受阈值限制）。
- 临时失败 → 累计到 `failThreshold`（页面可配，select 下拉）才通知。
- 恢复成功 → 发「恢复」通知；或 `notifyOnSuccess` 开启时成功也通知。

### 7.7 备注

- 手机侧零依赖，不跑 `npm install`；`lib/checkin/` 签到核心在本项目直接维护。
- 前端 `/_worker.js` 已通过 `/api` 前缀通用代理 `/api/checkin/*`，无需单独配置。

### 7.8 每日日报（2026-09-27：取代按账号逐封的积分过期提醒）

**背景（为什么频繁）**：旧 `credit-expiry.js` 按「账号 × 到期批次」各发一封、`maxReminders` 默认 3，且积分过期调度器经 `startAllTasks` 在 **gateway 与 mod-checkin 两个进程各跑一份**，同一事件成倍发信。

**改造**：
- 移除账号表单里的 `creditExpiry*` 字段（`common.js` 删 `creditExpirySchema`，5 个 provider 去掉 `...creditExpirySchema()`）；`tasks/index.js` 去掉 `startCreditExpiryScheduler` 调用、`checkCreditExpiryNow`、`creditExpiryState`。
- 新增 `lib/daily-report.js`：每天固定时刻（默认 **23:30**，时区 `mail_config.daily_report.timezone`，默认 Asia/Shanghai）**只发一封**日报，六块：①积分过期(分/总，复用 `fetchCreditExpiryBatches`) ②代理连通(在线时长/连通率，读 `proxy_check.log`+`node_switch.log`) ③签到(成功/应签) ④设备健康(`metrics()`) ⑤积分消耗与预估可用天数(`getUsageStatsWithEstimates`) ⑥当日告警汇总。每块独立 try/catch，单块失败不拖垮整封。
- 新增 `lib/alert-events.js`：在 `notify.js sendMail` 总漏斗里按 `[告警]/[提醒]` 前缀落当日事件到 `~/.monitor_data/alert_events.json`（供第⑥块）。
- **调度只在 gateway 进程启动**：`server.js` `startDailyReportScheduler()`（mod-checkin 不启），从根上消除双进程重复发信。
- **高危即时件仍单独发**：凭证失效、代理所有候选节点失效等仍即时 `[告警]` 邮件；积分到期/凭证到期预警不再单独发，并入日报。`cookieExpiry` 到期预警逻辑（`checkCookieExpiryOnce`）本次未改动。
- **统一入口**：`notify.html` 新增「每日日报」卡片（开关 + 时刻 + 展望天数 + 预览/立即发送）。配置存 `mail_config.json` 的 `daily_report`；`/api/notify` 保存白名单已加 `daily_report`。
- 新增路由：`POST /api/daily-report/preview`（只读预览）、`POST /api/daily-report/send`（立即发一封）。
- 发布：`lib/daily-report.js`、`lib/alert-events.js` 已加入 `release-manifest.json` 的 **gateway** 模块文件清单（仅 gateway 进程 import）。

---

## 八、相关文件索引

| 文件 | 角色 |
|------|------|
| `monitor/lib/notify.js` | 代理检测、节点切换、邮件通知、调度器 |
| `monitor/lib/logger.js` | `writeLog()` — 所有日志写入都走它（含轮转） |
| `monitor/lib/utils.js` | `HOME`, `DATA_DIR` 常量、配置加载 |
| `monitor/lib/actions.js` | `switchProxy()` — 实际执行 sing-box API 切换 |
| `monitor/server.js` | HTTP 路由（/api/proxy-check/*、/api/checkin/*） |
| `monitor/lib/providers/index.js` | Provider 注册中心 |
| `monitor/lib/providers/trae.js` | Trae provider（**方案一 refreshToken 静默续期 + 方案二 Cookie 回落**、schema 驱动前端表单、含「下载提取脚本」入口） |
| `monitor/lib/checkin/trae-credential.js` | 导入串（`TRAE1.<base64url>`）解析/构造 —— provider 与 HTTP 路由共用 |
| `monitor/lib/tasks/trae-import.js` | 方案一凭证导入 upsert（按 userId 判定「新增 or 更新」，默认值取自 provider schema） |
| `monitor/frontend/trae-export.bat` | ★生成的产物（纯 ASCII 外壳 + base64 载荷），面板下载的就是它 |
| `tools/trae-export.ps1` | 提取脚本**源文件**（可读、含中文），改它之后必须重新生成 .bat |
| `tools/build-trae-export.mjs` | 生成器：`node tools/build-trae-export.mjs`；带「产物必须纯 ASCII」门禁 |
| `monitor/lib/tasks/index.js` | 签到任务调度中心（CRUD、定时执行、通知触发、Cookie 到期监控） |
| `monitor/lib/checkin-log.js` | 30 天滚动签到日志 |
| `monitor/lib/checkin/checkin.js` | 签到核心客户端（CheckinClient + GetUserToken + CheckLogin + JWT/Cookie 工具函数） |
| `monitor/lib/checkin/scheduler.js` | 定时调度器 |
| `monitor/frontend/checkin.html` | 签到页面（多账号管理、动态表单、积分、日志、Cookie 剩余天数显示） |
| `monitor/TASK_GUIDE.md` | 原始功能需求文档 |
| `DEPLOYMENT.md` | 部署流程 |
| `monitor/deploy_tmp/ARCHITECTURE.md` | 网络架构 |
| `fix_dns.py` | 修复 sing-box DNS（改 IP-DoH → 校验 JSON → `sv restart sing-box`），2026-08-18 使用 |
| `diag_dns_servers.py` | DNS 诊断：对比 IP-DoH / 域名-DoH / UDP DNS 对节点域名的解析结果 |
