#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
codearts_test.py —— CodeArts（码道 / CodeArts Agent）签到接口可用性实测

抓包来源：examples/codearts_解析结果（2026-09-08，Edge 浏览器）
关键端点：
    GET  /portal/snap-manager/v1/credit/has-claimed?_=<ts>   -> 原始 JSON 布尔
    POST /portal/snap-manager/v1/credit/claim                -> 原始 JSON 布尔
         body {"credit_type": "daily_bonus"}

鉴权形态：纯 Cookie + cftk 头（华为云 WAF / APISIX 前置），无 Bearer。

凭证来源（二选一）：
  1. 抓包模板（默认）—— 从 codearts_解析结果/036_..._credit_claim/请求.txt 读 cookie/cftk
  2. 实时登录会话 —— `--session .codearts_session.json`
     由 codearts_login.py 生成（账号密码登录 + 新设备验证），cookie 是新鲜的
     ```bash
     python codearts_login.py login --account 173xxxx --password '***'
     python codearts_test.py --session .codearts_session.json
     ```

安全性：
  · 阶段 1 全部只读（has-claimed / package_overview / rest/me）
  · 阶段 2 仅在「has-claimed = false」时才调用 claim —— 这是每日一次的可重复动作，
    成功即领取当日签到积分，属于用户本人账号的正常行为，不会造成数据破坏。

输出：examples/_test_results_codearts.txt 、 examples/_evidence_codearts.json
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(BASE, "codearts_解析结果")
HOST = "https://codearts.huaweicloud.com"

# 以 claim 请求为模板（头最完整）
TEMPLATE = os.path.join(
    SRC_DIR, "036_POST https___codearts.huaweicloud.com_portal_snap-manager_v1_credit_claim", "请求.txt"
)

CTX = ssl.create_default_context()
log, evidence = [], {"cases": []}


def parse_headers(path):
    raw = open(path, encoding="utf-8", errors="replace").read()
    # 抓包行分隔符可能是 \n 或 \r\n 或 \n\n
    lines = re.split(r"[\r\n]+", raw)
    out = {}
    for ln in lines:
        if not ln or ln.startswith(("GET ", "POST ", "HTTP/", ":")):
            continue
        if ":" in ln:
            k, v = ln.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


H = parse_headers(TEMPLATE)
COOKIE = H.get("cookie", "")
CFTK = H.get("cftk", "")
CRED_SOURCE = "capture(2026-09-08)"


def use_session(path):
    """用 codearts_login.py 产出的会话文件替换抓包凭证。

    会话文件里的 cookie 是刚登录得到的新鲜值；`cftk` 头取 cookie
    `devclouddevuibjtcftk`（实测两者恒等）。
    """
    global COOKIE, CFTK, CRED_SOURCE
    with open(path, encoding="utf-8") as fh:
        sess = json.load(fh)
    cks = sess.get("cookies", {})
    COOKIE = "; ".join("%s=%s" % (k, v) for k, v in cks.items() if v)
    CFTK = cks.get("devclouddevuibjtcftk", "")
    age = int(time.time()) - int(sess.get("savedAt", 0))
    CRED_SOURCE = "session(%s，%d 秒前登录)" % (os.path.basename(path), age)
    return sess



def call(label, method, path, body=None, note="", use_cookie=True):
    url = HOST + path
    headers = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/json",
        "language": "zh-cn",
        "x-language": "zh-cn",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": H.get("user-agent", "Mozilla/5.0"),
        "referer": "https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn",
    }
    if CFTK:
        headers["cftk"] = CFTK
    if use_cookie:
        headers["cookie"] = COOKIE

    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    t0 = time.time()
    resp_headers, redirect_hint = {}, None
    try:
        with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
            code, text = r.status, r.read().decode("utf-8", "replace")
            resp_headers = dict(r.headers)
    except urllib.error.HTTPError as e:
        code, text = e.code, e.read().decode("utf-8", "replace")
        resp_headers = dict(e.headers)
    except Exception as e:  # noqa: BLE001
        code, text = -1, f"<{type(e).__name__}: {e}>"
    ms = int((time.time() - t0) * 1000)

    # ★ 关键：华为云在「登录态失效」时不改 HTTP 状态码，而是下发
    #   HW-AJAX-REDIRECT 头（HTTP 200 + 空响应体）。必须据此判定，不能只看状态码。
    for k, v in resp_headers.items():
        if k.lower() == "hw-ajax-redirect":
            redirect_hint = v

    try:
        payload = json.loads(text)
    except Exception:  # noqa: BLE001
        payload = None

    shown = json.dumps(payload, ensure_ascii=False) if payload is not None else (text or "<空响应体>")
    log.append(f"  {method:5} {path.split('?')[0]:<52} -> HTTP {code}  ({ms}ms)")
    log.append(f"        {shown[:260]}")
    if redirect_hint:
        log.append(f"        ⚠ 登录态失效：HW-AJAX-REDIRECT = {redirect_hint}")
    if note:
        log.append(f"        note: {note}")
    evidence["cases"].append(
        {
            "label": label,
            "method": method,
            "url": url,
            "http": code,
            "ms": ms,
            "session_expired": bool(redirect_hint),
            "hw_ajax_redirect": redirect_hint,
            "response": payload if payload is not None else text[:600],
            "note": note,
        }
    )
    return code, payload


def main():
    ts = lambda: int(time.time() * 1000)  # noqa: E731

    log.append("=" * 82)
    log.append("CodeArts 签到接口可用性实测")
    log.append(f"凭证来源: {CRED_SOURCE}")
    log.append(f"cookie 长度: {len(COOKIE)}  |  cftk: {(CFTK or '<无>')[:20]}...")
    log.append("=" * 82)

    # ---- 阶段 1：只读 ---------------------------------------------------
    log.append("\n【阶段 1】只读探测")
    c_auth, _ = call("负向-无Cookie", "GET", f"/portal/snap-manager/v1/credit/has-claimed?_={ts()}",
                     note="验证 Cookie 鉴权确实生效", use_cookie=False)

    c1, claimed = call("has-claimed", "GET", f"/portal/snap-manager/v1/credit/has-claimed?_={ts()}",
                       note="今日是否已领取每日签到积分")

    call("package_overview", "GET", f"/portal/snap-manager/v1/package_overview?_={ts()}",
         note="积分包总览（可用额度来源）")

    call("rest/me", "GET", f"/portal/rest/me?_={ts()}", note="当前用户身份与角色")

    call("package_info", "GET", f"/portal/snap-manager/v1/package_info?_={ts()}", note="套餐信息")

    # ---- 阶段 2：条件写入 ------------------------------------------------
    log.append("\n【阶段 2】每日签到领取（条件执行）")
    expired = any(c.get("session_expired") for c in evidence["cases"])
    if expired:
        log.append("  ⚠ 当前 Cookie 会话已失效（抓包于 2026-09-08，实测 2026-09-10）")
        log.append("    -> 跳过 claim 写入；接口行为以抓包实证为准：")
        log.append("       capture 017  GET  /credit/has-claimed  -> false")
        log.append("       capture 036  POST /credit/claim {credit_type:daily_bonus} -> true")
        log.append("       capture 063  GET  /credit/has-claimed  -> true")
        evidence["summary"] = {
            "session_expired": True,
            "live_claim_skipped": True,
            "capture_evidence": {
                "has_claimed_before": False,
                "claim_request": {"credit_type": "daily_bonus"},
                "claim_response": True,
                "has_claimed_after": True,
            },
        }
    elif c1 == 200 and claimed is False:
        log.append("  has-claimed=false -> 今日未领取，执行 claim")
        c2, ok = call("credit/claim", "POST", "/portal/snap-manager/v1/credit/claim",
                      body=json.dumps({"credit_type": "daily_bonus"}),
                      note="领取每日签到积分（daily_bonus）")
        c3, claimed2 = call("has-claimed(复查)", "GET",
                            f"/portal/snap-manager/v1/credit/has-claimed?_={ts()}",
                            note="确认状态已翻转")
        call("package_overview(复查)", "GET", f"/portal/snap-manager/v1/package_overview?_={ts()}",
             note="确认积分已入账")
        evidence["summary"] = {"claimed_before": claimed, "claim_response": ok,
                               "claimed_after": claimed2, "claim_http": c2}
    elif c1 == 200:
        log.append(f"  has-claimed={claimed} -> 今日已领取，跳过写入（幂等安全）")
        evidence["summary"] = {"claimed_before": claimed, "skipped": True}
    else:
        log.append(f"  has-claimed 未能确认（HTTP {c1}）-> 跳过写入")
        evidence["summary"] = {"error_http": c1}

    ok = sum(1 for c in evidence["cases"] if c["http"] == 200)
    log.append("\n" + "=" * 82)
    log.append(f"HTTP 200 用例: {ok} / {len(evidence['cases'])}")
    log.append("=" * 82)

    with open(os.path.join(BASE, "_test_results_codearts.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(log) + "\n")
    with open(os.path.join(BASE, "_evidence_codearts.json"), "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, ensure_ascii=False, indent=2)

    print("\n".join(log))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="CodeArts 签到接口可用性实测")
    ap.add_argument("--session", default=None,
                    help="用 codearts_login.py 生成的会话文件替代抓包凭证（推荐）")
    args = ap.parse_args()
    if args.session:
        use_session(args.session)
    sys.exit(main())
