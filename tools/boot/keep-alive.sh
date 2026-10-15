#!/data/data/com.termux/files/usr/bin/bash
# 每 60 秒重新获取 wake-lock，防止被系统撤销
while true; do
  termux-wake-lock 2>/dev/null
  sleep 60
done
