<#
.SYNOPSIS
  模块化部署脚本（方案 B）：上传改动文件 + 创建/更新 mon-checkin runit 服务 + 重启 gateway + 健康验证
.DESCRIPTION
  P1 阶段部署：checkin 模块独立进程化。
  可重复执行（幂等）：runit 服务已存在则只更新 run 脚本内容；文件按 sha256 变化才 scp。
.EXAMPLE
  .\update-modules.ps1              # 全量：文件 + 服务 + 重启 + 验证
  .\update-modules.ps1 -VerifyOnly  # 只做健康检查（部署后快速核对）
#>
param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
$ROOT = $PSScriptRoot
# Termux SSH 目标：用户名形如 u0_aXXX（在手机上执行 whoami 查看），IP 为局域网地址（若configured=ip -4 addr show wlan0）
$SSH_TARGET = if ($env:MONITOR_SSH_TARGET) { $env:MONITOR_SSH_TARGET } else { 'u0_aXXX@192.168.0.xxx' }
$SSH_ARGS = @('-p', '8022')
$SVDIR = '/data/data/com.termux/files/usr/var/service'

function Invoke-Remote {
  param([string]$Cmd, [int]$TimeoutSec = 30)
  & ssh @SSH_ARGS -o ConnectTimeout=8 -o BatchMode=yes $SSH_TARGET $Cmd
  if ($LASTEXITCODE -ne 0) { throw "远程命令失败 (exit=$LASTEXITCODE): $Cmd" }
}
function Upload-IfChanged {
  param([string]$Local, [string]$Remote)
  $localHash = (Get-FileHash -LiteralPath $Local -Algorithm SHA256).Hash.ToLower()
  $remoteHash = & ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET "sha256sum $Remote 2>/dev/null | cut -d' ' -f1"
  if ($remoteHash -ne $localHash) {
    & scp -P 8022 $Local "${SSH_TARGET}:$Remote" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "上传失败: $Local" }
    Write-Host "    [UP] $Remote"
  } else {
    Write-Host "    [--] $Remote (未变化)"
  }
}

if ($VerifyOnly) {
  Write-Host '== 健康检查 ==' -ForegroundColor Cyan
  Invoke-Remote 'curl -s --max-time 5 http://127.0.0.1:3081/healthz; echo; curl -s --max-time 5 http://127.0.0.1:3083/healthz; echo'
  return
}

Write-Host '[1/5] SSH 连通性' -ForegroundColor Cyan
Invoke-Remote 'echo SSH_OK'

Write-Host '[2/5] 备份远程现网文件' -ForegroundColor Cyan
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
Invoke-Remote "mkdir -p ~/monitor_backup_mod_$ts && cp ~/monitor/server.js ~/monitor/lib/notify.js ~/monitor/lib/utils.js ~/monitor_backup_mod_$ts/ 2>/dev/null; echo BACKUP_OK ~/monitor_backup_mod_$ts"

Write-Host '[3/5] 上传改动文件（按 sha256 增量）' -ForegroundColor Cyan
Upload-IfChanged "$ROOT\monitor\lib\module.js"      '~/monitor/lib/module.js'
Upload-IfChanged "$ROOT\monitor\lib\notify.js"      '~/monitor/lib/notify.js'
Upload-IfChanged "$ROOT\monitor\lib\utils.js"       '~/monitor/lib/utils.js'
Upload-IfChanged "$ROOT\monitor\mod-checkin.js"     '~/monitor/mod-checkin.js'
Upload-IfChanged "$ROOT\monitor\server.js"          '~/monitor/server.js'
Invoke-Remote 'chmod 644 ~/monitor/lib/module.js ~/monitor/lib/notify.js ~/monitor/lib/utils.js ~/monitor/mod-checkin.js ~/monitor/server.js && node --check ~/monitor/mod-checkin.js && node --check ~/monitor/server.js && echo SYNTAX_OK'

Write-Host '[4/5] 创建/更新 mon-checkin runit 服务' -ForegroundColor Cyan
Invoke-Remote @"
mkdir -p $SVDIR/mon-checkin && cat > $SVDIR/mon-checkin/run <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
cd /data/data/com.termux/files/home/monitor
exec node mod-checkin.js 2>&1
EOF
chmod +x $SVDIR/mon-checkin/run
echo SERVICE_READY
"@

Write-Host '[5/5] 重启服务并健康验证' -ForegroundColor Cyan
Invoke-Remote "SVDIR=$SVDIR sv restart mon-checkin 2>/dev/null || SVDIR=$SVDIR sv start mon-checkin; sleep 2; SVDIR=$SVDIR sv restart server; sleep 4"
Invoke-Remote 'echo "--- healthz ---"; curl -s --max-time 5 http://127.0.0.1:3081/healthz; echo; curl -s --max-time 5 http://127.0.0.1:3083/healthz; echo; echo "--- provider filter ---"; curl -s --max-time 5 "http://127.0.0.1:3081/api/checkin/tasks?provider=autoclaw" | head -c 300; echo'
Write-Host ('完成。回滚：恢复 ' + "~/monitor_backup_mod_$ts" + ' 下的文件后 sv restart server') -ForegroundColor Green
