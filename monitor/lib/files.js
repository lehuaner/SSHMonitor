import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join, normalize, dirname } from 'node:path';
import { run, HOME, PROTECTED_FILES } from './utils.js';

const SAFE_ROOT = normalize(HOME);

export function safePath(p) {
  const full = normalize(join(HOME, p || ''));
  if (!full.startsWith(SAFE_ROOT)) return null;
  return full;
}

export function isProtected(p) {
  const full = safePath(p);
  if (!full) return false;
  const rel = full.replace(SAFE_ROOT + '/', '');
  return PROTECTED_FILES.some(f => rel === f || rel.startsWith(f + '/'));
}

export function listDir(path) {
  const dir = safePath(path);
  if (!dir || !existsSync(dir)) return null;
  return readdirSync(dir).map(name => {
    const full = join(dir, name);
    try {
      const s = statSync(full);
      const rel = path ? `${path}/${name}` : name;
      return { name, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs, protected: isProtected(rel) };
    } catch {
      return { name, isDir: false, size: 0, mtime: 0, protected: false };
    }
  }).sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
}

export function readFileContent(p) {
  const f = safePath(p);
  if (!f || !existsSync(f) || statSync(f).isDirectory()) return null;
  try { return readFileSync(f, 'utf-8'); } catch { return null; }
}

export function writeFileContent(p, c) {
  const f = safePath(p);
  if (!f) return false;
  try { writeFileSync(f, c, 'utf-8'); return true; } catch { return false; }
}

export function renameItem(p, n) {
  const f = safePath(p);
  if (!f || !existsSync(f)) return null;
  const d = join(dirname(f), n);
  if (existsSync(d)) return 'exists';
  try { renameSync(f, d); return true; } catch { return false; }
}

export function deleteItem(p) {
  const f = safePath(p);
  if (!f || !existsSync(f)) return null;
  try {
    if (statSync(f).isDirectory()) run(`rm -rf "${f}" 2>/dev/null`);
    else unlinkSync(f);
    return true;
  } catch { return false; }
}

export function makeDir(p) {
  const f = safePath(p);
  if (!f) return false;
  try { mkdirSync(f, { recursive: true }); return true; } catch { return false; }
}

// ====== Notes ======
const NOTES_FILE = HOME + '/.file_notes.json';

export function loadNotes() {
  try { return JSON.parse(readFileSync(NOTES_FILE, 'utf-8')); } catch { return {}; }
}

export function saveNotes(n) {
  try { writeFileSync(NOTES_FILE, JSON.stringify(n, null, 2), 'utf-8'); return true; } catch { return false; }
}

// ====== Upload ======
export function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const boundary = ct.match(/boundary=(.+)/)?.[1];
    if (!boundary) return reject('no boundary');
    let buf = [];
    req.on('data', d => buf.push(d));
    req.on('end', () => {
      const data = Buffer.concat(buf).toString('binary');
      const parts = data.split(`--${boundary}`);
      for (const part of parts) {
        if (part.includes('filename="')) {
          const m = part.match(/filename="(.+?)"/);
          const start = part.indexOf('\r\n\r\n') + 4;
          const end = part.lastIndexOf('\r\n--');
          if (m && start > 3) { resolve({ fileName: m[1], data: Buffer.from(part.slice(start, end > 0 ? end : undefined), 'binary') }); return; }
        }
      }
      reject('no file');
    });
    req.on('error', reject);
  });
}
