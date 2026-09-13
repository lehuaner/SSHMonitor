/**
 * E2E 短信验证码登录实测（真实网络请求，两阶段）
 *
 * Phase 1:  node _e2e_sms_codearts.mjs request
 *   → 真实向华为发 getSMSCodeV3 → 手机收短信 → 保存 client 状态到 _e2e_state.json
 *
 * Phase 2:  node _e2e_sms_codearts.mjs submit <code>
 *   → 从 _e2e_state.json 恢复 client → opType=1 提交 → OAuth 落地
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CodeArtsClient } from './lib/checkin/codearts.js';

const STATE_FILE = fileURLToPath(new URL('./_e2e_state.json', import.meta.url));

// ── 凭据（从远端 checkin_tasks.json 提取） ──
const CRED = {
  account: '19154975875',
  password: '2003726asd',
  // ★ 不带 hwidCasSid → 触发短信验证分支
  hwidCasSid: '',
  localStorageId: 'w913GM77ibQjHiaZShA7nhgbhTbeCDk3So8z0qHyibrbTsxd',
  fpSeed: 'codearts-checkin',
};

function saveClient(client) {
  const state = {
    account: client.account,
    password: client.password,
    hwidCasSid: client.hwidCasSid,
    localStorageId: client.localStorageId,
    fpSeed: client.fpSeed,
    base: client.base,
    authDevices: client.authDevices,
    _lastAccountInfo: client._lastAccountInfo,
    cookies: client.http.cookies(),
    fp: client.fp,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[save] client 状态已写入 ${STATE_FILE}`);
}

function restoreClient() {
  if (!existsSync(STATE_FILE)) throw new Error(`状态文件 ${STATE_FILE} 不存在，请先运行 request 阶段`);
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  const c = new CodeArtsClient({
    account: s.account, password: s.password,
    hwidCasSid: s.hwidCasSid, localStorageId: s.localStorageId,
    fpSeed: s.fpSeed, cookies: s.cookies, verbose: true,
  });
  c.base = s.base;
  c.authDevices = s.authDevices;
  c._lastAccountInfo = s._lastAccountInfo;
  c.fp = s.fp;
  console.log(`[restore] client 状态已从 ${STATE_FILE} 恢复`);
  return c;
}

const phase = process.argv[2];

if (phase === 'request') {
  // ═══════════════════════════════════════════════════
  // Phase 1: 触发登录链 + 发短信
  // ═══════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════');
  console.log('  Phase 1: requestVerifyCode · 19154975875');
  console.log('═══════════════════════════════════════════════════\n');

  const client = new CodeArtsClient({ ...CRED, verbose: true });

  console.log('[1] client.login() …\n');
  const r = await client.login();

  if (r.ok && !r.needVerify) {
    console.log('\n✅ 设备已受信，无需验证码 —— E2E 不需要跑。');
    process.exit(0);
  }
  if (!r.ok && !r.needVerify) {
    console.log('\n❌ login 失败:', r.error || '未知错误');
    if (r.riskCaptcha) console.log('   （图形验证码风控门 —— fail-first）');
    process.exit(1);
  }

  // needVerify = true
  console.log('\n[2] login 返回 needVerify, authDevices:', JSON.stringify(r.authDevices));

  // 如果 sent=0，需要显式发短信
  if (!r.authDevices.some((d) => d.sent === 1)) {
    console.log('\n[3] sent=0 → 调用 client.requestVerifyCode() 发短信 …\n');
    const vr = await client.requestVerifyCode();
    if (!vr.ok) {
      console.log('\n❌ requestVerifyCode 失败:', vr.error || JSON.stringify(vr));
      process.exit(1);
    }
    console.log('\n[3] requestVerifyCode ok, authDevices:', JSON.stringify(client.authDevices));
  }

  // 保存状态
  saveClient(client);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  ✅ 短信已发送！请查看手机，然后运行：');
  console.log('  node _e2e_sms_codearts.mjs submit <6位验证码>');
  console.log('═══════════════════════════════════════════════════');
  process.exit(0);

} else if (phase === 'submit') {
  // ═══════════════════════════════════════════════════
  // Phase 2: 提交验证码
  // ═══════════════════════════════════════════════════
  const code = process.argv[3];
  if (!code || !/^\d{4,8}$/.test(code)) {
    console.log('用法: node _e2e_sms_codearts.mjs submit <6位验证码>');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════');
  console.log(`  Phase 2: submitVerifyCode(code=${code}) · 19154975875`);
  console.log('═══════════════════════════════════════════════════\n');

  const client = restoreClient();
  console.log('\n[1] client.submitVerifyCode(' + code + ') …\n');
  const r = await client.submitVerifyCode(code);

  console.log('\n[1] 结果:', JSON.stringify(r, null, 2).slice(0, 2000));

  if (r.ok) {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  ✅ E2E 短信验证码登录成功！');
    console.log('  hwidCasSid:', client.hwidCasSid?.slice(0, 20) + '…');
    console.log('  localStorageId:', client.localStorageId?.slice(0, 20) + '…');
    console.log('  cookies:', Object.keys(client.http.cookies()).join(', '));
    console.log('═══════════════════════════════════════════════════');
    // 清理状态文件
    try { unlinkSync(STATE_FILE); } catch {}
    process.exit(0);
  } else {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  ❌ E2E 失败:', r.error || '未知错误');
    if (r.landingFailed) console.log('  （验证码已通过，但 OAuth 落地失败）');
    console.log('═══════════════════════════════════════════════════');
    process.exit(1);
  }

} else {
  console.log('用法:');
  console.log('  node _e2e_sms_codearts.mjs request   # 发短信');
  console.log('  node _e2e_sms_codearts.mjs submit <code>  # 提交验证码');
  process.exit(1);
}
