# 新增 checkin（签到）平台 · 全流程方案

> 产出：接口清单与字段定义 / 展示面板 Provider 数据结构 / 1:1 参考 Trae 的交互流程 / 改造清单 / 关键接口可用性实测
> 输入源：`examples/workbuddy_解析结果`（web 抓包）、`examples/workbuddy3_解析结果`（桌面端抓包，2026-09-10）、`examples/workbuddy4_解析结果`（个人用量页抓包，2026-09-10）、**`examples/workbuddy5_解析结果`（含桌面端登录握手全链路，2026-09-10，★v1.7 新增）**
> 参考流：`examples/2026-08-15-152602_解析结果`（Trae 原生「每日签到 + 积分」API + OAuth/Passport 认证链路）
> 实测日期：2026-09-08（首轮）／2026-09-10（★遗留项收尾 + 代码落地）／2026-09-10 14:40（★v1.5：用量/余额端点修正 + 多平台统计落地）
> 文档版本：**v1.7** — ★★**纠正 v1.6 §12 的错误结论**：WorkBuddy **存在 cookie → Bearer 换票机制**，并已实装为 `authMode: 'auto'`（只填 Cookie 即自动换出 60 天 Bearer，**用户无需再抓包**）。换票链路 = `POST /v2/plugin/auth/state`（无鉴权）+ `POST www.workbuddy.cn/console/login/enterprise?state=`（带站点 Cookie）；实测边界：最小凭证 `session`+`session_2`、**会话绑定登录时 UA**、可重复换但**有速率限制**、refreshToken 暂不可兑换。详见 §12
> 上一版：**v1.6** — ①★**签到历史补齐**：`/api/checkin/logs` 改为「本地运行记录 ∪ 平台侧签到历史」（新契约 `provider.getCheckinHistory`；CodeArts 从权益包的 `每日签到赠送包 createdTime` 反推、WorkBuddy 用 `checkin_dates`），解决「平台侧连签 3 天、日历只显示 1 天」；②★**Token 无原始数据显式归因**（`usageMeta.tokens=false` → 面板显示 `—` + 具体原因，不再显示 0）；③「全部平台」视图不再重复展示全局合计格；④新增账号的「名称」占位随 Provider 变化；⑤CodeArts 权益包升级为**逐包明细**端点 + 新增「近30天区间汇总」提示；详见 §11
> 上一版：v1.4 —— ①★**新增关键坑：APISIX 校验 `User-Agent`**（同一 cookie 换 UA 即 401→200），并据此**纠正 v1.3 的「抓包会话已吊销」误判**；②Provider 的 UA 改为可配置项 + 默认取登录浏览器值；③补 WorkBuddy **真实端到端实测**（签到 +100、幂等复查，本地与远端双跑）；④§9.3 字段表 / §1.5 / §7.2 同步更新

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
- ★★ **APISIX 前置网关会校验 `User-Agent`**（2026-09-10 实测，v1.4 新增）：**同一份 cookie**，
  - UA = `…Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0` → **全部 HTTP 401**（`401 Authorization Required`，HTML 体）
  - UA = `…Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0`（登录浏览器真实版本）→ **全部 HTTP 200**

  ⇒ 401 **未必是会话失效**。若「刚复制的新 cookie 也 401」，先换 UA 再判断，
  且 Provider 必须把 UA 做成可配置项、默认取登录浏览器抓包值。
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
4. ★★ **UA 不匹配会被网关判成 401**（v1.4 新增，纠正了此前「会话已吊销」的误判）。
   - 现象：同一份 cookie，UA 用 `Edg/151` → 401；用登录浏览器的 `Edg/152` → 200。
   - 误判代价：v1.3 曾据此把 `workbuddy3` 抓包会话判为「已被服务端吊销」。
     v1.4 复核：**该会话配抓包 UA 至今仍返回 200**（`streak.days=0`，会话有效，只是当天没签）。
   - 落地：Provider 的 UA 必须可配置，默认取登录浏览器值（见 §9.3）。

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

---

## 9. ★ v1.3 落地实现（2026-09-10）

> 本章把 §1–§7 的协议结论落成**可运行代码**，并在远端 Termux 完成部署验证。

### 9.1 落地形态（与 §5「假设 TS 项目」的差异）

实际面板不是 TS 项目，而是运行在 Honor 10（Termux / Android，Node v24）上的**零依赖 ESM Node 服务** `honor10-monitor`，因此 §5 的 `providers/workbuddy/*.ts` 多文件清单**不适用**。实际落地为一个 Provider 单文件：

| 文件 | 作用 | 行数 |
|---|---|---|
| `monitor/lib/providers/index.js` | Provider 注册中心（已有，未改） | 30 |
| `monitor/lib/providers/trae.js` | Trae 参考实现（已有） | 231 |
| **`monitor/lib/providers/workbuddy.js`** | ★ 本次新增：WorkBuddy Provider | 约 340 |
| **`monitor/lib/providers/codearts.js`** | ★ 本次新增：CodeArts Provider（薄包装） | 约 300 |
| **`monitor/lib/checkin/codearts.js`** | ★ 本次新增：CodeArts 客户端（登录链 + 业务接口，零依赖） | 约 860 |
| `monitor/server.js` | 注册 3 个 Provider + 3 条验证码路由 | +约 70 行 |
| `monitor/lib/tasks/index.js` | 会话巡检门控通用化 + 告警文案通用化 | +约 15 行 |
| `monitor/frontend/checkin.html` | 「📱 设备验证」按钮（仅 verifyCode 能力显示） | +约 25 行 |

零依赖约束：只用 `node:crypto` / `node:https` / 内置 `fetch`，**不引入任何 npm 包**（手机端不做 `npm install`）。

### 9.2 Provider 契约实现（对齐 §3.4）

| 契约方法 | WorkBuddy 实现 | CodeArts 实现 |
|---|---|---|
| `checkin(task)` | 先读 `checkin-activity-status`；已签直接返回；未签 POST `daily-checkin`；`code:10001` → `alreadyCheckedIn=true` | 探活 → `has-claimed` → `claim` → 用 `package/overview` 前后余额差算当日所得 |
| `getCredits(task)` | `total_credits`（活动累计积分） | `all_credit_package.package_credit_remain` |
| `checkCredential(task)` | 状态接口可读即有效 | 签到状态可读即有效 |
| `checkStatus(task)` | `{checked_in, credits}` | `{checked_in, credits}` |
| `getTotalCredits(task)` | 主值 + 能量余额 + 累计天数 | 主值 + basic/bonus 分项 |
| `probeSession(task)` | bearer 解 JWT `exp`；web 解 `session` 第二段（仅提醒） | 实探；`expiresAt=null`（时效不可解析） |
| `requestVerifyCode(task)` / `submitVerifyCode(task, code)` | —（不需要） | ★保留：设备未受信时才需要 |
| `sessionCredentialKeys` | `['cookie','token']` | `['hwidCasSid','cookies']` |

> `sessionCredentialKeys` 是本次新增的**可选声明**：`lib/tasks/index.js` 的会话巡检原本硬编码 `task.config.cookie`，现改为按 Provider 声明取键，Trae 行为不变（默认 `['cookie']`），CodeArts 才能被纳入巡检。

### 9.3 WorkBuddy Provider configSchema（10 字段）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `authMode` | select | `web` | `web`（双 cookie）/ `bearer`（JWT，寿命 60d，推荐服务端） |
| `cookie` | password | — | **`session` + `session_2` 必须成对** |
| `token` | password | — | Keycloak JWT（Bearer 模式） |
| `baseUrl` | select | `https://www.workbuddy.cn` | 或 `https://copilot.tencent.com`（同一后端） |
| ★`userAgent` | text | 登录浏览器的 UA（默认 `…Chrome/152…Edg/152.0.0.0`） | **APISIX 会校验 UA**，与登录浏览器不一致直接 401（见 §1.5 / §7.2 坑 4） |
| `time` / `timezone` | select | `09:00` / `Asia/Shanghai` | 定时 |
| `failThreshold` | select | 3 | 连续失败告警阈值 |
| `cookieExpiryNotify` | toggle | true | 凭证到期提醒 |
| `cookieExpiryNotifyDays` | select | 1 | 提前几天提醒 |
| `notifyOnSuccess` | toggle | false | 成功也发通知 |

**§7.2 三个坑在代码中的落地**：
1. `session` 时间戳不可信 → `probeSession()` **实探** `GET /activity/growth/streak`（401 才算失效），时间戳只用于「到期提醒」。
2. 双 cookie 成对 → `authMode=web` 时凭整段 cookie 字符串发送，不做拆解、不做重组。
3. ★**绝不接受响应 cookie**：所有请求都是「从配置读凭证 → 发送」，**没有任何 `set-cookie` 回写路径**（上游会主动 `session=; Max-Age=0`，一旦回写就会把自己的会话搞没）。
4. 两个 streak 语义 → `checkin-activity-status.streak_days` 作为主展示（活动累计），严格连续天数留给 `growth/streak` 备查。

### 9.4 新增 API 路由（server.js）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/checkin/verify-code/request?id=` | 先尝试登录：设备已受信则返回 `alreadyTrusted`，否则下发验证码并返回 `authDevices[]` |
| POST | `/api/checkin/verify-code/submit?id=` | body `{code, deviceIndex}` → 校验 → 信任本机 → 落会话 |
| POST | `/api/checkin/verify-code/cancel?id=` | 丢弃本次验证会话（TTL 10 分钟） |

两条路由都支持任意 Provider：只要该 Provider 实现了 `requestVerifyCode`/`submitVerifyCode` 即可（能力位 `verifyCode`），前端按钮据此自动显隐。

### 9.5 验证结果

**本地自检（`monitor/_selftest_providers.mjs`）：22/22 通过**
```
=== 1. 静态契约 ===         两个 Provider 的 id/name/configSchema/capabilities 映射全部一致；
                            注册表可见 workbuddy、codearts
=== 2. WorkBuddy 逻辑分支（mock fetch）===
  ✓ A 已签: alreadyCheckedIn=true credits=900，且未调用 daily-checkin（省一次写请求）
  ✓ B 首签: reward=100 credits=900（800 + 100 回查）
  ✓ C 10001: 识别为已签到（非错误）
  ✓ D 401: 归一化为 kind=invalid
  ✓ E 缺凭证: kind=invalid
  ✓ F web 探活: expiresAt=2026-09-14T16:38:55Z（session 第二段）
  ✓ F bearer 探活: expiresAt=2026-11-09T04:01:26Z（JWT exp，≈60 天，与 §7.4 实测一致）
  ✓ G 总积分: 附加请求失败时降级为 null，主值不受影响
```

**远端部署（Termux Honor 10，Node v24.18.0）**：`deploy-remote.sh` 重启成功（runit），`/api/checkin/providers` 返回 3 个 Provider：
```
trae     | Trae                 | 6 caps | 10 fields
workbuddy| WorkBuddy 成长签到   | 6 caps | 10 fields
codearts | CodeArts 码道        | 7 caps | 11 fields
```

**★真实账号端到端（CodeArts，2026-09-10 现场）**：
```
POST /api/checkin/test?id=<codearts任务>     → {"ok":true,"total":7355.28,"valid":true}
GET  /api/checkin/status?id=<codearts任务>   → {"ok":true,"checked_in":true,"credits":7355.28}
GET  /api/checkin/credits/total?id=<codearts任务>
     → {"ok":true,"total":7355.28,"packs":{"basic":500,"bonus":6855.28}}
POST /api/checkin/run?id=<codearts任务>      → {"ok":true,"alreadyCheckedIn":true,"credits":7355.28,"reward":null}
```
说明：当日已领 → 幂等返回 `alreadyCheckedIn=true`；余额 7355.28 = 基础包 500 + 赠送包 6855.28，与 CodeArts 后台一致。

**★WorkBuddy 真实端到端（2026-09-10 下午，用户提供的 web 凭证）**：
```
[本地直连]
checkStatus    → {"ok":true,"checked_in":false,"credits":200}       ← 今日未签
checkin        → {"ok":true,"alreadyCheckedIn":false,"credits":300,"reward":100}   ★ +100 真实入账
checkStatus    → {"ok":true,"checked_in":true,"credits":300}
复跑 checkin   → {"ok":true,"alreadyCheckedIn":true,"credits":300,"reward":null}    ← 幂等

[远端 Termux 服务，同上凭证]
POST /api/checkin/test  → {"ok":true,"total":300,"valid":true}
GET  /api/checkin/status→ {"ok":true,"checked_in":true,"credits":300}
GET  …/credits/total    → total=300, energy=3, streakDays=3, checkins=["2026-09-10","2026-09-09","2026-09-08"]
POST /api/checkin/run   → {"ok":true,"alreadyCheckedIn":true,"credits":300,"reward":null}
```
完整状态样本（`checkin-activity-status` 实测）：
```json
{"active":true,"season":8,"activity_name":"开学季","theme_name":"Buddy加油站",
 "today_checked_in":true,"streak_days":3,"total_credits":300,"daily_credit":100,"today_credit":100,
 "checkin_dates":["2026-09-10","2026-09-09","2026-09-08"],"week_checkin_days":3,
 "week_progress":[false,true,true,true,false,false,false],
 "start_time":"2026-09-01 00:00:00","end_time":"2026-09-15 23:59:59",
 "claim_button_text":"立即领取",
 "action_button":{"show":true,"text":"认证领积分","action":"…/events/campus-freshman/"}}
```
> ★**结论修正（v1.4）**：v1.3 记录的「抓包会话已被服务端吊销」是**误判** —— 真因是 UA 不匹配（§1.5 / §7.2 坑 4）。
> 旧抓包会话配抓包 UA 至今仍 200。WorkBuddy 侧现已**真实跑通签到（+100）与幂等复查**，无需再等凭证。

### 9.6 复现命令
```bash
# 本地（Windows / 任意 Node ≥18）
node monitor/_selftest_providers.mjs        # 22 项自检
node --check monitor/lib/providers/workbuddy.js
node --check monitor/lib/providers/codearts.js

# 远端（Termux）
cd $HOME/monitor && bash deploy-remote.sh
curl -s http://127.0.0.1:3081/api/checkin/providers
```

---

## 10. ★ v1.5 落地实现（2026-09-10 14:40）：真实余额 / 真实用量 / 多平台统计

### 10.1 本次要回答的四个问题

| # | 用户问题 | 结论 |
|---|---|---|
| Q1 | 新增两个平台的「近30天」是不是没有远程端点验证？ | **一半对**。「📅 近30天」按钮走的是**本地日志**（`checkin_logs.json`，由真实签到运行写入，数据真实但非远端查询）；**远端逐日验证**由另一个按钮「◈ 积分消耗明细」提供，本次已让两个新平台都具备真实远端来源 |
| Q2 | WorkBuddy 积分只显示 300，不是 1700 左右 | **确认是 bug**：用错了字段（活动累计 ≠ 账户余额）。已改用真实余额端点，实测 1702~1722 |
| Q3 | 数据面板只显示 Trae，缺 provider 切换与总统计 | **确认是架构缺口**：`checkin-stats.js` 只认 `getUsage`，且前端无平台维度。本次三者全补 |
| Q4 | 继续审计哪些端点没有真实服务器端点 | 见 **§10.3 端点真伪审计表**（已逐条实测） |

### 10.2 根因与修复

| 问题 | 根因 | 修复 |
|---|---|---|
| 积分 300 ≠ 1700 | `getCredits/getTotalCredits` 取 `checkin-activity-status.total_credits`（签到活动**累计发放**积分：3 天 × 100 = 300），与账户可用余额无关 | 新增 `fetchBalance()` 走 `POST /billing/meter/get-user-resource-summary`，主值 = `Σ Packages[].CycleRemainCapacity`；`total_credits` 降级为附属字段 `activityCredits` |
| 面板只有 Trae | `updateUsageStats()` 里 `if (typeof provider.getUsage !== 'function') { noSupport++; continue; }`，只有 Trae 实现了 `getUsage` | ①WorkBuddy 补 `getUsage`（真实远端）②CodeArts 补 `getDailyUsage`（真实远端聚合）③`checkin-stats` 支持两种口径并把来源写进落库 |
| 无 provider 切换/总计 | 前端只有「账号」下拉，无平台维度 | `getUsageStats()` 新增 `byProvider`（复用同一 `buildTotal()` 算法，避免口径漂移）；前端加平台切换按钮组 + 「全部平台年/月合计」格 |
| WorkBuddy 逐日全为 0 | `get-user-request-usage` **只保留近 30 天**，起点早于窗口会**静默返回空列表**（HTTP 200 / code 0，不报错） | `fetchUsage()` 把起点收敛到近 30 天（`MAX_LOOKBACK_DAYS = 30`）；落库版本号 bump 到 v4 强制重拉 |

### 10.3 ★ 端点真伪审计表（核心产物）

> 判定口径：**🛰 真实远端** = 本次实测从厂商服务器拿到当前账号的真实数据；**📄 本地记录** = 本机文件，内容可能源自真实运行/真实端点，但本身不是远端查询。

#### WorkBuddy

| 端点 | 用途 | 性质 | 实测（2026-09-10） |
|---|---|---|---|
| `POST /v2/billing/meter/checkin-activity-status` | 签到活动状态 | 🛰 真实远端 | code 0，today_checked_in=true，total_credits=300 |
| `POST /v2/billing/meter/daily-checkin` | 每日签到（写） | 🛰 真实远端 | code 0，credit=+100 |
| `POST /billing/meter/get-user-resource-summary` | ★**账户可用余额** | 🛰 真实远端 | 1722.11 / 配额 6900（2 个包） |
| `POST /billing/meter/get-user-request-usage` | ★**逐请求消耗明细** | 🛰 真实远端 | 近 30 天 total=242 条 |
| `POST /billing/meter/get-user-resource-free-packages` | 免费权益包明细 | 🛰 真实远端 | 17 个资源实例（含包名/周期） |
| `POST /billing/meter/get-user-resource-paid-packages` | 付费权益包明细 | 🛰 真实远端 | 0 条（未购买） |
| `POST /billing/meter/compensation-status` | 补偿包领取状态 | 🛰 真实远端（只读） | claimed=true, credit_num=1000 |
| `POST /billing/meter/check-gift-claimed` | 礼包领取状态 | 🛰 真实远端（只读） | claimed=true, credit_num=1500 |
| `GET /activity/growth/streak` | 连续签到 | 🛰 真实远端 | streak_days=3 |
| `GET /activity/growth/energy` | 能量余额 | 🛰 真实远端 | balance=3 |
| `checkin_dates` + `daily_credit` | 签到记录（日期→积分） | 派生字段 | 由上面的真实端点响应折算 |

#### CodeArts

| 端点 | 用途 | 性质 | 实测 |
|---|---|---|---|
| `GET  /portal/snap-manager/v1/credit/has-claimed` | 今日是否已领 | 🛰 真实远端 | 裸布尔 |
| `POST /portal/snap-manager/v1/credit/claim` | 领取积分（写） | 🛰 真实远端 | 裸布尔 true |
| `GET  /portal/snap-manager/v1/package/overview` | 余额 / 分项 | 🛰 真实远端 | 7355.28 / 7500 |
| `GET  /portal/snap-manager/v1/package/info` | 套餐规格 | 🛰 真实远端 | codearts.agent.individual.trial |
| `POST .../analytics/usage/personal/charts` | ★**逐日 + 按模型用量** | 🛰 真实远端 | DATE_DAY 30 格；09-09=144.72 |
| `POST .../analytics/usage/personal/stats` | 区间汇总指标 | 🛰 真实远端 | TOTAL_CREDITS=144.72 |
| `POST .../analytics/usage/personal/heatmap` | 用量热力图 | 🛰 真实远端 | 31 格 |
| ⚠️ 会话级（逐请求）明细 | — | **不存在** | 只有日粒度 + 区间模型粒度，没有 `日期×模型` 矩阵 |

#### Trae（参照系）

| 端点 | 用途 | 性质 |
|---|---|---|
| 按会话用量 `user_usage_group_by_sessions` | 逐日消耗（含 token 明细） | 🛰 真实远端 |
| 权益包列表 | 余额分项 | 🛰 真实远端 |

#### 本地记录（明确**不是**远端端点）

| 位置 | 内容 | 说明 |
|---|---|---|
| `GET /api/checkin/logs`（📅 近30天按钮） | 签到结果日志 | 📄 本地 `checkin_logs.json`，由**真实签到运行**写入 → 数据真实，但不是远端查询 |
| `data/checkin_stats.json` | 每日 00:00 余额快照 | 📄 本地，快照值取自真实余额端点 |
| `data/checkin_usage_stats.json` | 逐日消耗落库 | 📄 本地缓存，**源为各平台真实远端端点**，供面板快速读取 |

### 10.4 `get-user-request-usage` 的三个坑（v1.5 实测补齐）

1. **参数类型**：`startTime`/`endTime` 必须是 `"YYYY-MM-DD HH:mm:ss"` **字符串**。
   传 epoch 毫秒（数字或数字字符串）→ `code 10001 json: cannot unmarshal number into Go struct field GetUserUsageReq.startTime of type string`。
2. **键名**：分页键是 `pageNum`（**不是** `pageNumber`）。用错键名**不报错**，静默返回 `total: 0, data: []` —— 极易误判为「这个账号没有用量」。
3. **保留窗口**：**只保留近 30 天**。实测同一 cookie、同一账号：

   | 查询区间 | 返回 |
   |---|---|
   | `2026-09-01` ~ `2026-09-09` | total=101（有数据） |
   | `2026-08-01` ~ `2026-09-09` | total=0（**静默空**，HTTP 200 / code 0） |
   | `2026-06-01` ~ `2026-09-09` | total=0（静默空） |

   ⇒ Provider 侧把起点收敛到 `now - 30d`。**不收敛的话，逐日统计会整段落 0 并写进落库**（本次真实踩到：WorkBuddy 年度消耗落成 0，修正后为 964.94）。

### 10.5 统计数据落库口径（`lib/checkin-stats.js`）

取数优先级（**全部优先真实远端端点，绝不用本地记录顶替**）：

```
provider.getDailyUsage(task, {startSec, endSec})   → 平台直接给逐日聚合（CodeArts 用量分析）
  ↓ 无则
provider.getUsage(task, {start_time, end_time, …}) → 按会话/按请求明细，本地按日聚合（Trae / WorkBuddy）
  ↓ 无则
计入 noSupport（面板不展示该账号）—— ★不塞本地记录充数
```

- Trae 的参数契约是基准（`start_time/end_time` 为 epoch 秒 + `usage_type:[7]`）；WorkBuddy 在自己的 `getUsage` 里把 epoch 翻译成日期字符串，对上保持同一契约。
- 落库版本 `TOKEN_VERSION = 4`；不匹配即强制全量重拉（用于修正历史错误口径）。
- 落库每条账号记录新增：`providerId` / `providerName` / `source` / `sourceLabel` / `note` / `modelTotals`（区间模型累计，用于「无逐日模型归属」的平台）。
- `getUsageStats()` 返回新增 `byProvider[]`，每项含该平台的 `total`（与全局 total 同一算法 `buildTotal()`）。

### 10.6 新增 / 变更的 API 路由

| 路由 | 变更 |
|---|---|
| `GET /api/checkin/stats` | 返回值新增 `byProvider[]`；账号新增 `source/sourceLabel/note/providerId/modelsFromRange` |
| `POST /api/checkin/usage?id=` | provider 无 `getUsage` 时不再 501，改为 **降级返回落库逐日明细**：`{ok, fallback:'daily', reason:'provider_no_session_api', days, models, sourceLabel, note}` |
| `GET /api/checkin/packages?id=` | ★新增：权益包明细（WorkBuddy `free/paid-packages`、CodeArts `package/overview`） |

### 10.7 前端面板变化（`frontend/checkin.html`）

1. **平台切换按钮组**（全部平台 / Trae / WorkBuddy / CodeArts）——切换后账号下拉、柱状图、月柱状图、日历热力图全部按该平台重算。
2. **总计**：统计块第一格显示当前视图账号数；末格「**全部平台 年 / 月合计**」常驻，切换平台时也能看到全局数。
3. **数据来源徽标**：每个账号行标注 `🛰 来源接口`（远端）或 `📄`（本地），悬停显示完整来源与注意事项。
4. **权益包按钮** `💎 权益包`：仅对声明了 `packages` 能力的 provider 显示，展示进度条 + 剩余/总量 + 周期截止。
5. **消耗明细降级视图**：provider 无会话接口时，渲染落库逐日表（日期 / 模型 / 积分 / token）+ 模型区间累计说明。

### 10.8 验证结果（真实链路，非 mock）

```
# 本地自检：35 项全绿（新增 H 组 4 项：用量入参类型/键名、出参映射、token 不臆造；I 组 2 项：PackageCodes 必填）
自检结果：通过 35，失败 0

# 远端 /api/checkin/stats（5 个账号，101 天）
byProvider: [('codearts', 1, 144.72, 1730038),
             ('trae',     3, 14561.79, 2105309435),
             ('workbuddy',1, 964.94, 0)]
TOTAL year = 15671.45

# 远端 /api/checkin/usage（WorkBuddy，真实逐请求明细）
ok=True total=242   首条: 1789022340 deepseek-v4.1-flash 14.12

# 远端 /api/checkin/usage（CodeArts，降级逐日）
fallback=daily  source=remote  sourceLabel=CodeArts 用量分析接口
days[0] = 2026-09-09 144.72  模型={"GLM-5.2":144.72}

# 远端 /api/checkin/packages
WorkBuddy: total=1702.06 free=17 paid=0
CodeArts : total=7355.28 spec=codearts.agent.individual.trial
```

### 10.9 复现命令

```bash
# 本地（Windows / 任意 Node ≥18）
node monitor/_selftest_providers.mjs        # 35 项自检（含真实只读探活）
node --check monitor/lib/providers/workbuddy.js
node --check monitor/lib/checkin-stats.js

# 远端（Termux）
cd $HOME/monitor && bash deploy-remote.sh
curl -s http://127.0.0.1:3081/api/checkin/stats | python3 -m json.tool | head -40
curl -s -X POST "http://127.0.0.1:3081/api/checkin/usage?id=<taskId>" \
     -H 'Content-Type: application/json' \
     -d '{"start_time":0,"end_time":9999999999,"page_size":50,"page_num":1}'
curl -s "http://127.0.0.1:3081/api/checkin/packages?id=<taskId>"
```

### 10.10 遗留 / 已知限制

- **WorkBuddy 用量不返回 token 数**（只有 `credit`）→ 面板在该平台 token 列恒为 0 / 「—」，**不臆造**。
- **CodeArts 无会话级明细**，且 analytics 不提供 `日期×模型` 矩阵 → 只有当「区间内单模型」或「单消耗日」时才做逐日模型归属，否则只给区间模型累计并显式标注。
- **只有 `getUsage` / `getDailyUsage` 的 provider 会进入消耗统计**；都不支持的平台计入 `noSupport`，面板不展示（而不是拿本地记录占位）。
- `lib/checkin-stats.js` 的 `getStats()`（旧「快照差分」口径）已无调用方，保留但不再进入面板。


---

## 11. ★ v1.6 落地实现（2026-09-10 15:40）：签到历史补齐 / Token 无数据归因 / 名称占位

> 输入：用户三问 —— ①「CodeArts 权益包里有每日签到数据，但『近30天』还是只有一天」；②「新增账号时名称 placeholder 没有随 provider 变」；③「WorkBuddy Bearer token 到底怎么获取，能不能用 cookie 换」
> 新增抓包证据：`examples/codearts3_解析结果`

### 11.1 CodeArts「近30天」只有一天 —— 根因与修复

**根因**：`checkin_logs.json` 只记录**本部署真正执行过签到的那几天**。CodeArts 账号是 09-08 接入的，
但监控只在 09-10 落了一条记录 → 日历 30 格里只有 1 个 ✓。而平台侧其实连签了 3 天
（权益包里躺着 3 个 `每日签到赠送包`，`createdTime` 分别是 09-08 / 09-09 / 09-10）。

**修复：`/api/checkin/logs` 改成「本地运行记录 ∪ 平台侧签到历史」**

| 平台 | 远端签到历史数据源 | 实测结果 |
|---|---|---|
| CodeArts | `POST /portal/snap-manager/v1/package/credit/page` → 过滤 `resourceSpec` 含 `bonus.daily_login`，`createdTime` 即签到日、`creditAmount` 即当日发放 | 3 天：09-08 / 09-09 / 09-10（各 1000） |
| WorkBuddy | `checkin-activity-status.checkin_dates` + `daily_credit`（与「预估可用天数」同源） | 3 天：09-08 / 09-09 / 09-10（各 100） |
| Trae | 无远端签到历史接口 → 返回 `hasRemoteApi=false`，前端标注「仅显示本机运行记录」 | 28 天（全部本机） |

- 新契约：`provider.getCheckinHistory(task,{days}) -> [{date, credits, source}]`（**可选**，未实现的平台自动降级）
- 合并策略：远端只补本地**没有**的日期，标记 `source:'remote'`；本地记录永远优先（含失败/凭证失效状态）
- 前端：新增 `.log-day.remote` 蓝色样式 + 图例（本机成功 / 平台远端记录 / 失败 / 凭证失效 / 未签到），
  并在标题栏显示「其中 N 天为本机未运行、由平台远端记录补回」；无远端接口的平台显式说明

**实测（生产域名 `/api/checkin/logs?taskId=<codearts>`）**：
`localCount=1, remoteCount=2, remoteLabel="codearts 权益包明细(每日签到包)"` → 日历 3 天 ✓

### 11.2 新增/确认的 CodeArts 端点（`examples/codearts3_解析结果`）

| 端点 | 说明 | 用途 |
|---|---|---|
| `POST /portal/snap-manager/v1/package/credit/page` | ★**逐包明细**（单层信封，无 code 包裹）：`{list:[{packageType,resourceSpec,creditAmount,creditUsed,createdTime,expiredTime}],total}` | 权益包浮层数据源（升级）+ 签到历史 |
| `GET /portal/dataflywheel/.../analytics/filters/options?startDate=&endDate=&isPersonal=true` | 筛选项（teams/models/serviceFunctions/dataLastUpdateTime） | 证实「近 N 天」= 日期参数 |
| `POST /portal/dataflywheel/.../analytics/usage/personal/stats` | 区间汇总：`TOTAL_CREDITS/TOKEN_TOTAL/TOKEN_DAILY_AVG/REQUEST_COUNT/ACTIVE_DAYS/TOKEN_CACHE_HIT` | 「近30天区间汇总」提示条 |

**★关于「CodeArts 有没有『近30天』端点」**：
没有名为「近30天」的独立端点，但**所有用量端点都是日期区间参数化的** ——
`{startDate,endDate}` 设成 30 天就是「近30天」（抓包里 heatmap 甚至一次性拉了整年
`2025-09-10 ~ 2026-09-10`）。真正缺的是**逐请求/逐会话明细**端点（所以「积分消耗明细」
只能降级到逐日）。实测 30 天区间汇总：`2026-08-12 ~ 2026-09-10 → token=1,730,038,
日均=57,667.93（=总量/30）, 请求=1, 活跃=1 天, 缓存命中=1,206,400`。

### 11.3 Token 无原始数据 → 显式归因（不再显示 0）

- Provider 新增**用量能力声明** `usageMeta = { tokens: boolean, tokenNote: string|null }`：
  - `workbuddy`: `tokens:false` + 说明「`get-user-request-usage` 只返回积分/请求条数/模型/时间，不返回 token 明细」
  - `trae` / `codearts`: `tokens:true`
- `checkin-stats` 把它落到 `checkin_usage_stats.json` 的 `accounts[].usageMeta`，
  并在 `getUsageStats()` 输出 `tokenSupported` / `tokenNote`（账号级 + `byProvider[]` 平台级）
- 前端：Token 视图下该类账号的值显示 **`—` + 悬停原因**，统计卡顶部弹出琥珀色说明条
  （「**WorkBuddy 平台不提供 token 原始数据：…** Token 视图下显示为 —（未采集到原始数据，
  不等于消耗为 0）；积分数据完整可用」）；图表区同样给出「图为什么是空的」说明
- 顺带把 CodeArts 30 天区间汇总渲染成 🛰 提示条（Token / 日均 / 缓存命中 / 请求数 / 活跃天数）

### 11.4 全部平台视图不再重复展示「全部平台合计」

选「全部平台」时，`total` 本身就是全局合计，右侧那颗「全部平台 年/月合计」格子是重复信息 → **隐藏**；
只有切到具体平台视图时才显示，并改名为「**全部平台 年 / 月合计（对照）**」。

### 11.5 新增账号的名称占位随 Provider 变化

- Provider 新增可选字段 `namePlaceholder`（`getProviderSchemas()` 透出）：
  `trae → 例：Trae 主账号`、`workbuddy → 例：WorkBuddy 成长签到 · 乐幻`、`codearts → 例：CodeArts 码道 · 17327137416`
- 前端 `syncNamePlaceholder()` 在打开弹窗与切换 Provider（`renderFields`）时同步刷新；
  Provider 未声明时兜底 `例：<provider.name> 主账号`

### 11.6 验证结果

- 本地自检 `monitor/_selftest_providers.mjs`：**35 通过 / 0 失败**，新增两项真实探活输出：
  - `WorkBuddy 远端签到历史（checkin_dates）: 3 天 → 2026-09-08(100), 09-09(100), 09-10(100)`
  - `CodeArts 远端签到历史（每日签到赠送包 createdTime）: 3 天 → 2026-09-08, 09-09, 09-10`
  - `CodeArts 权益包: ... perPackage=true（赠送包·每日签到赠送包:1000 ×3 / 赠送包·新订阅赠送包:3855.28 / 基础包·个人体验版基础包:500）`
- 生产域名实测：`/api/checkin/logs?taskId=<codearts>` 返回 3 天（2 天 `source=remote`）；
  `/api/checkin/providers` 三个平台的 `namePlaceholder` 均正确；前端新函数全部命中

### 11.7 复现命令

```bash
# 签到历史（合并本地 + 远端）
curl -s "http://127.0.0.1:3081/api/checkin/logs?taskId=<taskId>"
# 区间汇总（近30天）
curl -s "http://127.0.0.1:3081/api/checkin/stats?force=1" | node -e "..."   # 看 accounts[].summary
```

---

## 12. ★ WorkBuddy Bearer Token 溯源（2026-09-10）：能不能用 cookie 换？

> 用户问：「确定 workbuddy bearer token 如何获取 —— 这个 token 只能抓包，但抓包很麻烦，希望能用 cookie 换；如果确定换不了，告诉我，我再去抓包。」
> 证据来源：`examples/workbuddy_解析结果`、`workbuddy2_解析结果`（桌面端会话）、`workbuddy3/4`，以及线上 web/usercenter 前端 bundle 反查。

### 12.1 Bearer 到底是什么（已解码）

桌面端请求头里那串 `eyJ...` 是 **Keycloak access token**（RS256，`kid=myfEzp783Ki_JCx8Vnc3X_ix6jZrb6Cf5OMkGZMPI3s`）：

| 字段 | 值 |
|---|---|
| `iss` | `https://copilot.tencent.com/auth/realms/copilot` |
| `azp`（client_id） | `console` |
| `aud` | `account` |
| `scope` | `profile offline_access email` |
| `sub` / `preferred_username` | `8b3cb381-…` / `17327137416` |
| `realm_access.roles` | `default-roles` / **`offline_access`** / `uma_authorization` |
| 有效期 | `exp - iat = 5,184,000s` = **60 天** |

调用方的额外约定：请求带 `x-domain: copilot.tencent.com`、`x-user-id: <sub>`。

### 12.2 ★结论更正：站点 cookie **可以**换到 Bearer（v1.7，2026-09-10）

> ⚠️ **本节推翻了 v1.6 的结论。** 当时（`workbuddy_/2/3/4_解析结果`）判定「不存在换票端点」，
> 是因为那 4 份抓包里**没有覆盖「桌面端首次登录/扫码登录」这一步**——换票端点只在
> **登录握手阶段**出现。补抓 `workbuddy5_解析结果`（含完整登录链路）后找到并**实测通过**。

**换票链路（两条请求，全部实测 2026-09-10）**

```
① 申请 state（完全无需鉴权）
   POST https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy
   头：X-No-Authorization: true / X-Domain: copilot.tencent.com / X-Product: SaaS
   体：{}
   → { code:0, data:{ state:"23a892d8-…", authUrl:"https://www.workbuddy.cn/login?platform=workbuddy&state=…" } }

② 用站点 Cookie 换票（★打 www.workbuddy.cn，Cookie 属于该域）
   POST https://www.workbuddy.cn/console/login/enterprise?state=<state>
   头：x-domain: www.workbuddy.cn / x-product-code: workbuddy / cookie: session=…; session_2=…
   → { code:0, data:{
        accessToken: "eyJhbGciOi…",          // 就是桌面端那串 Bearer（Keycloak access token）
        expiresIn: 5184000,                   // 60 天
        refreshToken: "eyJhbGciOiJIUzUxMi…",  // 90 天（见 12.5，暂不可用）
        refreshExpiresIn: 7776000,
        tokenType: "Bearer" } }
```

客户端侧的完整时序（`workbuddy5` 抓包编号）：
`005` 申请 state → 打开 `authUrl` 登录页 → `041/054/060` 轮询
`GET /v2/plugin/auth/token?state=…`（返回 `code:11217 login ing...`）→ `061` 换票命中 →
`069` 轮询也拿到 token → `072/074` 后续请求开始带 `Authorization: Bearer`。

**实测边界条件（都是踩过的坑）**

| 项 | 实测结果 |
|---|---|
| 最小凭证 | Cookie 里的 **`session` + `session_2` 两项**；只给一项或不给 → **401** |
| **User-Agent** | 站点会话**绑定登录时的 UA**：换一个同样合法的完整 Chrome UA（非登录时那个）→ **401**；用登录浏览器的 UA → **200**。`accept` 头无关 |
| 可重复性 | **可重复换票**（非一次性）。但**有速率限制**：短时间连换 ~8 次后开始 401，等 45~60 秒即恢复 ⇒ 换出的 token 必须缓存，只在临期时才再换 |
| 鉴权域 | 换出的 Bearer 在 `www.workbuddy.cn` 与 `copilot.tencent.com` **都可直接用**（实测均 200，返回体逐字段一致） |
| 空请求体 | `POST /console/login/enterprise` 不需要请求体；`x-device-token` **非必需** |

### 12.3 落地实现：`authMode: 'auto'`（Provider 已上线）

`monitor/lib/providers/workbuddy.js` 新增第三种鉴权形态（与 Trae 的 `resolveToken` 同构）：

| authMode | 行为 |
|---|---|
| **`auto`（新默认，推荐）** | 有 Cookie → 换 Bearer 后用 Bearer；token 剩余 < 6h 才再换；**换票失败自动回落 Cookie 直连**，签到不中断 |
| `web` | 始终 Cookie 直连（旧行为，保持不变） |
| `bearer` | 始终用手填 token |

关键实现点：
- 换出的 `accessToken` 回写 `task.config.token`，到期时间回写 `task.tokenExpiredAt`（随 `saveTasks` 落盘）。
- 模块级 `exchangeCooldown`（60s）：换票失败后进入冷却，避免同一轮签到里每个请求都去撞限流（不入 tasks JSON）。
- 编辑账号改 Cookie 时，`updateTask` 已有的 `delete task.config.token` 逻辑会强制重换，不会沿用旧账号 token。
- 换票 401 的错误信息里直接列出三种成因（UA 不一致 / 缺 session / 换票过频），便于自查。

**收益**：用户只需粘贴一次 Cookie（**无需抓包**），即可获得 **60 天**的 Bearer；
需要人工维护的仍是 Cookie（名义 7 天，到期前邮件提醒），而 Bearer 由它自动派生。

### 12.4 关于 refreshToken：暂时用不了（已实测）

`refreshToken` 是标准 Keycloak offline token（`typ:Offline`、`azp:console`、
`aud=https://copilot.tencent.com/auth/realms/copilot`、`scope` 含 `offline_access`），
但直接兑换被拒：

```
POST https://copilot.tencent.com/auth/realms/copilot/protocol/openid-connect/token
     grant_type=refresh_token & client_id=console & refresh_token=<rt>
→ 401 unauthorized_client  （不带 client_id 同样 401 invalid_client）
   client_id=account-console → 400 invalid_grant
        "Invalid refresh token. Token client and authorized client don't match"
```
⇒ `client_id=console` 这个 client 未开放 `refresh_token` 直连授权；`account-console` 这个 client
虽允许 refresh 授权但签发方不匹配。**续期只能靠「Cookie 再换一次」**，故 Cookie 才是需要人工维护的凭证。

### 12.5 已排除的做法（保留）

- ❌ 把 `KEYCLOAK_IDENTITY` 直接当 Bearer 用（`typ:JWT` 的 SSO 身份令牌，`aud`/用途不同）
- ❌ 用 `session`/`session_2` 调 `/protocol/openid-connect/token`（Keycloak 不认站点会话）
- ❌ `/console/validate/refresh-token`：只返回 `{code:0,msg:"OK"}` 并**清空** `session`/`session_2` cookie，不签发任何令牌
- ❌ 从 web 控制台前端 bundle 找换票端点（755 KB bundle 里无 `Authorization`/`access_token`）
  —— 这条推理当时导向了错误结论：换票发生在**桌面客户端登录握手**，不在 web 控制台里

### 12.6 复现脚本

- `monitor/_probe_wb_token_exchange.mjs` —— 用抓包里的 Cookie 跑一遍 ①②，打印换出的 token 有效期
- `monitor/_probe_wb_auto_mode.mjs` —— 端到端验证 auto 模式（换票 / 缓存复用 / web 对照 / probeSession）
- `monitor/_probe_wb_auto_remote.mjs` —— 手机端同款验证（读线上任务副本，不落盘）

### 12.7 备选路线（不再需要，留档）

**API Key**：`https://www.workbuddy.cn/profile/keys`，接口 `GET/POST /console/api/client/v1/api-keys`
（有效期可选 7 天 / 30 天 / 1 年 / 永久）。只读实测 `HTTP 200, code=0, total=1, items=[]`。
⚠️ 未验证能否用于 `/v2/billing/meter/*`；创建 Key 属写操作，未经用户同意不做。
