<#
# dsh-safety recover.ps1 — 启动失败急救（官方 profile 级）
#
# 场景：dsh web 打不开（例如装了某个坏插件 / 补丁层损坏）。
#
# 救法（全部基于官方机制，改的是 profile 的 dsh.profile.bundles，不碰聚合包）：
#   1) -RestorePoint <备份目录>   从 install.ps1 的备份恢复 profile package.json
#   2) -DropPlugin <名字>         用官方命令摘掉指定插件：dsh plugin --profile web remove <名字>
#   3) -DisableAll                临时禁掉所有非官方 bundle（只保留 @deepseek-ai/dsh-base
#                                 + @deepseek-ai/dsh-web-app），救活 GUI 再排查
#
# 任何操作都会先备份、打印改动内容。不带参数 = 只读诊断。
#
# 用法：
#   powershell -File recover.ps1                 # 只读诊断
#   powershell -File recover.ps1 -RestorePoint <dir> [-Apply]
#   powershell -File recover.ps1 -DropPlugin dsh-safety [-Apply]
#   powershell -File recover.ps1 -DisableAll [-Apply]
#>
param(
  [string]$RestorePoint,
  [string]$DropPlugin,
  [switch]$DisableAll,
  [switch]$Apply,
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { $env:USERPROFILE + '\.dsh' }
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$profilePkg = Join-Path $profileDir 'package.json'
$backupsRoot = Join-Path $dshHome '.dsh-safety\install-backups'

function Fail($msg) { Write-Error $msg; exit 1 }
if (-not (Test-Path $profileDir)) { Fail "profile 目录不存在: $profileDir" }

# ── 只读诊断 ───────────────────────────────────────────────
Write-Host "===== 诊断（profile: $Profile）====="
if (Test-Path $backupsRoot) {
  $baks = Get-ChildItem $backupsRoot -Directory | Sort-Object Name -Descending
  Write-Host "install.ps1 备份点 ($($baks.Count) 个):"
  $baks | ForEach-Object { "   $($_.Name)" }
} else { Write-Host "无 install.ps1 备份点" }

if (Test-Path $profilePkg) {
  $json = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "当前 bundles: $($json.dsh.profile.bundles -join ', ')"
} else { Fail "profile package.json 不存在: $profilePkg" }

if (-not ($RestorePoint -or $DropPlugin -or $DisableAll)) {
  Write-Host "`n只读诊断完成。要实际救活请带 -Apply 使用某一种救法。"
  exit 0
}

# 改动前先备份
$backup = Join-Path (Join-Path $dshHome '.dsh-safety\recover-backups') ([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item $profilePkg (Join-Path $backup 'profile-package.json')
Write-Host "已备份 -> $backup"

if (-not $Apply) { Write-Host "[DRY-RUN] 未带 -Apply，未改动。确认后加 -Apply。"; exit 0 }

# ── 救法 1：从 install.ps1 备份恢复 profile manifest ───────
if ($RestorePoint) {
  if (-not (Test-Path (Join-Path $RestorePoint 'package.json'))) { Fail "恢复点缺少 package.json: $RestorePoint" }
  Copy-Item -Force (Join-Path $RestorePoint 'package.json') $profilePkg
  Write-Host "✔ 已从 $RestorePoint 恢复 profile package.json"
}

# ── 救法 2：官方命令摘掉指定插件 ──────────────────────────
if ($DropPlugin) {
  Write-Host "✔ 执行: dsh plugin --profile $Profile remove $DropPlugin"
  & dsh plugin --profile $Profile remove $DropPlugin 2>&1 | Out-Null
  Write-Host "  完成（同步了依赖与 bundles）"
}

# ── 救法 3：临时禁掉所有非官方 bundle ─────────────────────
if ($DisableAll) {
  $json = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
  $official = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app')
  $bundles = @($json.dsh.profile.bundles | Where-Object { $_ -in $official })
  $json.dsh.profile.bundles = $bundles
  [System.IO.File]::WriteAllText($profilePkg, ($json | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "✔ 已把 dsh.profile.bundles 收窄为官方 bundle: $($bundles -join ', ')"
}

# ── 收尾：pnpm 同步 + 验证 ─────────────────────────────────
Push-Location $profileDir
pnpm install 2>&1 | Out-Null
Pop-Location
$dump = & dsh --profile $Profile --dump-config 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) {
  Write-Host "✔ dump-config 通过 —— 组合可解析，重启 dsh web 即可验证 GUI。"
} else {
  Write-Host "⚠ dump-config 仍失败，试试:"
  Write-Host "    dsh --profile $Profile --dump-default-config   （跳过用户层，看官方 bundle 层）"
  Write-Host "恢复入口: $backup"
  exit 1
}
Write-Host "恢复入口（需要时手动还原）: $backup"
