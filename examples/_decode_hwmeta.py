#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解码抓包中的 fp / hwmeta（base64 + XOR 滚动密钥）。"""
import base64
import re
import sys
import urllib.parse
from pathlib import Path

CAP = Path(__file__).parent / "codearts首次登录与二次登录_解析结果"


def xor_decrypt(data: str) -> str:
    key = 211
    out = []
    for ch in data:
        c = ord(ch)
        out.append(chr((c ^ (key - 1)) & 0xFF))
        key = c
    return "".join(out)


def decode_blob(raw: str) -> str:
    s = urllib.parse.unquote(raw)
    try:
        dec = base64.b64decode(s + "=" * (-len(s) % 4)).decode("latin-1")
    except Exception as e:  # noqa: BLE001
        return "<<base64 fail: %s>>" % e
    return xor_decrypt(dec)


def find_body(idx_prefix: str):
    dirs = sorted(CAP.glob(idx_prefix + "_*"))
    if not dirs:
        return None
    p = dirs[0] / "请求体.txt"
    return p.read_text(encoding="utf-8", errors="replace") if p.exists() else None


def get_field(body: str, name: str):
    m = re.search(r"(?:^|&)" + re.escape(name) + r"=([^&]*)", body)
    return m.group(1) if m else None


TARGETS = [
    ("079", "fp"),
    ("096", "hwmeta"),
    ("108", "hwmeta"),
    ("112", "hwMeta"),
    ("264", "hwmeta"),
    ("265", "fp"),
]

for pref, fld in TARGETS:
    body = find_body(pref)
    if body is None:
        print("== %s 无请求体" % pref)
        continue
    val = get_field(body, fld)
    print("=" * 70)
    print("== %s  field=%s  len(raw)=%s" % (pref, fld, len(val) if val else None))
    if not val:
        continue
    plain = decode_blob(val)
    print("-- 明文 (%d chars) --" % len(plain))
    print(plain[:2000])
    print()
