#!/usr/bin/env node
/**
 * tools/build-trae-export.mjs —— 把 tools/trae-export.ps1 打包成
 * monitor/frontend/trae-export.bat（用户从签到面板下载的那个单文件脚本）。
 *
 * ── 为什么要“打包”而不是直接手写 .bat ──
 *   cmd.exe 解析批处理文件时按字节推进，文件里只要出现非 ASCII 字节（UTF-8 中文），
 *   行读取就会错位：`exit /b` 会被跳过，后面的 PowerShell 代码被当批处理执行。
 *   （已实测复现：纯 ASCII 的 t1 正常，带中文的 t2/t3/t4/t5 全部跑穿。）
 *   ⇒ .bat 外壳必须【纯 ASCII】；中文放进 base64 载荷，由 PowerShell 按 UTF-8 解出来跑。
 *
 * 用法：node tools/build-trae-export.mjs
 * 产出：monitor/frontend/trae-export.bat（纯 ASCII、CRLF、无 BOM）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = 'tools/trae-export.ps1';
const OUT = 'monitor/frontend/trae-export.bat';
const WRAP = 120; // base64 每行长度（cmd 单行上限 8191，远够）

const ps = readFileSync(SRC, 'utf8');
const b64 = Buffer.from(ps, 'utf8').toString('base64');
const payload = b64.match(new RegExp(`.{1,${WRAP}}`, 'g')).join('\r\n');

// 外壳：纯 ASCII。用 IndexOf 找载荷边界，再把 base64 解成 UTF-8 源码 Invoke-Expression。
const bat = `@echo off
rem ===========================================================================
rem  Trae credential exporter (Plan A: refreshToken server-side auto-renew)
rem
rem  GENERATED FILE - do not edit by hand.
rem  Source : ${SRC}
rem  Build  : node tools/build-trae-export.mjs
rem
rem  Why the payload is base64: cmd.exe mis-parses batch files that contain
rem  non-ASCII bytes (line reader desyncs, "exit /b" is skipped). Keeping this
rem  shell pure ASCII is what makes it reliable; the PowerShell source is
rem  decoded from base64 as UTF-8 at runtime.
rem ===========================================================================
chcp 65001 >nul
setlocal
rem Forward args to PowerShell (--push / --no-push / --name=xxx)
set "TRAE_EXPORT_ARGS=%*"
rem Server base URL: the checkin panel replaces __API_BASE__ with its own
rem location.origin AT DOWNLOAD TIME, so nothing is hardcoded. Left as the
rem literal placeholder here (raw download) the script simply skips the upload.
set "TRAE_API_BASE=__API_BASE__"
title Trae credential exporter
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; $t=[IO.File]::ReadAllText($f); $h=[char]35; $a=$t.IndexOf($h+'B64'+$h); $b=$t.IndexOf($h+'END'+$h); if($a -lt 0 -or $b -le $a){ Write-Host 'payload markers not found'; exit 1 }; $s=($t.Substring($a+5,$b-$a-5) -replace '\\s',''); Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))"
echo.
pause
exit /b 0
#B64#
${payload}
#END#
`;

// 统一成 CRLF：.gitattributes 声明了 `*.bat text eol=crlf`，
// 落盘即 CRLF；这里直接产出 CRLF，保证「本地测的」==「实际发货的」。
const batOut = bat.replace(/\r?\n/g, '\r\n');

// 门禁：产物必须是纯 ASCII，否则 cmd 又会错位
const bad = [...batOut].filter((c) => c.charCodeAt(0) > 0x7f);
if (bad.length) throw new Error(`产物含非 ASCII 字符 ${bad.length} 个，拒绝写出：${JSON.stringify(bad.slice(0, 8))}`);

writeFileSync(OUT, batOut, 'ascii');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
console.log(`源   ${SRC}  ${ps.length} 字节  sha256:${sha(ps)}`);
console.log(`产出 ${OUT}  ${batOut.length} 字节  sha256:${sha(batOut)}  （纯 ASCII + CRLF ✓）`);
console.log(`载荷 ${b64.length} 字符 base64，折成 ${Math.ceil(b64.length / WRAP)} 行`);
