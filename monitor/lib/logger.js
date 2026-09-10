import { existsSync, statSync, renameSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * 确保目录存在
 */
function ensureDir(dir) {
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {}
}

/**
 * 写入日志文件，带按日轮转
 * 规则：
 *  - 文件 > maxSize 且最后修改日 ≠ 今天 → 重命名为 file.YYYY-MM-DD.ext，创建新文件
 *  - 文件 > maxSize 但最后修改日 == 今天 → 不轮转，直接追加（当天日志不跨文件）
 *  - 文件 ≤ maxSize → 直接追加
 */
export function writeLog(filePath, content, maxSize = DEFAULT_MAX_SIZE) {
  try {
    ensureDir(dirname(filePath));

    if (existsSync(filePath)) {
      const st = statSync(filePath);
      if (st.size > maxSize) {
        const mtime = st.mtime;
        const today = new Date();
        if (mtime.toDateString() !== today.toDateString()) {
          // 最后修改日不是今天 → 轮转
          const dateStr = mtime.toISOString().slice(0, 10);
          const dotIdx = filePath.lastIndexOf('.');
          const rotatedPath = dotIdx > filePath.lastIndexOf('/')
            ? filePath.slice(0, dotIdx) + '.' + dateStr + filePath.slice(dotIdx)
            : filePath + '.' + dateStr;
          renameSync(filePath, rotatedPath);
        }
        // 当天日志不轮转，直接追加
      }
    }

    appendFileSync(filePath, content + '\n');
  } catch (e) {
    console.error('writeLog error:', e.message);
  }
}

/**
 * 读取日志文件最近 N 行
 */
export function readLogTail(filePath, maxLines = 100) {
  try {
    if (!existsSync(filePath)) return [];
    const data = readFileSync(filePath, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
