# Honor10 监控系统 - 部署指南

## 项目结构

```
Honor 10/
├── update-modules.ps1      # 新机首次 provisioning（建 runit 服务 + 基线上传，仅初始化）
                            # 后端发布：见 docs/features/f101 —— 设备 apply 时自 GitHub 拉取；前端走 .github/workflows/deploy-frontend.yml
├── cloudflaretoken         # Cloudflare API Token 凭证（仅运维如清缓存用；前端 CI 令牌存 GitHub Secrets）
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

### 4. Cloudflare API Token

前端发布所需的 Cloudflare 令牌为最小权限 `Cloudflare Pages:Edit`，由 GitHub 仓库 Secrets 保管（`CLOUDFLARE_API_TOKEN`），不再放本地/脚本。CDN 清除缓存等运维操作（下方）另需具备 `Zone: Purge Cache` 权限的令牌。

## 部署方式（已去 PC↔SSH）

- **后端（手机 monitor）**：`git commit → git tag → git push` 后，在手机「发布」面板点「应用 / 拉取并应用」（`POST /api/release/apply {tag}`）。手机若本地无该版本档案，会**自动按 manifest 从 GitHub 拉取**文件、`node --check` 门禁后复制重启（方案A）。详见 `docs/features/f101-tag发布部署流程.md`。
- **前端（Cloudflare Pages）**：改 `monitor/frontend/**` 合 `main` → GitHub Actions 自动发（`.github/workflows/deploy-frontend.yml`）。
- **新机首次初始化**：`.\update-modules.ps1`（创建 runit 服务 + 上传基线，仅此一次）。

## 部署流程详解

### 前端部署（Cloudflare Pages）

已迁移到 GitHub Actions，本地不再手发：

1. 推送到 `main` 且改动命中 `monitor/frontend/**` → workflow 自动触发
2. CI 内 `npx wrangler pages deploy`（凭据取自仓库 Secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）
3. 发布到 `honor10-monitor` 的 production，可经 `https://honor10.lehuan.vip` 访问

### 后端部署（Termux Node.js）

由 `mod-release` 在设备上执行（无 PC scp）：

1. 解析 tag → commit sha，读 `release-manifest.json` 的设备侧文件清单
2. 逐个文件从 GitHub Contents API 下载到 `~/releases/<tag>/files/`
3. 对每个 `.js` 跑 `node --check` 门禁（失败即中止，不触碰运行中代码）
4. 按 manifest 复制到 `~/monitor/` 运行位置 → `sv restart` 对应 runit 服务 → `/healthz` 验证
5. 写 `deployed-version.json` 记账 + 审计；失败自动回滚本次复制

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
