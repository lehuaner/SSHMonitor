import { run, HOME, getCustomServiceRules } from './utils.js';
import { readFileSync, readdirSync } from 'node:fs';

// sing-box 重启后，selector 会重置为 sb-config.json 的 default 节点（通常是列表第一个，如"美国1"）
// 此函数在 sing-box 启动后等待 Clash API 就绪，并把 selector 切回重启前用户正在用的节点
async function restoreSelectorAfterStart(savedNode) {
  if (!savedNode) return;
  // 等待 Clash API 就绪（最多 ~10s）
  for (let i = 0; i < 20; i++) {
    try {
      const out = await run(`curl -s --max-time 2 http://127.0.0.1:9090/proxies 2>/dev/null`);
      if (out && out.includes('节点选择')) break;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  // 切回原节点
  await run(`curl -s -X PUT -H 'Content-Type: application/json' -d '{"name":"${savedNode}"}' http://127.0.0.1:9090/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9 2>/dev/null`);
}

// 安全杀进程：读取 /proc 找到命令行包含 match 的进程，排除当前 Node.js 进程及其父进程
function safeKillByMatch(matchStr) {
  const myPid = process.pid;
  const myPpid = process.ppid;
  let killed = 0;
  try {
    for (const pidStr of readdirSync('/proc')) {
      if (!/^\d+$/.test(pidStr)) continue;
      const pid = parseInt(pidStr);
      if (pid === myPid || pid === myPpid) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
        if (cmdline && cmdline.includes(matchStr) && !cmdline.includes('safeKill') && !cmdline.includes('node server.js')) {
          try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
        }
      } catch {}
    }
  } catch {}
  return killed;
}

export async function doAction(action, pid) {
  switch (action) {
    case 'kill':
      await run(`kill ${parseInt(pid)} 2>/dev/null`);
      return { ok: true, msg: `进程 ${pid} 已终止` };
    case 'restart-singbox': {
      // 重启前先保存当前 selector 节点（sing-box 重启后会重置为 default，通常是列表第一个如"美国1"）
      let savedNode = '';
      try {
        const out = await run(`curl -s --max-time 2 http://127.0.0.1:9090/proxies 2>/dev/null`);
        const d = JSON.parse(out);
        for (const [, p] of Object.entries(d.proxies || {})) {
          if (p.now && p.type === 'Selector') { savedNode = p.now; break; }
        }
      } catch {}
      // setsid 让进程脱离当前会话，避免 SSH 断开被杀
      await run(`kill $(pgrep -x sing-box) 2>/dev/null; sleep 1; ENABLE_DEPRECATED_LEGACY_DNS_SERVERS=true ENABLE_DEPRECATED_MISSING_DOMAIN_RESOLVER=true setsid sing-box run -c ${HOME}/sb-config.json >/dev/null 2>&1 & disown`);
      // 重启后恢复原节点（异步，不阻塞响应）
      restoreSelectorAfterStart(savedNode);
      return { ok: true, msg: savedNode ? `Sing-box 已重启，已恢复节点: ${savedNode}` : 'Sing-box 已重启' };
    }
    case 'restart-tunnel':
      await run('pkill -f "cloudflared tunnel run" 2>/dev/null; sleep 2; setsid cloudflared tunnel run honor-server >/dev/null 2>&1 & disown');
      return { ok: true, msg: '隧道已重启' };
    case 'restart-monitor':
      // 不能直接 pkill 自己（会中断响应），用 daemon.py 异步重启
      // daemon.py 会: 1) 杀掉旧进程 2) 用 setsid 启动新进程
      // 延迟 500ms 执行，确保响应能正常返回
      setTimeout(() => {
        run(`cd ${HOME}/monitor && setsid python3 daemon.py >/dev/null 2>&1 & disown`);
      }, 500);
      return { ok: true, msg: '监控重启中（约2秒）...' };
    case 'restart-proxy':
      await run(`pkill -f "node.*proxy-bridge.*server\\.js" 2>/dev/null; sleep 1; cd ${HOME}/proxy-bridge && setsid node server.js > proxy.log 2>&1 & disown`);
      return { ok: true, msg: '代理转发已重启' };
    case 'restart-watchdog':
      // 用 Node.js 安全杀进程（避免 pkill -f 误杀包含该字符串的自身 bash 进程）
      safeKillByMatch('watchdog.sh');
      await new Promise(r => setTimeout(r, 1000));
      await run(`setsid bash ${HOME}/watchdog.sh >/dev/null 2>&1 & disown`);
      return { ok: true, msg: 'Watchdog 已重启' };
    default: {
      // 自定义服务规则：action 以 custom- 前缀开头，从规则中查找对应的 cmd 执行
      if (action && action.startsWith('custom-')) {
        const rules = getCustomServiceRules();
        const rule = rules.find(r => r.action === action);
        if (rule && rule.cmd) {
          // 替换 $HOME 占位符
          let cmd = rule.cmd.replace(/\$HOME/g, HOME);
          // 安全杀进程：用 rule.match 精确查找并 kill，避免 pkill 误杀自身
          safeKillByMatch(rule.match);
          await new Promise(r => setTimeout(r, 1000));
          // 移除 cmd 中的 pkill 部分，只执行启动命令
          cmd = cmd.replace(/pkill\s+-f\s+(['"]?)([^'";\s]+)\1\s*;?\s*/g, '');
          cmd = cmd.replace(/^\s*sleep\s+\d+\s*;?\s*/, '');
          await run(cmd);
          return { ok: true, msg: `${rule.label || rule.match} 已重启` };
        }
      }
      return { ok: false, msg: '未知操作' };
    }
  }
}
