# 常见问题（FAQ）

## 会不会让我的 DSH 打不开？

不会。插件采用 **fail-soft** 设计：注册/加载任一环节出错时仅降级记日志，不影响 DSH 启动。

## 它是不是和 DSH 自带的沙箱/审批重复？

部分重复，但不完全。DSH 自带 `dsh-sandbox-policy`（工作区外要审批）+ `dsh-user-approval`（确认门）——**在配置正确的前提下，那才是第一道、也是更强的一道防线**。但现实里沙箱常常是宽开的（曾实测：一条 `Remove-Item -Recurse -Force` 没有任何内置机制拦住）。本插件补的是：
- dsh 没有的**恢复层**：回收站/undo、组合快照/回滚、删除审计、重启前体检；
- **问人层**：重要的删改必须先经过用户审批（`safety_ask` → `dsh-safety allow`）；
- 宽开沙箱下的**兜底拦截**。

最佳实践：**先把 DSH 沙箱/审批配好，再用本插件做恢复层与问人层**。

## 模型想删除/改写重要文件时，正确流程是什么？

1. 模型调用被守卫**拦截**，收到教育式拒绝（是什么/为什么/后果/正路）；
2. 模型调用 **`safety_ask`**，附上因果（what / why / consequence / alternative），得到 request id；
3. 模型把 id 告诉**你**；
4. 你执行 **`dsh-safety allow <id>`**（或直接 `dsh-safety delete <path> --force`）；
5. 模型重试原调用 → 守卫放行一次（该审批即被消费）。

## 为什么 `force:true` 不够了？

因为模型能自己传 `force:true`——**模型可自设的标志不是用户确认**，那等于没有确认门。所以现在 `safe_delete` 的 `force:true` 只是标记，删除 confirm/protected 目标前必须存在**已由用户批准**的审批请求。CLI 侧的 `dsh-safety delete --force` 是例外：CLI 用户就是人类本人，`--force` 即真实审批。

## 如何删除受保护路径上的文件？

**CLI 侧**（你是人类）：
```bash
dsh-safety delete <path> --force    # 先授予所需审批，再移入回收站（可撤销）
```
**模型侧**：让模型先 `safety_ask` 创建请求，你再 `dsh-safety allow <id>`。无论哪种方式，删除**只进回收站、永不真正删除**，可随时 `undo`。

## 模型被拦之后一直"换别的办法"重试，怎么办？

这正是守卫要阻止的行为：systemPrompt 已明确"被拦就停、不许换工具/换路径/编码绕过"，且同一目标反复被拦会升级为 STOP 警告。如果模型仍在纠缠，直接回复它：**调用 `safety_ask` 说明因果并等待批准，或放弃该操作**。

## 为什么递归删除默认在任何路径都无条件拒绝？

目录递归删除（`rm -rf`、`Remove-Item -Recurse`）的破坏半径最大、意图最难判断，且正是那次真实事故的直接手法。策略为默认拒绝、显式放行——需要删除时走 `safe_delete` 进回收站（可撤销）。`mode: cooperative` 下人类可授予一次性通用递归审批放行自由路径的递归删除（`dsh-safety allow --path … --recursive`）。

## `strict` 和 `cooperative` 有什么区别？

- `strict`（默认）：递归 shell 删除**永不可批准**，目录树删除唯一通道是 `safe_delete`（回收站、可撤销）——最安全；
- `cooperative`：人类可授予一次性审批放行自由路径的递归 shell 删除——更灵活，但**删除是永久的、不进回收站**，只在你明确信任该操作时使用。

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

## 之前设置里的「安全中心」面板哪去了？

按用户要求已移除（连同其 `/safety/api` 路由与浏览器半区 `lib/client.js`）。管理/审批/审计全部走模型侧工具与独立 CLI（`safety_ask`、`dsh-safety allow/approvals/revoke`、`safety_journal`/`safety_status`），功能不受影响。

## 模型会不会在 `safety_ask` 里撒谎（把危险操作说成无害）？

会——`what`/`why`/`consequence`/`alternative` 四个字段由模型单方填写，**系统无法核验其真实性**。为此每个审批请求额外携带**系统按真实路径分类计算的后果**（`systemNote`）：`dsh-safety approvals` 把 `[system]` 判定与 `(model: …)` 自述分开显示，批准时以系统判定为准。但这只解决"信息呈现"——如果你不看就批（橡皮图章），任何提示都拦不住；所以请至少在批准前扫一眼 `[system]` 那栏。
