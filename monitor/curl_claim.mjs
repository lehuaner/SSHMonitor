/**
 * 临时脚本 —— 用真实的 curl 命令对指定账号签到。
 * 方式：先用该账号 Cookie 换出新鲜 JWT（复用生产 CheckinClient.getUserToken），
 *       再拼出与「通过抓包(样本381)」完全一致的请求头，交给系统 curl 发送 claim。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CheckinClient, deriveDevice } from './lib/checkin/checkin.js';

const TASK_ID = '476a3ecc-19f0-4c19-9185-f300ed8fd147'; // 19154975875
const t = JSON.parse(
  readFileSync('/data/data/com.termux/files/home/.monitor_data/checkin_tasks.json', 'utf8'),
).find((x) => x.id === TASK_ID);
if (!t) {
  console.log('NO_TASK', TASK_ID);
  process.exit(0);
}

const dev = deriveDevice(t.id + '|trae');
const c = new CheckinClient({ baseUrl: t.config.baseUrl, token: '', cookie: t.config.cookie || '', device: dev });
const r = await c.getUserToken();
console.log('[19154975875] fresh token UserID=' + r.UserID);

const headers = {
  'authorization': 'Cloud-IDE-JWT ' + r.Token,
  'content-type': 'application/json',
  'accept': '*/*',
  'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
  'vscode-sessionid': dev.vscodeSessionId,
  'x-market-client-id': 'VSCode 1.107.1',
  'x-market-user-id': dev.marketUserId,
  'x-user-region': 'CN',
  'x-device-brand': '82JW',
  'x-device-id': dev.deviceId,
  'x-device-type': 'windows',
  'x-lgw-req-sdk-type': '3',
  'package-type': 'stable_cn',
  'x-lscbd-aid': '787976',
  'x-lscbd-platform': 'windows',
  'app-version': '0.1.50',
};

const args = ['-s', '-S', '-X', 'POST', t.config.baseUrl + '/trae/api/v2/ug/checkin_credits/claim'];
for (const [k, v] of Object.entries(headers)) args.push('-H', k + ': ' + v);
args.push('--data', '{}');

console.log('[19154975875] running curl claim ...');
try {
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  console.log('CURL_STDOUT: ' + out);
} catch (err) {
  console.log('CURL_STDOUT: ' + (err.stdout || ''));
  console.log('CURL_STDERR: ' + (err.stderr || ''));
  console.log('CURL_STATUS: ' + (err.status ?? 'spawn-fail'));
}