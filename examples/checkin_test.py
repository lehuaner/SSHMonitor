# -*- coding: utf-8 -*-
"""可用性初步测试：用抓包中的 session cookie 调用 workbuddy 签到平台关键接口（只读）。"""
import json, urllib.request, urllib.error, ssl, os, time, datetime

BASE = "https://www.workbuddy.cn"
HERE = os.path.dirname(os.path.abspath(__file__))
cookie = open(os.path.join(HERE, "workbuddy_解析结果", "_cookie.txt"), encoding="utf-8").read().strip()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"
CTX = ssl.create_default_context()

# (method, path, body_or_None, note)
GETS = [
    ("GET", "/activity/growth/streak", None, "连续签到核心"),
    ("GET", "/activity/growth/energy", None, "能量/积分余额"),
    ("GET", "/activity/growth/heatmap", None, "打卡热力图"),
    ("GET", "/activity/growth/buddy/info", None, "当前buddy"),
    ("GET", "/activity/growth/buddy/list", None, "已拥有buddy"),
    ("GET", "/activity/growth/buddy/quota", None, "抽取额度"),
    ("GET", "/activity/growth/buddy/visible", None, "buddy可见性"),
    ("GET", "/activity/growth/buddy/agreement", None, "协议状态"),
    ("GET", "/activity/growth/buddy/travel/status", None, "出行状态"),
    ("GET", "/activity/growth/buddy/travel/config", None, "出行配置"),
    ("GET", "/activity/growth/lottery/summary", None, "抽奖概览"),
    ("GET", "/activity/growth/lottery/prizes", None, "奖池"),
    ("GET", "/activity/growth/lottery/chances", None, "抽奖余量"),
    ("GET", "/activity/growth/redeem/summary", None, "兑换概览"),
    ("GET", "/activity/growth/buddy/templates", None, "模板库"),
    ("GET", "/v2/activity/growth/profile", None, "成长档案"),
    ("GET", "/v2/activity/growth/badges", None, "徽章"),
    ("GET", "/v2/activity/growth/subscribe-task/status", None, "订阅任务"),
    ("GET", "/v2/activity/growth/tasks", None, "任务列表"),
]
POSTS = [
    ("POST", "/billing/meter/get-user-resource-summary", {}, "资源汇总(只读)"),
    ("POST", "/billing/meter/compensation-status", {}, "补偿包状态"),
    ("POST", "/billing/meter/check-gift-claimed", {}, "赠礼状态"),
    ("POST", "/v2/plugin/login/gray-decision?feature=oneid_component&platform=workbuddy", None, "灰度开关"),
]

def call(method, path, body, use_cookie):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("user-agent", UA)
    req.add_header("accept", "application/json, text/plain, */*")
    req.add_header("x-client-platform", "web")
    req.add_header("referer", "https://www.workbuddy.cn/profile/growth-center")
    if data is not None:
        req.add_header("content-type", "application/json")
    if use_cookie:
        req.add_header("cookie", cookie)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20, context=CTX) as r:
            raw = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
    except Exception as e:
        return None, -1, str(e)[:120], 0
    dt = round(time.time() - t0, 3)
    return raw, status, None, dt

def summarize(raw):
    try:
        j = json.loads(raw)
        code = j.get("code")
        rid = j.get("requestId")
        data = j.get("data")
        dstr = json.dumps(data, ensure_ascii=False)
        if len(dstr) > 240:
            dstr = dstr[:240] + f"...(len={len(dstr)})"
        return code, rid, dstr
    except Exception:
        return "-", "-", raw[:160]

lines = []
lines.append("=== WorkBuddy 签到平台 接口可用性测试 ===")
lines.append("时间: " + datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
lines.append("会话cookie长度: %d  过期(中间段): 2026-09-14T16:38:55Z" % len(cookie))
lines.append("")

lines.append("--- [A] 负向用例：不带 cookie 调用 streak（应 401） ---")
raw, st, err, dt = call("GET", "/activity/growth/streak", None, False)
lines.append("GET /activity/growth/streak | no-cookie | HTTP %s | %ss | %s" % (st, dt, (err or raw[:80])))

lines.append("")
lines.append("--- [B] 正向用例：携带 session cookie 的只读接口 ---")
ok = 0; tot = 0
for method, path, body, note in GETS + POSTS:
    tot += 1
    raw, st, err, dt = call(method, path, body, True)
    if err:
        lines.append("%-4s %-58s | HTTP %s | %ss | ERR %s" % (method, path[:58], st, dt, err))
        continue
    code, rid, dstr = summarize(raw)
    passed = (st == 200 and str(code) in ("0", "-"))
    ok += 1 if passed else 0
    tag = "OK " if passed else "!! "
    lines.append("%s%-4s %-58s | HTTP %s code=%s | %ss" % (tag, method, path[:58], st, code, dt))
    lines.append("      note=%-12s data=%s" % (note, dstr))

lines.append("")
lines.append("小结: 正向用例通过 %d/%d" % (ok, tot))
out = os.path.join(HERE, "_test_results.txt")
open(out, "w", encoding="utf-8").write("\n".join(lines))
print("\n".join(lines))
print("\nWROTE", out)
