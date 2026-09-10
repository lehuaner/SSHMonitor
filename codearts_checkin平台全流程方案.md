# 新增 CodeArts（码道 Agent）checkin 平台 · 开发文档

> 产出：接口清单与字段定义 / 展示面板 Provider 数据结构 / 交互流程 / 改造清单 / 关键接口可用性实测
> 输入源：`examples/codearts_解析结果`（HTTP 抓包解析，86 条，主域 `codearts.huaweicloud.com`）
> 原始抓包：`examples/codearts.saz`（560KB，2026-09-08 09:15 GMT 采集，Edge 152 / Windows）
> 姊妹文档：`checkin平台全流程方案.md`（WorkBuddy 侧，同构设计，可对照阅读）
> 实测日期：2026-09-10 ｜ 文档版本：v1.0

---

## 0. 背景与目标

在「展示面板」中新增一个 **CodeArts checkin Provider**，数据来自华为云 CodeArts（码道 / CodeArts Agent）的每日积分领取体系。工作要求：

1. 梳理 CodeArts 签到所需的**全部接口清单及字段定义**（来源 = CodeArts 抓包）；
2. 定义展示面板**新增 Provider 所需的数据结构与字段**；
3. 复用 WorkBuddy/Trae 已有的 `CheckinProvider` 骨架，仅替换域名/路径/凭据字段；
4. 对关键接口做**可用性实测**，把过程与结果写入本文档。

**结论先行**：CodeArts 的签到体系与 WorkBuddy/Trae **结构最简**——它没有「连续签到天数 / 热力图 / 补签卡 / 抽奖」五件套，只有一对接口：

```
GET  /portal/snap-manager/v1/credit/has-claimed   → 今日是否已领取（原始 JSON 布尔）
POST /portal/snap-manager/v1/credit/claim         → 领取每日签到积分 {"credit_type":"daily_bonus"}
```

因此 Provider 实现量最小；**主要复杂度在于鉴权形态与响应信封的不统一**（见 §1.3、§1.6）。

---

## 1. 全局约定

### 1.1 响应信封（★与 WorkBuddy 最大的差异：不统一）

CodeArts 各业务域的封装风格互不相同，**没有唯一信封**。Provider 必须按前缀分派解析器：

| 前缀 | 信封形态 | 示例 |
|---|---|---|
| `/portal/snap-manager/v1/credit/*` | **原始 JSON**（无包裹） | `false` / `true`（裸布尔） |
| `/portal/snap-manager/v1/*`（其余） | **原始 JSON 对象/数组** | `{ "team_roles":[], "enterprise_roles":["enterprise_admin"] }` |
| `/portal/dataflywheel/*` | `{ "code":200, "data":{…} }` | 见 §2.4 |
| `/portal/rest/bss/*` | **华为云 OpenAPI 风格** | `{ "error_code":"CBC.0000", "error_msg":"SUCCESS", "totalSize":1, "orderList":"…" }` |
| `/portal/rest/me` | **原始 JSON 对象** | 见 §2.6 |
| `/portal/DevCloudConsole/v3/*` | `{ "status":"success", "result":{…} }` | 见 §2.3 |
| `furiondata.myhuaweicloud.com/*` | `{ "status":"success", "result":… }` | 埋点/日志上报 |

**复用建议**：在 Provider 层实现 `normalizeEnvelope()` 时，**按 URL 前缀选择解析策略**（而非探测字段），把这五套统一成 WorkBuddy 侧的 `{ ok, code, message, requestId, data }`。注意 `totalSize`/`result` 等字段名与 WorkBuddy 完全不同，需单独映射。

### 1.2 域名

| 用途 | 域名 |
|---|---|
| 业务主域（Portal API） | `codearts.huaweicloud.com` |
| 埋点 / 数据上报 | `furiondata.myhuaweicloud.com` |
| 静态资源 CDN | `devcloud-res.hc-cdn.com` / `res.hc-cdn.com` |
| 前端页面 | `/portal/settings/personal-usage?locale=zh-cn`（签到入口所在地） |

### 1.3 鉴权形态（★关键）

CodeArts **纯 Cookie 会话 + WAF 令牌**，无 Bearer / 无 OAuth 头：

| 项 | 内容 |
|---|---|
| 主凭据 | Cookie：`SessionID`、`cbc-sid`、`vk`、`devclouddevuibjJ_SESSION_ID`、`SID=Set2`、`user_tag`、`domain_tag`、`ua` |
| WAF 令牌 | `cftk: 4H4S-HCUU-C7LO-75CZ-…`（★**同时**出现在 **cookie** 与 **请求头** 中，两者都要带） |
| 浏览器校验 | Cookie `browserCheckResult=A`、`cfLatestRecordTimestamp=<ms>` |
| 必需请求头 | `x-requested-with: XMLHttpRequest`、`language: zh-cn`、`x-language: zh-cn`、`content-type: application/json`、`referer: …/personal-usage?locale=zh-cn` |
| 无 | 无 `Authorization`、无 CSRF token（`_`/时间戳查询参数仅为缓存击穿） |

> **注意**：`user_tag` 与 `domain_tag` 分别对应 `userId` 与 `domainId`（见 §2.6 `rest/me`），可用于快速识别账号身份。

### 1.4 全局常量
- `regionId = "cn-north-4"`（华北-北京四）
- `Endpoint = "CodeArtsAgentPortal"`（响应头）
- 积分单位：`credits`（响应中记作 `package_credit_*`）
- 签到类型枚举：`credit_type` 观测到唯一值 **`daily_bonus`**
- 租户/身份标识：
  - `tenantId`（domainId）= `0d2a3a0cc500f3060f0dc00096bca220`
  - `projectId` = `0d2a3bba3a00f2ab2fcbc000fba927b8`
  - `userId` = `0d2a3a0dae80f58a1f92c0000c3a3de6`

### 1.5 会话时效
抓包于 2026-09-08，**2026-09-10 实测已失效**（详见 §6.3）。CodeArts 的 Cookie 会话寿命较短（小时~天级），且失效表现**非常隐蔽**（见下）。

### 1.6 ★★ 关键坑：登录态失效不改 HTTP 状态码

这是本平台**最容易踩的坑**，必须写进 Provider：

```
HTTP/1.1 200 OK
...
HW-AJAX-REDIRECT: https://auth.huaweicloud.com/authui/login?service=
```

- 登录态失效时，服务端返回 **HTTP 200 + 空响应体**，
  仅通过响应头 `HW-AJAX-REDIRECT` 下发登录地址，另有响应头 `Rf` 由 `service` 变为 `cf2`。
- **只看 HTTP 状态码会把「未登录」误判为「成功但无数据」**（2026-09-10 实测：5 个接口全部 HTTP 200，实际全部未登录）。
- Provider 的错误归一化必须**优先检查 `HW-AJAX-REDIRECT` 头**（等价于 401），命中即触发重新登录并标记 `credentialInvalid=true`。
- 附：**未带 Cookie** 请求同样返回 HTTP 200 + 空体 + `HW-AJAX-REDIRECT`（不会返回 401/403），因此**无法用状态码区分「无凭证」与「凭证过期」**。

### 1.7 查询参数约定
所有 GET 接口带 `?_=<unix_ms>`（缓存击穿）。**必带**，否则可能命中 CDN 缓存；值可用当前毫秒时间戳。

---

## 2. 接口清单及字段定义

> 共 **19 个业务端点**（签到 2 + 积分套餐 5 + 用量分析 4 + 计费订单 2 + 用户权限 5 + 页面 1）+ 4 个埋点端点。

### 2.1 签到核心接口（Provider 必接，共 2 个）

#### ① `GET /portal/snap-manager/v1/credit/has-claimed?_=<ms>` —— 今日是否已领

| 项 | 内容 |
|---|---|
| 请求 | 无 body；带 §1.3 全部头与 cookie |
| 响应 | **原始 JSON 布尔**：`false`（未领） / `true`（已领） |
| 抓包实证 | capture 017 → `false`；capture 063（约 7.7s 后）→ `true` |
| 说明 | 每次进入 `/portal/settings/personal-usage` 都会调用，是**签到按钮的显隐依据** |

> ⚠️ 响应是**裸布尔**，不是 `{"data":false}`。`json.loads` 后直接得到 Python `bool`；判空时注意 `False` 与「请求失败」的区别（后者见 §1.6 的 200 空体）。

#### ② `POST /portal/snap-manager/v1/credit/claim` —— 领取每日签到积分 ★写

| 项 | 内容 |
|---|---|
| 请求头 | `content-type: application/json`、`origin: https://codearts.huaweicloud.com` + §1.3 全部 |
| 请求体 | ```{ "credit_type": "daily_bonus" }``` |
| 响应 | **原始 JSON 布尔** `true` = 领取成功 |
| 抓包实证 | capture 036 → `true`（2026-09-08 09:15:24 GMT，Content-Length: 30） |

**语义与幂等性**：
- 该接口是**每日一次**的领取动作，服务端按 `credit_type=daily_bonus` + 当日日期去重。
- 重复调用预期返回 `false` 或错误（**本次未实测**，因凭证已失效，见 §6.3）→ Provider 应在调用前先查 `has-claimed`，避免依赖二次调用的返回语义（**先读后写**，与 WorkBuddy 不同：WorkBuddy 靠 `code:10001` 拒绝，CodeArts 靠前置查询）。
- 响应**不返回发放的积分数量**。要拿到积分余额需另查 §2.2 `package_overview`（与 WorkBuddy 的 `daily-checkin` 直接返回 `credit:100` 不同）。

**推荐调用序列**：
```
GET  /credit/has-claimed      → false ?
POST /credit/claim  {credit_type:"daily_bonus"}  → true
GET  /credit/has-claimed      → true   (确认翻转)
GET  /package_overview        → 读取最新积分余额
```

### 2.2 积分与套餐接口（Provider 展示用，共 5 个）

#### `GET /portal/snap-manager/v1/package_overview?_=<ms>` —— ★积分总额来源
响应（原始 JSON）：
| 字段 | 含义 | 实测值 |
|---|---|---|
| `all_credit_package.package_credit_amount` | 总积分额度 | 4500.0 |
| `all_credit_package.package_credit_used` | 已用 | 0.0 |
| `all_credit_package.package_credit_remain` | **剩余可用** | 4500.0 |
| `all_credit_package.package_credit_user_amount/used/remain` | 当前用户维度额度 | 4500 / 0 / 4500 |
| `all_credit_package.expiring_credit_amount` | 即将过期 | 0 |
| `basic_package` | 基础套餐（含 `enable`, `resource_id`, `spec_code`, `package_amount`, `package_used_count`, 同名 credit 三件套） | `enable:true`, credit 500 |
| `bonus_credit_package` | 赠送包 | 4000.0 |
| `ondemand_credit_package` | 按需包 | `null` |
| `model_package` | 模型包 | `[]` |

> `all_credit_package` = `basic_package`(500) + `bonus_credit_package`(4000) = 4500，校验一致。
> **Provider 的「当前积分」应取 `all_credit_package.package_credit_remain`。**

#### `GET /portal/snap-manager/v1/package_info?_=<ms>` —— 套餐状态
```json
{ "enable": true, "resource_id": "fa64939fc6ae40fd9c80edac79e6b444",
  "spec_code": "codearts.agent.individual.trial", "status": "normal" }
```

#### `GET /portal/snap-manager/v1/maas/package_info_all?_=<ms>` —— 套餐明细（数组）
返回 `[{ charge_type, package_list:[{ id, domainId, domainName, userId, region, resourceId, specCode, resourceStatus, serviceName, factor, amount, createdTime, … }] }]`。用于展示套餐/资源明细。

#### `GET /portal/DevCloudConsole/v3/<tenantId>/package/detail?page_size=…` —— 订单式套餐列表
```json
{ "status": "success",
  "result": { "total": 1, "list": [ { "resource_id": "fa64939…", "name": "CodeArts Agent",
    "order_id": "CS2609081702KQW88", "product_id": "OFFI1296473119762554880",
    "buy_time": "2026-09-08 17:02:05", "region_id": "cn-north-4",
    "auto_renew": "yes", "status": "normal",
    "resource_type_code": "hws.resource.type.codearts.snap",
    "resource_type_name": "码道代码智能体" } ] } }
```

#### `GET /portal/snap-manager/v1/users/user-license/<userId>?_=<ms>` —— 许可证
```json
{ "userId": "0d2a3a0dae80f58a1f92c0000c3a3de6",
  "licenseDetail": { "doer-enterprise": false, "coding": true, "doer-pro": false } }
```

### 2.3 用量分析接口（可选接，共 4 个）

> 这批接口提供**使用热力图与趋势**，可做「面板里的活动日历」。注意：这是**用量（token/请求）热力图**，**不是签到热力图**——CodeArts 不提供签到日历。

#### `POST /portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/heatmap`
```json
// 请求（一年跨度 → 365 格）
{ "startDate": "2025-09-08", "endDate": "2026-09-08",
  "metrics": ["TOKEN_TOTAL", "REQUEST_COUNT"], "xDimension": "DATE_DAY" }
// 响应
{ "code": 200, "data": { "series": [ { "name": "TOKEN_TOTAL", "xDimension": "DATE_DAY",
  "yDimension": null, "valueType": "COUNT",
  "cells": [ { "xLabel": "2025-09-08", "yLabel": null, "value": 0 }, … ] } ] } }
```

#### `POST …/usage/personal/stats` —— 环比概览
```json
{ "startDate": "2026-09-02", "endDate": "2026-09-08",
  "metrics": ["TOTAL_CREDITS","TOKEN_TOTAL","TOKEN_DAILY_AVG","REQUEST_COUNT","ACTIVE_DAYS","TOKEN_CACHE_HIT"] }
// 响应：{ "code":200, "data":[ {"id":"TOTAL_CREDITS","value":0.0,"last_value":0.0,"ratio":0.0}, … ] }
```

#### `POST …/usage/personal/charts` —— 多维图表
同样结构，`xDimension` 可取 `MODEL` / `FUNCTION` / `DATE_DAY`；`metrics` 可取 `TOKEN_TOTAL` / `TOKEN_INPUT` / `TOKEN_OUTPUT` / `TOKEN_CACHE_HIT` / `TOTAL_CREDITS` / `REQUEST_COUNT`。

#### `GET …/analytics/filters/options?startDate=&endDate=` —— 筛选项字典
```json
{ "code":200, "data": {
  "teams": [ {"id":"ALL_MEMBERS","name":"企业内全部成员"}, {"id":"NO_TEAM",…}, {"id":"ALL_TEAMS",…} ],
  "models": [],
  "serviceFunctions": [ {"id":"agent-general","name":"智能体"}, {"id":"agent-custom","name":"自定义智能体"},
                        {"id":"ask","name":"智能问答"}, {"id":"agent-teams","name":"Agent Team"},
                        {"id":"agent-claw","name":"码道Agent Space"}, {"id":"agent-tui",…} ] } }
```

### 2.4 计费 / 订单接口（可选接，共 2 个）

#### `POST /portal/rest/bss/v1/cloudservices/countdown-iam5` —— 到期倒计时
```json
// 请求
{ "tenantId": "0d2a3bba3a00f2ab2fcbc000fba927b8",
  "cloudServiceType": "hws.service.type.devcloud",
  "resourceType": "hws.resource.type.codearts.snap",
  "regionId": "cn-north-4", "resourceIds": ["fa64939fc6ae40fd9c80edac79e6b444"] }
// 响应（节选）
{ "cloudServiceCountDowns": [ { "resourceId": "fa64939…", "regionId": "cn-north-4",
  "resourceSpecCode": "codearts.agent.individual.trial",
  "countDownCode": "hws_countdown_period_using",
  "countDownInfos": "{\"status\":2,\"nextOperationPolicy\":0,\"nextOperationRemainingDay\":30}",
  "countDownTips": "{\"effTime\":\"2026-09-08T09:03:07Z\",\"expTime\":\"2026-10-08T15:59:59Z\"}",
  "isTrial": 0, "isAutoRenew": 1, "orderId": "CS2609081702KQW88", … } ] }
```
> 注意 `countDownInfos` / `countDownTips` 是**被序列化成字符串的 JSON**，需二次 `JSON.parse`。

#### `POST /portal/rest/bss/v3/orders/query-on-demand-iam5` —— 订单状态
```json
// 请求：{ fromQueryService:"CLOUD_SERVICE", pageSize:200, pageIndex:1,
//         orderCondition:{ orderIds:["CS2609081702KQW88"] }, orderProperties:["status"] }
// 响应：{ "error_code":"CBC.0000", "error_msg":"SUCCESS", "totalSize":1,
//         "orderList":"[{\"orderId\":\"CS2609081702KQW88\",…,\"status\":5}]" }
```
> `orderList` 同样是**字符串化 JSON**。

### 2.5 用户与权限接口（Provider 展示用，共 5 个）

| Method | Path | 响应关键字段 |
|---|---|---|
| GET | `/portal/rest/me?_=<ms>` | `userId`, `domainId`, `domainName`, `projectId`, `region`, `name`, `userName`, `roles[]`（含 `te_admin` 等） |
| GET | `/portal/snap-manager/v1/member_roles?_=<ms>` | `{ team_roles:[], enterprise_roles:["enterprise_admin"] }` |
| GET | `/portal/snap-manager/v1/sso_user?_=<ms>` | 抓包中**全字段为 `null`**（可视为空档案） |
| GET | `/portal/snap-manager/v1/users/user-license/<userId>?_=<ms>` | 见 §2.2 |
| POST | `/portal/snap-manager/v1/applications/status` | `{ result:false, appTypes:[], tags:[], is_show_third_party:false }`；请求体 `{ "specCode": "xxxxxxx" }` |

### 2.6 页面入口
`GET /portal/settings/personal-usage?locale=zh-cn` —— 签到入口页面（返回 HTML）。抓包中伴随 `referer: https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn` 出现在全部业务请求上。

### 2.7 埋点端点（不需接入）
`POST furiondata.myhuaweicloud.com/furiondataserver/fr?appId=…&release=1.0.9&pid=N`、`POST /furiondataserver/api/pages`、`GET /furiondataserver/checkStyle`、`GET /furiondataserver/check`（均返回 `{"status":"success","result":…}`）。属前端埋点，Provider 忽略。

---

## 3. 展示面板 · 新增 Provider 的数据结构与字段

### 3.1 Provider 元信息（配置）
```ts
interface CheckinProviderMeta {
  id: "codearts";
  name: "CodeArts 码道签到";
  kind: "checkin";
  platform: "codearts";
  baseUrl: "https://codearts.huaweicloud.com";
  authType: "cookie";                    // 纯 Cookie + cftk（无 Bearer）
  auth: {
    cookieNames: ["SessionID", "cbc-sid", "vk", "devclouddevuibjJ_SESSION_ID",
                  "SID", "user_tag", "domain_tag", "ua",
                  "browserCheckResult", "cfLatestRecordTimestamp", "cftk"];
    headerToken: "cftk";                 // ★同一令牌需在 header 与 cookie 双写
    requiredHeaders: ["x-requested-with", "language", "x-language", "content-type", "referer"];
    expiryProbe: "GET /portal/snap-manager/v1/credit/has-claimed";  // 探活接口
    invalidSignal: "HW-AJAX-REDIRECT";   // ★失效信号：响应头，而非 HTTP 状态码
  };
  envelopes: {                           // ★按前缀分派
    "/portal/snap-manager/v1/credit": "raw";     // 裸 JSON（含布尔）
    "/portal/snap-manager/v1":        "raw";
    "/portal/dataflywheel":           "code-data";
    "/portal/rest/bss":               "hw-openapi";
    "/portal/DevCloudConsole":        "status-result";
  };
  endpoints: {
    hasClaimed:     "/portal/snap-manager/v1/credit/has-claimed";
    claim:          "/portal/snap-manager/v1/credit/claim";
    packageOverview:"/portal/snap-manager/v1/package_overview";
    packageInfo:    "/portal/snap-manager/v1/package_info";
    maasPackages:   "/portal/snap-manager/v1/maas/package_info_all";
    packageDetail:  "/portal/DevCloudConsole/v3/{tenantId}/package/detail";
    userLicense:    "/portal/snap-manager/v1/users/user-license/{userId}";
    restMe:         "/portal/rest/me";
    memberRoles:    "/portal/snap-manager/v1/member_roles";
    ssoUser:        "/portal/snap-manager/v1/sso_user";
    usageHeatmap:   "/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/heatmap";
    usageStats:     "/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/stats";
    usageCharts:    "/portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/charts";
    filterOptions:  "/portal/dataflywheel/datapreprocess/v1/analytics/filters/options";
    countdown:      "/portal/rest/bss/v1/cloudservices/countdown-iam5";
    orderQuery:     "/portal/rest/bss/v3/orders/query-on-demand-iam5";
  };
  cacheBust: true;                       // ★所有 GET 需 ?_=<unix_ms>
  refreshIntervalSeconds: 60;
}
```

### 3.2 归一化签到快照（面板消费）
```ts
interface CheckinSnapshot {
  providerId: "codearts";
  userId: string;                 // rest/me.userId
  domainId: string;               // rest/me.domainId
  fetchedAt: number;
  checkin: {
    checkedInToday: boolean;      // has-claimed（裸布尔）
    creditType: "daily_bonus";
    // ★CodeArts 无「连续天数 / 热力图 / 补签卡 / 档位」，以下字段恒为 null，
    //   为兼容统一 CheckinProvider 契约保留
    days: null;
    tiers: null;
    makeupCards: null;
    lotteryChances: null;
  };
  credits: {
    remain: number;               // all_credit_package.package_credit_remain  ★主展示值
    amount: number;               // package_credit_amount
    used: number;                 // package_credit_used
    userRemain: number;           // package_credit_user_remain
    expiring: number;             // expiring_credit_amount
    breakdown: {                  // 分项
      basic: number;              // basic_package.package_credit_remain
      bonus: number;              // bonus_credit_package.package_credit_remain
      ondemand: number | null;
    };
  };
  plan: {
    enable: boolean;
    specCode: string;             // codearts.agent.individual.trial
    status: string;               // normal
    resourceId: string;
    autoRenew: boolean;           // countdown.isAutoRenew
    expireTime: string | null;    // countdownTips.expTime
    remainingDays: number | null; // countdownInfos.nextOperationRemainingDay
  };
  license: Record<string, boolean>;   // { "coding": true, "doer-pro": false, … }
  roles: string[];                    // rest/me.roles
  usage?: {                           // 可选：用量趋势
    heatmap: Array<{ date: string; tokenTotal: number; requestCount: number }>;
    stats: Array<{ id: string; value: number; lastValue: number; ratio: number }>;
  };
}
```

### 3.3 字段映射表（CodeArts → 归一化）
| 归一化字段 | CodeArts 来源 | 说明 |
|---|---|---|
| `checkin.checkedInToday` | `GET /credit/has-claimed` | 裸布尔，直接映射 |
| `credits.remain` | `package_overview.all_credit_package.package_credit_remain` | ★主展示值 |
| `credits.amount` / `used` | `all_credit_package.package_credit_amount` / `_used` | 直接 |
| `credits.breakdown.basic` | `basic_package.package_credit_remain` | 基础包 |
| `credits.breakdown.bonus` | `bonus_credit_package.package_credit_remain` | 赠送包 |
| `plan.specCode` | `package_info.spec_code` | 直接 |
| `plan.resourceId` | `package_info.resource_id` | 直接 |
| `plan.expireTime` | `bss/countdown → JSON.parse(countDownTips).expTime` | ★需二次解析 |
| `plan.remainingDays` | `bss/countdown → JSON.parse(countDownInfos).nextOperationRemainingDay` | ★需二次解析 |
| `plan.autoRenew` | `bss/countdown.isAutoRenew` | 1 → true |
| `userId` / `domainId` | `rest/me.userId` / `.domainId` | 亦可从 cookie `user_tag`/`domain_tag` 取 |
| `license` | `user-license.licenseDetail` | 原样 |
| `roles` | `rest/me.roles` | 数组 |
| `usage.heatmap[]` | `analytics/usage/personal/heatmap → data.series[].cells[]` | `xLabel`→date，`value`→指标值 |
| `usage.stats[]` | `analytics/usage/personal/stats → data[]` | 原样 |

### 3.4 Provider 接口契约（复用统一骨架）
```ts
interface CheckinProvider {
  meta: CheckinProviderMeta;
  establishSession(): Promise<Session>;              // CodeArts 仅需导入 Cookie jar（含 cftk）
  getStatus(session: Session): Promise<CheckinSnapshot>;
  checkIn(session: Session): Promise<CheckinResult>; // ★先 has-claimed，再 claim
  claim(session: Session, tier?: string): Promise<ClaimResult>; // 不适用（无档位），抛 NotImplemented
  poll(session: Session, intervalMs: number): void;
}
```

#### `checkIn()` 实现要点（★与 WorkBuddy 的差异）
```ts
async checkIn(session) {
  // 1) 先探活 + 判断今日状态（CodeArts 靠前置查询实现幂等）
  const claimed = await this.hasClaimed(session);   // 裸布尔
  if (claimed === true) return { alreadyCheckedIn: true, ok: true };

  // 2) 执行领取
  const ok = await this.post(session, E.claim, { credit_type: "daily_bonus" });

  // 3) 回查确认（CodeArts claim 不返回积分数量）
  const after = await this.hasClaimed(session);
  const overview = await this.packageOverview(session);
  return { ok: ok === true, alreadyCheckedIn: false,
           creditsAfter: overview.data.all_credit_package.package_credit_remain,
           verified: after === true };
}
```

---

## 4. 交互流程设计（对照 Trae / WorkBuddy）

### 4.1 CodeArts 签到序列
```
(0) 打开 https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn
(1) GET  /portal/rest/me?_=<ms>                            → 用户身份(userId/domainId/roles)
(2) GET  /portal/snap-manager/v1/package_info?_=<ms>        → 套餐状态
(3) GET  /portal/snap-manager/v1/package_overview?_=<ms>    → ★积分余额
(4) GET  /portal/snap-manager/v1/credit/has-claimed?_=<ms>  → ★今日是否已领 (false)
(5) POST /portal/snap-manager/v1/credit/claim               → ★领取每日签到积分
             body { "credit_type": "daily_bonus" }          → true
(6) GET  /portal/snap-manager/v1/credit/has-claimed?_=<ms>  → true（确认翻转）
(7) GET  /portal/snap-manager/v1/package_overview?_=<ms>    → 刷新积分余额
    轮询：GET has-claimed + package_overview（每 60s）
凭证失效：响应头出现 HW-AJAX-REDIRECT → 触发重新登录
```

### 4.2 三平台对照（统一 Provider 契约的可行性）
| 维度 | Trae | WorkBuddy | **CodeArts** |
|---|---|---|---|
| 鉴权 | `Cloud-IDE-JWT`（Bearer） | Cookie（`session`+`session_2`）／Bearer JWT | **Cookie + `cftk` 头/ cookie** |
| 状态读接口 | `checkin_credits/status` | `meter/checkin-activity-status` | **`credit/has-claimed`** |
| 签到写接口 | `checkin_credits/claim` | `meter/daily-checkin` | **`credit/claim`** |
| 写请求体 | 有 | **空 `{}`** | **`{credit_type:"daily_bonus"}`** |
| 幂等机制 | 服务端按日 | 服务端按日（`code:10001`） | **需客户端先查 `has-claimed`** |
| 写响应 | 结构化 | `{credit, streak_days}` | **裸布尔 `true`** |
| 连续签到/热力图/档位/抽奖 | 有 | 有 | **无** |
| 积分余额 | 写接口同返 | `energy` + `activity.total_credits` | **`package_overview`（另查）** |
| 失效信号 | HTTP 401/1001 | HTTP 401（网关） | ★**HTTP 200 + `HW-AJAX-REDIRECT` 头** |
| 响应信封 | `{code,message,…}` | `{code,msg,requestId,data}` | **五种混用（§1.1）** |

> **统一契约结论**：`CheckinProvider` 骨架对三平台均适用，但需在 `errorNormalizer()` 中为 CodeArts 增加 **`HW-AJAX-REDIRECT` → 401** 的映射，并在 `normalizeEnvelope()` 中增加**前缀分派**能力。CodeArts 的 `days/tiers/makeupCards/lotteryChances` 恒为 `null`，面板需容忍空值（隐藏对应卡片）。

---

## 5. 改造内容清单（文件 / 模块级）

> 假设展示面板为 TS 项目，已有 `providers/trae/` 作为模板。

| 状态 | 路径 / 文件 | 内容 |
|---|---|---|
| ☐ 新增 | `providers/codearts/types.ts` | §3.1–3.2 的 `CheckinProviderMeta` / `CheckinSnapshot` / `CheckinProvider` |
| ☐ 新增 | `providers/codearts/endpoints.ts` | §2 全部 19 个路径常量 + 请求/响应字段类型 |
| ☐ 新增 | `providers/codearts/client.ts` | `HttpClient`（cookie + `cftk` 双写、`?_=<ms>` 自动附加）；★`normalizeEnvelope()` **按前缀分派**（5 种信封） |
| ☐ 新增 | `providers/codearts/session.ts` | `SessionStore`：导入/持久化 Cookie jar（含 `cftk`、`SID`、`SessionID`…）；★失效判定读 **`HW-AJAX-REDIRECT` 响应头** |
| ☐ 新增 | `providers/codearts/checkin.ts` | `getStatus()`(has-claimed + package_overview) + `checkIn()`(**先读后写**) + `poll()` |
| ☐ 新增 | `providers/codearts/mapper.ts` | §3.3 字段映射；`countDownInfos`/`countDownTips`/`orderList` **二次 JSON.parse** |
| ☐ 修改 | `providers/index.ts` | 注册 `codearts` Provider（id/name/kind） |
| ☐ 修改 | `providers/registry.config.ts` | 追加 `codearts` 元信息（baseUrl/authType/endpoints/envelopes/cacheBust） |
| ☐ 修改 | `panel/CheckinCard.tsx` | 容忍 `days/tiers/makeupCards/lottery` 为 `null` → 只渲染「今日是否已领 + 积分余额 + 套餐到期」 |
| ☐ 修改 | `i18n/zh-CN.yaml` | 新增 `codearts` 文案（「码道签到」「每日积分」「套餐剩余天数」等） |
| ☐ 新增 | `providers/codearts/__tests__/checkin.test.ts` | 基于 `_evidence_codearts.json` 的快照断言（含裸布尔、五种信封） |
| ☐ 修改 | `panel/CheckinCard.tsx`（错误态） | CodeArts 专属错误：「登录态失效，需重新登录华为云」 |

---

## 6. 可用性测试（过程 + 结果）

### 6.1 凭证来源
- 取自 `examples/codearts_解析结果/036_POST .../credit/claim/请求.txt`（头最完整的一条）。
- Cookie 长度 1139；`cftk = 4H4S-HCUU-C7LO-75CZ-IYAA-H7TD-ZMU6-5954`。
- 抓包时间：2026-09-08 09:15 GMT。

### 6.2 测试方法
- 语言/库：Python `urllib`（无第三方依赖），HTTPS 直连。
- 复刻抓包头部：`cookie` + `cftk`(header) + `x-requested-with` + `language`/`x-language` + `referer` + 同一 `user-agent`。
- **仅调用只读接口**；`claim` 设为**条件执行**（仅当 `has-claimed=false` 时才调用）。
- 脚本：`examples/codearts_test.py`；结果：`examples/_test_results_codearts.txt`、`_evidence_codearts.json`。

### 6.3 结果总表（2026-09-10 实测）
| 类别 | 用例 | 结果 |
|---|---|---|
| 负向 | `GET /credit/has-claimed`（不带 Cookie） | **HTTP 200 + 空体 + `HW-AJAX-REDIRECT`** —— 未返回 401，★见 §1.6 |
| 正向 | `GET /credit/has-claimed`、`package_overview`、`rest/me`、`package_info` | **HTTP 200 + 空体 + `HW-AJAX-REDIRECT`（全部）** → **凭证已失效** |
| — | 判定 | **0/5 可用**（HTTP 200 但均为登录跳转信号） |
| 跳过 | `POST /credit/claim` | 凭证失效，**按安全策略跳过写入**；语义以抓包实证为准 |

**抓包实证（接口行为的地面真值）**：
```
capture 017  GET  /portal/snap-manager/v1/credit/has-claimed?_=1788858921516  → false
capture 036  POST /portal/snap-manager/v1/credit/claim
                  {"credit_type":"daily_bonus"}                              → true
capture 063  GET  /portal/snap-manager/v1/credit/has-claimed?_=1788858929240  → true
capture 016  GET  /portal/snap-manager/v1/package_overview                    → all_credit_remain=4500.0
capture 008  GET  /portal/rest/me                                             → userId=0d2a3a0d…3de6
```
> 017 → 036 → 063 三步构成完整签到闭环（未领 → 领取成功 → 已领），**端点与请求体形态均已在抓包中确证**。

### 6.4 与 WorkBuddy 的测试结果对比
| | WorkBuddy | CodeArts |
|---|---|---|
| 抓包 → 实测间隔 | 同日（2026-09-10） | 2 天（09-08 → 09-10） |
| 凭证是否有效 | ✅ 有效（Bearer 寿命 60d） | ❌ 失效（Cookie 会话小时~天级） |
| 实测覆盖 | 读 + 写（幂等实测） | 仅只读（写被跳过） |
| 失效信号 | HTTP 401（显式） | ★HTTP 200 + 响应头（隐蔽） |

### 6.5 结论与风险
- ✅ **端点与字段已确证**：`has-claimed` / `claim` 的路径、方法、请求体、响应形态（裸布尔）全部由抓包实证，Provider 可据此实现。
- ⚠️ **本次未能完成真机实测**：抓包 Cookie 已于 2 天内失效，`claim` 写入被安全策略跳过。**建议补一次实测**（详见 §8）。
- ⚠️ **★最高优先级风险**：登录态失效**不改 HTTP 状态码**（见 §1.6）。任何「只看 `resp.status === 200` 判成功」的代码在 CodeArts 上都会静默失败。
- ⚠️ **响应信封五种混用**（§1.1），且 `countDownInfos`/`countDownTips`/`orderList` 是**字符串化 JSON**，需二次解析。
- ⚠️ **`claim` 不返回发放积分数量**，需另查 `package_overview` 才能确认入账。
- ⚠️ **凭证寿命短**：Cookie 会话约小时~天级，Provider 必须实现失效探测与重新登录引导（无法静默刷新，无 refresh 接口）。
- ⚠️ **无连续签到体系**：面板需为 CodeArts 隐藏「连续天数环 / 热力图 / 补签卡 / 抽奖」等 WorkBuddy 专属卡片。

---

## 7. 待确认 / 后续

1. **补一次真机实测（★首要）**：重新抓包（或导出浏览器 Cookie）后运行
   ```bash
   cd examples && python codearts_test.py
   ```
   重点确认：① `claim` 重复调用的返回（`false` 还是错误码）；② 失效 Cookie 的准确寿命；③ `has-claimed=false` 时 `claim` 的真实响应头。
2. **`claim` 的幂等语义**：目前只能靠客户端「先读后写」规避；若服务端对重复调用返回 `false`，Provider 应把 `false` 映射为 `alreadyCheckedIn` 而非失败。
3. **每日积分数量**：`daily_bonus` 每次发放多少积分？接口未返回，需对比领取前后 `package_overview.package_credit_remain` 差值补齐。
4. **是否存在连续签到/累计奖励**：CodeArts 抓包中未出现任何 streak/连续签到字段，**初步判断不存在**；可访问页面确认有无未触发的隐藏接口。
5. **是否与 WorkBuddy 双 Provider 并列展示**：统一 `CheckinProvider` 契约已就绪，CodeArts 需处理大量 `null` 字段。
6. **Cookie 的获取方式**：CodeArts 无类似 `client-login` 的 code 换 session 流程，凭证只能从浏览器导出。若要支持多账号自动签到，需评估华为云 IAM 的长期凭证（AK/SK）是否可用于该 Portal API（当前抓包中**未使用** AK/SK 签名）。

---

## 附：完整端点速查表

| # | Method | Path | 用途 |
|---|---|---|---|
| 1 | GET | `/portal/settings/personal-usage?locale=zh-cn` | 签到入口页 |
| 2 | GET | `/portal/rest/me?_=<ms>` | 用户身份 / 角色 |
| 3 | GET | `/portal/snap-manager/v1/member_roles?_=<ms>` | 企业/团队角色 |
| 4 | GET | `/portal/snap-manager/v1/sso_user?_=<ms>` | SSO 用户档案 |
| 5 | GET | `/portal/snap-manager/v1/users/user-license/<userId>?_=<ms>` | 许可证 |
| 6 | POST | `/portal/snap-manager/v1/applications/status` | 应用状态 |
| 7 | GET | `/portal/snap-manager/v1/package_info?_=<ms>` | 套餐状态 |
| 8 | GET | `/portal/snap-manager/v1/package_overview?_=<ms>` | ★积分总览 |
| 9 | GET | `/portal/snap-manager/v1/maas/package_info_all?_=<ms>` | 套餐明细 |
| 10 | **GET** | **`/portal/snap-manager/v1/credit/has-claimed?_=<ms>`** | **★今日是否已领** |
| 11 | **POST** | **`/portal/snap-manager/v1/credit/claim`** | **★领取每日签到积分** |
| 12 | GET | `/portal/DevCloudConsole/v3/<tenantId>/package/detail` | 订单式套餐列表 |
| 13 | POST | `/portal/rest/bss/v1/cloudservices/countdown-iam5` | 到期倒计时 |
| 14 | POST | `/portal/rest/bss/v3/orders/query-on-demand-iam5` | 订单状态 |
| 15 | GET | `/portal/dataflywheel/datapreprocess/v1/analytics/filters/options` | 筛选项字典 |
| 16 | POST | `…/analytics/usage/personal/heatmap` | 用量热力图 |
| 17 | POST | `…/analytics/usage/personal/stats` | 用量环比 |
| 18 | POST | `…/analytics/usage/personal/charts` | 用量多维图表 |
| 19 | GET | `/portal/nps-website/api/get_commit_date?surveyId=…` | NPS 问卷（无关） |
| — | POST | `furiondata.myhuaweicloud.com/furiondataserver/{fr,api/pages}` | 埋点（忽略） |
| — | GET | `furiondata.myhuaweicloud.com/furiondataserver/{check,checkStyle}` | 埋点（忽略） |
