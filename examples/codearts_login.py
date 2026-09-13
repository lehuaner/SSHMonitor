#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
codearts_login.py —— CodeArts（华为云码道）账号密码登录 + 新设备验证

背景
----
CodeArts 的业务接口只认 Cookie 会话，而该会话寿命很短（小时~天级），失效时
不改 HTTP 状态码、仅通过响应头 `HW-AJAX-REDIRECT` 下发登录地址（见
`codearts_checkin平台全流程方案.md` §1.6）。因此 Provider 需要一个能"重新登录"
的能力，而不是依赖一次抓包的长效凭证。

本模块实现完整登录链路：

  ① 引导      GET  auth.huaweicloud.com/authui/login.html        → 拿 WAF 会话
  ② 取引导信息 GET  auth.huaweicloud.com/authui/getSDKBaseInfo    → pageToken/pageTokenKey/state/hwidConfig
  ③ 预热      POST id1…/UnifiedIDMPortal/ajaxHandler/login/jsRemoteLogin
  ④ 设备指纹   POST id1…/UnifiedIDMPortal/ajaxHandler/common/dev            → sid(=hwid_cas_sid)
  ⑤ 健康上报   POST id1…/UnifiedIDMPortal/ajaxHandler/common/analysisHealth
  ⑥ 账号识别   POST id1…/UnifiedIDMPortal/ajaxHandler/login/getLoginIdsByPwd
  ⑦ 密码登录   POST id1…/UnifiedIDMPortal/ajaxHandler/login/unionLoginByPwd  → callbackURL + needPopTrust
  ⑧ 【新设备】 GET  id1…/CAS/portal/authIdentify.html
               POST id1…/CAS/IDM_W/ajaxHandler/cloudIframeAuthIdentify/getPageInfo → 验证设备列表
               POST id1…/CAS/IDM_W/ajaxHandler/cloudAuthLogin    {twoStepVerifyCode}
               POST id1…/CAS/IDM_W/ajaxHandler/updateTrustBrowser
  ⑨ 换取会话   callbackURL → /oauth2/v3/authorize → getLoginWay → CAS remoteLogin
               → /oauth2/v3/loginCallback → /oauth2/ajax/login → code
               → auth.huaweicloud.com/authui/casLogin → /authui/login
               → codearts…/personal-usage?ticket=ST-…  ⇒ devclouddevuibjJ_SESSION_ID
               → codearts…/personal-usage              ⇒ devclouddevuibjtcftk

已实测确认的关键结论（2026-09-10 现场复现）
------------------------------------------
· 设备指纹 `fp` 算法：`base64( XOR( body ) )`，body = 按键名排序的 `k=v&…` + `&cs=<SHA1(body)>`；
  XOR 滚动密钥初值 211，每步 `key ← 该步产出的密文字节`（加解密同规则）。
· `cs` 必须是 **SHA1**。改用 MD5（旧版 CAS 算法）→ 服务端 200 但 `sid` 返回空串。
· 服务端**只校验 `cs` 完整性，不校验各指纹字段的真实性**：把 canvas/webgl/fonts/ep/epls
  全部换成伪造 SHA1 值，只要 `cs` 正确，照样签发 `sid`。⇒ 纯 Python 生成指纹即可，无需 Playwright。
· `hwid_cas_sid` 才是**可持久化的设备信任令牌**：请求里带上它，服务端原样回显，
  并以 `Max-Age=315360000`(10 年) 写入 cookie。带上它重登 → 不会触发设备验证。
· 不带 `hwid_cas_sid` 时，服务端每次会话新签发一个 `sid`（同一会话内幂等）。
· 设备验证相关的 ajax handler 只存在于 `/CAS/IDM_W/ajaxHandler/`；
  在 `/UnifiedIDMPortal/ajaxHandler/` 下请求同名单会 404（已实测对照）。

用法
----
  # 账号密码登录；若是新设备，会打印验证设备列表并提示输入验证码
  python codearts_login.py login --account 17300000000 --password '***' \
         --session .codearts_session.json

  # 已有会话文件，只做探活
  python codearts_login.py check --session .codearts_session.json

  # 已验证的指纹算法自检（离线，不联网）
  python codearts_login.py selftest

说明：本模块仅做"登录 + 会话导出"，不执行任何签到写操作。
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import http.cookiejar
import json
import os
import random
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ==========================================================================
# 常量（全部来自 codearts2 抓包实证）
# ==========================================================================

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0")

# 登录成功后要落地的业务页（= OAuth 的 service）
SERVICE = "https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn"
# 华为云侧 CAS 回调
CAS_SERVICE = "https://auth.huaweicloud.com/authui/casLogin?service=" + urllib.parse.quote(SERVICE, safe="")
CAS_SERVICE_APP = "https://auth.huaweicloud.com/authui/casLoginAPP?service=" + urllib.parse.quote(SERVICE, safe="")
LOGIN_PAGE = "https://auth.huaweicloud.com/authui/login.html?service=" + urllib.parse.quote(SERVICE, safe="")

ID1 = "https://id1.cloud.huawei.com"
AJAX_NEW = ID1 + "/UnifiedIDMPortal/ajaxHandler"        # 登录阶段（新版 UnifiedIDMPortal）
AJAX_CAS = ID1 + "/CAS/IDM_W/ajaxHandler"               # 设备验证阶段（实测该前缀下才有）
AUTH_IDENTIFY_PAGE = ID1 + "/CAS/portal/authIdentify.html"

REQ_CLIENT_TYPE = "88"
LOGIN_CHANNEL = "88000000"
CLIENT_ID = "103493351"
LANG = "zh-cn"
REGION_CODE = "cn"
THEME_NAME = "lightred"
SCOPE = ("https://www.huawei.com/auth/account/unified.profile"
         "+https://www.huawei.com/auth/account/risk.idstate"
         "+LoginState")
CVERSION_FALLBACK = "UP_CAS_6.26.2.100_blue"

# 业务会话 cookie（登录成功的判据）
CODEARTS_SESSION_COOKIES = ("devclouddevuibjJ_SESSION_ID", "devclouddevuibjagencyID", "devclouddevuibjtcftk")
# 失效信号头
EXPIRY_HEADER = "hw-ajax-redirect"

# unionLoginByPwd 以「isSuccess=0 + 这些 errorCode」的形式要求设备验证
# （实测：不带受信 hwid_cas_sid 时返回 10002080，且 errorDesc 里内嵌 authCodeSentList）
NEED_VERIFY_CODES = ("10002080",)

# 指纹模板：一台 Windows + Edge、1920x1080、UTC+8 的常见桌面环境
# （实测证明服务端不校验这些值，只校验 cs，因此固定模板即可、且能保证跨会话稳定）
FP_PROFILE: Dict[str, Any] = {
    "bsh": 856, "bsw": 1496,
    "devs": "", "ips": "",
    "epl": 5,
    "ett": 0,                    # 每次生成时填当前毫秒
    "etz": -480,                 # UTC+8
    "nacn": "Mozilla", "nan": "Netscape", "nce": "true",
    "nlg": "zh-CN", "npf": "Win32",
    "sah": 1032, "saw": 1920, "sh": 1080, "sw": 1920,
}


# ==========================================================================
# 设备指纹（fp）生成 —— 纯标准库
# ==========================================================================

def _xor_encrypt(data: str) -> str:
    """明文 → 密文。

    规则：key 初值 211；每一步 `c = p ^ (key-1)`，随后 `key ← c`（**密文字节**）。
    与前端 JS / 参考项目 `fingerprint.py::_xor_encrypt` 完全一致。
    """
    key = 211
    out = []
    for ch in data:
        c = (ord(ch) ^ (key - 1)) & 0xFF
        out.append(chr(c))
        key = c
    return "".join(out)


def _xor_decrypt(data: str) -> str:
    """密文 → 明文（注意：不是 _xor_encrypt 的自反调用，key 同样滚动为密文字节）。"""
    key = 211
    out = []
    for ch in data:
        c = ord(ch)                                   # 当前输入即密文字节
        out.append(chr((c ^ (key - 1)) & 0xFF))
        key = c
    return "".join(out)


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _serialize(pairs: Dict[str, Any]) -> str:
    """按键名升序序列化为 `k=v&k=v`，key/value 都做 encodeURIComponent 风格编码。"""
    parts = []
    for key in sorted(pairs.keys()):
        val = pairs[key]
        parts.append("%s=%s" % (urllib.parse.quote(str(key), safe=""),
                                urllib.parse.quote(str(val), safe="")))
    return "&".join(parts)


def build_fp(seed: str = "codearts-checkin", *, now_ms: Optional[int] = None,
             profile: Optional[Dict[str, Any]] = None) -> str:
    """生成合法设备指纹 fp。

    服务端只校验 `cs = SHA1(serialized)` 的完整性，因此这里用 `seed` 派生出
    一组稳定的伪哈希字段——同一 seed 每次生成完全一致，天然满足"设备指纹稳定"要求。

    Args:
        seed:    设备种子；同一台机器固定即可（默认写死一个常量）。
        now_ms:  `ett` 取值，默认当前毫秒时间戳。
        profile: 覆盖 FP_PROFILE 中的非哈希字段。
    """
    prof = dict(FP_PROFILE)
    if profile:
        prof.update(profile)
    prof["ett"] = int(now_ms if now_ms is not None else time.time() * 1000)

    def h(tag: str) -> str:
        return _sha1("%s|%s" % (seed, tag))

    pairs = dict(prof)
    pairs["canvas"] = h("canvas")
    pairs["webgl"] = h("webgl")
    pairs["fonts"] = h("fonts")
    pairs["ep"] = h("ep")
    # epls = 4 个带前缀的插件指纹，逗号分隔
    pairs["epls"] = ",".join(p + h(p) for p in ("P", "C", "M", "W"))

    serialized = _serialize(pairs)
    body = serialized + "&cs=" + _sha1(serialized)
    return base64.b64encode(_xor_encrypt(body).encode("latin-1")).decode("ascii")


def decode_fp(fp: str) -> str:
    """反向解码 fp（用于调试 / 自检）。"""
    return _xor_decrypt(base64.b64decode(fp).decode("latin-1"))


def parse_auth_code_sent_list(raw: Any) -> List[Dict[str, Any]]:
    """从 `errorDesc` / `localInfo.errorDesc` 里抽出 `authCodeSentList`。

    `errorDesc` 可能是 JSON 字符串，也可能是已解析好的 dict；两种都兼容。
    形如：{"authCodeSentList":[{"name":"Honor 10","accountType":-1,"sent":1,"type":"device"}]}
    """
    if not raw:
        return []
    desc = raw
    if isinstance(desc, str):
        try:
            desc = json.loads(desc)
        except Exception:  # noqa: BLE001
            return []
    if not isinstance(desc, dict):
        return []
    items = desc.get("authCodeSentList") or []
    return [d for d in items if isinstance(d, dict)]


# ==========================================================================
# 数据类
# ==========================================================================

@dataclass
class LoginResult:
    ok: bool
    need_verify: bool = False
    cookies: Dict[str, str] = field(default_factory=dict)
    auth_devices: List[Dict[str, Any]] = field(default_factory=list)
    error: str = ""
    detail: Any = None

    def __bool__(self) -> bool:  # noqa: D105
        return self.ok


# ==========================================================================
# 登录器
# ==========================================================================

class CodeArtsLogin:
    """CodeArts（华为云）账号密码登录，含新设备验证。"""

    def __init__(self, *, verify_tls: bool = True, timeout: int = 25,
                 fp_seed: str = "codearts-checkin", verbose: bool = True) -> None:
        ctx = ssl.create_default_context()
        if not verify_tls:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self._ctx = ctx
        self._timeout = timeout
        self._verbose = verbose
        self.jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ctx),
        )
        self._opener.addheaders = [
            ("User-Agent", UA),
            ("Accept-Language", "zh-CN,zh;q=0.9"),
            ("Accept", "application/json, text/plain, */*"),
        ]

        self.fp_seed = fp_seed
        self._cversion = CVERSION_FALLBACK
        self._fp: Optional[str] = None
        self._local_storage_id = ""
        self._hwid_cas_sid = ""
        self._base: Dict[str, str] = {}
        self._auth_base: Dict[str, str] = {}
        self._auth_devices: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # 基础 HTTP
    # ------------------------------------------------------------------
    def _log(self, msg: str) -> None:
        if self._verbose:
            print(msg, flush=True)

    def _request(self, method: str, url: str, data: Optional[Dict[str, Any]] = None,
                 referer: str = "https://auth.huaweicloud.com/",
                 origin: str = "https://auth.huaweicloud.com",
                 headers: Optional[Dict[str, str]] = None,
                 allow_redirects: bool = True) -> Dict[str, Any]:
        body = None
        hdrs = {"Referer": referer}
        if data is not None:
            body = urllib.parse.urlencode(data).encode("utf-8")
            hdrs["Content-Type"] = "application/x-www-form-urlencoded"
            if origin:
                hdrs["Origin"] = origin
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
        try:
            with self._opener.open(req, timeout=self._timeout) as resp:
                return {"status": resp.status, "url": resp.url, "headers": dict(resp.headers),
                        "text": resp.read().decode("utf-8", "replace")}
        except urllib.error.HTTPError as exc:
            return {"status": exc.code, "url": url, "headers": dict(exc.headers),
                    "text": exc.read().decode("utf-8", "replace")}
        except Exception as exc:  # noqa: BLE001
            return {"status": -1, "url": url, "headers": {}, "text": "<%s: %s>" % (type(exc).__name__, exc)}

    def _get(self, url: str, **kw) -> Dict[str, Any]:
        return self._request("GET", url, None, **kw)

    def _post(self, url: str, data: Dict[str, Any], **kw) -> Dict[str, Any]:
        return self._request("POST", url, data, **kw)

    def _post_json(self, url: str, data: Dict[str, Any], **kw) -> Dict[str, Any]:
        resp = self._post(url, data, **kw)
        try:
            return json.loads(resp["text"])
        except Exception:  # noqa: BLE001
            return {"isSuccess": 0, "_raw": resp["text"][:400], "_http": resp["status"]}

    # ------------------------------------------------------------------
    # Cookie / 会话
    # ------------------------------------------------------------------
    def cookies(self) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for ck in self.jar:
            if ck.value:
                out[ck.name] = ck.value
        return out

    def _restore_cookies(self, saved: Dict[str, str]) -> None:
        """把上次保存的 cookie 灌回 jar（按已知域分配，避免污染）。"""
        domains = {
            "hwid_cas_sid": ".id1.cloud.huawei.com",
            "CAS_THEME_NAME": "id1.cloud.huawei.com",
            "VERSION_NO": "id1.cloud.huawei.com",
            "JSESSIONID": "id1.cloud.huawei.com",
            "HuaweiID_CAS_ISCASLOGIN": ".huawei.com",
            "CASLOGINSITE": ".huawei.com",
            "LOGINACCSITE": ".huawei.com",
        }
        for name, value in saved.items():
            if not value:
                continue
            ck = http.cookiejar.Cookie(
                version=0, name=name, value=value, port=None, port_specified=False,
                domain=domains.get(name, ".huaweicloud.com"), domain_specified=True,
                domain_initial_dot=True, path="/", path_specified=True,
                secure=True, expires=None, discard=False, comment=None, comment_url=None,
                rest={}, rfc2109=False,
            )
            try:
                self.jar.set_cookie(ck)
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------
    # ① 引导 / ② 取引导信息
    # ------------------------------------------------------------------
    def _bootstrap(self) -> Dict[str, Any]:
        self._log("[1/9] 打开登录页，建立 WAF 会话 …")
        self._get(LOGIN_PAGE)

        self._log("[2/9] getSDKBaseInfo 取 pageToken / hwidConfig …")
        url = ("https://auth.huaweicloud.com/authui/getSDKBaseInfo?flowType=unionLogin&service="
               + urllib.parse.quote(SERVICE, safe="") + "&_=%d" % int(time.time() * 1000))
        resp = self._get(url)
        try:
            info = json.loads(resp["text"])
        except Exception:  # noqa: BLE001
            return {"isSuccess": 0, "_raw": resp["text"][:400]}
        if info.get("isSuccess") != 1:
            return info

        cfg: Dict[str, Any] = {}
        raw_cfg = info.get("hwidConfig")
        if raw_cfg:
            try:
                cfg = json.loads(urllib.parse.unquote(raw_cfg))
            except Exception:  # noqa: BLE001
                cfg = {}
        self._cversion = cfg.get("cookieVersion") or CVERSION_FALLBACK
        self._local_storage_id = info.get("localStorageID", "") or cfg.get("localStorageID", "")
        self._base = {
            "pageToken": info.get("pageToken", ""),
            "pageTokenKey": info.get("pageTokenKey", ""),
            "reqClientType": str(cfg.get("reqClientType", REQ_CLIENT_TYPE)),
            "loginChannel": str(cfg.get("loginChannel", LOGIN_CHANNEL)),
            "clientID": str(cfg.get("clientID", CLIENT_ID)),
            "lang": info.get("lang", LANG),
            "languageCode": info.get("lang", LANG),
            "state": info.get("state", ""),
        }
        self._config = cfg
        self._log("        pageToken=%s…  cVersion=%s" % (self._base["pageToken"][:16], self._cversion))
        return info

    def _ajax(self, prefix: str, path: str) -> str:
        return "%s/%s?reflushCode=%s&cVersion=%s" % (
            prefix, path, "%.15f" % random.random(), self._cversion)

    # ------------------------------------------------------------------
    # ③ 预热
    # ------------------------------------------------------------------
    def _step_js_remote_login(self) -> Dict[str, Any]:
        self._log("[3/9] jsRemoteLogin 预热（抓包中固定返回 10006003，属正常）…")
        data = dict(self._base)
        data.update({
            "loginUrl": "https://auth.huaweicloud.com/authui/login.html#/hwIDLogin",
            "service": CAS_SERVICE,
            "themeName": THEME_NAME,
            "jsSiteID": "1",
            "scope": SCOPE,
            "client_id": self._base["clientID"],
            "access_type": "offline",
            "regionCode": REGION_CODE,
            "localStorageID": self._local_storage_id,
        })
        return self._post_json(self._ajax(AJAX_NEW, "login/jsRemoteLogin"), data)

    # ------------------------------------------------------------------
    # ④ 设备指纹
    # ------------------------------------------------------------------
    def _step_dev(self, prefix: str = AJAX_NEW, base: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        self._log("[4/9] common/dev 上报设备指纹 …")
        if self._fp is None:
            self._fp = build_fp(self.fp_seed)
        b = dict(base or self._base)
        data = dict(b)
        data.update({"fp": self._fp, "localStorageID": self._local_storage_id})
        if self._hwid_cas_sid:
            data["hwid_cas_sid"] = self._hwid_cas_sid
        res = self._post_json(self._ajax(prefix, "common/dev"), data)
        sid = (res or {}).get("sid") or ""
        if sid:
            self._hwid_cas_sid = sid
        if (res or {}).get("localStorageID"):
            self._local_storage_id = res["localStorageID"]
        self._log("        sid=%s  (已持久化，后续重登可跳过设备验证)" % (sid[:24] + "…" if sid else "<空>"))
        return res

    # ------------------------------------------------------------------
    # ⑤ 健康上报
    # ------------------------------------------------------------------
    def _step_health(self, prefix: str = AJAX_NEW, base: Optional[Dict[str, str]] = None,
                     current_uri: str = "/UnifiedIDMPortal/unionLogin/portal/index.html") -> Dict[str, Any]:
        self._log("[5/9] common/analysisHealth 健康上报 …")
        b = dict(base or self._base)
        message = {
            "currentUri": current_uri,
            "isOpenCookie": "true", "isOpenPerformance": True, "isSupportES6": True,
            "dNSTake": "0", "tCPTake": "0", "reqRespTake": "41", "totalTake": "642",
            "whiteScreenTake": "78", "resourceDataSize": 594103, "domDisplayTake": "287",
            "reqReadyTake": "39", "currentLocaleTime": time.strftime("%Y-%m-%d %H:%M:%S"),
            "resources": [], "extInfo": {"isSwitchWiseContent2SLB": False},
        }
        data = dict(b)
        data.update({
            "operType": "1000", "message": json.dumps(message, ensure_ascii=False),
            "illnessType": "0", "localStorageID": self._local_storage_id,
        })
        if self._hwid_cas_sid:
            data["hwid_cas_sid"] = self._hwid_cas_sid
        return self._post_json(self._ajax(prefix, "common/analysisHealth"), data)

    # ------------------------------------------------------------------
    # ⑥ 账号识别
    # ------------------------------------------------------------------
    @staticmethod
    def normalize_account(account: str) -> str:
        """华为云要求手机号带国家码前缀（抓包中为 `0086` + 手机号）。"""
        acct = account.strip()
        if acct.isdigit() and len(acct) == 11 and acct.startswith("1"):
            return "0086" + acct
        return acct

    def _step_login_ids(self, account: str, password: str) -> Dict[str, Any]:
        self._log("[6/9] getLoginIdsByPwd 识别账号 …")
        data = dict(self._base)
        data.update({
            "userAccount": self.normalize_account(account),
            "password": password,
            "localStorageID": self._local_storage_id,
        })
        if self._hwid_cas_sid:
            data["hwid_cas_sid"] = self._hwid_cas_sid
        return self._post_json(self._ajax(AJAX_NEW, "login/getLoginIdsByPwd"), data)

    # ------------------------------------------------------------------
    # ⑦ 密码登录
    # ------------------------------------------------------------------
    def _step_union_login(self, account: str, password: str,
                          account_info: Optional[Dict[str, Any]] = None,
                          hwmeta: str = "") -> Dict[str, Any]:
        self._log("[7/9] unionLoginByPwd 提交密码 …")
        info = account_info or {}
        data = dict(self._base)
        data.update({
            "userAccount": self.normalize_account(account),
            "password": password,
            "service": CAS_SERVICE,
            "bsAcctService": CAS_SERVICE_APP,
            "hwmeta": hwmeta,
            "opType": "0",
            "scope": SCOPE,
            "access_type": "offline",
            "anonymousLoginID": info.get("anonymousAccount", ""),
            "registerCountry": info.get("countryCode", "CN"),
            "serial": str(info.get("serial", 0)),
            "localStorageID": self._local_storage_id,
        })
        if self._hwid_cas_sid:
            data["hwid_cas_sid"] = self._hwid_cas_sid
        return self._post_json(self._ajax(AJAX_NEW, "login/unionLoginByPwd"), data)

    # ------------------------------------------------------------------
    # ⑧ 新设备验证
    # ------------------------------------------------------------------
    def _step_auth_devices(self) -> Dict[str, Any]:
        """打开 authIdentify 页并取验证设备列表（服务端会同时下发验证码）。"""
        self._log("[8/9] 新设备 → 打开 authIdentify 页，取验证设备列表 …")
        auth_url = ("%s?loginUrl=%s&service=%s&lang=%s&reqClientType=%s&loginChannel=%s"
                    "&clientID=%s&themeName=%s&regionCode=%s&scenesType=0") % (
            AUTH_IDENTIFY_PAGE,
            urllib.parse.quote("https://auth.huaweicloud.com/authui/login.html#/hwIDLogin", safe=""),
            urllib.parse.quote(CAS_SERVICE, safe=""), LANG, REQ_CLIENT_TYPE, LOGIN_CHANNEL,
            CLIENT_ID, THEME_NAME, REGION_CODE)
        self._get(auth_url)

        self._post(self._ajax(AJAX_CAS, "common/getBaseSwitchInfo"),
                   {"themeName": THEME_NAME, "lang": LANG, "supportHarmonyTheme": "false"})

        url_param = ("loginUrl=%s&service=%s&lang=%s&reqClientType=%s&loginChannel=%s&scenesType=0") % (
            urllib.parse.quote("https://auth.huaweicloud.com/authui/login.html#/hwIDLogin", safe=""),
            urllib.parse.quote(CAS_SERVICE, safe=""), LANG, REQ_CLIENT_TYPE, LOGIN_CHANNEL)
        data = {
            "reqClientType": REQ_CLIENT_TYPE, "loginChannel": LOGIN_CHANNEL,
            "clientID": CLIENT_ID, "lang": LANG, "languageCode": LANG,
            "loginUrl": "https://auth.huaweicloud.com/authui/login.html#/hwIDLogin",
            "service": CAS_SERVICE, "scenesType": "0",
            "pageName": "cloudIframeAuthIdentify",
            "interfaceName": "cloudIframeAuthIdentify/getPageInfo",
            "supportHarmonyTheme": "false", "urlParam": url_param,
        }
        res = self._post_json(self._ajax(AJAX_CAS, "cloudIframeAuthIdentify/getPageInfo"),
                              data, referer=auth_url)
        if res.get("isSuccess") != 1:
            return res

        self._auth_base = {
            "pageToken": res.get("pageToken", ""),
            "pageTokenKey": res.get("pageTokenKey", ""),
            "reqClientType": REQ_CLIENT_TYPE, "loginChannel": LOGIN_CHANNEL,
            "clientID": CLIENT_ID, "lang": LANG, "languageCode": LANG,
        }
        # 认证页同样需要 dev + analysisHealth（与服务端状态机一致）
        self._step_dev(prefix=AJAX_CAS, base=self._auth_base)
        self._step_health(prefix=AJAX_CAS, base=self._auth_base,
                          current_uri="/CAS/portal/authIdentify.html")

        desc = (res.get("localInfo") or {}).get("errorDesc", "{}")
        devices = parse_auth_code_sent_list(desc)
        # getPageInfo 若没返回设备列表，保留上一步（10002080 分支）拿到的，避免丢信息
        if devices:
            self._auth_devices = devices
        return res

    def send_verify_code(self, device_index: int = 0) -> LoginResult:
        """取验证设备列表（服务端同时向默认设备发送验证码）。"""
        res = self._step_auth_devices()
        if res.get("isSuccess") != 1:
            return LoginResult(False, error="获取验证设备列表失败", detail=res)
        if not self._auth_devices:
            return LoginResult(False, error="没有可用的验证设备", detail=res)
        if not 0 <= device_index < len(self._auth_devices):
            return LoginResult(False, error="设备序号 %d 越界（共 %d 个）"
                               % (device_index, len(self._auth_devices)))
        self._auth_devices[device_index]["sent"] = 1
        return LoginResult(True, need_verify=True, cookies=self.cookies(),
                           auth_devices=self._auth_devices, detail=res)

    def verify_device(self, verify_code: str) -> LoginResult:
        """提交设备验证码 → 信任本机 → 重新走 OAuth 拿会话。"""
        device = next((d for d in self._auth_devices if d.get("sent") == 1), None) or (
            self._auth_devices[0] if self._auth_devices else None)
        if device is None:
            return LoginResult(False, error="没有可用的验证设备，请先调用 send_verify_code()")

        data = dict(self._auth_base)
        data.update({
            "twoStepVerifyCode": verify_code,
            "verifyAccountType": str(device.get("accountType", -1)),
            "verifyUserAccount": str(device.get("name", "")),
        })
        res = self._post_json(self._ajax(AJAX_CAS, "cloudAuthLogin"), data)
        if res.get("isSuccess") != 1:
            return LoginResult(False, error="验证码校验失败", detail=res)

        # 信任当前浏览器（→ 服务端会把 hwid_cas_sid 记为受信任设备）
        self._post(self._ajax(AJAX_CAS, "updateTrustBrowser"), dict(
            self._auth_base, operType="2", trustBrowser="1"))

        callback = res.get("callbackURL", "")
        if not callback:
            return LoginResult(True, need_verify=False, cookies=self.cookies(), detail=res)

        self._clear_oauth_cookies()
        fin = self._finish_oauth(callback)
        return fin if fin.ok else fin

    # ------------------------------------------------------------------
    # ⑨ 完成 OAuth → 落地业务会话
    # ------------------------------------------------------------------
    @staticmethod
    def _qs(url: str) -> Dict[str, str]:
        return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(url).query).items()}

    def _clear_oauth_cookies(self) -> None:
        """清除上一轮 OAuth 留下的干扰 cookie，避免二次走 OAuth 时串状态。"""
        drop = []
        for ck in self.jar:
            host = (ck.domain or "").lstrip(".")
            if host.endswith("oauth-login.cloud.huawei.com") or host.endswith("oauth-login1.cloud.huawei.com"):
                drop.append(ck)
        for ck in drop:
            try:
                self.jar.clear(ck.domain, ck.path, ck.name)
            except Exception:  # noqa: BLE001
                pass

    def _finish_oauth(self, callback_url: str) -> LoginResult:
        """callbackURL → authorize → getLoginWay → CAS → loginCallback → code → 业务会话。"""
        if not callback_url:
            return LoginResult(False, error="callbackURL 为空")

        # (a) callbackURL：可能是 302 跳到 authorize，也可能本身就是 authorize 页
        resp = self._get(callback_url, allow_redirects=False)
        if resp["status"] in (301, 302, 303, 307, 308):
            authorize_url = resp["headers"].get("Location", "")
            if not authorize_url:
                return LoginResult(False, error="callbackURL 未返回 Location", detail=resp["status"])
        else:
            authorize_url = callback_url
        self._get(authorize_url, allow_redirects=False)

        host = urllib.parse.urlparse(authorize_url).netloc
        params = self._qs(authorize_url)
        if not host or not params.get("ticket"):
            return LoginResult(False, error="authorize URL 解析失败", detail=authorize_url[:200])

        # (b) getLoginWay —— 请求体 = authorize URL 的全部查询参数（抓包实证）
        gw = self._post_json("https://%s/oauth2/ajax/getLoginWay?reflushCode=%s&display=page"
                             % (host, "%.15f" % random.random()), params,
                             origin="https://%s" % host,
                             headers={"interfaceVersion": "v3", "fromLoginAuth": "false"})
        if str(gw.get("isSuccess")) != "true":
            return LoginResult(False, error="getLoginWay 失败", detail=gw)

        sig = gw.get("signatureInfo", {}) or {}
        cas_redirect = ((gw.get("loginInteractInfo") or {}).get("cas") or {}).get("casLoginRedirectUrl", "")
        if not cas_redirect:
            return LoginResult(False, error="未取到 casLoginRedirectUrl", detail=gw)

        # (c) CAS remoteLogin → loginCallback（必须访问该页以建立 OAuth ticket 状态）
        r = self._get(cas_redirect, allow_redirects=False)
        login_callback = r["headers"].get("Location", "") if r["status"] == 302 else r["url"]
        if not login_callback:
            return LoginResult(False, error="CAS 未返回 loginCallback", detail=r["status"])
        self._get(login_callback, allow_redirects=False)

        cb = self._qs(login_callback)
        ticket = cb.get("ticket", "")
        if not ticket:
            return LoginResult(False, error="loginCallback 缺少 ticket", detail=login_callback[:200])

        # (d) oauth2/ajax/login —— 参数 = signatureInfo 全部字段 + ticket/siteID/countryCode
        payload = dict(sig)
        payload.update({"ticket": ticket,
                        "siteID": cb.get("siteID", "1"),
                        "countryCode": cb.get("countryCode", "CN")})
        lr = self._post_json("https://%s/oauth2/ajax/login?reflushCode=%s&display=page"
                             % (host, "%.15f" % random.random()), payload,
                             origin="https://%s" % host,
                             headers={"interfaceVersion": "v3", "fromLoginAuth": "false"})
        if str(lr.get("isSuccess")) != "true":
            return LoginResult(False, error="oauth2/ajax/login 失败", detail=lr)

        code_url = lr.get("code", "")
        if not code_url:
            return LoginResult(False, error="oauth2/ajax/login 未返回 code", detail=lr)

        # (e) 一路跟到 codearts，落地业务会话 cookie
        r1 = self._get(code_url, allow_redirects=False)
        hop = r1["headers"].get("Location", "")
        if hop:
            r2 = self._get(hop, allow_redirects=True)          # → codearts…?ticket=ST-…（发 SESSION_ID）
            if r2["status"] >= 400:
                return LoginResult(False, error="跳转业务域失败", detail=r2["status"])
        self._get(SERVICE, allow_redirects=True)               # → 干净页（发 tcftk）

        cks = self.cookies()
        missing = [n for n in CODEARTS_SESSION_COOKIES if not cks.get(n)]
        if missing:
            return LoginResult(False, error="业务会话 cookie 缺失：%s" % ", ".join(missing),
                               cookies=cks)
        return LoginResult(True, need_verify=False, cookies=cks)

    # ------------------------------------------------------------------
    # 探活：确认会话真的可用（不只看状态码）
    # ------------------------------------------------------------------
    def check_session(self) -> Dict[str, Any]:
        """请求一个只读业务接口，按 `HW-AJAX-REDIRECT` 判定会话是否有效。"""
        cks = self.cookies()
        url = ("https://codearts.huaweicloud.com/portal/snap-manager/v1/credit/has-claimed"
               "?_=%d" % int(time.time() * 1000))
        headers = {
            "Accept": "application/json, text/plain, */*",
            "x-requested-with": "XMLHttpRequest",
            "language": "zh-cn", "x-language": "zh-cn",
            "referer": SERVICE,
        }
        if cks.get("devclouddevuibjtcftk"):
            headers["cftk"] = cks["devclouddevuibjtcftk"]
        headers["Cookie"] = "; ".join("%s=%s" % (k, v) for k, v in cks.items())
        req = urllib.request.Request(url, headers=headers)
        try:
            with self._opener.open(req, timeout=self._timeout) as resp:
                status, body, hdrs = resp.status, resp.read().decode("utf-8", "replace"), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            status, body, hdrs = exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)
        except Exception as exc:  # noqa: BLE001
            return {"valid": False, "error": str(exc)}

        redirect = ""
        for k, v in hdrs.items():
            if k.lower() == EXPIRY_HEADER:
                redirect = v
        return {"valid": not redirect, "status": status, "hwAjaxRedirect": redirect,
                "body": body[:200]}

    # ------------------------------------------------------------------
    # 顶层：登录
    # ------------------------------------------------------------------
    def login(self, account: str, password: str, *,
              cookies: Optional[Dict[str, str]] = None,
              hwmeta: str = "") -> LoginResult:
        """账号密码登录。

        返回 `need_verify=True` 时，调用 `send_verify_code()` 取设备列表，
        再调用 `verify_device(code)` 提交验证码。
        """
        if cookies:
            self._restore_cookies(cookies)
            self._hwid_cas_sid = cookies.get("hwid_cas_sid", "") or self._hwid_cas_sid

        info = self._bootstrap()
        if info.get("isSuccess") != 1:
            return LoginResult(False, error="getSDKBaseInfo 失败", detail=info)
        if not self._base.get("pageToken"):
            return LoginResult(False, error="未取到 pageToken", detail=info)

        self._step_js_remote_login()          # 失败属正常
        dev = self._step_dev()
        self._step_health()

        ids = self._step_login_ids(account, password)
        account_info: Dict[str, Any] = {}
        if ids.get("isSuccess") == 1:
            lst = ids.get("accountInfoList") or []
            account_info = lst[0] if lst else {}
        else:
            code = ids.get("errorCode", "")
            if code == "10000400":
                return LoginResult(False, error="账号或密码错误", detail=ids)
            if code == "10000201":
                return LoginResult(False, error="需要图片验证码（10000201），当前实现未接入", detail=ids)
            # 其它错误（如风控）不阻断，继续尝试 unionLoginByPwd
            self._log("        getLoginIdsByPwd 返回 %s，继续尝试 unionLoginByPwd" % code)

        login = self._step_union_login(account, password, account_info, hwmeta=hwmeta)

        # ★ 新设备分支 A：isSuccess=0 + errorCode=10002080
        #   实测（不带受信 hwid_cas_sid）：服务端不返回 callbackURL，而是把
        #   「已下发验证码的设备列表」塞进 errorDesc 的 JSON 串里。
        #   必须与分支 B（needPopTrust=true，见下）一并支持。
        if login.get("isSuccess") != 1:
            code_err = str(login.get("errorCode") or "")
            if code_err in NEED_VERIFY_CODES:
                self._auth_devices = parse_auth_code_sent_list(login.get("errorDesc"))
                self._log("        unionLoginByPwd 返回 %s → 本机是新设备，需要设备验证"
                          % code_err)
                if self._auth_devices:
                    self._log("        服务端已向以下设备下发验证码：%s" % ", ".join(
                        "%s(accountType=%s,sent=%s)" % (d.get("name"), d.get("accountType"),
                                                        d.get("sent"))
                        for d in self._auth_devices))
                return LoginResult(True, need_verify=True, cookies=self.cookies(),
                                   auth_devices=self._auth_devices, detail=login)
            err = login.get("errorDesc") or login.get("errorCode") or "未知错误"
            return LoginResult(False, error="密码登录失败：%s" % err, detail=login)

        callback = login.get("callbackURL", "")
        need_verify = bool(login.get("needPopTrust", False))

        fin = self._finish_oauth(callback)
        if not fin:
            return fin
        if not need_verify:
            return fin

        self._log("        needPopTrust=true → 本机是新设备，需要设备验证")
        return LoginResult(True, need_verify=True, cookies=fin.cookies)


# ==========================================================================
# 会话文件
# ==========================================================================

def save_session(login: CodeArtsLogin, path: str) -> None:
    data = {
        "savedAt": int(time.time()),
        "hwid_cas_sid": login._hwid_cas_sid,          # ★ 设备信任令牌，务必保留
        "localStorageID": login._local_storage_id,
        "fp": login._fp,
        "fpSeed": login.fp_seed,
        "cookies": login.cookies(),
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)


def load_session(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ==========================================================================
# 自检：指纹算法可离线复现（用抓包里的真实 fp 反查）
# ==========================================================================

def selftest(capture_dir: Optional[str] = None) -> int:
    """校验 XOR+Base64+SHA1 指纹算法。"""
    ok = True

    # 1) XOR 加解密往返
    #    注意：算法按字节(0-255)运算，输入必须是单字节字符（fp 正文恒为 ASCII/百分号编码）。
    xor_ok = True
    for probe in ("hello world", "a" * 300, "".join(chr(i) for i in range(1, 256)),
                  "bsh=856&bsw=1496&epls=P1%2CC2&cs=deadbeef"):
        if _xor_decrypt(_xor_encrypt(probe)) != probe:
            print("✗ XOR 往返失败：%r" % probe[:24])
            ok = xor_ok = False
    if xor_ok:
        print("✓ XOR 加解密往返一致（含 1–255 全字节集）")

    # 2) 往返：build_fp → decode_fp → 校验 cs
    fp = build_fp("selftest-seed", now_ms=1789015082237)
    body = decode_fp(fp)
    pre, _, cs = body.rpartition("&cs=")
    if _sha1(pre) != cs:
        print("✗ 自生成 fp 的 cs 校验失败")
        ok = False
    else:
        print("✓ 自生成 fp：长度 %d，cs=SHA1 校验通过" % len(fp))
        print("  " + body)

    # 3) 若给了抓包目录，用抓包里的真实 fp 逐字节对拍
    if capture_dir and os.path.isdir(capture_dir):
        hits = [d for d in os.listdir(capture_dir) if d.startswith("073_")]
        if hits:
            p = os.path.join(capture_dir, hits[0], "请求体.txt")
            raw = open(p, encoding="utf-8", errors="replace").read()
            flat = raw.replace("\r\n", "&").replace("\n", "&")
            real_fp = dict(urllib.parse.parse_qsl(flat, keep_blank_values=True)).get("fp", "")
            real_body = decode_fp(real_fp)
            rpre, _, rcs = real_body.rpartition("&cs=")
            if not real_fp or _sha1(rpre) != rcs:
                print("✗ 抓包 fp 反解失败")
                ok = False
            else:
                print("✓ 抓包 fp 反解成功：长度 %d，cs=SHA1 校验通过" % len(real_fp))
                # 用抓包中已排好序的字段重新拼接，再套同一套 cs + XOR + Base64，
                # 应与原 fp 逐字节相同
                pairs = [kv.split("=", 1) for kv in rpre.split("&") if "=" in kv]
                serialized = "&".join("%s=%s" % (k, v) for k, v in sorted(pairs))
                rebuilt = base64.b64encode(
                    _xor_encrypt(serialized + "&cs=" + _sha1(serialized)).encode("latin-1")).decode("ascii")
                if rebuilt == real_fp:
                    print("✓ 逐字节重建一致（证明算法与字段顺序均正确）")
                else:
                    print("✗ 重建结果与抓包不一致")
                    ok = False
                # 再验证 _serialize() 的编码风格：抓包里的值是 encodeURIComponent 结果，
                # 先 unquote 还原成原始值，再交给 _serialize() 重新编码，应完全等价
                kv = {k: urllib.parse.unquote(v) for k, v in pairs}
                if _serialize(kv) != serialized:
                    print("✗ _serialize() 编码风格与抓包不一致")
                    print("   抓包: %s" % serialized[:160])
                    print("   本模块: %s" % _serialize(kv)[:160])
                    ok = False
                else:
                    print("✓ _serialize() 编码风格与浏览器 encodeURIComponent 一致")

    print("自检结果：%s" % ("全部通过" if ok else "存在失败项"))
    return 0 if ok else 1


# ==========================================================================
# CLI
# ==========================================================================

def _print_devices(devices: List[Dict[str, Any]]) -> None:
    print("\n可用验证设备：")
    for i, d in enumerate(devices):
        mark = "*" if d.get("sent") == 1 else " "
        print("  %s [%d] %-18s accountType=%s" % (
            mark, i, d.get("name", "<未知>"), d.get("accountType", "-")))
    print("（华为云已向其中一台发送验证码）")


def _wait_for_code(path: str, timeout: int) -> Optional[str]:
    """轮询读取验证码文件（供后台/非交互运行使用）。

    为何需要：服务端在 `cloudIframeAuthIdentify/getPageInfo` 时**才**下发验证码，
    所以验证码必须在「本次运行的 send_verify_code() 之后」提交 ——
    把码写进文件、由本函数取走，是唯一能跨进程又不重发验证码的方式。
    """
    print("\n等待验证码：请把收到的验证码写入 %s" % path)
    waited = 0
    while waited < timeout:
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    val = fh.read().strip()
            except Exception:  # noqa: BLE001
                val = ""
            if val:
                print("已读到验证码，提交中 …")
                return val
        time.sleep(2)
        waited += 2
        if waited % 30 == 0:
            print("  …已等待 %d 秒（超时 %d 秒）" % (waited, timeout))
    return None


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="CodeArts（华为云）登录 + 新设备验证")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="账号密码登录")
    p_login.add_argument("--account", required=True, help="手机号或华为账号")
    p_login.add_argument("--password", default=None, help="密码（省略则交互输入）")
    p_login.add_argument("--session", default=".codearts_session.json", help="会话保存路径")
    p_login.add_argument("--code", default=None,
                         help="设备验证码（注意：本次运行仍会重新下发一条验证码，"
                              "仅当你能立刻提供刚收到的码时使用）")
    p_login.add_argument("--code-file", default=None,
                         help="★推荐：非交互运行，轮询该文件获取验证码（不重发）")
    p_login.add_argument("--code-timeout", type=int, default=900, help="等待验证码最长秒数")
    p_login.add_argument("--device-index", type=int, default=0, help="选择第几个验证设备")
    p_login.add_argument("--hwmeta", default="", help="风控 hwmeta（默认空串）")
    p_login.add_argument("--fp-seed", default="codearts-checkin", help="设备指纹种子（同一台机器固定）")
    p_login.add_argument("--no-verify-tls", action="store_true")

    p_check = sub.add_parser("check", help="用已保存会话探活")
    p_check.add_argument("--session", default=".codearts_session.json")

    p_self = sub.add_parser("selftest", help="离线校验指纹算法")
    p_self.add_argument("--capture", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                          "codearts2_解析结果"))

    args = ap.parse_args(argv)

    if args.cmd == "selftest":
        return selftest(args.capture)

    if args.cmd == "check":
        sess = load_session(args.session)
        lg = CodeArtsLogin(verbose=False)
        lg._restore_cookies(sess.get("cookies", {}))
        lg._hwid_cas_sid = sess.get("hwid_cas_sid", "")
        res = lg.check_session()
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0 if res.get("valid") else 2

    # ---- login ----
    password = args.password
    if password is None:
        password = getpass.getpass("华为云密码: ")

    saved = None
    if os.path.exists(args.session):
        try:
            saved = load_session(args.session)
            print("检测到已有会话文件 %s，将复用设备信任令牌 hwid_cas_sid" % args.session)
        except Exception:  # noqa: BLE001
            saved = None

    lg = CodeArtsLogin(verify_tls=not args.no_verify_tls, fp_seed=args.fp_seed)
    if saved:
        lg._fp = saved.get("fp") or None
        lg._local_storage_id = saved.get("localStorageID", "")
        lg._hwid_cas_sid = saved.get("hwid_cas_sid", "")

    res = lg.login(args.account, password,
                   cookies=(saved or {}).get("cookies"), hwmeta=args.hwmeta)

    if not res:
        print("\n✗ 登录失败：%s" % res.error)
        if res.detail:
            print("  detail: %s" % json.dumps(res.detail, ensure_ascii=False)[:500])
        # ★ 失败也要落盘：hwid_cas_sid 是 10 年有效的设备信任令牌，
        #   保住它，下次重试就可能直接命中受信设备、跳过验证。
        if lg._hwid_cas_sid:
            save_session(lg, args.session)
            print("  已保存设备信任令牌 hwid_cas_sid 到 %s（下次重登可跳过设备验证）" % args.session)
        return 1

    if res.need_verify:
        code = args.code
        if not code:
            vr = lg.send_verify_code(device_index=args.device_index)
            if not vr:
                print("\n✗ 取验证设备失败：%s" % vr.error)
                if lg._hwid_cas_sid:
                    save_session(lg, args.session)
                return 1
            _print_devices(vr.auth_devices)
            if args.code_file:
                code = _wait_for_code(args.code_file, args.code_timeout)
                if not code:
                    print("\n✗ 等待验证码超时")
                    if lg._hwid_cas_sid:
                        save_session(lg, args.session)
                    return 4
            elif not sys.stdin.isatty():
                # 非交互环境（CI / 脚本调用）：不能阻塞在 input()。
                # 保存 hwid_cas_sid 后退出，调用方拿验证码再用 --code-file 重跑。
                if lg._hwid_cas_sid:
                    save_session(lg, args.session)
                print("\n⚠ 需要设备验证码，但当前不是交互终端。")
                print("  请改用：python codearts_login.py login --account %s --code-file <文件>"
                      % args.account)
                return 4
            else:
                code = input("请输入设备上收到的验证码: ").strip()
        else:
            lg.send_verify_code(device_index=args.device_index)
        res = lg.verify_device(code)
        if not res:
            print("\n✗ 设备验证失败：%s" % res.error)
            if res.detail:
                print("  detail: %s" % json.dumps(res.detail, ensure_ascii=False)[:500])
            if lg._hwid_cas_sid:
                save_session(lg, args.session)
                print("  已保存设备信任令牌 hwid_cas_sid 到 %s" % args.session)
            return 1

    save_session(lg, args.session)
    print("\n✓ 登录成功，会话已保存到 %s" % args.session)
    print("  业务 cookie: %s" % ", ".join(
        "%s=%s…" % (n, (res.cookies.get(n) or "")[:12]) for n in CODEARTS_SESSION_COOKIES))

    probe = lg.check_session()
    print("  会话探活: %s" % ("有效 ✓" if probe.get("valid") else "无效 ✗ %s" % probe))
    return 0 if probe.get("valid") else 3


if __name__ == "__main__":
    sys.exit(main())
