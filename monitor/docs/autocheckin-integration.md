# AutoCheckinTrae 集成到 Honor10 Monitor 设计文档（v2）

> 状态：**已实施**，2026-08-15 部署上线
> 日期：2026-08-15
> 变更：v2 引入 **Provider 抽象**，支持多账号、多 provider，新增 30 天日志与积分查看。
> v3 更新：configSchema 新增 `select` 类型支持下拉菜单（接口地址/时区/签到时间/阈值）+ 自定义选项

## 1. 背景与目标

将 Trae 每日自动签到集成到 Honor10 监控项目，并设计成**可扩展的多 provider 签到框架**。

核心诉求（v2 更新）：

1. **复用本项目邮件通知系统**（`sendMail`）。
2. **不重写签到核心逻辑**——把 AutoCheckinTrae 当库打包。
3. **前端添加多个 Trae 账号**，把 **Trae 当作第一个 provider** 配置。
4. **后续注册更多 provider**（架构面向扩展）。
5. **前端可配置项越多越好**。
6. **凭证有效性检测** + 当天失败必通知。
7. **30 天签到日志系统**。
8. **积分查看**（每账号当前积分；积分明细/趋势需上游支持）。

## 2. 关键调研结论

### 2.1 AutoCheckinTrae 结构

| 文件 | 外部依赖 | 是否使用 |
|---|---|---|
| `src/checkin.js` — `CheckinClient` | **零依赖**（全局 fetch） | ✅ 核心 |
| `src/scheduler.js` — `startScheduler` | **零依赖**（全局 Intl） | ✅ 核心 |
| `src/config.js` | `dotenv`（唯一 npm 包） | ❌ 不需要 |
| `src/server.js` | Node 内置 | ❌ 丢弃 |
| `src/cli.js` | 本地模块 | 可选 |
| `test/*.js` | `vitest`（仅开发） | ❌ 不进手机 |

- **纯 ESM JS，Node ≥18 直接运行**，无编译、无构建。
- 唯一 npm 包是 `config.js` 的 `dotenv`；核心 `checkin.js`/`scheduler.js` **零依赖**。
- `dotenv`/`vitest`/`node_modules` 全部不进手机，monitor 保持零依赖。

### 2.2 积分数据现状（重要）

- `CheckinClient.status()` 已返回 `{ code, checked_in, credits, message }`，**`credits` = 当前积分余额**。
- → **「每账号当前积分」可直接实现，无需改上游**。
- 若需**积分明细 / 每日趋势 / 累计获得**，上游当前无专门接口，需改 AutoCheckinTrae。

### 2.3 关键约束

- monitor `package.json` **零依赖**，只用 Node 内置模块。
- 部署为**文件 scp 到手机**，手机**不跑 npm install**。
- → 采用 **vendor + 部署期脚本化同步**，不用 npm `file:` 依赖。

### 2.4 凭证格式（erived from AutoCheckinTrae config.json）

```json
{ "baseUrl": "https://api.trae.cn", "token": "JWT", "checkinTime": "09:00", "timezone": "Asia/Shanghai", "enableSchedule": true }
```

## 3. 整体架构（v2：Provider 抽象）

```
┌─────────────────────────── 前端 checkin.html ───────────────────────────┐
│  多账号列表 │ 动态表单(按 provider 渲染) │ 每账号积分 │ 30天签到日历 │
└──────────────────────────────────────────────────────────────────────────┘
                       │  /api/checkin/*
┌─────────────────────────── 后端 monitor ───────────────────────────┐
│  server.js → /api/checkin/* 路由                                    │
│                                                                     │
│  lib/tasks/index.js ── 任务调度中心（遍历启用任务 → 派发）           │
│      │                                                              │
│  lib/providers/index.js ── Provider 注册中心                        │
│      │                                                              │
│      ├── lib/providers/trae.js ── Trae provider（包装 vendored CheckinClient）
│      │       └── lib/checkin/checkin.js + scheduler.js（vendor，零依赖）
│      │
│  lib/checkin-log.js ── 30 天滚动日志（~/.monitor_data/checkin_logs.json）
│  lib/notify.js ── sendMail（复用）
└──────────────────────────────────────────────────────────────────────────┘
```

**原则**：签到核心 = vendor 零依赖文件；Trae 专属逻辑 = provider 适配层；调度/日志/通知 = 通用框架。新增 provider 只加一个文件 + 注册一行，不动 server.js 主流程。

## 4. 文件结构

```
monitor/
├── lib/
│   ├── checkin/                    # vendor 自 AutoCheckinTrae（零依赖）
│   │   ├── checkin.js              #   CheckinClient
│   │   └── scheduler.js            #   startScheduler
│   ├── providers/                  # Provider 抽象层（新增）
│   │   ├── index.js                #   注册中心 + 派发
│   │   └── trae.js                 #   Trae provider（第一个）
│   ├── tasks/
│   │   └── index.js                #   任务调度中心（统一调度所有 provider）
│   ├── checkin-log.js              # 30 天滚动日志（新增）
│   ├── notify.js                   # 现有通知（复用 sendMail）
│   └── utils.js                    # 现有工具
├── server.js                       # 新增 /api/checkin/* 路由 + 启动调度
└── frontend/
    ├── checkin.html                # 新增：provider 化签到页
    ├── index.html                  # 导航栏加「签到」入口
    └── _worker.js                  # 无需改（/api 已代理）
```

## 5. Provider 抽象（核心设计）

### 5.1 Provider 接口

```js
registerProvider({
  id: 'trae',                 // 唯一标识，存于 task.providerId
  name: 'Trae',
  // 前端动态渲染表单的配置 schema（可配置项越多，字段越多）
  configSchema: [
    { key: 'token',      label: '凭证 Token',      type: 'password', required: true },
    { key: 'baseUrl',    label: '接口地址',        type: 'text',     default: 'https://api.trae.cn' },
    { key: 'time',       label: '签到时间',        type: 'time',     default: '09:00' },
    { key: 'timezone',   label: '时区(IANA)',      type: 'text',     default: 'Asia/Shanghai' },
    { key: 'retryCount', label: '失败重试次数',    type: 'number',   default: 2 },
    { key: 'notifyOnSuccess', label: '成功发通知', type: 'toggle',   default: false },
  ],
  capabilities: ['checkin', 'credits', 'credentialTest'],

  // 以下由 provider 实现（Trae 内部包装 vendored CheckinClient）
  async checkin(task) {},          // 执行一次签到
  async checkCredential(task) {},  // 校验凭证有效性
  async getCredits(task) {},       // 查询当前积分
})
```

### 5.2 Task 数据结构

```json
{
  "id": "a1b2c3",
  "providerId": "trae",
  "name": "Trae 主账号",
  "config": { "token": "...", "baseUrl": "https://api.trae.cn", "time": "09:00", "timezone": "Asia/Shanghai", "retryCount": 2 },
  "enabled": true,
  "failCount": 0,
  "credentialInvalid": false,
  "lastResult": null,
  "lastError": null,
  "credits": null
}
```

### 5.3 前段动态渲染

- `GET /api/checkin/providers` 返回注册表 + 每个 provider 的 `configSchema`。
- 前端根据 `configSchema` **动态生成表单**，新增/编辑账号时按 provider 渲染字段。
- 新增 provider 不改前端代码（schema 驱动）。

## 6. 任务调度中心（lib/tasks/index.js）

- 遍历 `~/.monitor_data/checkin_tasks.json` 中 `enabled` 任务。
- 每个任务按 `provider.config.time + timezone` 用 vendor 的 `nextTriggerMs` 计算下次触发时刻，自递归 setTimeout。
- 到点调用 `providers[id].checkin(task)`，结果写日志 + 按需通知。
- 模块级 try/catch 保护：单个任务失败不断链。
- 现有 `checkProcs/checkProxy/checkDeviceAlerts` **本次不迁移**，避免回归；框架先跑通签到。

## 7. 凭证有效性检测 + 通知

### 7.1 判定：连续失败 N 次（默认 3，页面可配）

**例外（当天失败必通知）**：当天签到窗口已过且本次失败 → 立即通知，不受 N 次限制。

### 7.2 失败分类

| 类型 | 判定 | 处理 |
|---|---|---|
| 凭证无效（硬失败） | HTTP 401/403，或 message 含 token/invalid/未授权/登录过期 | 立即 `sendMail`，`credentialInvalid=true`，暂停该任务轮询 |
| 临时失败 | 网络超时 / 5xx / 非凭证类 | `failCount++`；当天失败立即通知；否则累计 N 次通知一次 |
| 成功 | `checked_in` 或领取成功 | 重置 `failCount=0`，记日志（默认不发邮件） |

### 7.3 通知主题

- `[告警] Trae 签到凭证无效`
- `[告警] Trae 签到失败（连续 N 次）`
- `[告警] Trae 今日签到失败`
- `[恢复] Trae 签到恢复`

### 7.4 防误报

沿用 notify.js「两阶段初始化」：任务首次启动只记录状态，第二次确认后再激活通知。

## 8. 30 天日志系统（lib/checkin-log.js）

- 存储：`~/.monitor_data/checkin_logs.json`（append 追加，滚动裁剪保留 30 天）。
- 记录结构：

```json
{ "taskId": "a1b2c3", "providerId": "trae", "date": "2026-08-15",
  "status": "success|fail|invalid|skipped", "credits": 200, "reward": 5,
  "error": null, "ts": 1726300000000 }
```

- API：
  - `GET /api/checkin/logs?days=30` → 按 taskId/date 分组。
  - `GET /api/checkin/logs?taskId=&days=30` → 单账号 30 天。
- 前端：每账号一个 30 天签到日历/表格（成功/失败/无效彩色标记）。

## 9. 积分查看

- `GET /api/checkin/tasks` 返回每账号 `credits`（来自上次 `getCredits`）。
- `GET /api/checkin/credits?id=` → 实时调用 `provider.getCredits(task)` 刷新。
- 前端展示每账号当前积分 + 最近 30 天积分变化。
- **依赖现状**：当前 `status()` 已返回 `credits`（余额），可直实现。**积分明细/趋势暂无**，需上游扩展。

## 10. API 汇总

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/checkin/providers` | provider 注册表 + configSchema（前端动态表单） |
| GET | `/api/checkin/tasks` | 账号列表（token 脱敏 + 积分） |
| POST | `/api/checkin/tasks` | 新增账号（按 providerId） |
| PUT | `/api/checkin/tasks?id=` | 更新账号 |
| DELETE | `/api/checkin/tasks?id=` | 删除账号 |
| POST | `/api/checkin/run?id=` | 手动立即签到 |
| POST | `/api/checkin/run-all` | 全部启用账号签到 |
| POST | `/api/checkin/test?id=` | 测试凭证有效性 |
| GET | `/api/checkin/credits?id=` | 实时查积分 |
| GET | `/api/checkin/logs?days=&taskId=` | 30 天日志 |

## 11. sync 脚本（脚本化同步）

新增 `sync-checkin.ps1`（部署前执行）：

```powershell
$dest = "d:\Code\Project\SSH\Honor 10\monitor\lib\checkin"
Copy-Item "D:\Code\Project\Nodejs\AutoCheckinTrae\src\checkin.js"   -Destination "$dest" -Force
Copy-Item "D:\Code\Project\Nodejs\AutoCheckinTrae\src\scheduler.js" -Destination "$dest" -Force
```

部署流程：`sync-checkin.ps1` → `deploy-remote.sh`（scp）→ 手机 restart monitor。

## 12. 需要改动/新增的文件清单

| 文件 | 动作 |
|---|---|
| `monitor/lib/checkin/checkin.js` | 新增（vendor） |
| `monitor/lib/checkin/scheduler.js` | 新增（vendor） |
| `monitor/lib/providers/index.js` | 新增（注册中心） |
| `monitor/lib/providers/trae.js` | 新增（Trae provider） |
| `monitor/lib/tasks/index.js` | 新增（调度中心） |
| `monitor/lib/checkin-log.js` | 新增（30 天日志） |
| `monitor/server.js` | 修改：注册 provider + 启动调度 + `/api/checkin/*` 路由 |
| `monitor/frontend/checkin.html` | 新增（provider 化页面） |
| `monitor/frontend/index.html` | 修改：导航栏加入口 |
| `sync-checkin.ps1` | 新增 |
| `deploy.ps1` / `deploy-remote.sh` | 修改：接入 sync |

## 13. 待确认点

1. **连续失败阈值 N**：默认 3，页面可配，是否 OK？
2. **积分需求范围**：仅需「当前余额」（现有接口即可），**还是**要「每日积分明细/趋势」（需改 AutoCheckinTrae 上游）？
3. **日志粒度**：30 天按天一条（成功/失败/无效），是否够？是否需要更多字段（如领取奖励数）？
4. **成功发通知**：默认不发，是否有某账号需要成功也通知？（已做成每账号可配 `notifyOnSuccess`）
5. **sync 脚本位置**：独立 `sync-checkin.ps1` 还是并入 `deploy.ps1`？

## 14. 部署/回滚

- 部署：跑部署脚本，手机 monitor 自动重启。
- 回滚：`monitor/lib/checkin/` 是生成物，重新 sync 旧版或 git 恢复。