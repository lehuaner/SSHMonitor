# Honor10 监控系统 - 部署指南

## 项目结构

```
Honor 10/
├── update-modules.ps1      # 新机首次 provisioning（建 runit 服务 + 基线上传，仅初始化）
│                           # 发布：tag 触发 .github/workflows/release.yml 打包 GitHub Release 产物（GitHub 只发版、不部署）；设备端 apply 自拉产物部署；前端由设备端 apply 后置钩子纯 REST 直传 Cloudflare Pages（monitor/lib/pages-deploy.js）。详见 docs/features/f101-tag发布部署流程.md
├── cloudflaretoken         # （历史遗留）运维令牌；前端 Pages 发布令牌已改存设备 ~/.monitor_data/frontend_deploy.json，不再放本地/GitHub Secrets
├── monitor/
│   ├── server.js           # 后端主服务（Node.js HTTP 服务，端口 3081）
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
│       ├── utils.js        # 工具函数（SSH、进程管理、服务规则）
│       ├── actions.js      # 动作执行（重启服务等）
│       ├── files.js        # 文件管理
│       ├── logger.js       # 日志
│       ├── metrics.js      # 系统指标采集
│       ├── notify.js       # 邮件通知 + 设备告警 + 代理检测
│       ├── recorder.js     # 流量记录
│       └── subscription.js # 订阅解析（vmess/vless/hysteria2/trojan/ss）
└── subscriber.sh           # 订阅更新脚本（已禁用，由 monitor API 替代）
```

## 架构概览

```
用户浏览器
  ↓ HTTPS
Cloudflare Pages (honor10.lehuan.vip)
  ├── 静态资源 → Pages CDN 直接返回
  └── /api /sb /action 等 → _worker.js 代理
                              ↓
                         Cloudflare Tunnel (t.honor10.lehuan.vip)
                              ↓
                         Termux Node.js (127.0.0.1:3081)
                              ├── monitor (server.js)
                              ├── sing-box (9090 API, 7890 代理)
                              └── cloudflared tunnel
```

## 前置条件

### 1. Termux 环境（Honor 10 手机）

```bash
# 安装 Node.js 和依赖
pkg install nodejs git

# 安装 sing-box
pkg install sing-box

# 安装 cloudflared
pkg install cloudflared

# 配置隧道
cloudflared tunnel login
cloudflared tunnel create honor-server
cloudflared tunnel route dns honor-server t.honor10.lehuan.vip
```

### 2. Cloudflare 配置

- **Pages 项目**：`honor10-monitor`（production 分支）
- **自定义域名**：`honor10.lehuan.vip` → Pages 项目
- **Cloudflare Access**：保护所有路径，OTP 邮箱认证
- **Tunnel**：`honor-server` → `t.honor10.lehuan.vip` → `http://localhost:3081`

### 3. SSH 密钥认证（部署机器 → Termux）

```powershell
# 在部署机器上生成密钥（如已有则跳过）
ssh-keygen -t ed25519 -C "deploy"

# 把公钥添加到 Termux
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh -p 8022 u0_a145@192.168.0.107 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# 测试免密登录
ssh -p 8022 u0_a145@192.168.0.107 "echo OK"
```

### 4. Cloudflare 令牌（Pages 发布，设备端持有）

前端发布**不再走 GitHub Actions / GitHub Secrets**。设备端 `mod-release` 通过 `lib/pages-deploy.js` 用 **纯 REST 直传 Cloudflare Pages**。所需令牌为最小权限 **`Cloudflare Pages:Edit`**（连 Account ID、项目名、production branch 一起配），存于设备 `~/.monitor_data/frontend_deploy.json`（权限 600，含 token 明文，属运行时凭据，不外泄/不入库）。首次配置：设备端 `cd ~/monitor && node setup-deploy.js` 交互式选择「本机 / Cloudflare Pages」并写入。CDN 清缓存等运维（下方）另需具备 `Zone: Purge Cache` 权限的令牌。

## 部署架构（v1.0.15+：GitHub 只发版、设备自拉自部署、前端设备直传 Pages）

GitHub Actions 仅负责**打包发布产物**，不做任何部署；部署全部由手机设备端 `mod-release` 完成：

- **发布（PC/Windows）**：改代码 → `git commit` → `git tag -a vX.Y.Z` → `git push origin main --tags`。
  推 tag 触发 `.github/workflows/release.yml`：`tools/build-release.cjs` 按 `release-manifest.json` 做 `node --check` 门禁 + 文件存在性校验，打包 `honor10-backend.tar.gz` / `honor10-frontend.tar.gz` / `honor10-build.json`（逐文件 sha256）/ `honor10-manifest.json`，`gh release create` 挂到该 tag 的 GitHub Release。
- **应用（设备，一键）**：面板「发布」页「拉取并应用」或 `POST /api/release/apply {tag}`。`mod-release.stageFromRelease(tag)` 从该 Release **下载产物 → 逐文件 sha256 校验 → 解包到 `~/releases/<tag>/files/`**（不再逐文件走 Contents API、无回退），`node --check` 门禁后按 manifest 复制到 `~/monitor/`、按 `applyOrder` `sv restart` 服务并 `/healthz` 验证、写 `deployed-version.json` 记账。详见 `docs/features/f101-tag发布部署流程.md`。
- **前端（设备直传 Cloudflare Pages）**：apply 成功后，若本次含前端改动（`meta.frontendChanged`），`deployFrontend` 钩子按 `frontend_deploy.json.mode` 处理——`pages` → `lib/pages-deploy.js` 纯 REST 直传 CF（blake3 哈希 + upload-token + check-missing/assets/upload + 建 deployment + 轮询就绪）；`local` → 复制到 `~/monitor/frontend`。**发布失败** → 回滚到上一 good deployment + 落库 `~/.monitor_data/pages_deploy_last.json` + 邮件告警。前后端版本不一致由前端顶部版本条（`config.js` 读 `/api/release/version-status`）提示。
- **新机首次初始化**：`.\update-modules.ps1`（建 runit 服务 + 上传基线，仅此一次）+ `node setup-deploy.js`（选前端部署位置）+ `npm i @noble/hashes`（blake3 依赖；产物只含源码，不含 node_modules）。

## 部署流程详解（一次发版）

1. 本地改代码，`node --check` 通过；若新增/移动发布文件，**同步登记 `monitor/release-manifest.json`**（manifest 是发布/回滚唯一依据；引用到仓库不存在的文件会让 CI 存在性校验失败）。
2. `git add <相关文件>` → `git commit` → `git tag -a vX.Y.Z -m "..."` → `git push origin main --tags`。
3. 等 `.github/workflows/release.yml` 成功（约 30–60s）：`GET /repos/{repo}/releases/tags/vX.Y.Z` 能看到 4 个资产即就绪。
4. 设备 apply：`POST /api/release/apply {tag}`（或面板按钮）。含 `release` 模块变更时，mod-release 会自重启中断该内存任务 → 见下方「关键坑」拆模块/手工补记账。
5. 验证：`GET /api/release/version-status` → `backend==<tag>`；若含前端，`pages==<tag>`、`mismatch:false`；三进程 `sv status server mon-checkin mon-release` 均 `run`；生产域 `https://honor10-monitor.pages.dev` 返回 200。

## 关键坑（v1.0.15–v1.0.20 实战）

- **设备自拉必是「完整资产 URL + Accept: application/octet-stream」**：GitHub Release 资产的 `.url` 已是 `https://api.github.com/...`，`ghFetchBuffer` 不能再见它拼一次 `https://api.github.com` base（否则主机变 `api.github.comhttps` → `fetch failed ENOTFOUND`）；且下载资产必须带 `Accept: application/octet-stream`（默认 json 只会拿到**元数据 JSON**、`build.commit` 为空）。v1.0.20 已修。
- **不要给守护进程注入 `globalThis.fetch = undici`**：Termux 上 runit 守护进程**联网/DNS 本来正常**（会话 40/40、runit 子进程 5/5、自举 upstream 检查成功皆可证）。此前“守护进程没网/需 dnsfix”实为 URL bug + `globalThis.fetch` 覆盖在长驻进程破坏 fetch 造成的假 ENOTFOUND。排查 Node `fetch failed ENOTFOUND` 先打印**实际 URL/hostname**，别直奔 DNS/网络。
- **manifest 只能引用真实存在的文件**；改 manifest 后**先 `sv restart mon-release` 再 apply**（进程启动时一次性读入清单，否则新增文件静默漏部署）。
- **apply 含 release 模块会自重启丢任务**：拆 `modules:["gateway","checkin"]` 再单独 `["release"]`；或会话内部署后手工补 `deployed-version.json` 记账（审计行用 `ts` 不用 `at`）。
- **后端版本 bump 但无前端改动**时 `version-status` 会显 `mismatch:true`（仅标签差）：按 v1.0.20 做法会话重发一次 Pages 对齐标签即消除，或等下一个含前端的版本。
- 私有仓库：设备自拉/上游检测用 `~/.monitor_data/release_config.json.upstream.token`（fine-grained PAT `Contents: Read-only`）。

## 自动重启机制

部署后，auto-recovery 循环每 30 秒检查一次，自动重启挂掉的服务：

| 服务 | 检测命令 | 重启命令 |
|------|----------|----------|
| monitor | `pgrep -f 'node server.js'` | `cd ~/monitor && nohup node server.js >> ~/logs/monitor/monitor.log 2>&1 &` |
| sing-box | `pgrep -f 'sing-box run'` | `sing-box run -c ~/sb-config.json` |
| cloudflared | `pgrep -f 'cloudflared tunnel run'` | `cloudflared tunnel run honor-server` |

## 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| monitor | 3081 | Node.js HTTP 后端 |
| sing-box API | 9090 | Clash API（节点管理） |
| sing-box 代理 | 7890 | 混合代理入站 |
| Termux SSH | 8022 | SSH 服务 |

## 常用运维命令

### 手动重启 monitor

```bash
ssh -p 8022 u0_a145@192.168.0.107 "~/restart-monitor.sh"
```

### 查看 monitor 日志

```bash
ssh -p 8022 u0_a145@192.168.0.107 "tail -50 ~/logs/monitor/monitor.log"
```

### 检查服务状态

```bash
ssh -p 8022 u0_a145@192.168.0.107 "pgrep -fa 'node server.js|sing-box run|cloudflared tunnel run|while sleep 30'"
```

### 清除 CDN 缓存

```powershell
# 需具备 Zone: Purge Cache 权限的令牌（Pages 令牌无此权限）；勿写回明文，用环境变量提供
$token = $env:CLOUDFLARE_PURGE_TOKEN
$zone = "392b994235b3ffb2fdb55f39661c59e1"
Invoke-RestMethod -Method POST -Uri "https://api.cloudflare.com/client/v4/zones/$zone/purge_cache" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" } `
  -Body '{"purge_everything":true}'
```

### 查看实时流量

访问 `https://honor10.lehuan.vip/sb/ui/`（sing-box MetaCubeXD 面板）。

## 故障排查

### 前端显示旧内容

1. 强制刷新浏览器（Ctrl+F5）
2. 清除 CDN 缓存（见上方命令）
3. 检查 `main.honor10-monitor.pages.dev` 是否显示最新内容（无 CDN 缓存）

### 后端 API 返回 502

1. 检查 cloudflared 隧道状态：`ssh -p 8022 u0_a145@192.168.0.107 "pgrep -fa cloudflared"`
2. 检查 monitor 进程：`ssh -p 8022 u0_a145@192.168.0.107 "pgrep -fa 'node server.js'"`
3. 查看 monitor 日志：`ssh -p 8022 u0_a145@192.168.0.107 "tail -50 ~/logs/monitor/monitor.log"`
4. 手动重启：`ssh -p 8022 u0_a145@192.168.0.107 "~/restart-monitor.sh"`

### SSH 连接失败

1. 确认手机和电脑在同一 WiFi
2. 确认 Termux SSH 服务在运行：`ssh -p 8022 u0_a145@192.168.0.107 "echo OK"`
3. 检查密钥是否已添加：`ssh -p 8022 u0_a145@192.168.0.107 "cat ~/.ssh/authorized_keys"`

### 手机重启后服务（SSH/sing-box/cloudflared/monitor）全部未启动

**现象**：手机重启后，SSH 8022 端口拒绝连接（`ECONNREFUSED`），sing-box、cloudflared、monitor 等全部未运行，但设备本身在线（ping 通）。

**根本原因**：所有服务由 termux-services（runit）托管，`runsvdir` 是总管监视线程。手机重启后 `runsvdir` 未自动启动，导致其管辖的 7 个服务（sing-box、cloudflared、server/monitor、subscriber、ai-unified、sshd、ssh-agent）全部处于 `runsv not running`。Termux:Boot 的开机脚本未被触发执行。

**解决方案（已实施并验证生效）**：

1. **安装 Termux:Boot**（必须与 Termux 主应用同源，均为 F-Droid 版，否则签名不一致无法工作）：
   - 官方直链：`https://f-droid.org/repo/com.termux.boot_1000.apk`
   - 注意：不要用固定文件名 `com.termux.boot.apk` 访问镜像（F-Droid 文件名带版本号，会下错成 Termux:API）
   - 安装后**手动打开一次** Termux:Boot，注册开机广播接收器
2. **授予自启动权限**（荣耀/国产 ROM 关键，否则开机广播被拦截）：
   - 设置 → 应用 → 应用启动管理 → 找到 Termux:Boot 和 Termux → 手动管理，勾选自启动 + 后台活动
   - 设置 → 应用 → 特殊访问权限 → 忽略电池优化 → 允许 Termux:Boot 和 Termux
3. **开机脚本**已存在于 `~/.termux/boot/`：
   - `start-all.sh`：启动 runsvdir 托管所有服务 + 获取 wake-lock
   - `keep-alive.sh`：每 60 秒重新获取 wake-lock 防后台冻结
4. **重启后必须解锁一次手机**：Android 锁屏未解锁时，应用无法访问凭据加密存储，Termux:Boot 的开机脚本会被延迟到解锁后才触发（国产 ROM 尤其严格）。这是正常机制，不是配置失败。

**验证方法**：
- 检查 boot 脚本是否执行：`cat ~/.termux/boot.log`（应含 `boot start` → `runsvdir started` → `boot complete`）
- 检查所有服务：`sv status /data/data/com.termux/files/usr/var/service/*`（应显示 `run:`）
- 端口检查：3081(monitor)、9090(sing-box)、8022(SSH)

### auto-recovery 未运行

```bash
# 检查
ssh -p 8022 u0_a145@192.168.0.107 "pgrep -f 'while sleep 30'"

# 手动启动
ssh -p 8022 u0_a145@192.168.0.107 "~/start-all.sh"
```

## 数据目录

| 路径 | 说明 |
|------|------|
| `~/.monitor_data/` | 配置文件、订阅列表、通知配置、流量记录 |
| `~/monitor/` | 后端代码 |
| `~/sb-config.json` | sing-box 配置 |
| `~/logs/monitor/` | monitor 日志 |
| `~/monitor_backup_*/` | 部署时的备份文件 |

## 部署回滚

```bash
# 找到最新备份
ssh -p 8022 u0_a145@192.168.0.107 "ls -dt ~/monitor_backup_* | head -1"

# 回滚
ssh -p 8022 u0_a145@192.168.0.107 "cp -r ~/monitor_backup_YYYYMMDD_HHMMss/* ~/monitor/ && ~/restart-monitor.sh"
```
