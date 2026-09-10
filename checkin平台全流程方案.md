# 新增 checkin（签到）平台 · 全流程方案

> 产出：接口清单与字段定义 / 展示面板 Provider 数据结构 / 1:1 参考 Trae 的交互流程 / 改造清单 / 关键接口可用性实测
> 输入源：`examples/workbuddy_解析结果`（HTTP 抓包解析，主域 `www.workbuddy.cn`）
> 参考流：`examples/2026-08-15-152602_解析结果`（Trae 原生「每日签到 + 积分」API + OAuth/Passport 认证链路）
> 实测日期：2026-09-08 ｜ 文档版本：v1.1（②更正「立即领取」= 已确认 `redeem` 端点；澄清每日签到打卡独立端点仍待抓包；修正 heatmap 今日 score=2）

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

### 1.3 鉴权形态
| 平台 | 凭据 | 形态 | 有效期 |
|---|---|---|---|
| WorkBuddy | `session` Cookie | `<id>\|<expiry_unix>\|<hash>` | 中间段为过期 Unix 时间戳，约 24h（实测 `1789403935` ≈ 2026-09-14 16:38Z） |
| Trae | `Cloud-IDE-JWT` | `RefreshToken` 派生的 JWT | access≈14 天，refresh 更长 |

### 1.4 全局常量（来自 WorkBuddy streak 接口）
- `timezone = "Asia/Shanghai"`
- `launch_date = "2026-06-17"`（成长平台上线日）
- 稀有度枚举：`R / SR / SSR / UR`
- 积分单位：`energy`（能量）、`credit`（积分/抽奖）、`cards`（补签卡）、`chances`（抽奖机会）

### 1.5 关键坑（实测确认）
- WorkBuddy 几乎所有 growth/billing 响应都会 `set-cookie: session=; Max-Age=0` **主动清 session**；请求里携带的才是有效 session，**切勿用响应 cookie 覆盖本地 session**。
- 风控参数（Trae 的 `msToken/a_bogus/ttwid`）属可选层，等价实现可裁剪或自签。

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

**2) 每日签到打卡（手动点击）—— 端点路径仍待确认**
- 用户的「连续 8 天」(`streak.days=8`) 证明**每日签到点击确实在发生**；但本次抓包已枚举全部 growth 写请求（`296 redeem` / `247 buddy_travel_claim` / `280 buddy_travel_depart` / `312 lottery_draw`），**除 `redeem` 外没有第二条签到类 POST**。
- 故「每日签到打卡」的真实端点路径**仍未在抓包中**，需一次点击抓包确认。其 1:1 工作规格见 §2.2-3。
- 展示与「今日已签」判定当前可用只读接口驱动（见 §2.2-4），不依赖该写端点。

**3) 每日签到写接口（工作规格，路径待确认）**
| Method | Path（推测，★以点击抓包为准） | 请求 | 响应 `data` |
|---|---|---|---|
| POST | `/activity/growth/<checkin>`（真实 path 待确认） | `{ "client_token":"checkin-<YYYYMMDD>-<uuid>" }`（幂等防重） | `{ "checked_in":bool, "streak_days":int, "credit_granted":int, "energy_granted":int, "requestId":string }` |

**4) 签到状态读取（展示用，已可用，来自现有 capture）**
- `GET /activity/growth/streak` → `streak.days`、`makeup_cards`、`redemption_status`
- `GET /activity/growth/heatmap` → `cells[]`，**今日格 `score>0` 即视为已签到**（实测 2026-09-08 `today.score=2, is_active:true, status_text:"今日已活跃"` ⇒ 当日已签；`streak.days=8` 与 `month_total_days=8` 一致）
- 两个只读接口已实测可用（HTTP 200/code=0），可直接驱动面板「今日是否已签」标识与连续天数环。

**5) 用户可见文案 ↔ 结构化字段映射（关键）**
用户点击「立即领取」后看到的 UI 提示「**每日100分，已领8天，累计800分**」是**前端聚合展示文案**，字面值 `100 / 800` **未出现在任何接口响应体**：
| UI 文案 | 结构化来源 | 说明 |
|---|---|---|
| 已领8天 | `streak.days` (=8) / `redeem_summary.remaining_days` (=8) | 直接对应，已确认 |
| 每日100分 | 前端固定常量（成长中心卡片标签，未在响应中） | Provider 侧记为 `streak.dailyPoints=100` 展示常量，待 growth-center JS（capture 184/188/190）确证 |
| 累计800分 | `streak.days × dailyPoints` = 8×100 | 前端计算展示，非接口字段 |

**6) Provider 落地**
- `claim(session, tier)`（★已确认）：映射 `POST /activity/growth/redeem{tier,client_token}`，与 Trae `claim` 1:1；调用后回查 `streak`/`redeem_summary` 刷新。
- `checkIn(session)`（每日打卡，路径待确认）：主路径为 `POST` 每日签到（真实路径确认后回填）；确认前降级为「读取今日状态（heatmap 今日格 score>0）」。
- `getStatus(session)`：照常读取 `streak`+`heatmap`+`redeem_summary` 用于展示与「今日已签」判定。

**⚠️ 待办（非阻塞）**：若「每日签到打卡」与「立即领取(redeem)」是**两个不同按钮**，请在成长中心**再点一次每日「签到」**，把该请求（URL+请求体+响应体）发我，我据此回填 §2.2-3 真实路径并实跑测试。

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
  authType: "cookie";              // 区别于 trae 的 "jwt"
  auth: {
    cookieName: "session";         // 形如 <id>|<expiry_unix>|<hash>
    sessionTtlSeconds: 86400;      // 中间段 unix 估算
    establishVia: "client-login";  // A4：code 换 session
  };
  endpoints: {                     // 路径映射（复用 trae 骨架的 endpoint 配置位）
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
    days: number;                 // 连续天数
    checkedInToday: boolean;      // 今日是否已签到（heatmap 今日格 score>0 推导）
    lastCheckinDate: string | null; // 最近签到日期 YYYY-MM-DD
    monthTotalDays: number;
    monthConsumedDays: number;
    dailyPoints: number;          // 前端展示常量：每日签到积分（默认 100），来自成长中心卡片，未在 API 响应；累计分=days×dailyPoints
    nextTier: string | null;      // "14d"
    nextTierRemaining: number;
    makeupCards: { balance: number; max: number };
    tiers: Array<{                // 档位奖励
      tier: string; days: number;
      credit: number; energy: number; cards: number; chances: number;
      status: "available" | "claimed" | "locked";
    }>;
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
| `streak.checkedInToday` | `heatmap.cells[今日].score > 0` | 今日签到判定（无写接口时） |
| `streak.lastCheckinDate` | `heatmap.cells` 末个 `score>0` 的 date | 最近签到日 |
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
  checkIn(session: Session): Promise<CheckinResult>;   // 每日签到：有 /checkin 端点则 POST（≈trae claim），否则降级为读取今日状态
  claim(session: Session, tier?: string): Promise<ClaimResult>; // 领连续签到档位奖励（映射到 redeem）
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

### 4.2 WorkBuddy Provider 1:1 平移序列
```
(0) 打开 www.workbuddy.cn/login?platform=workbuddy&state=...   → 登录页(oneid/SSO)
(*) POST /console/auth/risk-context                            → login_risk_state(风控前置)
(1) 经 oneid/SSO 回跳取得一次性 code                            → AuthCode 等价物
(2) GET  /console/client-login?code=...&target=...             → set-cookie session(≈24h)  ★=ExchangeToken
(3) GET  /v2/plugin/login/gray-decision?feature=oneid_component → enabled(登录组件开关)    ★=CheckLogin
(4) GET  /activity/growth/buddy/info                           → poll_interval_seconds(会话保活) ★=Login/GetUserInfo 合并
(5) GET  /v2/activity/growth/profile                           → 用户档案(UserID/level)      ★=GetUserInfo
(6) [session Cookie 即调用凭据]                                 ★=GetUserToken(无需额外 JWT)
(7) GET  /activity/growth/streak                               → {days, tiers, makeup_cards}  ★=checkin_credits/status
(8) POST /activity/growth/redeem{tier,client_token}            → 领档位奖励                   ★=checkin_credits/claim
    轮询: GET streak/heatmap/energy (每 60s, 来自 poll_interval_seconds)
```

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
- **签到（每日打卡）为核心，且为手动**：用户已确认成长中心有手动「签到」按钮（本次抓包未捕获该次点击，真实端点路径待一次点击抓包确认）。Provider 的 `checkIn()` **主路径为 `POST` 手动签到**，与 Trae `checkin_credits/claim` 1:1；真实路径确认前先以「读取今日状态（heatmap 今日格 score>0）」降级实现，确认后切 POST。面板「签到」按钮常态可点击。
- **档位领奖**：`claim()` 映射到 **`POST /activity/growth/redeem`**（领取连续签到档位奖励），面板文案标注「领奖」而非「签到」。
- **鉴权差异**：WorkBuddy 用 `session` Cookie（≈24h），无 JWT；Trae 用 `Cloud-IDE-JWT`（14d）。`TokenStore` 需分两类实现，但接口一致。
- **风控可裁剪**：Trae 的 `msToken/a_bogus/ttwid` 在 WorkBuddy 侧对应 `x-device-token` + `risk-context`，按需保留。

---

## 5. 改造内容清单（文件 / 模块级）

> 假设展示面板为 TS 项目，已有 `providers/trae/` 作为 1:1 模板。下列为新增 WorkBuddy Provider 的待办。

| 状态 | 路径 / 文件 | 内容 |
|---|---|---|
| ☐ 新增 | `providers/workbuddy/types.ts` | §3.1–3.2 的 `CheckinProviderMeta` / `CheckinSnapshot` / `CheckinProvider` |
| ☐ 新增 | `providers/workbuddy/endpoints.ts` | §2 全部路径常量 + 请求/响应字段类型 |
| ☐ 新增 | `providers/workbuddy/client.ts` | `HttpClient`（复用 trae 骨架，鉴权头改 `cookie`）+ `normalizeEnvelope()` 分支 |
| ☐ 新增 | `providers/workbuddy/session.ts` | `SessionStore`：解析 `session=<id>\|<expiry>\|<hash>`  expiry；失效→触发 `client-login` 重建立 |
| ☐ 新增 | `providers/workbuddy/checkin.ts` | `getStatus()`(streak/heatmap/energy) + `checkIn()`(双模式：/checkin POST 或降级读状态) + `claim(tier)`(redeem) + `poll()` |
| ☐ 待联调 | `后端 /activity/growth/<checkin>`（真实 path 待一次点击抓包确认） | 每日签到打卡端点（工作规格见 §2.2-3），与 Trae `claim` 1:1 对齐；`redeem`（立即领取档位奖励）路径已确认，无需新建 |
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
| 探测 | `POST /activity/growth/checkin`、`/sign`、`/daily/checkin`（仅验证这三个猜测路径） | **HTTP 404**（仅说明猜测路径不对；真实端点不在本次抓包中，待点击抓包确认） |
| 抓包实证（写） | `POST /activity/growth/redeem`（capture 296，请求 `{tier:"7d",client_token}`） | **code:0**（领档成功：`redemption_id:543960, energy_granted:2, cards_granted:1, chances_granted:1, remaining_days:0`）；这是用户「立即领取」点击的真实动作 |
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

### 6.6 结论与风险
- ✅ WorkBuddy checkin 平台核心接口**全部可用**，字段与抓包一致，凭证有效。
- ⚠️ `session` 仅约 24h，Provider 必须实现 `SessionStore` 过期重建立（走 `client-login`），否则每日需重新登录。
- ⚠️ **更正**：用户确认 WorkBuddy 有手动「签到」按钮，故**存在**签到写接口；本抓包未记录该次点击，之前「404 即无端点」的推断错误——404 仅说明三个猜测路径不对。端点真实路径/字段待一次「点击签到」抓包确认（§2.2 待办）。`checkIn()` 主路径为 POST 手动签到，确认前降级为读取状态，确认后切 POST。
- ⚠️ 写接口（`redeem/claim/draw/depart`）中，**`redeem` 已由抓包实证 code:0**（capture 296/299/297），无需再实跑；但 `client_token` 幂等边界（重复提交同一 token）仍建议以**独立测试账号**补一轮验证。
- ⚠️ **端点澄清**：WorkBuddy 成长中心**确有**「立即领取」写接口——`POST /activity/growth/redeem`（已确认，capture 296）。但「每日签到打卡」这一独立点击的真实路径**不在本次抓包中**（抓包仅含 `redeem` 这一条签到类写），需一次点击抓包回填（§2.2-3）。面板「签到」按钮在路径确认前先以读取状态（heatmap 今日格 score>0）实现，确认后无缝切 POST。
- ⚠️ 用户所见「每日100分，已领8天，累计800分」为**前端展示文案**，字面值 `100/800` 不在任何响应体；「已领8天」= `streak.days=8` 已确认，「每日100分/累计800分」为前端常量/计算值，Provider 侧用 `streak.dailyPoints=100` 展示，待 growth-center JS 确证。

---

## 7. 待确认 / 后续
1. 展示面板现有代码仓库路径（本环境仅见抓包数据，未见面板源码）——确认后把 §5 清单落地到实际文件树。
2. `session` 过期后的静默重建是否需要用户重新 SSO，还是支持 refresh 类接口（抓包未见 refresh，需后端确认）。
3. 写接口实测账号与幂等 `client_token` 生成策略。
4. 是否将 Trae 与 WorkBuddy 双 Provider 在面板并列展示（统一 `CheckinProvider` 契约已就绪）。
5. `examples/workbuddy2_解析结果`（桌面客户端 `copilot.tencent.com` 会话，440 条）已分析：**growth 仅 `v2_activity_growth_buddy_info`(GET×2)，无每日签到打卡 POST**，缺失端点仍未覆盖 → 需一次「点击每日签到」抓包回填（§2.2-3）。另发现 growth 接口经 `copilot.tencent.com` 代理可达（buddy_info 即走此），为 Provider 提供 web-`session` 之外的**第二条访问路径**，其鉴权形态（桌面 token vs session cookie）待确认，可能更利于无头调用。
