# SSHMonitor

自托管的 **Android/Termux 设备监控 + 多平台自动签到** 一体化服务。

在一台旧手机（本项目使用 Honor 10）上以 Termux + runit 运行 Node.js 后端，通过 Cloudflare Tunnel 安全暴露，前端静态托管于 Cloudflare Pages；提供系统监控、进程管理、文件管理、代理订阅管理，以及 Trae / CodeArts / WorkBuddy / AutoClaw / OfficeAce 等平台的**每日自动签到、凭证到期巡检、邮件/站内告警、每日日报**能力。

```
用户浏览器
  ↓ HTTPS（Cloudflare Access 保护）
Cloudflare Pages（前端静态 + _worker.js API 代理）
  ↓ Cloudflare Tunnel
Termux (Android) runit 守护
  ├── server.js        网关：系统监控 / 文件 / 订阅 / 发布 API（:3081）
  ├── mod-checkin.js   签到调度：多平台 provider、凭证探活、每日日报
  ├── mod-release.js   发布自部署：拉取 GitHub Release 产物 → 校验 → 应用
  ├── sing-box         代理（Clash API :9090）
  └── cloudflared      隧道
```

## 功能

- **多平台自动签到**：Trae、华为 CloudIDE CodeArts、WorkBuddy、AutoClaw（智谱）、OfficeAce；支持验证码登录、设备二次验证流转、JWT/Cookie 自动刷新与落盘
- **凭证生命周期管理**：会话到期提前邮件提醒、失效自动重登、连续失败告警阈值
- **每日日报**：按天汇总签到结果 / 积分 / 异常，取代逐账号刷屏通知
- **设备监控**：CPU / 内存 / 流量记录、进程管理（runit 服务启停）、远程文件管理
- **代理订阅**：vmess / vless / hysteria2 / trojan / ss 订阅解析与节点测速，sing-box 配置生成
- **发布即部署**：`git tag` → GitHub Actions 打包 Release 产物 → 手机自拉、逐文件 sha256 校验、按 manifest 应用并健康验证，失败自动回滚 + 告警；前端由设备直传 Cloudflare Pages

## 快速开始

1. 手机安装 Termux（F-Droid）+ Termux:Boot，装 Node.js：`pkg install nodejs git`
2. 部署后端：将 `monitor/` 放到设备 `~/monitor/`，首次可用根目录 `update-modules.ps1` 建 runit 服务（Termux SSH 默认端口 8022）
3. 打开面板 `http://<设备IP>:3081`，在「签到」页新增账号（各平台凭证说明见表单内提示）
4. 可选：配置 Cloudflare Tunnel + Pages + Access，参考 [DEPLOYMENT.md](DEPLOYMENT.md)
5. 发布通道见 [docs/features/f101-tag发布部署流程.md](docs/features/f101-tag发布部署流程.md)

## 目录结构

```
monitor/
├── server.js            网关主服务（HTTP :3081）
├── mod-checkin.js       签到调度守护模块
├── mod-release.js       发布/自部署模块
├── release-manifest.json 发布清单（部署与回滚唯一依据）
├── frontend/            Cloudflare Pages 前端（纯静态 + _worker.js 代理）
└── lib/
    ├── checkin/         各平台签到协议客户端
    ├── providers/       provider 表单 / 能力 / 错误归一化
    └── ...              监控 / 通知 / 订阅 / 文件 / 发布等模块
.github/workflows/       Release 打包流水线（只发版、不部署）
docs/                    流程与决策文档
tools/build-release.cjs  产物打包（node --check 门禁 + sha256）
```

```
tools/build-release.cjs      产物打包（node --check 门禁 + sha256）
tools/trae-export.ps1        Trae「方案一」凭证提取脚本（源文件，Windows）
tools/build-trae-export.mjs  把它打包成面板可下载的 monitor/frontend/trae-export.bat
```

## Trae 签到：两种凭证方案

| | 方案一（首选） | 方案二（兜底） |
|---|---|---|
| 凭证 | `refreshToken`（「导入串」`TRAE1.…`） | 浏览器整段 Cookie |
| 获取 | 面板「新增账号」里下载 `.bat`，在装有 **Trae CN** 客户端的 Windows 上双击运行 | F12 复制 `api.trae.cn` 请求的 `cookie:` 整段值 |
| 续期 | 服务端 `ExchangeToken` 静默续期（**不需要设备签名**） | `GetUserToken` 换 8h JWT |
| 人工干预 | 约 180 天一次 | 约 14~15 天一次（`X-Cloudide-Session` 只有 14 天） |

方案一失败会**自动回落**到方案二，并记一条 `[提醒]` 事件进**每日日报**（不发即时邮件）。
提取脚本只**只读**客户端文件；它读得到的 `.bat` 里不含任何硬编码地址——面板在下载那一刻
把自己的 origin 注进去，因此换域名 / 本地部署都自动正确。
`TRAE SOLO CN` 签发的凭证**不能**用于方案一（上游要求设备签名）。

## 安全与隐私

- 所有平台凭证仅存于设备本地 `~/.monitor_data/`（任务配置、`frontend_deploy.json` 等，权限 600），**不进入本仓库**
- 面板与 API 应置于 Cloudflare Access（OTP）或等价认证之后，后端自身不做鉴权
- 设备标识（`x-device-id` 等）不内置真实抓包值：优先级为**账号表单 > `~/.monitor_data/device_identity.json`（部署级真实值）> 按账号稳定派生**（派生只是没配任何东西时的兜底），详见 `monitor/lib/checkin/checkin.js` 头注释
- 方案一的导入串自带客户端真实 aha 设备 ID，导入时自动落到该账号的 `deviceId`；签到 `claim` 会校验它，用错会返回 `9074`（伪装成"操作太过频繁"）
- 本仓库历史已做过隐私清理（抓包样本、agent 记忆、订阅令牌脚本一律不入库）

## 免责声明

自动签到依赖上游平台的私有接口与风控策略，随时可能失效；仅用于个人账号的自我管理，请自行评估合规风险。

## License

[MIT](LICENSE)
