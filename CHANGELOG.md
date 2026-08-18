# Changelog

本项目使用语义化版本（SemVer）。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
