# -*- coding: utf-8 -*-
"""第二轮测试：纠正 gray-decision 方法、采集完整证据 JSON、探测 trae 参考接口。"""
import json, urllib.request, urllib.error, ssl, os, time, base64, datetime

CTX = ssl.create_default_context()
HERE = os.path.dirname(os.path.abspath(__file__))
WB = "D:\Code\Project\SSH\Honor 10\examples\workbuddy_解析结果"
cookie = open(os.path.join(WB, "_cookie.txt"), encoding="utf-8").read().strip()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"

def call(method, url, body=None, headers=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("user-agent", UA)
    req.add_header("accept", "application/json, text/plain, */*")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("content-type", "application/json")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, r.read().decode("utf-8", "replace"), None, round(time.time()-t0,3)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8","replace"), None, round(time.time()-t0,3)
    except Exception as e:
        return -1, "", str(e)[:120], round(time.time()-t0,3)

lines = []
ev = {}

# 1) 纠正：gray-decision 应为 GET
st, raw, err, dt = call("GET",
    "https://www.workbuddy.cn/v2/plugin/login/gray-decision?feature=oneid_component&platform=workbuddy",
    headers={"cookie": cookie, "x-client-platform": "web", "referer": "https://www.workbuddy.cn/login/"})
lines.append("[纠正] GET gray-decision(oneid_component) -> HTTP %s %ss  %s" % (st, dt, (err or raw[:120])))
try: ev["gray_decision_oneid"] = json.loads(raw)
except: pass

# 2) 完整证据：核心只读接口
for path in ["/activity/growth/streak", "/activity/growth/energy", "/activity/growth/redeem/summary",
             "/activity/growth/buddy/travel/status", "/v2/activity/growth/profile", "/activity/growth/lottery/summary"]:
    st, raw, err, dt = call("GET", "https://www.workbuddy.cn"+path,
        headers={"cookie": cookie, "x-client-platform": "web", "referer": "https://www.workbuddy.cn/profile/growth-center"})
    try: j = json.loads(raw)
    except: j = None
    ev[path] = j
    lines.append("[证据] GET %s -> HTTP %s code=%s %ss" % (path, st, (j.get("code") if j else "-"), dt))

# heatmap 取首尾样例
st, raw, err, dt = call("GET", "https://www.workbuddy.cn/activity/growth/heatmap",
    headers={"cookie": cookie, "x-client-platform": "web", "referer": "https://www.workbuddy.cn/profile/growth-center"})
hm = json.loads(raw) if raw else None
if hm and hm.get("data",{}).get("cells"):
    cells = hm["data"]["cells"]
    ev["heatmap_sample"] = {"total_cells": len(cells), "first": cells[0], "last": cells[-1],
                            "nonzero_count": sum(1 for c in cells if c.get("score",0)>0)}

# 3) 探测 trae 参考接口（JWT 已过期，预期 401/失败）
trae_jwt = open(os.path.join(HERE, "2026-08-15-152602_解析结果", "_trae_jwt.txt"), encoding="utf-8").read().strip()
st, raw, err, dt = call("POST", "https://api.trae.cn/trae/api/v2/ug/checkin_credits/status",
    body={}, headers={"authorization": "Cloud-IDE-JWT "+trae_jwt, "x-user-region":"CN",
                      "package-type":"stable_cn", "user-agent":"TRAE-SOLO-CN/1.0"})
lines.append("[参考] POST api.trae.cn/trae/api/v2/ug/checkin_credits/status (expired JWT) -> HTTP %s %ss  %s" % (st, dt, (raw[:140] if raw else err)))
ev["trae_checkin_status_probe"] = {"http": st, "body": raw[:200]}

lines.append("")
out = os.path.join(HERE, "_test_results2.txt")
open(out, "w", encoding="utf-8").write("\n".join(lines))
open(os.path.join(HERE, "_evidence.json"), "w", encoding="utf-8").write(json.dumps(ev, ensure_ascii=False, indent=2))
print("\n".join(lines))
print("\nWROTE", out, "and _evidence.json")
