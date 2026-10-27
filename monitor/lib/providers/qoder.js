/**
 * Qoder CN（qoder.com.cn）Provider —— 每日 100 Credits 签到。
 *
 * 与 Trae/WorkBuddy/AutoClaw 同构（configSchema / checkin / getCredits / checkCredential /
 * checkStatus / getTotalCredits / probeSession），协议细节见 ../checkin/qoder.js 文件头。
 *
 * ★凭证形态：Qoder CN 客户端（Electron）里的 access token（dt-…，30 天）+ refresh token（drt-…，360 天）。
 *   两者都从本机已登录客户端导出：`tools/qoder-export.ps1` 读
 *   %APPDATA%\com.qodercn.app.stable\auth.v1.dat（DPAPI + OSCrypt v10 信封）→ 生成导入串 → 面板一键导入。
 *   ★续期会**同时轮换两个 token**：provider 每次续期后无条件回写 task.config.token /
 *     task.config.refreshToken / task.tokenExpiredAt / task.config.refreshTokenExpiresAt，
 *     漏写 = 旧串作废 + 下次必失效（与 AutoClaw 10-19 事故同型）。
 *
 * ★设备风控头（Cosy-Machine*）可选：2026-10-27 实测「四件套」（Authorization + Cosy-ClientType +
 *   User-Agent + Content-Type）即可读写签到；带上设备三件套（runtime-info 产出）更贴近客户端流量。
 *   注意 runtime-info 的身份会随时间轮换，不做强校验 —— 缺了不影响签到，失效时重新导入即可。
 *
 * E2E 实测（2026-10-27，账号 01a1625e…）：
 *   - campaigns 里「每天领 100 Credits」（campaignKey act-20261021-436）claimStatus=CLAIMED
 *   - 再打 claim → 200 {status:"CLAIMED", replayed:true}，不重复发积分 ⇒ 判为「今日已签到」
 *   - 刷新串轮换后复验 campaigns 仍 200 ⇒ 自动续期可用
 */
import { QoderClient, pickDailyCampaign, campaignTitle, describeBenefit, maskToken, dailyWindowOpen, remainingCredits } from '../checkin/qoder.js';
import { TIMEZONES, TIMES, THRESHOLDS, EXPIRY_DAYS } from './common.js';

/** access token 剩余不足该值时自动续期（dt- 不是 JWT，只能靠导入/续期时记录的到期时间） */
const TOKEN_MIN_REMAINING_MS = 24 * 60 * 60 * 1000;

/** 把裸错误归一成 {kind: invalid|throttle|transient} */
function classify(err) {
  if (err && err.kind) return err;
  const msg = (err && err.message ? err.message : String(err)).trim();
  const e = new Error(msg);
  const invalid = /HTTP 401|HTTP 403|token|凭证|登录|过期|失效|会话|unauthorized|expired|invalid|10019901001/i.test(msg);
  e.kind = invalid ? 'invalid' : 'transient';
  return e;
}

function clientFor(task) {
  const c = (task && task.config) || {};
  return new QoderClient({
    token: c.token,
    refreshToken: c.refreshToken,
    machineId: c.machineId,
    machineToken: c.machineToken,
    machineCode: c.machineCode,
    machineType: c.machineType,
    machineOs: c.machineOs,
    hostname: c.hostname,
    clientVersion: c.clientVersion,
  });
}

/** 需要续期？没有 token / 记录的到期时间已不足 24h */
function tokenNeedsRefresh(task) {
  const c = (task && task.config) || {};
  if (!c.token) return true;
  const exp = Number(c.tokenExpiredAt || task.tokenExpiredAt || 0);
  if (!exp) return false; // 没记录到期时间就先用着，401 再强制续期
  return exp - Date.now() < TOKEN_MIN_REMAINING_MS;
}

/**
 * 续期并把新凭证写回任务配置（调用方 executeTaskCheckin 会 saveTasks 持久化）。
 * @param {object} task
 * @param {object} [client] 已构造的客户端（复用，省一次解析）
 */
async function refreshTaskToken(task, client) {
  const c = task.config || (task.config = {});
  if (!c.refreshToken) {
    const e = new Error('未配置 refresh_token 且 access token 不可用，请重新导入 Qoder 凭证');
    e.kind = 'invalid';
    throw e;
  }
  const cli = client || clientFor(task);
  const r = await cli.refresh();
  c.token = r.token;
  c.refreshToken = r.refreshToken;   // ★无条件回写（轮换）
  c.tokenExpiredAt = r.expiresAt ? Date.parse(r.expiresAt) : c.tokenExpiredAt || null;
  c.refreshTokenExpiresAt = r.refreshExpiresAt ? Date.parse(r.refreshExpiresAt) : c.refreshTokenExpiresAt || null;
  task.tokenExpiredAt = c.tokenExpiredAt || null;
  task.refreshTokenExpiredAt = c.refreshTokenExpiresAt || null;
  return cli;
}

/** 取一个已就绪的客户端（必要时先续期） */
async function readyClient(task) {
  const cli = clientFor(task);
  if (tokenNeedsRefresh(task)) {
    await refreshTaskToken(task, cli);
  }
  return clientFor(task);
}

/**
 * 跑一次需要鉴权的调用；遇到 invalid（401/403）且有 refresh token 时强制续期并重试一次。
 * ★这是「导入时 token 已过期」与「服务端提前吊销」两种情况的兜底。
 */
async function withAuthRetry(task, fn) {
  const cli = await readyClient(task);
  try {
    return await fn(cli);
  } catch (err) {
    const e = classify(err);
    if (e.kind === 'invalid' && task.config && task.config.refreshToken) {
      const fresh = await refreshTaskToken(task);
      return fn(fresh);
    }
    throw e;
  }
}

function remainingOf(quota) {
  return remainingCredits(quota);
}

export default {
  id: 'qoder',
  name: 'Qoder CN',
  capabilities: ['checkin', 'credits', 'credentialTest', 'status', 'totalCredits', 'sessionProbe'],
  // 长期凭证 = refresh_token（drf… 360 天，每次续期轮换）；access token 是派生的 30 天短腿
  sessionCredentialKeys: ['refreshToken'],
  credDisplay: {
    ladder: [
      {
        label: 'Refresh Token', fields: ['refreshTokenExpiredAt', 'config.refreshTokenExpiresAt', 'cookieExpiresAt'], if: 'hasRefreshToken',
        title: 'Qoder CN 维护链终点：refresh_token 约 360 天，每次续期轮换出新串（provider 自动回写）。access token 约 30 天，每次签到前自动续期；两者都由 Windows 端「qoder-export」脚本从已登录客户端导出',
      },
      {
        label: 'Access Token', fields: ['tokenExpiredAt'], if: 'hasToken && noRefreshToken',
        title: '30 天短凭证：此账号没配 refresh_token，到期后无法自动续期，只能重新导入',
      },
    ],
  },
  namePlaceholder: '例：Qoder CN 主账号',
  configSchema: [
    // 纯展示字段：渲染一个下载按钮，不参与取值/提交（无 data-k，前端 collectFields 自动跳过）。
    // 面板下载时把脚本里的 __API_BASE__ 替换成 location.origin，于是脚本既能只输出导入串，
    // 也能直接写回本服务端 —— 全程不硬编码任何地址。需要 PowerShell 7（AES-GCM）。
    {
      key: '__exportScript', label: '① 提取凭证', type: 'download',
      href: '/qoder-export.bat', text: '下载 Windows 提取脚本',
      hint: '在装有已登录 Qoder CN 客户端的 Windows 上双击运行（需 PowerShell 7）：只读客户端 auth.v1.dat + UMID 组件 → 输出 QODER1.… 导入串，并可直接写回本面板（新增 or 更新自动判断）。不会修改客户端文件。',
    },
    {
      key: 'token', label: '② Access Token（dt-… 约 30 天）', type: 'password', required: false,
      placeholder: '粘贴 dt-… 或留空（有 refresh token 时自动换新）',
      hint: '推荐用面板「导入 Qoder 凭证」：在装有已登录 Qoder CN 客户端的 Windows 上运行 tools/qoder-export.ps1，把导入串贴回来即可自动填好 token / refreshToken / 设备身份。',
    },
    {
      key: 'refreshToken', label: 'Refresh Token（drt-… 约 360 天）', type: 'password', required: false,
      placeholder: '建议填写：没有它 access token 到期后无法自动续期',
      hint: '每次续期都会轮换出新的 refresh_token，本模块会自动回写；约 360 天一次需要重新导出。',
    },
    {
      key: 'machineToken', label: '设备身份 MachineToken（可选）', type: 'password', required: false,
      hint: 'Qoder 客户端 UMID 组件产出（machineToken/machineCode/machineType 三件套）。导入时自动填；缺失时用最小鉴权四件套，实测同样可签到。',
    },
    { key: 'machineCode', label: '设备身份 MachineCode（可选）', type: 'password', required: false },
    { key: 'machineType', label: '设备身份 MachineType（可选）', type: 'password', required: false },
    { key: 'machineId', label: '设备 MachineId（可选）', type: 'password', required: false,
      hint: '客户端 ~/.qoder-cn/.auth/machine_id，导入时自动填。' },
    { key: 'machineOs', label: '设备系统标识（可选）', type: 'text', required: false,
      hint: 'Cosy-MachineOS，形如 x86_64_win32（导入时自动填）。' },
    { key: 'hostname', label: '设备主机名（可选）', type: 'text', required: false },
    { key: 'time', label: '签到时间', type: 'select', default: '10:05', required: true,
      options: TIMES.map(([v, l]) => ({ value: v, label: l })),
      hint: '上游每日 10:00（UTC+8）开窗，建议 10:00 之后。' },
    { key: 'timezone', label: '时区(IANA)', type: 'select', default: 'Asia/Shanghai', required: true,
      options: TIMEZONES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'failThreshold', label: '连续失败告警阈值', type: 'select', default: 3,
      options: THRESHOLDS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'cookieExpiryNotify', label: '凭证到期提前邮件通知', type: 'toggle', default: true },
    { key: 'cookieExpiryNotifyDays', label: '凭证到期前何时通知', type: 'select', default: 7,
      options: EXPIRY_DAYS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'notifyOnSuccess', label: '成功也发通知', type: 'toggle', default: false },
  ],

  /** 执行一次签到：查状态 → 可领则领 → 回读余额 */
  async checkin(task) {
    try {
      return await withAuthRetry(task, async (cli) => {
        const res = await cli.checkin();
        return {
          ok: true,
          alreadyCheckedIn: res.alreadyCheckedIn,
          credits: res.credits,
          reward: res.reward || null,
          claimStatus: res.claim ? res.claim.status : (res.alreadyCheckedIn ? 'CLAIMED' : null),
          campaignTitle: campaignTitle(res.campaign),
          benefitText: describeBenefit(res.reward),
        };
      });
    } catch (err) {
      throw classify(err);
    }
  },

  /** 当前可用积分（套餐 + 加油包） */
  async getCredits(task) {
    try {
      const quota = await withAuthRetry(task, (cli) => cli.quota());
      return { ok: true, credits: remainingOf(quota) };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 测试凭证有效性：活动列表能读到即视为有效 */
  async checkCredential(task) {
    try {
      const st = await withAuthRetry(task, (cli) => cli.status());
      return { ok: true, campaigns: st.rows.length, checkedIn: st.checkedIn };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 今日签到状态（不领取）+ 当前积分 */
  async checkStatus(task) {
    try {
      const out = await withAuthRetry(task, async (cli) => {
        const st = await cli.status();
        let credits = null;
        try { credits = remainingCredits(await cli.quota()); } catch { /* 忽略 */ }
        return { st, credits };
      });
      return {
        ok: true,
        checked_in: out.st.checkedIn,
        claimable: !!out.st.claimable,
        credits: out.credits,
        statusDescription: out.st.campaign
          ? `${campaignTitle(out.st.campaign)}（${out.st.campaign.claimStatus}）`
          : (dailyWindowOpen() ? '今日活动未下发' : '今日 10:00 开窗'),
      };
    } catch (err) {
      throw classify(err);
    }
  },

  /** 账户总可用积分 */
  async getTotalCredits(task) {
    try {
      const quota = await withAuthRetry(task, (cli) => cli.quota());
      return { ok: true, total: remainingOf(quota) };
    } catch (err) {
      throw classify(err);
    }
  },

  /**
   * 凭证会话探测（到期监控用）：优先本地到期时间（导入/续期时记录），无网络开销；
   * 没有记录时做一次只读网络探测。
   */
  async probeSession(task) {
    const c = (task && task.config) || {};
    if (!c.token && !c.refreshToken) {
      return { ok: false, isLogin: false, expiresAt: null, error: '未配置凭证' };
    }
    const refreshExp = Number(c.refreshTokenExpiresAt || 0) || null;
    const tokenExp = Number(c.tokenExpiredAt || task.tokenExpiredAt || 0) || null;
    if (refreshExp && refreshExp <= Date.now()) {
      return { ok: false, isLogin: false, expiresAt: refreshExp, error: 'refresh_token 已过期，请重新导入' };
    }
    if (c.refreshToken && refreshExp) {
      return { ok: true, isLogin: true, expiresAt: refreshExp };
    }
    if (tokenExp && tokenExp <= Date.now()) {
      return { ok: false, isLogin: false, expiresAt: tokenExp, error: 'access token 已过期且无 refresh_token' };
    }
    try {
      const st = await withAuthRetry(task, (cli) => cli.status());
      return { ok: true, isLogin: true, expiresAt: refreshExp || tokenExp || null, campaigns: st.rows.length };
    } catch (err) {
      const e = classify(err);
      if (e.kind === 'invalid') return { ok: false, isLogin: false, expiresAt: null, error: e.message };
      throw e;
    }
  },
};
