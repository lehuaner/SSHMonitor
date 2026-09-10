// 用 Cloudflare Pages API 直接部署文件
// 确保 _worker.js 被正确识别为 Worker
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

const TOKEN = 'cfut_22Wpsd918WZHE3fpgBDcpPHUjm7rb1RFMVF8uep5870f091b';
const ACCOUNT_ID = '2374927b5eab88cecbdcdb3c837b6aa2';
const PROJECT = 'honor10-monitor';
const FRONTEND_DIR = 'd:/Code/Project/SSH/Honor 10/monitor/frontend';

const api = (path, opts = {}) => fetch(`https://api.cloudflare.com/client/v4${path}`, {
  ...opts,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...opts.headers,
  },
});

// 1. 读取所有文件
console.log('=== 1. 读取文件 ===');
const files = [];
function readDir(dir, prefix = '') {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;  // 跳过隐藏文件/目录
    const full = join(dir, name);
    const rel = prefix + name;
    const st = statSync(full);
    if (st.isDirectory()) {
      readDir(full, rel + '/');
    } else {
      files.push({ path: '/' + rel, full, size: st.size });
    }
  }
}
readDir(FRONTEND_DIR);
console.log(`找到 ${files.length} 个文件:`);
files.forEach(f => console.log(`  ${f.path} (${f.size} bytes)`));

// 2. 计算每个文件的 hash
console.log('\n=== 2. 计算文件 hash ===');
const fileHashes = {};
const manifest = {};
for (const f of files) {
  const content = readFileSync(f.full);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const b64 = Buffer.from(hash, 'hex').toString('base64');
  fileHashes[f.path] = b64;
  manifest[f.path] = hash;
  f.hash = hash;
  f.b64 = b64;
}
console.log('Manifest:', Object.keys(manifest).length, '个文件');

// 3. 获取上传 token
console.log('\n=== 3. 获取上传 token ===');
const tr = await api(`/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}/upload-token`, { method: 'POST' });
console.log('Status:', tr.status);
const ttext = await tr.text();
console.log('Response:', ttext.substring(0, 500));
let td;
try { td = JSON.parse(ttext); } catch(e) { console.log('Parse error:', e.message); process.exit(1); }
if (!td.success) {
  console.log('Errors:', JSON.stringify(td.errors, null, 2));
  process.exit(1);
}
const uploadToken = td.result.jwt;

// 4. 检查哪些文件需要上传
console.log('\n=== 4. 检查需要上传的文件 ===');
const hashes = Object.values(fileHashes);
const cr = await api(`/pages/assets/check-missing`, {
  method: 'POST',
  headers: { 'X-Cloudflare-Workers-Upload-Token': uploadToken },
  body: JSON.stringify({ hashes }),
});
const cd = await cr.json();
console.log('Check missing:', cr.status, cd.success);
const missingHashes = cd.success ? cd.result : [];
console.log(`需要上传: ${missingHashes.length} 个文件`);

// 5. 上传缺失的文件
if (missingHashes.length > 0) {
  console.log('\n=== 5. 上传文件 ===');
  // 构建 payload
  const payload = {};
  for (const f of files) {
    if (missingHashes.includes(f.b64)) {
      const content = readFileSync(f.full);
      payload[f.b64] = Array.from(content);
    }
  }
  console.log(`上传 ${Object.keys(payload).length} 个文件...`);
  const ur = await api(`/pages/assets/upload`, {
    method: 'POST',
    headers: { 'X-Cloudflare-Workers-Upload-Token': uploadToken },
    body: JSON.stringify(payload),
  });
  const ud = await ur.json();
  console.log('Upload:', ur.status, ud.success);
  if (!ud.success) {
    console.log(JSON.stringify(ud.errors, null, 2));
    process.exit(1);
  }
}

// 6. 创建部署
console.log('\n=== 6. 创建部署 ===');
const dr = await api(`/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}/deployments`, {
  method: 'POST',
  body: JSON.stringify({
    manifest: fileHashes,
    env_vars: {},
    branch: 'production',
    commitment_hash: uploadToken,
  }),
});
const dd = await dr.json();
console.log('Deploy:', dr.status, dd.success);
if (dd.success) {
  console.log('\n✓ 部署成功！');
  console.log('Deployment ID:', dd.result.id);
  console.log('URL:', dd.result.url);
  console.log('Environment:', dd.result.environment);
  console.log('uses_functions:', dd.result.uses_functions);
} else {
  console.log('Errors:', JSON.stringify(dd.errors, null, 2));
}
