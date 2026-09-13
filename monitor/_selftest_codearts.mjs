/**
 * 临时自检：用抓包里的真实 fp 逐字节校验 JS 指纹算法（与 Python 版同源）。
 * 运行：node _selftest_codearts.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFp, decodeFp, serializePairs, sha1Hex, xorEncrypt, xorDecrypt,
  parseAuthCodeSentList, isRiskCaptcha, VERIFY_TYPE_PHONE, CodeArtsClient,
} from './lib/checkin/codearts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = path.join(__dirname, '..', 'examples', 'codearts2_解析结果');
let ok = true;

// --- 1) XOR 往返（含 1-255 全字节集）---
for (const probe of ['hello world', 'a'.repeat(300), 'bsh=856&bsw=1496&cs=deadbeef']) {
  const rt = xorDecrypt(xorEncrypt(probe));
  if (rt !== probe) { console.log('✗ XOR 往返失败:', probe.slice(0, 20)); ok = false; }
}
if (ok) console.log('✓ XOR 加解密往返一致');

// --- 2) 自生成 fp 的 cs 校验 ---
const fp = buildFp('selftest-seed', 1789015082237);
const body = decodeFp(fp);
const idx = body.lastIndexOf('&cs=');
const pre = body.slice(0, idx), cs = body.slice(idx + 4);
if (sha1Hex(pre) !== cs) { console.log('✗ 自生成 fp 的 cs 校验失败'); ok = false; }
else console.log(`✓ 自生成 fp：长度 ${fp.length}，cs=SHA1 校验通过`);

// --- 3) 抓包真实 fp 逐字节重建 ---
const dirs = fs.existsSync(CAPTURE)
  ? fs.readdirSync(CAPTURE).filter((d) => d.startsWith('073_')) : [];
if (!dirs.length) {
  console.log('⚠ 未找到抓包目录，跳过真实 fp 对拍');
} else {
  const raw = fs.readFileSync(path.join(CAPTURE, dirs[0], '请求体.txt'), 'utf8');
  const flat = raw.replace(/\r?\n/g, '&');
  const realFp = new URLSearchParams(flat).get('fp') || '';
  const realBody = decodeFp(realFp);
  const i2 = realBody.lastIndexOf('&cs=');
  const rpre = realBody.slice(0, i2), rcs = realBody.slice(i2 + 4);

  if (!realFp) { console.log('✗ 抓包 fp 读取失败'); ok = false; }
  else if (sha1Hex(rpre) !== rcs) { console.log('✗ 抓包 fp 反解后 cs 不匹配'); ok = false; }
  else {
    console.log(`✓ 抓包 fp 反解成功：长度 ${realFp.length}，cs=SHA1 通过`);
    // 抓包里的值本身已是 encodeURIComponent 结果 → 只按 key 排序后原样重拼
    // （★ 不要再次编码，否则会双重编码）
    const rawPairs = rpre.split('&').filter((kv) => kv.includes('='))
      .map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; });
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    rawPairs.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]));
    const serialized = rawPairs.map(([k, v]) => `${k}=${v}`).join('&');
    const rebuilt = Buffer.from(xorEncrypt(`${serialized}&cs=${sha1Hex(serialized)}`)).toString('base64');
    if (rebuilt === realFp) console.log('✓ 逐字节重建一致（算法 + 字段顺序全对）');
    else { console.log('✗ 重建结果与抓包不一致'); ok = false; }

    // 编码风格等价：把值 unquote 还原后交给 serializePairs()，应完全等价
    const decoded = {};
    for (const [k, v] of rawPairs) decoded[k] = decodeURIComponent(v);
    if (serializePairs(decoded) === serialized) {
      console.log('✓ serializePairs() 编码风格与浏览器 encodeURIComponent 一致');
    } else {
      console.log('✗ serializePairs() 编码风格与抓包不一致');
      console.log('  抓包:', serialized.slice(0, 140));
      console.log('  本实现:', serializePairs(decoded).slice(0, 140));
      ok = false;
    }
  }
}

// --- 4) authCodeSentList 解析（str / dict 两种形态）---
const desc = '{"authCodeSentList":[{"accountType":-1,"name":"Honor 10","sent":1,"type":"device"}],"riskFlag":"x"}';
const a = parseAuthCodeSentList(desc);
const b = parseAuthCodeSentList(JSON.parse(desc));
if (a.length === 1 && b.length === 1 && a[0].name === 'Honor 10') console.log('✓ authCodeSentList 解析（str/dict）通过');
else { console.log('✗ authCodeSentList 解析失败'); ok = false; }
if (parseAuthCodeSentList(null).length !== 0) { console.log('✗ 空输入应返回 []'); ok = false; }

// --- 5) 图片验证码风控门判定（fail-first 规则：触发即判失败，禁止重试）---
const r1 = { isSuccess: 0, errorCode: '10000706', errorDesc: 'need picture authcode risk' };
const r2 = { isSuccess: 0, errorCode: 'other', errorDesc: '{"extErrorDesc":"xxx need picture authcode risk"}' };
const r3 = { isSuccess: 0, errorCode: '10002080', errorDesc: '{"authCodeSentList":[{"accountType":-1,"sent":1}]}' };
const r4 = { isSuccess: 0, localInfo: { errorDesc: 'Need Picture AuthCode Risk' } };
if (isRiskCaptcha(r1) && isRiskCaptcha(r2) && isRiskCaptcha(r4)
  && !isRiskCaptcha(r3) && !isRiskCaptcha(null)) {
  console.log('✓ isRiskCaptcha 判定（错误码 / 文案 / localInfo 三通道 + 负例）通过');
} else { console.log('✗ isRiskCaptcha 判定失败'); ok = false; }

// --- 6) 手机号-only 分支解析（2026-09-12 抓包：sent=0，不会自动发码）---
const phoneDesc = '{"authCodeSentList":[{"accountType":2,"name":"191******75","sent":0,"type":"sms"}],'
  + '"riskFlag":"001000000011100000000010000"}';
const p1 = parseAuthCodeSentList(phoneDesc);
if (p1.length === 1 && Number(p1[0].accountType) === VERIFY_TYPE_PHONE && p1[0].sent === 0) {
  console.log('✓ 手机号-only 分支解析（accountType=2 / sent=0）通过');
} else { console.log('✗ 手机号-only 分支解析失败'); ok = false; }

// --- 7) getSMSCodeV3 请求体与抓包逐字段对齐 + _ensureSmsSent 幂等 ---
try {
  const c = new CodeArtsClient({
    account: '19154975875', hwidCasSid: 'a'.repeat(84), localStorageId: 'LS-TEST',
  });
  c.base = {
    pageToken: 'PT', pageTokenKey: 'PTK', reqClientType: '88', loginChannel: '88000000',
    clientID: '103493351', lang: 'zh-cn', languageCode: 'zh-cn', state: 'ST',
  };
  const calls = [];
  c.http.postJson = async (url, data) => { calls.push({ url, data }); return { isSuccess: 1 }; };
  c.authDevices = [{ accountType: 2, name: '191******75', sent: 0, type: 'sms' }];

  const s1 = await c._ensureSmsSent();          // 首次：真正发短信
  const d1 = calls[0] || {};
  const expect = {
    userAccount: '008619154975875',             // normalizeAccount 后（与登录链一致）
    accountType: '2',
    mobilePhone: '191******75',                 // 打码值原样回传
    operType: '8',
    smsReqType: '6',
    localStorageID: 'LS-TEST',
    hwid_cas_sid: 'a'.repeat(84),
  };
  const fieldsOk = !!d1.data
    && Object.entries(expect).every(([k, v]) => String(d1.data[k]) === v)
    && d1.data.pageToken === 'PT'
    && String(d1.url).includes('login/getSMSCodeV3');
  const s2 = await c._ensureSmsSent();          // 第二次：应 skipped，不再发请求

  if (s1.ok && !s1.skipped && fieldsOk
    && c.authDevices[0].sent === 1 && s2.ok && s2.skipped && calls.length === 1) {
    console.log('✓ getSMSCodeV3 请求体逐字段对齐抓包 + _ensureSmsSent 幂等 通过');
  } else {
    console.log('✗ getSMSCodeV3 / _ensureSmsSent 校验失败');
    console.log('  s1:', JSON.stringify(s1), 'fieldsOk:', fieldsOk, 'calls:', calls.length);
    ok = false;
  }
} catch (e) {
  console.log('✗ getSMSCodeV3 自检异常:', e.message); ok = false;
}

// --- 8) unionLoginByPwd 提交步骤（opType=1）请求体对齐抓包第 110 条 + localStorageID 更新 ---
try {
  const c2 = new CodeArtsClient({
    account: '19154975875', password: 'testpw', hwidCasSid: 'a'.repeat(84), localStorageId: 'LS-OLD',
  });
  c2.base = {
    pageToken: 'PT', pageTokenKey: 'PTK', reqClientType: '88', loginChannel: '88000000',
    clientID: '103493351', lang: 'zh-cn', languageCode: 'zh-cn', state: 'ST',
  };
  const calls2 = [];
  c2.http.postJson = async (url, data) => {
    calls2.push({ url, data });
    // 模拟抓包第 110 条响应：isSuccess=1 + 新 localStorageID + needPopTrust
    return { isSuccess: 1, localStorageID: 'LS-NEW', needPopTrust: true,
             callbackURL: 'https://example.com/callback?ticket=ST-123' };
  };
  const acctInfo = { anonymousAccount: 'l****an', serial: 1 };
  const res = await c2._stepUnionLogin(acctInfo, 'hwmeta-str', {
    twoStepVerifyCode: '337245',
    verifyAccountType: 2,
    verifyUserAccount: '191******75',
  });
  const d = calls2[0] || {};
  const expectSubmit = {
    userAccount: '008619154975875',
    opType: '1',
    verifyAccountType: '2',
    verifyUserAccount: '191******75',
    twoStepVerifyCode: '337245',
    anonymousLoginID: 'l****an',
    localStorageID: 'LS-OLD',             // 请求时仍用旧值
    hwid_cas_sid: 'a'.repeat(84),
  };
  const submitOk = !!d.data
    && Object.entries(expectSubmit).every(([k, v]) => String(d.data[k]) === v)
    && String(d.url).includes('login/unionLoginByPwd');
  const lsUpdated = c2.localStorageId === 'LS-NEW';   // 响应后应更新为新值
  if (submitOk && lsUpdated && res.isSuccess === 1) {
    console.log('✓ unionLoginByPwd 提交步骤（opType=1）请求体对齐 + localStorageID 更新 通过');
  } else {
    console.log('✗ unionLoginByPwd 提交步骤校验失败');
    console.log('  submitOk:', submitOk, 'lsUpdated:', lsUpdated, 'ls:', c2.localStorageId);
    ok = false;
  }
} catch (e) {
  console.log('✗ unionLoginByPwd 提交步骤自检异常:', e.message); ok = false;
}

console.log(ok ? '\n自检结果：全部通过' : '\n自检结果：存在失败项');
process.exit(ok ? 0 : 1);
