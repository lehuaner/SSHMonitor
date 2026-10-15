#!/data/data/com.termux/files/usr/bin/bash
# battery-trace.sh —— 临时电池行为观测（2026-10-14 新增）
#
# 背景：设备插着 AC 充电，但电量到 82% 后 status=NOT_CHARGING 停充
#   （华为「智能充电模式/峰值容量」系统策略，Termux 读不到策略参数与恢复阈值）。
#   本脚本每分钟记录一次 termux-battery-status 原始 JSON，静置 1~2 天后
#   从 percentage/current 拐点即可看出「停充 → 跌到多少 → 恢复充电」。
#
# 定位：临时观测，不入 runit、不开机自启。数据：~/.monitor_data/battery_trace.jsonl
# 停止：pkill -f battery-trace.sh（脚本自身无副作用，仅追加写一个文件）
# 源：本地仓库 tools/battery-trace.sh（部署产物 = 设备 ~/tools/battery-trace.sh）

OUT="$HOME/.monitor_data/battery_trace.jsonl"

while true; do
  RAW=$(termux-battery-status 2>/dev/null)
  if [ -n "$RAW" ]; then
    # 压成单行 + 时间戳前缀，便于 jq/python 逐行解析
    echo "{\"ts\":\"$(date '+%Y-%m-%dT%H:%M:%S')\",\"b\":$(echo "$RAW" | tr -d '\n' | tr -s ' ')}" >> "$OUT"
  fi
  sleep 60
done
