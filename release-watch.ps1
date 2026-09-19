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
  [int]$IntervalSec = 300
)
$ErrorActionPreference = 'Stop'
$ROOT = $PSScriptRoot
$SSH_ARGS = @('-p', '8022')
$SSH_TARGET = 'u0_a145@192.168.0.107'

function Invoke-Remote([string]$Cmd) {
  & ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET $Cmd
  if ($LASTEXITCODE -ne 0) { throw "远程命令失败: $Cmd" }
}
function Get-RemoteJson([string]$Cmd) {
  $out = & ssh @SSH_ARGS -o BatchMode=yes $SSH_TARGET $Cmd
  try { ($out -join "`n") | ConvertFrom-Json } catch { $null }
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
  if ($existing -and $existing.sha -eq $sha) {
    Write-Host '   已 staging（sha 一致），跳过'; return
  }

  # ① 受影响模块 = diff 上一部署 sha..tag ∩ manifest
  $deployed = Get-RemoteJson 'cat ~/.monitor_data/deployed-version.json 2>/dev/null'
  $deployedSha = $deployed.lastApply.sha
  $changed = @()
  if ($deployedSha) { $changed = @(git diff --name-only $deployedSha $sha) }
  if (-not $changed.Count) { $changed = $repoFiles }   # 无基线 → 视为全量
  $affected = @()
  foreach ($m in $manifest.modules.PSObject.Properties) {
    if ($changed | Where-Object { $m.Value.files.PSObject.Properties.Name -contains $_ }) { $affected += $m.Name }
  }
  Write-Host ("   affected: " + ($affected -join ', '))

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

do {
  try {
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
