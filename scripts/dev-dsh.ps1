#Requires -Version 5.1
<#
.SYNOPSIS
  源码开发：本地编译并启动 dsh-qqbot（在 QQ 里和 agent 对话）。

.DESCRIPTION
  规避两个已经踩过的坑：

  1. node < 22.18 会让 dsh CLI 静默退出（入口用 import.meta.main 自执行，
     老版本 node 下该值为 undefined，于是什么都不打印、退出码 0）。
     脚本会自己挑一个 >= 22.18 的 node，优先用 DeepSeek Harness 桌面版
     内置的 node（resources/runtime/node/node.exe）。

  2. package.json 的 main 指向 dist/，改完 src/ 必须重新编译才生效；
     用 -Build 在启动前跑一次 pnpm build（tsc -> dist/，tsdown -> lib/client.js）。

.PARAMETER Build
  启动前执行 pnpm build。

.PARAMETER Bind
  首次绑定用：额外设置 QQBOT_BIND_OPEN_BROWSER=1，拉起浏览器扫码页
  （终端二维码错位时的降级通道）。扫码成功后凭据自动写入
  ~/.dsh/profiles/<Profile>/cordis.patch.yml，之后无需再扫。

.PARAMETER Profile
  dsh profile 名，默认 qqbot（由 `dsh plugin --profile qqbot add link:<repo>` 创建）。

.PARAMETER AppId
  可选：临时指定 AppID（等价于 QQBOT_APPID 环境变量）。

.PARAMETER AppSecret
  可选：临时指定 AppSecret（等价于 QQBOT_SECRET 环境变量）。

.EXAMPLE
  # 首次：编译 + 启动 + 打开浏览器扫码页
  powershell -ExecutionPolicy Bypass -File scripts\dev-dsh.ps1 -Build -Bind

.EXAMPLE
  # 日常：改完源码重新编译并重启
  powershell -ExecutionPolicy Bypass -File scripts\dev-dsh.ps1 -Build

.NOTES
  本文件必须保存为 UTF-8 with BOM：Windows PowerShell 5.1 会把无 BOM 的
  脚本按 ANSI 解码，中文串被截断后直接抛语法错误。
#>
param(
  [switch]$Build,
  [switch]$Bind,
  [string]$Profile = 'qqbot',
  [string]$AppId,
  [string]$AppSecret
)

$ErrorActionPreference = 'Stop'
$MinNodeVersion = [version]'22.18.0'
$repo = Split-Path -Parent $PSScriptRoot

# ── 1. 找一个够新的 node ──────────────────────────────────────────────
function Get-NodeVersion([string]$exe) {
  try {
    $raw = & $exe -v 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    return [version]($raw.Trim().TrimStart('v'))
  } catch { return $null }
}

# 桌面版安装根目录候选。运行时布局随版本变过两套，两套都探测：
#   0.2.x（当前）: resources\runtime\primary-runtime\dependencies\node\bin\node.exe
#   0.1.x（旧）  : resources\runtime\node\node.exe
function Find-DesktopRoots {
  $roots = New-Object System.Collections.Generic.List[string]

  $appExe = (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Select-Object -First 1).Path
  if ($appExe) { $roots.Add((Split-Path -Parent $appExe)) }

  if ($env:LOCALAPPDATA) { $roots.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')) }
  foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($pf) { $roots.Add((Join-Path $pf 'DeepSeek Harness')) }
  }
  # 装在非系统盘（如 D:\Program Files）时靠盘符枚举兜底
  foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    $roots.Add((Join-Path $drive.Root 'Program Files\DeepSeek Harness'))
  }

  return ($roots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)
}

function Find-Node {
  $candidates = New-Object System.Collections.Generic.List[string]

  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { $candidates.Add($onPath.Source) }

  foreach ($root in (Find-DesktopRoots)) {
    $candidates.Add((Join-Path $root 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'))
    $candidates.Add((Join-Path $root 'resources\runtime\node\node.exe'))
    # 最后一招：Electron 本体 + ELECTRON_RUN_AS_NODE=1 即一个 node
    $candidates.Add((Join-Path $root 'DeepSeek Harness.exe'))
  }

  foreach ($exe in $candidates) {
    if (-not (Test-Path $exe)) { continue }
    $electron = (Split-Path -Leaf $exe) -eq 'DeepSeek Harness.exe'
    if ($electron) { $env:ELECTRON_RUN_AS_NODE = '1' }
    try { $version = Get-NodeVersion $exe }
    finally { if ($electron) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } }
    if ($version -and $version -ge $MinNodeVersion) {
      return @{ Exe = $exe; Version = $version; Electron = $electron }
    }
  }
  return $null
}

$node = Find-Node
if (-not $node) {
  Write-Error ("找不到 >= $MinNodeVersion 的 node。请安装 Node 22.18+，或安装/启动 DeepSeek Harness 桌面版以复用其内置运行时。")
  exit 1
}

# 让 npx/pnpm 也跑在这个 node 上（Electron 运行时需要 RUN_AS_NODE 标记）
$env:Path = (Split-Path -Parent $node.Exe) + ';' + $env:Path
if ($node.Electron) { $env:ELECTRON_RUN_AS_NODE = '1' }
$nodeLabel = "$($node.Version)  $($node.Exe)"
if ($node.Electron) { $nodeLabel = $nodeLabel + '  [Electron RUN_AS_NODE]' }
Write-Host "node  $nodeLabel" -ForegroundColor DarkGray

# ── 2. 定位 dsh CLI（优先用 npx 缓存里的，省去每次解析包） ─────────────
function Find-DshBin {
  $caches = @(
    (Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'),
    'D:\Program Files\nodejs\node_cache\_npx'
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($cache in $caches) {
    $hit = Get-ChildItem $cache -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  return $null
}

$dshBin = Find-DshBin
if (-not $dshBin) {
  Write-Host '未找到已缓存的 dsh CLI，改用 npx 拉取…' -ForegroundColor DarkGray
  $dshArgs = @('--yes', '@deepseek-ai/dsh@latest')
} else {
  Write-Host "dsh   $dshBin" -ForegroundColor DarkGray
  $dshArgs = @($dshBin)
}

# ── 3. 编译 ───────────────────────────────────────────────────────────
if ($Build) {
  $pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $pnpm) {
    Write-Error '找不到 pnpm.cmd。请先安装 pnpm，或手动在仓库根执行 pnpm build。'
    exit 1
  }
  Write-Host "`n编译中: pnpm build ($repo)" -ForegroundColor Cyan
  Push-Location $repo
  # 原生命令写 stderr 时（tsc/tsdown 的进度行）PS5.1 会当成错误，临时放宽
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $pnpm build; if ($LASTEXITCODE -ne 0) { Write-Error '构建失败'; exit 1 } }
  finally { $ErrorActionPreference = $eap; Pop-Location }
} elseif (-not (Test-Path (Join-Path $repo 'dist\index.js'))) {
  Write-Warning 'dist/ 不存在，插件无法加载。请加 -Build 或先执行 pnpm build。'
}

# ── 4. 环境变量 ───────────────────────────────────────────────────────
if ($AppId) { $env:QQBOT_APPID = $AppId }
if ($AppSecret) { $env:QQBOT_SECRET = $AppSecret }
if ($Bind) { $env:QQBOT_BIND_OPEN_BROWSER = '1' }

$hasCreds = ($env:QQBOT_APPID -and $env:QQBOT_SECRET)
Write-Host ("凭据: " + $(if ($hasCreds) { "已通过环境变量提供 ($env:QQBOT_APPID)" } else { '未提供 → 启动后走扫码绑定' })) -ForegroundColor DarkGray
Write-Host "启动: dsh --profile $Profile`n" -ForegroundColor DarkGray

# ── 5. 启动 ───────────────────────────────────────────────────────────
# dsh 的日志走 stderr；EAP=Stop 下 PS5.1 会把它当致命错误并中断前台进程
$ErrorActionPreference = 'Continue'
if ($dshBin) {
  & $node.Exe $dshBin --profile $Profile @args
} else {
  & npx.cmd @dshArgs --profile $Profile @args
}
exit $LASTEXITCODE
