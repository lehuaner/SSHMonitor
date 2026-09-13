# Honor 10 monitor 项目长期备忘

> 详细过程见 `.workbuddy/memory/YYYY-MM-DD.md`；本文只放跨会话仍需遵守的硬事实。

## 运行环境
- 远端：Termux（Honor 10），SSH `root@192.168.0.107:8022`，服务根 `~/monitor/`。
- **monitor 由 runit 托管，服务名是 `server`**（不是 `monitor`）。重启走 `bash deploy-remote.sh`
  （内部 `sv restart server`，并清理非 runsv 托管的孤儿 `node server.js`）。
- 数据目录 `~/.monitor_data/`（`checkin_tasks.json` / `checkin_logs.json` / `checkin_stats.json` …）。
- 本地 git 仓库**常年落后于手机**；改代码前先把 `~/monitor/{server.js,lib/**}` 拉下来。
- 本地 `monitor/lib/providers/` 缺 `common.js`，Provider 只能在远端跑（本机只能跑 `lib/checkin/*`）。

## CodeArts（码道）账号 17327137416
- **★ 每日签到现行走「运营活动中心」**：`GET /portal/promptcenter/v1/ops/delivery?channel=PORTAL`
  （取 `type=USER_LOGIN` 项的 `claimable`/`campaignId`）→ `POST /portal/promptcenter/v1/ops/claim`
  `{campaignId, channel:'PORTAL'}`。领取流水看 `/ops/credit/campaign/{id}` 的 `benefits[].claimedAt`。
- **旧接口 `/portal/snap-manager/v1/credit/{has-claimed,claim}` 已废弃**：仍在路由表里，
  但返回 `HTTP 200 + 完全空响应体`（无 content-type、无 HW-AJAX-REDIRECT）。**永远不要把它判成 `false`。**
- 该 `ops/*` 接口参数校验极严：只认 `channel`，多传 `?_=` 会 400 `HDN.1000`。
- 活动积分进独立桶 `pointBucket=GENERAL`，**分钟级延迟**才并入套餐余额 ⇒ 当日所得取
  活动返回的 `totalAmount`，不能用余额差。
- 账号/套餐读取：`/snap-manager/v1/package/overview`（面板余额口径）、`/package/info`、
  `/rest/me`、`/package/credit/page`（逐包明细）一直可用。
- 会话失效信号：HTTP 200 + 空体 + 响应头 `HW-AJAX-REDIRECT`（不带 Cookie 可复现，无 401/403）。
- **登录链（2026-09-12 已修复，可自动重登）**：`authui/login.html` → `getSDKBaseInfo`（取
  `pageToken`）→ `jsRemoteLogin`（固定返 `10006003`，正常）→ `common/analysisHealth`
  → `common/dev`（建 `hwid_cas_sid`，10 年）→ `login/getLoginIdsByPwd` →
  `login/unionLoginByPwd` → OAuth 换票 → 逐跳带 `?ticket=ST-…` 落到业务站点。
  - ★ `unionLoginByPwd` 的 **`anonymousLoginID` 只能是裸匿名账号**（`l****an`）；
    拼上 `anonymousEncryption`（JWT）会报 `10000000 loginFlowContext is empty!`。
  - ★ 落地**必须逐跳手动跟随**（`follow` 默认仅同源，第 2 跳就跨域），且每跳保留 ticket；
    否则只拿到 `…J_SESSION_ID`，缺 `…agencyID`/`…tcftk`。
  - `needPopTrust:true` → 补 `login/updateTrustBrowser`（`operType=1&trustBrowser=1`）。
  - 设备验证 = **同端点** `login/unionLoginByPwd` 再调一次（`opType=1` +
    `verifyUserAccount`/`verifyAccountType`/`twoStepVerifyCode`）；`10002080` 的 `errorDesc`
    自带 `authCodeSentList`（验证码已下发，无独立下发接口）。
    **不要用 `/CAS/IDM_W/ajaxHandler/*`**（另一命名空间，必返 `cloudLoginBean is null`）。
  - `hwmeta` 传空串**可被接受**（不必逆向那个二进制 TLV）。
  - ★ **`hwidConfig` 是一层 URL 编码的 JSON 字符串**（14k+ 字符，解码后 87 键），不是对象；
    必须先 `decodeURIComponent`+`JSON.parse` 再取 `cookieVersion`/`localStorageID`。
  - ★ **设备信任绑定 (hwid_cas_sid + fpSeed)**，**不绑定 localStorageID / cookie jar**
    （实测两者每次都可以是新的）。⇒ 换 fpSeed = 换设备 = 必须重新短信验证一次；
    fpSeed 一经验证不要再改。验证通过后签发的 sid 即持久受信令牌（空 jar 重登免验证）。
  - **「新设备 → 短信码 → opType=1」分支 2026-09-12 已真实实测通过**（探针 v17a/v17b/v19/v20）；
    `submitVerifyCode(code, deviceIndex)` 必须尊重调用方 deviceIndex。
  - ★ **重登必须先清空脏 jar 只留 `hwid_cas_sid`**（v21 定位，`login()` 开头
    `resetKeeping`）：旧业务 cookie 会让 OAuth 落地把票换进旧（失效）会话 ——
    症状是 login() 假成功（3/3 cookie「齐」但全是旧的）+ 业务接口仍 `HW-AJAX-REDIRECT`
    =「重登后仍失效」。判「重登成功」必须用业务接口复探，不能只看 cookie 齐不齐。
  - 登录中途可能有 HTML 中间页 `loginBindMfa.html`：`IAMCSRF` 取自
    `GET /authui/getAntiPhishingInfo?isSupport=true&isBindMfa=true`，POST `authui/validateUser`
    （`step=afterBindMfa&isConfirmed=false`）放行。

## 工作习惯（本项目）
- 抓包解析目录名把 `/` 换成了 `_`：`..._snap-manager_v1_member_roles` 实际是 `/member/roles`，
  不要照抄当路径（会 400 `TM.00001001 请求没有配置URL校验规则`）。
- 定位「凭证有效但签到失败」的优先手段：**比对前端 bundle 版本 + grep 接口路径**
  （`devcloud-res.hc-cdn.com/CodeArtsAgentPortal/<版本>/hws/assets/index-<hash>.js`）。
- 登录链这类「报错信息量极低」的故障，**唯一可靠手段是抓包逐字段 diff**（`tr '&' '\n'` 拆 body），
  并翻**历史抓包**交叉验证字段形态；不要靠猜、不要给字段「自作聪明」加后缀。
- **部署大文件走 base64 中转**：`base64` 编码 → 上传 `.b64` → 远端 `base64 -d` →
  两边 `sha256sum` 对拍。`.b64` 纯 ASCII，免疫 ssh-mcp upload 吞反斜杠转义的问题。
- **覆盖远端文件前先 diff**（本地常年落后/超前）：用 `difflib.unified_diff` 确认
  「远端独有行」全是本次要删的旧代码，再覆盖。
