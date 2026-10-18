# ============================================================================
#  WorkBuddy 凭证提取（桌面端 refreshToken → 服务端静默续期）
#
#  【这是源文件】最终给用户的单文件 .bat 由 tools/build-wb-export.mjs 生成：
#      node tools/build-wb-export.mjs
#  原因：.bat 里只要出现非 ASCII 字节，cmd.exe 的行读取就会错位、连 exit /b 都失效，
#        所以外壳必须是纯 ASCII，本文件被 base64 塞进去、由 PowerShell 按 UTF-8 解出来跑。
#
#  做什么：
#    1. 临时用 --inspect 启动 WorkBuddy 桌面端（若已在运行则先优雅关闭），
#       通过主进程 Node inspector（CDP）执行一段只读脚本：
#         · process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()
#           取 atRestSecretKey → SHA256 派生 buildKey（桌面端同款算法，2026-10-18 实测）
#         · 解密 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
#           里的 $wbEncrypted 字段（AES-256-GCM + WBEV1 帧 AAD）→ 取出 refreshToken 等
#    2. 【实测】拿 refreshToken 打一次官方续期端点（/v2/plugin/auth/token/refresh），
#       确认这个账号真的能用，并换到全新的 access+refresh 对
#    3. 输出一段「导入串」（WB1.<base64url>），贴到签到面板即可
#    4. 结束后恢复桌面端原状（原本在跑 → 无调试端口重启；原本没跑 → 关掉）
#
#  安全性：
#    - 读取桌面端登录态文件【只读】，绝不修改客户端任何文件；调试端口只监听 127.0.0.1
#    - 唯一的网络请求是 WorkBuddy 官方续期接口
#    - refreshToken 为离线令牌（Offline），监控端与桌面端各持一份、互不顶下线（实测）
#
#  只支持 Windows。
# ============================================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { chcp.com 65001 > $null } catch {}

# 服务端地址：由签到面板在【下载那一刻】把它自己 origin 写进 .bat 外壳的
# `set "WB_API_BASE=..."` 明文行（不放在 base64 载荷里，否则无法替换）。
# 直接下原始文件时该值是字面量 __API_BASE__ ⇒ 校验不过 ⇒ 自动跳过"写回服务端"。
# 因此这里没有任何硬编码域名。
$ApiBase = [string]$env:WB_API_BASE

# 命令行参数（.bat 用 %* 透传到 WB_EXPORT_ARGS）
$RawArgs = [string]$env:WB_EXPORT_ARGS
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

$REFRESH_URL = 'https://www.workbuddy.cn/v2/plugin/auth/token/refresh'
# 刷新端点用桌面端 UA（客户端原样值；与 provider 里 REFRESH.ua 一致）
$REFRESH_UA  = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'
# 调试端口候选（都只监听 127.0.0.1；按顺序找空闲的）
$INSPECT_PORTS = @(9333, 9334, 9335, 9336, 9337, 9338)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ────────────────────────────────────────────────────────────────
#  定位 WorkBuddy
# ────────────────────────────────────────────────────────────────
function Find-WorkBuddyExe {
  # ① 正在运行的进程（路径最真实）
  try {
    $p = Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if ($p -and (Test-Path -LiteralPath $p.Path)) { return [string]$p.Path }
  } catch {}
  # ② 注册表卸载信息（InstallLocation 或 UninstallString 所在目录）
  $regRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($root in $regRoots) {
    try {
      foreach ($item in @(Get-ItemProperty $root -ErrorAction SilentlyContinue)) {
        if (-not ($item.DisplayName -like '*WorkBuddy*')) { continue }
        $dir = $null
        if ($item.InstallLocation) { $dir = [string]$item.InstallLocation }
        elseif ($item.UninstallString) {
          $u = ([string]$item.UninstallString).Trim('"')
          if ($u -match '^(.*)\\') { $dir = $Matches[1].Trim('"') }
        }
        if ($dir) {
          $exe = Join-Path $dir 'WorkBuddy.exe'
          if (Test-Path -LiteralPath $exe) { return $exe }
        }
      }
    } catch {}
  }
  # ③ 常见安装位置兜底
  $guess = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'),
    'D:\Code\Editer\WorkBuddy\WorkBuddy.exe',
    (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe')
  )
  foreach ($g in $guess) {
    if ($g -and (Test-Path -LiteralPath $g)) { return $g }
  }
  return $null
}

function Get-WorkBuddyProcesses {
  return @(Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue)
}

# 优雅关闭 → 等 8 秒 → 强杀兜底（桌面端会话在服务端，强杀不丢凭证）
function Stop-WorkBuddyProcesses {
  $procs = Get-WorkBuddyProcesses
  if ($procs.Count -eq 0) { return }
  foreach ($p in $procs) { try { $null = $p.CloseMainWindow() } catch {} }
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $deadline) {
    if ((Get-WorkBuddyProcesses).Count -eq 0) { return }
    Start-Sleep -Milliseconds 400
  }
  Stop-Process -Name 'WorkBuddy' -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000
}

# ────────────────────────────────────────────────────────────────
#  Inspector / CDP
# ────────────────────────────────────────────────────────────────
function Get-InspectorTarget([int]$Port) {
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/json/list" -f $Port) -TimeoutSec 3
    $t = @($r) | Where-Object { $_.webSocketDebuggerUrl } | Select-Object -First 1
    if ($t) { return $t }
  } catch {}
  return $null
}

function Wait-Inspector([int[]]$Ports, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    foreach ($p in $Ports) {
      $t = Get-InspectorTarget $p
      if ($t) { return @{ port = $p; target = $t } }
    }
    if ($TimeoutSec -le 0) { break }
    Start-Sleep -Milliseconds 700
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Test-PortBusy([int]$Port) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $r = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $r.AsyncWaitHandle.WaitOne(300)) { return $false }
    $c.EndConnect($r)
    return $true
  } catch { return $false } finally { $c.Close() }
}

# 在 WorkBuddy 主进程里执行一段 JS（Runtime.evaluate），返回解析后的对象。
# 返回 { ok, value } 或 { ok=$false, error }
function Invoke-CdpEval([string]$WsUrl, [string]$Js, [int]$TimeoutMs) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ct = [System.Threading.CancellationToken]::None
  try {
    $t = $ws.ConnectAsync([Uri]$WsUrl, $ct)
    if (-not $t.Wait($TimeoutMs)) { throw '连接 inspector 超时' }
    if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { throw ('WebSocket 状态异常：' + $ws.State) }

    $payload = @{
      id = 1
      method = 'Runtime.evaluate'
      params = @{ expression = $Js; awaitPromise = $true; returnByValue = $true }
    } | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $seg = [System.ArraySegment[byte]]::new($bytes)
    $t = $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct)
    if (-not $t.Wait($TimeoutMs)) { throw '发送执行请求超时' }

    $buf = New-Object byte[] 65536
    $sb  = New-Object Text.StringBuilder
    $resp = $null
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
      $segIn = [System.ArraySegment[byte]]::new($buf)
      $task = $ws.ReceiveAsync($segIn, $ct)
      $left = [int][Math]::Max(1000, ($deadline - (Get-Date)).TotalMilliseconds)
      if (-not $task.Wait($left)) { throw '等待执行结果超时' }
      $r = $task.Result
      if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw 'inspector 连接被关闭' }
      $sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)) | Out-Null
      if (-not $r.EndOfMessage) { continue }
      $text = $sb.ToString()
      $sb.Clear() | Out-Null
      $maybe = $null
      try { $maybe = $text | ConvertFrom-Json } catch {}
      if ($maybe -and $maybe.id -eq 1) { $resp = $maybe; break }
    }
    if (-not $resp) { throw '没有等到执行结果' }
    if ($resp.error) { throw ('CDP 错误：' + ($resp.error | ConvertTo-Json -Compress)) }
    if ($resp.result -and $resp.result.exceptionDetails) {
      $ed = $resp.result.exceptionDetails
      $msg = ''
      if ($ed.exception -and $ed.exception.description) { $msg = [string]$ed.exception.description }
      elseif ($ed.text) { $msg = [string]$ed.text }
      throw ('页面内脚本异常：' + $msg)
    }
    $val = $null
    if ($resp.result -and $resp.result.result) { $val = $resp.result.result.value }
    if ($val -isnot [string]) { throw '执行结果不是字符串' }
    return @{ ok = $true; value = ($val | ConvertFrom-Json) }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  } finally {
    try { $ws.Dispose() } catch {}
  }
}

# ────────────────────────────────────────────────────────────────
#  续期 / JWT / 导入串
# ────────────────────────────────────────────────────────────────
function Invoke-WbRefresh([string]$refreshToken, [string]$userId) {
  $headers = @{
    'accept'                = 'application/json, text/plain, */*'
    'x-domain'              = 'copilot.tencent.com'
    'x-refresh-token'       = $refreshToken
    'x-auth-refresh-source' = 'plugin'
    'x-product'             = 'SaaS'
    'x-request-id'          = [guid]::NewGuid().ToString('N')
    'user-agent'            = $REFRESH_UA
  }
  if ($userId) { $headers['x-user-id'] = $userId }
  try {
    $r = Invoke-RestMethod -Uri $REFRESH_URL -Method Post -Headers $headers -Body '{}' `
                           -ContentType 'application/json' -TimeoutSec 30
    if ($r.data -and $r.data.accessToken -and $r.data.refreshToken) {
      return @{ ok = $true; token = [string]$r.data.accessToken; refreshToken = [string]$r.data.refreshToken;
                expiresIn = [int]$r.data.expiresIn; refreshExpiresIn = [int]$r.data.refreshExpiresIn }
    }
    return @{ ok = $false; msg = '响应里没有 accessToken / refreshToken' }
  } catch {
    $status = $null
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    $msg = $_.Exception.Message
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
        if ($j.msg) { $msg = 'code=' + $j.code + ' "' + $j.msg + '"' }
        elseif ($j.message) { $msg = 'code=' + $j.code + ' "' + $j.message + '"' }
      } catch {}
    }
    return @{ ok = $false; status = $status; msg = $msg }
  }
}

function Get-JwtClaims([string]$token) {
  try {
    $parts = ([string]$token).Split('.')
    if ($parts.Length -lt 2) { return $null }
    $b = $parts[1].Replace('-', '+').Replace('_', '/')
    while ($b.Length % 4) { $b += '=' }
    return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) | ConvertFrom-Json)
  } catch { return $null }
}

function Get-JwtExpMs([string]$token) {
  $c = Get-JwtClaims $token
  if ($c -and $c.exp) { return [long]$c.exp * 1000 }
  return $null
}

function New-ImportString([string]$refreshToken, [string]$token, [string]$uid, [string]$uin,
                          [string]$nickname, [string]$phone, [long]$tokenExpireAt, [long]$refreshTokenExpireAt) {
  $blob = [ordered]@{
    v     = 1
    rt    = $refreshToken
    uid   = $uid
    uin   = $uin
    nick  = $nickname
    phone = $phone
    at    = (Get-Date).ToString('s')
  }
  # ★把刚换到的 access token 一并带上：服务端首次使用就不必立刻再续期
  if ($token) { $blob.tk = $token }
  if ($tokenExpireAt -gt 0) { $blob.texp = $tokenExpireAt }
  # refreshToken 自身到期（约 30 天）：面板卡片按它显示"凭证"还剩多久
  if ($refreshTokenExpireAt -gt 0) { $blob.rexp = $refreshTokenExpireAt }
  $json = $blob | ConvertTo-Json -Compress
  $b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $b64  = $b64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
  return 'WB1.' + $b64
}

# 取服务端已有的 WorkBuddy 账号清单（供用户选「更新哪个 / 新建」）
function Get-WbTargets([string]$apiBase) {
  try {
    $r = Invoke-RestMethod -Uri ($apiBase.TrimEnd('/') + '/api/checkin/wb-targets') -Method Get -TimeoutSec 20
    if ($r -and $r.tasks) { return @($r.tasks) }
  } catch {}
  return @()
}

# 把导入串写回服务端（新增 or 更新由 taskId / uid 决定）
function Invoke-Push([string]$apiBase, [string]$importString, [string]$name, [string]$taskId) {
  $url = $apiBase.TrimEnd('/') + '/api/checkin/wb-import'
  $payload = @{ importString = $importString }
  if ($taskId) { $payload.taskId = $taskId }
  if ($name) { $payload.name = $name }
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
      } catch {}
    }
    return @{ ok = $false; msg = $msg }
  }
}

# ────────────────────────────────────────────────────────────────
#  在 WorkBuddy 主进程里跑的提取脚本（只读）
#  算法与 2026-10-18 逆向结论一致：
#    buildKey = SHA256(atRestSecretKey) → 解密 .info 里的 $wbEncrypted 字段
#    （AES-256-GCM；AAD = "WB-AAD\0" + [1] + lenpref(魔数) + lenpref("sym-v1")
#      + u32(suite) + lenpref(keyId) + [framing] + [0] + [0]，field 帧魔数 = WBEV1）
# ────────────────────────────────────────────────────────────────
$CDP_JS = @'
(async () => {
  try {
    const binding = process._linkedBinding('electron_browser_workbuddy_storage');
    const payload = JSON.parse(binding.loggerGet());
    if (!payload || !payload.atRestSecretKey) {
      return JSON.stringify({ ok: false, error: '桌面端未返回 atRestSecretKey（客户端版本可能变了）' });
    }
    const crypto = process.mainModule.require('crypto');
    const fs = process.mainModule.require('fs');
    const path = process.mainModule.require('path');
    const os = process.mainModule.require('os');
    const buildKey = crypto.createHash('sha256').update(String(payload.atRestSecretKey), 'utf8').digest();
    const keyId = crypto.createHash('sha256').update(buildKey).digest('hex').slice(0, 16);
    const encLen = (s) => { const b = Buffer.from(s, 'utf8'); const o = Buffer.alloc(4); o.writeUInt32BE(b.length); return Buffer.concat([o, b]); };
    const encU32 = (n) => { const o = Buffer.alloc(4); o.writeUInt32BE(n); return o; };
    const FRAME = { file: ['WBEF1', 1], field: ['WBEV1', 2], record: ['WBER1', 3], stream: ['WBES1', 4] };
    const aad = (kid, suite, framing) => Buffer.concat([
      Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
      encLen(FRAME[framing][0]), encLen('sym-v1'), encU32(suite), encLen(kid),
      Buffer.from([FRAME[framing][1]]), Buffer.from([0]), Buffer.from([0]),
    ]);
    const decEnv = (envB64) => {
      const env = JSON.parse(Buffer.from(envB64, 'base64').toString('utf8'));
      const d = crypto.createDecipheriv('aes-256-gcm', buildKey, Buffer.from(env.nonce, 'base64'));
      d.setAAD(aad(String(env.keyId), Number(env.suite) || 1, 'field'));
      d.setAuthTag(Buffer.from(env.authTag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
    };
    const decField = (node) => (node && typeof node === 'object' && node.$wbEncrypted && node.envelope) ? decEnv(node.envelope) : null;
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const infoPath = path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
    if (!fs.existsSync(infoPath)) {
      return JSON.stringify({ ok: false, error: '未找到桌面端登录态文件：' + infoPath + '。请先在 WorkBuddy 桌面端登录目标账号，再重跑本脚本。' });
    }
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const acc = info.account || {};
    const auth = info.auth || {};
    const rec = {
      uid: String(acc.uid || ''),
      uin: String(acc.uin || ''),
      nickname: '',
      phone: '',
      refreshToken: '',
      sessionState: String(auth.sessionState || ''),
    };
    try { rec.nickname = decField(acc.nickname) || ''; } catch (e) {}
    try { rec.phone = decField(acc.phoneNumber) || ''; } catch (e) {}
    try { rec.refreshToken = decField(auth.refreshToken) || ''; } catch (e) {}
    if (!rec.refreshToken) {
      return JSON.stringify({ ok: false, error: '解密成功但未取到 refreshToken（登录态可能不完整）。请在桌面端退出并重新登录该账号，再重跑本脚本。', keyId: keyId });
    }
    return JSON.stringify({ ok: true, keyId: keyId, account: rec });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
  }
})()
'@

# ------------------------------------------------------------------ 主流程
Write-Host ''
Write-Host '=== WorkBuddy 凭证提取（桌面端 refreshToken）===' -ForegroundColor Cyan
Write-Host '只读桌面端登录态文件（通过其主进程环境解密）；只会向 WorkBuddy 官方接口发一次续期测试请求。'
Write-Host '注意：提取期间脚本会临时重启 WorkBuddy 桌面端（结束后自动恢复原状）。'
Write-Host ''

$exe = Find-WorkBuddyExe
if (-not $exe) {
  Write-Host '没有找到 WorkBuddy 桌面端（WorkBuddy.exe）。' -ForegroundColor Red
  Write-Host '请先安装 WorkBuddy 桌面端并登录目标账号，然后重跑本脚本。' -ForegroundColor Yellow
  exit 1
}
Write-Host ('桌面端位置：{0}' -f $exe) -ForegroundColor DarkGray

$wasRunning = ((Get-WorkBuddyProcesses).Count -gt 0)
$launched = $false
$inspPort = $null
$result = $null

try {
  # ① 也许已经有现成的调试端口（用户自己开的），有就直接用
  $insp = Wait-Inspector $INSPECT_PORTS 0

  if (-not $insp) {
    # ② 需要自己拉一个带调试端口的实例。桌面端单实例锁：先在跑就先关掉。
    if ($wasRunning) {
      Write-Host ''
      Write-Host '检测到 WorkBuddy 正在运行，需要临时重启它（不会丢登录态，结束后自动恢复）。' -ForegroundColor Yellow
      $go = 'Y'
      if ($CanAsk) { $go = Ask-Text '现在关闭并重启 WorkBuddy？(Y/n)' 'Y' }
      if ($go -match '^[Nn]') {
        Write-Host '已取消。请手动退出 WorkBuddy（含托盘图标）后重跑本脚本。' -ForegroundColor DarkYellow
        exit 1
      }
      Stop-WorkBuddyProcesses
    }

    # 挑一个空闲端口再启动
    $port = $null
    foreach ($p in $INSPECT_PORTS) { if (-not (Test-PortBusy $p)) { $port = $p; break } }
    if (-not $port) {
      Write-Host '没有找到空闲的调试端口（9333-9338 都被占用）。' -ForegroundColor Red
      exit 1
    }
    Write-Host ('正在以调试模式启动 WorkBuddy（127.0.0.1:{0}）……' -f $port)
    Start-Process -FilePath $exe -ArgumentList ('--inspect={0}' -f $port) | Out-Null
    $launched = $true

    $insp = Wait-Inspector @($port) 45
    if (-not $insp) {
      Write-Host '启动后 45 秒内没有等到调试端口就绪。' -ForegroundColor Red
      Write-Host '可能原因：桌面端启动失败 / 版本不支持 --inspect / 被安全软件拦截。' -ForegroundColor Yellow
      exit 1
    }
  }

  $inspPort = [int]$insp.port
  $wsUrl = [string]$insp.target.webSocketDebuggerUrl
  Write-Host ('已连接桌面端主进程（端口 {0}），开始解密登录态……' -f $inspPort)

  $eval = Invoke-CdpEval $wsUrl $CDP_JS 60000
  if (-not $eval.ok) {
    Write-Host ('✗ 提取失败：{0}' -f $eval.error) -ForegroundColor Red
    exit 1
  }
  $result = $eval.value
  if (-not $result.ok) {
    Write-Host ('✗ 提取失败：{0}' -f $result.error) -ForegroundColor Red
    exit 1
  }

  $acc = $result.account
  Write-Host ''
  Write-Host ('✓ 已从桌面端解出登录态（密钥指纹 {0}，算法校验通过）' -f $result.keyId) -ForegroundColor Green
  Write-Host ('   昵称：{0}    手机：{1}' -f ($acc.nickname, $acc.phone)) -ForegroundColor White
  Write-Host ('   账号 uid：{0}    uin：{1}' -f ($acc.uid, $acc.uin))

  # uid 与 refreshToken 的 sub 应当一致（不一致说明文件被换过，属于异常）
  $rtClaims = Get-JwtClaims $acc.refreshToken
  if ($rtClaims -and $rtClaims.sub -and $acc.uid -and ([string]$rtClaims.sub -ne [string]$acc.uid)) {
    Write-Host ('⚠ 注意：refreshToken 的 sub（{0}）与文件记录的 uid 不一致，仍将以实际续期结果为准。' -f $rtClaims.sub) -ForegroundColor Yellow
  }

  # ③ 实测续期：这既是"验证账号可用"，也顺便换到全新的一对 token
  Write-Host ''
  Write-Host '正在用官方续期接口实测该凭证……'
  $ref = Invoke-WbRefresh $acc.refreshToken ([string]$acc.uid)
  if (-not $ref.ok) {
    Write-Host ('✗ 续期失败：{0}' -f $ref.msg) -ForegroundColor Red
    if ($ref.status -eq 401 -or $ref.status -eq 403) {
      Write-Host '   → 该凭证已失效。请在 WorkBuddy 桌面端退出并重新登录该账号，再重跑本脚本。' -ForegroundColor DarkYellow
    }
    exit 1
  }
  $expMs = Get-JwtExpMs $ref.token
  if (-not $expMs -and $ref.expiresIn -gt 0) { $expMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ($ref.expiresIn * 1000) }
  $rexpMs = Get-JwtExpMs $ref.refreshToken
  if (-not $rexpMs -and $ref.refreshExpiresIn -gt 0) { $rexpMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ($ref.refreshExpiresIn * 1000) }
  $expDays = '?'
  if ($expMs) { $expDays = [math]::Round((([DateTimeOffset]::FromUnixTimeMilliseconds($expMs)).LocalDateTime - (Get-Date)).TotalDays, 1) }
  Write-Host ('✓ 续期成功（新 access 有效 {0} 天；新 refreshToken 滚动 {1} 天）' -f $expDays, [math]::Round($ref.refreshExpiresIn / 86400.0, 0)) -ForegroundColor Green

  # ④ 组装导入串
  $import = New-ImportString $ref.refreshToken $ref.token ([string]$acc.uid) ([string]$acc.uin) `
            ([string]$acc.nickname) ([string]$acc.phone) ([long]$expMs) ([long]$rexpMs)

  Write-Host ''
  Write-Host '导入串（复制下面整行）：' -ForegroundColor Yellow
  Write-Host ('   ' + $import) -ForegroundColor Yellow

  # ── 写回服务端 ────────────────────────────────────────────────
  # 默认【不写回】：面板几乎总在 Cloudflare Access 之后，浏览器带着 Access 会话能过，
  # 而 PowerShell 脚本没有会话。所以导入统一走面板的「导入凭证」（由浏览器提交）。
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
    $targets = Get-WbTargets $ApiBase
    $suggest = 'WorkBuddy 成长签到'
    if ($acc.nickname) { $suggest = 'WorkBuddy 成长签到 · ' + $acc.nickname }
    elseif ($acc.phone) { $suggest = 'WorkBuddy 成长签到 · ' + $acc.phone }

    # ── 选目标：服务端已有账号时让用户明确选「更新哪一个 / 新建」──
    $taskId = $null
    $matchedIdx = 0
    if ($TaskArg) {
      $taskId = $TaskArg
    } elseif ($targets.Count -gt 0) {
      for ($i = 0; $i -lt $targets.Count; $i++) {
        $t = $targets[$i]
        if ($t.userId -and $acc.uid -and ([string]$t.userId -eq [string]$acc.uid)) { $matchedIdx = $i + 1 }
      }
      Write-Host ('  服务端已有 {0} 个 WorkBuddy 账号：' -f $targets.Count) -ForegroundColor Cyan
      for ($i = 0; $i -lt $targets.Count; $i++) {
        $t = $targets[$i]
        $modeTxt = '桌面端 refreshToken'
        if ($t.mode -eq 'cookie') { $modeTxt = 'Cookie' } elseif ($t.mode -eq 'bearer') { $modeTxt = 'Bearer' }
        $mark = ''
        if (($i + 1) -eq $matchedIdx) { $mark = '   ← 按 uid 自动识别为同一账号' }
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
      Write-Host '  服务端还没有 WorkBuddy 账号，将新建一个。' -ForegroundColor DarkGray
    }

    # 名称只在「新建」时才有意义；更新时服务端会保留原名
    $name = $null
    if (-not $taskId) {
      if ($NameArg) { $name = $NameArg }
      else { $name = Ask-Text '  新建账号名称' $suggest }
    }

    $p = Invoke-Push $ApiBase $import $name $taskId
    if ($p.ok) {
      if ($p.created) {
        Write-Host ('  ✓ 已新增账号：{0}' -f $p.name) -ForegroundColor Green
      } else {
        Write-Host ('  ✓ 已更新凭证：{0}（id {1}）' -f $p.name, $taskId) -ForegroundColor Green
        Write-Host '    只替换了凭证；账号名称 / 签到时间 / 时区 / 开关 / Cookie 全部保持原样。' -ForegroundColor DarkGray
      }
    } else {
      if ($p.accessDenied) {
        Write-Host '  ⚠ 自动写回失败：面板在 Cloudflare Access 之后，脚本没有浏览器登录态。' -ForegroundColor Yellow
        Write-Host '    这不影响凭证提取 —— 导入串已复制到剪贴板，' -ForegroundColor Yellow
        Write-Host '    打开签到面板 → 工具栏「导入凭证」→ 粘贴即可（浏览器里是已登录的）。' -ForegroundColor Yellow
      } else {
        Write-Host ('  ✗ 写入失败：{0}' -f $p.msg) -ForegroundColor Red
        Write-Host '    → 可回到签到面板手动粘贴该导入串。' -ForegroundColor DarkYellow
      }
    }
    Write-Host ''
    Write-Host '完成。打开签到面板即可看到（任务已进入调度）。' -ForegroundColor Cyan
  } else {
    try { Set-Clipboard -Value $import; Write-Host ''; Write-Host '导入串已复制到剪贴板。' -ForegroundColor Green } catch {}
    Write-Host ''
    Write-Host '下一步（导入由浏览器完成，这样才过得了 Cloudflare Access）：' -ForegroundColor Cyan
    Write-Host '  1) 打开签到面板 → 点工具栏「导入凭证」'
    Write-Host '  2) 在「导入串」框里 Ctrl+V（脚本已复制好）'
    Write-Host '  3) 选「写入到」哪个账号（会自动认出同一账号），点「导入」'
    Write-Host ''
    Write-Host '为什么脚本不自己写回：面板在 Cloudflare Access 之后，脚本没有浏览器登录态，' -ForegroundColor DarkGray
    Write-Host '直连会被拦在登录页。若你的部署没有 Access（纯内网/本机），可用 --push 直连。' -ForegroundColor DarkGray
  }
} finally {
  # ── 恢复桌面端原状 ──
  # 我们拉起来的调试实例必须关掉（不留调试端口）；原本在跑的恢复成正常启动。
  if ($launched) {
    Write-Host ''
    Write-Host '正在恢复 WorkBuddy 桌面端……' -ForegroundColor DarkGray
    Stop-WorkBuddyProcesses
    if ($wasRunning) {
      Start-Sleep -Milliseconds 500
      Start-Process -FilePath $exe | Out-Null
      Write-Host '已按原样重新启动桌面端。' -ForegroundColor DarkGray
    }
  }
}

exit 0
