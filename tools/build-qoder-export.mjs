#!/usr/bin/env node
/**
 * tools/build-qoder-export.mjs —— 把 tools/qoder-export.ps1 打包成
 * monitor/frontend/qoder-export.bat（面板「新增账号」里下载的单文件脚本）。
 *
 * 与 build-trae-export.mjs 同思路：.bat 外壳必须【纯 ASCII】。
 *   cmd.exe 按字节解析批处理，文件里出现 UTF-8 中文会让行读取错位（`exit /b` 被跳过）。
 *   ⇒ 中文放进 base64 载荷，运行时由 PowerShell 按 UTF-8 解出来执行。
 *
 * ★与 Trae 的唯一差异：Qoder 的 auth.v1.dat 是 AES-256-GCM，只有 PowerShell 7+
 *   （.NET 8 的 System.Security.Cryptography.AesGcm）能解，所以外壳调 `pwsh` 而不是
 *   Windows PowerShell 5.1 的 `powershell`；找不到 pwsh 时给出安装提示。
 *
 * 用法：node tools/build-qoder-export.mjs
 * 产出：monitor/frontend/qoder-export.bat（纯 ASCII、CRLF、无 BOM）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SRC = 'tools/qoder-export.ps1';
const OUT = 'monitor/frontend/qoder-export.bat';
const WRAP = 120;

const ps = readFileSync(SRC, 'utf8');
const b64 = Buffer.from(ps, 'utf8').toString('base64');
const payload = b64.match(new RegExp(`.{1,${WRAP}}`, 'g')).join('\r\n');

const bat = `@echo off
rem ===========================================================================
rem  Qoder CN credential exporter (daily check-in token + device identity)
rem
rem  GENERATED FILE - do not edit by hand.
rem  Source : ${SRC}
rem  Build  : node tools/build-qoder-export.mjs
rem
rem  Requires PowerShell 7+ (AES-256-GCM via .NET 8). Install:
rem      winget install --id Microsoft.PowerShell -e
rem
rem  The payload is base64 because cmd.exe mis-parses batch files containing
rem  non-ASCII bytes; the PowerShell source is decoded as UTF-8 at runtime.
rem ===========================================================================
chcp 65001 >nul
setlocal
rem Panel origin is injected at download time (placeholder replaced by JS).
set "QODER_API_BASE=__API_BASE__"
title Qoder CN credential exporter
where pwsh >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] PowerShell 7 is required but "pwsh" was not found.
  echo     Install it once:  winget install --id Microsoft.PowerShell -e
  echo     Then run this file again.
  echo.
  pause
  exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; $t=[IO.File]::ReadAllText($f); $h=[char]35; $a=$t.IndexOf($h+'B64'+$h); $b=$t.IndexOf($h+'END'+$h); if($a -lt 0 -or $b -le $a){ Write-Host 'payload markers not found'; exit 1 }; $s=($t.Substring($a+5,$b-$a-5) -replace '\\s',''); Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))"
echo.
pause
exit /b 0
#B64#
${payload}
#END#
`;

const batOut = bat.replace(/\r?\n/g, '\r\n');
const bad = [...batOut].filter((c) => c.charCodeAt(0) > 0x7f);
if (bad.length) throw new Error(`产物含非 ASCII 字符 ${bad.length} 个，拒绝写出：${JSON.stringify(bad.slice(0, 8))}`);

writeFileSync(OUT, batOut, 'ascii');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
console.log(`源   ${SRC}  ${ps.length} 字节  sha256:${sha(ps)}`);
console.log(`产出 ${OUT}  ${batOut.length} 字节  sha256:${sha(batOut)}  （纯 ASCII + CRLF ✓）`);
console.log(`载荷 ${b64.length} 字符 base64，折成 ${Math.ceil(b64.length / WRAP)} 行`);