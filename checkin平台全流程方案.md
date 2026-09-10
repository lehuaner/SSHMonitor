# 新增 checkin（签到）平台 · 全流程方案

> 产出：接口清单与字段定义 / 展示面板 Provider 数据结构 / 1:1 参考 Trae 的交互流程 / 改造清单 / 关键接口可用性实测
> 输入源：`examples/workbuddy_解析结果`（web 抓包）、`examples/workbuddy3_解析结果`（桌面端抓包，2026-09-10）
> 参考流：`examples/2026-08-15-152602_解析结果`（Trae 原生「每日签到 + 积分」API + OAuth/Passport 认证链路）
> 实测日期：2026-09-08（首轮）／2026-09-10（★遗留项收尾）
> 文档版本：**v1.2** — ①**结清遗留项**：每日签到打卡的真实端点已确认（`POST /v2/billing/meter/daily-checkin`，位于 `copilot.tencent.com`，非 `www` 域）；②修正 web 侧凭证形态（需 `session`+`session_2` 成对）；③补 `checkin-activity-status` 全量状态接口；④新增 §7「遗留项收尾实测」

---

## 0. 背景与目标

需要在「展示面板」中**新增一个 checkin（签到）Provider**，数据来自 WorkBuddy 的成长/签到体系。工作要求：

1. 梳理新增 checkin 平台所需的**全部接口清单及字段定义**（来源 = WorkBuddy 抓包）；
2. 定义展示面板**新增 Provider 所需的数据结构与字段**；
3. **严格 1:1 参考 Trae 的交互流程**并复用其现有实现骨架；
4. 利用抓包中的**有效凭证**对关键接口做可用性初步实测，并把过程与结果写入本文档。

结论先行：**WorkBuddy 的成长体系与 Trae 的原生签到体系高度同构**——两者都有「连续签到天数 / 热力图 / 积分(energy/credit) / 补签卡 / 抽奖 / 兑换档位」五件套，且都依赖登录态。差异仅在鉴权形态（WorkBuddy 用 `session` Cookie；Trae 用 `Cloud-IDE-JWT`）。因此可直接把 Trae 的 8 步 client lifecycle 平移为 WorkBuddy Provider 骨架，仅替换域名/路径/凭据字段。

---

## 1. 全局约定（两平台一致部分）

### 1.1 通用响应信封
WorkBuddy 业务接口统一返回：
```json
{ "code": 0, "msg": "OK", "requestId": "<uuid>", "data": { ... } }
```
Trae 的签到类接口（`trae/api/v2/*`）返回简化信封：
```json
{ "code": 0, "message": "success", ...业务字段 }
```
**复用建议**：在 Provider 层实现一个 `normalizeEnvelope()`，把两套装包统一成 `{ ok, code, message, requestId, data }`，下游逻辑无感知。

### 1.2 域名
| 平台 | 主域 |
|---|---|
| WorkBuddy（新增 Provider） | `www.workbuddy.cn` |
| Trae（参考实现） | `api.trae.cn` / `www.trae.cn` |

### 1.3 鉴权形态（★v1.2 更正）
| 平台 | 路径 | 凭据 | 形态 | 有效期 |
|---|---|---|---|---|
| WorkBuddy | web | **`session` + `session_2` 双 Cookie** | `session` = `<id>\|<expiry_unix>\|<hash>` | 名义 7d，**但可被 logout / 新登录即时吊销**；两 cookie 缺一即 401 |
| WorkBuddy | 桌面/OpenAPI | `Authorization: Bearer` | Keycloak JWT（`iss=…/auth/realms/copilot`, `app_type=codebuddy`） | 实测 ≈60d（2026-09-10 → 2026-11-09） |
| Trae | — | `Cloud-IDE-JWT` | `RefreshToken` 派生的 JWT | access≈14 天，refresh 更长 |

### 1.4 全局常量（来自 WorkBuddy streak 接口）
- `timezone = "Asia/Shanghai"`
- `launch_date = "2026-06-17"`（成长平台上线日）
- 稀有度枚举：`R / SR / SSR / UR`
- 积分单位：`energy`（能量）、`credit`（积分/抽奖）、`cards`（补签卡）、`chances`（抽奖机会）

### 1.5 关键坑（实测确认）
- WorkBuddy 几乎所有 growth/billing 响应都会 `set-cookie: session=; Max-Age=0` **主动清 session**；请求里携带的才是有效 session，**切勿用响应 cookie 覆盖本地 session**。
- ★**双 cookie**：web 侧必须同时携带 `session` + `session_2`，缺一即 401（v1.2 实测，见 §7.2）。
- ★**时间戳不可信**：`session` 的 expiry 段只是上限；logout / 任何一次新登录都会即时吊销而不改时间戳。有效性必须**实探**。
- ★**两个 streak 语义不同**：严格连续 vs 活动累计，勿混用（见 §7.2 坑 3）。
- ★**域选型**：每日签到端点在 `copilot.tencent.com`；`www.workbuddy.cn` 同名路径亦可达但需 cookie。两域鉴权**不互通**。
- 风控参数（Trae 的 `msToken/a_bogus/ttwid`）属可选层，等价实现可裁剪或自签；WorkBuddy 侧 `X-User-Id`/`X-Device-Token`/`X-Domain` **实测非必需**。

---

## 2. 新增 checkin 平台 · 接口清单及字段定义

> 下列即「WorkBuddy checkin 平台」对外的完整 API 面（共 45 个端点，认证 12 + 业务 23 + 支撑 10）。与「签到 Provider」直接相关的核心集见 §2.2，全量汇总见 §2.5。

### 2.1 认证 / 会话建立接口

| # | Method | Path | 关键字段 | 说明 |
|---|---|---|---|---|
| A1 | GET | `/login` | `?platform=workbuddy&state=&version=&loginSessionId=` | 登录入口（301→`/login/`） |
| A2 | GET | `/v2/plugin/login/gray-decision` | `?feature=oneid_component\|login_v2&platform=workbuddy` | 灰度开关；返回 `data.enabled/reason/ip` |
| A3 | POST | `/console/auth/risk-context` | `?platform=workbuddy&version=5.5.3`；头 `x-device-token` | 下发 `login_risk_state` Cookie，返回 `{code:0,data:{}}` |
| A4 | GET | `/console/client-login` | `?code=<一次性code>&target=<回跳>` | **建立会话核心**：用 code 换 `session` Cookie（302，`set-cookie: session=<id>\|<expiry>\|<hash>`） |
| A5 | POST | `/console/login/enterprise` | `?state=`；头 `x-product-code:workbuddy` | 企业态登录提交 |

**A2 实测**：`feature=oneid_component` → `enabled:true, reason:"full_rollout"`（已全量）；`login_v2` → `enabled:false`。

### 2.2 签到核心接口（Provider 必接）

#### GET `/activity/growth/streak` —— 连续签到核心
请求头：`x-client-platform: web`、`referer: /profile/growth-center`、有效 `session`。
响应 `data` 字段：
| 字段 | 类型 | 含义 | 实测值 |
|---|---|---|---|
| `streak.days` | int | 当前连续天数 | 8 |
| `streak.month_total_days` | int | 本月应签到天数 | 8 |
| `streak.month_consumed_days` | int | 本月已消耗(补签)天数 | 0 |
| `streak.next_tier` | string | 下一档位（`14d`/`28d`） | 14d |
| `streak.next_tier_remaining` | int | 距下一档剩余天 | 6 |
| `streak.makeup_dates` | string[] | 可补签日期 | [] |
| `makeup_cards.balance/max` | int/int | 补签卡余量/上限 | 1 / 4 |
| `redemption_status.tier_*_count` | int | 各档已领次数 | 7d=1 |
| `redemption_status.tier_*_status` | string | `available`/`claimed`/`locked` | 7d=claimed |
| `redemption_status.tiers[]` | obj[] | 档位奖励配置：{tier,days,credit,energy,cards,chances} | 见下 |
| `timezone` / `launch_date` | string | 全局常量 | Asia/Shanghai / 2026-06-17 |

`tiers` 配置：
| tier | days | credit | energy | cards | chances |
|---|---|---|---|---|---|
| 7d | 7 | 0 | 2 | 1 | 1 |
| 14d | 14 | 50 | 3 | 1 | 1 |
| 28d | 28 | 150 | 5 | 1 | 1 |

#### ★ 领取 / 签到 功能（本 checkin 平台首要能力）

> **重要更正（用户反馈 + 抓包证据，2026-09-08）**：本抓包**确实记录到了「立即领取」点击动作**——即 `296_POST /activity/growth/redeem`（capture 296，响应 `code:0`）。此前「实测 404 即判定无端点」的推理错误：`POST /activity/growth/checkin`、`/sign`、`/daily/checkin` 返回 404 仅说明**这三个猜测路径不对**，不代表「领取/签到」不存在。WorkBuddy 成长体系与 Trae 同构，**手动领取/签到确实存在**。

**1) ★ 立即领取（领取连续签到档位奖励）—— 路径已确认（capture 296）**
`POST /activity/growth/redeem`：点击「立即领取」领取某档连续签到里程碑奖励（与 Trae `checkin_credits/claim` 1:1）。

| 项 | 内容 |
|---|---|
| 请求体 | `{ "tier":"7d", "client_token":"redeem-7d-<uuid>" }`（`client_token` 幂等防重，前缀 `redeem-<tier>-`） |
| 响应 `data` | `redemption_id:int, tier:"7d", credit_granted:int, energy_granted:int, cards_granted:int, cards_overflow:int, chances_granted:int, remaining_days:int` |
| 实测（capture 296，code:0） | `redemption_id:543960, tier:"7d", credit_granted:0, energy_granted:2, cards_granted:1, cards_overflow:0, chances_granted:1, remaining_days:0` |
| 领后状态（capture 299 `GET /redeem/summary`） | `starter_status:"claimed"`, `remaining_days:8`, `month_total_days:8` |
| 领后状态（capture 297 `GET /streak`） | `days:8`, `redemption_status.tier_7d_status:"claimed"` |

> 点击它之后成长中心弹出的提示「**每日100分，已领8天，累计800分**」即来自此处（字面值映射见 §2.2-5）。

**2) ★ 每日签到打卡（手动点击）—— 端点已确认（v1.2 结清）**

> **结论（2026-09-10 实测确认）**：每日签到的真实端点是
> **`POST https://copilot.tencent.com/v2/billing/meter/daily-checkin`**，
> 而**不是** `www.workbuddy.cn/activity/growth/*` 下的任何路径。
> 旧文档此前只在 `www` 域内枚举写请求，故始终找不到；这是**域选错**，不是端点不存在。

- 抓包实证：`examples/workbuddy3_解析结果/182_POST ..._v2_billing_meter_daily-checkin`（2026-09-10 桌面端 WorkBuddy 5.5.3）。
  请求体为 `{}`（无 `client_token`，与 `redeem` 不同）；响应 `code:0` → `{credit:100, streak_days:9, is_streak_day:false}`。
- 实测（2026-09-10，`examples/checkin_test3.py`）：当日重复调用返回
  `HTTP 400 / code:10001 / "今天已签到，请明天再来"`，且 `total_credits`、`streak_days` 均未变化 → **天然幂等，无需 `client_token` 防重**。
- 同域的读接口 `POST /v2/billing/meter/checkin-activity-status` 提供签到活动全量状态（见下 §2.2-4）。
- 旧猜测路径的**真实返回**（带有效凭证实测）：`POST /activity/growth/checkin` → **HTTP 404 `404 page not found`**，`/activity/growth/sign` → 同为 404。即这两个路径确实不存在。

**3) 每日签到写接口（已确认，取代旧「工作规格」）**

| Method | Path | 请求头 | 请求体 | 响应 `data` |
|---|---|---|---|---|
| POST | `https://copilot.tencent.com/v2/billing/meter/daily-checkin` | `Authorization: Bearer <JWT>`（★仅此一项必需） | `{}` | 首次签到：`{ "credit":100, "streak_days":9, "is_streak_day":false }` |
| POST | `https://www.workbuddy.cn/v2/billing/meter/daily-checkin` | `Cookie: session=…; session_2=…` | `{}` | 同上（★同一后端，web 侧亦可调用，见 §7.4） |

> 失败语义（实测）：当日已签 → `HTTP 400`，`{ "code":10001, "msg":"今天已签到，请明天再来" }`。
> 未鉴权 → `HTTP 401`（APISIX 网关层，HTML 体）。
> Provider 侧应把 `code:10001` 识别为 `alreadyCheckedIn`（非错误），据 `msg` 判定。

**4) 签到状态读取（展示用，已可用）**

★ **首选（v1.2 新增）：`POST /v2/billing/meter/checkin-activity-status`** —— 一个接口给全「签到活动」所需状态，实测 `code:0`。
| 字段 | 类型 | 含义 | 实测值（2026-09-10） |
|---|---|---|---|
| `active` | bool | 活动是否进行中 | true |
| `today_checked_in` | bool | **今日是否已签到（直接判定，无需推导）** | 签到前 false → 签到后 true |
| `streak_days` | int | 活动期内**累计**签到天数 | 8 → 9 |
| `daily_credit` / `today_credit` | int | 每日积分 / 今日所得 | 100 / 100 |
| `is_streak_day` | bool | 今日是否为连续打卡日（额外奖励） | false |
| `next_streak_day` / `streak_bonus_days` / `streak_bonus_credit` | int | 下一连续奖励里程碑及奖励 | 0 / 0 / 0 |
| `checkin_dates[]` | string[] | 签到日期列表（倒序） | 9 项，含 2026-09-10 |
| `week_checkin_days` / `week_progress[]` | int / bool[7] | 本周签到天数 / 逐日进度 | 3 / `[T,T,F,T,F,F,F]` |
| `total_credits` | int | **活动累计积分**（★替代旧文档「已领8天×100分」的前端推算） | 800 → 900 |
| `start_time` / `end_time` | string | 活动起止 | 2026-09-01 ~ 2026-09-15 |
| `theme_name` / `season` / `activity_name` | string/int | 活动主题 | Buddy加油站 / 8 / 开学季 |
| `claim_button_text` | string | 按钮文案 | "立即领取" |
| `action_button` | obj | 活动位按钮 `{show,text,action}` | 认证领积分 → events/campus-freshman |

> 该接口把「今日已签 / 累计天数 / 累计积分 / 本周进度 / 活动期」一次给全，**应作为 Provider 状态读取的主接口**，取代原先「靠 heatmap 今日格 score>0 推导」的做法。

**备选（旧有，仍可用）：**
- `GET /activity/growth/streak` → `streak.days`（★严格连续，断一天归零）、`makeup_cards`、`redemption_status`
- `GET /activity/growth/heatmap` → `cells[]`，今日格 `score>0` 视为已签到
- ⚠️ **语义坑（v1.2 实测暴露）**：`growth/streak.streak.days` 是**严格连续**天数，`meter/checkin-activity-status.streak_days` 是**活动期累计**天数，两者不等价。2026-09-10 实测前者 `0`（09-09 漏签断签），后者 `9`。面板展示要区分「连续签到」与「累计签到」两个指标，勿混用。

**5) 用户可见文案 ↔ 结构化字段映射（关键，★v1.2 已全部落到接口）**
用户点击后看到的 UI 提示「**每日100分，已领8天，累计800分**」——v1.1 时判断「字面值不在任何响应体」，**v1.2 已推翻**：三个数值现均可在 `POST /v2/billing/meter/checkin-activity-status` 中直接取到。
| UI 文案 | 结构化来源 | 说明 |
|---|---|---|
| 已领8天 | `streak_days` (=8) ／ `growth/streak.streak.days` | ★v1.2 直接给出（活动期累计） |
| 每日100分 | `daily_credit` (=100) | ★v1.2 直接给出，**不再是前端常量**；无需再等 growth-center JS 确证 |
| 累计800分 | `total_credits` (=800) | ★v1.2 直接给出，**不再是 `days×100` 的前端推算**；签到后变 900 |

> 结论：Provider 只需读取 `checkin-activity-status`，即可 1:1 复现该提示文案，无需任何前端常量或乘法推算。

**6) Provider 落地（v1.2 已全部确认，无待办）**
- `checkIn(session)`（★已确认）：`POST /v2/billing/meter/daily-checkin`，**空请求体**，无幂等 token；把 `code:10001 / "今天已签到"` 映射为 `alreadyCheckedIn=true`（非错误）。调用后回查 `checkin-activity-status` 刷新。
- `claim(session, tier)`（★已确认）：`POST /activity/growth/redeem{tier,client_token}`，领取连续签到**档位**奖励（7d/14d/28d）。
- `getStatus(session)`（★建议升级）：主接口改用 `POST /v2/billing/meter/checkin-activity-status`（一次拿全），辅以 `growth/streak` + `heatmap` + `redeem/summary`。
- **两个「领取」不要混淆**：
  | 按钮 | 端点 | 语义 |
  |---|---|---|
  | 成长中心「立即领取」（活动面板） | `POST /v2/billing/meter/daily-checkin` | **每日签到打卡**（点击即得当日 100 分） |
  | 档位奖励「领取」 | `POST /activity/growth/redeem{tier}` | 领取 7d/14d/28d 里程碑奖励 |

> 旧 §2.2-3 与 §6.6 的「端点路径待确认 / 疑似不存在」结论**已在 v1.2 全部结清**，详见 §7。

#### GET `/activity/growth/heatmap` —— 打卡日历（365 格）
`data.cells[]`：`{ date:"YYYY-MM-DD", score:int, has_new_buddy:bool }`。实测 365 格，跨 `2025-09-09`~`2026-09-08`，`score>0` 共 **19** 天；`today={date:"2026-09-08", score:2, is_active:true}`，今日已活跃。

#### GET `/activity/growth/energy` —— 能量/积分余额
`data`：`{ balance:int, total_consumed:int, total_earned:int }`（实测 `10 / 60 / 70`）。

#### POST `/activity/growth/redeem` —— 兑换连续签到档位奖励（写）
请求体：`{ "tier":"7d", "client_token":"redeem-7d-<uuid>" }`（client_token 幂等）。
响应 `data`：`{ redemption_id, tier, credit_granted, energy_granted, cards_granted, chances_granted, cards_overflow, remaining_days }`。
> 这是 WorkBuddy 侧与 Trae `checkin_credits/claim` 最对应的「领奖」动作（见 §4.4）。

#### GET `/activity/growth/redeem/summary`
`data`：`{ starter/advanced/legendary_count, starter/advanced/legendary_status, total_consumed, remaining_days, month_total_days }`（实测 starter 已 claimed）。

### 2.3 奖励玩法接口（Provider 可选接）

| Method | Path | 请求 | 响应 `data` 关键字段 |
|---|---|---|---|
| GET | `/activity/growth/lottery/summary` | — | `chances:int, module.enabled:bool` |
| GET | `/activity/growth/lottery/prizes` | — | `prizes[]`:{prize_code,prize_name,prize_type(`credit`/`physical`),credit_amount,probability_pct,icon_url} |
| GET | `/activity/growth/lottery/chances` | — | `balance:int` |
| POST | `/activity/growth/lottery/draw` | `{client_token}` | `draw_uuid,prize_code,prize_name,prize_type,credit_amount,idempotent_hit` |
| GET | `/activity/growth/buddy/info` | — | `buddy{instance_id,name,rarity,soul_desc,base_static_url,...}, poll_interval_seconds` |
| GET | `/activity/growth/buddy/list` | — | `buddies[]`(含 acquired_at/current_buddy/source/template_id), `count` |
| GET | `/activity/growth/buddy/quota` | — | `affordable,balance,cost_per_open,max_open_count` |
| GET | `/activity/growth/buddy/visible` | — | `buddy_visible, has_buddy` |
| GET | `/activity/growth/buddy/agreement` | — | `agreed, dismissed_scenes` |
| GET | `/activity/growth/buddy/templates` | — | `count, templates[]`(23 个，含 rarity/template_id/各 url) |
| GET | `/activity/growth/buddy/travel/status` | — | `state(idle/traveling/arrived), location, depart_at, arrive_at, server_now, reward_credit, daily_limit_reached` |
| GET | `/activity/growth/buddy/travel/config` | — | `locations[]`(code/name/duration/reward), `intro_slogans[]`, `intro_slogan_items[]` |
| POST | `/activity/growth/buddy/travel/depart` | `{location_id:int}` | `state:traveling, location, depart_at, arrive_at` |
| POST | `/activity/growth/buddy/travel/claim` | `{}` | `state:idle, letter, reward_credit, use_deeplink` |

### 2.4 档案 / 任务 / 徽章（Provider 展示用）

| Method | Path | 响应 `data` 关键字段 |
|---|---|---|
| GET | `/v2/activity/growth/profile` | `completed, first_visit, level, level_icon, level_name, max_level, total` |
| GET | `/v2/activity/growth/badges` | `badges[]{task_id,code,title,earned,url,claimable,claimed,badge_name}, max_cert{}` |
| GET | `/v2/activity/growth/tasks` | `tasks[]{task_code,title,task_type,jump_url,reward_credit,reward_energy,accept_status,progress,icon_url,tag}` |
| GET | `/v2/activity/growth/subscribe-task/status` | `subscribe_task{task_code,subscribed,remaining_seconds,task_status,advanced}` |

### 2.5 支撑接口（计费 / 指标，按需）
`POST /billing/meter/get-user-resource-summary`(+`-paid-packages`/`-free-packages`/`-get-user-request-usage`)、`POST /billing/pay/get-price`、`POST /billing/meter/compensation-status`、`POST /billing/meter/check-gift-claimed`、`POST /billing/pay/get-order-list`、`POST /v1/metrics`、`GET /console/api/client/v1/api-keys`。

---

## 3. 展示面板 · 新增 Provider 的数据结构与字段

Provider 对外只暴露**归一化**后的签到快照，屏蔽两平台差异。下方为推荐的数据结构（TypeScript 风格，可直接落地为 `provider/workbuddy/types.ts`）。

### 3.1 Provider 元信息（配置）
```ts
interface CheckinProviderMeta {
  id: "workbuddy";                 // 唯一标识
  name: "WorkBuddy 成长签到";
  kind: "checkin";
  platform: "workbuddy";
  baseUrl: "https://www.workbuddy.cn";
  authType: "cookie" | "bearer";   // web 用 cookie；桌面/OpenAPI 用 bearer
  auth: {
    cookieNames: ["session", "session_2"];  // ★v1.2：两者必须成对，缺一即 401
    sessionTtlSeconds: 604800;     // 中间段 unix 为「上限」，非有效依据（见 §7.2 坑 1）
    establishVia: "client-login";  // A4：code 换 session
    bearerSource: "keycloak";      // copilot.tencent.com/auth/realms/copilot 下发，实测 ~60d
  };
  endpoints: {                     // 路径映射（复用 trae 骨架的 endpoint 配置位）
    // ★ v1.2 新增：签到主接口（copilot.tencent.com 与 www.workbuddy.cn 同路径均可达）
    checkinStatus: "/v2/billing/meter/checkin-activity-status";  // 读：签到活动全量状态
    dailyCheckin:  "/v2/billing/meter/daily-checkin";            // 写：每日签到打卡
    // 成长体系（www.workbuddy.cn）
    streak:        "/activity/growth/streak";
    heatmap:       "/activity/growth/heatmap";
    energy:        "/activity/growth/energy";
    redeem:        "/activity/growth/redeem";
    redeemSummary: "/activity/growth/redeem/summary";
    lotterySummary: "/activity/growth/lottery/summary";
    lotteryPrizes: "/activity/growth/lottery/prizes";
    lotteryChances:"/activity/growth/lottery/chances";
    lotteryDraw:   "/activity/growth/lottery/draw";
    profile:       "/v2/activity/growth/profile";
    badges:        "/v2/activity/growth/badges";
    tasks:         "/v2/activity/growth/tasks";
  };
  refreshIntervalSeconds: 60;     // 来自 buddy/info.poll_interval_seconds
}
```

### 3.2 归一化签到快照（面板消费）
```ts
interface CheckinSnapshot {
  providerId: "workbuddy";
  userId: string;                 // 响应头 x-user-id
  fetchedAt: number;              // unix ms
  streak: {
    days: number;                 // ★严格连续天数（growth/streak.streak.days，断签归零）
    checkedInToday: boolean;      // 今日是否已签到（★v1.2 直接取 checkin-activity-status.today_checked_in）
    lastCheckinDate: string | null; // 最近签到日期 = checkin_dates[0]
    monthTotalDays: number;
    monthConsumedDays: number;
    dailyPoints: number;          // 每日签到积分（★v1.2 已由 daily_credit=100 直接提供，不再是前端常量）
    nextTier: string | null;      // "14d"
    nextTierRemaining: number;
    makeupCards: { balance: number; max: number };
    tiers: Array<{                // 档位奖励
      tier: string; days: number;
      credit: number; energy: number; cards: number; chances: number;
      status: "available" | "claimed" | "locked";
    }>;
  };
  // ★ v1.2 新增：签到活动（season）维度
  activity: {
    active: boolean;
    season: number;               // 8
    name: string;                 // "开学季"
    themeName: string;            // "Buddy加油站"
    startTime: string; endTime: string;
    totalCheckinDays: number;     // 活动期累计签到天数（checkin-activity-status.streak_days）
    totalCredits: number;         // 活动期累计积分（★取代旧文档「天数×100」的前端推算）
    todayCredit: number;
    weekCheckinDays: number;
    weekProgress: boolean[];      // 长度 7
    checkinDates: string[];       // 倒序
    isStreakDay: boolean;
    nextStreakDay: number;
    streakBonusDays: number;
    streakBonusCredit: number;
    claimButtonText: string;      // "立即领取"
    actionButton: { show: boolean; text: string; action: string };
  };
  energy: { balance: number; totalEarned: number; totalConsumed: number };
  heatmap: Array<{ date: string; score: number; hasNewBuddy: boolean }>;
  lottery?: { chances: number; moduleEnabled: boolean; prizes: LotteryPrize[] };
  buddy?: {
    current: { instanceId: number; name: string; rarity: string; staticUrl: string };
    travel: { state: "idle" | "traveling" | "arrived"; locationName: string; rewardCredit: number; dailyLimitReached: boolean };
  };
  profile?: { level: number; completed: number; total: number };
}
```

### 3.3 字段映射表（WorkBuddy → 归一化）
| 归一化字段 | WorkBuddy 来源 | 说明 |
|---|---|---|
| `streak.days` | `streak.streak.days` | 直接 |
| `streak.tiers[].status` | `redemption_status.tier_7d_status` 等 | 三档分别映射 |
| `streak.nextTierRemaining` | `streak.streak.next_tier_remaining` | 直接 |
| `energy.balance` | `energy.balance` | 直接 |
| `heatmap[]` | `heatmap.cells[]` | 重命名 `has_new_buddy`→`hasNewBuddy` |
| `streak.checkedInToday` | `checkin-activity-status.today_checked_in` | ★v1.2 直接取值；旧法（`heatmap.cells[今日].score > 0`）降为兜底 |
| `streak.lastCheckinDate` | `checkin-activity-status.checkin_dates[0]` | 倒序列表首项 |
| `streak.dailyPoints` | `checkin-activity-status.daily_credit` | ★v1.2 接口直接提供（=100），不再是前端常量 |
| `activity.totalCredits` | `checkin-activity-status.total_credits` | ★活动累计积分，取代旧「days×dailyPoints」推算 |
| `activity.totalCheckinDays` | `checkin-activity-status.streak_days` | ★活动期累计（≠ 严格连续天数） |
| `activity.season/name/themeName` | `checkin-activity-status.season/activity_name/theme_name` | 活动标识 |
| `activity.weekProgress` | `checkin-activity-status.week_progress[]` | 本周 7 天逐日进度 |
| `lottery.chances` | `lottery/chances.balance` 或 `lottery/summary.chances` | 二者一致 |
| `buddy.current` | `buddy/info.buddy` | 取 instance_id/name/rarity/base_static_url |
| `buddy.travel.state` | `buddy/travel/status.state` | 状态机 |
| `profile.level` | `v2/.../profile.level` | 直接 |

### 3.4 Provider 接口契约（复用 trae 骨架）
```ts
interface CheckinProvider {
  meta: CheckinProviderMeta;
  establishSession(code: string): Promise<Session>;   // ≈ trae ExchangeToken
  getStatus(session: Session): Promise<CheckinSnapshot>; // ≈ trae checkin_credits/status
  checkIn(session: Session): Promise<CheckinResult>;   // ★v1.2 已确认：POST /v2/billing/meter/daily-checkin（空体）；
                                                       //   code:10001「今天已签到」→ alreadyCheckedIn=true（非错误）
  claim(session: Session, tier?: string): Promise<ClaimResult>; // 领连续签到档位奖励（映射到 growth/redeem）
  poll(session: Session, intervalMs: number): void;   // 复用 trae 轮询调度
}
```

---

## 4. 交互流程设计（1:1 参考 Trae，复用现有代码）

### 4.1 Trae 参考流（8 步，已重建）
```
(0) GET  www.trae.cn/authorization                → 登录页
(*) POST www.trae.cn/ttwid/check/                 → 设备/风控校验
(1) POST api.trae.cn/.../oauth/GetPCAuthCode      → AuthCode(10min)
(2) POST api.trae.cn/trae/api/v3/oauth/ExchangeToken
                                                  → Token(UserJwt)+RefreshToken(14d)
(3) POST api.trae.cn/.../trae/CheckLogin         → IsLogin,UserID,Host
(4) POST api.trae.cn/.../trae/Login              → set-cookie X-Cloudide-Session
(5) POST api.trae.cn/.../trae/GetUserInfo        → 用户档案
(6) POST api.trae.cn/.../common/GetUserToken     → 会话 JWT(authorization 用)
(7) POST api.trae.cn/trae/api/v2/ug/checkin_credits/status → {checked_in,credits}
(8) POST api.trae.cn/trae/api/v2/ug/checkin_credits/claim  → 执行签到
    退出: ClearRefreshToken
```

### 4.2 WorkBuddy Provider 1:1 平移序列（v1.2：第 7/8 步已定稿）
```
(0) 打开 www.workbuddy.cn/login?platform=workbuddy&state=...   → 登录页(oneid/SSO)
(*) POST /console/auth/risk-context                            → login_risk_state(风控前置)
(1) 经 oneid/SSO 回跳取得一次性 code                            → AuthCode 等价物
(2) GET  /console/client-login?code=...&target=...             → set-cookie session + session_2  ★=ExchangeToken
(3) GET  /v2/plugin/login/gray-decision?feature=oneid_component → enabled(登录组件开关)    ★=CheckLogin
(4) GET  /activity/growth/buddy/info                           → poll_interval_seconds(会话保活) ★=Login/GetUserInfo 合并
(5) GET  /v2/activity/growth/profile                           → 用户档案(UserID/level)      ★=GetUserInfo
(6) [session + session_2 Cookie 即调用凭据]                     ★=GetUserToken(无需额外 JWT)
(7) POST /v2/billing/meter/checkin-activity-status             → 签到活动全量状态
                                                                 {today_checked_in, streak_days, total_credits…} ★=checkin_credits/status
(8) POST /v2/billing/meter/daily-checkin   (请求体 {})          → 执行每日签到                        ★=checkin_credits/claim
(8b)POST /activity/growth/redeem{tier,client_token}            → 领 7d/14d/28d 档位奖励(可选，与 8 不同按钮)
    轮询: POST checkin-activity-status + GET streak/heatmap/energy (每 60s, 来自 poll_interval_seconds)
```

**桌面端等价路径（OpenAPI 形态，实测可用）**：
```
POST https://copilot.tencent.com/v2/billing/meter/checkin-activity-status
POST https://copilot.tencent.com/v2/billing/meter/daily-checkin
  Headers: Authorization: Bearer <Keycloak JWT>   ← ★仅此一项必需（实测）
           (X-User-Id / X-Domain / X-Device-Token 均可省略)
JWT 来源: https://copilot.tencent.com/auth/realms/copilot  (iss=…/auth/realms/copilot, app_type=codebuddy)
有效期: 实测 iat 2026-09-10 → exp 2026-11-09（约 60 天），远长于 web session
```
> 两条路径**同一后端**：`www.workbuddy.cn/v2/billing/meter/*` 与 `copilot.tencent.com/v2/billing/meter/*` 路径完全一致，仅鉴权形态不同（cookie vs bearer）。实测二者返回体逐字段一致。无头/服务端调用**优先选桌面 Bearer 路径**（凭证寿命长、无需 cookie 配对）。

### 4.3 复用现有代码清单（把 trae 骨架实例化为 workbuddy）
| 复用模块（trae 实现中抽象出的） | 落位点（workbuddy） | 改动量 |
|---|---|---|
| `HttpClient`（带 Authorization/UA/超时/重试） | 同构，仅换 `baseUrl` 与鉴权头（`cookie` 替代 `Cloud-IDE-JWT`） | 小 |
| `normalizeEnvelope()`（两套信封归一） | 新增 WorkBuddy 分支（`code/msg/requestId/data`） | 小 |
| `TokenStore`（access/refresh 持久化） | 改为 `SessionStore`（session 字符串 + expiry 解析） | 中 |
| `pollScheduler(intervalMs)`（轮询调度） | 直接复用，`intervalMs=60000` | 无 |
| `redeemWithIdempotency(token)`（client_token 幂等） | 直接复用，映射到 `redeem{tier,client_token}` | 无 |
| `errorNormalizer`（401/20310/1001→统一错误） | 新增 WorkBuddy 401 分支（session 失效→重新 client-login） | 小 |
| `deviceRiskProbe()`（ttwid/risk-context） | 映射到 `POST /console/auth/risk-context` | 小 |

### 4.4 关键差异与对齐点（必须写进改造）
- **签到（每日打卡）为核心，且为手动**（★v1.2 定稿）：端点为 **`POST /v2/billing/meter/daily-checkin`**，空请求体，与 Trae `checkin_credits/claim` 1:1。Provider 的 `checkIn()` 直接 POST；当日重复调用返回 `code:10001` 属正常态，映射为 `alreadyCheckedIn=true`。面板「签到」按钮常态可点击。
- **档位领奖**：`claim()` 映射到 **`POST /activity/growth/redeem{tier,client_token}`**（7d/14d/28d 里程碑奖励），面板文案标注「领奖」而非「签到」。**与每日签到是两个不同动作**。
- **鉴权差异（★v1.2 更正）**：
  | 路径 | 凭据 | 必需项 | 寿命 |
  |---|---|---|---|
  | web | Cookie | **`session` + `session_2` 必须同时携带**（缺一 → 401） | 名义 7d，但会被 logout/新登录即时吊销 |
  | 桌面/OpenAPI | `Authorization: Bearer <JWT>` | 仅此一项（`X-User-Id`/`X-Device-Token` 实测可省） | 约 60d |
  `TokenStore` 需分两类实现，但 `CheckinProvider` 接口一致。
- **风控可裁剪**：Trae 的 `msToken/a_bogus/ttwid` 在 WorkBuddy 侧对应 `x-device-token` + `risk-context`，**实测非必需**（Bearer-only 即可 200），按需保留。
- **两个「streak」不要混用**：`growth/streak.days` = 严格连续；`meter/checkin-activity-status.streak_days` = 活动期累计。面板需分别呈现。

---

## 5. 改造内容清单（文件 / 模块级）

> 假设展示面板为 TS 项目，已有 `providers/trae/` 作为 1:1 模板。下列为新增 WorkBuddy Provider 的待办。

| 状态 | 路径 / 文件 | 内容 |
|---|---|---|
| ☐ 新增 | `providers/workbuddy/types.ts` | §3.1–3.2 的 `CheckinProviderMeta` / `CheckinSnapshot` / `CheckinProvider` |
| ☐ 新增 | `providers/workbuddy/endpoints.ts` | §2 全部路径常量 + 请求/响应字段类型 |
| ☐ 新增 | `providers/workbuddy/client.ts` | `HttpClient`（复用 trae 骨架，鉴权头改 `cookie`）+ `normalizeEnvelope()` 分支 |
| ☐ 新增 | `providers/workbuddy/session.ts` | `SessionStore`：★必须同时持久化 `session` 与 `session_2`（缺一 401）；解析 `session=<id>\|<expiry>\|<hash>` 仅作刷新提醒，**不可作有效性判据**；失效→触发 `client-login` 重建立 |
| ☐ 新增 | `providers/workbuddy/checkin.ts` | `getStatus()`(streak/heatmap/energy) + `checkIn()`(双模式：/checkin POST 或降级读状态) + `claim(tier)`(redeem) + `poll()` |
| ✅ 已确认 | `POST /v2/billing/meter/daily-checkin`（无需新建后端） | 每日签到打卡端点**已定稿**（见 §2.2-3 / §7）：空请求体，`code:10001` = 今日已签。与 Trae `claim` 1:1；`redeem`（档位奖励）路径亦已确认 |
| ☐ 新增 | `providers/workbuddy/mapper.ts` | §3.3 字段映射（WorkBuddy→归一化快照） |
| ☐ 修改 | `providers/index.ts` | 注册 `workbuddy` Provider（id/name/kind） |
| ☐ 修改 | `providers/registry.config.ts` | 追加 `workbuddy` 元信息（baseUrl/authType/endpoints/refreshInterval） |
| ☐ 修改 | `panel/CheckinCard.tsx` | 消费 `CheckinSnapshot`：连续天数环、热力图、能量、档位进度、抽奖入口 |
| ☐ 修改 | `i18n/zh-CN.yaml` | 新增 `workbuddy` 文案（「领奖」「补签卡」等） |
| ☐ 新增 | `providers/workbuddy/__tests__/checkin.test.ts` | 基于抓包样本(`_evidence.json`)的快照断言 |
| ☐ 新增 | `docs/workbuddy-checkin-api.md` | 本文档的接口子集引用 |

---

## 6. 可用性初步测试（过程 + 结果）

### 6.1 凭证来源与有效性
- **WorkBuddy session**：从 `209_...streak/请求.txt` 提取 `session` Cookie（长度 3909）。中间段 `1789403935` ⇒ 过期 `2026-09-14T16:38:55Z`，**实测时有效**。
- **Trae JWT**：从 `006_...GetThirdPartyToken/请求.txt` 提取 `Cloud-IDE-JWT`，解码 `exp=1787207760`（≈2026-08-20），**已过期**——故 Trae 仅做流程对齐与端点验证，不做业务实测。

### 6.2 测试方法
- 语言/库：Python `urllib`（无第三方依赖），`HTTPS` 直连（sandbox 已放行 `www.workbuddy.cn`，无代理即可）。
- **仅调用只读 GET/空体 POST**，避免变更用户状态（不调用 `redeem/claim/draw/depart` 等写接口）。
- 每个请求带 `session` Cookie + `x-client-platform: web` + `referer: /profile/growth-center`。
- 脚本：`examples/checkin_test.py`、`examples/checkin_test2.py`；原始结果：`examples/_test_results.txt`、`_test_results2.txt`、`_evidence.json`。

### 6.3 结果总表
| 类别 | 用例 | 结果 |
|---|---|---|
| 负向 | 不带 cookie 调 `streak` | **HTTP 401**（鉴权生效 ✓） |
| 正向 | `streak / energy / heatmap / buddy/info / buddy/list / buddy/quota / buddy/visible / buddy/agreement / buddy/travel/status / buddy/travel/config / lottery/summary / lottery/prizes / lottery/chances / redeem/summary / buddy/templates / v2/profile / v2/badges / v2/subscribe-task/status / v2/tasks` | **HTTP 200 / code=0**（20/20） |
| 正向 | `POST billing/meter/get-user-resource-summary / compensation-status / check-gift-claimed` | **HTTP 200 / code=0**（3/3） |
| 纠正 | `GET gray-decision(feature=oneid_component)`（首轮误用 POST 得 404，纠正后） | **HTTP 200 / code=0** |
| 探测 | `POST /activity/growth/checkin`、`/sign`（带有效凭证复测） | **HTTP 404 `404 page not found`** —— 确认旧猜测路径不存在（正确端点在 `copilot.tencent.com` 域） |
| 抓包实证（写） | `POST /activity/growth/redeem`（capture 296，请求 `{tier:"7d",client_token}`） | **code:0**（领档成功：`redemption_id:543960, energy_granted:2, cards_granted:1, chances_granted:1, remaining_days:0`）；这是用户「立即领取」点击的真实动作 |

### 6.3.1 ★ v1.2 补测（2026-09-10，遗留项收尾）
| 类别 | 用例 | 结果 |
|---|---|---|
| 负向 | `POST copilot…/checkin-activity-status` 无鉴权 | **HTTP 401**（APISIX，HTML 体）✓ 鉴权生效 |
| 正向 | `POST copilot…/checkin-activity-status` 带 Bearer | **HTTP 200 / code=0**（`today_checked_in:true, streak_days:9, total_credits:900`） |
| 正向 | `POST copilot…/daily-checkin` 当日重复调用 | **HTTP 400 / code:10001「今天已签到，请明天再来」**，且状态零变化 → **幂等确认** |
| 关键性 | 仅 `Authorization`（去掉 X-User-Id / X-Domain / X-Device-Token） | **HTTP 200** → 这三个头**非必需** |
| 跨域 | web `session` Cookie 调 `copilot.tencent.com` | **HTTP 401** → 两域鉴权不互通 |
| 域内 | `POST www.workbuddy.cn/v2/billing/meter/daily-checkin` | **HTTP 400 / code:10001** → **同名同路径在 www 域同样可达**（cookie 鉴权） |
| 凭证形态（★重点） | 仅 `session` / 仅 `session_2` / `session+tgw_l7_route` / `session+ww_device_nonce` | **全部 401** |
| 凭证形态（★重点） | **`session` + `session_2`** | **HTTP 200** → **两者必须成对**；`tgw_l7_route`、`ww_device_nonce` 非必需 |
| 凭证时效 | 旧 web session（`…\|1789403935\|…`，名义 2026-09-14 到期） | **HTTP 401** → 已被 09-08 的 `GET /console/logout` 即时吊销；**时间戳不可作有效性判据** |
| 正向复核 | `growth/streak`、`energy`、`redeem/summary`、`v2/profile`、`lottery/chances`（带 session+session_2） | **全部 HTTP 200 / code=0**（5/5） |

**v1.2 补测通过率：11/12 正向 200，唯一 400 为设计内的幂等拒绝**。测试脚本：`examples/checkin_test3.py`（桌面路径）、`checkin_test4.py`（跨域/头部必需性）、`checkin_test5.py`（web 凭证形态）；证据：`examples/_test_results3.txt` `_test_results4.txt` `_test_results5.txt` 与对应 `_evidence*.json`。
| 参考 | `POST api.trae.cn/trae/api/v2/ug/checkin_credits/status`（expired JWT） | HTTP 200 但 `code:1001, enable:false, "unable to authenticate"`（端点真实、envelope 与文档一致、凭证过期） |

**通过率：23/23（纠正后）**。首轮 22/23 的唯一「失败」为测试方法误用（POST vs GET），非接口问题。

### 6.4 关键证据（实时响应摘录，2026-09-08）
```
streak   : days=8, next_tier=14d, next_tier_remaining=6, makeup_cards={balance:1,max:4}
           redemption_status.tier_7d_status="claimed", tiers=[7d/14d/28d]
energy   : balance=10, total_earned=70, total_consumed=60
heatmap  : 365 cells (2025-09-09 ~ 2026-09-08), score>0 共 19 天, 末格 2026-09-08 score=18
travel   : state="traveling", location="咖啡馆", reward_credit=10, daily_limit_reached=true
redeem   : starter_status="claimed"
profile  : level=13, completed=13, total=16
lottery  : chances=0, module.enabled=true
```
> 与 2026-09-07 抓包快照对比：energy(8→10)、makeup_cards(0→1)、tier_7d(available→claimed)、travel(idle→traveling) 均发生变化——证明接口返回的是**实时态**，凭证有效。

### 6.5 Trae 参考端点探测
```
POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status
  Authorization: Cloud-IDE-JWT <expired>
→ 200 {"checked_in":false,"code":1001,"enable":false,
       "message":"We're sorry, but we are not able to authenticate you..."}
```
说明：Trae 签到端点真实存在、返回结构与文档一致；本抓包 JWT 已过期故被拒。其与 WorkBuddy `streak` 的 `{checked_in | days}` 字段可 1:1 对应，验证了 §4 的映射假设。

### 6.6 结论与风险（v1.2 更新）
- ✅ WorkBuddy checkin 平台核心接口**全部可用**，字段与抓包一致，凭证有效。
- ✅ **遗留项已结清**：每日签到打卡端点 = `POST /v2/billing/meter/daily-checkin`（`copilot.tencent.com`）。旧文档的「路径待确认」与「404 疑似无端点」推断**均作废**——根因是**域选错**（在 `www` 域枚举写请求，而该端点在 `copilot` 域）。
- ⚠️ **凭证形态更正（重要）**：web 侧需 **`session` + `session_2` 成对**；旧文档「带 session Cookie 即可」不完整。实测只带 `session` → 401。
- ⚠️ **凭证时效更正（重要）**：`session` cookie 第二段 unix 时间戳**不能**作为有效性判据。实测名义 2026-09-14 到期的 session 已被 09-08 的 logout 即时吊销 → 401。Provider 必须**实探**（打一次只读接口）而非算时间。
- ⚠️ 写接口边界：`daily-checkin` 已实测幂等（`code:10001`，状态零变化），**无需 `client_token`**；`redeem` 的 `client_token` 幂等边界仍建议以独立测试账号补一轮验证。
- ⚠️ 用户所见「每日100分，已领8天，累计800分」→ ★v1.2 已由接口直接提供：`daily_credit=100`（即「每日100分」）、`total_credits=900`（即「累计分」，签到 9 天）。**不再是前端推算**。旧文档基于 heatmap 的 `8×100` 推算法可弃用。
- ⚠️ 两处「streak」语义不同（严格连续 vs 活动累计），Provider 展示层必须区分（详见 §2.2-4）。

---

## 7. ★ v1.2 遗留项收尾实测（2026-09-10）

> 本节结清旧文档 §2.2-3 / §6.3 / §6.6 中所有「待确认」项。
> 输入源：`examples/workbuddy3_解析结果`（桌面端 WorkBuddy/5.5.3，2026-09-10 12:01 CST 抓包，222 条）

### 7.1 每日签到链路（完整时序，抓包 + 实测双重证据）
```
[抓包 workbuddy3，2026-09-10]
165  POST /v2/billing/meter/checkin-activity-status   → today_checked_in:false, streak_days:8, total_credits:800
166~176  POST /billing/meter/get-user-resource-*      → 积分包查询（支撑）
182  POST /v2/billing/meter/daily-checkin   {}        → ★ code:0  {credit:100, streak_days:9, is_streak_day:false}
184  POST /v2/billing/meter/checkin-activity-status   → today_checked_in:true,  streak_days:9, total_credits:900
187  POST /v2/billing/meter/checkin-activity-status   → 同上（幂等复查）

[实测 checkin_test3.py，同日稍晚]
     POST /v2/billing/meter/checkin-activity-status   → 200  today_checked_in:true, total_credits:900
     POST /v2/billing/meter/daily-checkin   {}        → 400  code:10001 "今天已签到，请明天再来"   ← 幂等
     POST /v2/billing/meter/checkin-activity-status   → 200  状态零变化，未重复发放 ✓
```
**结论**：`daily-checkin` 是**每日一次的幂等写接口**，请求体为空，成功 +100 credit，并把 `streak_days` +1、`total_credits` +100。

### 7.2 新增的三个「坑」（必须写进 Provider 实现）
1. **`session` cookie 的过期时间戳不可信**。服务端 logout 或**任何一次新登录**都会即时吊销旧 session，但 cookie 第二段的 unix 时间戳不会更新。
   - 证据：`workbuddy2_解析结果/176_GET …/console/logout` → `set-cookie: session=; Max-Age=0`；此后旧 session（名义 09-14 到期）实测 401。
   - 影响：`SessionStore` 必须**主动探活**（调一次 `checkin-activity-status`），不能靠本地时间判断。
2. **web 侧凭证是 `session` + `session_2` 双 cookie**。APISIX 前置校验要求两者同时存在，缺一即 401（`tgw_l7_route`、`ww_device_nonce` 经实测**非必需**）。
   - 影响：`client-login` 换取凭证后，必须把**两个** cookie 都存下来；只存 `session` 会导致次日全部接口 401。
3. **两个「streak」语义不同**，勿混用于同一张图：
   | 字段 | 语义 | 2026-09-10 实测 |
   |---|---|---|
   | `growth/streak.streak.days` | **严格连续**签到天数（断一天归零） | `0`（09-09 漏签） |
   | `meter/checkin-activity-status.streak_days` | **活动期内累计**签到天数 | `9` |

### 7.3 旧 404 的根因（修正记录）
| 项 | 旧结论（v1.1） | 新结论（v1.2） |
|---|---|---|
| 每日签到端点 | 「路径待确认」，猜测 `/activity/growth/checkin` | **`POST /v2/billing/meter/daily-checkin`**（`copilot.tencent.com`，www 域同名路径亦可达） |
| 旧猜测路径 | 404「仅说明猜测路径不对」 | 404 确认（带有效凭证复测），**该路径确实不存在**；404 根因是**域选错** |
| 签到写接口是否存在 | 「存在，路径未知」 | **存在且已定稿**，空请求体、天然幂等 |
| Provider `checkIn()` | 降级为「读今日状态」 | **直接 POST**，`code:10001` → `alreadyCheckedIn=true` |

### 7.4 双访问路径对照（Provider 选型依据）
| 维度 | web 路径 | 桌面 / OpenAPI 路径 |
|---|---|---|
| Host | `www.workbuddy.cn` | `copilot.tencent.com` |
| 业务前缀 | `/activity/growth/*`、`/v2/billing/meter/*` | `/v2/billing/meter/*`、`/billing/meter/*` |
| 鉴权 | Cookie：**`session` + `session_2`** | `Authorization: Bearer <JWT>`（仅此一项） |
| 凭证寿命 | 名义 7d，**可被即时吊销** | 实测 ≈60d（2026-09-10 → 2026-11-09） |
| 配对要求 | 必须双 cookie | 无 |
| 适用 | 有浏览器登录态的场景 | ★**无头 / 服务端自动签到首选** |

> **Provider 建议**：自动签到优先走桌面 Bearer 路径（寿命长、无 cookie 配对、字段一致）；web 路径作为降级或面板内嵌场景使用。

### 7.5 复现命令
```bash
cd examples
python checkin_test3.py   # 桌面路径：签到幂等性 + 鉴权（读 _test_results3.txt）
python checkin_test4.py   # 跨域鉴权隔离 + 必需请求头
python checkin_test5.py   # web 凭证形态定位（session vs session_2）+ growth 只读复核
python codearts_test.py   # CodeArts（见另一份文档）
```

---

## 8. 待确认 / 后续
1. 展示面板现有代码仓库路径（本环境仅见抓包数据，未见面板源码）——确认后把 §5 清单落地到实际文件树。
2. `session` 过期/被吊销后的静默重建是否需要用户重新 SSO，还是支持 refresh 类接口（抓包未见 refresh，需后端确认）。★v1.2 补充：若改走桌面 Bearer 路径（寿命 60d），该问题优先级大幅下降。
3. `redeem` 的幂等 `client_token` 边界（重复提交同一 token）仍建议以独立测试账号补一轮验证。`daily-checkin` 已实测幂等，无需 token。
4. 是否将 Trae 与 WorkBuddy 双 Provider 在面板并列展示（统一 `CheckinProvider` 契约已就绪）。
5. ✅ **已结清（v1.2）**：`examples/workbuddy3_解析结果`（桌面客户端 `copilot.tencent.com`，222 条）已捕获并实测每日签到链路 —— `POST /v2/billing/meter/daily-checkin` 与 `POST /v2/billing/meter/checkin-activity-status`。旧文档 §2.2-3 的遗留项关闭。**新增待办**：桌面端 JWT（`copilot.tencent.com/auth/realms/copilot`）的自动刷新流程未在抓包中出现，若要用作长期无头凭证，需确认 refresh_token 换取方式。
