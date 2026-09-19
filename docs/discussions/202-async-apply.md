---
feature_ids: [F101a]
related_features: [F101]
topics: [release, api-design]
doc_kind: discussion
created: 2026-09-19
---

# Discussion: apply 改 202 异步轮询模式的利弊

> Status: open · 关联 F101「已知限制」第一条

## 背景

当前 `POST /api/release/apply` 是同步接口：请求内完成「复制文件 → sv restart → 健康轮询 → 记账」后才返回。当 apply 包含 **gateway 自身**时，mod-release 重启 gateway 的瞬间，这次 HTTP 响应的传输通道（经 gateway 反代）被切断——浏览器 fetch 报网络错误，但后台流程实际继续跑完并成功。v1.0.2 实测复现两次。

## 202 异步模式是什么

把 apply 拆成两步：

```
POST /api/release/apply  {"tag":"v1.0.2"}
  → 202 Accepted  {"taskId":"ab12cd","statusUrl":"/api/release/tasks/ab12cd"}
     （mod-release 立即开跑后台任务，响应先于任何重启返回）

GET /api/release/tasks/ab12cd   ← 前端每 1.5s 轮询
  → {"state":"running|done|failed","steps":[{module:"gateway",copied:11,healthy:true},…],"error":null}
```

关键约束不变：apply 的**响应**必须在任何 `sv restart` 之前发出——只要任务 ID 先返回，gateway 死活都不影响轮询（轮询直接打 :3084 的 mod-release，不经 gateway 反代；面板 fetch 已同源代理，也可直连同源 `/api/release/tasks/...`——注意若 gateway 被重启，轮询要容忍短暂 502 并继续重试）。

## 优点

1. **消除"假失败"**——面板不再把成功的 apply 显示为网络错误，用户不必"看到报错再刷新确认"；
2. **过程可视化**——轮询响应可携带逐步进度（哪个模块已复制/已重启/健康与否），前端可渲染成进度条，而不是黑盒等几十秒；
3. **超时免疫**——同步模式下模块多、健康轮询慢时可能撞上代理/浏览器超时；异步后任务在服务端跑多久都行；
4. **串行化防护更容易**——任务表天然记录"进行中"，第二个 apply 请求可直接 409 拒绝，避免并发 apply 互相踩；
5. **为批量/组合发布铺路**——未来"一次 apply 两个模块按依赖顺序 two-phase"在任务模型里是自然表达。

## 代价 / 风险

1. **复杂度 +**：mod-release 要维护任务表（内存 Map + 落盘即可，重启后标记 interrupted）、状态机（running/done/failed/interrupted）、清理策略（保留最近 20 个任务）；
2. **前端改造**：release.html 的 apply/rollback 改为「发起 → 轮询 → 渲染进度」三段，约 +60 行 JS；
3. **轮询通道在 gateway 重启窗口会 502**：需要前端容忍（重试 3~4 次 × 1.5s 即可覆盖 ~6s 重启窗口），或干脆让面板 fetch release 相关接口时直连 `http://127.0.0.1:3084`（仅手机本机浏览器场景，公网用户仍走反代 + 重试）；
4. **幂等语义要想清楚**：同一 tag 重复 apply 应允许（文件相同幂等），但并发 apply 要拒绝——用任务表判断即可；
5. **回滚是否也异步**：回滚同样会重启 gateway，建议同任务模型一起改，一次到位。

## 结论与建议

值得做，但不是现在阻塞项：当前"假失败"有明确恢复路径（刷新页面看状态），且 apply 频率极低（发版才有）。建议排到下次功能迭代一起做（连同 rollback 异步化），工作量估计：mod-release +80 行、release.html +60 行、无 schema 变更。触发条件：当"面板显示失败但实际成功"造成过一次真实误操作（如重复 apply 或误回滚），立即提优先级。
