<#
.SYNOPSIS
  tag 发布流水线 · PC 侧（方案 B / P2，B 模式两段式的"段一"：staging，不动线上）
.EXAMPLE
  .\release-watch.ps1                  # 检查一次远端新 tag 并 staging
  .\release-watch.ps1 -Tag v1.0.1      # 显式 staging 指定 tag
  .\release-watch.ps1 -Watch           # 循环：每 5 分钟检查一次
#>
param(
  [string]$Tag = '',
  [switch]$Watch,
  [switch]$SyncUpstreamToken,
  [int]$IntervalSec = 300
)
$ErrorActionPreference = 'Stop'
# ★远程 JSON 可能含非 ASCII（如 deployed-version.json 的中文 note）：
#   PowerShell 默认按本地代码页（GBK）解码 ssh 的字节流，多字节字符会被解坏 → ConvertFrom-Json 报
#   “Unterminated string”，进而静默退化成“无基线 → 全量 affected”。强制 UTF-8 解码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ROOT = $PSScriptRoot
$SSH_ARGS = @('-p', '8022')
$SSH_TARGET = 'u0_a145@192.168.0.107'

function Invoke-Remote([string]$Cmd) {
  & ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET $Cmd
  if ($LASTEXITCODE -ne 0) { throw "远程命令失败: $Cmd" }
}
function Get-RemoteJson([string]$Cmd) {
  $out = & ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET $Cmd
  try { ($out -join "`n") | ConvertFrom-Json } catch {
    Write-Host "[warn] 远程 JSON 解析失败（会退化成全量 affected）: $_" -ForegroundColor Yellow
    $null
  }
}

$manifest = Get-Content (Join-Path $ROOT 'monitor\release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$repoFiles = @()
foreach ($m in $manifest.modules.PSObject.Properties) {
  foreach ($f in $m.Value.files.PSObject.Properties) { $repoFiles += $f.Name }
}
$repoFiles = $repoFiles | Sort-Object -Unique

function Stage-Release([string]$tag) {
  Write-Host "== staging $tag ==" -ForegroundColor Cyan
  $sha = git rev-list -n 1 $tag
  if (-not $sha) { throw "tag 不存在: $tag" }
  $remoteDir = "~/releases/$tag"

  $existing = Get-RemoteJson "cat $remoteDir/meta.json 2>/dev/null"

  # ① 受影响模块 = diff 上一部署 sha..tag ∩ manifest（先算，用于判断旧 meta 是否需重算）
  $deployed = Get-RemoteJson 'cat ~/.monitor_data/deployed-version.json 2>/dev/null'
  $deployedSha = $deployed.lastApply.sha
  $changed = @()
  if ($deployedSha) {
    $changed = @(git diff --name-only $deployedSha $sha)
    # 区分两种“空”：有基线但确实无文件变化（如 tag 被移动/重写历史） vs 根本拿不到基线。
    # 前者不能当全量，否则会把所有模块重启一遍。
    if (-not $changed.Count) { Write-Host "   [warn] $deployedSha..${sha} 无文件变化（同一内容的重复 tag）→ affected 置空，apply 需显式指定模块" -ForegroundColor Yellow }
  } else {
    Write-Host "   [warn] 拿不到部署基线 sha（deployed-version.json 缺失或解析失败）→ 视为全量" -ForegroundColor Yellow
    $changed = $repoFiles
  }
  $affected = @()
  foreach ($m in $manifest.modules.PSObject.Properties) {
    if ($changed | Where-Object { $m.Value.files.PSObject.Properties.Name -contains $_ }) { $affected += $m.Name }
  }
  Write-Host ("   affected: " + ($affected -join ', '))

  # 已 staging 且 sha + affected 均一致才跳过（affected 不一致 → 基线修正后重算并覆写 meta）
  if ($existing -and $existing.sha -eq $sha `
      -and ((@($existing.affectedModules) | Sort-Object) -join ',') -eq ((@($affected) | Sort-Object) -join ',')) {
    Write-Host '   已 staging（sha 与 affected 一致），跳过'; return
  }

  # ② 只导出 tag 里真实存在的 manifest 文件（git archive 直接产 tar，PC 侧无临时目录）
  $tagTree = @(git ls-tree -r --name-only $tag)
  $export = @($repoFiles | Where-Object { $tagTree -contains $_ })
  Write-Host ("   export files: " + $export.Count)
  $archive = Join-Path $ROOT '.openclaw\tmp\release-stage.tar.gz'
  New-Item -ItemType Directory -Force -Path (Split-Path $archive) | Out-Null
  git archive --format=tar.gz -o $archive $tag -- $export
  if ($LASTEXITCODE -ne 0) { throw 'git archive 失败' }

  Invoke-Remote "mkdir -p $remoteDir/files"
  & scp -P 8022 $archive "${SSH_TARGET}:$remoteDir/stage.tar.gz" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'scp 失败' }
  # 解包到 files/；stage.tar.gz 保留作为该 release 的存档（不删除任何文件）
  Invoke-Remote "tar xzf $remoteDir/stage.tar.gz -C $remoteDir/files && echo EXTRACT_OK"

  # ③ 语法门禁（手机端对所有 staged .js 跑 node --check）
  $jsFiles = @($export | Where-Object { $_.EndsWith('.js') })
  if ($jsFiles.Count) {
    $checkCmd = ($jsFiles | ForEach-Object { "node --check $remoteDir/files/$_" }) -join ' && '
    Invoke-Remote "$checkCmd && echo SYNTAX_OK"
  }

  # ④ meta.json（受影响模块 / sha / stagedAt）
  $meta = @{ tag = $tag; sha = $sha; stagedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); affectedModules = $affected; fileCount = $export.Count } | ConvertTo-Json -Compress
  $metaB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($meta))
  Invoke-Remote "echo $metaB64 | base64 -d > $remoteDir/meta.json"
  Invoke-Remote "cat $remoteDir/meta.json"
  Write-Host "   staged 完成 → $remoteDir（待应用：面板按钮 或 POST /api/release/apply）" -ForegroundColor Green
}

# 把 PC 上 git 已存的 GitHub 凭证同步到手机端上游检测配置（token 不回显、不进命令行参数）。
# 适用场景：私有仓库的手机端检测（GCM 的 OAuth token 会轮换/失效，重新跑一次即可）。
function Sync-UpstreamToken {
  Write-Host '== 同步上游检测 token ==' -ForegroundColor Cyan
  $res = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
  if (-not $res) { throw 'git credential fill 拿不到 github.com 凭证（PC 上未存过？）' }
  $tok = ($res | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
  if (-not $tok) { throw '凭证里没有 password/token 字段' }
  $user = ($res | Where-Object { $_ -like 'username=*' }) -replace '^username=', ''
  Write-Host "   username=$user 长度=$($tok.Length) 末4位=$($tok.Substring($tok.Length-4))（只报脱敏信息）"

  $body = @{ token = $tok; enabled = $true } | ConvertTo-Json -Compress
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($body))
  # 走 stdin，不进远程命令行；tr -d '\r' 避免 PowerShell 管道带 CR 导致 base64 报错
  $out = $b64 | ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET "tr -d '\r' | base64 -d | curl -s -X PUT --data-binary @- -H 'content-type: application/json' http://127.0.0.1:3084/api/release/config"
  $masked = ($out -join ' ')
  if ($masked -notmatch '"ok":true') { throw "配置写入失败: $masked" }
  Write-Host "   PUT /api/release/config -> ok（响应已脱敏）" -ForegroundColor Green

  $chk = ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET "curl -s -X POST http://127.0.0.1:3084/api/release/upstream/check"
  try {
    $j = ($chk -join "`n") | ConvertFrom-Json
    if ($j.checkError) { Write-Host "   检测仍报错: $($j.checkError)" -ForegroundColor Yellow }
    else { Write-Host "   检测 OK：latest=$($j.latest) base=$($j.base) 落后 $(($j.items | Where-Object { $_.newer }).Count) 个" -ForegroundColor Green }
  } catch { Write-Host "   检测响应解析失败: $_" -ForegroundColor Yellow }
}

do {
  try {
    if ($SyncUpstreamToken) {
      Sync-UpstreamToken
      $SyncUpstreamToken = $false
    }
    if ($Tag) {
      Stage-Release $Tag
      $Tag = ''
    } else {
      $deployed = Get-RemoteJson 'cat ~/.monitor_data/deployed-version.json 2>/dev/null'
      $deployedTag = $deployed.lastApply.tag
      $stagedRaw = & ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET 'ls ~/releases 2>/dev/null'
      $staged = @($stagedRaw | Where-Object { $_ })
      $remoteTags = git ls-remote --tags origin 2>$null | ForEach-Object { ($_ -split "`t")[1] -replace 'refs/tags/', '' -replace '\^{}', '' } | Where-Object { $_ -match '^v\d+(\.\d+)*$' } | Sort-Object { [version]($_ -replace '^v', '') } -Descending
      $newest = $remoteTags | Select-Object -First 1
      if ($newest -and $newest -ne $deployedTag -and $staged -notcontains $newest) {
        Write-Host "发现新 tag: $newest（当前部署: $(if ($deployedTag) { $deployedTag } else { '未记录' })）"
        Stage-Release $newest
      } else {
        Write-Host "无新 tag（最新: $newest，部署: $deployedTag，staged: $($staged -join ', ')）"
      }
    }
  } catch {
    Write-Host "[release-watch] $_" -ForegroundColor Red
  }
  if ($Watch) { Start-Sleep -Seconds $IntervalSec }
} while ($Watch)
