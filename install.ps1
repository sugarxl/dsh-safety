<#
# dsh-safety install.ps1 — 安全安装：快照 → 复制 → 挂载 → pnpm → 校验 → 失败自动回滚
#
# 用法：
#   powershell -File install.ps1            # 干跑：只打印将要执行的步骤，不写任何文件
#   powershell -File install.ps1 -Apply     # 真正执行（先备份，失败自动回滚）
#
# 目标：把 dsh-safety 装进本机个人插件聚合包
#   profiles/web/plugins/dsh-personal-plugin/dsh-safety/
# 并按本机规则：行只插入聚合包 cordis.patch.yml 一次；依赖加到聚合包 package.json；
# 绝不写入 profile 的 cordis.patch.yml 或 dsh.profile.bundles。
#>
param(
  [switch]$Apply,
  [string]$Source = $PSScriptRoot,
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'
$dshHome = $env:USERPROFILE + '\.dsh'
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$aggDir = Join-Path $profileDir 'plugins\dsh-personal-plugin'
$aggPatch = Join-Path $aggDir 'cordis.patch.yml'
$aggPkg   = Join-Path $aggDir 'package.json'
$pluginName = 'dsh-safety'

function Fail($msg) { Write-Error $msg; exit 1 }

if (-not (Test-Path $aggDir)) { Fail "未找到聚合包目录: $aggDir" }
if (-not (Test-Path $aggPatch)) { Fail "未找到聚合包补丁: $aggPatch" }
if (-not (Test-Path $aggPkg)) { Fail "未找到聚合包 package.json: $aggPkg" }
if (-not (Test-Path (Join-Path $Source 'lib\index.js'))) { Fail "源码不完整（缺 lib\index.js）: $Source" }

# 目标文件
$dest = Join-Path $aggDir $pluginName
$backupRoot = Join-Path $dshHome ".dsh-safety\install-backups\$([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))"

$patchRow = @"
- insert:
    - id: $pluginName
      name: $pluginName
"@

Write-Host "===== dsh-safety 安装计划 ====="
Write-Host "源:        $Source"
Write-Host "目标:      $dest"
Write-Host "补丁文件:  $aggPatch  (追加一行 insert，幂等检查)"
Write-Host "依赖文件:  $aggPkg    (追加 `"$pluginName`": `"workspace:*`")"
Write-Host "备份目录:  $backupRoot"
Write-Host "校验:      dsh --profile $Profile --dump-config | findstr $pluginName"
Write-Host "=============================="

# ── 预检：是否已安装 / 是否重复 ──────────────────────────────
$patchText = Get-Content $aggPatch -Raw -Encoding UTF8
if ($patchText -match "id:\s*$pluginName\s*$") { Fail "聚合包补丁已有 $pluginName 行，已安装？请勿重复。可用 recover.ps1 处理" }
$aggJson = Get-Content $aggPkg -Raw -Encoding UTF8 | ConvertFrom-Json
if ($aggJson.dependencies.PSObject.Properties.Name -contains $pluginName) { Fail "聚合包依赖已含 $pluginName，已安装？" }
if (Test-Path $dest) { Fail "目标目录已存在: $dest（先备份它或删掉再装）" }

if (-not $Apply) {
  Write-Host "`n[DRY-RUN] 未带 -Apply，未写任何文件。确认无误后加 -Apply 执行。"
  exit 0
}

# ── 1) 备份（可回滚的恢复点）────────────────────────────────
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
Copy-Item $aggPatch (Join-Path $backupRoot 'cordis.patch.yml')
Copy-Item $aggPkg   (Join-Path $backupRoot 'package.json')
[System.IO.File]::WriteAllText((Join-Path $backupRoot 'MANIFEST.txt'), @"
installed=$pluginName
profile=$Profile
agg=$aggDir
at=$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))
"@, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "1) 已备份 -> $backupRoot"

try {
  # ── 2) 复制插件 ──────────────────────────────────────────────
  Copy-Item -Recurse $Source $dest -Exclude 'node_modules'
  Write-Host "2) 已复制 -> $dest"

  # ── 3) 聚合包补丁追加一行（幂等：先确认无重复）────────────
  $newPatch = ($patchText.TrimEnd("`r", "`n")) + "`n" + $patchRow + "`n"
  [System.IO.File]::WriteAllText($aggPatch, $newPatch, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "3) 聚合包补丁已追加 $pluginName 行"

  # ── 4) 聚合包依赖加 workspace:* ────────────────────────────
  $aggJson.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue 'workspace:*' -Force
  [System.IO.File]::WriteAllText($aggPkg, ($aggJson | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "4) 聚合包依赖已加 $pluginName"

  # ── 5) pnpm install ─────────────────────────────────────────
  Write-Host "5) pnpm install（profile 目录: $profileDir）..."
  Push-Location $profileDir
  pnpm install
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败 (exit $LASTEXITCODE)" }
  Pop-Location
  Write-Host "   pnpm install 完成"

  # ── 6) dump-config 校验 ────────────────────────────────────
  Write-Host "6) 校验: dsh --profile $Profile --dump-config ..."
  $dump = & dsh --profile $Profile --dump-config 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "dump-config 失败: $dump" }
  if ($dump -notmatch $pluginName) { throw "dump-config 未见 $pluginName 行，安装可能未生效" }
  Write-Host "   ✔ $pluginName 行已出现在组合树中"

  Write-Host "`n✅ 安装完成。请重启 dsh web 生效。"
  Write-Host "重启前可再跑一次: dsh --profile $Profile --dump-config 确认；或 safety_check（安装后插件自带）。"
  Write-Host "回滚入口: recover.ps1（或手动恢复 $backupRoot 的备份）。"
}
catch {
  Write-Host "`n❌ 安装失败，回滚中..."
  # 回滚：恢复备份文件，删除复制的目录，重新 pnpm install 清理依赖
  try {
    if (Test-Path (Join-Path $backupRoot 'cordis.patch.yml')) { Copy-Item -Force (Join-Path $backupRoot 'cordis.patch.yml') $aggPatch }
    if (Test-Path (Join-Path $backupRoot 'package.json'))    { Copy-Item -Force (Join-Path $backupRoot 'package.json') $aggPkg }
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Push-Location $profileDir
    pnpm install 2>&1 | Out-Null
    Pop-Location
    Write-Host "已回滚（聚合包补丁/依赖恢复，插件目录已删）。"
  } catch {
    Write-Host "回滚也失败了，请手动恢复: $backupRoot"
  }
  exit 1
}
