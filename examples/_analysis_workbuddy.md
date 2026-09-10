# WorkBuddy「成长 / 签到」平台 API 目录

> 来源：对 `examples/workbuddy_解析结果/` 下 HTTP 抓包解析结果（请求.txt / 响应.txt / 响应体.json）的人工梳理。
> 目标：为「展示型看板」设计新的签到 Provider，提供字段级、可直接对接的 API 目录。
> 抓包时间参考：2026-09-07（响应 `date` 头），演示账号 x-user-id = `bb1a0124-b950-4052-9904-bc45ccd68bf0`。

---

## 全局约定（GLOBAL CONVENTIONS）

### 基础域名（Base domains）
| 域名 | 用途 |
|---|---|
| `www.workbuddy.cn` | **主 API 域名**，所有 `/activity/growth/*`、`/console/*`、`/billing/*`、`/v1/metrics`、`/v2/plugin/*` 均在此域 |
| `download.codebuddy.cn` | 登录页静态资源（JS/CSS/图片）、部分 buddy 资源 |
| `staging-download.codebuddy.cn` | buddy 模板 / 运营素材（大部分 buddy 形象图） |
| `static.workbuddy.cn` | travel（出行）场景预览/在途照片 |
| `acc-1258344699.cos.accelerate.myqcloud.com` | 徽章 / 任务图标 / buddy 静态资源（COS 加速） |
| `dscache.tencent-cloud.cn` | 徽章图片（uploader 上传） |
| `openplatform-cdn.codebuddy.cn` | 运营平台素材（部分 badge 图） |

> 所有接口均为 **HTTPS / HTTP2**；反向代理为 `APISIX/3.9.1`。

### 通用响应信封（Common response envelope）
绝大多数业务接口返回统一结构：
```json
{ "code": 0, "msg": "OK", "requestId": "<uuid>", "data": { ... } }
```
- `code` : int — `0` 表示成功；非 0 为业务错误
- `msg` : string — 提示文案（成功为 `"OK"`）
- `requestId` : string — 与响应头 `x-request-id` 一致
- `data` : object/array — 业务载荷（各接口不同，见下文）

**例外**：
- `POST /v1/metrics` 返回 OpenTelemetry 格式 `{"partialSuccess":{}}`（无 code 信封）
- 计费类（billing）接口的 `data` 常再包一层腾讯云风格 `data.Response.{...}`
- 登录态接口（login / client-login）返回 301/302 重定向，无 JSON 信封

### 认证 Cookie（Auth cookie）
- **主会话 Cookie 名为 `session`**，形状为三段竖线分隔：
  ```
  session = <id> | <expiry_unix> | <hash>
  ```
  - 示例：`mgknGhtLbjTyOOESvDa27Q|1789403935|uLqqClzvOw2RqvLdlj4nbkhj-byczMZaoFmzd0C...`
  - **中间段 `1789403935` 为过期 Unix 时间戳**（≈ 2026-09-08 16:38，约 24h 有效；另一抓包中见到 `1789104944`）
  - Cookie 属性：`HttpOnly`、`Secure`、`Path=/`（按接口前缀变化：`/activity`、`/v2`、`/billing`、`/console`）
- 注意：几乎所有 growth/billing 响应都会回 `set-cookie: session=; Path=/<prefix>; Max-Age=0; Expires=Thu, 01-Jan-70 00:00:00 GMT; HttpOnly` —— 即在响应中**主动清除 session**（请求里携带的才是有效 session）。对接时请勿用响应里的 session 覆盖请求 session。
- 其它会话相关 Cookie：
  - `tgw_l7_route=<hex>`：APISIX 路由 Cookie（`Path=/`、`Secure`、`sameSite=None`、过期约 1h），由响应 `set-cookie` 下发，请求回带即可
  - `login_risk_state=<uuid>`：由 `POST /console/auth/risk-context` 设置（`HttpOnly; Path=/auth; Max-Age=1800`）
  - 分析/营销 Cookie（非必需）：`_gcl_au`、`sensorsdata2015jssdkcross`、`qcloud_from`、`trafficParams`、`i18next`

### 请求头约定（Request headers）
| Header | 取值 | 说明 |
|---|---|---|
| `x-client-platform` | `web`（growth/billing） / 空（登录页、v1/metrics） | 区分客户端；growth 与 billing 接口固定带 `web` |
| `referer` | `https://www.workbuddy.cn/profile/growth-center`（growth）/ `.../profile/plans-usage`（billing meter）/ `.../profile/billing`（order）/ `.../profile/keys`（api-keys）/ 登录页（auth） | 用于来源校验/统计 |
| `accept` | `application/json, text/plain, */*`（业务接口）/ `*/*`（v1/metrics） | |
| `content-type` | `application/json`（POST body） | |
| `origin` | `https://www.workbuddy.cn` | POST 同源接口带 |
| `x-device-token` | `v3:...` 长串 | 设备指纹（risk-context、login/enterprise 等风控接口） |
| `x-product-code` | `workbuddy` | login/enterprise 使用 |
| `x-domain` | `www.workbuddy.cn` | 部分同源接口使用 |
| `traceparent` / `traceid` | W3C trace | 链路追踪，可选 |
| `user-agent` | 标准浏览器 UA（Edge/Chromium） | |

### 响应头约定（Response headers）
- `x-request-id: <uuid>`、`traceid: <hex>`、`x-user-id: <uuid>`（已登录用户 id）
- `server: APISIX/3.9.1`、`content-type: application/json; charset=utf-8`

### 其它全局常量（来自 growth 接口）
- `timezone`: `"Asia/Shanghai"`（来自 `GET /activity/growth/streak`）
- `launch_date`: `"2026-06-17"`（成长平台上线日，来自 streak）
- buddy 稀有度枚举：`R` / `SR` / `SSR` / `UR`
- 积分单位：`credits`（能量为 `energy`，补签卡为 `cards`，抽奖机会为 `chances`）
- 常用 deeplink scheme：`workbuddy://chat`、`workbuddy://expert`、`workbuddy://templates`、`workbuddy://discover?cardId=...` 等

---

## 汇总表（SUMMARY TABLE）

| # | Method | Path | 用途 |
|---|---|---|---|
| 1 | GET | `/login` | 登录入口页（302→/login/） |
| 2 | GET | `/login/` | 登录页 HTML |
| 3 | GET | `/v2/plugin/login/gray-decision?feature=oneid_component&platform=workbuddy` | 灰度：oneid 组件开关 |
| 4 | GET | `/v2/plugin/login/gray-decision?feature=login_v2&platform=workbuddy` | 灰度：login_v2 开关 |
| 5 | POST | `/console/auth/risk-context?platform=workbuddy&version=5.5.3` | 风控上下文（下发 login_risk_state） |
| 6 | POST | `/console/login/enterprise?state=...` | 企业态登录 |
| 7 | POST | `/billing/ide/trial` | IDE 试用开通 |
| 8 | GET | `/console/auth/login?platform=workbuddy&state=...&domain=www.workbuddy.cn` | 鉴权登录（302→force_login） |
| 9 | GET | `/login?force_login_type=&platform=workbuddy&state=...` | 强制登录页（302→/login/） |
| 10 | GET | `/login/?force_login_type=&platform=workbuddy&state=...` | 强制登录页 HTML |
| 11 | GET | `/console/client-login?code=...&target=%2Fprofile%2Fplan` | **建立会话：code 换 session（302→/profile/plan 且 set-cookie session）** |
| 12 | GET | `/profile/plan` | 套餐页 HTML |
| 13 | GET | `/v2/activity/growth/subscribe-task/status` | 订阅任务状态 |
| 14 | GET | `/v2/activity/growth/profile` | 成长档案（等级/进度） |
| 15 | GET | `/v2/activity/growth/badges` | 徽章列表 |
| 16 | GET | `/activity/growth/buddy/info` | 当前 buddy 信息 + 轮询间隔 |
| 17 | GET | `/activity/growth/energy` | 能量（积分）余额 |
| 18 | GET | `/activity/growth/buddy/list` | 已拥有 buddy 列表 |
| 19 | GET | `/activity/growth/buddy/agreement` | buddy 协议同意状态 |
| 20 | GET | `/activity/growth/buddy/quota` | buddy 抽取额度 |
| 21 | GET | `/activity/growth/buddy/visible` | buddy 是否可见/是否已拥有 |
| 22 | GET | `/activity/growth/heatmap` | 连续签到热力图（365 天） |
| 23 | GET | `/activity/growth/buddy/travel/status` | buddy 出行状态 |
| 24 | GET | `/activity/growth/streak` | 连续签到 / 补签 / 兑换状态 |
| 25 | GET | `/activity/growth/lottery/summary` | 抽奖概览（剩余次数） |
| 26 | GET | `/activity/growth/redeem/summary` | 积分兑换概览 |
| 27 | GET | `/activity/growth/buddy/travel/config` | 出行地点/文案配置 |
| 28 | GET | `/v2/activity/growth/tasks` | 任务列表 |
| 29 | GET | `/activity/growth/buddy/templates` | buddy 模板库（全部可抽卡） |
| 30 | POST | `/activity/growth/buddy/travel/claim` | 领取出行奖励 |
| 31 | POST | `/activity/growth/buddy/travel/depart` | 派遣 buddy 出行 |
| 32 | POST | `/activity/growth/redeem` | 兑换连续签到奖励 |
| 33 | GET | `/activity/growth/lottery/prizes` | 奖池列表 |
| 34 | POST | `/activity/growth/lottery/draw` | 抽奖 |
| 35 | GET | `/activity/growth/lottery/chances` | 抽奖剩余次数 |
| 36 | POST | `/billing/meter/get-user-resource-summary` | 资源用量汇总 |
| 37 | POST | `/billing/meter/get-user-resource-paid-packages` | 付费资源包列表（分页） |
| 38 | POST | `/billing/meter/get-user-resource-free-packages` | 免费资源包列表（分页） |
| 39 | POST | `/billing/pay/get-price` | 价格试算 |
| 40 | POST | `/billing/meter/compensation-status` | 补偿包状态 |
| 41 | POST | `/billing/meter/check-gift-claimed` | 赠礼领取状态 |
| 42 | POST | `/billing/meter/get-user-request-usage` | 用户请求用量明细（分页） |
| 43 | POST | `/v1/metrics` | OpenTelemetry 指标上报 |
| 44 | POST | `/billing/pay/get-order-list` | 订单列表 |
| 45 | GET | `/console/api/client/v1/api-keys?page=1&page_size=10&user_enterprise_id=personal-edition-user-id` | API Key 列表 |

---

## 一、认证 / 登录流程（AUTH / LOGIN）

### GET /login
- 用途：登录入口。抓包中带 `?platform=workbuddy&state=3cf7471a-...&version=5.5.3&loginSessionId=61350475-eb56-48eb-b6dd-85fbe53db93e`。
- 响应：`301` → `Location: /login/`
- 关键请求头：`accept: text/html,...`、`cookie: session=...|1789104944|...`（此时已带旧 session）
- 无 JSON 体（HTML 页面）。

### GET /login/
- 用途：登录页 HTML（`200`，`content-length: 17878`）。同上的 `session` cookie。

### GET /v2/plugin/login/gray-decision
- 用途：登录相关功能灰度开关（feature flag）。
- 查询参数：`feature`（`oneid_component` | `login_v2`）、`platform=workbuddy`
- 请求头：`x-client-platform` 无 / `referer: /login/`、`accept: application/json`
- 响应信封：`{code,msg,requestId,data}`
- `data` 字段：
  - `enabled` : bool — 开关
  - `reason` : string — 如 `"full_rollout"` / `"disabled"`
  - `ip` : string — 客户端 IP（如 `"112.23.190.214"`）
- 实测：`feature=oneid_component` → `enabled:true, reason:"full_rollout"`；`feature=login_v2` → `enabled:false, reason:"disabled"`

### POST /console/auth/risk-context
- 用途：提交设备风控上下文，获取 `login_risk_state` cookie。
- 查询参数：`platform=workbuddy&version=5.5.3`
- 请求头：`x-device-token: v3:...`（必带）、`origin`、`referer:/login/`
- 请求体：空（`content-length: 0`）
- 响应 `set-cookie`：`login_risk_state=<uuid>; Path=/auth; Max-Age=1800; HttpOnly; Secure; SameSite=Lax`
- 响应体：`{code:0,msg:"OK",requestId,data:null}`（data 实际为 `{}`/空）

### POST /console/login/enterprise
- 用途：企业态登录提交。
- 查询参数：`state=3cf7471a-...`（与登录流程 state 一致）
- 请求头：`x-device-token`、`x-product-code: workbuddy`、`x-domain: www.workbuddy.cn`、`origin`
- 请求体：空
- 响应头：`x-user-id: bb1a0124-...`、`set-cookie: session=; Path=/console; Max-Age=0`（清 session，登录未真正完成时）
- 响应体：`{code:0,msg,requestId,data:{}}`

### POST /billing/ide/trial
- 用途：开通 IDE 试用。
- 请求体：空；请求头带 `session`（已登录）
- 响应：`set-cookie: session=; Path=/billing; Max-Age=0`、`x-user-id`
- 响应体：`{code:0,msg,requestId,data:{}}`（content-length ~91）

### GET /console/auth/login
- 用途：鉴权登录入口。带 `platform=workbuddy&state=...&domain=www.workbuddy.cn`
- 响应：`302` → `Location: /login?force_login_type=&platform=workbuddy&state=...`
- `set-cookie: session=; Path=/console; Max-Age=0`

### GET /login (force_login) & GET /login/ (force_login)
- 同 1/2，但带 `force_login_type=&platform=workbuddy&state=...`，最终 200 返回登录页 HTML。

### GET /console/client-login  ★ 建立会话的关键接口
- 用途：**用一次性 `code` 换取已登录 `session` cookie**（OAuth 风格的 code 交换）。
- 查询参数：`code=9dab46fd-33e3-402c-9e34-26a552b7ffe4`、`target=%2Fprofile%2Fplan`
- 响应：`302` → `Location: /profile/plan`
- **响应 `set-cookie: session=<id>|1789403935|<hash>; Path=/; ...`** —— 此处写入真实会话（注意三段格式，中间为过期 unix 时间戳）
- 这是看板对接中最关键的“登录态来源”：前端拿到 `code`（通常来自 oneid/SSO 回跳）后请求本接口落地 session。

### GET /profile/plan
- 用途：套餐页 HTML（`200`，`content-length: 11182`），已登录态访问。
- 请求头带有效 `session=<id>|1789403935|<hash>`。

---

## 二、成长 / 签到 业务接口（/activity/growth/* 与 /v2/activity/growth/*）

> 公共请求头（growth 接口一致）：`x-client-platform: web`、`referer: https://www.workbuddy.cn/profile/growth-center`、`accept: application/json, text/plain, */*`、带 `session=<id>|expiry|hash>` 与 `tgw_l7_route`。
> 公共响应头：均回 `set-cookie: session=; Path=/activity (或 /v2); Max-Age=0`（清 session，属正常）；返回 `{code:0,msg:"OK",requestId,data:{...}}`。

### GET /v2/activity/growth/subscribe-task/status
- 用途：订阅任务（新手引导订阅）状态。
- `data`:
  - `subscribe_task` : object
    - `task_code` : string（空串 `""` 表示无）
    - `subscribed` : bool
    - `remaining_seconds` : int
    - `task_status` : string（如 `"none"`）
    - `advanced` : bool

### GET /v2/activity/growth/profile
- 用途：用户成长档案（等级与完成进度）。
- `data`:
  - `completed` : int — 已完成任务数（13）
  - `first_visit` : bool
  - `level` : int — 当前等级（13）
  - `level_icon` : string(url) — 等级图标（`https://acc-1258344699.cos.accelerate.myqcloud.com/web/workbuddy/assets/badge-assets/badge-07.png`）
  - `level_name` : string（空）
  - `max_level` : bool
  - `total` : int — 总任务数（16）

### GET /v2/activity/growth/badges
- 用途：徽章列表 + 最高认证。
- `data`:
  - `badges` : array<object>
    - `task_id` : int
    - `code` : string（如 `first_chat`、`skill_installed`、`chat_5`、`template_5`、`automation_1`、`Expert_Philanthropy`…）
    - `title` : string（中文标题）
    - `earned` : bool
    - `url` : string(url) — 徽章图
    - `share_uuid` : string（空或 uuid）
    - `record_id` : int（0 表示未获得）
    - `claimed` : bool
    - `claimable` : bool
    - `badge_name` : string（如「话唠本唠」）
    - `task_type` : string（`beginner` | `auto` | `single`）
  - `max_cert` : object — 最高认证
    - `earned` : bool、`url` : string、`badge_id` : int、`share_uuid` : string、`earned_at` : string、`record_id` : int、`claimed` : bool

### GET /activity/growth/buddy/info
- 用途：当前展示中的 buddy 详情 + 轮询间隔。
- `data`:
  - `buddy` : object
    - `instance_id` : int（6454735）
    - `name` : string（「设计喵」）
    - `personality` : string（人设描述）
    - `rarity` : string（`R`/`SR`/`SSR`/`UR`）
    - `soul_desc` : string（「灵感设计师」）
    - `base_static_url` : string(url)
    - `base_animated_url` : string(url, .webm)
    - `full_animated_url` : string(url, .apng)
    - `thumbnail_url` : string(url)
    - `appearance` : object — `{eye, hat, body_accessory, effect}` 均为 `null`（可定制外观槽位）
  - `poll_interval_seconds` : int（60，前端轮询间隔）

### GET /activity/growth/energy
- 用途：能量（积分）余额。
- `data`:
  - `balance` : int — 当前余额（8）
  - `total_consumed` : int — 累计消耗（60）
  - `total_earned` : int — 累计获得（68）

### GET /activity/growth/buddy/list
- 用途：已拥有的全部 buddy。
- `data`:
  - `buddies` : array<object>（结构同 buddy/info 的 buddy，外加）
    - `acquired_at` : string(ISO8601 `+08:00`)
    - `current_buddy` : bool（是否当前展示）
    - `source` : string（`gacha` 抽卡 / `task:xxx` 任务 / `first_buddy` 首只）
    - `template_id` : int（对应 buddy/templates 的 template_id）
  - `count` : int（9）

### GET /activity/growth/buddy/agreement
- 用途：buddy 协议同意状态。
- `data`:
  - `agreed` : bool
  - `dismissed_scenes` : object — `{ "growth_onboarding": "v1" }`

### GET /activity/growth/buddy/quota
- 用途：buddy 抽取额度。
- `data`:
  - `affordable` : int — 当前可负担次数（0）
  - `balance` : int — 能量余额（8）
  - `cost_per_open` : int — 单次抽取消耗（10）
  - `max_open_count` : int — 最大抽取次数（5）

### GET /activity/growth/buddy/visible
- 用途：buddy 模块是否可见 / 是否已有 buddy。
- `data`:
  - `buddy_visible` : bool
  - `has_buddy` : bool

### GET /activity/growth/heatmap
- 用途：连续签到热力图（约 365 天单元格）。
- `data`:
  - `cells` : array<object>（按日期升序）
    - `date` : string(`YYYY-MM-DD`)
    - `score` : int — 当日活跃/签到得分
    - `has_new_buddy` : bool — 当日是否获得新 buddy

### GET /activity/growth/buddy/travel/status
- 用途：buddy「出行」状态机（idle / traveling / arrived）。抓包中出现 4 次（207/239/270/284），状态随动作变化。
- `data`:
  - `state` : string（`idle` | `traveling` | `arrived`）
  - `buddy_id` : int
  - `record_id` : int
  - `location` : object|null — `{ id:int, code:string("coffee"), name:string("咖啡馆"), duration_hours:int, cover_url:string }`
  - `depart_at` : int(unix) | null
  - `arrive_at` : int(unix) | null
  - `server_now` : int(unix) — 服务端当前时间（1788799152）
  - `letter` : object|null — `{ id:int, text:string(多行信), guide_text:string }`
  - `use_deeplink` : string（如 `workbuddy://discover?cardId=interactive-annual-report`）
  - `daily_limit_reached` : bool
  - `duration_hours` : int
  - `reward_credit` : int — 本次奖励积分（8）

### GET /activity/growth/streak  ★ 连续签到核心
- 用途：连续签到天数、补签卡、各档兑换状态 + 全局常量。
- `data`:
  - `streak` : object
    - `days` : int — 当前连续天数（8）
    - `month_total_days` : int（8）
    - `month_consumed_days` : int（0）
    - `next_tier` : string（"14d"）
    - `next_tier_remaining` : int（6）
    - `makeup_dates` : array<string>（空）
  - `makeup_cards` : object — `{ balance:int(0), max:int(4) }`
  - `redemption_status` : object — 连续签到兑换状态
    - `tier_7d_count`/`tier_14d_count`/`tier_28d_count` : int
    - `tier_7d_status`/`tier_14d_status`/`tier_28d_status` : string（`available`/`locked`）
    - `remaining_days` : int（8）
    - `tiers` : array<object> — 各档奖励配置
      - `tier` : string（`7d`/`14d`/`28d`）
      - `days` : int、`credit` : int、`energy` : int、`cards` : int、`chances` : int
      - 示例 7d→{credit:0,energy:2,cards:1,chances:1}；14d→{credit:50,energy:3,cards:1,chances:1}；28d→{credit:150,energy:5,cards:1,chances:1}
  - `timezone` : string（"Asia/Shanghai"）★全局常量
  - `launch_date` : string（"2026-06-17"）★全局常量

### GET /activity/growth/lottery/summary
- 用途：抽奖概览。
- `data`:
  - `chances` : int — 剩余抽奖次数（0）
  - `module` : object — `{ enabled: bool(true) }`

### GET /activity/growth/redeem/summary
- 用途：积分兑换概览。
- `data`:
  - `starter_count` : int、`advanced_count` : int、`legendary_count` : int（0/0/0）
  - `starter_status` : string（`available`）、`advanced_status`/`legendary_status` : string（`locked`）
  - `total_consumed` : int（0）
  - `remaining_days` : int（8）、`month_total_days` : int（8）

### GET /activity/growth/buddy/travel/config
- 用途：出行地点与引导文案配置。
- `data`:
  - `locations` : array<object> — 可去地点
    - `id` : int、`code` : string（`coffee`/`mall`/`gym`/`ancient_town`）、`name` : string、`description` : string
    - `cover_url` : string
    - `duration_hours_min`/`duration_hours_max` : int（1~4）
    - `reward_credit_min`/`reward_credit_max` : int（5~10）
    - `sort` : int
    - `preview_photos` : array<object> — `{ url:string, title:string }`
    - `traveling_photos` : array<object> — `{ url:string, title:string }`
  - `intro_slogans` : array<string>（10 条运营文案）
  - `intro_slogan_items` : array<object> — `{ text:string, prompt:string, expert_id:string("ex_xxx") }`
  - `server_now` : int(unix)（1788799152）

### GET /v2/activity/growth/tasks
- 用途：任务列表（新手/日常任务，含奖励与进度）。
- `data`:
  - `tasks` : array<object>
    - `task_code` : string（`create_canvas`、`playbook_prompt`、`RichMeow_Chat`、`Library_read`、`Expert_lighthouse`、`Expert_Philanthropy`、`Hp_Appearance`、`Model_chat_GLM5.2`、`black_cat`、`Expert_team_use_3`、`first_buddy`、`chat_5`、`skill_1`、`expert_5`、`template_5`、`automation_1`）
    - `title` : string、`description` : string、`task_desc` : string
    - `task_type` : string（`single` | `auto`）
    - `jump_url` : string（deeplink，如 `workbuddy://chat`）
    - `valid_start`/`valid_end` : string|null（ISO8601 `+08:00`）
    - `reward_credit` : int、`reward_energy` : int、`reward_buddy` : bool
    - `template_id_fixed` : int（奖励 buddy 的 template_id，0 表示无）
    - `badge_name` : string（关联徽章名，空串表示无）
    - `accept_status` : string（`not_accepted`/`accepted`/`claimed`）
    - `progress` : object|null — `{ current:int, target:int }`
    - `is_pinned` : bool、`is_new` : bool
    - `icon_url` : string(url)
    - `tag` : string（如 `"PC"`/`"限定"`/`"限量"`，部分无）
    - `locked` : bool
    - `has_reward` : bool
    - `claimed_button_text` : string、`claimed_button_style` : string（`gray`/`green`）
    - `claimed_button_url` : string（可选，跳转链接）
    - `reward_popup_button_text` : string、`reward_popup_redirect_url` : string（可选）

### GET /activity/growth/buddy/templates
- 用途：buddy 模板库（全部可抽/可展示的 buddy 定义，共 23 个）。
- `data`:
  - `count` : int（23）
  - `templates` : array<object>
    - `template_id` : int（1~23）
    - `name` : string、`description` : string、`personality` : string、`catchphrase` : string
    - `species` : string（"cat"）
    - `rarity` : string（`R`/`SR`/`SSR`/`UR`）
    - `base_static_url`/`base_animated_url`/`full_animated_url`/`thumbnail_url` : string(url)
    - `can_be_shiny` : bool
    - `is_monthly_new` : bool
    - `is_hidden` : bool
    - `is_activity_limited` : int（0 普通 / 1 活动限定）

### POST /activity/growth/buddy/travel/claim
- 用途：领取出行（到达后）奖励。
- 请求体：`{}`（空）
- 响应 `data`:
  - `state` : string（`idle`，领取后回到空闲）
  - `record_id` : int
  - `letter` : object — `{ id:int, text:string, guide_text:string }`
  - `reward_credit` : int（8）
  - `use_deeplink` : string（`workbuddy://discover?cardId=interactive-annual-report`）

### POST /activity/growth/buddy/travel/depart
- 用途：派遣 buddy 去某个地点出行。
- 请求体：`{ "location_id": int(1) }`
- 响应 `data`:
  - `state` : string（`traveling`）
  - `buddy_id` : int、`record_id` : int
  - `location` : object — `{ id, code, name, duration_hours:int, cover_url }`
  - `depart_at` : int(unix)、`arrive_at` : int(unix)、`server_now` : int(unix)
  - `letter` : null、`use_deeplink` : string(空)
  - `daily_limit_reached` : bool、`duration_hours` : int(0)、`reward_credit` : int(0)

### POST /activity/growth/redeem
- 用途：兑换连续签到档位奖励。
- 请求体：`{ "tier": string("7d"), "client_token": string("redeem-7d-<uuid>") }`（client_token 用于幂等）
- 响应 `data`:
  - `redemption_id` : int
  - `tier` : string（"7d"）
  - `credit_granted` : int、`energy_granted` : int、`cards_granted` : int、`chances_granted` : int
  - `cards_overflow` : int、`remaining_days` : int

### GET /activity/growth/lottery/prizes
- 用途：奖池列表。
- `data`:
  - `prizes` : array<object>
    - `prize_code` : string（`积分_1`/`实物奖励`/`积分_2`/`实物奖励_2`…）
    - `prize_name` : string（"10 积分"/"杯子"/"100 积分"/"胸针"/"冰箱贴"）
    - `prize_type` : string（`credit` 积分 / `physical` 实物）
    - `credit_amount` : int（积分奖励数量；实物为 0）
    - `probability_pct` : number（45 / 9.997 / 0.0003 / 0.0018 等）
    - `icon_url` : string（空）

### POST /activity/growth/lottery/draw
- 用途：执行一次抽奖。
- 请求体：`{ "client_token": string("draw-<uuid>") }`（幂等 token）
- 响应 `data`:
  - `draw_uuid` : string(uuid)
  - `prize_code` : string、`prize_name` : string、`prize_type` : string、`credit_amount` : int
  - `idempotent_hit` : bool（是否命中幂等，重复 token 返回原结果）

### GET /activity/growth/lottery/chances
- 用途：查询剩余抽奖次数。
- `data`: `{ "balance": int(0) }`

---

## 三、支撑接口（SUPPORTING）

### POST /billing/meter/get-user-resource-summary
- 用途：资源用量汇总。referer: `/profile/plans-usage`。请求体 `{}`。
- `data`:
  - `Packages` : array<object>
    - `PackageCode` : string（`TCACA_code_007_...`）
    - `CycleTotalCapacity` : string、`CycleRemainCapacity` : string、`CycleUsedCapacity` : string、`CycleFrozenCapacity` : string（均为字符串数字，含小数）
    - `CapacityUnit` : string（"credits"）
  - `SubscriptionPackageCode` : string（空）
  - `IsPaidUser` : bool、`IsProtectedPriceUser` : bool

### POST /billing/meter/get-user-resource-paid-packages
- 用途：付费资源包（分页）。referer: `/profile/plans-usage`。
- 请求体：`{ "PageNumber":int(1), "PageSize":int(20), "Status":[int(0),int(3)], "PackageCodes":[string,...], "NeedRenewInfo":bool(true) }`
- `data`: `{ "Accounts": array(空), "TotalCount": int(0) }`

### POST /billing/meter/get-user-resource-free-packages
- 用途：免费资源包（分页，字段极多）。referer: `/profile/plans-usage`。
- 请求体：`{ "PageNumber":int(1), "PageSize":int(200), "Status":[int(0)], "SlicePeriodStartTime":"2026-09-08 00:00:00", "SlicePeriodEndTime":"2026-09-08 23:59:59", "PackageCodes":[string,...] }`
- `data.Accounts[]` 单条字段（均为腾讯云资源账户对象）：
  - `AccountId`:int、`Uin`:string、`AppId`:int、`DealName`:string、`CapacityType`:int、`CapacityUnit`:string
  - `CreateTime`:int(毫秒 unix)、`CycleStartTime`/`CycleEndTime`:string、`DeductionStartTime`:int、`DeductionEndTime`:int
  - `FeeType`:int、`Region`:string("ap-others")、`Zone`:string("ap-others-4")
  - `PackageCode`:string、`PackageName`:string（如「CodeBuddy个人版国内运营裂变包」）
  - `ProductCode`:string("p_tcaca")、`ProductName`:string("腾讯云代码助手")、`SubProductCode`:string、`SubProductName`:string
  - `CapacityRemain`/`CapacityUsed`/`CapacitySize`:int(多为 0)
  - `CycleCapacityRemain`/`CycleCapacitySize`/`CycleCapacityUsed`:int
  - `RemainCycles`/`TotalCycles`/`ResourceCycleId`:int、`ResourceId`:string(`codebuddy-xxxx`)、`ResourceType`:string
  - `Status`:int、`Threshold`:int、`SupportAutoRenew`/`SupportManualRenew`/`AutoRenewFlag`:int
  - `ExpiredTime`:string、`RegionId`:int、`ZoneId`:int
  - `*Precise`:string（高精度字符串数值，如 `CycleCapacityRemainPrecise:"5.30000239"`）
  - `AccountAttributes`:array<object> — `{ Key:string, Value:string, Type:int }`（如 payerType/payerUin）
- `data.TotalCount` : int

### POST /billing/pay/get-price
- 用途：价格试算（下单前询价）。referer: `/profile/plans-usage`。
- 请求体：`{ "PriceType":"getPrice", "ResInfo":[ { "GoodsCategoryId":int(2023396), "Region":"ap-others", "Zone":"ap-others-4", "GoodsNum":int(1), "Currency":"CNY", "PayMode":"prePay", "Purpose":"purchase", "GoodsDetail": string(JSON) } ] }`
  - `GoodsDetail` 内含：`pid`、`productCode`(`p_tcaca`)、`subProductCode`(`sp_tcaca_codebuddyide_creditplan`)、`timeUnit`(`m`)、`timeSpan`(1)、`commodityCode`(`TCACA_code_009_...`)、`BusinessInfo:[{name:"payment_platform",value:"wb_web"}]`
- 响应 `data.Response.PriceInfos[0]`：
  - `Price`:int(5000 分)、`TotalCost`:int、`TimeUnit`("m")、`TimeSpan`:int(1)、`GoodsNum`:int、`ProductCode`、`SubProductCode`
  - `RealTotalCost`:int(5000)、`Policy`:int(100)、`Currency`:"CNY"
  - `HighPrecisionPrice`:object — `{ PriceHigh, TotalCostHigh, RealTotalCostHigh }`（字符串）
  - `AmountUnit`:string("pent" 即分)、`PayerMode`:string("self")、`Action`:string("prePurchase")
  - `PartDetail`:string(JSON，含各计费项明细)

### POST /billing/meter/compensation-status
- 用途：补偿包状态。请求体空。
- `data`: `{ "claimed":bool(true), "active":bool(false), "credit_num":int(1000), "validity_period":int(12), "end_time":string("2026-04-30 23:59:59") }`

### POST /billing/meter/check-gift-claimed
- 用途：赠礼领取状态查询。请求体空。
- `data`: `{ "claimed":bool(true), "claimed_at":string("2026-04-19 14:57:00"), "active":bool(true), "credit_num":int(1500), "validity_period":int(1), "start_time":string, "end_time":string("2026-09-30 23:59:59") }`

### POST /billing/meter/get-user-request-usage
- 用途：用户请求用量明细（分页）。referer: `/profile/plans-usage`。
- 请求体：`{ "startTime":"2026-08-31 00:00:00", "endTime":"2026-09-07 23:59:59", "pageNum":int(1), "pageSize":int(10) }`
- `data`:
  - `total` : int（363）
  - `data` : array<object>
    - `requestId` : string、`credit` : number（如 10.5）、`model` : string（`hy3`/`glm-5.3-flash`）、`client` : string（"WorkBuddy"）
    - `requestTime` : string("2026-09-07 23:42:00")
    - `inputTrunc` : string（截断输入）、`input` : string（完整输入）
    - `agentPurpose` : string（`conversation` / `context_summary_max_token` 等）

### POST /v1/metrics
- 用途：OpenTelemetry 指标上报（前端埋点）。referer 为登录页，`x-client-platform` 无，`accept:*/*`。
- 请求体：OTLP JSON —— `{ "resourceMetrics":[ { "resource":{ "attributes":[ {key,value:{stringValue}} ... ] }, "scopeMetrics":[] } ] }`
  - 资源属性示例：`service.name="login-frontend"`、`telemetry.sdk.language="webjs"`、`telemetry.sdk.name="opentelemetry"`、`telemetry.sdk.version="1.29.0"`、`service.version="1.0.0"`、`detectors=["all"]`
- 响应（**非标准信封**）：`{ "partialSuccess": {} }`，`content-type: application/json`（无 code 字段）

### POST /billing/pay/get-order-list
- 用途：订单列表。referer: `/profile/billing`。
- 请求体：`{ "Limit":int(10), "Offset":int(0), "PayMode":"prePay", "Status":[string("processing"/"delivered"/"finished"/"delete")], "OrderType":"desc", "CreateStartTime":"2024-09-08T00:00:00+08:00", "CreateEndTime":"2026-09-08T23:59:59+08:00" }`
- 响应 `data.Response`：
  - `Data` : array<object> — 每个为 `{ BigOrderId:string, OrderInfos:array<object> }`
    - `OrderInfos[].OrderId`:string、`Status`:string(`finished`)、`Payer`:string、`CreateTime`:string、`Creator`:string
    - `RealTotalCost`:string、`VoucherDecline`:string、`GoodsCategoryId`:int
    - `TimeSpan`:string、`TimeUnit`:string(`p` 包/`m` 月)、`Currency`:string("CNY")、`Policy`:string
    - `Price`:string、`TotalCost`:string、`DiscountPrice`:string
    - `ProductCode`:string(`p_tcaca`)、`SubProductCode`:string(`sp_tcaca_codebuddyide_bonus_pack`)
    - `PriceDetail`:string(JSON)、`PayDetail`:string(JSON)、`PayMode`:string(`prePay`)、`OrderAction`:string(`prePurchase`)
    - `OverdueTime`:string、`Zone`/`Region`:string、`GoodsNum`:string、`DeliverNum`:int、`FailResourceNum`:int
    - `ActivityId`:string、`DeliverFlag`:string(`success`)、`PayerMode`:string(`self`)、`OwnerUin`:string
  - `TotalCount` : string（"32"）

### GET /console/api/client/v1/api-keys
- 用途：API Key 列表。referer: `/profile/keys`。
- 查询参数：`page=1&page_size=10&user_enterprise_id=personal-edition-user-id`
- `data`: `{ "items": array(空[]), "total": int(1), "page": int(1), "page_size": int(10) }`
  - （items 为 APIKey 对象数组，本账号为空；单条预期含 key 名/前缀/创建时间/状态等，待非空样本补全）

---

## 对接看板（签到 Provider）的要点提示
1. **会话建立**：先经 oneid/SSO 拿到 `code`，请求 `GET /console/client-login?code=...&target=...`，从响应 `set-cookie: session=<id>|<expiry_unix>|<hash>` 取出 session；过期时间为中间段 unix 时间戳，约 24h。
2. **调用所有 growth 接口**都需带 `x-client-platform: web`、`referer: /profile/growth-center`、有效 `session` cookie。
3. **连续签到核心数据**在 `GET /activity/growth/streak`（days / 各档 redemption_status / tiers 奖励 / timezone / launch_date）。
4. **能量/积分**在 `GET /activity/growth/energy`；**打卡日历**在 `GET /activity/growth/heatmap`；**补签卡**数量在 `streak.makeup_cards.balance`。
5. **buddy 出行（打卡变体）**：`travel/status` → `travel/depart{location_id}` → 轮询 status 到 `arrived` → `travel/claim{}` 领取 `reward_credit`。
6. **抽奖**：`lottery/summary`+`lottery/chances` 查余量 → `lottery/prizes` 看奖池 → `lottery/draw{client_token}`（client_token 用于幂等防重）。
7. 注意响应普遍会 `set-cookie: session=; Max-Age=0` 清 session，**不要**用它覆盖本地有效 session。
