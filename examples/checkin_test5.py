#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
checkin_test5.py —— WorkBuddy web 侧收尾验证（含凭证形态更正）

本脚本产生两项**对旧文档的更正**：

【更正 1】web 侧凭证不是单个 session cookie，而是 session + session_2 成对
  实测 /activity/growth/streak：
      session        -> 401
      session_2      -> 401
      session+tgw_l7_route            -> 401
      session+ww_device_nonce         -> 401
      session+session_2               -> 200  ★
      tgw_l7_route only               -> 401
  结论：APISIX 要求 session 与 session_2 同时存在；tgw_l7_route / ww_device_nonce 非必需。
  → 旧文档 §1.3 / §6.2「带 session Cookie 即可」不完整，Provider 的 SessionStore
    必须同时持久化 session 与 session_2。

【更正 2】cookie 第二段 unix 过期时间不可作为有效性依据
  workbuddy_解析结果（09-07）的 session 第二段 = 1789403935（2026-09-14，尚未到期），
  但实测 401。根因：workbuddy2_解析结果/176 是一次显式
      GET /console/logout -> set-cookie: session=; Max-Age=0   (2026-09-08)
  即服务端已吊销。→ 必须实探，不能只看时间戳。

安全性：仅只读 GET + 诊断性 POST，不做任何领取/兑换写操作。
输出：examples/_test_results5.txt 、 examples/_evidence5.json
"""

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = "https://www.workbuddy.cn"
# workbuddy3 抓包中最新的 web 会话（2026-09-10 登录，session 段 exp 2026-09-17）
SRC = os.path.join(
    BASE, "workbuddy3_解析结果", "090_GET https___www.workbuddy.cn_console_account", "请求.txt"
)

CTX = ssl.create_default_context()
log, evidence = [], {"cases": []}


def load():
    raw = open(SRC, encoding="utf-8", errors="replace").read()

    def hdr(n):
        m = re.search(r"(?:^|\n)\s*" + n + r":\s*([^\n]+)", raw, re.I)
        return m.group(1).strip() if m else None

    jar = {}
    for kv in (hdr("cookie") or "").split(";"):
        kv = kv.strip()
        if "=" in kv:
            k, v = kv.split("=", 1)
            jar[k] = v
    return jar, hdr("user-agent") or "Mozilla/5.0"


JAR, UA = load()
# 实测得出的最小凭证：session + session_2
CRED = f"session={JAR.get('session','')}; session_2={JAR.get('session_2','')}"
FULL = "; ".join(f"{k}={v}" for k, v in JAR.items())


def call(label, method, path, cookie=CRED, body=None, note=""):
    url = WEB + path
    headers = {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": UA,
        "Cookie": cookie,
        "x-client-platform": "web",
        "referer": "https://www.workbuddy.cn/profile/growth-center",
        "x-requested-with": "XMLHttpRequest",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
            code, text = r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        code, text = e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        code, text = -1, f"<{type(e).__name__}: {e}>"

    try:
        payload = json.loads(text)
    except Exception:  # noqa: BLE001
        payload = None

    shown = json.dumps(payload, ensure_ascii=False) if payload is not None else text
    log.append(f"  {method:5} {path:<46} -> HTTP {code}")
    log.append(f"        {shown[:230]}")
    if note:
        log.append(f"        note: {note}")
    evidence["cases"].append(
        {
            "label": label,
            "method": method,
            "url": url,
            "http": code,
            "response": payload if payload is not None else text[:600],
            "note": note,
        }
    )
    return code, payload


def main():
    log.append("=" * 80)
    log.append("WorkBuddy web 侧收尾验证（凭证来源 workbuddy3_解析结果/090）")
    log.append("=" * 80)

    # ---- [A] 凭证形态定位 ------------------------------------------------
    log.append("\n[A] 凭证形态定位：哪一个 cookie 组合是必需的？")
    probes = [
        ("仅 session", f"session={JAR.get('session','')}"),
        ("仅 session_2", f"session_2={JAR.get('session_2','')}"),
        ("session + tgw_l7_route", f"session={JAR.get('session','')}; tgw_l7_route={JAR.get('tgw_l7_route','')}"),
        ("session + ww_device_nonce", f"session={JAR.get('session','')}; ww_device_nonce={JAR.get('ww_device_nonce','')}"),
        ("session + session_2  ★", CRED),
        ("全量 cookie jar", FULL),
    ]
    for note, ck in probes:
        call(f"凭证定位-{note}", "GET", "/activity/growth/streak", cookie=ck)

    # ---- [B] growth 只读接口复核 ----------------------------------------
    log.append("\n[B] growth 只读接口复核（旧文档 §6 结论是否仍成立）")
    call("streak", "GET", "/activity/growth/streak", note="连续签到核心")
    call("energy", "GET", "/activity/growth/energy", note="能量余额")
    call("redeem/summary", "GET", "/activity/growth/redeem/summary", note="档位领取状态")
    call("v2/profile", "GET", "/v2/activity/growth/profile", note="成长档案")
    call("lottery/chances", "GET", "/activity/growth/lottery/chances", note="抽奖机会")

    # ---- [C] 旧文档猜测路径的真实返回 -----------------------------------
    log.append("\n[C] 旧文档猜测路径的真实返回（带有效凭证，排除鉴权干扰）")
    call("旧猜测-checkin", "POST", "/activity/growth/checkin", body="{}",
         note="旧文档推测的每日签到路径")
    call("旧猜测-sign", "POST", "/activity/growth/sign", body="{}", note="旧文档推测的备选路径")

    # ---- [D] 真实路径挂到 www 域 ----------------------------------------
    log.append("\n[D] daily-checkin 真实路径挂到 www 域（验证是否域内特有）")
    call("meter@www-读", "POST", "/v2/billing/meter/checkin-activity-status", body="{}",
         note="真实读接口在 copilot.tencent.com")
    call("meter@www-写", "POST", "/v2/billing/meter/daily-checkin", body="{}",
         note="真实写接口在 copilot.tencent.com")

    # ---- 汇总 -----------------------------------------------------------
    ok = sum(1 for c in evidence["cases"] if c["http"] == 200)
    log.append("\n" + "=" * 80)
    log.append(f"HTTP 200 用例: {ok} / {len(evidence['cases'])}")
    log.append("=" * 80)

    with open(os.path.join(BASE, "_test_results5.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(log) + "\n")
    with open(os.path.join(BASE, "_evidence5.json"), "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, ensure_ascii=False, indent=2)

    print("\n".join(log))
    return 0


if __name__ == "__main__":
    sys.exit(main())
