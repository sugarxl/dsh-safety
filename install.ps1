<#
# dsh-safety install.ps1 — 官方安装方式的"安全包装"：备份 → dsh plugin add → 校验 → 失败自动回滚
#
# 安装走官方机制（与 README 一致）：
#   dsh plugin --profile <name> add link:<绝对路径>
# dsh plugin 会在 profile 目录跑 pnpm，并把包加进 dsh.profile.bundles（reconcile）。
#
# 用法：
#   powershell -File install.ps1            # 干跑：只打印计划，不写任何文件
#   powershell -File install.ps1 -Apply     # 真正执行（先备份，失败自动回滚）
#
# 包会装到：$DSH_HOME/profiles/<Profile>/node_modules/dsh-safety/
# 组合行：  $DSH_HOME/profiles/<Profile>/package.json 的 dsh.profile.bundles
#>
param(
  [switch]$Apply,
  [string]$Source = $PSScriptRoot,
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$rowId = 'dsh-safety'                 # 组合行 id（不变）
$pkgName = '@suagr_xl/dsh-safety'      # npm 包名（reconcile / remove 用这个）
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { $env:USERPROFILE + '\.dsh' }
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$profilePkg = Join-Path $profileDir 'package.json'
$backupRoot = Join-Path $dshHome ".dsh-safety\install-backups\$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"
$absSource = (Resolve-Path $Source -ErrorAction SilentlyContinue).Path
if (-not $absSource -or -not (Test-Path (Join-Path $absSource 'lib\index.js'))) { Write-Error "源码不完整（缺 lib\index.js）: $Source"; exit 1 }
if (-not (Test-Path $profileDir)) { Write-Error "profile 目录不存在: $profileDir"; exit 1 }

Write-Host "===== dsh-safety 安装计划（官方机制）====="
Write-Host "源:        $absSource"
Write-Host "profile:   $Profile  ($profileDir)"
Write-Host "命令:      dsh plugin --profile $Profile add link:$absSource"
Write-Host "安装位置:  $profileDir\node_modules\@suagr_xl\dsh-safety\（scoped 包）"
Write-Host "组合层:    $profilePkg  (dsh.profile.bundles 自动 reconcile -> $pkgName)"
Write-Host "备份:      $backupRoot"
Write-Host "校验:      dsh --profile $Profile --dump-config | findstr $rowId"
Write-Host "=========================================="

if (-not $Apply) { Write-Host "`n[DRY-RUN] 未带 -Apply，未写任何文件。确认后加 -Apply 执行。"; exit 0 }

# 1) 备份 profile manifest
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
if (Test-Path $profilePkg) { Copy-Item $profilePkg (Join-Path $backupRoot 'package.json') }
Write-Host "1) 已备份 -> $backupRoot"

try {
  # 2) 官方安装
  Write-Host "2) 执行: dsh plugin --profile $Profile add link:$absSource ..."
  & dsh plugin --profile $Profile add "link:$absSource"
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败 (exit $LASTEXITCODE)" }
  Write-Host "   安装完成"

  # 3) 校验
  Write-Host "3) 校验: dsh --profile $Profile --dump-config ..."
  $dump = & dsh --profile $Profile --dump-config 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "dump-config 失败: $dump" }
  if ($dump -notmatch $rowId) { throw "dump-config 未见 $rowId 行" }
  Write-Host "   ✔ $rowId 行已出现在组合树中"

  Write-Host "`n✅ 安装完成。请重启 dsh web 生效。"
  Write-Host "回滚入口: recover.ps1（或手动 $backupRoot 的备份）"
}
catch {
  Write-Host "`n❌ 安装失败，回滚中..."
  try {
    & dsh plugin --profile $Profile remove $pkgName 2>&1 | Out-Null
    if (Test-Path (Join-Path $backupRoot 'package.json')) { Copy-Item -Force (Join-Path $backupRoot 'package.json') $profilePkg }
    Write-Host "已回滚（dsh plugin remove $pkgName + 恢复 profile package.json）。"
  } catch {
    Write-Host "回滚也失败了，请手动恢复: $backupRoot"
  }
  exit 1
}

