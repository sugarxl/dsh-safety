# 常见问题（FAQ）

## 会不会让我的 DSH 打不开？

不会。插件采用 **fail-soft** 设计：注册/加载任一环节出错时仅降级记日志，不影响 DSH 启动。

## 它是不是和 DSH 自带的沙箱/审批重复？

部分重复，但不完全。DSH 自带 `dsh-sandbox-policy`（工作区外要审批）+ `dsh-user-approval`（确认门）——**在配置正确的前提下，那才是第一道、也是更强的一道防线**。但现实里沙箱常常是宽开的（曾实测：一条 `Remove-Item -Recurse -Force` 没有任何内置机制拦住）。本插件补的是：
- dsh 没有的**恢复层**：回收站/undo、组合快照/回滚、删除审计、重启前体检；
- 宽开沙箱下的**兜底拦截**。

最佳实践：**先把 DSH 沙箱/审批配好，再用本插件做恢复层**。

## 如何删除受保护路径上的文件？

用 `safe_delete`（或 CLI `dsh-safety delete`）加 `force:true`/`--force`。该操作仍只进回收站、永不真正删除，可随时 `undo`。

## 为什么递归删除在任何路径都无条件拒绝？

目录递归删除（`rm -rf`、`Remove-Item -Recurse`）的破坏半径最大、意图最难判断，且正是那次真实事故的直接手法。策略为默认拒绝、显式放行——需要删除时走 `safe_delete` 进回收站（可撤销）。

## DSH 打不开了，我还能用这个吗？

能。CLI（`dsh-safety`）完全不依赖 DSH，直接读写 `$DSH_HOME/.dsh-safety` 状态：
```bash
dsh-safety check                      # 找乱码/JSON/重复 id / find mojibake/JSON/duplicate ids
dsh-safety status                     # 看可用快照 / list available snapshots
dsh-safety restore <id> --confirm     # 回滚 / roll back
```

## 模型用 `run_code` 执行任意代码，会不会绕过？

guard 会**扫描 `run_code` 的代码体文本**（`fs.rmSync`/`shutil.rmtree`/`require('fs').rmSync` + 保护标记），直白写法会被拦。但文本扫描挡不住动态拼接/混淆——这是根本边界：**`run_code` 是任意代码执行，真正隔离它的只有 DSH 沙箱**，插件只是增加一层难度。

## 会不会吃满我的磁盘？

不会。回收站和快照都有保留上限（`keepTrash` 默认 200、`keepSnapshots` 默认 10），每次删除/快照会自动裁剪。

## 我有多个 profile，能用吗？

能。`buildPolicy` 自动扫描 `$DSH_HOME/profiles/*` 下全部 profile，不需要逐个配置。

## 我在用 OCL（deepseek-harness 的 fork），能用吗？

本插件面向 DSH（`$DSH_HOME`、`@deepseek-ai/*`）。OCL 用的是 `OCL_HOME` 和 `@ocl/*`，需要一个小适配层（`homeIsConfirm` 等配置已预留）。社区版暂未内置 OCL 适配。

## 它和 `dsh plugin` 安装流程冲突吗？

不冲突——本插件**只走官方流程**：`dsh plugin --profile <name> add <包名>`（或本地 `link:`）。包会被自动 reconcile 进该 profile 的 `dsh.profile.bundles`，装进 `$DSH_HOME/profiles/<name>/node_modules/`，不需要任何手工配置，也没有"个人聚合包"这种额外约定。

## 快照里会不会存到我的密钥？

不会。`settings.yaml`、`.credentials.yaml` 默认被排除（`snapshotExclude` 可配置）。但请勿把 `$DSH_HOME/.dsh-safety/` 目录本身推上任何公开仓库。
