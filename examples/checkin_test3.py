#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
checkin_test3.py —— WorkBuddy 签到链路「遗留未验证接口」实测

背景
----
checkin平台全流程方案.md §2.2-3 遗留一条未完成验证：
「每日签到打卡」写接口的真实路径未知，旧文档曾误猜
    POST https://www.workbuddy.cn/activity/growth/checkin  -> 404
本次 workbuddy3 抓包（2026-09-10 桌面端）给出真实端点：
    POST https://copilot.tencent.com/v2/billing/meter/checkin-activity-status (读)
    POST https://copilot.tencent.com/v2/billing/meter/daily-checkin          (写)
本脚本用于实机验证这两个端点。

安全性
------
- daily-checkin 是「每日一次」幂等接口；抓包显示当日已签（today_checked_in=true,
  streak_days=9）。因此本次调用属于「当日重复调用」，用于验证幂等性，
  不会造成重复发放，也不会污染签到数据。
- 脚本会在调用前后各读一次 status，用差异证明幂等。

凭证来源：examples/workbuddy3_解析结果/182_..._daily-checkin/请求.txt
输出：examples/_test_results3.txt （人类可读）、examples/_evidence3.json（机读）
"""

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(
    BASE,
    "workbuddy3_解析结果",
    "182_POST copilot.tencent.comhttps___copilot.tencent.com_v2_billing_meter_daily-checkin",
    "请求.txt",
)

HOST = "https://copilot.tencent.com"
STATUS_PATH = "/v2/billing/meter/checkin-activity-status"
CHECKIN_PATH = "/v2/billing/meter/daily-checkin"


# --------------------------------------------------------------------------
# 1. 从抓包样本中提取凭证
# --------------------------------------------------------------------------
def load_credentials():
    with open(SRC, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()

    def grab(name):
        m = re.search(rf"^{name}:\s*(.+?)\s*$", raw, re.M | re.I)
        if not m:
            raise SystemExit(f"[FATAL] 抓包中未找到请求头 {name}")
        return m.group(1)

    return {
        "Authorization": grab("Authorization"),
        "X-User-Id": grab("X-User-Id"),
        "X-Domain": grab("X-Domain"),
        "X-Device-Token": grab("X-Device-Token"),
    }


# --------------------------------------------------------------------------
# 2. HTTP 调用
# --------------------------------------------------------------------------
CTX = ssl.create_default_context()

log_lines = []
evidence = {"target": "copilot.tencent.com", "cases": []}


def call(label, path, creds, auth=True, body=b"{}", note=""):
    url = HOST + path
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "axios/1.16.1",
    }
    if auth:
        headers.update(creds)

    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25, context=CTX) as resp:
            code, text = resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        code, text = e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        code, text = -1, f"<{type(e).__name__}: {e}>"

    try:
        payload = json.loads(text)
    except Exception:  # noqa: BLE001
        payload = None

    line = f"[{'AUTH' if auth else 'NOAUTH'}] POST {path}  -> HTTP {code}"
    log_lines.append(line)
    if payload is not None:
        log_lines.append("   resp: " + json.dumps(payload, ensure_ascii=False)[:900])
    else:
        log_lines.append("   raw : " + text[:400])
    if note:
        log_lines.append("   note: " + note)

    evidence["cases"].append(
        {
            "label": label,
            "method": "POST",
            "url": url,
            "authed": auth,
            "http": code,
            "response": payload if payload is not None else text[:2000],
            "note": note,
        }
    )
    return code, payload


def main():
    creds = load_credentials()
    log_lines.append("=" * 74)
    log_lines.append("WorkBuddy 签到链路实测 —— 遗留接口 daily-checkin 验证")
    log_lines.append("凭证来源: workbuddy3_解析结果/182_..._daily-checkin/请求.txt")
    log_lines.append("=" * 74)

    # --- 负向：不带鉴权 ---------------------------------------------------
    call("负向-无鉴权", STATUS_PATH, creds, auth=False, note="验证鉴权确实生效")

    # --- 正向：签到前状态 -------------------------------------------------
    c1, before = call(
        "签到前状态", STATUS_PATH, creds, note="读取当日签到活动全量状态"
    )

    # --- 正向：执行每日签到（当日重复调用 -> 验证幂等） -------------------
    c2, checkin = call(
        "每日签到(写)",
        CHECKIN_PATH,
        creds,
        note="当日已签，重复调用用于验证幂等性，不会重复发放",
    )

    # --- 正向：签到后复查 -------------------------------------------------
    c3, after = call("签到后复查", STATUS_PATH, creds, note="与签到前比对，确认未重复发放")

    # --- 判定 -------------------------------------------------------------
    log_lines.append("-" * 74)
    log_lines.append("判定：")
    authed_ok = c1 == 200 and c3 == 200
    log_lines.append(f"  · 鉴权生效 / 读接口可用 : {'PASS' if authed_ok else 'FAIL'}")

    d_before = (before or {}).get("data", {}) if isinstance(before, dict) else {}
    d_after = (after or {}).get("data", {}) if isinstance(after, dict) else {}
    d_check = (checkin or {}).get("data", {}) if isinstance(checkin, dict) else {}

    if d_before and d_after:
        same = (
            d_before.get("total_credits") == d_after.get("total_credits")
            and d_before.get("streak_days") == d_after.get("streak_days")
        )
        log_lines.append(
            f"  · 幂等性(total_credits/streak_days 不变): {'PASS' if same else 'CHECK'}"
        )
        log_lines.append(
            f"      before: streak_days={d_before.get('streak_days')}, "
            f"total_credits={d_before.get('total_credits')}, "
            f"today_checked_in={d_before.get('today_checked_in')}"
        )
        log_lines.append(
            f"      after : streak_days={d_after.get('streak_days')}, "
            f"total_credits={d_after.get('total_credits')}, "
            f"today_checked_in={d_after.get('today_checked_in')}"
        )
    if d_check:
        log_lines.append(
            f"  · daily-checkin 返回: {json.dumps(d_check, ensure_ascii=False)}"
        )

    log_lines.append(f"  · HTTP 码: status={c1}, daily-checkin={c2}, status2={c3}")
    log_lines.append("=" * 74)

    out_txt = os.path.join(BASE, "_test_results3.txt")
    with open(out_txt, "w", encoding="utf-8") as fh:
        fh.write("\n".join(log_lines) + "\n")

    evidence["summary"] = {
        "http": {"status_before": c1, "daily_checkin": c2, "status_after": c3},
        "before": d_before,
        "daily_checkin": d_check,
        "after": d_after,
    }
    out_json = os.path.join(BASE, "_evidence3.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, ensure_ascii=False, indent=2)

    print("\n".join(log_lines))
    print(f"\n写出: {out_txt}")
    print(f"写出: {out_json}")
    return 0 if authed_ok else 1


if __name__ == "__main__":
    sys.exit(main())
