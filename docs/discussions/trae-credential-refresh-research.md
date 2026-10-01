---
topics: [checkin, trae, credentials, research]
doc_kind: research
created: 2026-10-01
---

# Trae 凭证更新周期调研（15 天 → ？）

> 触发问题：当前 `monitor/lib/providers/trae.js` 的 Trae 凭证（网页 Cookie）实际需要用户
> **每 ~14~15 天重新粘贴一次**。本文调研同类 Trae 签到项目怎么解决这件事，并给出可选方案。
>
> 数据源：① 本仓 `examples/` 抓包（含 `trae_solo_refresh_crack.mjs` / `trae_solo_e2e_probe.mjs` 的既有探测意图）；
> ② 公开项目源码（devilardis / xinshang777 / Shuffle-1992 / NextAgentX / anghunk 等）；
> ③ 本机 `%APPDATA%` 下真实 Trae 客户端的只读实测。

---

## 0. 结论先行

**"15 天"不是我们实现的缺陷，是"用网页 Cookie 当凭证"这条路线的天花板。**
生态里的项目基本都不走这条路——它们**直接读本机 Trae 客户端 `storage.json` 里客户端自己维护的登录态**，
拿客户端正在用的 `token`（≈14 天，**客户端自己会刷新**），于是"客户端在登着就永远不用人工干预"。

⚠️ **一条重要的纠偏（本轮破坏性实测，两次）**：

- 对 `TRAE SOLO CN` 的 refreshToken：`20405 Device proof required` +
  `10101 refresh token is not matched to the client` ⇒ **走不通**。
- 对 `Trae CN` 的 refreshToken：**`HTTP 200 续期成功`**，最小请求体即可，
  且旧 refreshToken 仍可用（幂等窗）⇒ **走通了**。

差别只在 **refreshToken 绑定哪个 ClientID**：`ono9krqynydwx5`（Trae CN / IDE）不需要设备签名，
`en1oxy7wnw8j9n`（Trae SOLO）强制要求。详见 §3.3 / §3.4 / §4。

| 关键数字 | 值 | 来源 |
|---|---|---|
| `X-Cloudide-Session`（我们依赖的会话 Cookie） | **14 天** | 抓包 set-cookie `Expires` |
| 字节 passport `sid_guard` | **60 天** | 抓包 cookie 值 `\|5184000\|` |
| `GetUserToken` 换出的 session JWT | **8 小时** | 抓包 JWT `exp-iat=28800` |
| 客户端 `iCubeAuthInfo.token` | **≈14 天** | 本机 storage.json 实测 |
| 客户端 `iCubeAuthInfo.refreshToken` | **≈166~179 天** | 本机 storage.json 实测 |
| 客户端 device 私钥 | **在本机 storage.json 里，可用** | 本机实测（公钥与抓包一致） |

---

## 1. 本项目现状：15 天是怎么来的

`trae.js` 的链路（`resolveToken()` + `probeSession()`）：

```
用户粘贴整段网页 Cookie
   └─ GetUserToken  ──►  session JWT（8h，剩余 <1h 自动换）
   └─ CheckLogin    ──►  ExpiredAt（会话到期，≈14 天）
   └─ sid_guard 静态解析（≈60 天）
   取较早者 ⇒ cookieExpiresAt ≈ 14 天 ⇒ 到期前 1 天发邮件 ⇒ 用户重贴
```

抓包实证（`examples/2026-08-20-142413_解析结果`）：

- `736_POST .../cloudide/api/v3/trae/Login` 的响应头：
  `set-cookie: X-Cloudide-Session=…; Domain=.trae.cn; HttpOnly; Secure; SameSite=Lax; Expires=Thu, 03 Sep 2026 06:23:47 GMT`
  —— 抓包时间 2026-08-20，**恰好 +14 天**。（`2026-08-15` 那次同样：`Expires=Sat, 29 Aug 2026 07:25:37 GMT`）
- 同一抓包里 `CheckLogin` 的 `ExpiredAt=1788411619945` → 2026-09-03，也 ≈ +14 天。
- `_runtime_cookies_trae.txt` 里 `sid_guard=c441…|1787201646|5184000|Mon, 19-Oct-2026 04:54:06 GMT` → **60 天**。
- `GetUserToken` 换出的 JWT：`iat=1787206983 / exp=1787235783` → **8 小时**。
- `ExchangeToken`（`766_`）响应：`TokenExpireDuration=1209600000`（**14 天**）、
  `RefreshExpireAt - TokenExpireAt = 14342400000 ms`（**≈166 天**）。

**关键发现：网页端不会续 `X-Cloudide-Session`。**
`examples/update_token_解析结果`（浏览器打开 `www.trae.cn/dashboard` 的完整流程）里
调了 `CheckLogin` / `GetUserInfo` / `GetUserToken`，但**一次 `Login` 都没调，全程没有任何
`set-cookie: X-Cloudide-Session`**。真正下发/轮换该 Cookie 的只有 IDE 客户端的
`POST /cloudide/api/v3/trae/Login`（该请求还强制带 `msToken` + `a_bogus` 风控签名，
响应头回吐 `x-ms-token` 供链式使用）。

⇒ 也就是说：**只要你打开一次 Trae 客户端，它就替自己续了一个新的 14 天会话；而我们的服务拿的是
一段静态 Cookie 字符串，永远不会被续。** 这才是 15 天周期的根因。

---

## 2. 生态里各项目怎么做

| 项目 | 形态 | 凭证来源 | 续期机制 | 有效周期 |
|---|---|---|---|---|
| [devilardis/auto-checkin](https://github.com/devilardis/auto-checkin) | Python/FastAPI，Web 控制台 + Docker | **client 模式**：读本机 `storage.json`（tc 解密）取 `token`/`refreshToken`/`device_id`/`machine_id`/`ide_version`；**web 模式**：粘贴 Cookie + `curl_cffi` | client 模式：token 剩 <30 min 时用 `refreshToken` 打 `ExchangeToken`；web 模式：`GetUserToken` 换 8h JWT | client：**"基本免维护"**；web："Cookie 失效后重新粘贴一次" |
| [xinshang777/auto-checkin](https://github.com/xinshang777/auto-checkin) | Node，Windows 计划任务 4 次/天 | 三级来源取 `exp` 最大者：`manual(config)` > **本机 `storage.json`**（tc 解密）> `trae-token.json`（Playwright 从 `localStorage['Cloud-IDE-Token']` 一次性抓取） | 客户端自己续 token，脚本每次现取 | 引用其 README：token **≈13.8 天** |
| [Shuffle-1992/TraeSign](https://github.com/Shuffle-1992/TraeSign) | C# WinForms 托盘单 exe | 读 `Trae CN` / `TRAE SOLO CN` / `TraeWork` 的 `storage.json` + tc 解密；**故意不读客户端的 refreshToken** | 只用**自有** token 库（自己走 OAuth 授权拿到的 refreshToken），DPAPI 落盘 | 自持 refreshToken，滚动轮换即回写 |
| [NextAgentX/trae-workbuddy-switch](https://github.com/NextAgentX/trae-workbuddy-switch) | Tauri/Rust 桌面 App | 同样 tc 解密；文档给出 `iCubeAuthInfo://icube-dc:<id>` = **设备私钥/公钥 PEM** | 快照式切换 + 客户端自身续期 | — |
| [anghunk/trae-proxy](https://github.com/anghunk/trae-proxy)（MIT）及 [weixiaokuan123](https://github.com/weixiaokuan123/trae-proxy) / [dingminhua](https://github.com/dingminhua/dsh-connect-trae) 分支 | TypeScript 代理 | 读 `storage.json`（`src/decrypt.ts`） | `src/refresh.ts`：**`{ClientID, ClientSecret:"-", RefreshToken, UserID}`，不带 DeviceInfo / DeviceProof** | refreshToken 166 天 |

**共同点**：四个"签到"项目里三个走"读本机客户端"，只有 `devilardis` 同时提供"粘贴 Cookie"作为
降级模式，而它的 README 也明说 Cookie 模式**需要人工重贴**。

**没有任何项目**做到"定期无人值守地驱动浏览器重登 www.trae.cn"——`devilardis` 的
`checkin/traeweb.py` 记录了原因：

> www.trae.cn 存在字节系 WAF 挑战，必须用 curl_cffi 模拟浏览器 TLS 指纹，且 Cookie 需为
> 浏览器中复制的完整 Cookie（包含 ttwid / s_web_id 等防护 Cookie）

---

## 3. 关键机制拆解

### 3.1 `tc` 信封解密（公开算法，硬编码盐）

客户端把登录态加密存在 VS Code 风格的 `globalStorage`：

```
%APPDATA%\<AppName>\User\globalStorage\storage.json
AppName ∈ { Trae CN, Trae, TRAE SOLO CN, TRAE SOLO }
macOS: ~/Library/Application Support/<AppName>/User/globalStorage/storage.json
```

| 键 | 内容 |
|---|---|
| `iCubeAuthInfo://icube.cloudide` | **登录态本体**（加密） |
| `iCubeAuthInfo://icube-dc:<数字>` | **aha 设备 ID** → `x-device-id`；同键内含设备 `privateKeyPEM`/`publicKeyPEM` |
| `telemetry.machineId` / `telemetry.devDeviceId` | → `x-machine-id` |
| `iCubeLastVersion` | → `app-version` |

密文格式：`[6B header: 74 63 05 10 00 00][32B random][AES-128-CBC ciphertext]`，
密钥/IV = `SHA512( SHA512(random) ‖ (SALT_A XOR SALT_B) )` 的 `[0:16]` / `[16:32]`，
明文 = `[64B SHA-512 校验][JSON]`。盐值在公开仓库里硬编码（另有 `AES_PRIVATE` 变体用 `SALT_C XOR SALT_D`）。
**国际版可能是明文 JSON**（`str(enc).strip().startswith("{")`）。

解密后字段：`token`（裸 JWT，无 `Cloud-IDE-JWT ` 前缀）、`refreshToken`、`expiredAt`、
`refreshExpiredAt`、`tokenReleaseAt`、`userId`、`host`、`userRegion`、`account{username,email,…}`。

### 3.2 本机实测（2026-10-01，只读、只打印字段名与长度）

在本机跑 `tc` 解密探针（见 §5 备注），结果：

```
=== Trae CN        storage.json mtime 2026-09-29
  iCubeAuthInfo://icube.cloudide: type=AES hashOK=true b64len=2484
      token: string(1004)      refreshToken: string(61)
      expiredAt        -> 2026-09-14  (已过期 17 天)
      refreshExpiredAt -> 2027-02-27  (剩 149 天)
  iCubeAuthInfo://icube-dc:3798161405005257: keys=privateKeyPEM,publicKeyPEM
=== TRAE SOLO CN   storage.json mtime 2026-10-01
      expiredAt        -> 2026-10-14  (剩 13.4 天)
      refreshExpiredAt -> 2027-03-29  (剩 179 天)
      iCubeAuthInfo://icube-dc:3798161405005257: keys=privateKeyPEM,publicKeyPEM
```

两个细节值得记：

- `3798161405005257` **正是**本仓 `examples/_analysis_trae.md` 里抓到的 `x-device-id` 值
  ⇒ 那份抓包就来自这台机器，也确认了「aha 设备 ID = `iCubeAuthInfo://icube-dc:<数字>` 的后缀」。
- `Trae CN` 那条 token 已过期 17 天**且没有被续** ⇒ 客户端的自动续期**只在客户端真的在运行时发生**，
  不是"放着自己会好"。

### 3.3 设备绑定 vs DeviceProof（容易踩的两个坑）

- **`DeviceProof` 是硬门槛，且 refreshToken 与 ClientID 强绑定（本轮已实测，含破坏性测试）。**

  分两步测出来的，结论完全相反于"看社区代码得出的直觉"：

  **第一步（非破坏性，`examples/trae_exchange_preflight_probe.mjs`）**：用**故意无效**的
  refreshToken 跑 7 种请求形态（CN 与 SOLO 两条路径 × 最小体/带 DeviceInfo/带无效 DeviceProof/
  缺 `x-cloudide-token` 头）——**7 种全部 `HTTP 401 code=20101 "refresh token is invalid"`**。
  这只能说明服务端**先验 refreshToken、后谈设备**，**不能**说明 DeviceProof 可选。

  **第二步（破坏性，`examples/trae_exchange_refresh_probe.mjs`，2026-10-01 经用户明确同意）**：
  用 `TRAE SOLO CN` 客户端那份**真实有效**的 refreshToken：

  | 尝试 | 结果 |
  |---|---|
  | SOLO 官方形态（`en1oxy7wnw8j9n` + DeviceInfo，**无 DeviceProof**） | `HTTP 401 code=20405 "Device proof required."` |
  | 降级：devilardis/anghunk 的 CN 最小体（`ono9krqynydwx5`，无 DeviceInfo） | `HTTP 400 code=10101 "无效参数"` / `__Message.error: refresh token is not matched to the client` |

  ⇒ 硬结论：**refreshToken 与 ClientID 强绑定**——客户端那份属于 `en1oxy7wnw8j9n`，
  拿去配 `ono9krqynydwx5` 直接被拒（`10101`）；用回它自己的 `en1oxy7wnw8j9n` 则要 `DeviceProof`（`20405`）。

  ✅ **两次尝试都失败，所以 refreshToken 没有被轮换**——备份时与测试后指纹一致
  （`0e1b50351b6d`），`status` 仍 `code=0 checked_in=true`，客户端毫发无损。

  | 尝试（brand=`TRAE SOLO CN`, 账号 `用户3370882502`） | 结果 |
  |---|---|
  | SOLO 官方形态（`en1oxy7wnw8j9n` + DeviceInfo，无 DeviceProof） | `20405 "Device proof required."` |
  | SOLO **最小体**（`en1oxy7wnw8j9n`，**不带 DeviceInfo**） | `20403 "Token device not match."` |
  | CN 最小体（`ono9krqynydwx5`） | `10101 refresh token is not matched to the client` |
  | CN + DeviceInfo（`ono9krqynydwx5`） | `10101` 同上 |

  ⇒ SOLO 那条路**焊死**：声明设备要证明（`20405`），不声明设备又对不上（`20403`）。
  "不带 DeviceInfo 就能绕过签名"的猜想**已被实测排除**。

  **第三步续测（同样是破坏性，用在 `Trae CN` 上）—— 结论大反转：**

  | 尝试（brand=`Trae CN`, 账号 `lehuan`） | 结果 |
  |---|---|
  | **CN 最小体（`ono9krqynydwx5`，无 DeviceInfo / 无 DeviceProof）** | **`HTTP 200 ✅ 续期成功`** |

  ⇒ **`DeviceProof` 不是普遍要求，而是按 ClientID 而异**：
  - `en1oxy7wnw8j9n`（Trae SOLO 系客户端）→ 续期**强制** `DeviceProof`
  - `ono9krqynydwx5`（Trae CN / IDE 插件系客户端）→ 续期**不需要**任何设备签名，最小体即可

  ★ 这也解释了社区项目为什么"不带签名就能续期"：**它们的 refreshToken 绑的就是 `ono9krqynydwx5`。**
  之前"用别人的 ClientID 走不通"的结论要修正为：**走不通的是"拿 SOLO 的 token 配 CN 的 clientId"，
  而"拿 CN 的 token 配 CN 的 clientId"完全走得通。**

- **我们其实握着那把设备私钥。** `iCubeAuthInfo://icube-dc:<id>` 解出来是
  `{privateKeyPEM, publicKeyPEM}`；本机实测其 **`publicKeyPEM` 与抓包
  `traesolo自动刷新_解析结果/023` 请求体里的 `DevicePublicKey` 逐字一致**。
  ⇒ 抓包来自本机、签名私钥就在本机（PKCS#8，241 字符）。
  也就是说 `DeviceProof` **在密钥层面是可造的**，唯一缺的是**签名原文的构造方式**——
  社区无任何公开描述，`NextAgentX` 也明确说"自造设备标识必被 20403/20405 拒"。
- **`x-device-id` 必须用客户端的 aha ID。** `xinshang777` 的源码注释（2026-09-28 实测）：

  > claim 接口会校验 `x-device-id` 必须与 token 绑定的 aha 设备 ID 一致；若误用
  > `telemetry.devDeviceId`（另一个 UUID），服务端会返回 **9074「当前参与用户太多，请稍后再试」**
  > ——看起来像限流，实为设备不匹配。

  ⚠️ 这直接命中我们 `trae.js` 的 `classify()`：我们把 `9074 / 操作太过频繁` 归类为 `throttle` 并退避，
  **但如果根因是设备标识不匹配，退避永远不会成功**。
  注意区分：**线上部署配了账号级 `deviceId` 或部署级 `device_identity.json` 时用的是真实值**，
  派生只是没配任何东西时的兜底（`checkin.js` 的注释也记录了"派生值被上游拒"确实发生过）。
- 官方论坛确认账号级设备限制：*"单个账号最多同时在 2 台设备登录使用，频繁多设备登录会触发风控限制"*。

#### 3.3.2 客户端自己的续期请求（从 `Trae CN` 日志里挖到的原文）

`%APPDATA%\Trae CN\logs\<ts>\main.log` 里直接打印了客户端自己发起的续期请求：

```
[exchangeTokenByRefreshToken] request https://api.trae.cn/trae/api/v3/oauth/ExchangeToken
{"ClientID":"ono9krqynydwx5","ClientSecret":"","RefreshToken":"******",
 "DeviceInfo":{"DeviceID":"3798161405005257",
               "MachineID":"0ec2815d…b51",
               "PlatformCode":"IDE_PC",          ← 注意是 IDE_PC（SOLO 是 SOLO_PC）
               "DeviceType":"PC","DeviceName":"乐幻的电脑","DeviceModel":"82JW",
               "ClientVersion":"3.3.96",         ← CN 客户端版本是 3.3.x（不是 0.1.x）
               "DevicePublicKey":"-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMX4N/0Xd7Nvb…",
               "DeviceBrand":"LENOVO","DeviceCPU":"AMD Ryzen 5 5600H with Radeon Graphics",
               "OSInfo":"windows","OSVersion":"Windows 11 Pro"},
 "DeviceProof":{"Signature":"MEUCIQD6jTUC…","Timestamp":1790697409,"Nonce":"dccc9a4c…"},
 "IDEVersion":"3.3.96"}
[exchangeToken] response success … Result { "BoundDeviceID":"9r71j5vpdwwkqj",
  "ClientID":"ono9krqynydwx5", "DeviceBindStatus":"BOUND",
  "RefreshExpireAt":1805791408823, "TokenExpireDuration":751599437, … }
```

四条重要信息：

1. **客户端确实会带 `DeviceProof`**——但我们**不带**它也一样 `200`。
   ⇒ 结合 §3.3 的结论：`DeviceProof` 对 `ono9krqynydwx5` 是**可选**的（客户端只是习惯性都带），
   对 `en1oxy7wnw8j9n` 才**强制**。
2. **客户端用的也是 `ClientID: ono9krqynydwx5`** —— 与我们的配方完全一致（互相印证）。
   `ClientSecret` 是**空串**（我们用 `"-"` 也能过 ⇒ 该字段服务端不校验）。
3. 路径上客户端走 `/trae/api/v3/oauth/ExchangeToken`，我们走
   `/cloudide/api/v3/trae/oauth/ExchangeToken` —— **两条路径都接受 `ono9krqynydwx5`**。
4. ★ 响应里有个 **`BoundDeviceID: "9r71j5vpdwwkqj"`**（12 字符），
   **与 `DeviceID`（aha 数字 ID）是两个不同的东西**。
   平台那句 `该设备绑定的账户数量已达上限` 里的"设备"，很可能指的是**这个 `BoundDeviceID`**。

另外 `%APPDATA%\<brand>\ModularData\ckg_server\local_env.json` 也留了痕迹：

```json
// Trae CN      → 2 个账号
{"device_id":"3798161405005257","host_map":{"1000985253380538":"…","1910319278719667":"…","default":"…"}}
// TRAE SOLO CN → 1 个账号
{"device_id":"3798161405005257","host_map":{"1910319278719667":"…","default":""}}
```

`device_id` 两客户端相同（印证 §3.3.1），而 `host_map` 里登记的账号数
恰好在 `Trae CN` 上是 **2** —— 与"一台设备 2 个账号"的说法吻合。

#### 3.3.1 `Trae CN` 与 `TRAE SOLO CN` 的设备标识是否一致？—— 一半一致

逐字节对比两个客户端（2026-10-01）：

| 字段 | `Trae CN` | `TRAE SOLO CN` | 是否一致 |
|---|---|---|---|
| `iCubeAuthInfo://icube-dc:<id>` 键名 | `…:3798161405005257` | `…:3798161405005257` | ✅ **一致** |
| aha 设备 ID（→ `x-device-id`） | `3798161405005257` | `3798161405005257` | ✅ **一致** |
| `telemetry.machineId` | `0ec2815d…b51` | `0ec2815d…b51` | ✅ 一致 |
| `telemetry.devDeviceId` | `33489686-e229-…` | `33489686-e229-…` | ✅ 一致 |
| `telemetry.sqmId` | `{1BA25A1E-…}` | `{1BA25A1E-…}` | ✅ 一致 |
| **设备公钥** | sha `354de594…` | sha `7bf5a341…` | ❌ **不同** |
| **设备私钥** | sha `d34acee3…` | sha `9f56dbfb…` | ❌ **不同** |

⇒ **`deviceId` 是"机器级"的（两客户端共享），设备密钥对是"客户端级"的（各自一对）。**

三条实用推论：

1. **`x-device-id` 可以做成部署级配置**：同一台 Windows 上导出的所有账号共用同一个 aha ID
   （本机就是 `3798161405005257`），不需要每个账号填一遍。
2. **但导出时仍应把 `deviceId` 一起带出来**，不要假设它恒等于本机值——如果账号是在**另一台机器**上
   登录 `Trae CN` 的，那台机器的 aha ID 不同。
3. 抓包 `023` 的 `DevicePublicKey` 与 **SOLO** 那把一致（不是 CN 的），
   证明那份"自动刷新"抓包确实来自 `TRAE SOLO CN` 客户端——与它用
   `/trae/api/v3/oauth/ExchangeToken` + `en1oxy7wnw8j9n` 相印证。
   密钥对只在 DeviceProof 上有用，**对方案 B 无影响**（我们不签名）。

### 3.4 refreshToken 的轮换：实测是「**单 head 线性链 + 一代宽限**」

社区警告旧值会立刻作废（`TraeSign` 因此**拒绝读取**客户端的 refreshToken：
*"滚动轮换会让客户端持有的旧 token 失效导致其掉线"*）。

本机完整追踪了两条链，并用不同账号交叉验证，得到**三条准确规则**：

**链 A（`lehuan` / 1000985253380538）：**

```
gen0  220f383701b2   ← 客户端原始（~08-31）
gen1  f76d307d8acb   ← 我 06:36 用 gen0(=head) 续期 → 推进
gen2  6bf08ebca0a5   ← 用户 06:52 在客户端重新登录 → 推进
gen3  5ac2465551c0   ← 用户 06:58 又一次登出/登录 → 推进
```

**链 B（`用户3370882502` / 1910319278719667，由 `Trae CN` 客户端 07:02 登录产生）：**

```
gen0  067ce9cf3f6b   ← 客户端 07:02 登录
gen1  256d51a411ce   ← 我 07:05 用 gen0(=head) 续期 → 推进
```

**实测汇总：**

| 时刻 | 账号 | 传入的 token | 是否 head | 结果 |
|---|---|---|---|---|
| 06:36 | A | gen0 | ✅ head | `200`，**推进**出 gen1 |
| 06:53 | A | gen1 | ❌ head−1 | `200`，**返回 head=gen2，未推进** |
| ~07:00 | A | gen1 | ❌ head−2 | `401 ⛔ 20101 refresh token is invalid` |
| ~07:00 | A | gen2 | ❌ head−1 | `200`，**返回 head=gen3，未推进** |
| 07:05 | B | gen0 | ✅ head | `200`，**推进**出 gen1 |
| 07:05 | B | gen0 | ❌ head−1 | `200`，**返回 head=gen1，未推进** |
| 07:05 | A | gen3 | ✅ head | `200`，**推进**（客户端已换走，链仍活着） |

⇒ **规则（三条，都被实测钉住）：**

1. **服务端对每个 (用户, 客户端) 只保留一个 head**。
2. **传入 head ⇒ 服务端轮换它，推进一代**（与 access 是否临期无关：07:05 那次传入的
   access 是 3 分钟前刚签发的，照样轮换）。
3. **传入 head−1 ⇒ 只把当前 head 原样返回，不推进**；**传入 head−2 或更早 ⇒ `20101`**。

**第三次验证（2026-10-01 16:44，距首轮 ~9.5 小时后，且期间发生过换账号）—— 规则完全自洽：**

| 账号 | 我们持有的 | 状态 | 结果 |
|---|---|---|---|
| `191******75`（当日下午被换出 `Trae CN`） | `b7fb7fa88935`（07:09 的 head） | 仍可用 | `200 ✅` → 换出 `89b36f6296f5`，access 新 14 天 |
| `191******75` | `067ce9cf3f6b`（客户端 07:02 原始，两代前） | 已失效 | `401 ⛔ 20101` |
| `lehuan`（16:43 被重新登回 `Trae CN`） | `7839b3519810`（07:05，此时是 head−1） | 仍可用 | `200 ✅` → **返回 `15a50d2fa6b5`** |

★ `lehuan` 那条尤其漂亮：我们 07:05 存的 `7839b3519810` 换出来的
`15a50d2fa6b5`，**与客户端 16:43 重新登录后写进 `storage.json` 的那份逐字相同**，
access 到期时刻也一致（`2026-10-15T16:43:54`）——**双方在 9.5 小时后自动收敛到同一个 head**，
一秒都没差。

**⇒ 三条被反复验证的运营结论：**

1. **把账号换出客户端 / 登出，不会吊销我们持有的凭据**（`191` 和 `lehuan` 各验证一次）。
   ⇒ **一台设备顺序登录多个账号是可行的**：登录 A → 导出 → 换 B → 导出 …… A 的凭据不受影响。
   **只有"登录环节被平台设备上限挡住"时，才需要 VM。**
2. 我们只要**每次续期成功后落盘新值**，就永远贴着 head，客户端怎么换账号都不干扰我们。
3. 唯一会真失效的情形是**链连推两代而我们没跟上**（例如客户端反复重登 + 我们长期不续期）→ `20101`。

⚠️ 顺带记一条：续期返回的 `TokenExpireDuration` **不稳定**——
06:36 那次只有 `612445366`（7.1 天），16:44 这次是 ~14 天。
⇒ 实现时**不要假设 14 天**，一律以返回的 `TokenExpireAt` 为准，并用宽松阈值（<1 天）触发续期。

**这直接决定了两件事，而且我早先给过一条错建议、必须更正：**

- ✅ **客户端不会被我们锁在门外**：客户端手里那份最多退到 head−1，仍可用，
  而且它一续期就会拿到与我们相同的 head（**双方自然收敛**）。07:05 实测：
  拿客户端那份 head−1 续期 → `200`，返回的正是我们手里的 head `256d51a411ce`，
  access 到期时刻也完全一致。
- ❌ **我先前说的"每次签到都续一次"是错的、而且有害**：因为**传入 head 必推进**，
  如果我们每天续，两天就会把客户端那份推到 head−2 ⇒ **客户端被登出**。
  **正确做法：只在 access 临近过期时续（≈13~14 天一次）**，这样客户端有约 28 天
  的余量去自然续一次，双方始终在同一代内。
- ❌ 另一条更正：我用"旧值永远能换出 head"描述过它，**不对**——06:58 那次登出之后
  gen1 就死了。准确说法是**只宽限一代**。

仍要遵守的两条纪律：

- **必须持久化轮换后的新 `refreshToken`**（每次成功续期都会换新）。`devilardis` 只取 `Token`
  不回写——靠宽限期能撑一次，第二次就会 `20101`（潜在缺陷，不要照抄）。
- **绝不要写客户端的 `storage.json`。** `NextAgentX` 有一次真实事故记录：注入"部分登录态"后
  客户端判定登录态无效并**删除 `iCubeServerData`**，两个客户端双双变成未登录，且
  `account` 富对象与两个时间戳字段**不可恢复**。

---

### 3.5 本轮实测：读本机客户端 token 这条路**跑得通**（2026-10-01）

脚本 `examples/trae_client_token_probe.mjs`（只读：只调 `status` 与 `user_current_entitlement_list`）。

**① 解密成功、字段与公开文档一致**

| 客户端 | account | token exp | refresh exp | ahaDeviceId | ideVersion |
|---|---|---|---|---|---|
| `Trae CN` | lehuan | 2026-09-14（**已过期 17 天**） | 2027-02-27（剩 149 天） | 3798161405005257 | 2.3.79946 |
| `TRAE SOLO CN` | 用户3370882502 | 2026-10-14（剩 13.4 天） | 2027-03-29（剩 179 天） | 3798161405005257 | 2.3.87413 |

**② 拿客户端 token 打真实接口 —— 有效 token 直接通过**

```
===== TRAE SOLO CN  token 仍然有效 =====
-- profile: ours          (x-device-id=3798161405005257…)
  status           HTTP 200  ✅ code=0 checked_in=true credits=100 enable=true
  entitlements     HTTP 200  ✅ 权益包 33 个
-- profile: devilardis    → 同上
-- profile: wrong-device-id (用 telemetry.devDeviceId) → 同上
```

**③ 过期 token 的行为 —— 注意返回码形状**

```
===== Trae CN  token 已过期 =====
  status        HTTP 200  ⛔ code=1001 "We're sorry, but we are not able to authenticate you…"
  entitlements  HTTP 401  ⛔ code=1001 同上
```

**④ 三个结论**

1. **同类项目的"读本机客户端"路线完全可行** —— 解密 + 直接当 `Cloud-IDE-JWT` 用，一次就通。
2. **只读接口不校验设备标识**：三套请求头（本仓 provider / devilardis / 故意用错 `x-device-id`）
   返回**完全一致**。⇒ `x-device-id` 的校验确实发生在 `claim`（0 元下单）那一步，
   与 `checkin.js` 里的注释一致。**用错 deviceId 在只读接口上测不出来**。
3. ⚠️ **本仓 `classify()` 有一个真实缺口**：过期 token 在 `status` 上表现为
   **HTTP 200 + `code:1001` + "we are not able to authenticate you"**，
   而 `trae.js` 的失效正则 `/cookie|token|凭证|未授权|登录|过期|会话|invalid|expired|unauthorized|sign.?in/i`
   **匹配不到 "authenticate"** ⇒ 会被误判成 `transient` 而去重试。
   （当前主路径先走 `GetUserToken`，Cookie 死了那里就会报"凭证"命中；但 legacy 的
   "只配 token 不配 Cookie" 模式会踩到。）

---

### 3.6 端点矩阵：续期换出的 accessToken 能打通 provider 用到的**每一个**接口

脚本 `examples/trae_token_endpoint_matrix.mjs`（两个账号各跑一遍，2026-10-01）：

| 接口 | 用途（对应 `checkin.js`） | `173******16` | `191******75` |
|---|---|---|---|
| `POST /trae/api/v2/ug/checkin_credits/status` | 签到状态 / 积分 / 凭证探测 | ✅ `code=0` | ✅ `code=0` |
| `POST /trae/api/v2/pay/user_current_entitlement_list` | 总积分 / 权益包 | ✅ 200 | ✅ 200 |
| `POST /trae/api/v1/pay/query_user_usage_group_by_session` | 用量明细（`getUsage`） | ✅ 200 | ✅ 200 |
| `POST /trae/api/v2/ug/checkin_credits/claim` | **执行签到** | ✅ `{"code":0,"message":"success"}` | ✅ 同左 |
| `POST /cloudide/api/v3/common/GetUserToken` | Cookie 换 JWT | — Cookie 鉴权，accessToken 不适用 | |
| `POST /cloudide/api/v3/trae/CheckLogin` | Cookie 会话探测 | — 同上 | |

- **`claim` 真的通过了**——这是核心动作，说明鉴权与设备校验都过了。
  复查 `status`：`credits=100`、`extra_credits=100` **未变化**（当日已签，未重复发放）。
- `usage_by_session` 的 `usage_type` 是**数组**（抓包 068 实测 `[7]`）；传数字会 `HTTP 400` 空体。
  本仓 `trae.js` 的 `getUsage(task, params)` 是**透传** params 的，调用方需自己给对形状。

**一个顺带的设备头结论**：这次 `claim` 用的头是
`x-device-id = 3798161405005257`（**真实 aha ID**）+ `vscode-sessionid = '0'×64`（**假**）
+ `x-market-user-id = 00000000-…`（**假**）+ `app-version = 0.1.51`。**claim 照样通过。**
⇒ 说明上游在 claim 上真正校验的是 **`x-device-id`（aha ID）**；
`vscode-sessionid` / `x-market-user-id` 填什么都不影响。

**⚠️ 更正（2026-10-01 晚，经作者指出）**：我在本节先前写过"本仓 provider 现在恰恰是
*派生* `x-device-id`，这就是 `9074` 的根因"——**这句话是错的**。
`checkin.js` 的 `deriveDevice()` 只是**最后兜底**，真实优先级是：

```
账号 config.deviceId  >  ~/.monitor_data/device_identity.json（部署级真实标识）  >  按 taskId 派生兜底
```

也就是说**线上部署只要配了部署文件或账号级 deviceId，用的就是真实值**，
派生分支只是"没配任何东西"时的保守兜底（且 README 明确写了覆盖方式）。
`deriveDevice()` 的注释本身也写明了"自造的假设备标识会被上游拒（9004 / 操作太过频繁）"。

⇒ 结论修正为：**方案 B 不需要"修 bug"**。
导入串里带上真实 aha ID 的价值只是**便利性**——新增账号时不必再单独去配部署级文件，
让 `导入串` 自动落到该账号的 `config.deviceId` 即可。

---

## 4. 可选方案（已按本轮实测重新排序）

### 方案 A —— 新增"本机客户端 token 源"（**通用，任何账号都能用**）

每次签到前读 `storage.json` → tc 解密 → 取 `token`（剩 <1h 就跳过/告警）；
`x-device-id` / `x-machine-id` 一并从同一文件取。**只读，不碰 refreshToken，不写任何东西。**

- ✅ **本轮实测已打通**：解出的 token 直接当 `Cloud-IDE-JWT` 用，`status` `code=0`、
  `entitlements` 33 个包
- ✅ 不消费 refreshToken ⇒ **零轮换风险、零写入**，客户端完全不受影响
- ✅ 客户端的自动续期就是我们的续期 ⇒ 无人值守（`xinshang777` 就是这么做的："token 每次运行时现取"）
- ❌ 与部署形态冲突：当前签到跑在手机 Termux（见 `memory/2026-09-18.md`），
  **读不到 Windows 的文件**。二选一：
  ① 把 Trae 签到挪到 Windows 侧（网关/模块同源）；
  ② Windows 侧挂一个极小的"取 token 并上报"agent，定时把 token 推到手机上
     （本质还是方案 A，只是多一跳；这条能让手机侧完全无感）

### 方案 B —— 一次性导入 refreshToken，服务端自续（**本轮已实测打通**，限 Trae CN 系账号）

**已验证的配方**（2026-10-01，`Trae CN` / `lehuan`）：

```
POST https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken
body: { "ClientID": "ono9krqynydwx5", "ClientSecret": "-",
        "RefreshToken": "<客户端 storage.json 里那份>", "UserID": "<userId>" }
→ 200 Result { Token, RefreshToken, TokenExpireAt, RefreshExpireAt, DeviceBindStatus:"BOUND" }
```

- ✅ **不需要 `DeviceInfo`，不需要 `DeviceProof`**
- ✅ 新 token 打 `status` → `code=0 checked_in=true credits=100`
- ✅ **旧 refreshToken 仍可用（宽限一代）** ⇒ 客户端偶尔登出/重登不会把我们锁在门外
- ✅ **客户端也不会被我们锁在门外**：我们续期只会把它那份推到 head−1，它一续期就收敛回同一 head
- ✅ **零外部输入**：`refreshToken` / `userId` / `deviceId` / `machineId` 全部来自本机
  `%APPDATA%\Trae CN\User\globalStorage\storage.json`
- ⚠️ **续期节奏必须"懒"，只在 access 临期时续（≈13~14 天一次），绝不能每次签到都续**。
  因为传入 head 必定推进一代；若我们每天续，两天就会把客户端推到 head−2 ⇒ **客户端被登出**。
- ⚠️ 我们的凭据若被连续推进两代没跟上 ⇒ `20101`，需从客户端重新导出。

⚠️ **适用范围有个硬边界**：

| 客户端 | ClientID | 续期是否需要 DeviceProof | 方案 B |
|---|---|---|---|
| `Trae CN`（IDE） | `ono9krqynydwx5` | ❌ 不需要 | ✅ **可用** |
| `TRAE SOLO CN` | `en1oxy7wnw8j9n` | ✅ 必须 → `20405` | ❌ **不可用** |

⇒ **签到账号挂在哪个客户端里决定了能不能用方案 B。** 挂在 SOLO 里的账号只能走方案 A。

**新增账号最少只要一个值（实测，`examples/trae_refresh_with.mjs --minimal`）：**

```
只给 refreshToken：请求体不带 UserID、x-cloudide-token 传空串、无 DeviceInfo / 无 DeviceProof
→ HTTP 200 ✅ 续期成功
```

| 新增账号要填的 | 必填 | 来源 / 说明 |
|---|---|---|
| `refreshToken` | ✅ **唯一必填** | `Trae CN` 客户端 `storage.json` → `iCubeAuthInfo://icube.cloudide` 解密后的 `.refreshToken`（61 字符） |
| `userId` | ❌ 不用填 | 可从续期返回的 access JWT `data.id` **自动学到**（已验证一致，`decodeJwtClaims` 直接取） |
| `deviceId`（aha） | ⭕ 部署级配置一次 | claim 的 `x-device-id`；**同一台机器上所有账号共用同一个值**（本机 `3798161405005257`，取自 `iCubeAuthInfo://icube-dc:<数字>` 键名后缀）→ 放 `~/.monitor_data/device_identity.json`，不必每账号填 |
| `clientId` | 自动 | 固定 `ono9krqynydwx5` |
| `host` | 自动 / 下拉 | `https://api.trae.cn` |
| `app-version` | 自动 | `0.1.51` 实测可用，无需跟随客户端版本 |
| 签到时间 / 时区 / 失败阈值 / 通知开关 | 照旧 | 现有 `configSchema` 字段不变 |

⚠️ **唯一前提**：那份 refreshToken 必须来自 **`Trae CN`** 客户端的登录
（即 `ono9krqynydwx5` 授权）。来自 `TRAE SOLO CN` 的会被 `20405 Device proof required` 挡。
一个账号只要在 `Trae CN` 里登录过一次，就永久满足这个前提（实测：账号被换出客户端后凭据仍可用）。

- 观测到的 `TokenExpireDuration` 只有 **7.1 天**（不是 14 天），所以续期要"提前量给足"，
  建议 token 剩余 <2 天就续，并**每次都持久化轮换后的新 refreshToken**。
- 仍不建议自建 OAuth（`TraeSign`/`anghunk` 那条路）——除非有账号只存在于 SOLO 客户端里，
  而那又绕不开 `DeviceProof`。

### 方案 C —— 维持现状，只做体验改善

保留 Cookie 模式，把"14 天"讲清楚、提前量调大、修 `classify()` 的 `code=1001` 缺口。成本最低，问题不解决。

### 方案 D —— 不推荐

- **自动调 `Login` 续 `X-Cloudide-Session`**：需要 `msToken` + `a_bogus` 风控签名，
  生态里**没有任何公开实现**，可行性未知（这是唯一能把 Cookie 路线也变成无人值守的路，但风险高）。
- **Playwright 定期重登**：`www.trae.cn` 有 WAF + `ttwid`/`s_web_id` 挑战，
  没有任何项目做到过。
- **硬刚 `DeviceProof`**：私钥在本机（已确认与抓包公钥一致），但签名原文无公开资料，
  且**即使攻破也会轮换掉客户端那份 refreshToken**（见 §3.4）——收益与代价倒挂。

---

## 5. 备注 / 未验证项

- 本轮留下三个探针（前两个只读/非破坏性，第三个是**破坏性**的，需显式加 flag）：
  - `examples/trae_client_token_probe.mjs` —— 解本机 `storage.json` + 打 `status`/
    `user_current_entitlement_list`（只读接口），对比三套请求头。不打印任何 token 值。
  - `examples/trae_exchange_preflight_probe.mjs` —— 用**故意无效**的 refreshToken 探
    `ExchangeToken` 的校验顺序（因此不可能轮换真实凭证）。
  - `examples/trae_exchange_refresh_probe.mjs` —— **破坏性**：真实 refreshToken 续期实测，
    必须带 `--i-know-its-destructive`。会自动备份原凭据到 `%TEMP%\trae-creds-backup.json`。
- **未验证**：`X-Cloudide-Session` 是否存在"使用中滑动续期"。抓包里没有观察到任何
  `set-cookie: X-Cloudide-Session` 出现在非 `Login` 响应上，社区也没有独立佐证。
- **负结果：`DeviceProof` 签名原文爆破失败（已尝试，可复现）**。
  素材齐全：本机持有私钥，且抓包 `023` 提供了与之一致的公钥 + 一组真实
  `{Signature, Timestamp:1790785004, Nonce:'6227…'}` 样本。ECDSA 验签是强判据，
  本可用作离线 oracle 暴力枚举。`examples/trae_deviceproof_crack.mjs` 枚举了
  ≈5760 种字段拼接组合 × {两两/三三} × {`''`,`|`,`:`,`\n`,`-`,`_`,`.`,`,`,`/`,空格} ×
  {raw, sha256/384/512 的 raw/hex/base64} × {DER / base64url 两种签名编码}，另加整包请求体、
  DeviceInfo 原序/排序 JSON、query-string 形式、时间戳十进制/十六进制变体——**全部未命中**。
  ⇒ 签名原文很可能包含**服务端下发的 challenge**（同请求里的 `x-helios` / `x-medusa` /
  `x-neptune` anti-bot 头），无法离线重建。**结论：SOLO 系授权无法自行续期。**
  按"不滑动"对待更安全。
- 许可证：`anghunk/trae-proxy`、`weixiaokuan123/trae-proxy` 为 **MIT**（可参考实现）；
  `xinshang777/auto-checkin` **无 LICENSE**（保留所有权利，不要复制代码）。
- 本轮的第三方参考源码归档在 `examples/_research_trae/`（76 个文件、1.9 MB，未跟踪），
  其中 `src/` 下是四个项目的关键源文件（含 tc 解密与续期实现）。
