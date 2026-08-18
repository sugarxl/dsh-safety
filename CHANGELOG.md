# Changelog

本项目使用语义化版本（SemVer）。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Fixed（深度代码审查修复）

- **run_code 裸 fs 调用绕过**（真实绕过）：`import { rmSync/unlinkSync/rmdirSync } from 'node:fs'` 后的**裸调用**（无 `.` 前缀）先前完全漏检，现已识别并拦截（配保护标记/递归判定）。
- **`rm --recursive` 漏检**：补进递归删除识别。
- **快照失败残留**：`createSnapshot` 中途失败会清理半成品目录，不再留下无 manifest 的垃圾快照。
- **还原定位窗口**：`trashRestore` 查找 original 从"最近 5000 条日志"改为读全量，老删除也能精确还原到原路径。
- **CLI `--home` 参数解析**：修复值被吞进 positional 的问题；删除未使用的 `ok` 死代码。
- **安全中心 web API 加固**：POST 写操作（undo/restore/snapshot）要求 `X-DSH-Safety: 1` 头；面板请求加 15s 超时。
- 已知限制补：`run_code` import 别名/动态构造仍可能绕过、相对路径按进程 cwd 解析、web API 护栏是轻量的。

### Changed（架构加固）

- **策略单一来源**：`buildPolicy` 从插件迁到 `safety-core.mjs`，插件守卫与独立 CLI 共用同一份策略，杜绝两套表面漂移。
- **guard 覆盖 `run_code`**：任意代码执行体的代码文本同样走破坏性扫描（`fs.rmSync`/`shutil.rmtree`/`require('fs').rmSync` + 保护标记），堵住"绕工具边界删文件"的洞。
- **shell 变量引用删除可拦**：`Remove-Item "$env:USERPROFILE\.dsh\…"`、`%APPDATA%\npm\…`、`${HOME}/…` 这类展开后才是真实路径的命令，通过引用+尾段与保护标记比对后拒绝。
- **`restoreSnapshot` 事务化**：先备份现行文件、再从快照复制回，任一阶段失败整体回滚；备份按相对路径存放，修复同名文件互相覆盖的缺陷（曾导致回滚留下孤儿备份）。
- `prepublishOnly` / `pack` 脚本；README 补 `run_code`/变量引用/事务化恢复说明。
- 测试：19 个零依赖单测（新增 buildPolicy 共用、变量引用、run_code 扫描、事务化恢复）。

## [0.1.0] - 2026-08-18

### Added（首个开源版本）

- **执行前守卫**（`ctx.tools.guard`）：
  - 递归目录删除在**任意路径**一律拒绝（`rm -r/-rf`、`Remove-Item -Recurse`、`rd /s`、`rmdir`、`shutil.rmtree`、`fs.rm recursive`），强制走 `safe_delete`。
  - `write`/`edit`/`str_replace_editor` 写 protected 区（profile manifest/补丁/lockfile/`node_modules`、部署安装目录、home 补丁与设置）→ 拒绝。
  - 删除命中 confirm 区（`$HOME` 整区、插件源码、agent-preset）→ 拒绝并引导 `safe_delete`。
- **`safe_delete`**：回收站式删除（`safety_undo` 可还原）、`preview:true` 先预览、拒绝文件系统根与自身状态目录、删除全留审计。
- **组合快照/回滚**：`safety_snapshot`（SHA-256 清单，默认排除 `settings.yaml`/`.credentials.yaml`）+ `safety_restore`（`confirm:true`，现行文件先备份）。
- **重启前体检** `safety_check`：UTF-8 / 乱码检测 / JSON / 跨层重复插件行 id。
- **审计与面板**：`safety_journal` / `safety_status` / 浏览器「安全中心」设置分区。
- **独立 CLI** `bin/dsh-safety.mjs`（零依赖）：status / delete / trash / undo / snapshot / restore / check / journal / policy。
- **fail-soft apply**：插件注册失败只降级记日志，绝不让 DSH 启动失败。
- 工具：`install.ps1`（快照→安装→校验→回滚）、`recover.ps1`（启动失败急救）。
- 文档：中英双语 README（`README.i18n.yaml` 配对）、SECURITY、CONTRIBUTING。
- 测试：14 个零依赖单测 + 38 项集成检查；GitHub Actions CI（Node 22/24）。
