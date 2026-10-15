#!/data/data/com.termux/files/usr/bin/bash
# ~/.termux/boot/notify-boot.sh —— 开机心跳自检，独立于 runsvdir/runit 触发
#
# 为什么需要这个：check-remote-access.mjs / server.js 等所有检测能力本身都靠 runit 托管，
# 一旦 Termux:Boot 这次开机没触发、runsvdir 压根没起来（本次会话遇到的真实故障），
# 这些检测工具也跟着起不来，等于"瞎子的眼睛也是瞎的"，完全发不出任何信号。
# 本脚本由 Termux:Boot 直接执行（~/.termux/boot/ 下所有脚本都会被逐个跑，不经过 runit），
# 开机就主动汇报一次核心服务的真实存活状态，覆盖"整个 runit 栈没起来"这个盲区。
#
# 网络可能还没就绪（WiFi 刚连上需要时间），sendMail 用 curl 打 SMTP，做几次重试再放弃。
# 本地留一份源码（tools/boot-heartbeat.sh），走 scp 上传到 ~/.termux/boot/notify-boot.sh，
# 与 check-remote-access.mjs 同一套"本地是源、设备是部署产物"的定位，不走 F101 tag 流程。

log(){ echo "[$(date '+%Y-%m-%d_%H:%M:%S')] $*" >> $HOME/.termux/boot-heartbeat.log; }

log '=== heartbeat start ==='

# 错开 start-all.sh 的 sleep 5 + 唤醒时间，给网络/系统一点缓冲，避免抢跑发到一半网络断了
sleep 20

DATA_DIR=$HOME/.monitor_data

node <<'EOF' 2>&1
const SVDIR = '/data/data/com.termux/files/usr/var/service';
// ssh-agent 不在监控列表里：服务目录里有 Aug 11 遗留的 down 标记文件，属于「已知道、不关心」的历史状态（跟 sshd 之前那个 bug 同源，但目前没人在用 agent 转发，不纳入开机自检避免每次重启都误报"部分服务未启动"）
const SERVICES = ['server', 'mon-checkin', 'mon-release', 'mihomo', 'cloudflared', 'sshd', 'remote-access-check'];

async function main() {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('/data/data/com.termux/files/usr/bin/sv', ['status', ...SERVICES.map(s => SVDIR + '/' + s)], { encoding: 'utf8' });
  const report = (r.stdout || '') + (r.stderr || '');
  const lines = report.trim().split('\n').filter(Boolean);
  const upCount = lines.filter(l => l.startsWith('run:')).length;
  const downCount = lines.filter(l => l.startsWith('down:')).length;
  const failCount = lines.filter(l => l.startsWith('fail:')).length;
  const allOk = failCount === 0 && downCount === 0;

  const subject = allOk ? '[通知] honor10 开机自检：核心服务全部正常' : '[告警] honor10 开机自检：部分服务未启动';
  const body =
    `本邮件由 ~/.termux/boot/notify-boot.sh 独立发送，不经过 runit，专门覆盖"Termux:Boot 触发失败/runsvdir 没起来"这类整体性故障盲区。\n\n` +
    `run(正常): ${upCount}   down(被显式停止或未起): ${downCount}   fail(runsv 未接管): ${failCount}\n\n` +
    report;

  const { sendMail } = await import('/data/data/com.termux/files/home/monitor/lib/notify.js');

  // 网络可能还没通，重试 3 次，间隔 30s
  let sent = false; let lastErr = '';
  for (let i = 1; i <= 3; i++) {
    try {
      const ok = await sendMail(subject, body);
      if (ok) { sent = true; console.log(`[attempt ${i}] sendMail 成功`); break; }
      lastErr = `sendMail 返回 false（SMTP 配置缺失或 curl 报错）`;
      console.log(`[attempt ${i}] ${lastErr}`);
    } catch (e) {
      lastErr = String(e.message || e);
      console.log(`[attempt ${i}] 异常: ${lastErr}`);
    }
    if (i < 3) await new Promise(res => setTimeout(res, 30000));
  }
  console.log(sent ? 'HEARTBEAT_SENT_OK' : `HEARTBEAT_SEND_FAILED: ${lastErr}`);
}

main().catch(e => { console.error('heartbeat 顶层异常:', e.message); process.exit(1); });
EOF

NODE_EXIT=$?
log "node 退出码=$NODE_EXIT"
log '=== heartbeat done ==='
