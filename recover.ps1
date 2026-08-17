<#
# dsh-safety recover.ps1 — 启动失败急救
#
# 场景：dsh web 打不开（例如装了某个坏插件 / 补丁层损坏）。
#
# 三种救法（按优先级）：
#   1) -RestorePoint <备份目录>   从 install.ps1 留下的备份恢复聚合包（最快，若事故刚发生）
#   2) -DropPlugin <名字>         从聚合包临时摘掉指定插件（改 2 处 + pnpm），救活 GUI 再排查
#   3) -DisableAll                临时禁用整个 dsh-personal-plugin 聚合包 bundle
#                                  （把 profiles/web/package.json 的 dsh.profile.bundles 里的
#                                    dsh-personal-plugin 摘掉 + 备份），只保留官方 bundle
#
# 任何操作都先备份、都会打印将要改动的内容。不带参数 = 只读诊断。
#
# 用法：
#   powershell -File recover.ps1                 # 只读诊断（列出备份/快照/当前 bundles）
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
$dshHome = $env:USERPROFILE + '\.dsh'
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$profilePkg = Join-Path $profileDir 'package.json'
$aggDir = Join-Path $profileDir 'plugins\dsh-personal-plugin'
$aggPatch = Join-Path $aggDir 'cordis.patch.yml'
$aggPkg   = Join-Path $aggDir 'package.json'
$backupsRoot = Join-Path $dshHome '.dsh-safety\install-backups'

function Fail($msg) { Write-Error $msg; exit 1 }
if (-not (Test-Path $profileDir)) { Fail "profile 目录不存在: $profileDir" }

# ── 只读诊断 ───────────────────────────────────────────────
Write-Host "===== 诊断 ====="
if (Test-Path $backupsRoot) {
  $baks = Get-ChildItem $backupsRoot -Directory | Sort-Object Name -Descending
  Write-Host "install.ps1 备份点 ($($baks.Count) 个):"
  $baks | ForEach-Object { "   $($_.Name)  ($((Get-Date $_.Name.Substring(0,15) -ErrorAction SilentlyContinue)))" }
} else { Write-Host "无 install.ps1 备份点" }

if (Test-Path $profilePkg) {
  $json = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "当前 bundles: $($json.dsh.profile.bundles -join ', ')"
}

if (Test-Path $aggPatch) {
  Write-Host "聚合包补丁行:"
  (Get-Content $aggPatch -Encoding UTF8 | Select-String '^\s*-\s*id:' | ForEach-Object { "   " + $_.Line.Trim() })
}

if (-not ($RestorePoint -or $DropPlugin -or $DisableAll)) {
  Write-Host "`n只读诊断完成。要实际救活请带 -Apply 使用某一种救法。"
  exit 0
}

# 任何改动先备份
$backup = Join-Path (Join-Path $dshHome '.dsh-safety\recover-backups') ([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
if (Test-Path $profilePkg) { Copy-Item $profilePkg (Join-Path $backup 'profile-package.json') }
if (Test-Path $aggPkg)     { Copy-Item $aggPkg     (Join-Path $backup 'agg-package.json') }
if (Test-Path $aggPatch)   { Copy-Item $aggPatch   (Join-Path $backup 'agg-cordis.patch.yml') }
Write-Host "已备份 -> $backup"

if (-not $Apply) {
  Write-Host "[DRY-RUN] 未带 -Apply，未改动。确认后加 -Apply。"
  exit 0
}

# ── 救法 1：从 install.ps1 恢复点还原聚合包 ────────────────
if ($RestorePoint) {
  if (-not (Test-Path $RestorePoint)) { Fail "恢复点不存在: $RestorePoint" }
  Copy-Item -Force (Join-Path $RestorePoint 'cordis.patch.yml') $aggPatch
  Copy-Item -Force (Join-Path $RestorePoint 'package.json') $aggPkg
  Write-Host "✔ 已从 $RestorePoint 恢复聚合包补丁与依赖"
}

# ── 救法 2：从聚合包摘掉指定插件 ───────────────────────────
if ($DropPlugin) {
  $patchText = Get-Content $aggPatch -Raw -Encoding UTF8
  $lines = $patchText -split "`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($ln in $lines) {
    if ($ln -match "^\s*- insert:\s*$") { $skip = $false }
    if ($ln -match "id:\s*$DropPlugin\s*$") { $skip = $true; continue }
    if ($skip) { continue }
    $out.Add($ln)
  }
  [System.IO.File]::WriteAllText($aggPatch, ($out -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "✔ 聚合包补丁已摘除 $DropPlugin 行"

  if (Test-Path $aggPkg) {
    $json = Get-Content $aggPkg -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($json.dependencies.PSObject.Properties.Name -contains $DropPlugin) {
      $json.dependencies.PSObject.Properties.Remove($DropPlugin)
      [System.IO.File]::WriteAllText($aggPkg, ($json | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "✔ 聚合包依赖已移除 $DropPlugin"
    }
  }
}

# ── 救法 3：临时禁用整个聚合包 bundle ──────────────────────
if ($DisableAll) {
  if (-not (Test-Path $profilePkg)) { Fail "profile package.json 不存在: $profilePkg" }
  $json = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
  $bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-personal-plugin' })
  $json.dsh.profile.bundles = $bundles
  [System.IO.File]::WriteAllText($profilePkg, ($json | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "✔ 已从 dsh.profile.bundles 摘掉 dsh-personal-plugin（其余 bundle 保留）"
}

# ── 收尾：pnpm 同步 + 验证 ─────────────────────────────────
Push-Location $profileDir
pnpm install 2>&1 | Out-Null
Pop-Location
Write-Host "✔ pnpm install 已同步"
$dump = & dsh --profile $Profile --dump-config 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) {
  Write-Host "✔ dump-config 通过 —— 组合可解析，重启 dsh web 即可验证 GUI。"
} else {
  Write-Host "⚠ dump-config 仍失败（$Profile 的用户层可能还有其它问题）。试试:"
  Write-Host "    dsh --profile $Profile --dump-default-config   （只看官方 bundle 层，跳过用户层）"
  Write-Host "  恢复入口: $backup"
  exit 1
}
Write-Host "恢复入口（需要时手动还原）: $backup"
