# 新增 CodeArts（码道 Agent）checkin 平台 · 开发文档

> 产出：接口清单与字段定义 / 展示面板 Provider 数据结构 / 交互流程 / **登录与设备验证** / 改造清单 / 关键接口可用性实测  
> 输入源：`examples/codearts_解析结果`（86 条）、`examples/codearts2_解析结果`（257 条，含完整登录链路）  
> 原始抓包：`examples/codearts.saz`（2026-09-08 09:15 GMT）、`examples/codearts2.saz`（2026-09-10 04:37 GMT），Edge 152 / Windows  
> 参考实现：`D:/Code/Project/Python/HWCloud/cloud_space_huawei`（同作者华为云空间项目，含设备验证流程）  
> 姊妹文档：`checkin平台全流程方案.md`（WorkBuddy 侧，同构设计，可对照阅读）  
> 实测日期：2026-09-12 ｜ 文档版本：**v2.0**（★新增 §12：**每日签到接口迁移** —— 上游把签到从 `/snap-manager/v1/credit/*` 换到运营活动中心 `promptcenter/v1/ops/*`，旧接口保留路由但改为返回 **HTTP 200 + 空响应体**，导致「凭证有效却签到失败」；含定位方法（比对前端 bundle 版本 + grep 接口路径）与客户端改造）  
> 上一版 v1.5（2026-09-10 15:40）：新增 §11 签到历史 / 逐包明细 / 近30天区间汇总。

* * *

## 0\. 背景与目标

在「展示面板」中新增一个 **CodeArts checkin Provider**，数据来自华为云 CodeArts（码道 / CodeArts Agent）的每日积分领取体系。工作要求：

1.  梳理 CodeArts 签到所需的**全部接口清单及字段定义**（来源 = CodeArts 抓包）；
2.  定义展示面板**新增 Provider 所需的数据结构与字段**；
3.  复用 WorkBuddy/Trae 已有的 `CheckinProvider` 骨架，仅替换域名/路径/凭据字段；
4.  对关键接口做**可用性实测**，把过程与结果写入本文档。

**结论先行**：CodeArts 的签到体系与 WorkBuddy/Trae **结构最简**——它没有「连续签到天数 / 热力图 / 补签卡 / 抽奖」五件套，只有一对接口：

```
GET  /portal/snap-manager/v1/credit/has-claimed   → 今日是否已领取（原始 JSON 布尔）
POST /portal/snap-manager/v1/credit/claim         → 领取每日签到积分 {"credit_type":"daily_bonus"}

```

因此 Provider 实现量最小；**主要复杂度在于鉴权形态与响应信封的不统一**（见 §1.3、§1.6）。

* * *

## 1\. 全局约定

### 1.1 响应信封（★与 WorkBuddy 最大的差异：不统一）

CodeArts 各业务域的封装风格互不相同，**没有唯一信封**。Provider 必须按前缀分派解析器：

| 前缀 | 信封形态 | 示例 |
| --- | --- | --- |
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
| --- | --- |
| 业务主域（Portal API） | `codearts.huaweicloud.com` |
| 埋点 / 数据上报 | `furiondata.myhuaweicloud.com` |
| 静态资源 CDN | `devcloud-res.hc-cdn.com` / `res.hc-cdn.com` |
| 前端页面 | `/portal/settings/personal-usage?locale=zh-cn`（签到入口所在地） |

### 1.3 鉴权形态（★关键）

CodeArts **纯 Cookie 会话 + WAF 令牌**，无 Bearer / 无 OAuth 头：

| 项 | 内容 |
| --- | --- |
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

-   `regionId = "cn-north-4"`（华北-北京四）
-   `Endpoint = "CodeArtsAgentPortal"`（响应头）
-   积分单位：`credits`（响应中记作 `package_credit_*`）
-   签到类型枚举：`credit_type` 观测到唯一值 **`daily_bonus`**
-   租户/身份标识：
    -   `tenantId`（domainId）= `0d2a3a0cc500f3060f0dc00096bca220`
    -   `projectId` = `0d2a3bba3a00f2ab2fcbc000fba927b8`
    -   `userId` = `0d2a3a0dae80f58a1f92c0000c3a3de6`

### 1.5 会话时效

抓包于 2026-09-08，**2026-09-10 实测已失效**（详见 §6.3）。CodeArts 的 Cookie 会话寿命较短（小时~天级），且失效表现**非常隐蔽**（见下）。

### 1.6 ★★ 关键坑：登录态失效不改 HTTP 状态码

这是本平台**最容易踩的坑**，必须写进 Provider：

```
HTTP/1.1 200 OK
...
HW-AJAX-REDIRECT: https://auth.huaweicloud.com/authui/login?service=

```

-   登录态失效时，服务端返回 **HTTP 200 + 空响应体**，  
    仅通过响应头 `HW-AJAX-REDIRECT` 下发登录地址，另有响应头 `Rf` 由 `service` 变为 `cf2`。
-   **只看 HTTP 状态码会把「未登录」误判为「成功但无数据」**（2026-09-10 实测：5 个接口全部 HTTP 200，实际全部未登录）。
-   Provider 的错误归一化必须**优先检查 `HW-AJAX-REDIRECT` 头**（等价于 401），命中即触发重新登录并标记 `credentialInvalid=true`。
-   附：**未带 Cookie** 请求同样返回 HTTP 200 + 空体 + `HW-AJAX-REDIRECT`（不会返回 401/403），因此**无法用状态码区分「无凭证」与「凭证过期」**。

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
| --- | --- | --- | --- |
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
| --- | --- | --- |
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
| --- | --- |
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
| --- | --- |
| 请求带已有 `hwid_cas_sid` | 服务端**原样回显**，并写入 `Domain=id1.cloud.huawei.com; Max-Age=315360000`（**10 年**）的 cookie |
| 请求不带 | 服务端每次会话**新签发**一个 `sid`（同一会话内幂等，跨会话不同） |

⇒ Provider 只要把 `hwid_cas_sid` 随会话一起持久化，**后续重登自带受信设备身份，不会再触发设备验证**。  
`examples/codearts_login.py` 已将其写入会话文件（`--session`，默认 `.codearts_session.json`）。

#### 1.8.6 落地得到的业务会话 cookie

| Cookie | 来源 | 用途 |
| --- | --- | --- |
| `devclouddevuibjJ_SESSION_ID` | 第 ⑨ 步跟到 `codearts…/personal-usage?ticket=ST-…` | 业务会话主凭据 |
| `devclouddevuibjagencyID` | 同上 | 租户/代理标识（= `domainId`） |
| `devclouddevuibjtcftk` | 第 ⑨ 步最后再访问一次干净页 | ★ **WAF 令牌**，同时作为请求头 `cftk` 发送（实测两者恒等） |
| `user_tag` / `domain_tag` / `cbc-sid` / `vk` / `ua` / `HWWAFSESID` | `authui/casLogin` 环节 | 辅助 |

* * *

### 1.9 ★★ 新设备验证为何无法纯 HTTP 走通（2026-09-10 实证，结论性）

用真实账号 `173****7416` 对 §1.8.4 的设备验证链路做了逐项实测，结论是：  
**`hwid_cas_sid` 一旦丢失，纯 HTTP 无法完成新设备验证**；正确做法是把 sid 当作  
长期凭证持久化（见 §1.8.5），首次 onboarding 交给真实浏览器完成。

#### 1.9.1 根因①：两套登录栈互不相通（命名空间错配）

服务端存在两个**独立的会话命名空间**，端点存在性实测如下：

| 端点 | `/UnifiedIDMPortal/ajaxHandler/` | `/CAS/IDM_W/ajaxHandler/` |
| --- | --- | --- |
| `login/unionLoginByPwd`（密码登录） | ✅ 可用 | ❌ 404 |
| `login/getPageInfo` | 未使用 | ✅ 可用（返回 `pageToken` + `flowID`） |
| `remoteLogin` | ❌ 404 | ✅ 可用（但要求图形验证码） |
| `dev` / `analysisHealth` | `common/dev`、`common/analysisHealth` | `dev`、`analysisHealth`（**无 `common/`**） |
| `chkRisk` | ❌ 404 | ✅ 可用（返回 `extInfo`） |
| `cloudIframeAuthIdentify/getPageInfo` | ❌ 404 | ✅ 可用 |
| `cloudAuthLogin` | ❌ 404 | ✅ 可用 |
| `updateTrustBrowser` | `login/updateTrustBrowser` ✅ | ✅ 可用 |

⇒ codearts（`clientID=103493351`）的**密码登录只存在于 UnifiedIDMPortal**，  
而**设备验证端点只存在于 CAS/IDM\_W**。`cloudAuthLogin` 只在本命名空间内查找  
`cloudLoginBean`，于是跨命名空间调用必然返回：

```
{"errorCode":"10000600","errorDesc":"cloudLoginBean is null","isSuccess":0}

```

**这不是验证码问题**：用 3 个不同验证码（`010554` / `430303` / `611524`）分别  
提交，返回的 errorCode/errorDesc **完全一致**；换 `pageToken` 来源（登录页 /  
识别页）也一致 —— 已排除「码错误」与「token 传错」。

#### 1.9.2 根因②：CAS 登录栈另有一道图形验证码

把整条登录链搬到 CAS 命名空间（参考项目做法）后，流程能推进到密码提交，  
但 `remoteLogin` 返回：

```
{"errorCode":"10000201","errorDesc":"need picture authcode risk"}

```

即 CAS 栈要求**图片验证码**（参考项目靠人眼看图输入解决）。而 UnifiedIDMPortal  
栈不需要图片验证码 —— 这正是 codearts 前端选它的原因。**两栈各缺一块拼图**。

#### 1.9.3 根因③：重试会触发风控升级

连续多次尝试后，**连 UnifiedIDMPortal 的密码登录也开始返回**  
`need picture authcode risk`（风控把该账号/IP 标记为高风险）。  
⇒ 不要对真实账号做「暴力重试」，风控会累积升级。

#### 1.9.4 因此的正确策略（已落地）

```
首次 onboarding（一次性，人工）：
    真实浏览器登录 codearts → 设备验证（人工过图形验证码/短信）
    → 从 Cookie 取出 hwid_cas_sid（10 年有效）★

之后（全自动，可长期无人值守）：
    codearts_login.py 携带该 sid → 登录直接成功、跳过设备验证
    → codearts_test.py 签到

```

**A/B 对照实测（决定性证据）**：

| 臂 | 请求是否带 `hwid_cas_sid` | `unionLoginByPwd` 结果 |
| --- | --- | --- |
| A | **带**（复用会话文件） | `isSuccess=1` → `callbackURL` → 业务 cookie 落地 ✅ |
| B | **不带**（空 sid） | `isSuccess=0` / `errorCode=10002080`，errorDesc 内嵌 `authCodeSentList` ❌ |

臂 A 连续两次登录均成功且都跳过了设备验证 ⇒ sid 持久化确实等价于「受信设备」。

#### 1.9.5 `10002080` 分支（响应形态，需在代码里兼容）

不带 sid 时 `unionLoginByPwd` 的响应**不是** `needPopTrust=true`，而是硬错误，  
设备列表被塞在 `errorDesc` 的 **JSON 字符串**里：

```json
{"errorCode":"10002080","isSuccess":0,"errorDesc":"{\"authCodeSentList\":[
  {\"accountType\":-1,\"name\":\"Honor 10\",\"sent\":1,\"type\":\"device\"},
  {\"accountType\":2,\"name\":\"173******16\",\"sent\":0}],
  \"riskFlag\":\"001000000011100001000010000\"}"}

```

`codearts_login.py` 已同时支持两种形态：

-   分支 A：`isSuccess=0` + `errorCode=10002080` → 从 `errorDesc` 解析设备列表
-   分支 B：`isSuccess=1` + `needPopTrust=true` → 常规设备验证

* * *

## 2\. 接口清单及字段定义

> 共 **19 个业务端点**（签到 2 + 积分套餐 5 + 用量分析 4 + 计费订单 2 + 用户权限 5 + 页面 1）+ 4 个埋点端点。

### 2.1 签到核心接口（Provider 必接，共 2 个）

#### ① `GET /portal/snap-manager/v1/credit/has-claimed?_=<ms>` —— 今日是否已领

| 项 | 内容 |
| --- | --- |
| 请求 | 无 body；带 §1.3 全部头与 cookie |
| 响应 | **原始 JSON 布尔**：`false`（未领） / `true`（已领） |
| 抓包实证 | capture 017 → `false`；capture 063（约 7.7s 后）→ `true` |
| 说明 | 每次进入 `/portal/settings/personal-usage` 都会调用，是**签到按钮的显隐依据** |

> ⚠️ 响应是**裸布尔**，不是 `{"data":false}`。`json.loads` 后直接得到 Python `bool`；判空时注意 `False` 与「请求失败」的区别（后者见 §1.6 的 200 空体）。

#### ② `POST /portal/snap-manager/v1/credit/claim` —— 领取每日签到积分 ★写

| 项 | 内容 |
| --- | --- |
| 请求头 | `content-type: application/json`、`origin: https://codearts.huaweicloud.com` + §1.3 全部 |
| 请求体 | `{ "credit_type": "daily_bonus" }` |
| 响应 | **原始 JSON 布尔** `true` = 领取成功 |
| 抓包实证 | capture 036 → `true`（2026-09-08 09:15:24 GMT，Content-Length: 30） |

**语义与幂等性**：

-   该接口是**每日一次**的领取动作，服务端按 `credit_type=daily_bonus` + 当日日期去重。
-   重复调用预期返回 `false` 或错误（**本次未实测**，因凭证已失效，见 §6.3）→ Provider 应在调用前先查 `has-claimed`，避免依赖二次调用的返回语义（**先读后写**，与 WorkBuddy 不同：WorkBuddy 靠 `code:10001` 拒绝，CodeArts 靠前置查询）。
-   响应**不返回发放的积分数量**。要拿到积分余额需另查 §2.2 `package_overview`（与 WorkBuddy 的 `daily-checkin` 直接返回 `credit:100` 不同）。

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
| --- | --- | --- |
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
| --- | --- | --- |
| GET | `/portal/rest/me?_=<ms>` | `userId`, `domainId`, `domainName`, `projectId`, `region`, `name`, `userName`, `roles[]`（含 `te_admin` 等） |
| GET | `/portal/snap-manager/v1/member_roles?_=<ms>` | `{ team_roles:[], enterprise_roles:["enterprise_admin"] }` |
| GET | `/portal/snap-manager/v1/sso_user?_=<ms>` | 抓包中**全字段为 `null`**（可视为空档案） |
| GET | `/portal/snap-manager/v1/users/user-license/<userId>?_=<ms>` | 见 §2.2 |
| POST | `/portal/snap-manager/v1/applications/status` | `{ result:false, appTypes:[], tags:[], is_show_third_party:false }`；请求体 `{ "specCode": "xxxxxxx" }` |

### 2.6 页面入口

`GET /portal/settings/personal-usage?locale=zh-cn` —— 签到入口页面（返回 HTML）。抓包中伴随 `referer: https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn` 出现在全部业务请求上。

### 2.7 埋点端点（不需接入）

`POST furiondata.myhuaweicloud.com/furiondataserver/fr?appId=…&release=1.0.9&pid=N`、`POST /furiondataserver/api/pages`、`GET /furiondataserver/checkStyle`、`GET /furiondataserver/check`（均返回 `{"status":"success","result":…}`）。属前端埋点，Provider 忽略。

* * *

## 3\. 展示面板 · 新增 Provider 的数据结构与字段

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
    packageOverview:"/portal/snap-manager/v1/package/overview";   // ★实测正确路径（斜杠）；
    packageInfo:    "/portal/snap-manager/v1/package/info";       // 抓包目录名把它显示成 package_overview 是「/→_」转写，不是真路径
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
| --- | --- | --- |
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
| --- | --- |
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

* * *

## 4\. 交互流程设计（对照 Trae / WorkBuddy）

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
| --- | --- | --- | --- |
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

* * *

## 5\. 改造内容清单（文件 / 模块级）

> 假设展示面板为 TS 项目，已有 `providers/trae/` 作为模板。

| 状态 | 路径 / 文件 | 内容 |
| --- | --- | --- |
| ☐ 新增 | `providers/codearts/types.ts` | §3.1–3.2 的 `CheckinProviderMeta` / `CheckinSnapshot` / `CheckinProvider` |
| ☐ 新增 | `providers/codearts/endpoints.ts` | §2 全部 19 个路径常量 + 请求/响应字段类型 |
| ☐ 新增 | `providers/codearts/client.ts` | `HttpClient`（cookie + `cftk` 双写、`?_=<ms>` 自动附加）；★`normalizeEnvelope()` **按前缀分派**（5 种信封） |
| ☐ 新增 | `providers/codearts/session.ts` | `SessionStore`：导入/持久化 Cookie jar（含 `cftk`、`SID`、`SessionID`…）；★失效判定读 **`HW-AJAX-REDIRECT` 响应头** |
| ☐ 新增 | `providers/codearts/checkin.ts` | `getStatus()`(has-claimed + package\_overview) + `checkIn()`(**先读后写**) + `poll()` |
| ☐ 新增 | `providers/codearts/mapper.ts` | §3.3 字段映射；`countDownInfos`/`countDownTips`/`orderList` **二次 JSON.parse** |
| ☐ 修改 | `providers/index.ts` | 注册 `codearts` Provider（id/name/kind） |
| ☐ 修改 | `providers/registry.config.ts` | 追加 `codearts` 元信息（baseUrl/authType/endpoints/envelopes/cacheBust） |
| ☐ 修改 | `panel/CheckinCard.tsx` | 容忍 `days/tiers/makeupCards/lottery` 为 `null` → 只渲染「今日是否已领 + 积分余额 + 套餐到期」 |
| ☐ 修改 | `i18n/zh-CN.yaml` | 新增 `codearts` 文案（「码道签到」「每日积分」「套餐剩余天数」等） |
| ☐ 新增 | `providers/codearts/__tests__/checkin.test.ts` | 基于 `_evidence_codearts.json` 的快照断言（含裸布尔、五种信封） |
| ☐ 修改 | `panel/CheckinCard.tsx`（错误态） | CodeArts 专属错误：「登录态失效，需重新登录华为云」 |

* * *

## 6\. 可用性测试（过程 + 结果）

### 6.1 凭证来源

-   取自 `examples/codearts_解析结果/036_POST .../credit/claim/请求.txt`（头最完整的一条）。
-   Cookie 长度 1139；`cftk = 4H4S-HCUU-C7LO-75CZ-IYAA-H7TD-ZMU6-5954`。
-   抓包时间：2026-09-08 09:15 GMT。

### 6.2 测试方法

-   语言/库：Python `urllib`（无第三方依赖），HTTPS 直连。
-   复刻抓包头部：`cookie` + `cftk`(header) + `x-requested-with` + `language`/`x-language` + `referer` + 同一 `user-agent`。
-   **仅调用只读接口**；`claim` 设为**条件执行**（仅当 `has-claimed=false` 时才调用）。
-   脚本：`examples/codearts_test.py`；结果：`examples/_test_results_codearts.txt`、`_evidence_codearts.json`。

### 6.3 结果总表（2026-09-10 实测）

| 类别 | 用例 | 结果 |
| --- | --- | --- |
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

#### 6.3.1 ★ 真实账号复测（2026-09-10，用登录后的新鲜会话）

用真实账号走完 §1.8.1 登录链拿到新鲜会话，再以 `--session` 跑 `codearts_test.py`：

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | `GET /credit/has-claimed`（负向，不带 Cookie） | HTTP 200 + 空体 + `HW-AJAX-REDIRECT`（预期行为，对照用） |
| 2 | `GET /credit/has-claimed` | **HTTP 200 → `false`** ⇒ 今日未领取 |
| 3 | `GET /snap-manager/v1/package/overview` | **HTTP 200** → `all_credit_package.package_credit_amount=6500.0`、`remain=6355.28` |
| 4 | `GET /portal/rest/me` | **HTTP 200** → `userName=le_huan`, `domainId=0d2a3a0c…` |
| 5 | `GET /snap-manager/v1/package/info` | **HTTP 200** → `spec_code=codearts.agent.individual.trial` |
| 6 | `POST /credit/claim` `{"credit_type":"daily_bonus"}` | **HTTP 200 → `true`** ✅ **真机领取成功** |
| 7 | `GET /credit/has-claimed`（复查） | **HTTP 200 → `true`** ⇒ 状态已翻转 |
| 8 | `GET /package/overview`（复查） | **HTTP 200 → `package_credit_amount=7500.0`** ⇒ **+1000 积分入账** ✅ |

二次运行复测幂等性：`has-claimed=true → 跳过写入`，**5/5 HTTP 200**。

> **两个真实 bug 在本次复测中被修掉**（原脚本对抓包路径做了简写）：
> 
> 1.  `package_overview` / `package_info` 的真实路径是  
>     **`/snap-manager/v1/package/overview`**、**`/snap-manager/v1/package/info`**（`package` 与 `overview` 之间有 `/`），  
>     原脚本写成 `package_overview` → 服务端返回 `400 TM.00001001 请求没有配置URL校验规则`。
> 2.  失效判定把**负向对照用例**（故意不带 Cookie）也统计进去，导致 `expired` 恒为真、  
>     `claim` 永不执行。已改为只统计带 Cookie 的用例（`used_cookie`）。

### 6.4 与 WorkBuddy 的测试结果对比

|  | WorkBuddy | CodeArts |
| --- | --- | --- |
| 抓包 → 实测间隔 | 同日（2026-09-10） | 2 天（09-08 → 09-10） |
| 凭证是否有效 | ✅ 有效（Bearer 寿命 60d） | ❌ 失效（Cookie 会话小时~天级） |
| 实测覆盖 | 读 + 写（幂等实测） | 仅只读（写被跳过） |
| 失效信号 | HTTP 401（显式） | ★HTTP 200 + 响应头（隐蔽） |

### 6.5 结论与风险

-   ✅ **登录链路已可自动化**：`examples/codearts_login.py` 已完成账号密码登录 + 新设备验证，见 §6.6。
-   ✅ **签到已真机跑通**：真实账号实测 `claim → true`，积分 `6500 → 7500`（**+1000**），见 §6.3.1。
-   ✅ **设备信任可持久化**：`hwid_cas_sid`（10 年有效）落盘后，重登稳定跳过设备验证（A/B 实证，见 §1.9.4）。
-   ⚠️ **★最高优先级风险**：登录态失效**不改 HTTP 状态码**（见 §1.6）。任何「只看 `resp.status === 200` 判成功」的代码在 CodeArts 上都会静默失败。
-   ⚠️ **响应信封五种混用**（§1.1），且 `countDownInfos`/`countDownTips`/`orderList` 是**字符串化 JSON**，需二次解析。
-   ⚠️ **`claim` 不返回发放积分数量**，需另查 `package_overview` 才能确认入账。
-   ⚠️ **无连续签到体系**：面板需为 CodeArts 隐藏「连续天数环 / 热力图 / 补签卡 / 抽奖」等 WorkBuddy 专属卡片。
-   ⚠️ **新设备 onboarding 必须人工介入**：登录（UnifiedIDMPortal）与验证（CAS/IDM\_W）分属两套互不相通的会话命名空间，  
    CAS 栈还额外要求**图片验证码**，且重试会触发**风控升级**。⇒ **首次 onboarding 走真实浏览器拿 `hwid_cas_sid`，之后全自动**（见 §1.9）。

### 6.6 登录链路实测（2026-09-10 现场复现）

对 `examples/codearts_login.py` 的每一环做了真实联网验证（**除账号密码本身外，其余全部验证通过**）：

| 步骤 | 验证方式 | 结果 |
| --- | --- | --- |
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
> 
> ```bash
> cd examples
> python codearts_login.py login --account 173xxxxxxxx --password '***'
> 
> ```
> 
> 预期：若本机为受信设备 → 直接成功；若为新设备 → 打印验证设备列表并提示输入验证码。

**真实账号复测结果（2026-09-10 13:10，已执行）**：

| 步骤 | 结果 |
| --- | --- |
| ① ~ ⑦ 全链（携带浏览器抓包得到的受信 `hwid_cas_sid`） | ✅ **登录成功**，`needPopTrust` 为假 ⇒ **未触发设备验证** |
| 业务 cookie 落地 | ✅ `devclouddevuibjJ_SESSION_ID` / `devclouddevuibjagencyID` / `devclouddevuibjtcftk` 三件齐备 |
| `check_session()` 探活 | ✅ `valid=true`（无 `HW-AJAX-REDIRECT`） |
| **第二次**登录（复用落盘 sid） | ✅ 再次成功、**仍跳过设备验证** ⇒ sid 持久化有效 |
| 不带 sid 的对照臂 | ❌ `unionLoginByPwd → 10002080`（要求设备验证），后续 `cloudAuthLogin → 10000600 cloudLoginBean is null` |

⇒ 结论见 §1.9：**sid 是可用方案；纯 HTTP 的新设备验证走不通**（两套命名空间 + CAS 栈图片验证码 + 风控升级）。

* * *

## 7\. 待确认 / 后续

1.  ~**用真实账号跑通登录（★首要）**~ → **✅ 已完成（2026-09-10 13:10）**：
    
    ```bash
    cd examples
    python codearts_login.py login --account 173xxxxxxxx --password '***'
    
    ```
    
    实测：① 携带受信 `hwid_cas_sid` 时 `needPopTrust` 为假、**不需设备验证**；  
    ② 三个业务 cookie 齐备且 `check_session()` 探活通过；③ 二次登录复用 sid 仍成功。
2.  ~**补一次签到真机实测**~ → **✅ 已完成**：`claim → true`，积分 `6500 → 7500`（**+1000**）。  
    结果见 §6.3.1。剩余待补：失效 Cookie 的准确寿命（小时~天级，未精确测定）。
3.  **`claim` 的幂等语义**：目前只能靠客户端「先读后写」规避；若服务端对重复调用返回 `false`，Provider 应把 `false` 映射为 `alreadyCheckedIn` 而非失败。
4.  **每日积分数量**：**已实测 = +1000**（`package_credit_amount` 6500 → 7500）。接口本身不返回数量，需对比领取前后 `package_overview` 差值。
5.  **是否存在连续签到/累计奖励**：CodeArts 抓包中未出现任何 streak/连续签到字段，**初步判断不存在**；可访问页面确认有无未触发的隐藏接口。
6.  **是否与 WorkBuddy 双 Provider 并列展示**：统一 `CheckinProvider` 契约已就绪，CodeArts 需处理大量 `null` 字段。
7.  **图片验证码（`10000201`）** → **✅ 已定性**：它出现在 **CAS/IDM\_W 命名空间**的 `remoteLogin`（`need picture authcode risk`），  
    以及**风控升级后**的 UnifiedIDMPortal 登录上。这是「两套登录栈各缺一块拼图」的核心障碍之一，  
    结论是**不再尝试纯 HTTP 绕行**（见 §1.9）。若确需全自动新设备 onboarding，唯一可行方向是  
    Playwright 走真实浏览器登录（可见地过图形码与短信码），再取出 `hwid_cas_sid` 交给本项目。
8.  **`hwmeta` 风控字段**：抓包中 `unionLoginByPwd` 带一个长 base64 的 `hwmeta`（JS 运行时生成），  
    本实现默认传空串。实测：受信 sid + 空 `hwmeta` 可正常登录 ⇒ **它不是必需项**；  
    但在**不受信**场景下它可能影响风控评分（连续重试会触发 `need picture authcode risk`）。
9.  **风控「冷却」**：连续多次失败登录后账号会被临时标记（图片验证码）。**不要对真实账号做批量重试**；  
    若已触发，静置一段时间后恢复。

* * *

## 8\. 交付物

| 文件 | 说明 |
| --- | --- |
| `examples/codearts_login.py` | ★ 登录模块（账号密码 + 新设备验证 + fp 生成 + 会话持久化 + 探活） |
| `examples/codearts_test.py` | 签到接口实测脚本，`--session` 可直接消费上者产出的会话 |
| `examples/.codearts_session.json`（运行时生成，已 gitignore） | 会话 + `hwid_cas_sid`（设备信任令牌，10 年） |
| `examples/_test_results_codearts.txt`、`_evidence_codearts.json` | 实测输出（机器可读证据） |

```bash
# 0) 离线自检（不联网）
python examples/codearts_login.py selftest

# 1) 登录（携带已落盘的受信 hwid_cas_sid 时自动跳过设备验证）
python examples/codearts_login.py login --account 173xxxxxxxx --password '***'

# 1b) 只探活已保存会话
python examples/codearts_login.py check --session examples/.codearts_session.json

# 2) 用新鲜会话实测签到接口（has-claimed=false 时才会真正执行 claim）
python examples/codearts_test.py --session examples/.codearts_session.json

```

**实测结果（2026-09-10）**：登录 ✅（跳过设备验证）｜签到 ✅（`claim → true`，积分 **+1000**）｜  
`package/overview`、`package/info` 两个路径 bug 已修 ✅

* * *

## 附：完整端点速查表

| # | Method | Path | 用途 |
| --- | --- | --- | --- |
| 1 | GET | `/portal/settings/personal-usage?locale=zh-cn` | 签到入口页 |
| 2 | GET | `/portal/rest/me?_=<ms>` | 用户身份 / 角色 |
| 3 | GET | `/portal/snap-manager/v1/member_roles?_=<ms>` | 企业/团队角色 |
| 4 | GET | `/portal/snap-manager/v1/sso_user?_=<ms>` | SSO 用户档案 |
| 5 | GET | `/portal/snap-manager/v1/users/user-license/<userId>?_=<ms>` | 许可证 |
| 6 | POST | `/portal/snap-manager/v1/applications/status` | 应用状态 |
| 7 | GET | `/portal/snap-manager/v1/package/info?_=<ms>` | 套餐状态 ⚠️**注意有 `/`**（写作 `package_info` 会 400） |
| 8 | GET | `/portal/snap-manager/v1/package/overview?_=<ms>` | ★积分总览 ⚠️**注意有 `/`**（写作 `package_overview` 会 400） |
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
| --- | --- | --- | --- |
| ② | GET | `https://auth.huaweicloud.com/authui/getSDKBaseInfo?flowType=unionLogin&service=…` | → `pageToken` / `pageTokenKey` / `state` / `localStorageID` / `hwidConfig` |
| ③ | POST | `NEW/login/jsRemoteLogin` | `pageToken,pageTokenKey,state,loginUrl,service,themeName,jsSiteID,scope,client_id,access_type,regionCode,localStorageID` → 固定 `10006003` |
| ④ | POST | `NEW/common/dev` | `+fp`（可选 `hwid_cas_sid`,`localStorageID`）→ `sid` |
| ⑤ | POST | `NEW/common/analysisHealth` | `operType=1000, message=<JSON>, illnessType=0` |
| ⑥ | POST | `NEW/login/getLoginIdsByPwd` | `+userAccount(0086+手机号),password` → `accountInfoList` |
| ⑦ | POST | `NEW/login/unionLoginByPwd` | `+service,bsAcctService,hwmeta,opType=0,scope,access_type,anonymousLoginID,registerCountry,serial` → `callbackURL`,`needPopTrust`；**不带受信 sid 时改为返回 `isSuccess=0 / errorCode=10002080`**，设备列表内嵌在 `errorDesc`（见 §1.9.5） |
| ⑧ | GET | `https://id1.cloud.huawei.com/CAS/portal/authIdentify.html` | 新设备时的验证页 |
| ⑧ | POST | `CAS/common/getBaseSwitchInfo` | — |
| ⑧ | POST | `CAS/cloudIframeAuthIdentify/getPageInfo` | `pageName=cloudIframeAuthIdentify, interfaceName=…/getPageInfo, urlParam=…` → `pageToken`,`localInfo.errorDesc.authCodeSentList` |
| ⑧ | POST | `CAS/dev` / `CAS/analysisHealth` | 用 ⑧ 的 pageToken；**注意 CAS 下无 `common/` 前缀**（`CAS/common/analysisHealth` → 404，实测见 §1.9.1）；`currentUri=/CAS/portal/authIdentify.html` |
| ⑧ | POST | `CAS/cloudAuthLogin` | `twoStepVerifyCode, verifyAccountType, verifyUserAccount` → 新 `callbackURL` ⚠️ **跨命名空间调用必报 `10000600 cloudLoginBean is null`**（见 §1.9.1） |
| ⑧ | POST | `CAS/updateTrustBrowser` | `operType=2, trustBrowser=1` |
| — | POST | `CAS/common/getBaseSwitchInfo` / `CAS/login/getPageInfo` | **参考项目（CAS 栈）的入口**：`pageName=login, interfaceName=login/getPageInfo` → `pageToken` + `localInfo.flowID`（实测可用） |
| — | POST | `CAS/remoteLogin` | CAS 栈的密码登录；实测返回 `10000201 need picture authcode risk` ⇒ **CAS 栈需图形验证码**（见 §1.9.2） |
| — | POST | `CAS/chkRisk` | `userAccount, operType=0, lowLogin=` → `extInfo`（实测可用） |
| ⑨ | POST | `https://oauth-login1.cloud.huawei.com/oauth2/ajax/getLoginWay` | body = authorize URL **全部查询参数** → `signatureInfo`,`loginInteractInfo.cas.casLoginRedirectUrl` |
| ⑨ | GET | `<casLoginRedirectUrl>` | 302 → `oauth2/v3/loginCallback?…` |
| ⑨ | GET | `<loginCallback>` | 建立 OAuth ticket 状态（**不可跳过**） |
| ⑨ | POST | `https://oauth-login1.cloud.huawei.com/oauth2/ajax/login` | `signatureInfo` 全字段 + `ticket,siteID,countryCode` → `code` |
| ⑨ | GET | `<code>` → `authui/casLogin` → `authui/login` → `codearts…?ticket=ST-…` | ⇒ `devclouddevuibjJ_SESSION_ID`,`devclouddevuibjagencyID`,`user_tag`,`domain_tag` |
| ⑨ | GET | `codearts…/portal/settings/personal-usage?locale=zh-cn` | ⇒ `devclouddevuibjtcftk`（= 请求头 `cftk`） |

> 公共请求头：`Content-Type: application/x-www-form-urlencoded`、`Origin: https://auth.huaweicloud.com`、  
> `Referer: https://auth.huaweicloud.com/`；URL 追加 `?reflushCode=<随机小数>&cVersion=<cookieVersion>`。

* * *

## 9\. ★ v1.3 落地实现（2026-09-10）

> 把 §1–§4 的协议落成**可运行代码**，与 WorkBuddy Provider 并列注册进面板，并在远端 Termux 完成真实账号实测。

### 9.1 落地形态

面板是运行在 Honor 10（Termux / Android，Node v24）上的零依赖 ESM Node 服务，因此 Python 参考实现被**逐行移植为 JS**（不引入任何 npm 包，只用 `node:crypto` + `node:https`）：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| **`monitor/lib/checkin/codearts.js`** | 约 870 | ★核心客户端：登录链 ①–⑨、fp 算法、cookie jar、业务接口、设备验证接口；导出 `CodeArtsClient` / `HttpClient` / `buildFp` / `parseAuthCodeSentList` / `markInvalid` |
| **`monitor/lib/providers/codearts.js`** | 约 300 | Provider 层：configSchema + 契约方法 + 错误归一化 + 验证码两阶段接口（内存会话 TTL 10 分钟） |
| `monitor/server.js` | +70 行 | 注册 Provider + 3 条 `verify-code` 路由 |
| `monitor/lib/tasks/index.js` | +15 行 | 会话巡检按 `sessionCredentialKeys` 取键（CodeArts 才能被纳入巡检） |
| `monitor/frontend/checkin.html` | +25 行 | 「📱 设备验证」按钮（能力位 `verifyCode` 自动显隐） |
| `monitor/_selftest_providers.mjs` | 约 190 | 契约自检 + WorkBuddy mock 分支 + 真实只读探活 |

### 9.2 与 Python 参考实现的等价性（逐字节对拍）

`monitor/_selftest_codearts.mjs` 对 fp 算法做了对拍，**全部通过**：

```
✓ XOR 加解密往返一致
✓ 自生成 fp：长度 744，cs=SHA1 校验通过
✓ 抓包 fp 反解成功：长度 744，cs=SHA1 通过
✓ 逐字节重建一致（算法 + 字段顺序全对）
✓ serializePairs() 编码风格与浏览器 encodeURIComponent 一致
✓ authCodeSentList 解析（str/dict）通过

```

> JS 版与 Python 版**同算法同顺序**，因此 §6.6 的逐环验证结论对 JS 版同样成立（含 §1.8.3 的「`cs` 只校验完整性，可纯离线生成」）。

### 9.3 configSchema（11 字段）与 hwid\_cas\_sid 主方案

| key | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `account` | text | ✅ | 华为账号手机号（自动补 `0086` 前缀），用于会话失效时自动重登 |
| `password` | password | ✅ | 仅本地保存 |
| **`hwidCasSid`** | password | — | ★**主方案**：设备信任令牌（约 10 年） |
| `localStorageId` | text | — | 留空由服务端下发 |
| `fpSeed` | text | ✅ | 设备指纹唯一输入（默认 `codearts-checkin`）；改变它 = 换新设备 |
| `time` / `timezone` | select | ✅ | 定时 |
| `failThreshold` | select | — | 连续失败告警阈值 |
| `cookieExpiryNotify` / `cookieExpiryNotifyDays` | toggle/select | — | 会话失效提醒 |
| `notifyOnSuccess` | toggle | — | 成功也发通知 |

**`hwid_cas_sid` 是最省事的主方案**（§1.9.4 的 A/B 实证）：只要它在，每次重登都跳过设备验证；它由登录流程自动回填进 `task.config.hwidCasSid` + cookie jar，**无需手工粘贴**（首次 onboarding 也可从浏览器 Cookie 直接复制过来）。

### 9.4 设备验证接口（★按要求保留）

协议的已知限制（§1.9）不变，但接口按用户要求**完整保留**，以便换设备 / sid 失效时现场处置：

| 阶段 | API | 行为 |
| --- | --- | --- |
| 获取 | `POST /api/checkin/verify-code/request?id=` | ①先用现有凭证登录：sid 有效 → 返回 `alreadyTrusted:true`（附「无需验证码」文案）；②sid 失效 → 解析 `errorDesc.authCodeSentList` 得到设备列表并下发验证码；③登录阶段未解析出设备时才补调 `CAS/cloudIframeAuthIdentify/getPageInfo`（**一个窗口只调一次**，避免重发） |
| 提交 | `POST /api/checkin/verify-code/submit?id=` | `CAS/cloudAuthLogin` → `updateTrustBrowser` → 重走 OAuth → 落地会话；`namespaceMismatch`（`10000600 cloudLoginBean is null`）会被识别并给出「改用浏览器导出 cookie」的明确指引 |
| 取消 | `POST /api/checkin/verify-code/cancel?id=` | 丢弃内存中的验证会话 |

两阶段之间用**内存会话**（`Map<taskId,{client,at}>`，TTL 10 分钟）承载：因为 `fp` / `pageToken` / CAS 会话都在客户端实例里，换实例就失效。  
这条路径**不参与自动签到**：自动签到永远先走「已保存会话探活 → 账号密码 + sid 重登」，只有两者都失败才需要人工点一次「设备验证」。

### 9.5 远端部署与★真实数据实测（2026-09-10）

部署：`deploy-remote.sh`（runit 原子重启）→ `MONITOR_STARTED: 22082`；`/api/checkin/providers` 返回三个 Provider（`trae` / `workbuddy` / `codearts`）。

真实账号任务（providerId=`codearts`，携带落盘的 `hwid_cas_sid` + 27 项业务 cookie）实测：

| 调用 | 结果 |
| --- | --- |
| `POST /api/checkin/test?id=` | `{"ok":true,"total":7355.28,"valid":true}` |
| `GET /api/checkin/status?id=` | `{"ok":true,"checked_in":true,"credits":7355.28}` |
| `GET /api/checkin/credits/total?id=` | `{"ok":true,"total":7355.28,"packs":{"basic":500,"bonus":6855.28}}` |
| `POST /api/checkin/run?id=` | `{"ok":true,"alreadyCheckedIn":true,"credits":7355.28,"reward":null}` |

结论：

-   ✅ **会话探活 → 状态 → 积分 → 签到**四条路径全部真实跑通（不是 mock）。
-   ✅ 当日已领时 `checkin` **幂等**返回 `alreadyCheckedIn=true`，不重复发放（与 §2.1「CodeArts 靠前置查询实现幂等」一致）。
-   ✅ 积分 7355.28 = 基础包 500 + 赠送包 6855.28，与 CodeArts 后台一致；`claim` 不返回数量，正是靠 `package/overview` 前后差值算出当日所得（§9.6 的 `reward`）。
-   ⚠️ 远端首次运行即暴露并修掉一个真实 bug：`HttpClient.isExpired` 在 JS 移植时**漏写**，导致所有业务接口报 `isExpired is not a function`（`_biz()` 里唯一的失效判定入口）。已补为静态方法并注释「只看 `HW-AJAX-REDIRECT` 头，不看 HTTP 状态码」。

### 9.6 复现命令

```bash
# 本地契约自检（含 fp 对拍）
node monitor/_selftest_codearts.mjs
node monitor/_selftest_providers.mjs

# 远端
cd $HOME/monitor && node _selftest_providers.mjs
curl -s -X POST "http://127.0.0.1:3081/api/checkin/test?id=<taskId>"
curl -s        "http://127.0.0.1:3081/api/checkin/status?id=<taskId>"
curl -s -X POST "http://127.0.0.1:3081/api/checkin/run?id=<taskId>"

```

* * *

## 10\. ★ v1.4 落地实现（2026-09-10 14:40）：用量分析 + 权益包接入

### 10.1 背景

数据面板此前只显示 Trae 的消耗统计，因为 `lib/checkin-stats.js` 只认 `getUsage`（Trae 的按会话接口）。CodeArts 没有会话级接口，但有**真实远端**的个人用量分析端点 —— 本次把它接成 `getDailyUsage`，让 CodeArts 也进入统计面板。

### 10.2 新增端点（全部实测 🛰 真实远端）

| 端点 | 用途 | 实测 |
| --- | --- | --- |
| `POST /portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/charts` | 逐日 / 按模型用量 | DATE\_DAY 30 格；09-09 = 144.72 |
| `POST .../analytics/usage/personal/stats` | 区间汇总指标 | `TOTAL_CREDITS`\=144.72、`TOKEN_TOTAL`\=1730038 |
| `POST .../analytics/usage/personal/heatmap` | 用量热力图 | 31 格 |
| `GET /portal/snap-manager/v1/package/overview` | 权益包分项（已接入 `getPackages`） | 总额度 7355.28/7500 |
| `GET /portal/snap-manager/v1/package/info` | 套餐规格 | `codearts.agent.individual.trial` / normal |

请求体（`charts`）：

```json
{
  "startDate": "2026-08-11",
  "endDate":   "2026-09-10",
  "metrics":   ["TOTAL_CREDITS", "TOKEN_TOTAL"],
  "xDimension": "DATE_DAY"
}

```

-   `xDimension: "DATE_DAY"` → `cells[].xLabel` 是日期
-   `xDimension: "MODEL"` → `cells[].xLabel` 是模型名（如 `GLM-5.2`）
-   `metrics` 可选：`TOTAL_CREDITS` / `TOKEN_TOTAL` / `REQUEST_COUNT` / `ACTIVE_DAYS`

### 10.3 ★ 两个解析坑（实测）

1.  **双层信封**：响应是 `{ code: 200, data: { code: 200, data: { series: [...] } } }`。  
    注意 `HttpClient._biz()` 已把**整个 body** 解析为 `r.data`，所以业务数据在 `r.data.data.series`，不是 `r.data.series`。  
    （顺带：该接口的信封 code 是 `200`，不是全局常见的 `0`。）
2.  **没有「日期×模型」矩阵**：`xDimension: DATE_DAY` + `yDimension: MODEL` 返回 HTTP 200，但 `yLabel` **恒为 null**；`splitBy` / `dimensions` / `groupBy` 等参数一律 400。  
    ⇒ 只能分别调两次（DATE\_DAY 一次、MODEL 一次）再由本地合并。

### 10.4 `getDailyUsage` 契约与模型归属策略

```js
// providers/codearts.js
async getDailyUsage(task, { startSec, endSec }) → {
  days:        { 'YYYY-MM-DD': { total, tokens, models, modelTokens } },  // 仅含有消耗的日期
  modelTotals: [ { model, credits, tokens } ],                           // ★区间累计
  source: 'remote',
  sourceLabel: 'CodeArts 用量分析接口',
  note: null | '该平台只提供逐日总量与区间模型累计…',                      // 无法逐日归属时给出说明
}

```

模型归属策略（**不臆造**）：

-   区间内**只有一个模型** → 该模型直接落到每一天（本次实测场景，`GLM-5.2`）；
-   或区间内**只有一个有消耗的日子** → 该日承接所有模型的区间累计；
-   其余情况 → 逐日 `models` 留空，只给 `modelTotals`，并写 `note` 说明；前端渲染为「模型区间累计（上游不提供逐日模型归属）」。

### 10.5 三平台用量能力对照（★能力边界）

| 平台 | 逐请求明细 | 逐日聚合 | 逐日×模型 | 权益包明细 |
| --- | --- | --- | --- | --- |
| Trae | ✅ 按会话（含 token） | 本地聚合 | ✅ | ✅ |
| WorkBuddy | ✅ 按请求（无 token） | 本地聚合 | ✅ | ✅ 17 个资源实例 |
| **CodeArts** | ❌ **不存在** | ✅ 远端直接给 | ❌ 只有区间模型累计 | ✅ 3 个分项 |
| ⚠️ 结论 | CodeArts 的「积分消耗明细」按钮走**降级视图**（展示落库逐日表），不是逐请求列表 |  |  |  |

### 10.6 验证结果

```
# 远端 /api/checkin/usage?id=<codearts>
fallback = "daily"   source = "remote"   sourceLabel = "CodeArts 用量分析接口"
days[0]  = {date: 2026-09-09, consumption: 144.72, tokens: 1730038,
            models: {"GLM-5.2": {consumption: 144.72, tokens: 1730038}}}

# 远端 /api/checkin/packages?id=<codearts>
total = 7355.28   capacity = 7500   specCode = codearts.agent.individual.trial
  总额度 (all_credit_package)  7355.28 / 7500
  基础包 (basic_package)         500 / 500
  赠送包 (bonus_credit_package) 6855.28 / 7000

```

* * *

## 11\. ★ v1.5 落地实现（2026-09-10 15:40）：签到历史 / 逐包明细 / 近30天区间汇总

> 新增抓包证据：`examples/codearts3_解析结果`（个人用量页 `/portal/settings/personal-usage` 完整会话）

### 11.1 ★「CodeArts 有没有『近30天』端点」——答案与证据

**没有名为「近30天」的独立端点，但「近 N 天」是这些端点的普通参数。**

| 端点 | 日期参数 | 抓包中的实际取值 |
| --- | --- | --- |
| `POST .../analytics/usage/personal/charts` | `{startDate,endDate,metrics,xDimension}` | `2026-09-04 ~ 2026-09-10`（近7天）、`2026-09-04 ~ 2026-09-10` |
| `POST .../analytics/usage/personal/stats` | `{startDate,endDate,metrics}` | `2026-09-04 ~ 2026-09-10` |
| `POST .../analytics/usage/personal/heatmap` | `{startDate,endDate,metrics,xDimension}` | ★`2025-09-10 ~ 2026-09-10`（**整整一年**） |
| `GET .../analytics/filters/options` | `?startDate=&endDate=&isPersonal=true` | `2026-09-04 ~ 2026-09-10` |

页面上「近7天 / 近30天 / 自定义」只是把这两个日期换掉而已。  
**CodeArts 真正缺的是「逐请求 / 逐会话明细」端点**（只有聚合），  
所以面板的「◈ 积分消耗明细」对该平台降级为**逐日**表格（数据仍来自真实远端端点）。

### 11.2 新增端点

**① 逐包明细（权益包浮层升级）**

```
POST /portal/snap-manager/v1/package/credit/page
body: {pageNum:1, pageSize:20, sortField:"created_time", sortOrder:"desc"}
resp: {list:[{id,packageType,resourceSpec,creditAmount,creditUsed,createdTime,expiredTime,status}], total,pageNum,pageSize}

```

-   ★**单层信封**（无 `code` 包裹，与 analytics 的双层信封相反）
-   实测 5 条：`bonus · ...bonus.daily_login 1000/0` ×3（09-08/09/10）、`bonus · ...bonus.new_subscribe 4000/144.72`、`basic · ...individual.trial 500/0`
-   用途：①权益包浮层从「4 个聚合桶」升级为**逐包明细**（含到期时间）；②**反推逐日签到历史**（`bonus.daily_login` 的 `createdTime`）

**② 区间汇总（stats）** —— `TOTAL_CREDITS / TOKEN_TOTAL / TOKEN_DAILY_AVG / REQUEST_COUNT / ACTIVE_DAYS / TOKEN_CACHE_HIT`

-   实测（30 天窗口 `2026-08-12 ~ 2026-09-10`）：`token=1,730,038`、`日均=57,667.93`（= 总量 ÷ 30）、  
    `请求=1`、`活跃=1 天`、`缓存命中=1,206,400`
-   ★注意 `TOKEN_DAILY_AVG` 的分母是**区间天数**，不是活跃天数

### 11.3 签到历史补齐（解决「连签 3 天却只显示 1 天」）

新增 provider 可选契约 `getCheckinHistory(task,{days})`，CodeArts 实现：  
拉 `credit/page` 全部分页 → 过滤 `resourceSpec` 含 `bonus.daily_login`  
→ `createdTime`（Asia/Shanghai 自然日）为签到日、`creditAmount` 为当日发放积分。

服务端 `/api/checkin/logs` 把「本地 `checkin_logs.json`」与「平台侧历史」合并，  
远端只补本地没有的日期并标 `source:'remote'`；前端用蓝色 `✓` 区分并给出图例。

**实测**：CodeArts 账号本地仅 1 天（09-10）→ 合并后 **3 天**（09-08、09-09 来自远端，各 +1000）。

### 11.4 复现命令

```bash
# 逐包明细
curl -s "http://127.0.0.1:3081/api/checkin/packages?id=<codearts taskId>"
# 合并后的签到历史
curl -s "http://127.0.0.1:3081/api/checkin/logs?taskId=<codearts taskId>"

```

* * *

## 12\. ★★ v2.0 重大变更（2026-09-12）：每日签到接口迁移 → 运营活动中心

### 12.1 现象

`CodeArts 码道 · 17327137416` 账号 09-12 00:02 起签到失败：

```
lastResult = "fail"    lastError = "领取失败（claim 返回 false）"    failCount = 2
credentialInvalid = false    credits = 8355.28（读余额正常）

```

-   签到日志：09-10 ✅ / 09-11 ✅（reward +1000）/ **09-12 ❌**
-   同时 `credentialTest`、`status`、`credits`、`usage` 全部正常 ⇒ **凭证确实是有效的**

### 12.2 根因（一句话）

**上游把「每日签到」从「套餐积分」接口迁移到了「运营活动中心」接口；旧路由保留但已不服务，  
改为返回 `HTTP 200 + 完全空响应体`。客户端仍调旧接口，把空体按 `false` 处理 ⇒ 签到必然失败。**

|  | 旧（已废弃） | 新（现行） |
| --- | --- | --- |
| 读「今日是否可领」 | `GET /portal/snap-manager/v1/credit/has-claimed` → 裸布尔 `true/false` | `GET /portal/promptcenter/v1/ops/delivery?channel=PORTAL` → `data.items[]` 里 `type=USER_LOGIN` 那项的 `claimable` |
| 领取 | `POST /portal/snap-manager/v1/credit/claim` `{credit_type:'daily_bonus'}` → 裸布尔 `true` | `POST /portal/promptcenter/v1/ops/claim` `{campaignId, channel:'PORTAL'}` → `{code:0,data:{status:'CLAIMED',totalAmount}}` |
| 领取流水 | `POST /package/credit/page` 过滤 `bonus.daily_login` | `GET /portal/promptcenter/v1/ops/credit/campaign/{id}` → `benefits[].claimedAt` |
| 活动积分总览 | —— | `GET /portal/promptcenter/v1/ops/credit/overview` |

**旧接口此刻的真实行为**（凭证有效、同一次请求里 `package/overview` 正常返回余额）：

```
GET  /snap-manager/v1/credit/has-claimed  -> 200  len=0  content-type=(无)  hw-ajax-redirect=(无)
POST /snap-manager/v1/credit/claim        -> 200  len=0  content-type=(无)  hw-ajax-redirect=(无)
GET  /snap-manager/v1/package/overview    -> 200  len=1113 content-type=application/json

```

⚠️ **「空响应体」有两种完全不同的含义，必须区分**：

-   **登录态失效**：`200 + 空体 + HW-AJAX-REDIRECT`（本文件 §1.6 已记，实测不带 Cookie 可复现）
-   **接口已废弃/故障**：`200 + 空体 + 无 HW-AJAX-REDIRECT + 无 content-type`（本次）

旧实现 `const ok = r.data !== null ? r.data : /true/i.test(r.text)` 对空体得到 `false`，  
于是「今天没领过」和「claim 失败」两个错误结论同时产生 —— **错误信息还具有误导性**。

### 12.3 定位方法（可复用，★比翻抓包快得多）

**上游改接口时，前端 bundle 会先变。所以「比对前端版本号 + grep 接口路径」是第一手段。**

```bash
# 1) 抓控制台首页 HTML（不带 x-requested-with，否则网关只回 JSON/404）
#    带会话 cookie 请求 /portal/settings/personal-usage?locale=zh-cn
#    → HTML 里能看到当前 bundle 版本，旧抓包是 126.8.310，现在是 126.9.107
# 2) 下主 bundle（约 17MB），grep 关键字符串
grep -o 'credit/claim'  _portal_bundle.js | wc -l     # 0  ← 已被前端弃用
grep -o 'has-claimed'   _portal_bundle.js | wc -l     # 0
grep -o '.\{140\}promptcenter.\{200\}' _portal_bundle.js

```

新 bundle 里的签到链路（原文）：

```js
IZn = "PORTAL"
lpc = (e = IZn) => ya.get({url:"/promptcenter/v1/ops/delivery", params:{channel:e}})
spc = e => ya.post({url:"/promptcenter/v1/ops/claim", body:e})
spc({campaignId: se, channel: IZn})              // se = items.find(type===DAILY_CLAIM).campaignId
edc = () => window.service_cf3_config?.basePath || "/portal"   // ★axios baseURL

```

⇒ 完整路径 = `https://codearts.huaweicloud.com/portal/promptcenter/v1/ops/...`。

**排除过程中用掉的关键对照实验**（结论：与客户端实现无关）

| 实验 | 结果 | 结论 |
| --- | --- | --- |
| 换手机 vs Windows（不同出口 IP） | 都是空体 | 排除 IP/网络/手机环境 |
| 复放 09-10 抓包里的**浏览器真实会话**（含 `cbc-sid` + 新鲜 WAF cookie） | 仍空体，而同 cookie 打 `package/overview` 正常 | 排除 cookie 组成 |
| 只发业务三件套 cookie / 去掉 `cftk` 头 / 加 `origin`+`sec-fetch-*` / 换 UA | 全部空体 | 排除请求头 |
| 补浏览器同源头、加 `?_=`、换 body 形态 | 全部空体 | 排除参数与 CSRF |
| 冒烟探针 `GET /credit/__nope__` | `400 TM.00001001`（路由不存在） | 证明 `/credit/*` **路由存在**，是业务层故意返回空 |
| 清空 cookie 重新登录 | 登录链报 `10000000 loginFlowContext is empty!`（另一个独立问题，见 §12.6） | 未污染结论 |

### 12.4 实证（2026-09-12 00:16–00:23 CST）

```
GET  /portal/promptcenter/v1/ops/delivery?channel=PORTAL
 -> 200 {"code":0,"data":{"items":[
      {"campaignId":1,"title":"每日签到领1000 积分","type":"USER_LOGIN",
       "benefitAmount":1000,"claimable":true,"status":"ELIGIBLE","pendingTotalAmount":1000.00,
       "extra":{"startTime":"2026-09-08T16:00:00Z","endTime":"2026-12-30T16:00:00Z",
                "triggerEvent":"user.login","triggerMode":"MANUAL_CLAIM"}},
      {"campaignId":2,"title":"学生认证领4000 积分","type":"STUDENT_CERTIFIED","claimable":false}]}}

POST /portal/promptcenter/v1/ops/claim  {"campaignId":1,"channel":"PORTAL"}
 -> 200 {"code":0,"data":{"id":5517,"campaignId":1,"status":"CLAIMED","totalAmount":1000.00,
          "claimedAt":"2026-09-11T16:19:50Z","expireAt":"2026-10-11T16:19:50Z",
          "pointBucket":"GENERAL","bucketLabel":"通用积分"}}

复查 claimable=false / status=CLAIMED；余额 8355.28 -> 9355.28（+1000，★分钟级延迟到账）

```

**三条结论**：

1.  **账号一直有资格**：`claimable=true`、`status=ELIGIBLE`、`pendingTotalAmount=1000`，  
    活动窗口 `2026-09-08 ~ 2026-12-30` —— **不是活动结束、不是额度用尽、不是风控**。
2.  活动下发项的 `type` 是 **`USER_LOGIN`**（不是前端枚举里的 `DAILY_CLAIM`），  
    代码里要同时接受两者，否则会「找不到签到活动」。
3.  `ops/*` 接口**参数校验极严**：只认 `channel`；多传 `?_=` 会 400 `HDN.1000 channel : unknown exception`  
    ⇒ 缓存破坏参数必须拼进 path，且不要再附加 query。

### 12.5 客户端改造（`lib/checkin/codearts.js` + `lib/providers/codearts.js`）

| 改动 | 说明 |
| --- | --- |
| 新增 `ENDPOINTS.opsDelivery/opsClaim/opsCreditOverview/opsCreditCampaign` | 旧 `hasClaimed/claim` 常量标为「已废弃，仅留作回归对照」 |
| 新增 `opsDelivery()` / `dailyCampaign()` / `opsClaim(id)` / `opsCreditOverview()` / `opsCampaignCredit(id)` | 信封统一是 `{code,message,data}`，**只认 `code===0`** |
| 重写 `hasClaimed()` / `claim()` | 不再有「正则判裸布尔」分支；异常时返回 `broken:true` |
| 重写 `checkin()` | ① 接口异常（`code!=0`）抛 **`kind='transient'`**，绝不标成凭证失效；② 跳过写请求的条件改为 `campaign.claimable===false`；③ **当日所得直接取活动返回的 `totalAmount`/`benefitAmount`**，不再用余额差（余额是分钟级延迟到账的，同一秒内差值恒为 0） |
| `checkSession()` 改打 `ops/delivery` | `valid` 仍只看有无 `HW-AJAX-REDIRECT`（保持会话巡检语义，避免接口故障被误判成凭证失效而误发邮件）；另暴露 `apiOk` / `code` |
| `getCheckinHistory()` | **①运营活动流水（`benefits[].claimedAt`）优先 → ②旧「权益包明细」补迁移前历史**，按日期去重（新数据源优先） |
| 新增 `export const OPS_CHANNEL='PORTAL'` / `OPS_DAILY_TYPES=['USER_LOGIN','DAILY_CLAIM']` | channel 是无参数字符串常量，必须与前端一致 |

**远端部署与验收（2026-09-12 00:23）**

```bash
cp lib/checkin/codearts.js lib/providers/codearts.js ~/monitor/backup/20260912-ops-claim/   # 先备份
node --check lib/checkin/codearts.js && node --check lib/providers/codearts.js
node _selftest_providers.mjs        # 通过 70，失败 0
bash deploy-remote.sh               # runit 原子重启（sv restart server）

```

```
POST /api/checkin/test?id=<ca>      -> {"ok":true,"total":9355.28,"valid":true}
GET  /api/checkin/status?id=<ca>    -> {"ok":true,"checked_in":true,"credits":9355.28}
POST /api/checkin/run?id=<ca>       -> {"ok":true,"alreadyCheckedIn":true,"credits":9355.28,"reward":null}
                                       ↑ 已领则不发写请求（幂等短路生效）
GET  /api/checkin/logs?taskId=<ca>  -> 09-08/09-09(remote) + 09-10/09-11/09-12(local) = 5 天
任务状态 -> lastResult=success  lastError=null  failCount=0  todayCheckedIn=true

```

### 12.6 遗留问题（本次未修，与本 bug 无关）

-   ~**密码重登链已失效**：`ensureSession()` 走 `login()` 时被上游拒为  
    `isSuccess=0, errorCode=10000000, errorDesc="loginFlowContext is empty!"`~  
    → **已于 2026-09-12 定位并修复，见 §13。**
-   **活动积分进入独立桶**：`pointBucket=GENERAL（通用积分）`，与「套餐积分」  
    （`package/overview`，面板余额口径）是两套账；实测约 2~3 分钟后才会计入套餐余额。  
    面板暂时只显示套餐积分，签到当日所得由 `reward` 字段单独体现。
-   `ENDPOINTS.memberRoles/ssoUser` 的路径是错的（真路径是 `/snap-manager/v1/member/roles`、  
    `/snap-manager/v1/sso/user`，抓包目录名用 `_` 代替了 `/` 才看不出）。  
    这两个常量当前无调用方，暂不修，仅记录。

### 12.7 可复现命令

```bash
# 证据摘录（远端）：~/monitor/_ops_claim_evidence.txt
# 探针留档（远端）：_ca_probe_v{3,4,5,6,9,10,11,12}.mjs / _ca_hdr_probe.mjs / _ca_local_probe.mjs
node _ca_local_probe.mjs      # 本机复现「旧接口 200+空体 / package 正常」
node _ca_probe_v10.mjs        # 新接口投放列表（含 claimable）
node _ca_probe_v11.mjs        # 新接口真实领取（含余额前后对比）

```

* * *

# §13 密码重登链修复（2026-09-12）—— `loginFlowContext is empty!` 根因

> 抓包依据：`examples/codearts首次登录与二次登录_解析结果`（337 条，2026-09-12 00:30 抓取，  
> 完整覆盖「首次登录（走设备二次验证）」+「logout 后二次登录（受信设备）」两条链）。  
> 探针留档：`monitor/_ca_probe_v13/v14/v15/v16.mjs`。

## 13.1 结论速览（两个真 bug + 三个补全）

| # | 症状 / 缺陷 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `login()` 恒失败：`10000000 loginFlowContext is empty!` | `unionLoginByPwd` 的 `anonymousLoginID` 被拼成 `${anonymousAccount}|${anonymousEncryption}`（把 JWT 一起带上） | 只传**裸匿名账号** `l****an` |
| 2 | 登录「成功」但业务请求仍 200+空体 | 落地链第 2 跳即跨域，`follow` 默认仅同源 → 停在跨域，随后直接 GET `SERVICE`，**丢掉 `?ticket=ST-…`** | 手动逐跳跟随并保留 ticket（`_landBusinessSession`） |
| 3 | `needPopTrust=true` 后流程没走完 | 旧实现只把它当 `needVerify` 上报，从不调信任接口 | 补 `login/updateTrustBrowser`（`operType=1&trustBrowser=1`） |
| 4 | 设备验证「纯 HTTP 走不通」（旧结论） | 误用 `/CAS/IDM_W/ajaxHandler/cloudAuthLogin`（另一命名空间，无登录态）→ `10000600 cloudLoginBean is null` | 改在**同端点**重放 `login/unionLoginByPwd`（`opType=1` + 验证码） |
| 5 | 中途插入的「绑定 MFA」页会打断落地 | 该页是 HTML 中间页（非 302），需 POST `validateUser` 才能继续 | `_dismissBindMfa()`：取 `IAMCSRF` → POST → 继续跟随 |

★ 第 1 条就是长期挂在 §12.6 的「密码重登链已失效」，**与 hwmeta / flowID 无关**；  
第 4 条推翻了 §1.9 记的「纯 HTTP 无法完成新设备验证」——那其实是**路径选错**。

## 13.2 bug 1：`anonymousLoginID` 必须是裸账号

抓包里三次 `unionLoginByPwd`（第 96 / 108 / 279 条）**全部**是：

```
anonymousLoginID=l%2A%2A%2A%2Aan        # 即 l****an，无任何后缀

```

而代码写的是：

```js
anonymousLoginID: accountInfo.anonymousAccount
  ? `${accountInfo.anonymousAccount}|${accountInfo.anonymousEncryption || ''}` : '',

```

`anonymousEncryption` 是 `getLoginIdsByPwd` 返回的一枚 JWT（`{"did":"…","cat":…,"type":"2"}`），  
**不是** `anonymousLoginID` 的组成部分。带上它之后服务端查不到登录流程上下文：

```json
{"errorCode":"10000000","errorDesc":"loginFlowContext is empty!","isSuccess":0}

```

**实证（`_ca_probe_v13.mjs`，每个变体都从空 jar 全新走一遍）**：

```
V1 现状基线   sdkService=CAS + anon=account|encryption  → isSuccess=0 err=10000000 loginFlowContext is empty!
V2 仅修 anon  sdkService=CAS + anon=account             → isSuccess=1 hasCallback=true   ★
V3 anon+service sdkService=plain&site=mainland + anon=account → isSuccess=1 hasCallback=true
结论: V1=false  V2=true  V3=true

```

⇒ 单变量对照证明 **根因就是 `anonymousLoginID`**。顺带说明：`getSDKBaseInfo` 的  
`service` 用 `SERVICE` 还是 `CAS_SERVICE`、带不带 `&site=mainland`，对结果**无影响**  
（抓包里前端用的是 `SERVICE` + `site=mainland`，可以照抄，但不是必要条件）。

## 13.3 bug 2：落地必须逐跳手动跟随并保留 ticket

实测链路（抓包第 140~141 条 / 292~307 条）：

```
authui/casLogin?…&code=…   → 302  authui/login?service=…        （种 SSOJTC/SSOTGC/user_tag/domain_tag）
authui/login?service=…     → 302  codearts…?ticket=ST-…          （种 devclouddevuibjJ_SESSION_ID）
codearts…?ticket=ST-…      → 302  codearts…                      （种 …agencyID）
codearts…                  → 200                                 （种 …tcftk）

```

第 2 跳就跨到 `codearts.huaweicloud.com`，而 `HttpClient.request` 的 `follow` 默认  
`samehostOnly=true`，**跟到跨域即停**（返回 `stoppedAt`）。旧实现：

```js
await this.http.get(lr.code);                    // 只拿到 casLogin 的 302
await this.http.get(lr.code, { follow: true });  // 跟到跨域即停
await this.http.get(SERVICE, { follow: true });  // ★ 直接打干净页，ticket 丢了

```

**实证（`_ca_probe_v14.mjs`）**：

```
【方式 A】现状实现 → 命中 cookie: devclouddevuibjJ_SESSION_ID          (1/3)  jar=25
【方式 B】逐跳手动跟随 → 命中 3/3 + jar=27

```

新实现 `_landBusinessSession(codeUrl)`：循环 `get(cur, {follow:false})`，  
每跳后检查 `SESSION_COOKIES` 是否齐备，有 `location` 就继续，否则尝试 `_dismissBindMfa`，  
最多 10 跳；失败时把 `trail` 一并回传，便于诊断。

## 13.4 补全 3：`needPopTrust` → `updateTrustBrowser`

抓包第 108 条 `unionLoginByPwd` 成功且返回 `needPopTrust: true`，紧接着第 111 条：

```
POST /UnifiedIDMPortal/ajaxHandler/login/updateTrustBrowser
userAccount=008617327137416&operType=1&trustBrowser=1
&anonymousLoginID=l****an&localStorageID=…&hwid_cas_sid=…
→ {"isSuccess":1,"localStorageID":"…"}

```

旧实现把 `needPopTrust` 当成「需要人工验证」上报（`needle()`），登录其实没走完。  
现在改为：`if (login.needPopTrust) await this._stepTrustBrowser(accountInfo)`，然后正常收尾。

## 13.5 补全 4：设备验证 = 同端点 `opType=1` 重放

抓包第 96 / 108 条：**同一个** `login/unionLoginByPwd` 调用两次。

|  | 第 1 次（96） | 第 2 次（108） |
| --- | --- | --- |
| `opType` | `0` | **`1`** |
| 新增字段 | — | `verifyUserAccount=Honor 10`、`verifyAccountType=-1`、`twoStepVerifyCode=817983` |
| 响应 | `errorCode=10002080`，`errorDesc` 内嵌 `authCodeSentList` | `isSuccess=1` + `callbackURL` + `needPopTrust:true` |

`10002080` 的 `errorDesc` 结构（原文）：

```json
{"authCodeSentList":[{"accountType":-1,"name":"Honor 10","sent":1,"type":"device"},
                     {"accountType":-1,"name":"乐幻的Nova14Pro","sent":1,"type":"device"},
                     {"accountType":-1,"name":"MatePad Pro","sent":1,"type":"device"},
                     {"accountType":2,"name":"173******16","sent":0}],
 "riskFlag":"001000000011100001000010000"}

```

⇒ **验证码在第一次调用时就已下发**（`sent=1`），不需要另一个「下发」接口；  
第 2 次用 `verifyUserAccount` 选中设备（这里选 `Honor 10`）。

因此 `requestVerifyCode()` / `submitVerifyCode()` 全部改到 UnifiedIDMPortal 命名空间，  
旧的 CAS 路径（`CAS/IDM_W/ajaxHandler/{cloudIframeAuthIdentify/getPageInfo, cloudAuthLogin}`）  
**整体下线**——它必然返回 `10000600 cloudLoginBean is null`。

## 13.6 补全 5：「绑定 MFA」提示页

第 2 次登录时出现过（第 293~305 条），是个 **HTML 中间页**（`loginBindMfa.html`，HTTP 200，非 302），  
不处理就断链：

```
GET  /authui/loginBindMfa.html?isFromID=1&service=…        → 200  （前端壳）
GET  /authui/login.html?isFromID=1&service=…               → 200
GET  /authui/getAntiPhishingInfo?isSupport=true&isBindMfa=true
     → {"IAMCSRF":"c8dd04859b984aad934a3067cfbf57bb","promptBindMfa":"promptRedirectEnable",
        "showRememberPromptMfaDays":"30", …}                ← ★令牌来源
POST /authui/validateUser?isFromID=1&service=…
     step=afterBindMfa&IAMCSRF=…&isConfirmed=false&type=console_vmfa
     &rememberPromptMFA=true&isSupport=true&isFromID=1      → 302 login?service=…
     并回种 rememberPromptMFA_<uid>_<rand>=1（Max-Age=2592000 = 30 天）
GET  /authui/login?service=…                               → 302 codearts…?ticket=ST-…

```

`isConfirmed=false` 即「暂不绑定」，服务端放行并记住 30 天不再提示。  
前端 `app.bundle.js` 里也能对应上（`e.model.IAMCSRF = …n.IAMCSRF`）。

## 13.7 交付与验收（2026-09-12 00:45 实测）

改动文件（远端备份：`~/monitor/backup/20260912-login-fix/`）：

| 文件 | 改动 |
| --- | --- |
| `monitor/lib/checkin/codearts.js` | 1169 → 1299 行：修 `anonymousLoginID`；新增 `_landBusinessSession` / `_dismissBindMfa` / `_stepTrustBrowser`；重写 `login()` 收尾、`requestVerifyCode`、`submitVerifyCode`；删除 `needle()` |
| `monitor/lib/providers/codearts.js` | 604 → 608 行：更新注释；`submitVerifyCode` 区分「验证码错」与「落地失败」（新增 `landingFailed`），去掉 `namespaceMismatch` 分支 |

验收记录：

```
node _selftest_providers.mjs        → 通过 70，失败 0

_ca_probe_v15.mjs
  STEP 1 旧会话 checkSession={"valid":true,"apiOk":true,"code":0,"status":200}  remain=9355.28
  STEP 2 全新空 jar + hwidCasSid → login={"ok":true}  cookie 27 个，业务 cookie 3/3，缺=[]
  STEP 3 新会话 package/overview 200 remain=9355.28
         ops/delivery code=0（每日签到领1000 积分 / USER_LOGIN）
         getStatus checkedInToday=true campaign.status=CLAIMED benefitAmount=1000

_ca_probe_v16.mjs
  A) client.requestVerifyCode() → {"ok":true,"alreadyTrusted":true,"session":true}  业务 cookie 3/3
  C) provider.requestVerifyCode() → {"ok":true,"alreadyTrusted":true,"message":"设备已受信…"}

bash deploy-remote.sh                → sv restart server (pid 5750)
POST /api/checkin/test?id=<ca>       → {"ok":true,"total":9355.28,"valid":true}
GET  /api/checkin/status?id=<ca>     → {"ok":true,"checked_in":true,"credits":9355.28}
POST /api/checkin/run?id=<ca>        → {"ok":true,"alreadyCheckedIn":true,"reward":null}
任务状态                              → lastResult=success lastError=null failCount=0

```

⚠️ **尚未实机验证**：真实「新设备 → 收短信码 → 提交」路径（需要 `hwid_cas_sid` 失效才触发，  
主动制造会消耗真实短信码并可能改变设备信任状态）。当前只验证了受信设备下的  
`alreadyTrusted` 短路分支；`opType=1` 分支的**字段与端点**已按抓包 1:1 对齐，  
但首次真实触发时需留意。

## 13.8 可复现命令

```bash
# 远端探针留档
node _ca_probe_v13.mjs    # 单变量定位 anonymousLoginID（V1 失败 / V2 成功）
node _ca_probe_v14.mjs    # OAuth 逐跳追踪（方式 A 1/3 vs 方式 B 3/3）
node _ca_probe_v15.mjs    # 修复后端到端：login() + 业务接口
node _ca_probe_v16.mjs    # 设备验证分支（alreadyTrusted 短路）

# 本地解码抓包里的 fp / hwmeta（XOR 滚动密钥）
python examples/_decode_hwmeta.py

```

## 14\. 真实「新设备 → 短信码 → opType=1」分支实测（2026-09-12 01:00）

> 用户要求真实走一遍首次登录分支：全新指纹触发 10002080 → 短信码下发 →  
> `AskUserQuestion` 收码 → `opType=1` 提交 → 落业务会话 → 验证 sid 持久受信。  
> **全链路已跑通**，且顺带发现并修复 2 个新 bug。

## 14.1 结论速览

| # | 结论 | 证据 |
| --- | --- | --- |
| 1 | 全新指纹（新 fpSeed + 空 sid + 空 cookie）必触发 `10002080`，`errorDesc` 携带 `authCodeSentList`（与抓包第 79/96 条逐字段一致，含 `riskFlag`/`extInfo`） | v17a |
| 2 | `opType=1` + `twoStepVerifyCode` + `verifyUserAccount="Honor 10"` + `verifyAccountType=-1` → `isSuccess=1`，随后 OAuth 3/3 cookie 落地、`package/overview` 200 | v17b |
| 3 | ★ **验证通过后签发的 sid 是持久受信令牌**：全新空 cookie jar 只带该 sid + 同 fpSeed 重登 → `isSuccess=1`（免验证、不发短信） | v19-A |
| 4 | ★ **信任不绑定 localStorageID**：发全新 hwidConfig 下发的 localStorageID（`xEc3gVuarQ…`）替代存量（`WfrLXYmvqV…`），生产身份依然 `isSuccess=1` → `parseHwidConfig` 修复无回归 | v20 |
| 5 | 生产会话零扰动：探针全程只读不写回；`/api/checkin/test` → `{ok:true, valid:true, total:9355.28}` | v17b/v19/v20 + API |

## 14.2 顺带发现并修复的 2 个新 bug

**bug 3：`hwidConfig` 是一层 URL 编码的 JSON 字符串，不是对象**

旧代码 `const cfg = info.hwidConfig || {}` 把 14k+ 字符的编码串当对象用，  
`cfg.cookieVersion`/`cfg.localStorageID` 永远 undefined：

-   `cookieVersion` 一直退回常量兜底（碰巧值相同，没炸）；
-   `localStorageID` 一直空串发送（与抓包不一致，`common/dev`/`getLoginIds` 都带它）。

修法：新增 `parseHwidConfig(raw)`（`decodeURIComponent` + `JSON.parse`，解码后 87 键），  
`_bootstrap` 改用 `cfg.localStorageID` / `cfg.cookieVersion`，并把 `service` 参数  
从 casLogin 包裹串改为**业务地址本身 + `site=mainland`**（抓包第 29 条）。

**bug 4：`submitVerifyCode` 忽略 `deviceIndex`**

旧代码 `find(d => d.sent === 1) || this.authDevices[deviceIndex]` —— 多设备时用户选哪台  
都没用，永远发给列表里第一台 `sent=1` 的设备。修法：先取 `authDevices[deviceIndex]`，  
是 `sent===1` 就用它，否则才回退到 `find`。

**（探针侧）bug 5：v17a 直接调 `_stepUnionLogin`，绕过了 `login()` 里  
`this.authDevices = parseAuthCodeSentList(login.errorDesc)` 的赋值** —— 落盘状态里  
`authDevices` 恒为空数组，v17b 无从提交。已在探针里补上这一行。

## 14.3 真实流程实录（时间线）

```
00:54  v17a  fpSeed=codearts-verify-probe-1789145681056（全新）
             bootstrap=1 → dev 新签发 sid(len)=84
             → unionLoginByPwd isSuccess=0 errorCode=10002080
             authCodeSentList: Honor 10(sent=1) / 乐幻的Nova14Pro(sent=1) / 173******16(sent=0)
             riskFlag="001000000011100001000010000"  ← 与抓包逐字段一致
             状态落盘 _ca_verify_state.json（含真实 localStorageID h6I30723aXnO…）
00:55  AskUserQuestion 收码 → 用户答 655896（两台设备都收到）
00:56  v17b  opType=1 twoStepVerifyCode=6位 verifyUserAccount="Honor 10" verifyAccountType=-1
             anonymousLoginID=l****an（裸匿名账号） hwid_cas_sid=yes(84)
             → ok:true；业务 cookie 3/3；package/overview 200 remain=9355.28
00:58  v19-A 空 cookie jar 只带该 sid 重登 → isSuccess=1（免验证）→ 3/3 cookie → API 200
00:59  v20   生产身份（codearts-checkin + 存量 sid）+ 新代码发全新 localStorageID
             → isSuccess=1 ⇒ parseHwidConfig 修复无回归
01:00  /api/checkin/test → {ok:true, valid:true, total:9355.28}

```

## 14.4 对生产部署的指导

-   **日常**：仍用存量受信 sid（`codearts-checkin` 指纹），不碰验证分支。
-   **会话失效自动重登**：`login()` 走受信 sid，`isSuccess=1` 免验证，无需人工。
-   **真正的新设备/换机**：`login()` 返回 `needVerify:true + authDevices` → 前端展示设备表  
    让用户选 → `requestVerifyCode()`（若 `authDevices` 已在 10002080 里，验证码**已下发**，  
    不要重复调）→ 用户收码 → `submitVerifyCode(code, deviceIndex)` → 成功后  
    `getState()` 里是新受信 sid，**写回 task.config 即完成换机**。
-   **信任绑定关系**（实测）：`hwid_cas_sid` + 设备指纹（fpSeed）。**不绑定**  
    localStorageID（每次可换新），cookie jar 也不是必需（空 jar 亦受信）。
-   **重要**：换 fpSeed = 换设备 = 重新走一次短信验证。fpSeed 一经验证就不要再改。

## 14.5 可复现命令（新增）

```bash
node _ca_probe_v17a.mjs          # 触发真实 10002080（会发短信！），状态落盘
node _ca_probe_v17b.mjs <code> [deviceIndex]   # opType=1 提交验证码
node _ca_probe_v18.mjs           # 证实 hwidConfig 是 URL 编码 JSON（87 键）
node _ca_probe_v19.mjs           # 验证通过后 sid 是否持久受信（免短信）
node _ca_probe_v20.mjs           # 生产身份 + 新代码回归检查（免短信，不碰业务会话）

```

## 15\. 「04:00 会话失效，重登后仍失效」定位与修复（2026-09-12 11:00）

> 现象：04:00 巡检发现 17327137416 会话失效；自动重登跑完、任务配置也写回了  
> （cookie 27→26、`localStorageId` 变化），但探活**仍然失效**，  
> API 返回 `{"ok":false,"error":"重登后会话仍无效","kind":"invalid"}`。

## 15.1 定位（探针 v21 A/B 对照）

| 变体 | login() | jar 里业务 cookie | 重登后 ops/delivery |
| --- | --- | --- | --- |
| **A 生产路径**：脏 jar（任务保存的旧 cookies）随 `login()` 全程 | `ok:true` | 3/3（**全是旧的**，landing 根本没换新） | `expired=true`，`hw-ajax-redirect="…/authui/login?service="`（service 为空） |
| **B 对照**：干净 jar（只带 `hwid_cas_sid`） | `ok:true` | 3/3（新签发） | `expired=false`，`code:0` 正常 |

**根因**：`ensureSession()` → `login()` 带着**脏 cookie jar** 去重登。OAuth 落地跳把  
`?ticket=ST-…` 换进了**旧（已失效）会话**而不是签发新会话；`_landBusinessSession` 的  
成功判据只看「3/3 cookie 是否存在」，旧 cookie 天然满足 ⇒ `login()` 假成功，  
jar 里写着旧会话的 cookie 被原样写回任务，于是「重登后仍失效」。

（04:00 会话为什么死：无法完全区分是业务会话自然过期，还是前一晚 §14 的验证探针  
v19-A/v20 各自完整登录落地了新业务会话、触发单会话策略把旧会话挤掉。  
两者都属正常失效场景 —— 真正的缺陷是**重登无法自愈**。）

## 15.2 修复（1 个方法 + 1 行调用）

-   `HttpClient.resetKeeping(keep)`：清空 jar，仅保留指定 cookie。
-   `login()` 开头：`this.http.resetKeeping(['hwid_cas_sid'])` —— 重登一律从  
    「只带信任令牌」的干净 jar 开始（与 §14 实测的受信形态完全一致：信任绑定  
    `sid + fpSeed`，旧业务 cookie 对登录链毫无价值、只会串会话）。

## 15.3 验收

```
v21 变体A（修复后）：login ok:true → jar 26→27（全新）→ ops/delivery code:0
                    → packageOverview 200 remain=9355.28
API：test → {ok:true, valid:true, total:9355.28}；credits → ok
任务写回：cookies 27（全新），lsid=Mbrdeseb9mOf…，sid 头 2049373b（信任令牌不变）
自检：_selftest_providers.mjs → 70/0；runit 重启 pid 10740 单实例
备份：~/monitor/backup/20260912-dirty-jar/

```

## 15.4 经验

-   **「重登成功」不能只看 cookie 齐不齐** —— 旧 cookie 永远是「齐」的。必须用业务接口  
    复探（`HW-AJAX-REDIRECT`）闭环，`ensureSession()` 已有这一步，缺的是 login() 前清 jar。
-   **带凭证状态的客户端复用前，先想清楚哪些 cookie 是「会话」哪些是「设备」**：  
    设备信任令牌（`hwid_cas_sid`）跨会话复用，会话类 cookie 一律扔掉重来。
-   对照实验设计：生产路径（脏 jar）vs 已验证形态（干净 jar）只差一个变量，一次跑出根因。

## 16\. 19154975875 登录失败定位 + 「图片验证码门 → 手机号-only」分支实测（2026-09-12 12:40）

> 用户反馈 19154975875 浏览器登录不上去，并补充新抓包目录  
> `examples/codearts短信验证码登录_解析结果`（场景：**账号无设备验证项、仅支持手机号验证**）。  
> 判定规则：**触发图片验证码即判定本次登录失败** —— 本次 087 触发了 ⇒ 判失败  
> （但抓包把过码后的完整链路也录到了，见下）。

### 16.1 结论速览

| # | 结论 | 证据 |
| --- | --- | --- |
| 1 | 账号/密码/短信通道全部正常；卡住的是**风控**：第一次密码提交即要求图片验证码 | 086 识别成功、087 `10000706`、137 发短信 `isSuccess:1` |
| 2 | `10000706 need picture authcode risk`（orgErrorCode `70002082`，captchaType 5，riskFlag `011000000011100001000010000`）= 网易易盾图形验证码门；**该门未出现在主账号与 §14 探针的历史链路里**，riskFlag 第 2 位组由 `0`→`1` 表示风控升档 | 087 响应 vs §14.3 v17a riskFlag `0010…` |
| 3 | 过码后重试 `unionLoginByPwd`（带 `authcode={type:2,sceneId:"login",challenge,hcg,hct,validate}`）→ `10002080`，`authCodeSentList=[{accountType:2, name:"191******75", sent:0}]` —— **只有手机号、无任何设备项** | 120/136 响应 |
| 4 | ★ **`sent=0` 与设备项 `sent=1` 行为不同**：手机号验证码**不会自动下发**，必须显式调 `login_getSMSCodeV3`（`operType=8&smsReqType=6&accountType=2&mobilePhone=<打码值>`），且该请求**不带 authcode**（发短信不需要图形码结果） | 136→137 参数比对 |
| 5 | 抓包止于发码成功（137 `isSuccess:1`），**未含输码提交环节**（140+ 均为无关流量） | 目录 143 条 |

### 16.2 hwid\_cas\_sid 长度与浏览器查找方法（答复「几位数？浏览器里找不到」）

-   **不是固定位数的数字，是十六进制字符串**。历史记录：§6.6 纯 Python fp 签发 **64 字符**（2026-09-10）、  
    §14.3 探针签发 **84**（2026-09-12）、本次浏览器抓包 **84**（`2049375b375e396b…382e377e`，  
    同会话 087/120/136/137 四请求携带同一值）⇒ **长度不固定（64~84 均有），勿按位数匹配**。
-   浏览器找不到的原因：Cookie 域是 **`id1.cloud.huawei.com`**（[cloud.huawei.com](http://cloud.huawei.com) 家族），与  
    codearts / [auth.huaweicloud.com](http://auth.huaweicloud.com)（[huaweicloud.com](http://huaweicloud.com) 家族）不同站，那两个页面的 Cookie 列表看不到。  
    `Set-Cookie: hwid_cas_sid=…; Domain=id1.cloud.huawei.com; Max-Age=315360000; Path=/; Secure; SameSite=None`  
    （10 年有效，**无 HttpOnly**）。
-   查法（Edge）：F12 → 网络 → 过滤 `id1.cloud.huawei.com` → 任一请求（如 `common/dev`）→「Cookies」子标签；  
    或控制台把执行上下文切到 `id1.cloud.huawei.com`（登录框 iframe）→ `document.cookie`；  
    或 `codearts_login.py --save-session` 后读会话文件的 `hwidCasSid` 字段。

### 16.3 完整链路实录（本次抓包）

```
068  common/dev            → 新签发 sid 84 位，Set-Cookie hwid_cas_sid（见 16.2）
086  getLoginIdsByPwd      → isSuccess:1（le****an / innerUID=01a093a7… / inputAccountType=2 / CN）
087  unionLoginByPwd opType=0（无 authcode）→ ❌ 10000706 need picture authcode risk
                           extErrorDesc: captchaType=5, orgErrorCode=70002082
                           riskFlag=011000000011100001000010000   ← 图片验证码门 ⇒ 按规则判失败
091  cscPreprocess         → appId/businessId=huaweiup, sceneId=login,
                           challenge=8c06d944…20cb7, hcg=e2edfdbe…28d81, hct=1789184602726, type=2
093  csc-adapter/…/captchaid → captchaId=06c84107…, 网易易盾域名（c.dun.163.com / necaptcha.nosdn.127.net / cstaticdun.126.net）
095-113 易盾 JS + 验证码图片下载
117  c.dun.163.com/api/v3/check → 过码
108/126 ac.dun.163.com/v3/b  → __wmjsonp_…([200,…])  过码成功
120  unionLoginByPwd 重试  → 10002080, authCodeSentList=[{accountType:2, name:"191******75", sent:0}]
     请求新增 authcode={"type":2,"sceneId":"login","lang":"zh-CN",
            "challenge":"8c06d944…","hcg":"e2edfdbe…","hct":1789184602726,
            "validate":"CN31_STjrVUb*…"}   ← cscPreprocess + 网易过码结果拼装
128/129/134/142 扫码登录并行轮询（authui/qrcode/status，与本链路无关）
135  getLoginIdsByPwd      → 再次成功（136 的前置）
136  unionLoginByPwd 重放  → 仍 10002080（sent:0，手机号-only）
137  getSMSCodeV3          → operType=8, smsReqType=6, accountType=2,
                           mobilePhone=191%2A%2A%2A%2A%2A%2A75（打码值原样回传），无 authcode
                           → ✅ isSuccess:1（短信已发出）
（抓包结束，无 opType=1 输码提交环节）

```

### 16.4 与 §14 设备验证分支的关键差异

| 维度 | §14 设备验证（Honor 10 等） | 本节 手机号-only |
| --- | --- | --- |
| `authCodeSentList` | 设备项 `sent=1`（**系统已自动发码**，勿重复调） | 手机项 `sent=0`（**必须显式调 getSMSCodeV3**） |
| 前置门槛 | 无图形验证码 | **先过易盾图形验证码**（10000706 → authcode 重放） |
| 验证目标 | 设备名 `verifyUserAccount="Honor 10"` + `verifyAccountType=-1` | 手机号 `verifyUserAccount=191*****75` + `verifyAccountType=2`（推断，抓包未含提交环节） |
| 发码请求 | 不需要 | `getSMSCodeV3`（operType=8, smsReqType=6, accountType=2, mobilePhone=列表里打码值） |

### 16.5 对自动化（monitor）的判定规则

1.  **fail-first**：`unionLoginByPwd` 返回 `10000706` / `errorDesc` 含 `need picture authcode risk` /  
    `extErrorDesc.orgErrorCode=70002082` / 流量出现 `cstaticdun.126.net`、`ac.dun.163.com` →  
    **直接判任务失败**，不尝试过码（用户规则；过码依赖网易私有协议，不稳定且违反判定约定）。
2.  **sent 语义**：`authCodeSentList` 里 `sent===1` ⇒ 码已下发，直接等用户输码（§14.4 已有）；  
    `sent===0`（手机号-only）⇒ 先调 `getSMSCodeV3` 再收码，**不要**误判为「已发送」。
3.  **提交**：`opType=1` + `twoStepVerifyCode` + `verifyUserAccount`（手机号打码值）+  
    `verifyAccountType=2`（设备为 -1）。
4.  **风控升级信号**：riskFlag 第 2 位组 `1`（`0110…`）= 图形码门；日常登录若反复出现，  
    说明指纹/频率已被标记，应停手降温而非硬试。

> **✅ 已实现（2026-09-12 同日）**：上述规则已全部落入 `monitor/lib/checkin/codearts.js`
> 与 `monitor/lib/providers/codearts.js`：
>
> - `RISK_CAPTCHA_CODES` / `isRiskCaptcha()`：错误码 + 文案双通道判定，`login()` 与
>   `requestVerifyCode()` 均在 10002080 判定**之前** fail-fast（`ensureSession` 的
>   `if (!r.ok) return r` 保证签到路径判失败而非 transient 重试）。
> - `_stepGetSmsCodeV3()`：逐字段对齐第 137 条抓包（`operType=8` / `smsReqType=6` /
>   `accountType=2` / `mobilePhone=打码值原样回传` / 无 authcode）。
> - `_ensureSmsSent()`：幂等补发（成功即置 `sent=1`），`requestVerifyCode`（含缓存
>   命中路径）与 `submitVerifyCode` 三个入口都调用，堵住「sent=0 误当已发送」。
> - provider 层：`phoneOnly` 提示语（「验证码已通过短信发送到绑定手机号」）、
>   `riskCaptcha` 透传给 UI。
> - 附带修复：补建了 `monitor/lib/providers/common.js`（此前 `codearts.js` 引用
>   `./common.js` 但文件不存在，server.js 一启动就 ERR_MODULE_NOT_FOUND）。
> - 自测：`monitor/_selftest_codearts.mjs` 新增 5/6/7/8 四组用例（风控判定 /
>   手机号-only 解析 / getSMSCodeV3 请求体逐字段对齐 + 幂等 /
>   **unionLoginByPwd 提交步骤 opType=1 请求体对齐 + localStorageID 更新**），全部通过。
> - **✅ 已抓包确认（2026-09-12 第二次抓包）**：第 3 条「提交参数」已由
>   `examples/codearts短信验证码登录_解析结果` 第 110 条逐字段确认：
>   `opType=1` / `twoStepVerifyCode=337245` / `verifyAccountType=2` /
>   `verifyUserAccount=191******75`（手机号打码值），与设备分支仅 `verifyAccountType`
>   不同（设备为 -1，手机号为 2）。
> - **✅ localStorageID 轮换**：同次抓包第 110 条响应下发**新 `localStorageID`**
>   （`AqadBXxTb14y…` → `6XL8nfDBem7…`），第 113 条 `updateTrustBrowser` 必须用新值。
>   代码 `_stepUnionLogin` 已加 `if (res.localStorageID) this.localStorageId = res.localStorageID`，
>   自测用例 8 覆盖此路径。


### 16.6 长期方案

与 §14.4/§15 一致：**浏览器手动过一次滑块**完成登录，让该账号获得受信 `hwid_cas_sid`  
（主账号即此形态），此后 `login()` 带 sid + 同 fpSeed 即免验证；换 fpSeed = 换设备 = 重新走验证。