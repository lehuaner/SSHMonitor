# Trae 客户端生命周期 / 交互流 重建分析

> 数据源：`examples/2026-08-15-152602_解析结果`（HTTP 抓包解析结果，每次请求一个子目录）
> 目标：重建 Trae（api.trae.cn / www.trae.cn / api.trae.com.cn / zijieapi / mchost.guru）的**认证 + 用户/活动数据拉取**规范流程，作为给另一产品搭建等价「签到 / check-in」provider 的 1:1 参考模板。
> 焦点：AUTHENTICATION + USER/ACTIVITY DATA。UI 资源、遥测（mcs / mon / pc-mon / slardar / clarity / bat.bing）已忽略。

---

## 0. TL;DR — Trae 是否暴露原生签到/成长/连续签到 API？

**是，Trae 有原生的「每日签到 + 积分（credits）」API**，正好可作为 1:1 参考模板：

| 用途 | Method & Path | 鉴权 |
|------|--------------|------|
| 查询今日签到状态 / 积分 | `POST /trae/api/v2/ug/checkin_credits/status` | `authorization: Cloud-IDE-JWT <JWT>` |
| 执行签到领积分 | `POST /trae/api/v2/ug/checkin_credits/claim` | `authorization: Cloud-IDE-JWT <JWT>` |

- status 响应：`{"checked_in":false,"code":0,"credits":200,"enable":true,"message":"success"}`
- claim 响应：`{"code":0,"message":"success"}`；claim 后再查 status，`checked_in` 变 `true`。
- 这两个接口**不需要额外业务参数**（request body 仅 `{}`），只依赖登录态 JWT。

---

## 1. 全局约定（Global Conventions）

### 1.1 基础域名（Base Domains）
| 域名 | 角色 |
|------|------|
| `www.trae.cn` | 登录页（OAuth 授权页）+ `ttwid` 设备校验 + 静态资源 |
| `api.trae.cn` | **核心后端**：所有 `cloudide/api/*` 与 `trae/api/*`（登录、Token、用户、签到、计费） |
| `api.trae.com.cn` | 配套服务：`icube/api/*`（用户/设置）、`extensions/api/*`（插件）、`service_settings`、`native_config`、`notifications` |
| `mssdk.bytedance.com` | 反爬/风控 token（`msToken` / `a_bogus`）签发源，appid `711126` / `787976` |
| `*.zijieapi.com` / `*.mchost.guru` | 遥测/监控/远程资源（**非交互流**，忽略） |

### 1.2 通用请求头（几乎每个 api.trae.cn 调用都带）
```
authorization: Cloud-IDE-JWT <JWT>     # 核心鉴权头（见 §1.4 Token 模型）
x-cloudide-token: <JWT>                # 与上面同一个 JWT，部分接口冗余带
x-user-region: CN
package-type: stable_cn
x-lscbd-aid: 787976                    # 应用 aid
x-lscbd-platform: windows
app-version: 0.1.50
x-device-id: 3798161405005257
x-device-brand: 82JW
x-device-type: windows
x-market-client-id: VSCode 1.107.1
x-market-user-id: <uuid>
vscode-sessionid: <machine_id>
x-request-id: <uuid>
user-agent: VSCode 1.107.1 (TRAE SOLO CN)   # 或 Electron/TRAESOLOCN UA
```
浏览器侧（www.trae.cn / api.trae.cn CORS 调用）用 `Mozilla/...Edg/...` UA + `origin: https://www.trae.cn`，`cookie` 携带 ByteDance passport 全套。

### 1.3 统一响应包装（Envelope）
两套不同的 envelope，按 path 前缀区分：

**(A) `cloudide/api/*` 与 `trae/api/v3/*`（ByteDance AGW 风格）**
```json
{
  "ResponseMetadata": {
    "Action": "",
    "OID": "1000985253380538",     // 登录后填用户 ID
    "Region": "",
    "RequestId": "",
    "Service": "", "Source": "", "TraceID": "...", "Version": "", "WID": "...",
    "Error": {                      // 仅出错出现
      "Code": "20310",
      "Data": { "__Message.error": "get session empty..." },
      "Message": "The user is not logged in,",
      "StandardCode": "040203"
    }
  },
  "Result": { ... }                // 业务数据
}
```
- 响应头常见：`x-tt-agw-login: 1`、`x-tt-logid`、`x-tt-trace-id`、`strict-transport-security: max-age=31536000; includeSubDomains`。
- CORS：`access-control-allow-origin: https://www.trae.cn`、`access-control-allow-credentials: true`。

**(B) `trae/api/v2/*`（含签到）简化 envelope**
```json
{ "code": 0, "message": "success", ...业务字段 }
```
（`code:0` 表示成功，类似错误码在 `message`/独立 `code` 字段；icube 类用 `{"success":true,"data":{...}}`。）

### 1.4 Token 模型（关键）
Trae 使用**多层 token**，从登录到调用业务接口经历了 4 种凭据：

1. **ByteDance Passport Cookie**（浏览器登录态）
   - `sessionid` / `sid_tt` / `uid_tt` / `sid_guard` / `passport_auth_status` / `d_ticket` / `odin_tt` / `n_mh` / `ttwid` / `passport_csrf_token` 等。
   - 在 `www.trae.cn` 完成网页登录后由服务端 `Set-Cookie` 下发，浏览器/Electron 后续请求自动携带。

2. **AuthCode（PC 授权码，10 分钟 TTL）**
   - 登录成功后由 `www.trae.cn` 通过浏览器重定向回本地回调 `http://127.0.0.1:58448/authorize?authCodeInfo={"AuthCode":"...","ExpireAt":...,"ExpireDuration":600000}&userInfo={...}` 回传。
   - 客户端也可经 `GetPCAuthCode` 取同一 AuthCode（见 §3 步骤 2）。

3. **ExchangeToken 产物（核心）** —— `POST /trae/api/v3/oauth/ExchangeToken` 返回：
   ```json
   {
     "Token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7ImlkIjoiMTAwMDk4NTI1MzM4MDUzOCIsInNvdXJjZSI6InJlZnJlc2hfdG9rZW4iLCJzb3VyY2VfaWQiOiJIbFVqbUxTUmJ1VE9OanF1bDA1d1FUdXlJUDRZcy12WXJILTNHRkRjZnA4PS4xOGNiZTljYzJmNjQ5MDIyIiwidGVuYW50X2lkIjoiN28yZDg5NHA3ZHIwbzQiLCJ0eXBlIjoidXNlciJ9LCJleHAiOjE3ODc5ODgzNDAsImlhdCI6MTc4Njc3ODc0MH0.KJkQvfHXqlJoX9EMzMLxD7ydGkyDHQNAqi4bh-x3rd0isntfMGLa67QjTgMe6hb2JWLOmhhcd2i-KL0-uZMRxBqCKdlGcAc9jYGihcNDLihRR56QiICspWRE-hZ7C0H-noTUMhDJ-EGBD4j68CLtfOBb8oPZIC_bl4Fn9O52Dqnu14_kEvFdDhNEPMdmVgFyc5EJPo-1tSR2C3lGxcLQsW1dc0pEjD6iiNW-0s5BrCbf94Tjfyh8u1hwvqaRLjQdizI-pQmQzFgBJKWRwzVeNwCX7ju5QxTvAZfEAoayuMFZ_5HoSHB_J4atsJskMFWppWEeqQkA0ktxCulBHX_YieAeH3-dhLDP5nZeAiGB3DX-BcGVz1mW33AlzAbRuOvisoyqRql5HJULF6SLoxuzFA5omj4mESPcmjQ5q88w4R_EZpOcRkuQ7Z9TUTWMZe__TXX5V0Z-lvzAKnHo16BFZGlgde2B62HA0vVb20cAJmgn_iijN_KERb8dKOFhwxiYg1yAkM36BjLrZG3UGE0WrQPG0RnMtw8MZrfmb8_JybHAiGLJB1--yPz12e_8lupLtYN6bQwfrjFeambOWKVxm4PFUddN9Mb85_LD6us_TOK-QzqiAnyEbgwedSfaEJTAY5NIkd29pV1FTLOOlTk_IUPChojuwWtDw8LAr0D_9fc",          // == UserJwt，短中期访问凭据
     "UserJwt": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7ImlkIjoiMTAwMDk4NTI1MzM4MDUzOCIsInNvdXJjZSI6InJlZnJlc2hfdG9rZW4iLCJzb3VyY2VfaWQiOiJIbFVqbUxTUmJ1VE9OanF1bDA1d1FUdXlJUDRZcy12WXJILTNHRkRjZnA4PS4xOGNiZTljYzJmNjQ5MDIyIiwidGVuYW50X2lkIjoiN28yZDg5NHA3ZHIwbzQiLCJ0eXBlIjoidXNlciJ9LCJleHAiOjE3ODc5ODgzNDAsImlhdCI6MTc4Njc3ODc0MH0.KJkQvfHXqlJoX9EMzMLxD7ydGkyDHQNAqi4bh-x3rd0isntfMGLa67QjTgMe6hb2JWLOmhhcd2i-KL0-uZMRxBqCKdlGcAc9jYGihcNDLihRR56QiICspWRE-hZ7C0H-noTUMhDJ-EGBD4j68CLtfOBb8oPZIC_bl4Fn9O52Dqnu14_kEvFdDhNEPMdmVgFyc5EJPo-1tSR2C3lGxcLQsW1dc0pEjD6iiNW-0s5BrCbf94Tjfyh8u1hwvqaRLjQdizI-pQmQzFgBJKWRwzVeNwCX7ju5QxTvAZfEAoayuMFZ_5HoSHB_J4atsJskMFWppWEeqQkA0ktxCulBHX_YieAeH3-dhLDP5nZeAiGB3DX-BcGVz1mW33AlzAbRuOvisoyqRql5HJULF6SLoxuzFA5omj4mESPcmjQ5q88w4R_EZpOcRkuQ7Z9TUTWMZe__TXX5V0Z-lvzAKnHo16BFZGlgde2B62HA0vVb20cAJmgn_iijN_KERb8dKOFhwxiYg1yAkM36BjLrZG3UGE0WrQPG0RnMtw8MZrfmb8_JybHAiGLJB1--yPz12e_8lupLtYN6bQwfrjFeambOWKVxm4PFUddN9Mb85_LD6us_TOK-QzqiAnyEbgwedSfaEJTAY5NIkd29pV1FTLOOlTk_IUPChojuwWtDw8LAr0D_9fc",        // 与 Token 同值
     "TokenExpireAt": 1787988340345,
     "TokenExpireDuration": 1209600000,          // = 14 天
     "RefreshToken": "HlUjmLSRbuTONjqul05wQTuyIP4Ys-vYrH-3GFDcfp8=.18cbe9cc2f649022",
     "RefreshExpireAt": 1802330740345,           // 远长于 Token
     "ClientID": "en1oxy7wnw8j9n",
     "BoundDeviceID": "xj60ey88x6dyn0",
     "DeviceBindStatus": "BOUND"
   }
   ```
   - **`Cloud-IDE-JWT` 的本质** = 用 `RefreshToken` 作为 `source_id` 重新签发的 JWT，其 payload 形如：
     ```json
     {"data":{"id":"1000985253380538","source":"refresh_token",
              "source_id":"<RefreshToken>","tenant_id":"7o2d894p7dr0o4","type":"user"},
      "exp":1787988340,"iat":1786778740}
     ```
   - 该 JWT 即后续几乎所有业务接口（`authorization: Cloud-IDE-JWT`、签到、GetThirdPartyToken、icube）使用的凭据。

4. **X-Cloudide-Session Cookie + 会话 JWT**
   - `Login` 成功时通过 `set-cookie: X-Cloudide-Session=<val>; Domain=.trae.cn; HttpOnly; Secure; SameSite=Lax` 下发（有效期约 14 天）。
   - `GetUserToken`（`/cloudide/api/v3/common/GetUserToken`，仅依赖该 cookie，无 body）返回**会话 JWT**（payload `source:"session"`、`source_id` = 该 session 值）：
     ```json
     {"Token":"<session-JWT>","ExpiredAt":"2026-08-15T23:25:44...+08:00",
      "TenantID":"7o2d894p7dr0o4","UserID":"1000985253380538"}
     ```
   - 注意：`GetUserToken` 必须在 `X-Cloudide-Session` cookie 有效时调用，否则返回 `Error Code 20310 "get session empty"`（见 §3 步骤 0 的失败样例）。

### 1.5 反爬/风控参数（msToken / a_bogus）
- `Login`、`GetPCAuthCode` 等浏览器侧调用的 URL 带 `?msToken=<...>&a_bogus=<...>`（及 `code_challenge`/`code_challenge_method=S256` PKCE 参数）。
- `msToken` 由 `mssdk.bytedance.com/web/r_token?ms_appid=711126&msToken=...`（二进制 magic/version/dataType=8 协议）签发，用于生成签名。属风控层，做等价 provider 时通常可省略或替换为自有签名。

### 1.6 ttwid 机制
- `ttwid` 是 ByteDance 的 Web/设备指纹 cookie（形如 `1|<base64>|<ts>|<hmac>`），由 `www.trae.cn` 下发。
- 客户端在加载登录页前/后调用 `POST https://www.trae.cn/ttwid/check/`（body 含设备信息），返回 `{"status_code":0,"message":"check pass","sub_status_code":2001}` 作为风控前置校验。等价实现里对应「设备合法性校验」步骤。

---

## 2. 重建的客户端生命周期序列（Sequence）

```
[浏览器/Electron 外壳]
  │
  ├─(0) GET www.trae.cn/authorization?login_version=1&auth_from=solo
  │       &login_channel=native_ide&auth_type=local&client_id=en1oxy7wnw8j9n
  │       &redirect=0&auth_callback_url=http://127.0.0.1:58448/authorize
  │       &code_challenge=<PKCE>&code_challenge_method=S256&machine_id=<mid>&device_id=<did>
  │   └─> 200 HTML 登录页（用户在此输入账号/短信登录）
  │
  ├─(*) POST www.trae.cn/ttwid/check/          [风控/设备指纹校验]  -> {"check pass"}
  │
  ├─(用户登录成功)
  │     www.trae.cn 302 重定向到 auth_callback_url：
  │     http://127.0.0.1:58448/authorize
  │        ?authCodeInfo={"AuthCode":"x9QI...","ExpireAt":...,"ExpireDuration":600000}
  │        &userInfo={"UserID":"1000985253380538","ScreenName":"lehuan","TenantID":"7o2d894p7dr0o4",...}
  │        &host=https://api.trae.com.cn
  │
  ├─(1) POST api.trae.cn/cloudide/api/v3/trae/oauth/GetPCAuthCode
  │   └─> {AuthCode, ExpireAt, ExpireDuration}    (取回同一个 PC 授权码)
  │
  ├─(2) POST api.trae.cn/trae/api/v3/oauth/ExchangeToken
  │   └─> {Token(=UserJwt), RefreshToken, TokenExpireAt, RefreshExpireAt,
  │         ClientID, BoundDeviceID, DeviceBindStatus}
  │
  ├─(3) POST api.trae.cn/cloudide/api/v3/trae/CheckLogin
  │   └─> {IsLogin:true, UserID(OID), WID, ExpiredAt, Region:"CN", Host, MigrateToSG}
  │
  ├─(4) POST api.trae.cn/cloudide/api/v3/trae/Login?type=&msToken=<>&a_bogus=<>
  │   └─> {FirstLogin:false, NickNameEditStatus:"init"}
  │        set-cookie: X-Cloudide-Session=<val>   (14 天会话)
  │
  ├─(5) POST api.trae.cn/cloudide/api/v3/trae/GetUserInfo
  │   └─> {UserID, ScreenName, AvatarUrl, Region, TenantID, RegisterTime,
  │         LastLoginTime, AuditInfo, Gender, ...}
  │
  ├─(6) POST api.trae.cn/cloudide/api/v3/common/GetUserToken
  │   └─> {Token:<session-JWT>, ExpiredAt, TenantID, UserID}   (依赖 X-Cloudide-Session)
  │
  ├─【业务/活动数据】
  ├─(7) POST api.trae.cn/trae/api/v2/ug/checkin_credits/status
  │   └─> {checked_in:false, code:0, credits:200, enable:true, message:"success"}
  ├─(8) POST api.trae.cn/trae/api/v2/ug/checkin_credits/claim
  │   └─> {code:0, message:"success"}    (签到领积分)
  ├─(9) POST api.trae.cn/trae/api/v2/ug/checkin_credits/status   -> checked_in:true
  │
  ├─ 其他：GetThirdPartyToken / icube/api/v1/user / pay_ide_user_ent_usage 等
  │
  └─(退出) POST api.trae.cn/cloudide/api/v3/trae/oauth/ClearRefreshToken
              (清除 RefreshToken，注销；参数无效时返回 Code 10101)
```

> 说明：本抓包中 `GetThirdPartyToken`、`ClearRefreshToken` 出现在会话已经稳定的中段（由 VSCode/Electron UA 用 `Cloud-IDE-JWT` 调用），属「已登录态下的凭据续期/清理」动作，逻辑上位于 ExchangeToken 之后、业务调用之前/之中。

---

## 3. 每端点详情（Per-Endpoint Detail）

### 步骤 0 — 登录页 `GET www.trae.cn/authorization`
- **路径**：`/authorization?login_version=1&auth_from=solo&login_channel=native_ide&plugin_version=2.3.70844&auth_type=local&client_id=en1oxy7wnw8j9n&redirect=0&login_trace_id=<uuid>&auth_callback_url=http://127.0.0.1:58448/authorize&machine_id=<mid>&device_id=<did>&x_device_id=<did>&x_machine_id=<mid>&x_device_brand=82JW&x_device_type=windows&x_os_version=Windows%2011%20Pro&x_env=&x_app_version=0.1.50&x_app_type=stable&code_challenge=<S256>&code_challenge_method=S256&hide_saas_login=true&channel_name=common&click_id=TRAE%20SOLOSetup-stable-2.3.70844`
- **关键头**：`cookie`（仅匿名态 passport csrf 等）；`sec-fetch-mode: navigate`。
- **响应**：`200` HTML（SSR 登录页，`server: Tengine` / `x-powered-by: Goofy Node`）。
- **返回**：登录表单页；用户在页内完成登录。二次加载（`redirect=1`，capture 169）为登录完成后的回跳。

### 步骤 * — 设备校验 `POST www.trae.cn/ttwid/check/`
- **路径**：`/ttwid/check/`
- **关键头**：`cookie: ...; ttwid=1|<...>; ...`；`origin: https://www.trae.cn`；`referer: https://www.trae.cn/authorization?...`。
- **响应体**：`{"status_code":0,"message":"check pass","sub_status_code":2001}`。
- **作用**：风控/设备指纹前置校验，必须在授权流程早期调用。

### 步骤 1 — 取 PC 授权码 `POST api.trae.cn/cloudide/api/v3/trae/oauth/GetPCAuthCode`
- **路径**：`/cloudide/api/v3/trae/oauth/GetPCAuthCode`（无 query）
- **关键头**：`origin: https://www.trae.cn`；`referer: https://www.trae.cn/`；`cookie`（含 passport 全套）。
- **响应**：`200`，envelope (A)。
- **Result**：`{"AuthCode":"x9QIfAGg7t6tNW6PQHknOO0icmc05uMeH4fX3Y3yJDU","ExpireAt":1786779340071,"ExpireDuration":600000}`
- **说明**：该 AuthCode 与浏览器回跳 `127.0.0.1/authorize?authCodeInfo` 中的 **AuthCode 完全一致**（同一登录会话产物，10 分钟有效）。

### 步骤 2 — 换取 Token `POST api.trae.cn/trae/api/v3/oauth/ExchangeToken`
- **路径**：`/trae/api/v3/oauth/ExchangeToken`
- **关键头**：`x-lgw-req-sdk-type:3`、`package-type: stable_cn`、`x-lscbd-aid:787976`、`x-lscbd-platform:windows`、`app-version:0.1.50`；UA `TRAESOLOCN/1.107.1 ... Electron/39.2.7`；`sec-fetch-site: none`。**不需要 cookie**（用 AuthCode 兑换）。
- **响应体 Result**：见 §1.4 步骤 3 —— 返回 `Token`/`UserJwt`、`RefreshToken`、`TokenExpireAt/Duration`(14天)、`RefreshExpireAt`、`ClientID`、`BoundDeviceID`、`DeviceBindStatus`。
- **这是整个认证的核心**：之后所有 `Cloud-IDE-JWT` 都由 `RefreshToken` 派生。

### 步骤 3 — 校验登录态 `POST api.trae.cn/cloudide/api/v3/trae/CheckLogin`
- **路径**：`/cloudide/api/v3/trae/CheckLogin`（body 仅 `{}` 或空）
- **关键头**：`origin: https://www.trae.cn`；`cookie`（passport 全套 + `X-Cloudide-Session`）。
- **响应 Result**：`{"AIHost":"","AIPayHost":"","AIRegion":"","ExpiredAt":1787981892358,"Host":"https://api.trae.com.cn","IsLogin":true,"MigrateToSG":false,"NickNameEditStatus":"init","PasswordChanged":false,"Region":"CN","UserID":"1000985253380538"}`
- **作用**：确认登录有效，取回 `UserID(OID)`、`WID`、会话 `ExpiredAt`、后端 `Host`。`ResponseMetadata.OID/WID` 也会回填。

### 步骤 4 — 登录 `POST api.trae.cn/cloudide/api/v3/trae/Login`
- **路径**：`/cloudide/api/v3/trae/Login?type=&msToken=<...>&a_bogus=<...>`（query 带风控签名；`type` 为空）
- **方法**：实际为 `OPTIONS` 预检 + `POST`（CORS）。OPTIONS 响应头带 `x-ms-token`（下一次风控 token）。
- **关键头**：`origin: https://www.trae.cn`；`referer: https://www.trae.cn/`；`traceparent`；`cookie`。
- **响应**：`200`，`set-cookie: X-Cloudide-Session=<val>; Domain=.trae.cn; HttpOnly; Secure; SameSite=Lax; Expires=~14天后`。
- **Result**：`{"FirstLogin":false,"NickNameEditStatus":"init"}`。
- **作用**：在 Web 端建立 CloudIDE 会话（下发 `X-Cloudide-Session`），是 `GetUserToken` 的前置。

### 步骤 5 — 取用户信息 `POST api.trae.cn/cloudide/api/v3/trae/GetUserInfo`
- **路径**：`/cloudide/api/v3/trae/GetUserInfo`（body 空）
- **关键头**：同上 `origin/referer/cookie`。
- **Result 字段**：
  ```
  AIRegion, AuditInfo(JSON: audit_status/is_auditing/...), AvatarUrl,
  Description, Gender("0"), LastLoginTime, LastLoginType("sms"),
  MigrateToSG, NonPlainTextEmail, NonPlainTextMobile("173******16"),
  Region("CN"), RegisterTime, ScreenName("lehuan"), TenantID("7o2d894p7dr0o4"),
  UserID("1000985253380538")
  ```
- **作用**：拉取展示用用户档案。

### 步骤 6 — 取会话 Token `POST api.trae.cn/cloudide/api/v3/common/GetUserToken`
- **路径**：`/cloudide/api/v3/common/GetUserToken`（body 空，仅依赖 cookie）
- **关键头**：`cookie`（必须含有效 `X-Cloudide-Session`，否则 `Error 20310 "get session empty"`）。
- **成功 Result**：`{"ExpiredAt":"2026-08-15T23:25:44...+08:00","TenantID":"7o2d894p7dr0o4","Token":"<session-JWT>","UserID":"1000985253380538"}`
- **作用**：换得 session-JWT，可作为 `x-cloudide-token` 使用（与 `Cloud-IDE-JWT` 并存）。

### 步骤 7/8/9 — 签到/积分（原生 check-in API，重点参考）
- **状态查询** `POST /trae/api/v2/ug/checkin_credits/status`
  - 头：`authorization: Cloud-IDE-JWT <JWT>`（JWT 内 `source:"refresh_token"`）、`x-user-region:CN`、`x-device-*`、`package-type: stable_cn`、`x-lscbd-aid:787976`、`vscode-sessionid`、`x-market-*`、`x-lgw-req-sdk-type:3`。
  - 请求体：`{}`（仅 2 字节）。
  - 响应（envelope B）：`{"checked_in":false,"code":0,"credits":200,"enable":true,"message":"success"}`
- **执行签到** `POST /trae/api/v2/ug/checkin_credits/claim`
  - 头/体同上。
  - 响应：`{"code":0,"message":"success"}`
- **再查状态**：`checked_in` 变为 `true`，`credits` 仍 `200`（claim 后积分已入账）。
- **等价 provider 落地要点**：仅需「状态查询 → 条件 claim → 再查询确认」三步；无额外业务参数；完全依赖登录态 JWT。

### 其他登录后凭据动作
- **`POST /trae/api/v3/GetThirdPartyToken`**：`authorization: Cloud-IDE-JWT <JWT>` + `x-cloudide-token:<JWT>`（JWT `source:"refresh_token"`）。用于获取第三方（OAuth 下游）凭据；本包中 response body 仅为空 envelope（token 可能在 header/透传），属「令牌桥接」调用。
- **`POST /cloudide/api/v3/trae/oauth/ClearRefreshToken`**：注销/清刷新令牌；`authorization: Cloud-IDE-JWT`（本包中传空值导致 `Error 10101 无效参数`）。逻辑上位于登出时。
- **`POST api.trae.com.cn/icube/api/v1/user`**：`x-icube-token:<JWT>`；返回 `{"success":true,"data":{"loginAllowed":true}}`，用于 icube 侧登录许可校验。

### 配套（非核心）活动/计费端点（同域，可一并参考）
- `POST /trae/api/v2/pay_ide_user_ent_usage`（企业用量）、`/trae/api/v2/pay_ide_user_pay_status`、`/trae/api/v2/pay_cn_credits_billing_status`、`/icube/api/v1/notifications/count` —— 均用 `Cloud-IDE-JWT`。
- `GET www.trae.cn/api/tcc/commerce?key=errorMessageConfig` —— 返回多语言错误码文案映射（如 `9064/9065/...`），属前端文案配置，非交互流必需。

---

## 4. 给「等价签到 provider」的 1:1 落地清单

要复刻 Trae 这套 client lifecycle，你的 provider 需实现（按顺序）：

1. **授权入口**：一个登录页/授权端点，登录成功后通过**本地回调 URL**（或授权码回传）把 `AuthCode`（≈10 分钟 TTL）和 `userInfo` 交给客户端。
2. **ExchangeToken**：用 AuthCode 换 `access_token` + `refresh_token`（access ≈14 天，refresh 更长），并返回 `client_id` / `device_bind` 等。
3. **CheckLogin**：校验登录态、返回 user_id 与后端 host。
4. **Login**：建立应用会话，下发会话 cookie/token（`X-Cloudide-Session` 角色）。
5. **GetUserInfo**：返回用户档案字段（user_id、昵称、头像、租户、注册时间、地区等）。
6. **GetUserToken**：用会话换「API 调用用 JWT」，作为 `Authorization` 头。
7. **签到 API（核心参考）**：
   - `POST /ug/checkin_credits/status` → 返回 `checked_in / credits / enable`。
   - `POST /ug/checkin_credits/claim` → 执行签到。
   - 两者仅依赖 `Authorization: Bearer <JWT>`，无额外参数。
8. **登出**：`ClearRefreshToken` 清理刷新令牌。

**鉴权头约定**：所有业务接口统一 `Authorization: Cloud-IDE-JWT <JWT>`（JWT 内嵌 `user_id / tenant_id / source`）；封装层（如浏览器 CORS）用 `origin` 白名单 + `credentials`。风控层（msToken/a_bogus/ttwid）可简化为自有签名或移除。

---

## 5. 结论（Conclusion）

- **Trae 确实暴露原生「每日签到 + 积分」API**：`/trae/api/v2/ug/checkin_credits/status` 与 `/trae/api/v2/ug/checkin_credits/claim`，这正是要找的 1:1 参考模板——无业务参数、仅依赖登录态 JWT、返回 `checked_in/credits` 与 `code/message`。
- 其**认证链路**是典型「OAuth 风格 + ByteDance Passport」混合：网页登录 → 本地回调回传 AuthCode → ExchangeToken 换 access/refresh → CheckLogin/Login 建会话 → GetUserInfo/GetUserToken 取档案与调用令牌 → 业务接口用 `Cloud-IDE-JWT`。
- 对构建等价 provider 而言，可直接对齐上述 8 步与统一 envelope（§1.3）/Token 模型（§1.4），风控参数（msToken/ttwid/a_bogus）按需裁剪。
