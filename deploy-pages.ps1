# 部署 Cloudflare Pages 脚本
# 清除代理环境变量，避免 wrangler 通过代理发送请求

# 清除所有代理环境变量
$env:HTTP_PROXY = $null
$env:HTTPS_PROXY = $null
$env:http_proxy = $null
$env:https_proxy = $null
$env:ALL_PROXY = $null
$env:all_proxy = $null
$env:NO_PROXY = $null
$env:no_proxy = $null

# 使用权限最大的 token
$env:CLOUDFLARE_API_TOKEN = 'cfut_22Wpsd918WZHE3fpgBDcpPHUjm7rb1RFMVF8uep5870f091b'

# 启用 debug 日志，确保 wrangler 正确检测 _worker.js 并编译 Worker bundle
# （不启用 debug 日志时，wrangler 可能上传缓存的旧文件导致 uses_functions=false）
$env:WRANGLER_LOG = 'debug'

# 切换到前端目录
Set-Location 'd:\Code\Project\SSH\Honor 10\monitor\frontend'

# 部署到 production 分支
# 注意：不能使用 --no-bundle，否则 wrangler 4.x 不会编译 _worker.js，导致 uses_functions=false
# uses_functions=false 时所有 /api/* 请求不会被代理到后端，直接返回 404
Write-Host "开始部署到 Cloudflare Pages (production 分支)..."
npx wrangler pages deploy . --project-name=honor10-monitor --branch=production --commit-dirty=true --skip-caching
