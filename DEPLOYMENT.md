# Honor10 监控系统 - 部署指南

> 最近修订：2026-10-14（sing-box 下线、watchdog/auto-recovery 废止、脚本治理，详见文末「架构变更记录」）

## 项目结构

```
Honor 10/
├── update-modules.ps1      # 历史初始化工具（P1 模块化部署：上传文件 + 建 mon-checkin 服务）。
│                           # 现役发布走 F101 tag 流程（见下）；本脚本仅新机初始化/抢救时用。
├── cloudflaretoken         # （本地遗留、不入库）运维令牌；前端 Pages 发布令牌已改存设备 ~/.monitor_data/frontend_deploy.json
├── monitor/
│   ├── server.js           # 后端网关主服务（Node.js HTTP 服务，端口 3081）
│   ├── mod-checkin.js      # 签到调度守护模块（runit 服务 mon-checkin）
│   ├── mod-release.js      # 发布自部署模块（runit 服务 mon-release）
│   ├── release-manifest.json  # 发布清单（部署与回滚唯一依据）
│   ├── package.json
│   ├── frontend/           # Cloudflare Pages 前端静态文件
│   │   ├── _worker.js      # Pages Worker（API 代理到后端）
│   │   ├── index.html      # 监控面板
│   │   ├── notify.html     # 通知配置
│   │   ├── subscription.html # 订阅管理
│   │   ├── files.html      # 文件管理
│   │   ├── android.html    # Android 进程管理
│   │   └── config.js       # 前端配置
│   └── lib/                # 后端模块
│       ├── checkin/         # 各平台签到协议客户端
│       ├── providers/      # provider 表单 / 能力 / 错误归一化
│       ├── notify.js       # 告警调度：进程监控 + 代理探测 + 设备告警 + 每日日报
│       ├── subscription.js # 订阅解析（vmess/vless/hysteria2/trojan/ss）→ 生成 mihomo 配置
│       ├── pages-deploy.js # 前端纯 REST 直传 Cloudflare Pages
│       └── ...             # 监控 / 通知 / 文件 / 发布等模块
├── tools/
│   ├── boot/               # ★ 设备开机脚本的唯一源（start-all.sh / keep-alive.sh / notify-boot.sh）
│   ├── check-remote-access.mjs  # 远程访问链路探测（设备端回环，runit 服务 remote-access-check）
│   ├── machine-access-client.mjs # 机器端 API 客户端（api.lehuan.vip/honor10/*）
│   ├── cf-honor10-gw.mjs   # 机器网关 Worker 部署工具
│   ├── build-release.cjs   # Release 产物打包（node --check 门禁 + sha256）
│   └── ...
└── subscriber.sh           # （已废弃 2026-10-14，仅历史留存、不入库）订阅更新由 monitor
                            #   subscription_refresh 承担，设备脚本已归档
```

## 架构概览

```
用户浏览器
  ↓ HTTPS（Cloudflare Access 保护）
Cloudflare Pages (honor10.lehuan.vip)
  ├── 静态资源 → Pages CDN 直接返回
  └── /api /sb /action 等 → _worker.js 代理
                              ↓
                         Cloudflare Tunnel (t.honor10.lehuan.vip)
                              ↓
                         Termux runit 服务树
                         ├── server (server.js)          监控/文件/订阅/发布 API (:3081)
                         ├── mon-checkin (mod-checkin.js)  多平台签到调度
                         ├── mon-release (mod-release.js)  发布自部署
                         ├── mihomo                      代理（Clash API :9090，混合入站 :7897）
                         ├── cloudflared                  隧道
                         ├── sshd                         SSH (:8022)
                         ├── ai-unified / unified-novel   其他常驻服务
                         └── remote-access-check          外网链路回环探测
```

## 前置条件

### 1. Termux 环境（Honor 10 手机）

```bash
# 安装 Node.js 和依赖
pkg install nodejs git

# 安装 mihomo（Clash Meta 内核；2026-10 起替代 sing-box）
pkg install mihomo

# 安装 cloudflared
pkg install cloudflared

# 配置隧道
cloudflared tunnel login
cloudflared tunnel create honor-server
cloudflared tunnel route dns honor-server t.honor10.lehuan.vip
```

mihomo 配置位于 `~/mihomo/config.yaml`（由 monitor 的订阅模块生成/刷新），
`mixed-port: 7897`、`external-controller: 127.0.0.1:9090`。

### 2. Cloudflare 配置

- **Pages 项目**：`honor10-monitor`（production 分支）
- **自定义域名**：`honor10.lehuan.vip` → Pages 项目
- **Cloudflare Access**：保护所有路径，OTP 邮箱认证
- **Tunnel**：`honor-server` → `t.honor10.lehuan.vip` → `http://localhost:3081`
- **机器 / 多端 API 网关**：`api.lehuan.vip/honor10/*` → Worker `honor10-gw`（非浏览器访问后端，详见「机器 / 多端 API 网关」节）

### 3. SSH 密钥认证（部署机器 → Termux）

```powershell
# 在部署机器上生成密钥（如已有则跳过）
ssh-keygen -t ed25519 -C "deploy"

# 把公钥添加到 Termux
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh -p 8022 u0_aXXX@<PHONE_IP> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# 测试免密登录
ssh -p 8022 u0_aXXX@<PHONE_IP> "echo OK"
```

### 4. Cloudflare 令牌（Pages 发布，设备端持有）

前端发布**不再走 GitHub Actions / GitHub Secrets**。设备端 `mod-release` 通过 `lib/pages-deploy.js` 用 **纯 REST 直传 Cloudflare Pages**。所需令牌为最小权限 **`Cloudflare Pages:Edit`**（连 Account ID、项目名、production branch 一起配），存于设备 `~/.monitor_data/frontend_deploy.json`（权限 600，含 token 明文，属运行时凭据，不外泄/不入库）。首次配置：设备端 `cd ~/monitor && node setup-deploy.js` 交互式选择「本机 / Cloudflare Pages」并写入。CDN 清缓存等运维（下方）另需具备 `Zone: Purge Cache` 权限的令牌。

## 部署架构（v1.0.15+：GitHub 只发版、设备自拉自部署、前端设备直传 Pages）

GitHub Actions 仅负责**打包发布产物**，不做任何部署；部署全部由手机设备端 `mod-release` 完成：

- **发布（PC/Windows）**：改代码 → `git commit` → `git tag -a vX.Y.Z` → `git push origin main --tags`。
  推 tag 触发 `.github/workflows/release.yml`：`tools/build-release.cjs` 按 `release-manifest.json` 做 `node --check` 门禁 + 文件存在性校验，打包 `honor10-backend.tar.gz` / `honor10-frontend.tar.gz` / `honor10-build.json`（逐文件 sha256）/ `honor10-manifest.json`，`gh release create` 挂到该 tag 的 GitHub Release。
- **应用（设备，一键）**：面板「发布」页「拉取并应用」或 `POST /api/release/apply {tag}`。`mod-release.stageFromRelease(tag)` 从该 Release **下载产物 → 逐文件 sha256 校验 → 解包到 `~/releases/<tag>/files/`**，`node --check` 门禁后按 manifest 复制到 `~/monitor/`、按 `applyOrder` `sv restart` 服务并 `/healthz` 验证、写 `deployed-version.json` 记账。详见 `docs/features/f101-tag发布部署流程.md`。
- **前端（设备直传 Cloudflare Pages）**：apply 成功后，若本次含前端改动（`meta.frontendChanged`），`deployFrontend` 钩子按 `frontend_deploy.json.mode` 处理——`pages` → `lib/pages-deploy.js` 纯 REST 直传 CF（blake3 哈希 + upload-token + check-missing/assets/upload + 建 deployment + 轮询就绪）；`local` → 复制到 `~/monitor/frontend`。**发布失败** → 回滚到上一 good deployment + 落库 `~/.monitor_data/pages_deploy_last.json` + 邮件告警。前后端版本不一致由前端顶部版本条（`config.js` 读 `/api/release/version-status`）提示。
- **新机首次初始化**：`.\update-modules.ps1`（历史工具，建 runit 服务 + 上传基线）+ `node setup-deploy.js`（选前端部署位置）+ `npm i @noble/hashes`（blake3 依赖；产物只含源码，不含 node_modules）+ `CF_API_TOKEN=xxx node tools/cf-honor10-gw.mjs`（机器/多端 API 网关，生成 `gw_token`，见下节）。

## 机器 / 多端 API 网关（脱离浏览器访问后端）

供移动 App / 桌面 / CLI / 自动化脚本等非浏览器端调用后端全部接口（含高危，自用可信环境口径）。

**为什么不是 Cloudflare Access Service Token**：实测 `honor10.lehuan.vip` 是 **Pages 自定义域名**，Pages 这条 origin 类型**不认 Access service token**（带 API 现建的全新令牌仍 `service_token_status:false` → 302）；`t.honor10.lehuan.vip` 三级域外部 TLS 不可达；免费账户拿不到可用的二级自托管 Access 域。故机器通道改为 **二级域 + Worker 网关 + 一把共享 Bearer**。

**链路**：`client → https://api.lehuan.vip/honor10/<path> → [Worker honor10-gw：校验 Authorization: Bearer <gw_token> + 剥 /honor10 前缀] → t.honor10.lehuan.vip → Tunnel → 127.0.0.1:3081`。浏览器面板仍走 `honor10.lehuan.vip`（Pages + 邮箱 OTP），与本入口互不影响；`api.lehuan.vip/*` 根路径仍归 `ai-unified-worker`，`/honor10` 子路径 route 优先命中网关（实测共存、不干扰）。

**初次部署（一次性、幂等）**：
```powershell
$env:CF_API_TOKEN="..."   # 需 Workers Scripts:Edit + Zone Workers Routes:Edit
node tools/cf-honor10-gw.mjs          # 生成 gw_token 写设备 machine_access.json(600) + secret_text 注入 Worker + 部署 honor10-gw + 挂 route api.lehuan.vip/honor10/*
node tools/cf-honor10-gw.mjs --check  # 只读核对 token/worker/route
```

**凭证**：`~/.monitor_data/machine_access.json` 的 `gw_token`（权限 600；`.gitignore` 已忽略 `**/machine_access.json`，绝不入库/打印）。可随时重跑部署脚本前删除该字段以**轮换**。

**客户端调用**：
```bash
curl -sS -H "Authorization: Bearer $GW_TOKEN" https://api.lehuan.vip/honor10/healthz
```
Node / Python / iOS / Android 等价写法见 `tools/machine-access-client.mjs`。

**安全边界**：`api.lehuan.vip` 与 `t.honor10` 均**无 Access**，这把 Bearer 是该入口唯一防线；仅自用可信环境，泄露 = 后端全裸。

**冒烟实测（本环境）**：无 Bearer→401；错 Bearer→401；对 Bearer→200（返回后端真实数据）。

## 部署流程详解（一次发版）

1. 本地改代码，`node --check` 通过；若新增/移动发布文件，**同步登记 `monitor/release-manifest.json`**（manifest 是发布/回滚唯一依据；引用到仓库不存在的文件会让 CI 存在性校验失败）。
2. `git add <相关文件>` → `git commit` → `git tag -a vX.Y.Z -m "..."` → `git push origin main --tags`。
3. 等 `.github/workflows/release.yml` 成功（约 30–60s）：`GET /repos/{repo}/releases/tags/vX.Y.Z` 能看到 4 个资产即就绪。
4. 设备 apply：`POST /api/release/apply {tag}`（或面板按钮）。含 `release` 模块变更时，mod-release 会自重启中断该内存任务 → 见下方「关键坑」拆模块/手工补记账。
5. 验证：`GET /api/release/version-status` → `backend==<tag>`；若含前端，`pages==<tag>`、`mismatch:false`；服务 `sv status /data/data/com.termux/files/usr/var/service/*` 核心项均 `run`；生产域 `https://honor10-monitor.pages.dev` 返回 200。

## 关键坑（v1.0.15–v1.0.20 实战）

- **设备自拉必是「完整资产 URL + Accept: application/octet-stream」**：GitHub Release 资产的 `.url` 已是 `https://api.github.com/...`，`ghFetchBuffer` 不能再见它拼一次 `https://api.github.com` base（否则主机变 `api.github.comhttps` → `fetch failed ENOTFOUND`）；且下载资产必须带 `Accept: application/octet-stream`（默认 json 只会拿到**元数据 JSON**、`build.commit` 为空）。v1.0.20 已修。
- **不要给守护进程注入 `globalThis.fetch = undici`**：Termux 上 runit 守护进程**联网/DNS 本来正常**（会话 40/40、runit 子进程 5/5、自举 upstream 检查成功皆可证）。此前"守护进程没网/需 dnsfix"实为 URL bug + `globalThis.fetch` 覆盖在长驻进程破坏 fetch 造成的假 ENOTFOUND。排查 Node `fetch failed ENOTFOUND` 先打印**实际 URL/hostname**，别直奔 DNS/网络。
- **manifest 只能引用真实存在的文件**；改 manifest 后**先 `sv restart mon-release` 再 apply**（进程启动时一次性读入清单，否则新增文件静默漏部署）。
- **apply 含 release 模块会自重启丢任务**：拆 `modules:["gateway","checkin"]` 再单独 `["release"]`；或会话内部署后手工补 `deployed-version.json` 记账（审计行用 `ts` 不用 `at`）。
- **后端版本 bump 但无前端改动**时 `version-status` 会显 `mismatch:true`（仅标签差）：按 v1.0.20 做法会话重发一次 Pages 对齐标签即消除，或等下一个含前端的版本。
- 私有仓库：设备自拉/上游检测用 `~/.monitor_data/release_config.json.upstream.token`（fine-grained PAT `Contents: Read-only`）。

## 服务守护与开机自启（runit）

**所有服务由 runit（runsvdir）托管，崩溃自动重启**。没有 watchdog、没有 auto-recovery 循环、没有 nohup 守护进程——这些旧机制已于 2026-10-14 全部废止（与 runit 职责重叠）。

### 服务清单（/data/data/com.termux/files/usr/var/service/）

| 服务 | 内容 | 说明 |
|---|---|---|
| `server` | `~/monitor/server.js` | 网关主服务（**不是** `monitor`） |
| `mon-checkin` | `~/monitor/mod-checkin.js` | 多平台签到调度 |
| `mon-release` | `~/monitor/mod-release.js` | 发布自部署 |
| `mihomo` | `mihomo -d ~/mihomo` | 代理内核（Clash API 9090 / 混合入站 7897） |
| `cloudflared` | `cloudflared tunnel run honor-server` | 隧道 |
| `sshd` | Termux SSH | 端口 8022 |
| `remote-access-check` | `~/tools/check-remote-access.mjs --loop 300` | 外网链路回环探测 |
| `ai-unified` / `unified-novel` | 其他常驻服务 | |
| `ssh-agent` | 已知 down，不关心 | |

### 开机链路（手机重启后自动拉起全栈）

```
手机开机 → Termux:Boot 广播 → ~/.termux/boot/ 下脚本被逐个执行：
  start-all.sh   flock 防并发 → pkill -x runsvdir → setsid runsvdir -P <SVDIR> → 起 keep-alive 单实例
  keep-alive.sh  每 60s termux-wake-lock 防后台冻结
  notify-boot.sh  sleep 20 后开机自检（sv status 7 项核心服务）并发一封邮件，
                 覆盖「Termux:Boot 没触发 / runsvdir 没起来」这类整体性盲区
runsvdir 起来后按需拉起/重启上述所有服务
```

**脚本源码在本地仓库 `tools/boot/`（start-all.sh / keep-alive.sh / notify-boot.sh）**，设备 `~/.termux/boot/` 是部署产物；修改走「改本地 → base64 上传 → 两边 sha256 对拍」，**不走 F101 tag 发布流程**。`start-all.sh` 内置 flock 互斥，防止开机广播重复投递导致双 runsvdir / 多 keep-alive 实例。

**重启后必须解锁一次手机**：Android 锁屏未解锁时应用无法访问凭据加密存储，Termux:Boot 的开机脚本会被延迟到解锁后才触发（国产 ROM 尤其严格）。这是正常机制，不是配置失败。

**验证方法**：
- boot 日志：`cat ~/.termux/boot.log`（应含 `boot start` → `runsvdir started` → `boot complete`）
- 开机自检日志：`cat ~/.termux/boot-heartbeat.log`
- 服务状态：`sv status /data/data/com.termux/files/usr/var/service/*`
- 端口：3081（server）、9090（mihomo API）、7897（混合代理）、8022（SSH）

## 告警与监控体系

所有邮件告警由设备端发出，入口是 `mail_config.json`（`~/.monitor_data/`，权限 600）：

| 机制 | 载体 | 说明 |
|---|---|---|
| 进程掉线 | `notify.js checkProcs` | 对 `monitored_procs` 做 `ps -eo args` 子串匹配。**下线进程必须同步从该列表移除**，否则持续误报。保存走 `POST /api/notify`（会 resetProcStatus，不会补发「已恢复」） |
| 代理连通 | `notify.js checkProxy` | 候选节点测速 + 自动切换，全失效才告警 |
| 设备状态 | `notify.js checkDeviceAlerts` | 电量/温度/WiFi/磁盘/CPU/内存，`device_alerts` 块配置阈值与冷却 |
| 每日日报 | `notify.js sendDailyReport` | 每天汇总（默认 23:30），取代逐条刷屏 |
| 开机自检 | `~/.termux/boot/notify-boot.sh` | 独立于 runit，覆盖「整个 runit 栈没起来」盲区 |
| 远程链路 | `~/tools/check-remote-access.mjs` | 设备端回环探 api 网关；3 次采样全失败且连续 2 轮才告警，**发送前即时复探确认**；恢复时发通知 |

**已知盲区（设备级）**：设备真正断电时，以上所有机制随进程一起静默——「关机前预警」只能靠电量分级阈值尽量抢时间窗；「关机后通知」目前缺少外部兜底（曾评估 Cloudflare Worker cron 外部心跳方案，因 MailChannels 外发授权问题未落地，代码已暂存于 `wip/heartbeat` 分支）。

## 常用运维命令

```bash
SVDIR=/data/data/com.termux/files/usr/var/service

# 重启某个服务（唯一正确姿势；不要 pkill + nohup 手动起，会绕过 runit）
sv restart $SVDIR/server
sv restart $SVDIR/mihomo

# 服务状态
sv status $SVDIR/*

# 查看日志（svlogd，按天轮转）
tail -50 /data/data/com.termux/files/usr/var/log/server/current

# 健康检查
curl -s http://127.0.0.1:3081/healthz
curl -s http://127.0.0.1:3081/api/release/version-status

# 手机侧电池状态
termux-battery-status
```

### 清除 CDN 缓存

```powershell
# 需具备 Zone: Purge Cache 权限的令牌（Pages 令牌无此权限）；勿写回明文，用环境变量提供
$token = $env:CLOUDFLARE_PURGE_TOKEN
$zone = "<YOUR_ZONE_ID>"   # Cloudflare 控制台 → 域名 → Overview → Zone ID
Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zone/purge_cache" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"purge_everything":true}'
```

### 查看实时流量

访问 `https://honor10.lehuan.vip/sb/ui/`（mihomo 面板，原 sing-box MetaCubeXD 入口不变）。

## 故障排查

### 后端 API 返回 502

1. 检查 cloudflared 隧道状态：`sv status $SVDIR/cloudflared`
2. 检查 server 服务：`sv status $SVDIR/server`
3. 查看日志：`tail -50 /data/data/com.termux/files/usr/var/log/server/current`
4. 重启：`sv restart $SVDIR/server`
5. 区分本机/外网：跑一次 `node ~/tools/check-remote-access.mjs`，本机通、外部不通 = Tunnel/边缘链路问题

### 代理不通

1. mihomo 进程与 Clash API：`curl -s http://127.0.0.1:9090/version`
2. 配置：`~/mihomo/config.yaml`（由 monitor 订阅模块生成）
3. 重启：`sv restart $SVDIR/mihomo`

### 服务「看起来活着但外部不可达」

这正是 `remote-access-check` 的职责域：它同时对比本机回环直连 3081 与外网链路（api 网关 → Worker → Tunnel），本机不通报「本机服务不可达」，本机通而外部不通报「远程访问不可达」（大概率 Tunnel/边缘问题）。

### SSH 连接失败

1. 确认手机和电脑在同一 WiFi
2. 确认 sshd 服务在运行：`sv status $SVDIR/sshd`
3. 检查密钥是否已添加：`ssh -p 8022 u0_aXXX@<PHONE_IP> "cat ~/.ssh/authorized_keys"`

### 手机重启后服务全部未启动

见上文「开机链路」。排查顺序：`cat ~/.termux/boot.log` 确认 boot 脚本执行过 → 解锁一次手机（国产 ROM 延迟触发）→ `pgrep -x runsvdir` 确认总管在 → `sv status $SVDIR/*` 看各服务。

## 数据目录

| 路径 | 说明 |
|---|---|
| `~/.monitor_data/` | 配置文件、签到任务、通知配置、流量记录、`machine_access.json`、`frontend_deploy.json` |
| `~/monitor/` | 后端代码（F101 发布的落地处） |
| `~/releases/<tag>/files/` | Release 产物暂存（apply 前 sha256 校验） |
| `~/mihomo/` | mihomo 工作目录（`config.yaml`） |
| `/data/data/com.termux/files/usr/var/service/` | runit 服务目录 |
| `/data/data/com.termux/files/usr/var/log/<service>/current` | 各服务日志（svlogd） |
| `~/tools/` | 设备侧运维工具（check-remote-access.mjs 等，本地源在仓库 `tools/`） |
| `~/.termux/boot/` | 开机脚本（本地源在仓库 `tools/boot/`） |
| `~/script-archive-20261014/` | 已废止脚本归档（watchdog.sh、restart-monitor.sh、subscriber* 等，可恢复） |
| `~/disabled-services/sing-box/` | 已下线的 sing-box runit 服务目录（含历史日志，留档） |

## 部署回滚

```bash
# 方式一：回到上一个 good tag（推荐，走发布链）
curl -X POST http://127.0.0.1:3081/api/release/apply -H 'Content-Type: application/json' -d '{"tag":"v1.0.46"}'

# 方式二：apply 前的备份在 ~/monitor_backup_*（mod-release 每次 apply 自动留）
ssh -p 8022 u0_aXXX@<PHONE_IP> "ls -dt ~/monitor_backup_* | head -1"

# 回滚后重启（runit 会自动拉起，无需手动）
sv restart /data/data/com.termux/files/usr/var/service/server
```

## 架构变更记录

- **2026-10-14**：
  - **sing-box 正式下线**（配置删除后服务每秒崩溃循环，且拖累监控告警）。代理由 **mihomo**（Clash Meta 内核）完全替代：混合入站 `7897`（原 sing-box `7890`），Clash API 仍 `9090`。sing-box 的 runit 服务目录连日志归档至 `~/disabled-services/sing-box/`。
  - **watchdog.sh / restart-monitor.sh / subscriber 服务 / ~/ 顶层全部遗留脚本废止**：与 runit 职责重叠或已被 monitor API 替代，全部移入 `~/script-archive-20261014/`。重启服务一律 `sv restart <svc>`。
  - **告警监控列表清理**：`monitored_procs` 只保留真实在跑的关键进程（当前 `cloudflared tunnel`、`node server.js`）。
  - **开机脚本治理**：`tools/boot/` 成为 `start-all.sh` / `keep-alive.sh` / `notify-boot.sh` 的唯一源；`start-all.sh` 新增 flock 防并发双跑（曾出现双 runsvdir + 4 个 keep-alive 实例）。
  - `check-remote-access.mjs` 增加「发送前即时复探确认」，消除告警滞后导致的误报。
