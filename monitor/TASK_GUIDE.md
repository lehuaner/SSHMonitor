# Honor10 监控系统 - 功能增强任务指南 (v2.0)

## 一、文件页面交互改进

### 需求
- [ ] 非目录文件行添加 `file-row` 类，支持点击整行打开编辑器
- [ ] 鼠标悬停时显示指针样式 + 蓝色背景高亮
- [ ] 文件行添加 `title="点击编辑 文件名"` 提示
- [ ] hover 时文件名右侧浮现 `✎ 编辑` 标识
- [ ] 按钮点击使用 `event.stopPropagation()` 防止触发行点击事件

### 涉及文件
- `frontend/files.html` — **已完成**

---

## 二、代理连通性检测 — 多网站 + 重试 + 间隔

### 配置结构变更

```javascript
proxy_check: {
  enabled: false,
  test_urls: ['https://www.google.com', 'https://www.baidu.com'],  // 多检测目标
  retry_count: 2,          // 每个 URL 失败后的重试次数
  retry_delay: 3000,       // 重试间隔（毫秒）
  check_interval: 10,      // 检测间隔（分钟），默认 10 分钟
  candidate_nodes: [],     // 候选节点列表（用户选中）
}
```

### 需求
- [ ] `test_url`（单字符串）改为 `test_urls`（字符串数组），兼容旧格式自动转换
- [ ] **只检测候选节点列表中的节点**，非候选节点不检测连通性
- [ ] 非候选节点只记录平均延迟（从 sing-box API 的 delay 数据获取）
- [ ] 每个 URL 失败后自动重试 `retry_count` 次（默认 2），间隔 3 秒
- [ ] 所有 URL 全部连通成功才算 `ok = true`
- [ ] 前端 UI 支持增删改检测 URL
- [ ] 前端 UI 支持设置重试次数
- [ ] 前端 UI 支持设置检测间隔（分钟）
- [ ] 检测间隔配置持久化到 `mail_config.json`

### 涉及文件
- `lib/notify.js` — `proxy_check` 配置、`checkProxy()` 重试逻辑
- `lib/utils.js` — 配置默认值
- `frontend/notify.html` — 前端 UI（URL 管理、重试设置、间隔设置）
- `server.js` — 保存配置的接口

---

## 三、检测日志

### 需求
- [ ] 每次检测结果写入 `~/.monitor_data/proxy_check.log`
- [ ] 日志格式：每行 JSON `{timestamp, urls: [{url, status, latency, retries}], ok, retry_count, switched}`
- [ ] 新增 API `GET /api/proxy-check-logs` 返回最近 100 条
- [ ] 前端通知页面新增"检测日志"区域，默认折叠
- [ ] 日志展示：时间、每个 URL 状态码和延迟、是否切换节点

### 涉及文件
- `lib/notify.js` — 日志写入
- `server.js` — API 路由
- `frontend/notify.html` — 前端折叠日志展示

---

## 四、本地 API 接口（供其他服务调用）

### 需求
外部服务遇到代理问题时，可调用本地接口触发检测并切换：

```
POST /api/proxy-check/run
  → 立即执行一次连通性检测
  → 如当前节点异常，自动切换候选节点
  → 返回: { ok, current_node, all_ok, switched, details }

GET /api/proxy-check/status
  → 返回当前状态
  → 返回: { ok, current_node, last_check, candidate_nodes, check_interval }

POST /api/proxy-check/set-node?node=xxx
  → 手动切换到指定候选节点
  → 返回: { ok, node }
```

### 调用方式
```
# 服务调用示例（curl）
curl -X POST http://127.0.0.1:3081/api/proxy-check/run

# 返回
{
  "ok": true,
  "current_node": "香港_01",
  "all_ok": true,
  "switched": false,
  "last_check": "2026-07-15T12:00:00.000Z"
}
```

### 涉及文件
- `server.js` — 三个新路由
- `lib/notify.js` — 导出 `runProxyCheck()` 函数

---

## 五、节点候选与自动切换

### 需求
- [ ] `proxy_check.candidate_nodes` 存储用户选中的候选节点名
- [ ] 周期性检测只测试候选节点列表中的节点
- [ ] 当检测发现当前节点异常时：
    1. 在所有候选节点中运行连通性检测
    2. 通过检测的节点按权重评分排序
    3. 选择最高分节点
    4. 通过 sing-box Clash API `PUT /proxies/节点选择` 切换
    5. 发送切换通知邮件
- [ ] 前端可管理候选节点列表（从 sing-box 代理列表中选择）
- [ ] 候选节点列表持久化到 `mail_config.json`

### 涉及文件
- `lib/notify.js` — `switchNode()`, `runProxyCheck()`
- `server.js` — 节点列表 API
- `frontend/notify.html` — 候选节点选择 UI

---

## 六、节点权重算法

### 权重公式

| 因子 | 权重 | 说明 |
|------|------|------|
| 用户选中 | 0.5 | **候选节点**统一加 0.5；非候选节点该项为 0 |
| 近24h 连通率 | 0.3 | 近 24 小时检测成功次数 / 总检测次数（仅候选节点有数据，非候选节点该项为 0） |
| 平均延迟 | 0.2 | `max(0, 1 - avg_latency / 2000)` —— 延迟越低分越高 |

**分值范围**：
- 候选节点：0~1.0（三因子全参与）
- 非候选节点：0~0.2（只有延迟分，其他两项为 0）

### 数据来源
- **用户选中**：从 `proxy_check.candidate_nodes` 列表判断
- **连通率**：检测日志中统计近 24 小时该节点的成功/总次数
- **延迟**：通过 sing-box API `GET /group/节点选择/delay` 获取

### 需求
- [ ] 实现 `calculateNodeWeight(node, candidates, stats)` 函数
- [ ] 节点权重数据不单独持久化（从检测日志实时计算）
- [ ] 每次切换时按权重排序选择最优

### 涉及文件
- `lib/notify.js` — 权重计算函数

---

## 七、日志文件归类与轮转

### 现状
根目录散落 16 个日志文件，分属 5 类：

| 分类 | 当前文件 | 来源 |
|------|----------|------|
| Cloudflare | `cf.log`, `cf_dl.log`, `cf_dl2.log`, `cloudflared.log`, `tunnel.log` | cloudflared 隧道 |
| Sing-box | `sb.log`, `singbox.log` | sing-box 运行 |
| Monitor | `monitor.log`, `monitor_err.txt` | monitor 服务器 |
| Subscriber | `sub.log` | 订阅更新脚本 |
| Netdata | `netdata-extract.log`, `netdata.log`, `nd.log`, `nd.out`, `nd.err`, `nd-test.log` | netdata 安装/运行 |

### 需求
- [ ] 创建 `~/logs/` 目录，下设分类子目录：`cloudflare/`、`singbox/`、`monitor/`、`subscriber/`、`netdata/`
- [ ] 将现有日志文件移入对应的分类子目录
- [ ] 修改以下脚本，将日志写入新路径：
  - `subscriber-loop.sh`：`~/sub.log` → `~/logs/subscriber/sub.log`
  - `start-all.sh`：无日志文件，但 `&>/dev/null` 改为 `&>~/logs/startup.log`
  - `watchdog.sh`：`~/.monitor_data/watchdog.log` → `~/logs/monitor/watchdog.log`
- [ ] monitor 服务器新增日志轮转函数 `lib/logger.js`，规则：
  - 日志文件超过 5MB 且**最后修改日不是今天** → 重命名为 `.YYYY-MM-DD.log`，创建新文件
  - 日志文件超过 5MB 但**最后修改日是今天** → **不轮转**（当天日志不跨文件）
  - 日志文件未超过 5MB → 直接追加
- [ ] 日志轮转应用于：
  - `~/logs/monitor/monitor.log` — 服务器标准输出
  - `~/logs/monitor/error.log` — 服务器错误输出
  - `~/logs/monitor/proxy_check.log` — 代理连通性检测日志

### 涉及文件
- `lib/logger.js` — **新增**，日志轮转函数
- `lib/notify.js` — 检测日志写入路径改为新位置
- `subscriber-loop.sh` — 修改日志路径
- `start-all.sh` — 修改日志路径
- `watchdog.sh` — 修改日志路径
- `frontend/notify.html` — 前端日志读取路径同步

---

## 八、实施优先级与依赖关系

```
P0 [文件页面改进] — 无依赖，✅已完成
P0 [日志归类与轮转] — 无依赖，可先实施
P0 [多网站 + 重试 + 间隔] — 基础检测能力增强
P1 [检测日志] — 依赖检测逻辑
P1 [本地 API 接口] — 依赖检测与切换逻辑
P2 [节点候选与自动切换] — 依赖候选配置和权重算法
P2 [节点权重算法] — 依赖检测数据和候选列表
```

---

## 九、预期文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `lib/logger.js` | **新增** | 日志轮转工具函数 `writeLog()`、`rotateLog()` |
| `lib/notify.js` | **大幅修改** | 重写 `checkProxy()`：多网站、重试、日志、候选节点检测、权重、切换；新增 `runProxyCheck()`、`switchNode()`、`calculateNodeWeight()` |
| `lib/utils.js` | 修改 | `mailConfig` 默认值更新 |
| `server.js` | 修改 | 日志初始化、新增 `GET/POST /api/proxy-check/*` 三个路由 |
| `frontend/notify.html` | **大幅修改** | URL 管理 UI、重试/间隔设置、候选节点选择、检测日志展示 |
| `frontend/files.html` | 修改 | **已完成** |
| `subscriber-loop.sh` | 修改 | 日志路径更新 |
| `start-all.sh` | 修改 | 日志路径更新 |
| `watchdog.sh` | 修改 | 日志路径更新 |

---

## 十、日志轮转逻辑（核心）

```javascript
function writeLog(filePath, content, maxSize = 5 * 1024 * 1024) {
  // 1. 检查文件是否存在及大小
  // 2. 如果 > maxSize:
  //    a. 获取文件最后修改日期
  //    b. 如果最后修改日 ≠ 今天 → 重命名为 file.YYYY-MM-DD.ext
  //    c. 如果最后修改日 == 今天 → 不轮转，直接追加
  // 3. 追加内容到文件
}
```

---

## 十一、数据流概览

```
┌─────────────────────────────────────────────────────────────┐
│  定时器 (check_interval 分钟)                                │
│     ↓                                                        │
│  checkProxy()                                                │
│     ↓                                                        │
│  对每个候选节点:                                              │
│     → 对每个 test_url 发起 curl (经过代理)                    │
│     → 失败则重试 retry_count 次                               │
│     → 记录延迟和状态码                                        │
│     ↓                                                        │
│  每个节点所有 URL 全部通过?                                           │
│     ├─ Yes → 对于每个节点记录 ok=true                                     │
│     └─ No  → 对于每个节点记录 ok=false                                    │
│              → 按权重选最优候选节点                             │
│              → 通过 Clash API 切换                              │
│              → 发送通知邮件                                    │
│     ↓                                                        │
│  写入检测日志 (writeLog) → 更新 nodeStatusCache                │
└─────────────────────────────────────────────────────────────┘

外部服务请求:
┌──────────────────────────────────────────┐
│  POST /api/proxy-check/run               │
│     → 同 checkProxy() 逻辑                │
│     → 返回 { ok, current_node, switched } │
└──────────────────────────────────────────┘

日志轮转:
┌──────────────────────────────────────────┐
│  writeLog(path, content)                  │
│     → 文件 > 5MB 且非今日?                │
│        ├─ Yes → 重命名 file.2026-07-15.log│
│        └─ No  → 直接追加                  │
└──────────────────────────────────────────┘
```

---

以上是修正后的任务指南，请你审阅。主要改动：
1. 连通性检测**只检测候选节点**，非候选节点只记延迟
2. 新增**检测间隔设置**（默认 10 分钟）
3. 权重公式：候选节点统一 +0.5，非候选节点该项为 0
4. 新增**三个本地 API** 供其他服务调用
5. 新增**数据流概览**说明整体流程

有需要调整的吗？