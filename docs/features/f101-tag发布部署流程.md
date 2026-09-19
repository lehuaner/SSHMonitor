---
feature_ids: [F101]
related_features: [F100]
topics: [release, deployment, workflow]
doc_kind: spec
created: 2026-09-19
---

# F101: tag 发布部署流程（B 模式两段式）

> Status: implemented (v1.0.5，上游版本检测已上线；202 异步 apply；manifest 变更需重启 mon-release 已确认) · Owner: Honor

## Why

monitor 部署在手机 Termux，此前用 scp 手工拷文件 + 全量重启：任何小改动都要重启整个服务，签到/监控互相牵连，也没有版本记录和回滚手段。P1 已拆出 gateway + mod-checkin + mod-release 三进程；本文固化 P2 的标准发布流程，作为日常发版与故障恢复的唯一参考。

## 流程总览（日常发版三步）

```
① 开发   改代码（Windows 工作副本 D:\Code\Project\SSH\Honor 10\monitor）
② 发布   git commit → git tag -a vX.Y.Z → git push origin main --tags
         → release-watch.ps1 自动 staging（或手动：.\release-watch.ps1）
③ 应用   面板「发布」页点「应用此版本」（或 curl POST /api/release/apply）
         → 失败时：面板点「回滚上一版本」（或 POST /api/release/rollback）
```

前端（CF Pages）单独走 `.\deploy.ps1 frontend`，tag 流程只提示不代发。

## 阶段零：上游版本检测（v1.0.5 起，手机端自主）

职责划分：**Windows 侧只负责发布**（commit/tag/push + staging 把文件推上手机），
「GitHub 上有没有新版本」由手机端自己拉 API 判断（不依赖 PC 在线，也不做 Windows 计划任务）。

| 项 | 位置 / 端点 |
|---|---|
| 检测配置 | `~/.monitor_data/release_config.json`（repo / token / tagPattern / intervalMin / listSize / enabled） |
| 检测结果缓存 | `~/.monitor_data/upstream-version.json` |
| 读视图 | `GET /api/release/upstream`（tag 列表 + 本地 staged/applied 关联出的 state） |
| 立即检测 | `POST /api/release/upstream/check`（并发共享同一次检测，不会回退旧缓存） |
| 配置读写 | `GET/PUT /api/release/config`（token 永远脱敏，只回传 `••••末4位`） |
| 摘要 | `GET /api/release/status` 的 `upstream` 字段（latest / base / behindCount / pendingStaging / checkError） |

调度：启动 12s 后首检 + `intervalMin`（默认 30，下限 5）轮询；改配置后立即重排程并触发一次检测。
审计只在「发现新 tag」时记 `upstream:new-tag`，不刷屏。

**私有仓库必须配只读 token**（实测匿名访问 `api.github.com/repos/lehuaner/SSHMonitor/tags` → 404）：
GitHub → Settings → Personal access tokens → Fine-grained → 只勾 `Contents: Read-only`，
在面板「发布 → 检测设置」里填一次（只写不读，留空不覆盖）。
不配 token 时面板会显式提示「无 token（仅公开仓库可检）」，不会谎报「已是最新」。

前端（release.html）三态区分得很清楚，避免“有更新但应用不了”的歧义：

- `待 staging`（warn）：上游有 tag、手机无档案 → 要去 PC 跑 `.\release-watch.ps1 -Tag vX`
- `可应用`（ok + 行内按钮）：已 staging，直接 apply
- `当前 / 旧版本`（muted）

落后数 > 0 时页头显示 `+N 个新版本` 带红点，并把浏览器标签改成 `(N 待更新) 发布`。

**“是否已应用”按受影响模块判定**（v1.0.6）：读 staged meta 的 `affectedModules`，只要求
其中有部署记录的模块（frontend/CF_PAGES 不参与）都 ≥ 该 tag；未 staging 的 tag 不知道影响面 →
保守按全部模块。否则像“只发 release 模块”的 v1.0.5（gateway/checkin 记账仍是 v1.0.4）会被永远
报成“可应用 + 落后 1 个”，红点长亮不灭。比 `base`（各模块最低 tag）更老的一律归为旧版本。

## 阶段一：staging（PC 侧 release-watch.ps1，线上零影响）

| 步骤 | 动作 | 失败行为 |
|---|---|---|
| 发现 | `git ls-remote --tags` 找未部署/staging 的新 tag（semver 最新） | 无新 tag 直接退出 |
| 变更计算 | `git diff --name-only <deployed_sha>..<tag>` ∩ release-manifest.json → affectedModules | 无基线 → 视为全量 |
| 导出 | `git archive <tag> -- <manifest 文件>`（PC 无临时文件）→ scp → 手机 `~/releases/<tag>/files/` | scp 失败即中止 |
| 门禁 | 手机端对所有 staged .js 跑 `node --check` | 语法错误即中止 |
| 记录 | `meta.json`（tag/sha/stagedAt/affectedModules/fileCount，base64 传输） | — |

staging 完成后线上不受任何影响；`stage.tar.gz` 保留在 release 目录作为档案。

## 阶段二：apply（手机侧 mod-release :3084，经 gateway 反代）

`POST /api/release/apply {"tag":"vX.Y.Z","modules":["gateway","checkin",...]}`（modules 缺省用 meta.affectedModules）：

1. 读 `~/releases/<tag>/meta.json` 校验存在；
2. 按 manifest 逐模块复制文件（CF_PAGES 条目跳过并提示走 deploy.ps1）；
3. 该模块 `sv restart <service>` → 轮询 `/healthz`（≤15s）；
4. 全部成功 → 写 `~/.monitor_data/deployed-version.json`（每模块 tag/sha/appliedAt）+ 审计 JSONL；
5. 任一模块失败 → **停止后续模块，已复制文件自动回滚**（重新复制该 release 目录内旧文件并重启），审计记 `apply:fail`。

## 回滚

`POST /api/release/rollback {}`（默认回滚到比当前早的最近 release；`{"tag":"v1.0.0"}` 指定）：按 manifest 全量恢复该 release 内文件 → 各模块重启 → 健康验证 → 记账 + 审计。前提：目标 release 已在 `~/releases/` 常驻（staging 过就会一直在，无自动清理）。

## 接口速查（经 gateway :3081，路径前缀 /api/release）

| 端点 | 用途 |
|---|---|
| GET `/status` | deployed 各模块版本 + releases 列表 + manifest 模块名 |
| GET `/audit` | 最近 200 条发布事件（倒序） |
| POST `/apply` | 应用 release（body: tag, modules?） |
| POST `/rollback` | 回滚（body: tag?） |

前端入口：面板顶部「🚀 发布」标签（release.html）；PC 入口：`release-watch.ps1 [-Tag vX.Y.Z] [-Watch]`。

## 版本与文件位置

| 项 | 位置（手机） |
|---|---|
| 运行代码 | `~/monitor/`（runit 服务 server / mon-checkin / mon-release，端口 3081/3083/3084，全绑 127.0.0.1） |
| 发布档案 | `~/releases/<tag>/`（files/ + meta.json + stage.tar.gz） |
| 版本记账 | `~/.monitor_data/deployed-version.json` |
| 审计 | `~/.monitor_data/release_audit.jsonl` |
| 模块清单 | `~/monitor/release-manifest.json`（新增模块需同步登记） |

## 已知限制与注意事项

- **改了 `release-manifest.json` 必须先 `sv restart mon-release` 再 apply**（v1.0.4 实测）：
  mod-release 在进程启动时 `readFileSync` 读一次 manifest（`const MANIFEST = …`），
  不重启就 apply 会用**旧清单**复制文件 → 新增的文件根本不会被部署（不报错，静默漏）。
  验证方法：看 apply 结果里 `copied` 数量与 manifest 条目数是否对得上。
- **apply 包含 release 模块时，mod-release 自重启会吹掉内存任务**（文件已复制但记账/审计中断）——
  拆成两次调用：先 `modules:["gateway","checkin"]`，再 `modules:["release"]`，
  第二次预期任务丢失 → 比对 staged 与 live 文件 sha256 一致后**手工补记账**
  （写 `deployed-version.json` 的 `modules.release` + 追一条审计）；
  审计行字段统一用 `ts`（ISO 串），不要写 `at`（毫秒）——面板与历史条目都是 `ts`。
- **apply 含 gateway 时 HTTP 响应会被自身重启切断**（面板显示网络错误但实际成功）——202 异步模式已解；
  请求直接发给 :3084（mod-release）而不走 gateway 时，连这个影响也没有；
- apply 是异步任务，进模块多时耗时 = Σ(复制 + 重启 + 健康轮询)，最长可到数十秒；
- `deploy.ps1 frontend` 与 tag 流程互相独立：前端发版不产生手机端 release；
- 首次在新机器使用需先手工部署一次基线（update-modules.ps1）并写入 deployed-version.json；
- manifest 是发布的唯一依据：**新增/移动文件必须同步改 release-manifest.json**，否则该文件不参与发布与回滚；
- **manifest 必须登记所有发布文件，新增文件要同步补条目**：v1.0.5 发现 `frontend/release.html`（v1.0.2 引入）
  从来没登记过 → `git archive` 的 staging tar 里根本不含它（虽然前端实际走 deploy.ps1 未受影响）。
  改完文件跑一下「manifest 文件数 vs 目录实际文件数」对账；
- **release-watch.ps1 解析远程 JSON 必须 UTF-8 解码**（v1.0.5 踩过）：PowerShell 默认按本地代码页（GBK）
  解码 ssh 字节流，`deployed-version.json` 里只要有中文（如补记账的 note）就 `Unterminated string`，
  进而 `deployedSha` 取不到 → 静默退化成「全量 affected」。已修：脚本顶部强制
  `[Console]::OutputEncoding = UTF8` + 解析失败/无基线都打 `[warn]`；staging 跳过条件收紧为
  「sha + affected 均一致」，基线修正后重跑即可自动纠正 meta.json；
- **禁止绕过 tag 直接 scp 上线**（v1.0.4 踩过）：线上会跑成“无版本记录的代码”，下一次 apply/回滚
  会把它静默覆盖回去。临时验证可以，但收尾必须补 commit + tag + staging + apply，
  并用 `sha256sum` 比对 live 与 staged 文件确认一致。

## 发布记录

| tag | 日期 | 主要内容 | 受影响模块 | 结果 |
|---|---|---|---|---|
| v1.0.6 | 2026-09-19 | fix：上游 applied 按受影响模块判定 | release | apply [release] 成功（自重启丢任务 → sha256 SAME → 补记账）；release=v1.0.6 |
| v1.0.5 | 2026-09-19 | 上游版本检测（手机直连 GitHub API）+ 前端面板；补登记 release.html | release, frontend | apply [release] 成功（自重启丢任务 → sha256 核对 SAME → 补记账）；前端 deploy.ps1 上线；release=v1.0.5、gateway/checkin=v1.0.4 |
| v1.0.4 | 2026-09-19 | OfficeAce 签到 Provider（纯协议登录）+ tasks 接口凭证脱敏 | checkin, gateway, release | apply 成功（gateway 11 / checkin 18 文件 healthy）；release 模块自重启丢任务 → sha256 核对后补记账；三模块 deployed=v1.0.4 |
| v1.0.3 | 2026-09-19 | 202 异步 apply/rollback + 地区候选 + 订阅刷新 | gateway, release, checkin | 同上（手工 reconcile） |
| v1.0.2 | 2026-09-19 | 版本管理面板 release.html | gateway, release, frontend | 成功 |
| v1.0.1 | 2026-09-19 | P2 发布流水线自身 | gateway | 成功 |
| v1.0.0 | 2026-09-19 | P1 模块化基线（gateway + mod-checkin） | gateway, checkin | 成功（基线） |

## Open Questions

- [x] F101a: apply 改 202 异步任务模式（v1.0.3 已上线；discussion：202-async-apply.md）。★已知特例：apply 包含 release 模块自身时，mod-release 自重启会中断内存任务（文件已复制但记账/审计需 reconcile）——后续考虑任务落盘或拆批。
- [x] F101b: release-watch -Watch 挂 Windows 计划任务（5 分钟自动 staging）——**取消**：
  职责改为「Windows 只管发布、版本检测由手机自主」（v1.0.5 已实现），不再需要 PC 常开巡检；
  staging 仍在发布时手动/随 push 跑一次即可。
- [ ] F101c: releases/ 保留策略（当前永久保留；建议保留最近 5 个 + 磁盘水位清理）
- [ ] F101d: 上游检测只存 tag+sha，拿不到 annotated tag 的发布说明（现在靠 commits 首行）；
  若以后用 GitHub Release 写 changelog，可改拉 `/releases/latest` 的 body 展示
