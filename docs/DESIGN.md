# 设计说明（Design）

## 它解决什么问题

DeepSeek Harness（DSH）把"一切皆插件"推到极致，代价是**缺少护栏**：

1. 模型/脚本可以在没有明确指令的情况下删除或改写关键文件（无回收站、无撤销）。
2. 插件开发直接发生在生产 profile 里，一个坏补丁/坏编码就能让 DSH 打不开，且没有 last-known-good 自动恢复。
3. 安装/卸载非事务，失败后没有回滚通道。

一次真实事故（脚本因 PowerShell `$HOME` 只读变量静默解析错路径，`Remove-Item -Recurse -Force` 删掉整个引擎运行根）证明这些并非理论风险。dsh-safety 将这次事故的教训实现为强制机制，而非文档说明。

**更深一层的问题（本插件的转向）**：单纯"拒绝"会逼模型对抗——模型是目标驱动的，黑盒拒绝只会让它不断换姿势重试（`Remove-Item` 不行就 `rd /s`，shell 不行就 `run_code`）。所以正确的形态不是"执法"，而是 **"教育 + 门禁 + 恢复"**：

- **教育**：被拦时讲清因果（是什么/为什么/后果/正路），systemPrompt 植入"不乱删、先问人"的决策心智；
- **门禁**：重要的删改必须经过**用户的真实审批**（一次性、限时、全审计），模型永远不能自我批准；
- **恢复**：回收站 + 快照回滚 + 重启前体检，兜住"已经发生了"的事故。

## 为什么是插件层，而不是改 DSH 内核

| 层 | 能做什么 | 不能做什么 |
|---|---|---|
| **dsh 内核**（上游） | 进程隔离、安全启动、事务化安装、启动校验门 | 需要改源码，本插件不依赖 |
| **本插件（dsh-safety）** | 在工具调用边界拦截 + 教育式拒绝 + 用户审批门禁 + 回收站 + 快照回滚 + 体检 + 审计 | 拦不住"用户自己终端"、拦不住恶意插件（进程内同权） |
| **用户侧** | 配好 DSH 自带沙箱/审批，缩小工作区 | 需要人工配置 |

因此本插件是**安全网**而非沙箱；要彻底治理，仍需在 DSH 上游实现安全启动与故障隔离。但"删除可恢复、崩溃可回滚、重要的删改先问人"这一半能力，当前 dsh 并不具备，正是本插件补足的缺口。

## 架构

```
┌─ 工具调用边界（模型侧）────────────────────────────┐
│  tools.guard（单调守卫，执行前同步判定）             │
│    pwsh/bash / write/edit/str_replace_editor /      │
│    run_code（代码体文本扫描）                        │
│  fs/write-intent + fs/edit-intent（第二道防线）      │
│  └ 匹配已获批审批 → 一次性放行；否则教育式拒绝       │
└───────────────────────────────────────────────────┘
        │ 拒绝 → 教育式消息（是什么/为什么/后果/正路）
        │        + 写审计日志 + 返回模型（不崩进程）
        ▼
┌─ 唯一合法删除通道 + 审批 ──────────────────────────┐
│  safety_ask → 带因果的审批请求 → dsh-safety allow   │
│  safe_delete → trash/（可 undo）                    │
│  safety_snapshot / safety_restore（事务化回滚）      │
│  safety_check（重启前体检）                          │
└───────────────────────────────────────────────────┘
        │ 同一份状态（$DSH_HOME/.dsh-safety/）
        │   journal.jsonl / trash / snapshots / state.json（含审批）
        ▼
┌─ 独立 CLI（人侧，不依赖 DSH）──────────────────────┐
│  status/delete/trash/undo/snapshot/restore/check/   │
│  journal/policy/approvals/allow/revoke              │
└───────────────────────────────────────────────────┘
```

> 说明：本插件不提供浏览器面板（历史版本曾有一个「安全中心」设置分区与 `/safety/api` 路由，已按用户要求移除，见 CHANGELOG）。全部交互收敛到模型侧工具与独立 CLI，包更小、无 UI 依赖。

## 三级策略（人机交互视角）

| 级别 | 允许 | 禁止 | 默认覆盖 |
|---|---|---|---|
| `protected` | 读 | 写 / 改 / 删（除非已获用户审批） | profile manifest/补丁/lockfile/`node_modules`、安装目录、home 补丁与设置 |
| `confirm` | 读、编辑 | 删（需已获批的审批；回收站通道是 `safe_delete`，经批准的原始 shell 调用按原样执行） | 整个 `$HOME`、`profiles/*`、`.agent-presets` |
| `free` | 读写删 | 递归删（`cooperative` 下可批准） | 普通工作区文件 |

**递归删除是最高风险操作**（正是那次事故的直接手法），因此默认在任意路径拒绝，显式放行走 `safe_delete`（回收站、可撤销）；`mode: cooperative` 下人类可授予一次性通用递归审批放行自由路径的 shell 递归删除。

## 审批系统（核心）

**原则：模型永远不能批准自己的破坏性调用。** `force:true` 这种模型可自设的标志不是确认——批准只来自人类动作（CLI `dsh-safety allow` / `dsh-safety delete --force`）。

- **请求**（`safety_ask`）：被拦后模型发起结构化请求，携带 `what`/`why`/`consequence`/`alternative`，生成 request id 并写审计。**信任锚点**：系统同时按真实路径分类（`classifyWithReal`）计算权威后果写入 `systemNote`——模型自述视为未核验信息，CLI `approvals` 把 `[system]` 判定与 `(model: …)` 自述分开呈现，用户批准时以系统判定为准。
- **批准**（CLI）：`allow <id>` 批模型请求；`allow --path … [--kind delete|write] [--recursive]` 人类直接创建+批准；`delete --force` 先授予所需审批再移入回收站。
- **消费**（守卫 / `safe_delete`）：第一个匹配调用（kind 精确、target 精确；递归审批 flag 精确、target 可为空）一次性消费；之后失效。
- **属性**：一次性 + 限时（`approvalTtlMs`，默认 5 分钟）+ 全审计（谁请求/谁批准/何时/何时消费），持久化于 `state.json`；审批的「读→改→写」临界区由跨进程原子锁（`.approval-lock`）串行化（限时重试 + stamp 陈旧窃取），web + headless 双进程不会并发丢更新。
- **防循环**：同一目标反复被拦 → 拒绝消息升级为 STOP，明确禁止换工具/换路径/编码绕过。

## guard 判定链

```
破坏性动词？ ── 否 → 放行
   │ 是
递归删除（-Recurse/-r/-rf/rd /s/rmdir/shutil.rmtree/fs.rm recursive）？
显式路径命中 protected/confirm？（含 realpath 双查，防符号链接逃逸）
变量引用片段（$env:X\…、%X%\…、${X}/…）展开进受保护区？
命令文本命中保护标记（.dsh、node_modules、cordis.patch.yml…）？
run_code 代码体走同一条链？
   │
匹配已获批的一次性审批？ ── 是 → 消费并放行（审计 approval-consume）
   │ 否
递归删除在自由路径且 strict 模式 → 不可批准，拒绝
其余 → 教育式拒绝（是什么/为什么/后果/正路 + 反绕过提示）
```

拒绝都会：写审计日志 + 作为错误返回给模型（**绝不导致进程崩溃**）。

## 教育式拒绝与"给 AI 的心智"

- **拒绝消息** = 因果卡：`Target`（文件大小/目录内容预览）+ `Why it matters`（如"改写 profile manifest 会让 DSH 启动失败"）+ `Sanctioned path`（safe_delete / safety_ask）+ 反绕过条款 + 必要时 STOP 升级。
- **systemPrompt** = 决策心智：删/改重要文件前先 `preview`，再向用户讲清"是什么/为什么/后果/替代方案"，用户明确同意后才动手；一旦被拦就停、不许绕过、直接问用户。
- 目标：把"拒绝"从终点变成教学点，从源头减少"一直想别的办法"的对抗循环。

## 与 DSH 内置能力的诚实关系

| DSH 内置 | 作用 | 与本插件的关系 |
|---|---|---|
| `dsh-sandbox-policy` | 工作区外写操作要求提升/审批 | **更强**的隔离；理想配置下本插件拦截层部分冗余 |
| `dsh-user-approval` | 提升权限需用户审批 | 真正的确认门；本插件的审批系统可与它对接（`grantApproval` 即对接点） |
| `dsh-fs-observation-policy` | 先读后写（CAS） | 与写保护部分重叠 |
| `--dump-default-config` | 跳用户层看 bundle 层 | 诊断用，无自动恢复 |

结论：应优先配置好 DSH 自带的沙箱/审批（这是第一道、也是更强的隔离），本插件专攻 dsh 缺失的**恢复层**（回收站/快照/回滚/体检/审计）与**问人层**（审批门禁）以及**兜底层**（沙箱宽开时的最后防线）。

## 关键设计决策

1. **`buildPolicy` 单一来源**：插件与 CLI 共用 `safety-core.mjs`，两套表面永不漂移；CLI 另提供 `--write-root`/`--confirm-root`/`--no-home-confirm` 对齐插件配置根。
2. **fail-soft apply**：插件注册失败时只降级记日志，安全插件自身不得成为导致 DSH 启动失败的因素。
3. **审批=真实人机通道**：批准只来自 CLI 人类动作；一次性 + 限时 + 全审计，防止橡皮图章与永久放行。
4. **教育式拒绝 + 反绕过**：被拦返回因果与正路，systemPrompt 明确禁止换姿势绕过；同目标重复拦截升级 STOP。
5. **快照排除凭据**：`settings.yaml`/`.credentials.yaml` 默认不进快照，防泄露。
6. **事务化回滚**：`restoreSnapshot` 两阶段 + 失败整体回滚，备份按相对路径存放（避免同名冲突）。
7. **零外部依赖**：import 只有 Node 内置 + 仓库内模块——不 import 任何 `@deepseek-ai/*`，所以 `link:` 裸装（无自带 `node_modules`）也能启动，供应链最小。
8. **递归删除默认不可批准**：`strict` 模式下递归 shell 删除永不可批准，目录树删除唯一通道是 `safe_delete`（回收站）；`cooperative` 交给人类授权。
