#!/data/data/com.termux/files/usr/bin/bash
# Termux:Boot 开机自启脚本
# 启动 runsvdir 接管所有服务
#
# 本地源：tools/boot/start-all.sh（设备是部署产物，改这里 → base64 上传 → sha256 对拍）
# 部署位置：~/.termux/boot/start-all.sh

log(){ echo "[$(date '+%H:%M:%S')] $*" >> $HOME/.termux/boot.log; }

# ★防并发互斥：Termux:Boot 开机广播可能重复投递，或与手动触发叠加，
#   导致本脚本同时跑多遍。多个实例都执行 pkill+setsid 会各起一个 runsvdir
#   （双实例并存 + 僵尸 runsv），keep-alive 也会起多个循环（曾实测到 4 个）。
#   用 flock 保证临界区互斥：后到的实例直接退出。
exec 9>"$HOME/.termux/boot-start.lock"
if ! flock -n 9; then
  log 'another start-all instance is running, exit'
  exit 0
fi

# 等待系统启动完成
sleep 5
log 'boot start'

# 获取 wake-lock 保活（防止 Android 后台冻结）
termux-wake-lock 2>/dev/null
log 'wake-lock acquired'

# 启动 runsvdir 监督所有服务
# ★pkill -f 会匹配任何完整命令行包含该文本的进程（包括正在执行本脚本的 shell、
#   以及任何诊断命令里碰到这个字符串的情况），导致自杀式误杀。改用 -x 精确匹配进程名。
pkill -x runsvdir 2>/dev/null
sleep 1
setsid runsvdir -P /data/data/com.termux/files/usr/var/service < /dev/null > /dev/null 2>&1 &
log 'runsvdir started'

# 启动 keep-alive（后台保活）。
# 先清掉历史多跑残留的旧实例，保证全局只有一个 wake-lock 循环（空窗 <1s，新实例进循环即补锁）。
pkill -f 'boot/keep-alive.sh' 2>/dev/null
sleep 1
nohup bash $HOME/.termux/boot/keep-alive.sh > /dev/null 2>&1 &
log 'keep-alive started'

log 'boot complete'
