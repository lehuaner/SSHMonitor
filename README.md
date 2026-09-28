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

## 安全与隐私

- 所有平台凭证仅存于设备本地 `~/.monitor_data/`（任务配置、`frontend_deploy.json` 等，权限 600），**不进入本仓库**
- 面板与 API 应置于 Cloudflare Access（OTP）或等价认证之后，后端自身不做鉴权
- 设备标识（`x-device-id` 等）不内置真实抓包值：按账号稳定派生，可用账号表单或 `~/.monitor_data/device_identity.json` 覆盖，详见 `monitor/lib/checkin/checkin.js` 头注释
- 本仓库历史已做过隐私清理（抓包样本、agent 记忆、订阅令牌脚本一律不入库）

## 免责声明

自动签到依赖上游平台的私有接口与风控策略，随时可能失效；仅用于个人账号的自我管理，请自行评估合规风险。

## License

[MIT](LICENSE)
