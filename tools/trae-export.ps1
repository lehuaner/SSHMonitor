# ============================================================================
#  Trae 凭证提取（方案一：refreshToken 服务端自续）
#
#  【这是源文件】最终给用户的单文件 .bat 由 tools/build-trae-export.mjs 生成：
#      node tools/build-trae-export.mjs
#  原因：.bat 里只要出现非 ASCII 字节，cmd.exe 的行读取就会错位、连 exit /b 都失效，
#        所以外壳必须是纯 ASCII，本文件被 base64 塞进去、由 PowerShell 按 UTF-8 解出来跑。
#
#  做什么：
#    1. 只读本机 Trae 客户端的 storage.json，解密 iCubeAuthInfo（tc 信封）
#    2. 提取 refreshToken / aha 设备 ID / machineId / userId
#    3. 【实测】拿它打一次 ExchangeToken，确认这个账号真的能用
#    4. 输出一段「导入串」，贴到签到面板即可
#
#  安全性：
#    - 全程【只读】，绝不修改客户端任何文件
#    - 唯一的网络请求是 Trae 官方的续期接口
#    - 实测会轮换 refreshToken：客户端手里那份会退到上一代
#      （实测无害——客户端仍可正常续期，并与我们自动收敛到同一份）
#
#  只支持 Windows（读 %APPDATA%）。macOS / Linux 未支持。
# ============================================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { chcp.com 65001 > $null } catch {}

$CLIENT_ID     = 'ono9krqynydwx5'
$CLIENT_SECRET = '-'
$EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'
$BRANDS        = @('Trae CN', 'TRAE SOLO CN', 'Trae', 'TRAE SOLO')

# 服务端地址：由签到面板在【下载那一刻】把它自己 origin 写进 .bat 外壳的
# `set "TRAE_API_BASE=..."` 明文行（不放在 base64 载荷里，否则无法替换）。
# 直接下原始文件时该值是字面量 __API_BASE__ ⇒ 校验不过 ⇒ 自动跳过"写回服务端"。
# 因此这里没有任何硬编码域名。
$ApiBase = [string]$env:TRAE_API_BASE

# 命令行参数（.bat 用 %* 透传到 TRAE_EXPORT_ARGS）
$RawArgs = [string]$env:TRAE_EXPORT_ARGS
$WantPush = $null                                  # $null=每次询问；$true/$false=强制
if ($RawArgs -match '--no-push') { $WantPush = $false }
elseif ($RawArgs -match '--push') { $WantPush = $true }
$NameArg = $null
if ($RawArgs -match '--name[=\s]+"?([^"]+)"?') { $NameArg = $Matches[1].Trim() }
# --task=<id>：非交互场景直接指定"更新哪一个"（交互场景下由脚本列出账号让你选）
$TaskArg = $null
if ($RawArgs -match '--task[=\s]+"?([^"\s]+)"?') { $TaskArg = $Matches[1].Trim() }

# 能不能交互：被重定向（管道 / CI）时不要在 Read-Host 上卡死
$CanAsk = -not [Console]::IsInputRedirected

function Ask-Text([string]$question, [string]$default) {
  if (-not $CanAsk) { return $default }
  $a = Read-Host ("{0} [{1}]" -f $question, $default)
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}

# tc 信封的两组硬编码盐（来自公开实现，与客户端逐字节一致）
$SALT_A = [byte[]]@(82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37)
$SALT_B = [byte[]]@(31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-Sha512([byte[]]$bytes) {
  $sha = [Security.Cryptography.SHA512]::Create()
  try { [byte[]]$h = $sha.ComputeHash($bytes); return $h } finally { $sha.Dispose() }
}

function Decrypt-Tc([string]$b64) {
  [byte[]]$buf = [Convert]::FromBase64String($b64)
  if ($buf.Length -lt 40) { throw '信封太短' }
  if (-not ($buf[0] -eq 0x74 -and $buf[1] -eq 0x63 -and $buf[2] -eq 0x05 -and $buf[3] -eq 0x10)) {
    throw ('未知信封类型 0x{0:x2}{1:x2}{2:x2}{3:x2}' -f $buf[0], $buf[1], $buf[2], $buf[3])
  }
  [byte[]]$rb  = $buf[6..37]
  [byte[]]$enc = $buf[38..($buf.Length - 1)]

  [byte[]]$salt = New-Object byte[] 64
  for ($i = 0; $i -lt 64; $i++) { $salt[$i] = $SALT_A[$i] -bxor $SALT_B[$i] }

  [byte[]]$k1 = Get-Sha512 $rb
  [byte[]]$k2 = Get-Sha512 ([byte[]]($k1 + $salt))

  $aes = [Security.Cryptography.Aes]::Create()
  try {
    $aes.Mode    = [Security.Cryptography.CipherMode]::CBC
    $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
    $aes.Key     = [byte[]]$k2[0..15]
    $aes.IV      = [byte[]]$k2[16..31]
    $dec = $aes.CreateDecryptor()
    [byte[]]$plain = $dec.TransformFinalBlock($enc, 0, $enc.Length)
  } finally { $aes.Dispose() }

  [byte[]]$stored  = $plain[0..63]
  [byte[]]$payload = $plain[64..($plain.Length - 1)]
  [byte[]]$calc    = Get-Sha512 $payload

  $diff = 0
  for ($i = 0; $i -lt 64; $i++) { $diff = $diff -bor ($stored[$i] -bxor $calc[$i]) }
  if ($diff -ne 0) { throw 'SHA-512 校验失败（客户端版本可能变了）' }

  return ([Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json)
}

function Invoke-Exchange([string]$baseHost, [string]$refreshToken, [string]$userId) {
  $url = $baseHost.TrimEnd('/') + $EXCHANGE_PATH
  $bodyObj = @{ ClientID = $CLIENT_ID; ClientSecret = $CLIENT_SECRET; RefreshToken = $refreshToken }
  if ($userId) { $bodyObj.UserID = $userId }
  [byte[]]$bodyBytes = [Text.Encoding]::UTF8.GetBytes(($bodyObj | ConvertTo-Json -Compress))

  $headers = @{
    'accept'             = '*/*'
    'user-agent'         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TRAESOLOCN/1.107.1 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36'
    'x-cloudide-token'   = ''
    'x-lgw-req-sdk-type' = '3'
    'package-type'       = 'stable_cn'
    'x-lscbd-aid'        = '787976'
    'x-lscbd-platform'   = 'windows'
    'app-version'        = '0.1.51'
    'x-request-id'       = [guid]::NewGuid().ToString()
  }

  try {
    $r = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body $bodyBytes `
                           -ContentType 'application/json' -TimeoutSec 30
    if ($r.Result -and $r.Result.Token) {
      return @{ ok = $true; token = $r.Result.Token; refreshToken = $r.Result.RefreshToken; expireAt = $r.Result.TokenExpireAt }
    }
    return @{ ok = $false; msg = '响应里没有 Token' }
  } catch {
    $msg = $_.Exception.Message
    # 优先用 Invoke-RestMethod 塞在 ErrorDetails 里的响应体（PS 5.1 适用），
    # 拿不到再退回读 WebException.Response 的流。否则用户只看到泛化的 "400 Bad Request"。
    $raw = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = [string]$_.ErrorDetails.Message }
    if (-not $raw) {
      foreach ($ex in @($_.Exception, $_.Exception.InnerException)) {
        try {
          if ($ex -and $ex.Response) {
            $stream = $ex.Response.GetResponseStream()
            if ($stream) { $raw = (New-Object IO.StreamReader($stream)).ReadToEnd(); break }
          }
        } catch {}
      }
    }
    if ($raw) {
      try {
        $j = $raw | ConvertFrom-Json
        if ($j.ResponseMetadata -and $j.ResponseMetadata.Error) {
          $e = $j.ResponseMetadata.Error
          $msg = ('code={0} "{1}"' -f $e.Code, $e.Message)
        } elseif ($j.message) {
          $msg = ('code={0} "{1}"' -f $j.code, $j.message)
        }
      } catch {}
    }
    return @{ ok = $false; msg = $msg }
  }
}

function New-ImportString([string]$refreshToken, [string]$deviceId, [string]$machineId, `
                          [string]$userId, [string]$hostName, [string]$brand, `
                          [string]$token, [long]$tokenExpireAt) {
  $blob = [ordered]@{
    v     = 1
    rt    = $refreshToken
    did   = $deviceId
    mid   = $machineId
    uid   = $userId
    host  = $hostName
    brand = $brand
    at    = (Get-Date).ToString('s')
  }
  # ★把刚换到的 access token 一并带上：服务端首次使用就不必立刻再续期，
  #   而每次续期都会推进 refreshToken 轮换链（客户端手里那份只宽限一代）。
  if ($token) { $blob.tk = $token }
  if ($tokenExpireAt -gt 0) { $blob.texp = $tokenExpireAt }
  $json = $blob | ConvertTo-Json -Compress
  $b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $b64  = $b64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
  return 'TRAE1.' + $b64
}

# 取服务端已有的 Trae 账号清单（供用户选「更新哪个 / 新建」）
function Get-TraeTargets([string]$apiBase) {
  try {
    $r = Invoke-RestMethod -Uri ($apiBase.TrimEnd('/') + '/api/checkin/trae-targets') -Method Get -TimeoutSec 20
    if ($r -and $r.tasks) { return @($r.tasks) }
  } catch {}
  return @()
}

# 把导入串写回服务端（新增 or 更新由 taskId / userId 决定）
function Invoke-Push([string]$apiBase, [string]$importString, [string]$name, [string]$taskId, [string]$time, [string]$timezone) {
  $url = $apiBase.TrimEnd('/') + '/api/checkin/trae-import'
  $payload = @{ importString = $importString }
  if ($taskId) { $payload.taskId = $taskId }
  if ($name) { $payload.name = $name }
  if ($time) { $payload.time = $time }
  if ($timezone) { $payload.timezone = $timezone }
  [byte[]]$bodyBytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
  try {
    $r = Invoke-RestMethod -Uri $url -Method Post -Body $bodyBytes -ContentType 'application/json' -TimeoutSec 30
    return @{ ok = $true; created = [bool]$r.created; name = [string]$r.name; nameKept = [bool]$r.nameKept }
  } catch {
    $msg = $_.Exception.Message
    $raw = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = [string]$_.ErrorDetails.Message }
    if (-not $raw) {
      try {
        $resp = $_.Exception.Response
        if (-not $resp -and $_.Exception.InnerException) { $resp = $_.Exception.InnerException.Response }
        if ($resp) {
          $stream = $resp.GetResponseStream()
          if ($stream) { $raw = (New-Object IO.StreamReader($stream)).ReadToEnd() }
        }
      } catch {}
    }
    if ($raw) {
      # 被 Cloudflare Access 拦住时返回的是登录页 HTML，而不是我们的 JSON。
      # 这不是"脚本坏了"，而是"脚本没有浏览器会话" —— 必须给出可操作的指引。
      if ($raw -match '(?i)<!DOCTYPE|<html|cloudflareaccess|Sign in ') {
        return @{ ok = $false; accessDenied = $true; msg = '被 Cloudflare Access 拦截（脚本没有浏览器登录态）' }
      }
      try {
        $j = $raw | ConvertFrom-Json
        if ($j.error) { $msg = [string]$j.error }
        elseif ($j.ResponseMetadata -and $j.ResponseMetadata.Error) {
          $e = $j.ResponseMetadata.Error
          $msg = ('code={0} "{1}"' -f $e.Code, $e.Message)
        }
      } catch {}
    }
    return @{ ok = $false; msg = $msg }
  }
}

# ------------------------------------------------------------------ 主流程
Write-Host ''
Write-Host '=== Trae 凭证提取（方案一）===' -ForegroundColor Cyan
Write-Host '只读客户端文件；只会向 Trae 官方接口发一次续期测试请求。'
Write-Host ''

$appData = $env:APPDATA
if (-not $appData) {
  Write-Host '取不到 %APPDATA%，本脚本需要在 Windows 上运行。' -ForegroundColor Red
  exit 1
}

$records = @()
foreach ($brand in $BRANDS) {
  $file = Join-Path $appData ($brand + '\User\globalStorage\storage.json')
  if (-not (Test-Path -LiteralPath $file)) { continue }

  $json = $null
  try { $json = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
  if (-not $json) { continue }

  $authKey = $null
  $dcKey   = $null
  foreach ($prop in $json.PSObject.Properties) {
    if ($prop.Name -like 'iCubeAuthInfo://icube.cloudide*') { $authKey = $prop.Name }
    elseif ($prop.Name -match '^iCubeAuthInfo://icube-dc:(\d+)$') { $dcKey = $prop.Name }
  }
  if (-not $authKey) { continue }

  $auth = $null
  try { $auth = Decrypt-Tc ([string]$json.$authKey) } catch {
    Write-Host ('[{0}] 解密失败：{1}' -f $brand, $_.Exception.Message) -ForegroundColor Yellow
    continue
  }

  $username = ''
  $mobile   = ''
  if ($auth.account) {
    if ($auth.account.username) { $username = [string]$auth.account.username }
    if ($auth.account.nonPlainTextMobile) { $mobile = [string]$auth.account.nonPlainTextMobile }
  }
  $hostName = 'https://api.trae.cn'
  if ($auth.host) { $hostName = [string]$auth.host }
  $deviceId = ''
  if ($dcKey) { $deviceId = ($dcKey -split ':')[-1] }

  $records += [pscustomobject]@{
    brand            = $brand
    userId           = [string]$auth.userId
    username         = $username
    mobile           = $mobile
    refreshToken     = [string]$auth.refreshToken
    host             = $hostName
    deviceId         = $deviceId
    machineId        = [string]$json.'telemetry.machineId'
    refreshExpiredAt = [string]$auth.refreshExpiredAt
  }
}

if ($records.Count -eq 0) {
  Write-Host '没有找到任何已登录的 Trae 客户端。' -ForegroundColor Yellow
  Write-Host '请先在 Trae CN 客户端里登录目标账号（必须用 Trae CN，不要用 TRAE SOLO CN），然后重跑本脚本。'
  exit 1
}

Write-Host ('找到 {0} 个登录态，开始逐个实测……' -f $records.Count) -ForegroundColor Cyan

$results = @()
foreach ($rec in $records) {
  Write-Host ''
  Write-Host ('── [{0}] {1}  {2}' -f $rec.brand, $rec.username, $rec.mobile) -ForegroundColor White
  Write-Host ('   userId={0}  deviceId={1}' -f $rec.userId, $rec.deviceId)

  if (-not $rec.refreshToken) {
    Write-Host '   ✗ 没有 refreshToken' -ForegroundColor Red
    continue
  }

  $res = Invoke-Exchange $rec.host $rec.refreshToken $rec.userId
  if ($res.ok) {
    $rec.refreshToken = $res.refreshToken          # ★ 用轮换后的新值
    $expDays = '?'
    if ($res.expireAt) {
      $delta = ([datetimeoffset]::FromUnixTimeMilliseconds([long]$res.expireAt)).LocalDateTime - (Get-Date)
      $expDays = [math]::Round($delta.TotalDays, 1)
    }
    Write-Host ('   ✓ 续期成功（新 access 有效 {0} 天）' -f $expDays) -ForegroundColor Green

    $import = New-ImportString $rec.refreshToken $rec.deviceId $rec.machineId $rec.userId $rec.host $rec.brand $res.token $res.expireAt
    $rec | Add-Member -NotePropertyName importString -NotePropertyValue $import -Force
    $results += $rec

    Write-Host ''
    Write-Host '   导入串（复制下面整行）：' -ForegroundColor Yellow
    Write-Host ('   ' + $import) -ForegroundColor Yellow
  } else {
    Write-Host ('   ✗ 不可用：{0}' -f $res.msg) -ForegroundColor Red
    if ($rec.brand -like 'TRAE SOLO*') {
      Write-Host '     → 这是 TRAE SOLO CN 签发的凭证，方案一不支持（它要求设备签名）。' -ForegroundColor DarkYellow
      Write-Host '       请在 Trae CN 客户端里登录该账号后重跑本脚本。' -ForegroundColor DarkYellow
    } elseif ($res.msg -match '10101|not matched') {
      Write-Host '     → 该凭证不属于 Trae CN 客户端，请在 Trae CN 里登录后重跑。' -ForegroundColor DarkYellow
    } elseif ($res.msg -match '20101') {
      Write-Host '     → 该凭证已失效，请在 Trae CN 客户端重新登录后重跑。' -ForegroundColor DarkYellow
    }
  }
}

Write-Host ''
if ($results.Count -eq 0) {
  Write-Host '没有可用账号。' -ForegroundColor Yellow
  Write-Host ''
} else {
  Write-Host ('✓ 共 {0} 个可用账号。' -f $results.Count) -ForegroundColor Green

  # ── 写回服务端 ────────────────────────────────────────────────
  # 默认【不写回】：面板几乎总在 Cloudflare Access 之后，浏览器带着 Access 会话能过，
  # 而 PowerShell 脚本没有会话（CF_Authorization 是 HttpOnly，页面 JS 也读不到）
  # ⇒ 脚本直连会被拦在登录页。所以导入统一走面板的「导入凭证」（由浏览器提交）。
  # 若你的部署没有 Access（例如纯内网/本机），可加 --push 让脚本直接写回。
  $canPush = $ApiBase -match '^https?://'
  $doPush = ($WantPush -eq $true)
  if ($doPush -and -not $canPush) {
    Write-Host ''
    Write-Host '（已指定 --push，但脚本未携带服务端地址 —— 请从签到面板下载。已跳过写回。）' -ForegroundColor DarkYellow
    $doPush = $false
  }

  if ($doPush) {
    Write-Host ''
    $targets = Get-TraeTargets $ApiBase
    foreach ($rec in $results) {
      $suggest = 'Trae'
      if ($rec.username) { $suggest = 'Trae · ' + $rec.username }
      elseif ($rec.mobile) { $suggest = 'Trae · ' + $rec.mobile }
      elseif ($rec.userId) { $suggest = 'Trae · ' + $rec.userId.Substring([Math]::Max(0, $rec.userId.Length - 4)) }

      # ── 选目标：服务端已有账号时让用户明确选「更新哪一个 / 新建」──
      # 不能只靠服务端自动匹配：老账号是方案二(Cookie)建起来的，没有 refreshMeta.userId，
      # 自动匹配必然落空、凭空多出一个重复账号。
      $taskId = $null
      $matchedIdx = 0
      if ($TaskArg) {
        # 非交互：直接指定目标（不校验存在性，交给服务端报错，信息更准）
        $taskId = $TaskArg
      } elseif ($targets.Count -gt 0) {
        for ($i = 0; $i -lt $targets.Count; $i++) {
          $t = $targets[$i]
          if ($t.userId -and $rec.userId -and ([string]$t.userId -eq [string]$rec.userId)) { $matchedIdx = $i + 1 }
        }
        Write-Host ''
        Write-Host ('  服务端已有 {0} 个 Trae 账号：' -f $targets.Count) -ForegroundColor Cyan
        for ($i = 0; $i -lt $targets.Count; $i++) {
          $t = $targets[$i]
          $modeTxt = '方案一'
          if ($t.mode -eq 'cookie') { $modeTxt = '方案二 Cookie' }
          $mark = ''
          if (($i + 1) -eq $matchedIdx) { $mark = '   ← 按 userId 自动识别为同一账号' }
          Write-Host ('    [{0}] {1}   {2}{3}' -f ($i + 1), $t.name, $modeTxt, $mark)
        }
        Write-Host '    [0] 新建一个账号'
        $sel = Ask-Text '  本次凭证写到哪一个' ([string]$matchedIdx)
        $n = -1
        if ([int]::TryParse($sel, [ref]$n) -and $n -ge 1 -and $n -le $targets.Count) {
          $taskId = $targets[$n - 1].id
        }
      } elseif ($CanAsk) {
        Write-Host ''
        Write-Host '  服务端还没有 Trae 账号，将新建一个。' -ForegroundColor DarkGray
      }

      # 名称只在「新建」时才有意义；更新时服务端会保留原名
      $name = $null
      if (-not $taskId) {
        if ($NameArg -and $results.Count -eq 1) { $name = $NameArg }
        else { $name = Ask-Text '  新建账号名称' $suggest }
      }

      $p = Invoke-Push $ApiBase $rec.importString $name $taskId $null $null
      if ($p.ok) {
        if ($p.created) {
          Write-Host ('  ✓ 已新增账号：{0}' -f $p.name) -ForegroundColor Green
        } else {
          Write-Host ('  ✓ 已更新凭证：{0}（id {1}）' -f $p.name, $taskId) -ForegroundColor Green
          Write-Host '    只替换了凭证；账号名称 / 签到时间 / 时区 / 开关 / 方案二 Cookie 全部保持原样。' -ForegroundColor DarkGray
        }
      } else {
        if ($p.accessDenied) {
          Write-Host '  ⚠ 自动写回失败：面板在 Cloudflare Access 之后，脚本没有浏览器登录态。' -ForegroundColor Yellow
          Write-Host '    这不影响凭证提取 —— 上面的导入串已经复制到剪贴板，' -ForegroundColor Yellow
          Write-Host '    打开签到面板 → Trae 账号 →「导入凭证」→ 粘贴即可（浏览器里是已登录的）。' -ForegroundColor Yellow
        } else {
          Write-Host ('  ✗ 写入失败：{0}' -f $p.msg) -ForegroundColor Red
          Write-Host '    → 可回到签到面板手动粘贴该导入串。' -ForegroundColor DarkYellow
        }
      }
    }
    Write-Host ''
    Write-Host '完成。打开签到面板即可看到（任务已进入调度）。' -ForegroundColor Cyan
  } else {
    if ($results.Count -eq 1) {
      try { Set-Clipboard -Value $results[0].importString; Write-Host '导入串已复制到剪贴板。' -ForegroundColor Green } catch {}
    }
    Write-Host ''
    Write-Host '下一步（导入由浏览器完成，这样才过得了 Cloudflare Access）：' -ForegroundColor Cyan
    Write-Host '  1) 打开签到面板 → 点工具栏「导入凭证」'
    Write-Host '  2) 在「导入串」框里 Ctrl+V（脚本已复制好）'
    Write-Host '  3) 选「写入到」哪个账号（会自动认出同一账号），点「导入」'
    Write-Host ''
    Write-Host '为什么脚本不自己写回：面板在 Cloudflare Access 之后，脚本没有浏览器登录态，' -ForegroundColor DarkGray
    Write-Host '直连会被拦在登录页。若你的部署没有 Access（纯内网/本机），可用 --push 直连。' -ForegroundColor DarkGray
  }
  Write-Host ''
}
