#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=== [1/4] 重启 monitor ==="
chmod -R 644 $HOME/monitor/lib/*.js 2>/dev/null || true
chmod 644 $HOME/monitor/server.js 2>/dev/null || true
SERVICE_DIR=/data/data/com.termux/files/usr/var/service

if [ -d "$SERVICE_DIR/server" ]; then
  echo "    检测到 runit 托管 server 服务，使用 sv 原子重启（避免 pkill+手动启动产生重复实例）"
  # 清理非 runsv 托管的冗余 monitor 实例（如 auto-recovery/setuid 遗留的孤儿进程）
  for pid in $(pgrep -f 'node server.js' 2>/dev/null); do
    [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ] && continue
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    pcomm=$(ps -o comm= -p "$ppid" 2>/dev/null | tr -d ' ')
    if [ "$pcomm" != "runsv" ]; then
      kill "$pid" 2>/dev/null && echo "    清理冗余实例 PID $pid" || true
    fi
  done
  # 原子重启 runit 托管的唯一 monitor（Termux 需显式指定 SVDIR）
  SVDIR=$SERVICE_DIR sv restart server 2>/dev/null || true
  sleep 3
else
  echo "    未检测到 runit，走 pkill + 手动启动"
  pkill -f 'node server.js' 2>/dev/null || true
  sleep 2
  cd $HOME/monitor
  mkdir -p $HOME/logs/monitor
  setsid node server.js >> $HOME/logs/monitor/monitor.log 2>&1 &
  disown
  sleep 3
fi

# 兜底：若以上均未能保证至少一个 monitor 在跑（如 sv 失败），手动拉起
if ! pgrep -f 'node server.js' >/dev/null 2>&1; then
  echo "    sv 重启后无 monitor，手动兜底启动"
  cd $HOME/monitor
  setsid node server.js >> $HOME/logs/monitor/monitor.log 2>&1 &
  disown
  sleep 3
fi

MONITOR_PID=$(pgrep -f 'node server.js' 2>/dev/null | grep -v "bash -c" | head -1)
if [ -n "$MONITOR_PID" ]; then
  echo "MONITOR_STARTED: $MONITOR_PID"
else
  echo "MONITOR_FAILED"
  tail -20 $HOME/logs/monitor/monitor.log 2>/dev/null
  exit 1
fi

echo "=== [3/4] 确保 auto-recovery 循环运行 ==="
# auto-recovery: 每 30s 检查一次，monitor/sing-box/cloudflared 挂掉会自动重启
# 这是保证后端自动重启的关键机制
if pgrep -f 'while sleep 30' >/dev/null 2>&1; then
  echo "AUTO_RECOVERY_RUNNING"
else
  # 启动 auto-recovery 循环（与 start-all.sh 中的逻辑一致）
  # 注意：使用 pgrep 进程名匹配（不含 -f）避免匹配到自身的 bash 进程
  nohup bash -c '
  while sleep 30; do
    pgrep cloudflared >/dev/null 2>&1 || {
      nohup cloudflared tunnel run honor-server &>/dev/null & disown
    }
    pgrep sing-box >/dev/null 2>&1 || {
      ENABLE_DEPRECATED_LEGACY_DNS_SERVERS=true ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER=true nohup sing-box run -c $HOME/sb-config.json &>/dev/null & disown
    }
    pgrep -f "node server.js" 2>/dev/null | grep -v "bash -c" | head -1 >/dev/null 2>&1 || {
      cd $HOME/monitor && setsid node server.js >> $HOME/logs/monitor/monitor.log 2>&1 & disown
    }
  done
  ' >/dev/null 2>&1 &
  disown
  sleep 1
  if pgrep -f 'while sleep 30' >/dev/null 2>&1; then
    echo "AUTO_RECOVERY_STARTED"
  else
    echo "AUTO_RECOVERY_FAILED"
    exit 1
  fi
fi

echo "=== [4/4] 验证服务状态 ==="
echo "monitor:        $(pgrep -f 'node server.js' 2>/dev/null | grep -v 'bash -c' | head -1 || echo NOT_RUNNING)"
echo "auto-recovery:  $(pgrep -f 'while sleep 30' | head -1 || echo NOT_RUNNING)"
echo "sing-box:       $(pgrep sing-box | head -1 || echo NOT_RUNNING)"
echo "cloudflared:    $(pgrep cloudflared | head -1 || echo NOT_RUNNING)"
echo "--- 端口监听 ---"
ss -tlnp 2>/dev/null | grep -E ':(3081|9090|7890)' || netstat -tlnp 2>/dev/null | grep -E ':(3081|9090|7890)' || echo "端口检查跳过"
echo "--- monitor 日志(最后5行) ---"
tail -5 $HOME/logs/monitor/monitor.log 2>/dev/null || echo "无日志"
echo "=== DONE ==="
