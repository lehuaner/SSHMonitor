#!/usr/bin/env node
/**
 * tools/check-remote-access.mjs —— honor10 远程访问可行性定时检测（设备端自测，端到端回环）
 *
 * 目的：手机本地服务"活着" ≠ 外部真的能访问进来。本工具从设备自身出发，
 *   走完整公网链路（api.lehuan.vip/honor10 → honor10-gw Worker → Cloudflare Tunnel → 本机 3081），
 *   同时对比本机回环直连 3081，区分"后端本身故障"和"隧道/边缘链路故障"——
 *   这正是本次会话开头遇到的问题：sv status 全部显示服务在跑，但外部 curl 间歇性 530/超时，
 *   只看本机进程状态完全发现不了这种"看起来活着、实际不可达"的情况。
 *
 * 用法：
 *   node tools/check-remote-access.mjs              # 单次探测，结果打印到 stdout + 追加日志
 *   node tools/check-remote-access.mjs --loop 300   # 常驻模式：每 300 秒探测一轮（配套 runit 服务用这个）
 *
 * 部署：本文件通过 scp 上传到设备 ~/tools/check-remote-access.mjs，
 *   配套一个 runit 服务：run 脚本内容 = exec node /data/data/com.termux/files/home/tools/check-remote-access.mjs --loop 300 2>&1
 *   不走 F101 tag 发布流程（不属于 monitor/* 模块，是独立的设备运维工具，同 DEPLOYMENT.md 里"设备侧"脚本的定位）。
 *
 * 判定口径（复用本项目 proxy_check 已确立的"多次采样全失败才算真故障"模式，避免单次抖动误报，
 *   也避免"10次里9次通1次不通"这种间歇性问题被误判成"全通"从而漏报）：
 *   - 每轮连续探测 attempts 次（默认 3 次，间隔 retryDelayMs，每次独立超时 timeoutMs）
 *   - 全部成功 = ok；部分成功部分失败 = degraded（只记录，不告警，防止抖动骚扰邮箱）
 *   - 全部失败 = down 候选；连续 downRoundsAlert 轮(默认2)判定为 down 才真正发告警邮件
 *   - ★发送前即时复探：判定窗口（2 轮 × 300s = 10 分钟）足以让 Cloudflare 边缘/隧道抖动自愈，
 *     历史上多次出现"告警邮件送达时故障已消失"的误报。因此计数达标后不立即发信，而是立即
 *     再探 1 轮（attempts 次），仍全败才发；已自愈则按抖动处理（不发信、状态归零重计，
 *     不补发"已恢复"——因为从未 alert 过）。
 *   - 从 down 恢复到 ok/degraded 时发一封"已恢复"邮件（对称通知，同 proxy_check"全失效→恢复"通知设计思路）
 *
 * 本机直连 vs 外部链路 对比：
 *   - 本机不通：后端 server.js 本身挂了（如"runsvdir 没起，整个服务组全灭"这类情况），优先级最高，单独报
 *   - 本机通、外部不通/抖动：Tunnel/Cloudflare 边缘/Worker 网关链路问题，不是后端代码问题
 *   - 本机不通时不再重复报外部不通（外部请求本身就要经过本机，本机挂了外部必然也不通，只报根因，不刷屏）
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { api } from './machine-access-client.mjs';

const HOME = homedir();
const LOG_DIR = join(HOME, 'logs', 'remote-access');
const LOG_FILE = join(LOG_DIR, 'check.log');
const STATE_FILE = join(HOME, '.monitor_data', 'remote_access_state.json');

const CONFIG = {
  attempts: 3,
  retryDelayMs: 2000,
  timeoutMs: 10000,
  localUrl: 'http://127.0.0.1:3081/healthz',
  remotePath: '/healthz',
  downRoundsAlert: 2,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function probeLocal() {
  const t0 = Date.now();
  try {
    const res = await fetch(CONFIG.localUrl, { signal: AbortSignal.timeout(CONFIG.timeoutMs) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - t0, error: '', body: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: Date.now() - t0, error: e.message, body: '' };
  }
}

async function probeRemoteOnce() {
  const t0 = Date.now();
  try {
    // machine-access-client.mjs 的 api() 自带 AbortSignal.timeout(30000)，这里不复用其超时值，
    // 单独用 Promise.race 加一层更短的业务超时，避免 30s 对定时探测循环来说太久
    const result = await Promise.race([
      api(CONFIG.remotePath),
      new Promise((_, reject) => setTimeout(() => reject(new Error('本机探测超时')), CONFIG.timeoutMs)),
    ]);
    return { ok: result.ok, status: result.status, latencyMs: Date.now() - t0, error: '' };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: Date.now() - t0, error: String(e.message || e).slice(0, 160) };
  }
}

async function probeRemoteRound() {
  const samples = [];
  for (let i = 0; i < CONFIG.attempts; i++) {
    samples.push(await probeRemoteOnce());
    if (i < CONFIG.attempts - 1) await sleep(CONFIG.retryDelayMs);
  }
  const okCount = samples.filter((s) => s.ok).length;
  let verdict;
  if (okCount === CONFIG.attempts) verdict = 'ok';
  else if (okCount === 0) verdict = 'down';
  else verdict = 'degraded';
  return { verdict, okCount, total: CONFIG.attempts, samples };
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { lastVerdict: null, downRounds: 0 }; }
}
function saveState(s) {
  try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* 忽略写入失败，不阻塞探测主流程 */ }
}

function appendLog(entry) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* 忽略 */ }
}

async function runOneRound({ verbose = false } = {}) {
  const ts = new Date().toISOString();
  const local = await probeLocal();
  let remote = null;
  if (!local.ok) {
    // 本机直连都不通，外部链路必然也不通，不再浪费 3 次探测去撞墙，直接按"根因在本机"报
    remote = { verdict: 'skipped_local_down', okCount: 0, total: CONFIG.attempts, samples: [] };
  } else {
    remote = await probeRemoteRound();
  }

  const entry = { ts, local, remote };
  appendLog(entry);

  if (verbose) {
    console.log(`[${ts}] 本机=${local.ok ? '通' : `不通(${local.error})`}  外部=${remote.verdict}(${remote.okCount}/${remote.total})`);
    for (const s of remote.samples) console.log(`   - status=${s.status || '-'} ${s.latencyMs}ms ${s.error ? 'err=' + s.error : 'ok'}`);
  }

  return entry;
}

async function alertCheckAndMaybeSendMail(entry) {
  // 动态 import，避免在不发告警的绝大多数轮次里白白加载 notify.js(会触发其 SMTP 配置读取副作用)
  const state = loadState();
  const effectiveVerdict = entry.remote.verdict === 'skipped_local_down' ? 'local_down' : entry.remote.verdict;

  let alertMsg = null;
  if (effectiveVerdict === 'local_down') {
    // 本机服务本身挂了，最高优先级，直接报，不做"连续N轮"缓冲
    alertMsg = { kind: 'local_down', subject: '[告警] honor10 本机服务不可达', body: `时间: ${entry.ts}\n直连 127.0.0.1:3081/healthz 失败: ${entry.local.error}\n这通常意味着 server.js/网关进程本身没在跑(参考本次开机 runsvdir 未启动的情况)，外部链路问题暂无法判断。` };
  } else if (effectiveVerdict === 'down') {
    state.downRounds = (state.downRounds || 0) + 1;
    if (state.downRounds >= CONFIG.downRoundsAlert && state.lastVerdict !== 'down_alerted') {
      // ★发送前即时复探：判定窗口足以让 CF 边缘/隧道抖动自愈，历史上多次出现
      //   "告警邮件送达时故障已消失"的误报（用户收到邮件后实测外网访问正常）。
      //   计数达标后立即再探 1 轮（attempts 次），仍全败才真正发信；
      //   已自愈则按抖动处理：不发信、状态归零重计，允许下次真实故障再次触发。
      const recheck = await probeRemoteRound();
      appendLog({ ts: new Date().toISOString(), down_recheck: { verdict: recheck.verdict, okCount: recheck.okCount, total: recheck.total } });
      if (recheck.verdict === 'down') {
        const sampleErrors = entry.remote.samples.map((s) => s.error || `status=${s.status}`).join('; ');
        alertMsg = { kind: 'down', subject: '[告警] honor10 远程访问不可达', body: `时间: ${entry.ts}\n本机 3081 直连正常，但外部链路（api 网关 → Worker → Tunnel）连续 ${state.downRounds} 轮 ${CONFIG.attempts} 次探测全部失败，且发送前即时复探仍全部失败。\n最近一轮错误: ${sampleErrors}\n大概率是 Cloudflare Tunnel/边缘链路问题，不是后端服务本身故障。` };
        state.lastVerdict = 'down_alerted';
      } else {
        // 自愈：从未 alert 过，不补发恢复邮件；归零重计
        state.downRounds = 0;
        state.lastVerdict = recheck.verdict;
        saveState(state);
        return { sent: false, selfHealed: true };
      }
    }
  } else {
    // ok 或 degraded
    if (state.lastVerdict === 'down_alerted') {
      alertMsg = { kind: 'recovered', subject: '[通知] honor10 远程访问已恢复', body: `时间: ${entry.ts}\n外部链路恢复，当前判定: ${effectiveVerdict}(${entry.remote.okCount}/${entry.remote.total})。` };
    }
    state.downRounds = 0;
    state.lastVerdict = effectiveVerdict;
  }

  saveState(state);

  if (alertMsg) {
    try {
      const { sendMail } = await import('../monitor/lib/notify.js');
      await sendMail(alertMsg.subject, alertMsg.body);
      appendLog({ ts: new Date().toISOString(), alert_sent: alertMsg.kind, subject: alertMsg.subject });
      return { sent: true, kind: alertMsg.kind };
    } catch (e) {
      appendLog({ ts: new Date().toISOString(), alert_error: String(e.message || e) });
      return { sent: false, error: String(e.message || e) };
    }
  }
  return { sent: false };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const loopArgIdx = process.argv.indexOf('--loop');
if (loopArgIdx !== -1) {
  const intervalSec = Math.max(30, Number(process.argv[loopArgIdx + 1]) || 300);
  (async () => {
    console.log(`[check-remote-access] 常驻模式启动，间隔 ${intervalSec}s`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const entry = await runOneRound({ verbose: true });
        const alertResult = await alertCheckAndMaybeSendMail(entry);
        if (alertResult.sent) console.log(`  → 已发送告警邮件: ${alertResult.kind}`);
      } catch (e) {
        console.error(`[check-remote-access] 本轮异常(不影响循环): ${e.message}`);
        appendLog({ ts: new Date().toISOString(), round_error: String(e.message || e) });
      }
      await sleep(intervalSec * 1000);
    }
  })();
} else {
  (async () => {
    const entry = await runOneRound({ verbose: true });
    const alertResult = await alertCheckAndMaybeSendMail(entry);
    console.log(JSON.stringify({ verdict: entry.remote.verdict, alert: alertResult }, null, 2));
  })();
}
