<#
.SYNOPSIS
  Honor10 一键部署脚本
.DESCRIPTION
  支持部署前端（Cloudflare Pages）、后端（Termux Node.js）、或双端一起部署。
  后端部署后会自动重启 monitor 并确保 auto-recovery 循环运行，保证服务自动重启。
.PARAMETER Target
  frontend : 仅部署前端到 Cloudflare Pages
  backend  : 仅部署后端到 Termux (通过 SSH/SCP)
  all      : 同时部署前端和后端（默认）
.EXAMPLE
  .\deploy.ps1              # 部署双端
  .\deploy.ps1 frontend     # 仅前端
  .\deploy.ps1 backend      # 仅后端
#>
param(
  [ValidateSet('frontend','backend','all')]
  [string]$Target = 'all'
)

# ====== 全局配置 ======
$ErrorActionPreference = 'Stop'
$ROOT = $PSScriptRoot
$MONITOR_DIR = Join-Path $ROOT 'monitor'
$FRONTEND_DIR = Join-Path $MONITOR_DIR 'frontend'
$LIB_DIR = Join-Path $MONITOR_DIR 'lib'

# SSH 目标（~/.ssh/config 已配置 honor10 别名；未配置则用 IP+端口）
$SSH_HOST = 'honor10'   # 若未配置 SSH config 别名，改为 192.168.0.107 并使用 -p 8022
$SSH_PORT = 8022
$SSH_USER = 'u0_a145'
$REMOTE_MONITOR_DIR = '~/monitor'
$REMOTE_LIB_DIR = '~/monitor/lib'

# Cloudflare Pages 配置
$CF_PROJECT = 'honor10-monitor'
$CF_BRANCH = 'production'
$CF_TOKEN = 'cfut_22Wpsd918WZHE3fpgBDcpPHUjm7rb1RFMVF8uep5870f091b'

# ====== 工具函数 ======
function Write-Step  { param([string]$msg) Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-OK    { param([string]$msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "[!]  $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "[X]  $msg" -ForegroundColor Red }

# 构造 SSH/SCP 命令（兼容别名和 IP+端口两种方式）
function Get-SshCmd {
  param([string]$RemoteCmd)
  # 优先使用 honor10 别名（依赖 ~/.ssh/config）；若未配置则回退到 IP+端口
  $sshConfig = Join-Path $env:USERPROFILE '.ssh\config'
  $useAlias = (Test-Path $sshConfig) -and (Select-String -Path $sshConfig -Pattern '^Host\s+honor10\b' -Quiet)
  if ($useAlias) {
    return @{ Exe = 'ssh'; Args = @('honor10', $RemoteCmd) }
  } else {
    return @{ Exe = 'ssh'; Args = @('-p', "$SSH_PORT", "$SSH_USER@192.168.0.107", $RemoteCmd) }
  }
}
function Get-ScpCmd {
  param([string]$LocalFile, [string]$RemoteFile)
  $sshConfig = Join-Path $env:USERPROFILE '.ssh\config'
  $useAlias = (Test-Path $sshConfig) -and (Select-String -Path $sshConfig -Pattern '^Host\s+honor10\b' -Quiet)
  if ($useAlias) {
    return @{ Exe = 'scp'; Args = @($LocalFile, "honor10:$RemoteFile") }
  } else {
    return @{ Exe = 'scp'; Args = @('-P', "$SSH_PORT", $LocalFile, "$SSH_USER@192.168.0.107:$RemoteFile") }
  }
}

function Invoke-RemoteCmd {
  param([string]$Cmd)
  $c = Get-SshCmd -RemoteCmd $Cmd
  & $c.Exe @($c.Args) 2>&1 | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "远程命令失败 (exit=$LASTEXITCODE): $Cmd" }
}

function Upload-File {
  param([string]$Local, [string]$Remote)
  if (-not (Test-Path $Local)) { throw "本地文件不存在: $Local" }
  $c = Get-ScpCmd -LocalFile $Local -RemoteFile $Remote
  & $c.Exe @($c.Args) 2>&1 | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "上传失败 (exit=$LASTEXITCODE): $Local -> $Remote" }
}

# ====== 前端部署 ======
function Deploy-Frontend {
  Write-Step '部署前端到 Cloudflare Pages'

  # 优先使用满足 wrangler 要求的 Node 版本（>=22），避免 PATH 里是旧版 Node
  $nodeDir = 'D:\Code\JavaScript\NodeJs'
  if (Test-Path (Join-Path $nodeDir 'node.exe')) {
    $env:PATH = "$nodeDir;$env:PATH"
  }

  # 清除代理环境变量，避免 wrangler 走代理导致认证失败
  foreach ($v in 'HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy') {
    Set-Item -Path "Env:$v" -Value $null
  }
  $env:CLOUDFLARE_API_TOKEN = $CF_TOKEN
  # WRANGLER_LOG=debug: 规避 wrangler 4.x 部署时上传缓存旧文件的 bug（否则 uses_functions 可能为 false）
  $env:WRANGLER_LOG = 'debug'

  if (-not (Test-Path $FRONTEND_DIR)) { throw "前端目录不存在: $FRONTEND_DIR" }
  Push-Location $FRONTEND_DIR
  try {
    Write-Host "    项目: $CF_PROJECT  分支: $CF_BRANCH"
    Write-Host "    目录: $FRONTEND_DIR"
    # --skip-caching: 避免 wrangler 缓存导致旧文件
    # functions/ 目录结构确保 uses_functions=true
    & npx wrangler pages deploy . --project-name $CF_PROJECT --branch $CF_BRANCH --commit-dirty=true --skip-caching 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "wrangler 部署失败 (exit=$LASTEXITCODE)" }
    Write-OK '前端部署完成'
  } finally {
    Pop-Location
  }
}

# ====== 后端部署 ======
function Deploy-Backend {
  Write-Step '部署后端到 Termux (通过 SSH/SCP)'

  # 需要上传的文件清单
  $files = @(
    @{ Local = Join-Path $MONITOR_DIR 'server.js';      Remote = "$REMOTE_MONITOR_DIR/server.js" },
    @{ Local = Join-Path $MONITOR_DIR 'package.json';   Remote = "$REMOTE_MONITOR_DIR/package.json" }
  )
  $libFiles = @('utils.js','actions.js','files.js','logger.js','metrics.js','notify.js','recorder.js','subscription.js','checkin-log.js','checkin-stats.js')
  foreach ($f in $libFiles) {
    $files += @{ Local = Join-Path $LIB_DIR $f; Remote = "$REMOTE_LIB_DIR/$f" }
  }
  # lib 子目录（签到框架：vendor 核心 + provider + 任务调度）
  $libSubFiles = @('checkin/checkin.js','checkin/scheduler.js','providers/index.js','providers/trae.js','tasks/index.js')
  foreach ($f in $libSubFiles) {
    $files += @{ Local = Join-Path $LIB_DIR $f; Remote = "$REMOTE_LIB_DIR/$f" }
  }

  # 检查本地文件是否都存在
  Write-Host '    检查本地文件...'
  foreach ($f in $files) {
    if (-not (Test-Path $f.Local)) { throw "本地文件缺失: $($f.Local)" }
    $size = (Get-Item $f.Local).Length
    Write-Host "      $($f.Local)  ($size bytes)"
  }

  # 测试 SSH 连接
  Write-Step '测试 SSH 连接'
  try {
    Invoke-RemoteCmd 'echo SSH_OK && pwd'
    Write-OK 'SSH 连接正常'
  } catch {
    throw "SSH 连接失败，请先配置密钥认证。错误: $_"
  }

  # 备份旧文件
  Write-Step '备份远程旧文件'
  $backupTs = Get-Date -Format 'yyyyMMdd_HHmmss'
  $backupCmd = "cp -r $REMOTE_MONITOR_DIR `~/monitor_backup_$backupTs 2>/dev/null; mkdir -p `~/monitor_backup_$backupTs/lib && cp $REMOTE_MONITOR_DIR/server.js `~/monitor_backup_$backupTs/ 2>/dev/null; cp $REMOTE_LIB_DIR/*.js `~/monitor_backup_$backupTs/lib/ 2>/dev/null; echo BACKUP_DONE"
  Invoke-RemoteCmd $backupCmd
  Write-OK "已备份到 ~/monitor_backup_$backupTs"

  # 确保远程 lib 目录存在（含签到框架子目录）
  Invoke-RemoteCmd "mkdir -p $REMOTE_LIB_DIR/checkin $REMOTE_LIB_DIR/providers $REMOTE_LIB_DIR/tasks && echo DIR_READY"

  # 上传文件
  Write-Step '上传后端文件'
  foreach ($f in $files) {
    Write-Host "    上传: $($f.Local) -> $($f.Remote)"
    Upload-File -Local $f.Local -Remote $f.Remote
  }
  Write-OK '文件上传完成'

  # 重启 monitor 服务并确保 auto-recovery 循环运行
  # 远程执行脚本单独存为 deploy-remote.sh，避免 PowerShell here-string 引号嵌套问题
  Write-Step '上传并执行远程脚本（重启 monitor + 启动 auto-recovery）'
  $remoteScriptLocal = Join-Path $ROOT 'deploy-remote.sh'
  if (-not (Test-Path $remoteScriptLocal)) { throw "远程脚本不存在: $remoteScriptLocal" }
  $remoteScriptPath = '~/monitor/_deploy_remote.sh'
  Upload-File -Local $remoteScriptLocal -Remote $remoteScriptPath
  Invoke-RemoteCmd "chmod +x $remoteScriptPath && bash $remoteScriptPath && rm -f $remoteScriptPath"
  Write-OK '后端部署完成'
}

# ====== 主流程 ======
Write-Host "`n========================================" -ForegroundColor Magenta
Write-Host "  Honor10 一键部署脚本" -ForegroundColor Magenta
Write-Host "  目标: $Target" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta

$startTime = Get-Date
try {
  switch ($Target) {
    'frontend' { Deploy-Frontend }
    'backend'  { Deploy-Backend }
    'all'      { Deploy-Backend; Deploy-Frontend }
  }
  $elapsed = ((Get-Date) - $startTime).TotalSeconds
  Write-Host "`n========================================" -ForegroundColor Green
  Write-OK "部署完成！耗时 $([math]::Round($elapsed,1)) 秒"
  Write-Host "========================================" -ForegroundColor Green
  if ($Target -in 'frontend','all') {
    Write-Host "  前端: https://honor10.lehuan.vip" -ForegroundColor Cyan
  }
  if ($Target -in 'backend','all') {
    Write-Host "  后端: 已部署并重启，auto-recovery 已启用" -ForegroundColor Cyan
  }
  Write-Host "========================================" -ForegroundColor Green
} catch {
  $elapsed = ((Get-Date) - $startTime).TotalSeconds
  Write-Err "部署失败: $_"
  Write-Err "耗时 $([math]::Round($elapsed,1)) 秒"
  exit 1
}
