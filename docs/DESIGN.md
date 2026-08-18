# 设计说明（Design）

## 它解决什么问题

DeepSeek Harness（DSH）把"一切皆插件"推到极致，代价是**缺少护栏**：

1. 模型/脚本可以在没有明确指令的情况下删除或改写关键文件（无回收站、无撤销）。
2. 插件开发直接发生在生产 profile 里，一个坏补丁/坏编码就能让 DSH 打不开，且没有 last-known-good 自动恢复。
3. 安装/卸载非事务，失败后没有回滚通道。

一次真实事故（脚本因 PowerShell `$HOME` 只读变量静默解析错路径，`Remove-Item -Recurse -Force` 删掉整个引擎运行根）证明：这些不是理论风险。dsh-safety 把那次事故的教训编码成**强制机制**，而不是一句"注意安全"。

## 为什么是插件层，而不是改 DSH 内核

| 层 | 能做什么 | 不能做什么 |
|---|---|---|
| **dsh 内核**（上游） | 进程隔离、安全启动、事务化安装、启动校验门 | 需要改源码，本插件不依赖 |
| **本插件（dsh-safety）** | 在工具调用边界拦截 + 回收站 + 快照回滚 + 体检 + 审计 | 拦不住"用户自己终端"、拦不住恶意插件（进程内同权） |
| **用户侧** | 配好 DSH 自带沙箱/审批，缩小工作区 | 需要人工配置 |

所以它是**安全网**，不是沙箱；真正要治本，仍需把"安全启动/故障隔离"推给上游。但"删了能还回来、崩了能回滚"这半件事，当前 dsh 没有，正是本插件补的洞。

## 架构

```
┌─ 工具调用边界（模型侧）────────────────────────────┐
│  tools.guard（单调守卫，执行前同步判定）             │
│    pwsh/bash / write/edit/str_replace_editor /      │
│    run_code（代码体文本扫描）                        │
│  fs/write-intent + fs/edit-intent（第二道防线）      │
└───────────────────────────────────────────────────┘
        │ 拒绝 → 写审计日志 + 错误返回模型（不崩进程）
        │ 放行
        ▼
┌─ 唯一合法删除通道 ────────────────────────────────┐
│  safe_delete → trash/（可 undo）                    │
│  safety_snapshot / safety_restore（事务化回滚）      │
│  safety_check（重启前体检）                          │
└───────────────────────────────────────────────────┘
        │ 同一份状态（$DSH_HOME/.dsh-safety/）
        ▼
┌─ 独立 CLI（人侧，不依赖 DSH）──────────────────────┐
│  dsh-safety status/delete/trash/undo/snapshot/      │
│           restore/check/journal/policy               │
└───────────────────────────────────────────────────┘
```

## 三级策略

| 级别 | 允许 | 禁止 | 默认覆盖 |
|---|---|---|---|
| `protected` | 读 | 写 / 改 / 删 | profile manifest/补丁/lockfile/`node_modules`、安装目录、home 补丁与设置 |
| `confirm` | 读、编辑 | 删（`safe_delete --force` 也只进回收站） | 整个 `$HOME`、`profiles/*`、`.agent-presets` |
| `free` | 读写删 | 递归删 | 普通工作区文件 |

**递归删除在任意路径无条件拒绝**是核心决策：目录递归删除破坏半径最大、意图最难猜，宁可拦错不可放错；真要删，走 `safe_delete` 进回收站。

## guard 判定链

```
破坏性动词？ ── 否 → 放行
   │ 是
递归删除（-Recurse/-r/-rf/rd /s/rmdir/shutil.rmtree/fs.rm recursive）？
显式路径命中 protected/confirm？
变量引用片段（$env:X\…、%X%\…、${X}/…）展开进受保护区？
命令文本命中保护标记（.dsh、node_modules、cordis.patch.yml…）？
run_code 代码体走同一条链？
── 递归删除 → 无条件拒绝
```

拒绝都会：写审计日志 + 作为错误返回给模型（**绝不导致进程崩溃**）。

## 与 DSH 内置能力的诚实关系

| DSH 内置 | 作用 | 与本插件的关系 |
|---|---|---|
| `dsh-sandbox-policy` | 工作区外写操作要求提升/审批 | **更强**的隔离；理想配置下本插件拦截层部分冗余 |
| `dsh-user-approval` | 提升权限需用户审批 | 真正的确认门 |
| `dsh-fs-observation-policy` | 先读后写（CAS） | 与写保护部分重叠 |
| `--dump-default-config` | 跳用户层看 bundle 层 | 诊断用，无自动恢复 |

结论：**先配好 DSH 沙箱/审批**（这比任何一行代码都重要），本插件专攻 dsh 没有的**恢复层**（回收站/快照/回滚/体检/审计）+ **兜底层**（宽开沙箱下的最后防线）。

## 关键设计决策

1. **`buildPolicy` 单一来源**：插件与 CLI 共用 `safety-core.mjs`，两套表面永不漂移。
2. **fail-soft apply**：插件注册失败只降级记日志，**安全插件自己绝不能变成"装上就打不开"的事故源**。
3. **快照排除凭据**：`settings.yaml`/`.credentials.yaml` 默认不进快照，防泄露。
4. **事务化回滚**：`restoreSnapshot` 两阶段 + 失败整体回滚，备份按相对路径存放（避免同名冲突）。
5. **零外部依赖**：import 只有 Node 内置 + 自己的 `safety-core.mjs`——不 import 任何 `@deepseek-ai/*`，所以 `link:` 裸装（无自带 `node_modules`）也能启动，供应链最小。
