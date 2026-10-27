<#
.SYNOPSIS
  Qoder CN 凭证导出（Windows 侧，只读本机已登录客户端）→ 生成 QODER1.… 导入串，可直接写回面板。

.DESCRIPTION
  读取内容（全部只读）：
    %APPDATA%\com.qodercn.app.stable\Local State   os_crypt.encrypted_key（DPAPI 包裹的 AES-256-GCM key）
    %APPDATA%\com.qodercn.app.stable\auth.v1.dat   v10 信封：nonce(12) + ciphertext + tag(16)，内含 token/refreshToken/user
    <安装目录>\resources\umid\runtime-info.exe    UMID 设备风控三件套（machineToken/machineCode/machineType）
    %USERPROFILE%\.qoder-cn\.auth\machine_id      Cosy-MachineId
    <安装目录>\resources\umid\manifest.json       qoderCliVersion（= Cosy-Version）

  安全：脚本只读客户端文件，不写任何文件；凭证只出现在标准输出（供复制粘贴）或直接 POST 给面板。
        不落盘、不打日志、不写入仓库。运行时需要 PowerShell 7+（AES-GCM 依赖 .NET 8）。

.PARAMETER Panel
  面板地址，例如 https://monitor.example.com 或 http://192.168.0.107:3081。
  给了就直接 POST /api/checkin/qoder-import（可选择更新哪个账号）。

.PARAMETER TaskId
  指定要「更新」的已有账号 id（不传则按 userId 自动匹配，匹配不到才新建）。

.PARAMETER Name
  新建账号时的名称（默认用账号昵称）。

.PARAMETER NoUpload
  只在控制台打印导入串，不联网。

.PARAMETER NoVerify
  跳过「用该 token 读一次活动列表」的可用性自检。

.EXAMPLE
  pwsh -File qoder-export.ps1 -Panel http://192.168.0.107:3081
#>
#Requires -Version 7.0
param(
  [string]$Panel,
  [string]$TaskId,
  [string]$Name,
  [switch]$NoUpload,
  [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'

# 面板地址：面板下载脚本时会把 __API_BASE__ 替换成自己的 origin；
# 直接跑本文件（未替换）时该值仍是占位符 → 视为「不上传」。
if (-not $Panel -and $env:QODER_API_BASE -and $env:QODER_API_BASE -ne '__API_BASE__') {
  $Panel = $env:QODER_API_BASE
}
if ($env:QODER_NO_UPLOAD -eq '1') { $NoUpload = [switch]$true }

function Write-Step($m) { Write-Host "▶ $m" -ForegroundColor Cyan }
function Write-Ok($m) { Write-Host "✓ $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "✗ $m" -ForegroundColor Red }

# ---------------------------------------------------------------- 1) 定位客户端
$userData = Join-Path $env:APPDATA 'com.qodercn.app.stable'
if (-not (Test-Path (Join-Path $userData 'auth.v1.dat'))) {
  Write-Err2 "未找到 Qoder CN 客户端登录态：$userData\auth.v1.dat"
  Write-Host '  请先启动 Qoder CN 客户端并登录（剪藏/编辑器均可），再运行本脚本。'
  exit 1
}

$installDir = ''
$launcherIni = Join-Path $env:LOCALAPPDATA 'Qoder CN\Qoder CN Launcher\state.ini'
if (Test-Path $launcherIni) {
  $m = [regex]::Match((Get-Content $launcherIni -Raw), '(?m)^installDir=(.+)$')
  if ($m.Success) { $installDir = $m.Groups[1].Value.Trim() }
}
if (-not $installDir -or -not (Test-Path $installDir)) {
  foreach ($p in @('C:\Program Files\Qoder CN', (Join-Path $env:LOCALAPPDATA 'Programs\Qoder CN'))) {
    if (Test-Path (Join-Path $p 'resources\umid\runtime-info.exe')) { $installDir = $p; break }
  }
}
$umidExe = if ($installDir) { Join-Path $installDir 'resources\umid\runtime-info.exe' } else { '' }
$umidManifest = if ($installDir) { Join-Path $installDir 'resources\umid\manifest.json' } else { '' }
$buildManifest = if ($installDir) { Join-Path $installDir 'resources\build-manifest.json' } else { '' }

# ---------------------------------------------------------------- 2) 解密 auth.v1.dat
Write-Step '读取客户端登录态（DPAPI + OSCrypt v10）'
$localState = Get-Content (Join-Path $userData 'Local State') -Raw | ConvertFrom-Json
$blob = [Convert]::FromBase64String($localState.os_crypt.encrypted_key)
if ([Text.Encoding]::ASCII.GetString($blob[0..4]) -ne 'DPAPI') { throw 'unexpected encrypted_key prefix' }
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob[5..($blob.Length - 1)], $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)

$bytes = [IO.File]::ReadAllBytes((Join-Path $userData 'auth.v1.dat'))
if ([Text.Encoding]::ASCII.GetString($bytes[0..2]) -ne 'v10') { throw 'unexpected auth.v1.dat prefix' }
$nonce = $bytes[3..14]
$tag = $bytes[($bytes.Length - 16)..($bytes.Length - 1)]
$ct = $bytes[15..($bytes.Length - 17)]
$aes = [System.Security.Cryptography.AesGcm]::new($key, 16)
$plain = New-Object byte[] $ct.Length
$aes.Decrypt($nonce, $ct, $tag, $plain)
$auth = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
if (-not $auth.token) { throw 'auth.v1.dat 中没有 token —— 客户端可能未登录' }
Write-Ok ("账号：{0} / {1}" -f $auth.user.name, $auth.user.id)

# ---------------------------------------------------------------- 3) 设备身份
Write-Step '生成设备风控身份（UMID runtime-info.exe）'
$umid = $null
if ($umidExe -and (Test-Path $umidExe)) {
  $payload = '{"account":"' + $auth.user.id + '"}' + "`n"
  $out = $payload | & $umidExe 0 --account-stdin 2>$null
  try { $umid = ($out | Select-Object -First 1) | ConvertFrom-Json } catch { $umid = $null }
  if ($umid) { Write-Ok ("machineType={0} machineCode={1}" -f $umid.machineType, $umid.machineCode) }
} else {
  Write-Warn '未找到 resources\umid\runtime-info.exe（不影响签到，只是少了设备风控头）'
}
$machineId = ''
$machineIdFile = Join-Path $env:USERPROFILE '.qoder-cn\.auth\machine_id'
if (Test-Path $machineIdFile) { $machineId = ([IO.File]::ReadAllText($machineIdFile)).Trim() }
elseif (Test-Path (Join-Path $userData 'auth.machine-id')) { $machineId = ([IO.File]::ReadAllText((Join-Path $userData 'auth.machine-id'))).Trim() }

$cliVersion = '1.1.69'
if ($umidManifest -and (Test-Path $umidManifest)) {
  try { $v = (Get-Content $umidManifest -Raw | ConvertFrom-Json).qoderCliVersion; if ($v) { $cliVersion = [string]$v } } catch { }
}
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x86_64' } else { 'x86' }
$machineOs = "${arch}_win32"

# ---------------------------------------------------------------- 4) 可选：自检 token
if (-not $NoVerify) {
  Write-Step '自检 token（读一次活动列表）'
  $h = @{
    authorization      = "Bearer $($auth.token)"
    'cosy-clienttype'  = '10'
    'user-agent'       = 'Qoder'
    accept             = 'application/json'
    'accept-language'  = 'zh-CN'
  }
  if ($umid) {
    $h['Cosy-Version'] = $cliVersion
    $h['Cosy-MachineOS'] = $machineOs
    if ($machineId) { $h['Cosy-MachineId'] = $machineId }
    $h['Cosy-MachineHostname'] = $env:COMPUTERNAME
    $h['Cosy-MachineToken'] = $umid.machineToken
    $h['Cosy-MachineCode'] = $umid.machineCode
    $h['Cosy-MachineType'] = $umid.machineType
  }
  try {
    $r = Invoke-WebRequest -Uri 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns' -Headers $h -TimeoutSec 30 -SkipHttpErrorCheck
    if ($r.StatusCode -eq 200) {
      $j = $r.Content | ConvertFrom-Json
      $daily = @($j.campaigns | Where-Object { $_.actionType -eq 'CLAIM_BENEFIT' -and $_.benefit.kind -eq 'CREDITS' }) | Select-Object -First 1
      $state = if ($daily) { $daily.claimStatus } else { '未下发' }
      Write-Ok "token 可用；每日签到活动状态：$state"
    } else {
      Write-Warn "token 自检返回 HTTP $($r.StatusCode)（仍会导出，面板首次签到会自动续期）"
    }
  } catch {
    Write-Warn "token 自检失败：$($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- 5) 生成导入串
$texp = 0; $rexp = 0
if ($auth.expiresAt) { try { $texp = [DateTimeOffset]::Parse($auth.expiresAt).ToUnixTimeMilliseconds() } catch { } }
if ($auth.refreshTokenExpiresAt) { try { $rexp = [DateTimeOffset]::Parse($auth.refreshTokenExpiresAt).ToUnixTimeMilliseconds() } catch { } }

$blobObj = [ordered]@{
  v     = 1
  tk    = [string]$auth.token
  rt    = [string]$auth.refreshToken
  uid   = [string]$auth.user.id
  name  = [string]$auth.user.name
  mid   = [string]$machineId
  mtok  = if ($umid) { [string]$umid.machineToken } else { '' }
  mcode = if ($umid) { [string]$umid.machineCode } else { '' }
  mtype = if ($umid) { [string]$umid.machineType } else { '' }
  mos   = [string]$machineOs
  host  = 'https://openapi.qoder.com.cn'
  cli   = [string]$cliVersion
  at    = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
}
if ($texp) { $blobObj.texp = $texp }
if ($rexp) { $blobObj.rexp = $rexp }

$json = ($blobObj | ConvertTo-Json -Compress -Depth 4)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$importString = 'QODER1.' + $b64

Write-Host ''
Write-Host '================= QODER1 导入串 =================' -ForegroundColor Cyan
Write-Host $importString
Write-Host '=================================================' -ForegroundColor Cyan
Write-Host '（把整行粘贴到面板「新增账号 → 导入串」即可；或加 -Panel 让脚本自动提交）'

# ---------------------------------------------------------------- 6) 提交面板
if ($Panel -and -not $NoUpload) {
  $base = $Panel.TrimEnd('/')
  Write-Step "提交到面板 $base"
  try {
    if (-not $TaskId) {
      try {
        $targets = Invoke-RestMethod -Uri "$base/api/checkin/qoder-targets" -TimeoutSec 20
        $list = @($targets.tasks)
        if ($list.Count -gt 0) {
          Write-Host '已有 Qoder CN 账号：'
          for ($i = 0; $i -lt $list.Count; $i++) {
            $t = $list[$i]
            Write-Host ("  [{0}] {1}  uid={2}  RT={3}" -f ($i + 1), $t.name, $t.userId, $t.hasRefreshToken)
          }
          $pick = Read-Host '更新哪个？输入序号，直接回车 = 自动匹配/新建'
          if ($pick -match '^\d+$') {
            $idx = [int]$pick - 1
            if ($idx -ge 0 -and $idx -lt $list.Count) { $TaskId = $list[$idx].id }
          }
        }
      } catch {
        Write-Warn "读取账号清单失败（跳过选择）：$($_.Exception.Message)"
      }
    }
    $body = @{ importString = $importString }
    if ($TaskId) { $body.taskId = $TaskId }
    if ($Name) { $body.name = $Name }
    $resp = Invoke-RestMethod -Uri "$base/api/checkin/qoder-import" -Method POST `
      -ContentType 'application/json; charset=utf-8' `
      -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))) -TimeoutSec 30
    if ($resp.ok) {
      Write-Ok ("已{0}账号：{1}（id={2}）" -f $(if ($resp.created) { '新增' } else { '更新' }), $resp.name, $resp.id)
    } else {
      Write-Err2 "面板返回失败：$($resp | ConvertTo-Json -Compress)"
    }
  } catch {
    Write-Err2 "提交失败：$($_.Exception.Message)"
    Write-Host '  可手动复制上面的导入串到面板。'
  }
}
