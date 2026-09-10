# 新增 CodeArts（码道 Agent）checkin 平台 · 开发文档

> 产出：接口清单与字段定义 / 展示面板 Provider 数据结构 / 交互流程 / **登录与设备验证** / 改造清单 / 关键接口可用性实测
> 输入源：`examples/codearts_解析结果`（86 条）、`examples/codearts2_解析结果`（257 条，含完整登录链路）
> 原始抓包：`examples/codearts.saz`（2026-09-08 09:15 GMT）、`examples/codearts2.saz`（2026-09-10 04:37 GMT），Edge 152 / Windows
> 参考实现：`D:/Code/Project/Python/HWCloud/cloud_space_huawei`（同作者华为云空间项目，含设备验证流程）
> 姊妹文档：`checkin平台全流程方案.md`（WorkBuddy 侧，同构设计，可对照阅读）
> 实测日期：2026-09-10 ｜ 文档版本：**v1.1**（新增 §1.8 登录与设备验证、§6.6 登录链路实测、§8 交付物）

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
>
> **★凭证怎么来**：CodeArts **无长效凭证、无 refresh 接口**，Cookie 会话寿命仅小时~天级。
> 因此 Provider 必须实现「重新登录」——账号密码登录 + 新设备验证的完整协议见 **§1.8**，
> 参考实现 `examples/codearts_login.py`。登录成功后 `cftk` 头直接取 cookie `devclouddevuibjtcftk`（实测两者恒等）。

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

### 1.8 ★★ 会话获取：账号密码登录 + 新设备验证（已实现）

> 这一节解决**本项目最大的工程问题**：CodeArts 没有长效凭证，Cookie 小时~天级就失效，
> 且失效时静默返回 HTTP 200（§1.6）。因此 Provider 必须能**自己重新登录**，而不是依赖一次抓包。
>
> 实现见 `examples/codearts_login.py`（纯标准库，无第三方依赖）。
> 设计参考了同作者的华为云空间项目 `cloud_space_huawei/auth.py`（已跑通的设备验证流程），
> 并按 codearts2 抓包校准了全部常量与端点前缀。

#### 1.8.1 完整链路（9 步）

| # | 方法 | 端点 | 作用 / 产出 |
|---|---|---|---|
| ① | GET | `auth.huaweicloud.com/authui/login.html?service=…` | 建立 WAF 会话（`HWWAFSESID` / `Site`） |
| ② | GET | `auth.huaweicloud.com/authui/getSDKBaseInfo?flowType=unionLogin&service=…` | ★ **引导入口**：返回 `pageToken` / `pageTokenKey` / `state` / `localStorageID` / `hwidConfig`（内含 clientID、loginChannel、cookieVersion） |
| ③ | POST | `id1…/UnifiedIDMPortal/ajaxHandler/login/jsRemoteLogin` | 预热。**固定返回 `10006003`（Can't get loginSiteID）**，属正常 |
| ④ | POST | `id1…/UnifiedIDMPortal/ajaxHandler/common/dev` | 上报设备指纹 `fp` → 返回 `sid`（= `hwid_cas_sid`，**设备信任令牌**） |
| ⑤ | POST | `id1…/UnifiedIDMPortal/ajaxHandler/common/analysisHealth` | 健康上报（服务端状态机要求） |
| ⑥ | POST | `id1…/UnifiedIDMPortal/ajaxHandler/login/getLoginIdsByPwd` | 账号识别 → `accountInfoList`（`anonymousAccount` / `serial` / `countryCode`） |
| ⑦ | POST | `id1…/UnifiedIDMPortal/ajaxHandler/login/unionLoginByPwd` | 密码登录 → `callbackURL` + `needPopTrust` |
| ⑧ | — | `/CAS/portal/authIdentify.html` → `/CAS/IDM_W/ajaxHandler/{cloudIframeAuthIdentify/getPageInfo, cloudAuthLogin, updateTrustBrowser}` | **仅当 `needPopTrust=true`**（新设备）才走；见 §1.8.4 |
| ⑨ | — | `callbackURL` → `…/oauth2/v3/authorize` → `oauth2/ajax/getLoginWay` → `CAS/remoteLogin` → `oauth2/v3/loginCallback` → `oauth2/ajax/login` → `authui/casLogin` → `authui/login` → `codearts…/personal-usage?ticket=ST-…` | OAuth 换票 → 落地业务会话 cookie |

#### 1.8.2 关键常量（来自抓包，与旧版 CAS 不同）

| 常量 | CodeArts（码道） | 备注 |
|---|---|---|
| `clientID` | **`103493351`** | 云空间项目是 `4805300` |
| `reqClientType` | **`88`** | 云空间项目是 `1` |
| `loginChannel` | **`88000000`** | 云空间项目是 `1000002` |
| `cVersion` | `UP_CAS_6.26.2.100_blue` | 从 `getSDKBaseInfo` 的 `hwidConfig.cookieVersion` 动态取 |
| `service` | `https://auth.huaweicloud.com/authui/casLogin?service=<业务页 URL-encoded>` | OAuth 的 `redirect_uri` 即为它 |
| `scope` | `https://www.huawei.com/auth/account/unified.profile+…/risk.idstate+LoginState` | 三段，`+` 分隔 |
| 登录 ajax 前缀 | **`/UnifiedIDMPortal/ajaxHandler`** | 新版 |
| 设备验证 ajax 前缀 | **`/CAS/IDM_W/ajaxHandler`** | ★ 与登录阶段**不同前缀**，见 §1.8.4 |

#### 1.8.3 设备指纹 `fp` 算法（★已逐字节验证）

```
serialized = "&".join(f"{encodeURIComponent(k)}={encodeURIComponent(v)}" for k, v in sorted(fields))
body       = serialized + "&cs=" + SHA1(serialized)
fp         = Base64( XOR(body) )            # XOR 密钥初值 211，每步 key ← 该步产出的密文字节
```
字段（按 key 升序，**空值也要保留**）：
`bsh, bsw, canvas, devs, ep, epl, epls, ett, etz, fonts, ips, nacn, nan, nce, nlg, npf, sah, saw, sh, sw, webgl`

**实测结论（4 条，均为现场复现）**：

| 结论 | 证据 |
|---|---|
| `cs` 必须是 **SHA1**，用 MD5（云空间旧版算法）→ 服务端 200 但 `sid` 返回**空串** | 对照实验 F |
| 服务端**不校验** `canvas`/`webgl`/`fonts`/`ep`/`epls` 的真实性——全部替换为伪造 SHA1 值，只要 `cs` 正确，照样签发 `sid` | 对照实验 C/D/E |
| 因此 **纯 Python 生成指纹即可，无需 Playwright** | 本模块 `build_fp()` |
| 用抓包里的真实 `fp` 逐字节重建成功（XOR + 字段排序 + 百分号编码风格全部一致） | `python codearts_login.py selftest` |

> 注：XOR 的"加密"与"解密"是**两个不同函数**（都按**密文字节**滚动 key），不互为自反；
> 且 XOR 输出必须用 `latin-1` 编码后再 Base64，用 `utf-8` 会破坏字节序列（会把长度从 744 撑到 928 并被服务端判为非法）。

#### 1.8.4 新设备验证（`needPopTrust = true`）

`unionLoginByPwd` 返回 `needPopTrust: true` 时（本机非受信设备），必须补做：

```
GET  /CAS/portal/authIdentify.html?loginUrl=…&service=…&reqClientType=88&loginChannel=88000000&…
POST /CAS/IDM_W/ajaxHandler/common/getBaseSwitchInfo
POST /CAS/IDM_W/ajaxHandler/cloudIframeAuthIdentify/getPageInfo   # pageName=cloudIframeAuthIdentify
POST /CAS/IDM_W/ajaxHandler/common/dev                            # 用 authIdentify 页的 pageToken
POST /CAS/IDM_W/ajaxHandler/common/analysisHealth                 # currentUri=/CAS/portal/authIdentify.html
      ↓ 从 getPageInfo 的 localInfo.errorDesc.authCodeSentList 取验证设备列表
      ↓（服务端此时已向默认设备发送验证码）
POST /CAS/IDM_W/ajaxHandler/cloudAuthLogin      { twoStepVerifyCode, verifyAccountType, verifyUserAccount }
POST /CAS/IDM_W/ajaxHandler/updateTrustBrowser  { operType: 2, trustBrowser: 1 }
      ↓ 用 cloudAuthLogin 返回的新 callbackURL 重走 §1.8.1 第 ⑨ 步
```

**端点前缀的实测依据**：`authIdentify.html` 页面加载的 `/CAS/jsconfig/hwidConfig.js` 里
`ajaxServer = "CAS"`，经 `moduleNameMap` 映射为 `CAS/IDM_W`；而登录页的
`/UnifiedIDMPortal/jsconfig/hwidConfig.js` 中 `ajaxServer = "UnifiedIDMPortal"`。
现场对照请求确认：同名单在 `/UnifiedIDMPortal/ajaxHandler/` 下 **404**，在 `/CAS/IDM_W/ajaxHandler/` 下返回结构化 JSON。

**已现场验证**：按上述参数调用 `cloudIframeAuthIdentify/getPageInfo` 返回 **`isSuccess: 1`**（含 `pageToken`/`pageTokenKey`/`localInfo.flowID`），证明参数集被服务端接受。

#### 1.8.5 `hwid_cas_sid` —— 免验证的持久化关键（★务必保存）

| 行为 | 实测结果 |
|---|---|
| 请求带已有 `hwid_cas_sid` | 服务端**原样回显**，并写入 `Domain=id1.cloud.huawei.com; Max-Age=315360000`（**10 年**）的 cookie |
| 请求不带 | 服务端每次会话**新签发**一个 `sid`（同一会话内幂等，跨会话不同） |

⇒ Provider 只要把 `hwid_cas_sid` 随会话一起持久化，**后续重登自带受信设备身份，不会再触发设备验证**。
`examples/codearts_login.py` 已将其写入会话文件（`--session`，默认 `.codearts_session.json`）。

#### 1.8.6 落地得到的业务会话 cookie

| Cookie | 来源 | 用途 |
|---|---|---|
| `devclouddevuibjJ_SESSION_ID` | 第 ⑨ 步跟到 `codearts…/personal-usage?ticket=ST-…` | 业务会话主凭据 |
| `devclouddevuibjagencyID` | 同上 | 租户/代理标识（= `domainId`） |
| `devclouddevuibjtcftk` | 第 ⑨ 步最后再访问一次干净页 | ★ **WAF 令牌**，同时作为请求头 `cftk` 发送（实测两者恒等） |
| `user_tag` / `domain_tag` / `cbc-sid` / `vk` / `ua` / `HWWAFSESID` | `authui/casLogin` 环节 | 辅助 |

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
  establishSession(): Promise<Session>;              // ★见下：账号密码登录 + 新设备验证
  getStatus(session: Session): Promise<CheckinSnapshot>;
  checkIn(session: Session): Promise<CheckinResult>; // ★先 has-claimed，再 claim
  claim(session: Session, tier?: string): Promise<ClaimResult>; // 不适用（无档位），抛 NotImplemented
  poll(session: Session, intervalMs: number): void;
}
```

#### `establishSession()` 实现要点（★本项目核心）
CodeArts 无长效凭证 → 必须能**自动重新登录**（协议见 §1.8，参考实现 `examples/codearts_login.py`）：

```ts
async establishSession(saved?: Session): Promise<Session> {
  // 1) 复用已保存会话：把 cookies + hwid_cas_sid 灌回 jar
  //    ★ hwid_cas_sid 是受信设备令牌（10 年），带上它能跳过设备验证
  if (saved) restore(saved);

  // 2) 仅当「本地已有会话」时才先探活，避免无谓登录
  if (saved && await this.probe()) return saved;      // probe: 看 HW-AJAX-REDIRECT 头

  // 3) 走账号密码登录（§1.8.1 九步），拿到业务 cookie
  const r = await login(account, password, saved);
  if (r.needVerify) {
    const vr = await sendVerifyCode();                // getPageInfo → authCodeSentList
    const code = await askUser(vr.devices);           // ← 唯一需要人工介入的环节
    await verifyDevice(code);                         // cloudAuthLogin + updateTrustBrowser + 重走 OAuth
  }
  await save({ cookies, hwid_cas_sid });              // ★ 必须把 hwid_cas_sid 一起存
  return session;
}
```

**失败/降级分支**：

| 场景 | 处理 |
|---|---|
| `getLoginIdsByPwd` → `10000400` | 账号或密码错误，**终止**（继续调用 `unionLoginByPwd` 只会得到 `10000600`，见 §6.6） |
| `getLoginIdsByPwd` → `10000201` | 需要图片验证码，当前实现未接入 → 提示用户改用浏览器登录后导出 cookie |
| `unionLoginByPwd` → `needPopTrust: true` | 走设备验证；若用户无法提供验证码，降级为"提示手动登录" |
| `common/dev` 返回 `sid` 为空串 | 指纹非法（`cs` 不对/编码错），见 §1.8.3 |
| 业务 cookie 三缺一 | 登录未完成，报错并保留已获取的 `hwid_cas_sid` 供下次重试 |


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
- ✅ **登录链路已可自动化**：`examples/codearts_login.py` 已完成账号密码登录 + 新设备验证，见 §6.6。
- ⚠️ **本次未能完成签到真机实测**：抓包 Cookie 已于 2 天内失效，`claim` 写入被安全策略跳过。**建议补一次实测**（详见 §7）。
- ⚠️ **★最高优先级风险**：登录态失效**不改 HTTP 状态码**（见 §1.6）。任何「只看 `resp.status === 200` 判成功」的代码在 CodeArts 上都会静默失败。
- ⚠️ **响应信封五种混用**（§1.1），且 `countDownInfos`/`countDownTips`/`orderList` 是**字符串化 JSON**，需二次解析。
- ⚠️ **`claim` 不返回发放积分数量**，需另查 `package_overview` 才能确认入账。
- ⚠️ **无连续签到体系**：面板需为 CodeArts 隐藏「连续天数环 / 热力图 / 补签卡 / 抽奖」等 WorkBuddy 专属卡片。
- ⚠️ **账号密码登录需要人工介入**：新设备需在受信设备上收验证码；图片验证码（`10000201`）未接入。

### 6.6 登录链路实测（2026-09-10 现场复现）

对 `examples/codearts_login.py` 的每一环做了真实联网验证（**除账号密码本身外，其余全部验证通过**）：

| 步骤 | 验证方式 | 结果 |
|---|---|---|
| ① 引导 + ② `getSDKBaseInfo` | 真实请求 | ✅ `isSuccess=1`，取到 `pageToken`/`state`/`cVersion=UP_CAS_6.26.2.100_blue` |
| ③ `jsRemoteLogin` | 真实请求 | ✅ **误差码与服务端一字不差复现**：`10006003 Can't get loginSiteID` |
| ④ `common/dev`（纯 Python fp） | 真实请求 | ✅ `isSuccess=1`，签发真实 `sid`（64 字符） |
| ⑤ `analysisHealth` | 真实请求 | ✅ `isSuccess=1` |
| ⑥ `getLoginIdsByPwd` | 用**不存在的账号**（不触碰真实账号） | ✅ 抵达账号校验后端：`10000400 / chkHwidAccount / 70002003` |
| ⑦ `unionLoginByPwd` | 同上 | ⚠️ 返回 `10000600 Current page has expired`（见下"归因结论"） |
| ⑧ `cloudIframeAuthIdentify/getPageInfo` | 真实请求（带完整参数） | ✅ **`isSuccess=1`**，返回有效 `pageToken`/`pageTokenKey`/`localInfo.flowID` → 参数集被服务端接受 |
| ⑧ 端点前缀 | 对照请求 | ✅ 同名单在 `/UnifiedIDMPortal/ajaxHandler/` 下 **404**，在 `/CAS/IDM_W/ajaxHandler/` 下正常 |
| fp 算法 | 与抓包逐字节对拍 | ✅ `python codearts_login.py selftest` 全部通过 |

**⑦ 的归因结论（重要）**：
对 `unionLoginByPwd` 做了 10 组参数扫描（去掉 `hwid_cas_sid`、换用抓包旧 `sid`、跳过 ⑥、
重新 bootstrap 换新 `pageToken`、重复 ③ 预热、`opType=1`、补 `jsRemoteLogin` 风格字段、
去掉设备字段、置空 `service`），**全部返回同一个 `10000600`** ⇒ **与参数无关，是服务端页面状态机的问题**。

结合抓包顺序（④⑤⑥ 全部成功 → ⑦ 才成功）可以判定：
**`unionLoginByPwd` 要求当前 pageToken 已处于"账号识别成功"状态**，而用假账号时 ⑥ 必然失败，
页面状态无法推进。⇒ 这一步**只能在真实账号下才能跑到**，不是本实现的缺陷。

> 因此：请用真实账号跑一次
> ```bash
> cd examples
> python codearts_login.py login --account 173xxxxxxxx --password '***'
> ```
> 预期：若本机为受信设备 → 直接成功；若为新设备 → 打印验证设备列表并提示输入验证码。

---

## 7. 待确认 / 后续

1. **用真实账号跑通登录（★首要）**：
   ```bash
   cd examples
   python codearts_login.py login --account 173xxxxxxxx --password '***'
   ```
   重点确认：① 本机是否被判定为新设备（`needPopTrust`）；② 若为新设备，验证设备列表
   （`authCodeSentList`）里 `name` / `accountType` 的实际取值；③ ⑨ 步落地后三个业务
   cookie 是否齐全。跑通后即可接着实测签到：
   ```bash
   python codearts_test.py --session .codearts_session.json
   ```
2. **补一次签到真机实测**：确认 ① `claim` 重复调用的返回（`false` 还是错误码）；
   ② 失效 Cookie 的准确寿命；③ `has-claimed=false` 时 `claim` 的真实响应头。
3. **`claim` 的幂等语义**：目前只能靠客户端「先读后写」规避；若服务端对重复调用返回 `false`，Provider 应把 `false` 映射为 `alreadyCheckedIn` 而非失败。
4. **每日积分数量**：`daily_bonus` 每次发放多少积分？接口未返回，需对比领取前后 `package_overview.package_credit_remain` 差值补齐。
5. **是否存在连续签到/累计奖励**：CodeArts 抓包中未出现任何 streak/连续签到字段，**初步判断不存在**；可访问页面确认有无未触发的隐藏接口。
6. **是否与 WorkBuddy 双 Provider 并列展示**：统一 `CheckinProvider` 契约已就绪，CodeArts 需处理大量 `null` 字段。
7. **图片验证码（`10000201`）**：新设备/风控场景下 `getLoginIdsByPwd` 可能要求网易易盾图片验证码
   （`hwidConfig.csCaptchaUrl` / `cscSceneId=login` / `displayCaptchaType=1`）。当前实现只做报错提示，
   未接入识别。若触发频率高，可考虑：接 Playwright 走真实浏览器登录，或复用 `cloud_space_huawei`
   项目的 `_get_image_verify_code()`（若该版本仍走传统图形码）。
8. **`hwmeta` 风控字段**：抓包中 `unionLoginByPwd` 带一个长 base64 的 `hwmeta`（JS 运行时生成），
   本实现默认传空串。由 §6.6 的参数扫描可知它**不是** `10000600` 的成因，但真实账号登录时是否
   需要它尚未验证——若真实登录报风控错误，优先怀疑此项。

---

## 8. 交付物

| 文件 | 说明 |
|---|---|
| `examples/codearts_login.py` | ★ 登录模块（账号密码 + 新设备验证 + fp 生成 + 会话持久化 + 探活） |
| `examples/codearts_test.py` | 签到接口实测脚本，`--session` 可直接消费上者产出的会话 |
| `examples/.codearts_session.json`（运行时生成，已 gitignore） | 会话 + `hwid_cas_sid`（设备信任令牌，10 年） |

```bash
# 0) 离线自检（不联网）
python examples/codearts_login.py selftest

# 1) 登录（首次新设备需输入验证码）
python examples/codearts_login.py login --account 173xxxxxxxx --password '***'

# 2) 用新鲜会话实测签到接口
python examples/codearts_test.py --session examples/.codearts_session.json
```

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

### 附.2 登录 / 设备验证端点速查表（§1.8 实现）

前缀变量：
`NEW = https://id1.cloud.huawei.com/UnifiedIDMPortal/ajaxHandler`
`CAS = https://id1.cloud.huawei.com/CAS/IDM_W/ajaxHandler`
（**同名 handler 在 `NEW` 与 `CAS` 下不可互换**，实测见 §1.8.4）

| 阶段 | Method | URL | 关键参数 / 产出 |
|---|---|---|---|
| ② | GET | `https://auth.huaweicloud.com/authui/getSDKBaseInfo?flowType=unionLogin&service=…` | → `pageToken` / `pageTokenKey` / `state` / `localStorageID` / `hwidConfig` |
| ③ | POST | `NEW/login/jsRemoteLogin` | `pageToken,pageTokenKey,state,loginUrl,service,themeName,jsSiteID,scope,client_id,access_type,regionCode,localStorageID` → 固定 `10006003` |
| ④ | POST | `NEW/common/dev` | `+fp`（可选 `hwid_cas_sid`,`localStorageID`）→ `sid` |
| ⑤ | POST | `NEW/common/analysisHealth` | `operType=1000, message=<JSON>, illnessType=0` |
| ⑥ | POST | `NEW/login/getLoginIdsByPwd` | `+userAccount(0086+手机号),password` → `accountInfoList` |
| ⑦ | POST | `NEW/login/unionLoginByPwd` | `+service,bsAcctService,hwmeta,opType=0,scope,access_type,anonymousLoginID,registerCountry,serial` → `callbackURL`,`needPopTrust` |
| ⑧ | GET | `https://id1.cloud.huawei.com/CAS/portal/authIdentify.html` | 新设备时的验证页 |
| ⑧ | POST | `CAS/common/getBaseSwitchInfo` | — |
| ⑧ | POST | `CAS/cloudIframeAuthIdentify/getPageInfo` | `pageName=cloudIframeAuthIdentify, interfaceName=…/getPageInfo, urlParam=…` → `pageToken`,`localInfo.errorDesc.authCodeSentList` |
| ⑧ | POST | `CAS/common/dev` / `CAS/common/analysisHealth` | 用 ⑧ 的 pageToken；`currentUri=/CAS/portal/authIdentify.html` |
| ⑧ | POST | `CAS/cloudAuthLogin` | `twoStepVerifyCode, verifyAccountType, verifyUserAccount` → 新 `callbackURL` |
| ⑧ | POST | `CAS/updateTrustBrowser` | `operType=2, trustBrowser=1` |
| ⑨ | POST | `https://oauth-login1.cloud.huawei.com/oauth2/ajax/getLoginWay` | body = authorize URL **全部查询参数** → `signatureInfo`,`loginInteractInfo.cas.casLoginRedirectUrl` |
| ⑨ | GET | `<casLoginRedirectUrl>` | 302 → `oauth2/v3/loginCallback?…` |
| ⑨ | GET | `<loginCallback>` | 建立 OAuth ticket 状态（**不可跳过**） |
| ⑨ | POST | `https://oauth-login1.cloud.huawei.com/oauth2/ajax/login` | `signatureInfo` 全字段 + `ticket,siteID,countryCode` → `code` |
| ⑨ | GET | `<code>` → `authui/casLogin` → `authui/login` → `codearts…?ticket=ST-…` | ⇒ `devclouddevuibjJ_SESSION_ID`,`devclouddevuibjagencyID`,`user_tag`,`domain_tag` |
| ⑨ | GET | `codearts…/portal/settings/personal-usage?locale=zh-cn` | ⇒ `devclouddevuibjtcftk`（= 请求头 `cftk`） |

> 公共请求头：`Content-Type: application/x-www-form-urlencoded`、`Origin: https://auth.huaweicloud.com`、
> `Referer: https://auth.huaweicloud.com/`；URL 追加 `?reflushCode=<随机小数>&cVersion=<cookieVersion>`。

