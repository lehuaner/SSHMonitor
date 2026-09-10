/**
 * 用「真实设备标识」对指定账号试签到，验证根因是否为捏造设备标识触发上游风控。
 * 设备标识来自你真实签到成功抓包(020)的真实值：vscode-sessionid / x-market-user-id / x-device-id。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CheckinClient } from './lib/checkin/checkin.js';

const TASK_ID = process.argv[2] || '3363a609-e938-4463-a036-a56780d7b177'; // 17327137416
const USE_REAL_DEVICE = process.argv[3] !== '0';

// 真实成功抓包里使用的固定设备标识（两处抓包同一个值）
const REAL_DEVICE = {
  vscodeSessionId: '0ec2815d877a858e8e735d7c63cfd406d5f7456e417eecf3a3003f0983560b51',
  marketUserId: '27d676f6-393e-4bc7-833c-2dc7a0da0dc2',
  deviceId: '3798161405005257',
};

const t = JSON.parse(
  readFileSync('/data/data/com.termux/files/home/.monitor_data/checkin_tasks.json', 'utf8'),
).find((x) => x.id === TASK_ID);
if (!t) {
  console.log('NO_TASK', TASK_ID);
  process.exit(0);
}

const device = USE_REAL_DEVICE ? REAL_DEVICE : { vscodeSessionId: '', marketUserId: '', deviceId: '' };
const c = new CheckinClient({ baseUrl: t.config.baseUrl, token: '', cookie: t.config.cookie || '', device });
const r = await c.getUserToken();
c.token = r.Token;
console.log('[' + t.name + '] token UserID=' + r.UserID + ' deviceMode=' + (USE_REAL_DEVICE ? 'REAL' : 'fake'));

const headers = {
  'authorization': 'Cloud-IDE-JWT ' + r.Token,
  'content-type': 'application/json',
  'accept': '*/*',
  'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
  'vscode-sessionid': device.vscodeSessionId,
  'x-market-client-id': 'VSCode 1.107.1',
  'x-market-user-id': device.marketUserId,
  'x-user-region': 'CN',
  'x-device-brand': '82JW',
  'x-device-id': device.deviceId,
  'x-device-type': 'windows',
  'x-lgw-req-sdk-type': '3',
  'package-type': 'stable_cn',
  'x-lscbd-aid': '787976',
  'x-lscbd-platform': 'windows',
  'app-version': '0.1.51',
};

const args = ['-s', '-S', '-X', 'POST', t.config.baseUrl + '/trae/api/v2/ug/checkin_credits/claim'];
for (const [k, v] of Object.entries(headers)) args.push('-H', k + ': ' + v);
args.push('--data', '{}');

console.log('[' + t.name + '] running curl claim ...');
try {
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  console.log('CURL_STDOUT: ' + out);
} catch (err) {
  console.log('CURL_STDOUT: ' + (err.stdout || ''));
  console.log('CURL_STATUS: ' + (err.status ?? 'spawn-fail'));
}