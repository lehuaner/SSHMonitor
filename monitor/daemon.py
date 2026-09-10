#!/usr/bin/env python3
"""Daemon launcher: 重启 monitor 进程，防止双开。

根因：runit (runsv) 会在进程死亡后 ~1s 内自动重启 monitor。
旧版 daemon.py 用 pkill + sleep(2) + start，runsv 在 sleep 期间已重启，
daemon.py 又启动一个 → 两个 monitor 并存。

修复策略：
  1. 若 runit 管理 monitor → 用 `sv restart` 原子重启（stop+start 期间 runsv 不会双开）
  2. 若无 runit → 手动 kill + 轮询等待退出 + check-before-start（watchdog 可能已重启）
  3. 锁文件防止用户快速多次点击导致多个 daemon.py 并发
"""
import os, sys, time, subprocess

HOME = os.path.expanduser('~')
MONITOR_DIR = HOME + '/monitor'
SERVICE_DIR = '/data/data/com.termux/files/usr/var/service/server'
LOG_PATH = HOME + '/logs/monitor/monitor.log'
LOCK_FILE = HOME + '/.monitor_data/.restart.lock'


def run_cmd(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except Exception as e:
        return -1, '', str(e)


def is_runit_managed():
    """检查 runit 是否在管理 monitor 服务。"""
    rc, _, _ = run_cmd(f'test -d "{SERVICE_DIR}" && pgrep -x runsv >/dev/null 2>&1')
    return rc == 0


def find_monitor_pids():
    """通过 cwd=~/monitor 精确查找 monitor 进程（避免误杀 proxy-bridge 等同样运行 node server.js 的进程）。"""
    pids = []
    my_pid = os.getpid()
    my_ppid = os.getppid()
    try:
        for pid_str in os.listdir('/proc'):
            if not pid_str.isdigit():
                continue
            pid = int(pid_str)
            if pid == my_pid or pid == my_ppid:
                continue
            try:
                with open(f'/proc/{pid}/cmdline', 'rb') as f:
                    cmdline = f.read().replace(b'\0', b' ').decode('utf-8', 'ignore').strip()
                if 'node' not in cmdline or 'server.js' not in cmdline:
                    continue
                cwd = os.readlink(f'/proc/{pid}/cwd')
                if cwd == MONITOR_DIR:
                    pids.append(pid)
            except:
                continue
    except:
        pass
    return pids


# --- 锁文件：防止多个 daemon.py 并发执行（用户快速多次点击重启） ---
try:
    if os.path.exists(LOCK_FILE):
        with open(LOCK_FILE) as f:
            old_pid = f.read().strip()
        # 检查旧锁对应的进程是否还活着
        if old_pid and old_pid.isdigit() and os.path.exists(f'/proc/{old_pid}'):
            with open(f'/proc/{old_pid}/cmdline', 'rb') as f:
                old_cmd = f.read().replace(b'\0', b' ').decode('utf-8', 'ignore')
            if 'daemon.py' in old_cmd:
                print(f'Another restart in progress (PID={old_pid}), exiting')
                sys.exit(0)
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    with open(LOCK_FILE, 'w') as f:
        f.write(str(my_pid))
except:
    pass

try:
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)

    if is_runit_managed():
        # === 方式一：runit 管理 → sv restart 原子重启 ===
        # sv restart = stop（设 down 标记防止 auto-restart）+ start（清 down 标记并启动）
        # 整个过程由 runsv 控制，不会出现双开
        print('Restarting via runit (sv restart)...')
        rc, out, err = run_cmd(f'sv restart "{SERVICE_DIR}"', timeout=15)
        time.sleep(3)
        pids = find_monitor_pids()
        if pids:
            print(f'OK: monitor restarted via runit, PID={pids[0]}')
        else:
            print(f'FAIL: sv restart did not start monitor. rc={rc} err={err}')
    else:
        # === 方式二：无 runit → 手动 kill + check-before-start ===
        print('Runit not detected, manual restart...')

        # 1. 精确杀掉旧 monitor（按 cwd 匹配，不误杀 proxy-bridge）
        for pid in find_monitor_pids():
            try:
                os.kill(pid, 15)  # SIGTERM
                print(f'Killed old monitor PID={pid}')
            except:
                pass

        # 2. 轮询等待旧进程退出（最多 5s）
        for _ in range(25):
            if not find_monitor_pids():
                break
            time.sleep(0.2)
        time.sleep(0.5)  # 额外等待端口释放

        # 3. 检查是否已有 monitor 在运行（watchdog/auto-recovery 可能已重启）
        pids = find_monitor_pids()
        if pids:
            print(f'Monitor already running (PID={pids[0]}), skip start')
        else:
            # 4. 启动新 monitor
            log_fd = open(LOG_PATH, 'a')
            p = subprocess.Popen(
                ['node', 'server.js'],
                cwd=MONITOR_DIR,
                stdin=subprocess.DEVNULL,
                stdout=log_fd,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # setsid()，完全脱离当前会话
                close_fds=True,
            )
            print(f'Started node PID={p.pid}')
            time.sleep(3)
            pids = find_monitor_pids()
            if pids:
                print(f'OK: monitor running, PID={pids[0]}')
            else:
                print('FAIL: monitor exited')
                log_fd.flush()
                log_fd.close()
                try:
                    with open(LOG_PATH) as f:
                        for line in f.readlines()[-5:]:
                            print('  log:', line.rstrip())
                except:
                    pass
finally:
    # 清理锁文件
    try:
        os.remove(LOCK_FILE)
    except:
        pass
