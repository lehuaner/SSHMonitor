/**
 * 两个新 Provider 的本地自检（不依赖远端）：node monitor/_selftest_providers.mjs
 *   1) 静态契约：id / capabilities 与实际方法是否一一对应；configSchema 字段完整性
 *   2) WorkBuddy 逻辑分支：mock fetch 覆盖「已签 / 首签 / 10001 / 401」四条路径
 *   3) 真实只读探活（有凭证才跑）：WorkBuddy(抓包 cookie) + CodeArts(examples/.codearts_session.json)
 */
import { readFileSync } from 'node:fs';
import workbuddy from './lib/providers/workbuddy.js';
import codearts from './lib/providers/codearts.js';
import { getProviderSchemas } from './lib/providers/index.js';
import { registerProvider } from './lib/providers/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------------------
section('1. 静态契约');
for (const p of [workbuddy, codearts]) {
  ok(!!p.id && !!p.name, `${p.id}: 有 id/name`);
  ok(Array.isArray(p.configSchema) && p.configSchema.length > 5, `${p.id}: configSchema 字段数 ${p.configSchema.length}`);
  // schema 字段完整性
  const bad = p.configSchema.filter((f) => !f.key || !f.label || !f.type
    || (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length))
    || (f.type === 'select' && f.options.some((o) => o.value === undefined || !o.label)));
  ok(bad.length === 0, `${p.id}: 所有字段含 key/label/type（select 含 options）${bad.length ? ' 问题字段:' + bad.map((f) => f.key) : ''}`);
  // capabilities ↔ 方法映射
  const map = {
    checkin: 'checkin', credits: 'getCredits', credentialTest: 'checkCredential',
    status: 'checkStatus', totalCredits: 'getTotalCredits', sessionProbe: 'probeSession',
    verifyCode: 'requestVerifyCode', packages: 'getPackages',
  };
  const missing = p.capabilities.map((c) => map[c]).filter((m) => m && typeof p[m] !== 'function');
  ok(missing.length === 0, `${p.id}: capabilities 与实现一致${missing.length ? ' 缺:' + missing : ''}`);
  ok(p.capabilities.includes('verifyCode') === (typeof p.requestVerifyCode === 'function'),
    `${p.id}: verifyCode 能力与 requestVerifyCode 实现匹配`);
  ok(p.capabilities.includes('usage') ===
    (typeof p.getUsage === 'function' || typeof p.getDailyUsage === 'function'),
    `${p.id}: usage 能力 ↔ getUsage/getDailyUsage 实现匹配`);
  ok(Array.isArray(p.sessionCredentialKeys) && p.sessionCredentialKeys.length > 0,
    `${p.id}: 声明 sessionCredentialKeys=${JSON.stringify(p.sessionCredentialKeys)}`);
}
const schemas = (registerProvider(workbuddy), registerProvider(codearts), getProviderSchemas());
ok(schemas.some((s) => s.id === 'workbuddy') && schemas.some((s) => s.id === 'codearts'),
  `注册表可见: ${schemas.map((s) => s.id).join(', ')}`);

// ---------------------------------------------------------------------------
section('2. WorkBuddy 逻辑分支（mock fetch）');
const realFetch = globalThis.fetch;
let reqBodies = {};   // 最近一次 mockFetch 各请求的 JSON body
function mockFetch(routes) {
  const calls = [];
  reqBodies = {};
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const key = `${opts.method || 'GET'} ${path}`;
    calls.push(key);
    try { reqBodies[key] = opts.body ? JSON.parse(opts.body) : null; } catch { reqBodies[key] = null; }
    const r = routes[key];
    if (!r) return { status: 404, headers: new Headers(), text: async () => '{"code":404,"msg":"no mock"}' };
    const body = typeof r.body === 'function' ? r.body() : r.body;
    return {
      status: r.status ?? 200,
      headers: new Headers(),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return calls;
}
const st = (o) => ({ status: 200, body: { code: 0, requestId: 'r', data: o } });
const WB_STATUS = 'POST /v2/billing/meter/checkin-activity-status';
const WB_CHECKIN = 'POST /v2/billing/meter/daily-checkin';
const WB_ENERGY = 'GET /activity/growth/energy';
const WB_STREAK = 'GET /activity/growth/streak';
const WB_BALANCE = 'POST /billing/meter/get-user-resource-summary';
const WB_USAGE = 'POST /billing/meter/get-user-request-usage';
const WB_FREE = 'POST /billing/meter/get-user-resource-free-packages';
const wbTask = (cfg = {}) => ({ id: 't-wb', providerId: 'workbuddy', config: { authMode: 'web', cookie: 'session=a; session_2=b', ...cfg } });
/** 余额端点响应（与真实抓包同形）：001 包剩余 remain + 002 包 0 */
const bal = (remain = 1722.11) => st({
  Packages: [
    { PackageCode: 'TCACA_code_007_x', CycleTotalCapacity: '6400', CycleRemainCapacity: String(remain), CycleUsedCapacity: '4677', CapacityUnit: 'credits' },
    { PackageCode: 'TCACA_code_008_y', CycleTotalCapacity: '500', CycleRemainCapacity: '0', CycleUsedCapacity: '500', CapacityUnit: 'credits' },
  ],
  IsPaidUser: false,
});

// A. 今日已签 → 不应发写请求；credits 取「账户可用余额」而非活动累计积分
let calls = mockFetch({ [WB_STATUS]: st({ today_checked_in: true, total_credits: 300 }), [WB_BALANCE]: bal() });
let r = await workbuddy.checkin(wbTask());
ok(r.ok && r.alreadyCheckedIn === true && Math.round(r.credits) === 1722,
  `A 已签: credits=${r.credits}（★账户可用余额，不是活动累计 300）`);
ok(r.activityCredits === 300, `A 已签: activityCredits=${r.activityCredits}（活动累计单独保留）`);
ok(!calls.includes(WB_CHECKIN), 'A 已签: 未调用 daily-checkin（省一次写请求）');

// B. 未签 → 签到成功：reward 取 daily-checkin，credits 取签到后的账户余额
let ns = 0, nb = 0;
calls = mockFetch({
  [WB_STATUS]: { body: () => ({ code: 0, data: { today_checked_in: false, total_credits: (++ns === 1 ? 200 : 300) } }) },
  [WB_CHECKIN]: st({ credit: 100, streak_days: 9, is_streak_day: false }),
  [WB_BALANCE]: { body: () => (++nb === 1 ? bal(1622.11).body : bal(1722.11).body) },
});
r = await workbuddy.checkin(wbTask());
ok(r.ok && r.alreadyCheckedIn === false && r.reward === 100 && Math.round(r.credits) === 1722,
  `B 首签: reward=${r.reward} credits=${r.credits}（签到后余额回查）`);
ok(r.activityCredits === 300, `B 首签: activityCredits=${r.activityCredits}`);

// C. 未签但上游回 10001（竞态/今日已签）
mockFetch({
  [WB_STATUS]: st({ today_checked_in: false, total_credits: 200 }),
  [WB_CHECKIN]: { status: 400, body: { code: 10001, msg: '今天已签到，请明天再来' } },
  [WB_BALANCE]: bal(),
});
r = await workbuddy.checkin(wbTask());
ok(r.ok && r.alreadyCheckedIn === true, `C 10001: 识别为已签到（非错误）`);

// D. 401 → invalid
mockFetch({ [WB_STATUS]: { status: 401, body: '<html>401</html>' } });
let kind = null;
try { await workbuddy.checkin(wbTask()); } catch (e) { kind = e.kind; }
ok(kind === 'invalid', `D 401: 归一化为 kind=${kind}`);

// E. 凭证缺失 → invalid 且提示明确
kind = null;
try { await workbuddy.checkin({ id: 'x', providerId: 'workbuddy', config: { authMode: 'bearer' } }); }
catch (e) { kind = e.kind; }
ok(kind === 'invalid', `E 缺凭证: kind=${kind}`);

// F. probeSession 解析到期时间（web=session 第二段；bearer=JWT exp）
const expUnix = 1789403935;
mockFetch({ [WB_STREAK]: st({ streak: { days: 8 } }) });
r = await workbuddy.probeSession(wbTask({ cookie: `session=abc|${expUnix}|hash; session_2=z` }));
ok(r.isLogin === true && r.expiresAt === expUnix * 1000, `F web 探活: expiresAt=${new Date(r.expiresAt).toISOString()}`);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'RS256' })}.${b64({ exp: 1794196886, iss: 'x' })}.sig`;
mockFetch({ [WB_STREAK]: st({ streak: { days: 8 } }) });
r = await workbuddy.probeSession({ id: 'x', providerId: 'workbuddy', config: { authMode: 'bearer', token: jwt } });
ok(r.isLogin === true && r.expiresAt === 1794196886 * 1000, `F bearer 探活: expiresAt=${new Date(r.expiresAt).toISOString()}`);

// F2. ★auto 模式：Cookie 自动换 Bearer（workbuddy5 抓包确认的换票链路）
const WB_STATE = 'POST /v2/plugin/auth/state';
const WB_EXCHANGE = 'POST /console/login/enterprise';
const jwtLong = `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 5184000 })}.sig`;
const exchangeOk = st({ accessToken: jwtLong, expiresIn: 5184000, refreshExpiresIn: 7776000, refreshToken: 'rt-x', tokenType: 'Bearer' });

// F2-a 无 token → 应换票并回写
const autoTask = { id: 't-auto', providerId: 'workbuddy', config: { authMode: 'auto', cookie: 'session=a; session_2=b' } };
calls = mockFetch({ [WB_STATUS]: st({ today_checked_in: true }), [WB_BALANCE]: bal(), [WB_STATE]: st({ state: 'st-1', authUrl: 'u' }), [WB_EXCHANGE]: exchangeOk });
r = await workbuddy.checkStatus(autoTask);
ok(calls.includes(WB_STATE) && calls.includes(WB_EXCHANGE), 'F2-a auto 无 token: 触发了 state + 换票两个端点');
ok(autoTask.config.token === jwtLong, 'F2-a auto: accessToken 已回写到 config.token');
ok(Math.round((autoTask.tokenExpiredAt - Date.now()) / 86400000) === 60,
  `F2-a auto: tokenExpiredAt ≈ 60 天后（${new Date(autoTask.tokenExpiredAt).toISOString().slice(0, 10)}）`);
ok(r.ok === true, 'F2-a auto: 换票后业务请求成功');

// F2-b 已有未过期 token → 复用，不再换票（★换票有速率限制，必须尽量少换）
calls = mockFetch({ [WB_STATUS]: st({ today_checked_in: true }), [WB_BALANCE]: bal(), [WB_STATE]: st({ state: 'st-2' }), [WB_EXCHANGE]: exchangeOk });
await workbuddy.checkStatus(autoTask);
ok(!calls.includes(WB_EXCHANGE), 'F2-b auto 有缓存 token: 未再次换票（复用生效）');

// F2-c 换票被拒（401，常见于 UA 不一致 / 换票过频）→ 回落 Cookie 直连，签到不中断
const autoTask2 = { id: 't-auto2', providerId: 'workbuddy', config: { authMode: 'auto', cookie: 'session=a; session_2=b' } };
calls = mockFetch({
  [WB_STATUS]: st({ today_checked_in: true }), [WB_BALANCE]: bal(),
  [WB_STATE]: st({ state: 'st-3' }), [WB_EXCHANGE]: { status: 401, body: '<html>401</html>' },
});
r = await workbuddy.checkStatus(autoTask2);
ok(r.ok === true, 'F2-c 换票 401: 回落 Cookie 直连后仍成功（auto 的兜底生效）');
ok(!autoTask2.config.token, 'F2-c 换票 401: 未写入无效 token');
calls = mockFetch({ [WB_STATUS]: st({ today_checked_in: true }), [WB_BALANCE]: bal(), [WB_STATE]: st({ state: 'st-4' }), [WB_EXCHANGE]: exchangeOk });
await workbuddy.checkStatus(autoTask2);
ok(!calls.includes(WB_EXCHANGE), 'F2-c 换票 401 后的冷却期: 同一轮内不再重复撞限流');

// F2-d auto 只填 token（无 cookie）→ 直接按 bearer 用，不换票
const autoTask3 = { id: 't-auto3', providerId: 'workbuddy', config: { authMode: 'auto', token: jwtLong } };
calls = mockFetch({ [WB_STATUS]: st({ today_checked_in: true }), [WB_BALANCE]: bal(), [WB_STATE]: st({ state: 'st-5' }), [WB_EXCHANGE]: exchangeOk });
r = await workbuddy.checkStatus(autoTask3);
ok(r.ok === true && !calls.includes(WB_EXCHANGE), 'F2-d auto 仅 token: 直接用 bearer，不换票');

// G. getTotalCredits：余额为主值 + 活动信息 + 签到记录折算 + 权益包汇总
mockFetch({
  [WB_BALANCE]: bal(),
  [WB_STATUS]: st({
    today_checked_in: true, total_credits: 300, streak_days: 9, daily_credit: 100,
    checkin_dates: ['2026-09-10', '2026-09-09'],
  }),
  [WB_ENERGY]: { status: 500, body: { code: 500 } },
});
r = await workbuddy.getTotalCredits(wbTask());
ok(r.ok && Math.round(r.total) === 1722 && r.packs.energy === null,
  `G 总积分: total=${r.total} energy=${r.packs.energy}（附加失败降级为 null）`);
ok(r.checkins.length === 2 && r.checkins[0].credits === 100,
  `G 签到记录折算: ${JSON.stringify(r.checkins[0])}（checkin_dates + daily_credit → {date,credits}）`);
ok(Array.isArray(r.packs.list) && r.packs.list.length === 2,
  `G 权益包汇总: ${r.packs.list.map((x) => x.code + '=' + x.remain).join(', ')}`);

// H. getUsage：参数翻译（epoch → 「YYYY-MM-DD HH:mm:ss」+ pageNum）+ 出参映射为 Trae 会话形状
calls = mockFetch({
  [WB_USAGE]: st({
    total: 2,
    data: [
      { requestId: 'r1', credit: 3.97, model: 'deepseek-v4.1-flash', client: 'WorkBuddy', requestTime: '2026-09-10 14:32:00', inputTrunc: 'hi', agentPurpose: 'conversation' },
      { requestId: 'r2', credit: 15.33, model: 'hy3', client: 'WorkBuddy', requestTime: '2026-09-09 01:00:00', inputTrunc: 'yo', agentPurpose: 'conversation' },
    ],
  }),
});
const startSec = Math.floor(Date.parse('2026-09-03T00:00:00+08:00') / 1000);
const endSec = Math.floor(Date.parse('2026-09-10T23:59:59+08:00') / 1000);
const uo = await workbuddy.getUsage(wbTask(), { start_time: startSec, end_time: endSec, page_size: 50, page_num: 1 });
const sent = reqBodies[WB_USAGE] || {};
ok(sent.startTime === '2026-09-03 00:00:00' && sent.endTime === '2026-09-10 23:59:59',
  `H 用量入参: startTime=${sent.startTime} endTime=${sent.endTime}（★必须字符串日期，不是 epoch）`);
ok(sent.pageNum === 1 && sent.pageNumber === undefined,
  `H 用量入参: pageNum=${sent.pageNum}（★键名是 pageNum，不是 pageNumber）`);
ok(uo.total === 2 && uo.user_usage_group_by_sessions.length === 2, `H 用量出参: total=${uo.total}`);
ok(uo.user_usage_group_by_sessions[0].model_name === 'deepseek-v4.1-flash'
  && uo.user_usage_group_by_sessions[0].usage_time === Math.floor(Date.parse('2026-09-10T14:32:00+08:00') / 1000),
  `H 会话映射: model=${uo.user_usage_group_by_sessions[0].model_name} usage_time=${uo.user_usage_group_by_sessions[0].usage_time}`);
ok(uo.user_usage_group_by_sessions[0].extra_info.input_token === 0,
  'H 会话映射: token 恒为 0（★上游不提供 token 明细，不臆造）');

// I. getPackages：PackageCodes 必填（不传 → 静默空列表）
calls = mockFetch({
  [WB_BALANCE]: bal(),
  [WB_FREE]: st({
    Accounts: [{
      PackageCode: 'TCACA_code_007_x', PackageName: 'CodeBuddy个人版国内运营裂变包',
      CycleCapacityRemainPrecise: '22.11', CycleCapacitySizePrecise: '300',
      CycleStartTime: '2026-09-08 22:24:32', CycleEndTime: '2026-10-08 22:24:31',
    }],
  }),
});
r = await workbuddy.getPackages(wbTask());
ok(Math.round(r.total) === 1722 && r.list.length === 1 && r.list[0].packageName.includes('裂变包'),
  `I 权益包明细: total=${r.total} list=${r.list.length} name=${r.list[0] && r.list[0].packageName}`);
ok(Array.isArray((reqBodies[WB_FREE] || {}).PackageCodes) && reqBodies[WB_FREE].PackageCodes.includes('TCACA_code_007_x'),
  `I 权益包入参: PackageCodes=${JSON.stringify((reqBodies[WB_FREE] || {}).PackageCodes)}（★必填，缺失则静默空表）`);
globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
section('3. 真实只读探活（有凭证才跑，失败不判错）');

// WorkBuddy：优先用本地保存的凭证（_wb_cookie.txt），其次回退 workbuddy3 抓包
// ★注意 userAgent 必须显式给（APISIX 会校验 UA，用默认以外的旧 UA 会 401）
try {
  const WB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';
  let cookie = '';
  let src = '';
  try { cookie = readFileSync(new URL('./_wb_cookie.txt', import.meta.url), 'utf8').trim(); src = '_wb_cookie.txt'; } catch { /* 回退抓包 */ }
  if (!cookie) {
    const dir = '../examples/workbuddy3_解析结果/090_GET https___www.workbuddy.cn_console_account/请求.txt';
    const raw = readFileSync(new URL(dir, import.meta.url), 'utf8');
    const m = /(?:^|\n)\s*cookie:\s*([^\n]+)/i.exec(raw);
    const jar = {};
    for (const kv of (m ? m[1] : '').split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    cookie = `session=${jar.session || ''}; session_2=${jar.session_2 || ''}`;
    src = 'workbuddy3 抓包';
  }
  const task = { id: 'real-wb', providerId: 'workbuddy', config: { authMode: 'web', cookie, userAgent: WB_UA } };
  const sr = await workbuddy.checkStatus(task);
  console.log(`  · WorkBuddy 真实会话（${src}）: 今日已签=${sr.checked_in} 账户可用余额=${sr.credits}`);
  const pr = await workbuddy.probeSession(task);
  console.log(`  · WorkBuddy 探活: isLogin=${pr.isLogin} expiresAt=${pr.expiresAt ? new Date(pr.expiresAt).toISOString() : null}`);
  const tr = await workbuddy.getTotalCredits(task);
  console.log(`  · WorkBuddy 余额: total=${tr.total} 配额=${tr.packs.capacity} 活动累计=${tr.activityCredits} 签到天数=${tr.packs.streakDays}`);
  const nowSec = Math.floor(Date.now() / 1000);
  const ur = await workbuddy.getUsage(task, { start_time: nowSec - 7 * 86400, end_time: nowSec, page_size: 200, page_num: 1 });
  console.log(`  · WorkBuddy 近7天用量: 远端 total=${ur.total} 条，本页积分合计=${ur.user_usage_group_by_sessions.reduce((a, x) => a + x.credits_float, 0).toFixed(2)}`);
  const pk = await workbuddy.getPackages(task);
  console.log(`  · WorkBuddy 权益包: 可用=${pk.total} 免费包=${pk.free} 付费包=${pk.paid}（与 summary 对账：${Math.round(pk.summary.reduce((a, x) => a + x.remain, 0))}）`);
  const his = await workbuddy.getCheckinHistory(task, { days: 30 });
  console.log(`  · WorkBuddy 远端签到历史（checkin_dates）: ${his.length} 天 → ${his.map((x) => x.date + '(' + x.credits + ')').join(', ') || '—'}`);
} catch (e) {
  console.log(`  · WorkBuddy 真实会话不可用（跳过）: ${e.message}`);
}

// CodeArts：读 examples/.codearts_session.json
try {
  const raw = readFileSync(new URL('../examples/.codearts_session.json', import.meta.url), 'utf8');
  const s = JSON.parse(raw);
  const task = {
    id: 'real-ca', providerId: 'codearts',
    config: { hwidCasSid: s.hwid_cas_sid, localStorageId: s.localStorageID, cookies: s.cookies, fpSeed: s.fpSeed, account: s.account, password: s.password },
  };
  const pr = await codearts.probeSession(task);
  console.log(`  · CodeArts 探活: isLogin=${pr.isLogin}（cookies=${Object.keys(task.config.cookies || {}).length} 项）`);
  if (pr.isLogin) {
    const sr = await codearts.checkStatus(task);
    const cr = await codearts.getTotalCredits(task);
    console.log(`  · CodeArts 签到状态: 今日已签=${sr.checked_in} 积分=${sr.credits}（getTotalCredits=${cr.total}）`);
    const endSec = Math.floor(Date.now() / 1000);
    const du = await codearts.getDailyUsage(task, { startSec: endSec - 30 * 86400, endSec });
    const dayKeys = Object.keys(du.days);
    console.log(`  · CodeArts 近30天逐日用量（远端）: 有消耗天数=${dayKeys.length} ${dayKeys.map((d) => d + '=' + du.days[d].total.toFixed(2)).join(' ')}`);
    console.log(`  · CodeArts 模型区间累计: ${du.modelTotals.map((m) => m.model + '=' + m.credits.toFixed(2)).join(', ') || '—'}${du.note ? ' | note: ' + du.note : ''}`);
    // ★区间汇总（analytics/usage/personal/stats）：请求数 / 活跃天 / token 日均 / 缓存命中
    if (du.summary) {
      const s = du.summary;
      console.log(`  · CodeArts 区间汇总: ${s.range.start}~${s.range.end} token=${s.tokens} 日均=${s.tokensDailyAvg} 请求=${s.requests} 活跃=${s.activeDays} 天 缓存命中=${s.cacheHitTokens} 积分=${s.credits}`);
      console.log(`    token 逐日非零天数=${dayKeys.filter((d) => (du.days[d].tokens || 0) > 0).length}（★token 原始数据来源=charts TOKEN_TOTAL）`);
    } else {
      console.log('  · CodeArts 区间汇总: 无（stats 端点未返回）');
    }
    const pk = await codearts.getPackages(task);
    console.log(`  · CodeArts 权益包: 可用=${pk.total} 配额=${pk.capacity} 规格=${pk.specCode} perPackage=${pk.perPackage}（${pk.list.map((x) => x.packageName + ':' + x.remain).join(' / ')}）`);
    const his = await codearts.getCheckinHistory(task, { days: 30 });
    console.log(`  · CodeArts 远端签到历史（每日签到赠送包 createdTime）: ${his.length} 天 → ${his.map((x) => x.date).join(', ') || '—'}`);
  }
} catch (e) {
  console.log(`  · CodeArts 真实会话不可用（跳过）: ${e.message}`);
}

console.log(`\n自检结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
