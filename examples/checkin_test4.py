#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
checkin_test4.py —— WorkBuddy 双访问路径交叉验证 + 旧 404 根因定位

目的
----
checkin平台全流程方案.md §2.2-3 / §6.3 记录：旧文档曾推测每日签到端点为
    POST https://www.workbuddy.cn/activity/growth/checkin
并因 404 错误地推断「签到写接口不存在」。

workbuddy3 抓包证明真实端点位于 **另一个域**：
    POST https://copilot.tencent.com/v2/billing/meter/daily-checkin

本脚本用实测回答三个问题：
  Q1 旧猜测路径在 www.workbuddy.cn 上确实不存在？（复现 404）
  Q2 web session cookie 能否调用 copilot.tencent.com 的签到接口？（跨路径鉴权）
  Q3 copilot 的 Bearer JWT 需要哪些配套请求头？（Provider 落地所需）

安全性
------
全部为只读调用或必然失败的诊断调用；daily-checkin 若意外成功也只会返回
「今天已签到」而不产生副作用。

输出：examples/_test_results4.txt 、 examples/_evidence4.json
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
COPILOT = "https://copilot.tencent.com"

WEB_SRC = os.path.join(
    BASE, "workbuddy_解析结果", "209_GET https___www.workbuddy.cn_activity_growth_streak", "请求.txt"
)
DESK_SRC = os.path.join(
    BASE,
    "workbuddy3_解析结果",
    "182_POST copilot.tencent.comhttps___copilot.tencent.com_v2_billing_meter_daily-checkin",
    "请求.txt",
)

CTX = ssl.create_default_context()
log, evidence = [], {"cases": []}


def header_of(path, name, default=None):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    m = re.search(rf"^{name}:\s*(.+?)\s*$", raw, re.M | re.I)
    return m.group(1) if m else default


def cookie_of(path):
    raw = header_of(path, "cookie", "") or ""
    m = re.search(r"session=[^;]+", raw)
    return m.group(0) if m else ""


def call(label, method, url, headers, body=None, note=""):
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

    log.append(f"  {method} {url}")
    log.append(f"    -> HTTP {code}  {json.dumps(payload, ensure_ascii=False)[:200] if payload is not None else text[:150]}")
    if note:
        log.append(f"    note: {note}")
    evidence["cases"].append(
        {
            "label": label,
            "method": method,
            "url": url,
            "http": code,
            "response": payload if payload is not None else text[:800],
            "note": note,
        }
    )
    return code, payload


def main():
    web_session = cookie_of(WEB_SRC)
    bearer = header_of(DESK_SRC, "Authorization")
    user_id = header_of(DESK_SRC, "X-User-Id")
    device_token = header_of(DESK_SRC, "X-Device-Token")

    if not web_session or not bearer:
        raise SystemExit("[FATAL] 未能提取凭证")

    log.append("=" * 76)
    log.append("WorkBuddy 双路径交叉验证 —— 旧 404 根因定位")
    log.append("=" * 76)

    # ---- Q1: 旧猜测路径是否真的 404 ------------------------------------
    log.append("\n[Q1] 旧文档推测的每日签到路径（www.workbuddy.cn）")
    call(
        "Q1-旧猜测路径",
        "POST",
        f"{WEB}/activity/growth/checkin",
        {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Cookie": web_session,
            "x-client-platform": "web",
            "referer": "https://www.workbuddy.cn/profile/growth-center",
        },
        body="{}",
        note="复现旧文档的 404，作为对照",
    )
    call(
        "Q1-对照-已知可用",
        "GET",
        f"{WEB}/activity/growth/streak",
        {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Cookie": web_session,
            "x-client-platform": "web",
            "referer": "https://www.workbuddy.cn/profile/growth-center",
        },
        note="同域已知可用接口，证明 session 仍有效、404 并非凭证问题",
    )

    # ---- Q2: web session 能否打通 copilot 域 ---------------------------
    log.append("\n[Q2] 用 web session cookie 调用 copilot.tencent.com 签到接口")
    call(
        "Q2-跨域-session",
        "POST",
        f"{COPILOT}/v2/billing/meter/checkin-activity-status",
        {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "axios/1.16.1",
            "Cookie": web_session,
            "X-Domain": "copilot.tencent.com",
            "X-User-Id": user_id,
        },
        body="{}",
        note="验证两条路径鉴权是否互通（预期 401）",
    )
    call(
        "Q2-跨域-www路径",
        "POST",
        f"{WEB}/v2/billing/meter/checkin-activity-status",
        {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
            "Cookie": web_session,
            "x-client-platform": "web",
        },
        body="{}",
        note="同样的 meter 路径挂到 www 域，验证是否为域内特有路由",
    )

    # ---- Q3: Bearer 需要哪些配套头 --------------------------------------
    log.append("\n[Q3] copilot Bearer 鉴权的最小请求头集合")
    full = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "axios/1.16.1",
        "Authorization": bearer,
        "X-User-Id": user_id,
        "X-Domain": "copilot.tencent.com",
        "X-Device-Token": device_token,
    }
    call(
        "Q3-仅Bearer",
        "POST",
        f"{COPILOT}/v2/billing/meter/checkin-activity-status",
        {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "axios/1.16.1",
            "Authorization": bearer,
        },
        body="{}",
        note="仅 Authorization，判断 X-User-Id/X-Device-Token 是否必需",
    )
    call(
        "Q3-Bearer+XUserId",
        "POST",
        f"{COPILOT}/v2/billing/meter/checkin-activity-status",
        {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "axios/1.16.1",
            "Authorization": bearer,
            "X-User-Id": user_id,
            "X-Domain": "copilot.tencent.com",
        },
        body="{}",
        note="Bearer + X-User-Id，判断 X-Device-Token 是否必需",
    )
    call("Q3-完整头", "POST", f"{COPILOT}/v2/billing/meter/checkin-activity-status", full, body="{}",
         note="完整头，作为正对照")

    txt = os.path.join(BASE, "_test_results4.txt")
    with open(txt, "w", encoding="utf-8") as fh:
        fh.write("\n".join(log) + "\n")
    with open(os.path.join(BASE, "_evidence4.json"), "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, ensure_ascii=False, indent=2)

    print("\n".join(log))
    print(f"\n写出: {txt}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
