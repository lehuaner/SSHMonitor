/**
 * CodeArts（码道 Agent）Provider —— 包装 lib/checkin/codearts.js 的 CodeArtsClient。
 *
 * 职责：
 *   - 定义前端动态表单的 configSchema（账号密码 + ★hwid_cas_sid 设备信任令牌）
 *   - 实现 checkin / getCredits / checkCredential / checkStatus / getTotalCredits / probeSession
 *   - 会话失效时用「账号密码 + hwid_cas_sid」自动重登（sid 有效 → 跳过新设备验证）
 *   - ★设备验证接口 requestVerifyCode / submitVerifyCode：
 *     仅当 hwid_cas_sid 也失效（或换设备）时才需要人工填一次验证码；
 *     2026-09-12 按抓包改走 **UnifiedIDMPortal 同端点重试**（`opType=1` + 验证码），
 *     已在纯 HTTP 下打通（旧实现误用 CAS 命名空间，才表现为「走不通」）。
 *     成功即落地会话，失败则明确告知需改用浏览器导出 cookie。
 *   - 把 CodeArtsClient 抛出的错误归一化分类（invalid=会话失效 / transient=临时失败）
 *
 * 主方案（用户提供）：持久化 hwid_cas_sid。
 *   hwid_cas_sid 是华为侧「受信设备」令牌（约 10 年），随登录结果一起落盘；
 *   后续每次登录/重登都携带它 → 设备已被信任 → 不再触发新设备验证码。
 */
import { CodeArtsClient } from '../checkin/codearts.js';

// 三个平台共用的表单常量与「积分过期提醒」配置片段
import { TIMEZONES, TIMES, THRESHOLDS, EXPIRY_DAYS } from './common.js';

// 验证会话缓存：requestVerifyCode 与 submitVerifyCode 之间必须复用同一个客户端
// （fp / pageToken / 登录流程上下文都在客户端内存里，换实例就失效）
const VERIFY_TTL_MS = 10 * 60 * 1000;
const pendingVerify = new Map(); // taskId -> { client, at }

function gcPending() {
  const now = Date.now();
  for (const [id, p] of pendingVerify) if (now - p.at > VERIFY_TTL_MS) pendingVerify.delete(id);
}

/** epoch 秒 → 「YYYY-MM-DD」（Asia/Shanghai）—— 用量分析接口要求日期字符串 */
function ymd(sec) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date((Number(sec) || Date.now() / 1000) * 1000));
}

/** ISO 时间串（如 2026-09-10T05:15:52.000+00:00）→ 「YYYY-MM-DD」（Asia/Shanghai 自然日） */
function ymdFromIso(iso) {
  const t = Date.parse(iso);
  if (!t) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(t));
}

function buildClient(task) {
  const c = task.config || {};
  return new CodeArtsClient({
    account: c.account,
    password: c.password,
    hwidCasSid: c.hwidCasSid,
    localStorageId: c.localStorageId,
    cookies: c.cookies,
    fpSeed: c.fpSeed || 'codearts-checkin',
    timeout: c.timeout || 25000,
    verbose: !!c.debug,
  });
}

/** 把客户端最新会话状态写回 task.config（由调用方负责持久化） */
function persist(task, client) {
  try {
    const st = client.getState();
    if (st.hwidCasSid) task.config.hwidCasSid = st.hwidCasSid;
    if (st.localStorageId) task.config.localStorageId = st.localStorageId;
    if (st.cookies && Object.keys(st.cookies).length) task.config.cookies = st.cookies;
  } catch { /* 状态回写失败不影响主流程 */ }
}

/** 归一化错误：保留 CodeArtsClient 已标注的 kind，其余按凭证无效/临时失败分类 */
function classify(err) {
  const msg = (err && err.message ? err.message : String(err)).trim();
  const e = new Error(
    err && err.needVerify
      ? `${msg}（设备未受信，需要在账号上点「获取验证码」完成一次设备验证）`
      : msg
  );
  if (err && err.kind) e.kind = err.kind;
  if (err && err.needVerify) { e.needVerify = true; e.authDevices = err.authDevices || []; }
  if (e.kind) return e;

  if (/账号或密码|未配置账号|缺少账号/i.test(msg)) {
    e.kind = 'invalid';
  } else if (
    /HW-AJAX-REDIRECT|登录态失效|会话已失效|会话不可用|凭证|未授权|invalid|expired|unauthorized/i.test(msg)
    || /HTTP 401|HTTP 403/.test(msg)
  ) {
    e.kind = 'invalid';
  } else {
    e.kind = 'transient';
  }
  return e;
}

export default {
  id: 'codearts',
  name: 'CodeArts 码道',
  capabilities: ['checkin', 'credits', 'credentialTest', 'status', 'totalCredits', 'sessionProbe', 'verifyCode', 'usage', 'packages'],
  // 会话到期巡检使用的配置键：Trae 用 cookie，CodeArts 用 hwid_cas_sid / cookies
  sessionCredentialKeys: ['hwidCasSid', 'cookies'],
  // ★用量能力声明：CodeArts 用量分析接口（analytics/usage/personal/charts）逐日返回 TOKEN_TOTAL，
  //   逐日 token 矩阵完整可用（积分同样逐日可取）。
  usageMeta: {
    tokens: true,
    tokenNote: null,
  },
  // ★卡片凭证行（维护链终点口径）：CodeArts 没有可预知的终点 —— 业务 cookie 为会话态、
  //   hwid_cas_sid 为约 10 年的设备信任令牌，失效时用账号密码自动重登，
  //   probeSession 恒返 expiresAt:null，所以永远显示「—」（真失效走探活告警）。
  credDisplay: {
    ladder: [
      { label: '凭证', fields: ['cookieExpiresAt'],
        title: 'CodeArts 无固定维护日：会话为会话态、无名义到期，失效时用华为账号密码自动重登；只有需要新设备验证时才点「设备验证」' },
    ],
  },
  // 「新增账号 → 名称」输入框的占位提示（各平台命名习惯不同）
  namePlaceholder: '例：CodeArts 码道 · 138xxxx0000',
  configSchema: [
    { key: 'account', label: '华为账号（手机号）', type: 'text', required: true,
      placeholder: '如 138xxxx0000',
      hint: '用于会话失效时自动重新登录（自动补 0086 前缀）。仅本地保存。' },
    { key: 'password', label: '密码', type: 'password', required: true,
      hint: '仅本地保存，用于自动重登。' },
    { key: 'hwidCasSid', label: 'hwid_cas_sid（设备信任令牌 · ★推荐）', type: 'password', required: false,
      placeholder: '浏览器 Cookie 里的 hwid_cas_sid 值',
      hint: '★主方案：华为侧「受信设备」令牌（约 10 年有效）。填入后每次重登都会带上它，跳过新设备验证码。首次登录成功后系统会自动回填（无需手填）。获取方式：浏览器登录 codearts.huaweicloud.com 后，F12 → 应用 → Cookie → 复制 hwid_cas_sid。' },
    { key: 'localStorageId', label: 'localStorageID（可选）', type: 'text', required: false,
      hint: '登录页 localStorage 中的设备标识，留空由服务端下发。一般无需填写。' },
    { key: 'fpSeed', label: '指纹种子 (fpSeed)', type: 'text', default: 'codearts-checkin', required: true,
      hint: '设备指纹的唯一输入（内部做 XOR + SHA1 自校验），同一部署固定即可。改变它等价于换一台「新设备」，可能重新触发设备验证。' },
    { key: 'time', label: '签到时间', type: 'select', default: '09:00', required: true,
      options: TIMES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'timezone', label: '时区(IANA)', type: 'select', default: 'Asia/Shanghai', required: true,
      options: TIMEZONES.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'failThreshold', label: '连续失败告警阈值', type: 'select', default: 3,
      options: THRESHOLDS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'cookieExpiryNotify', label: '会话失效提醒', type: 'toggle', default: true,
      hint: '会话探活失败（hwid_cas_sid 失效且无法自动重登）时发邮件提醒。' },
    { key: 'cookieExpiryNotifyDays', label: '会话失效前何时通知', type: 'select', default: 1,
      options: EXPIRY_DAYS.map(([v, l]) => ({ value: v, label: l })) },
    { key: 'notifyOnSuccess', label: '成功也发通知', type: 'toggle', default: false },
  ],

  /** 执行一次签到：探活 → has-claimed → claim → 用前后余额差算当日所得 */
  async checkin(task) {
    const client = buildClient(task);
    try {
      const res = await client.checkin();
      persist(task, client);
      return {
        ok: true,
        alreadyCheckedIn: res.alreadyCheckedIn,
        credits: res.credits ?? null,
        reward: res.reward ?? null,
      };
    } catch (err) {
      persist(task, client); // 重登/探活过程中刷新的 hwid_cas_sid 也要存下来
      throw classify(err);
    }
  },

  /** 查询当前积分余额 */
  async getCredits(task) {
    const client = buildClient(task);
    try {
      const c = await client.getCredits();
      persist(task, client);
      return { ok: true, credits: c.remain ?? null };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /** 测试凭证有效性：签到状态可读即视为有效 */
  async checkCredential(task) {
    const client = buildClient(task);
    try {
      await client.getStatus();
      persist(task, client);
      return { ok: true };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /** 查询今日签到状态 + 当前积分（不领取） */
  async checkStatus(task) {
    const client = buildClient(task);
    try {
      const st = await client.getStatus();
      persist(task, client);
      return { ok: true, checked_in: !!st.checkedInToday, credits: st.credits ?? null };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /** 账户总可用积分（CodeArts 无「权益包列表」，用 package/overview 的剩余额度） */
  async getTotalCredits(task) {
    const client = buildClient(task);
    try {
      const c = await client.getCredits();
      persist(task, client);
      return {
        ok: true,
        total: c.remain ?? null,
        packs: { basic: c.breakdown.basic, bonus: c.breakdown.bonus },
        checkins: null,
      };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  // ------------------------------------------------------------------
  // 用量统计（★真实远端端点：analytics/usage/personal/*，与个人用量页同源）
  // ------------------------------------------------------------------

  /**
   * 逐日消耗（checkin-stats 的 getDailyUsage 契约）。
   *   - 逐日积分/token：charts xDimension=DATE_DAY（★准确到日）
   *   - 按模型：charts xDimension=MODEL（★只有区间累计，没有「日期×模型」矩阵；
   *     当区间内只有一个模型、或只有一个有消耗的日子时，可无歧义地落到逐日模型上）
   * @returns {Promise<{ok:boolean, days:Object, modelTotals:Array, source:string, note:?string}>}
   */
  async getDailyUsage(task, { startSec, endSec } = {}) {
    const client = buildClient(task);
    try {
      const startDate = ymd(startSec);
      const endDate = ymd(endSec);
      const METRICS = ['TOTAL_CREDITS', 'TOKEN_TOTAL'];
      const daily = await client.usageChart({ startDate, endDate, metrics: METRICS, xDimension: 'DATE_DAY' });
      const byModel = await client.usageChart({ startDate, endDate, metrics: METRICS, xDimension: 'MODEL' });
      persist(task, client);

      const pick = (map) => {
        const out = {};
        for (const c of map || []) {
          const k = c && c.xLabel;
          if (k) out[k] = (out[k] || 0) + (Number(c.value) || 0);
        }
        return out;
      };
      const credDay = pick(daily.TOTAL_CREDITS);
      const tokDay = pick(daily.TOKEN_TOTAL);
      const credModel = pick(byModel.TOTAL_CREDITS);
      const tokModel = pick(byModel.TOKEN_TOTAL);

      // 只有「有消耗」的日期入库；其余日期由 checkin-stats 补 0
      const days = {};
      for (const d of new Set([...Object.keys(credDay), ...Object.keys(tokDay)])) {
        const total = credDay[d] || 0;
        const tokens = tokDay[d] || 0;
        if (total === 0 && tokens === 0) continue;
        days[d] = { total, tokens, models: {}, modelTokens: {} };
      }

      const modelNames = [...new Set([...Object.keys(credModel), ...Object.keys(tokModel)])]
        .filter((m) => m && (credModel[m] || tokModel[m]));
      const modelTotals = modelNames
        .map((model) => ({ model, credits: credModel[model] || 0, tokens: tokModel[model] || 0 }))
        .sort((a, b) => b.credits - a.credits);

      // 模型归属：单模型 或 单消耗日 → 可精确归属；否则不拆分（不臆造）
      const consumingDays = Object.keys(days);
      const exact = modelNames.length <= 1 || consumingDays.length <= 1;
      if (exact) {
        if (modelNames.length === 1) {
          const m = modelNames[0];
          for (const d of consumingDays) {
            days[d].models = { [m]: days[d].total };
            days[d].modelTokens = { [m]: days[d].tokens };
          }
        } else if (consumingDays.length === 1) {
          const d = consumingDays[0];
          for (const mt of modelTotals) {
            days[d].models[mt.model] = mt.credits;
            days[d].modelTokens[mt.model] = mt.tokens;
          }
        }
      }

      // ★区间汇总（analytics/usage/personal/stats）：除逐日外还能拿到
      //   请求数 / 活跃天数 / token 日均 / 缓存命中 token，一并带出供面板展示。
      //   失败不影响逐日主流程（汇总只作补充）。
      const summary = await this.getUsageSummary(task, { startSec, endSec }).catch(() => null);

      return {
        ok: true,
        days,
        modelTotals,
        summary,
        source: 'remote',
        sourceLabel: 'CodeArts 用量分析接口',
        note: exact ? null
          : '该平台只提供逐日总量与区间模型累计，不提供「日期×模型」矩阵，故模型归属未按日拆分。',
      };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /**
   * ★远端签到历史（补「近30天」日历里本机没跑过的那些天）。
   *
   * 为什么需要它：本机 checkin_logs.json 只记录「本部署真正执行过签到的那几天」，
   * 新接入的账号（或中途换机/重装）会出现「平台侧明明连着签了好几天，日历却只有一天」。
   *
   * 数据源：权益包明细 POST /portal/snap-manager/v1/package/credit/page
   *   每日签到会新增一条 resourceSpec = `codearts.agent.individual.credits.bonus.daily_login`
   *   的赠送包，`createdTime` 即当天签到时间，`creditAmount` 即当天发放积分 ——
   *   所以这份「包列表」就是平台侧权威的逐日签到流水。
   *
   * @returns {Promise<Array<{date:string, credits:?number, source:string}>>} 按日期升序
   */
  async getCheckinHistory(task, { days = 30 } = {}) {
    const client = buildClient(task);
    try {
      const cutoff = ymd(Math.floor(Date.now() / 1000) - (days - 1) * 86400);
      const seen = new Set();
      const out = [];

      // ★① 现行数据源：运营活动中心「每日签到」的领取流水
      //   GET /ops/delivery → campaignId → GET /ops/credit/campaign/{id} → benefits[].claimedAt
      //   （2026-09-12 签到迁移到 ops/claim 之后，旧「权益包明细」不再新增签到包）
      try {
        const d = await client.dailyCampaign();
        if (d.code === 0 && d.campaign) {
          const cm = await client.opsCampaignCredit(d.campaign.campaignId);
          for (const b of cm.benefits || []) {
            const date = ymdFromIso(b.claimedAt);
            if (!date || date < cutoff || seen.has(date)) continue;
            seen.add(date);
            out.push({
              date,
              credits: Number(b.claimedAmount) || null,
              source: 'codearts 运营活动(每日签到)领取记录',
            });
          }
        }
      } catch { /* 旧数据源兜底 */ }

      // ② 兜底/补历史：迁移前的「套餐积分-每日签到赠送包」
      try {
        const all = [];
        for (let p = 1; p <= 5; p++) {
          const r = await client.creditPage({ pageNum: p, pageSize: 20 });
          all.push(...r.list);
          if (all.length >= r.total || r.list.length < r.pageSize) break;
        }
        for (const p of all) {
          if (!/bonus\.daily_login/i.test(p.resourceSpec || '')) continue;
          const date = ymdFromIso(p.createdTime);
          if (!date || date < cutoff || seen.has(date)) continue;
          seen.add(date);
          out.push({
            date,
            credits: Number(p.creditAmount) || null,
            source: 'codearts 权益包明细(每日签到包·迁移前)',
          });
        }
      } catch { /* 旧接口可能已下线，忽略 */ }

      persist(task, client);
      return out.sort((a, b) => (a.date < b.date ? -1 : 1));
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /**
   * 区间汇总（不依赖「日期缺口」，面板随时可见的「近 N 天」聚合）。
   *
   * ★关于「CodeArts 有没有『近30天』端点」：没有单独端点，但有**日期区间端点**——
   *   POST /portal/dataflywheel/datapreprocess/v1/analytics/usage/personal/stats
   *   入参 {startDate, endDate, metrics}，把 endDate-startDate 设成 30 天就是「近30天」；
   *   页面上「近7天 / 近30天 / 自定义」只是换这两个参数。
   *   真正缺的是「逐请求/逐会话明细」端点（所以「积分消耗明细」只能降到逐日）。
   *
   * @returns {Promise<?{range:{start,end,days},credits,tokens,tokensDailyAvg,requests,activeDays,cacheHitTokens,source:string}>}
   */
  async getUsageSummary(task, { startSec, endSec } = {}) {
    const client = buildClient(task);
    try {
      const startDate = ymd(startSec);
      const endDate = ymd(endSec);
      const st = await client.usageStats({
        startDate, endDate,
        metrics: ['TOTAL_CREDITS', 'TOKEN_TOTAL', 'TOKEN_DAILY_AVG', 'REQUEST_COUNT', 'ACTIVE_DAYS', 'TOKEN_CACHE_HIT'],
      });
      persist(task, client);
      const days = Math.round((Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000) + 1;
      return {
        range: { start: startDate, end: endDate, days },
        credits: st.TOTAL_CREDITS ?? null,
        tokens: st.TOKEN_TOTAL ?? null,
        tokensDailyAvg: st.TOKEN_DAILY_AVG ?? null,
        requests: st.REQUEST_COUNT ?? null,
        activeDays: st.ACTIVE_DAYS ?? null,
        cacheHitTokens: st.TOKEN_CACHE_HIT ?? null,
        source: 'CodeArts 用量分析接口 stats（区间参数）',
      };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /**
   * 权益包明细，面板「权益包」浮层数据源。
   *
   * ★数据源优先级：
   *   1) POST /portal/snap-manager/v1/package/credit/page —— 逐包明细（真实端点，
   *      含 packageType / creditAmount / creditUsed / expiredTime），一条一个包，
   *      能看出「哪一天签到送的包、什么时候过期、用掉多少」；
   *   2) package/overview 的 4 个聚合桶（all/basic/bonus/ondemand）—— 端点不可用时的降级。
   */
  async getPackages(task) {
    const client = buildClient(task);
    try {
      const c = await client.getCredits();
      const plan = await client.packageInfo().catch(() => null);
      // 逐包明细（最多取 5 页 = 100 条，足够覆盖历史赠送包）
      let detail = null;
      try {
        const acc = [];
        for (let p = 1; p <= 5; p++) {
          const r = await client.creditPage({ pageNum: p, pageSize: 20 });
          acc.push(...r.list);
          if (acc.length >= r.total || r.list.length < r.pageSize) break;
        }
        detail = acc;
      } catch { detail = null; }
      persist(task, client);

      const SPEC_LABEL = [
        [/bonus\.daily_login$/i, '每日签到赠送包'],
        [/bonus\.new_subscribe$/i, '新订阅赠送包'],
        [/bonus\./i, '赠送包'],
        [/\.trial$/i, '个人体验版基础包'],
        [/basic\./i, '基础包'],
      ];
      const specName = (spec) => {
        for (const [re, label] of SPEC_LABEL) if (re.test(spec || '')) return label;
        return spec || '权益包';
      };
      const TYPE_LABEL = { bonus: '赠送包', basic: '基础包', ondemand: '按需包', all: '总额度' };

      let list = [];
      if (detail && detail.length) {
        list = detail.map((p) => {
          const size = Number(p.creditAmount) || 0;
          const used = Number(p.creditUsed) || 0;
          return {
            kind: 'credit',
            packageCode: p.resourceSpec || p.packageType || 'credit',
            packageName: `${TYPE_LABEL[p.packageType] || p.packageType || '权益包'} · ${specName(p.resourceSpec)}`,
            size,
            used,
            remain: Math.max(0, size - used),
            unit: 'credits',
            cycleStart: p.createdTime ? String(p.createdTime).slice(0, 10) : '',
            cycleEnd: p.expiredTime ? String(p.expiredTime).slice(0, 10) : '',
            // ★归一后的到期毫秒（积分过期提醒直接读这个）。
            //   expiredTime 是带偏移的 ISO 串（实测 "2026-10-10T15:59:59.000+00:00"），Date.parse 即可。
            cycleEndMs: Date.parse(p.expiredTime) || null,
            extra: p.resourceId || '',
          };
        });
      }
      if (!list.length) {
        const raw = c.raw || {};
        const mk = (label, p) => (p ? {
          kind: 'credit', packageCode: label, packageName: label,
          remain: p.package_credit_remain ?? 0,
          size: p.package_credit_amount ?? 0,
          used: p.package_credit_used ?? 0,
          unit: 'credits', cycleStart: '', cycleEnd: '', extra: p.resource_id || '',
        } : null);
        list = [
          mk('总额度 (all_credit_package)', raw.all_credit_package),
          mk('基础包 (basic_package)', raw.basic_package),
          mk('赠送包 (bonus_credit_package)', raw.bonus_credit_package),
          mk('按需包 (ondemand_credit_package)', raw.ondemand_credit_package),
        ].filter(Boolean);
      }
      const free = (detail || []).filter((p) => p.packageType !== 'ondemand').length;
      const paid = (detail || []).filter((p) => p.packageType === 'ondemand').length;
      return {
        ok: true,
        total: c.remain,
        capacity: c.amount,
        used: c.used,
        list,
        free: detail ? free : list.length,
        paid: detail ? paid : 0,
        perPackage: !!detail,
        source: 'package/credit/page',
        summary: list.map((x) => ({ code: x.packageName, total: x.size, remain: x.remain, used: x.used })),
        specCode: plan && plan.data ? plan.data.spec_code : null,
        status: plan && plan.data ? plan.data.status : null,
      };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /**
   * 会话探活（供会话失效监控使用）。
   * CodeArts 的会话时效无法从 cookie 解析（业务 cookie 为会话态、hwid_cas_sid 为长期令牌），
   * 故 expiresAt 恒为 null：只在「探活失败」时由调度层判定为立即失效。
   *
   * ★2026-09-12 修复：改用 ensureSession 而非 checkSession。
   *   原实现只检查当前业务 cookie 是否有效，但 CodeArts 签到靠 ensureSession 自动重登
   *   （hwid_cas_sid 长期令牌 + 账号密码）。业务 cookie 过期但 hwid_cas_sid 仍有效时，
   *   原实现会误判 isLogin=false → 发"凭证已失效"邮件，而实际签到仍能成功。
   *   现与签到保持一致：ensureSession.ok=true 或 needVerify（设备未受信但凭证有效）
   *   均视为凭证可用，只有真正无法重登才判失效。
   * @returns {Promise<{ok:boolean, isLogin:boolean, expiresAt:null}>}
   */
  async probeSession(task) {
    const client = buildClient(task);
    try {
      const r = await client.ensureSession();
      persist(task, client);
      // ok=true：当前会话有效或已自动重登 → 凭证可用
      // needVerify：设备未受信，凭证本身有效但需人工验证 → 不应判凭证失效
      return { ok: true, isLogin: !!r.ok || !!r.needVerify, expiresAt: null };
    } catch (err) {
      persist(task, client);
      // 网络等临时失败：标 transient，调度层会静默跳过沿用旧缓存
      if (!err.kind) err.kind = 'transient';
      throw err;
    }
  },

  // ------------------------------------------------------------------
  // 设备验证接口（仅在 hwid_cas_sid 也失效时才需要）
  // ★ 2026-09-12：改走 UnifiedIDMPortal 同端点重试，纯 HTTP 已可完成
  // ------------------------------------------------------------------

  /**
   * 「获取验证码」：尝试登录；若设备已受信则直接建立会话；
   * 否则触发下发验证码并返回可选设备列表。
   * @returns {Promise<{ok:boolean, alreadyTrusted?:boolean, authDevices?:Array, hint?:string, error?:string}>}
   */
  async requestVerifyCode(task) {
    gcPending();
    const client = buildClient(task);
    try {
      const r = await client.login();
      persist(task, client);

      if (r.ok && !r.needVerify) {
        return { ok: true, alreadyTrusted: true, message: '设备已受信（hwid_cas_sid 有效），无需验证码' };
      }
      if (!r.ok && !r.needVerify) {
        return {
          ok: false,
          error: r.error || '登录失败',
          errorCode: r.errorCode,
          riskCaptcha: r.riskCaptcha,   // ★ 图片验证码风控门：透传给 UI 判失败
        };
      }

      let devices = r.authDevices || [];
      // ★ 手机号分支（2026-09-12 抓包）：sent=0 的列表 ≠ 验证码已发 —— 只有设备项
      //   （sent=1）会在 10002080 时自动下发。列表里没有 sent=1 项时必须补调
      //   requestVerifyCode() → 内部 getSMSCodeV3 真正把短信发出去。
      if (!devices.some((d) => d.sent === 1)) {
        const vr = await client.requestVerifyCode();
        persist(task, client);
        if (vr.alreadyTrusted) {
          return { ok: true, alreadyTrusted: true, message: '设备已受信（hwid_cas_sid 有效），无需验证码' };
        }
        if (vr.ok) devices = vr.authDevices;
        else {
          return {
            ok: false,
            error: vr.error || '验证码下发失败',
            errorCode: vr.errorCode,
            riskCaptcha: vr.riskCaptcha,
          };
        }
      }

      pendingVerify.set(task.id, { client, at: Date.now() });
      const phoneOnly = devices.length > 0
        && devices.every((d) => Number(d.accountType) === 2);
      return {
        ok: true,
        authDevices: devices,
        hint: phoneOnly
          ? '验证码已通过短信发送到绑定手机号，请填入收到的 6 位数字'
          : '验证码已下发至下列设备，请填入收到的 6 位数字',
      };
    } catch (err) {
      persist(task, client);
      throw classify(err);
    }
  },

  /**
   * 「提交验证码」：同端点带 `opType=1` 重放 → 信任本机 → 重走 OAuth 落地会话。
   * @param {object} task
   * @param {string} code 用户收到的验证码
   * @param {number} [deviceIndex] 设备序号（多设备时选择）
   */
  async submitVerifyCode(task, code, deviceIndex = 0) {
    gcPending();
    const p = pendingVerify.get(task.id);
    if (!p) return { ok: false, error: '验证会话已过期，请重新点击「获取验证码」' };

    const r = await p.client.submitVerifyCode(code, deviceIndex);
    persist(task, p.client);
    if (r.ok) {
      pendingVerify.delete(task.id);
      return { ok: true, message: '设备验证通过，会话已建立' };
    }
    if (r.landingFailed) {
      // 验证码本身通过了，只是换票/落地没成功 → 保留会话，可再点一次「获取验证码」
      return { ok: false, landingFailed: true, error: `验证码已通过，但会话落地失败：${r.error}` };
    }
    const code2 = String(r.errorCode || '');
    const hint = code2 === '10002080'
      ? '（服务端仍要求设备验证：验证码可能已过期，请重新获取）'
      : (code2 === '10000000' ? '（登录流程上下文已失效，请重新点击「获取验证码」）' : '');
    return { ok: false, error: `${r.error || '验证码校验失败'}${hint}`, errorCode: r.errorCode };
  },

  /** 丢弃当前验证会话（用户取消/超时） */
  cancelVerifyCode(task) {
    return { ok: pendingVerify.delete(task.id) };
  },
};
