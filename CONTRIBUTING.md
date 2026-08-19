# Contributing

欢迎贡献。本项目很小，原则很简单：**安全网自己绝不能变成事故源**。

## 开发

```bash
npm test                        # 全部单测（core + state/audit/policy/snapshot-store），零依赖 / all unit tests (zero deps)
npm run check                   # 语法检查 / syntax checks
node test/harness.mjs           # 集成检查（干净检出、零依赖、无需 junction） / integration checks (clean checkout, zero deps, no junction needed)
```

## 模块布局

```
lib/safety-core.mjs       纯逻辑：策略/守卫判定/回收站/快照/校验（零依赖、可单测）
lib/state.mjs             持久化状态：审批、守卫计数、日志（node 内置，同步读写）
lib/audit.mjs             JSONL 审计 + 阈值告警
lib/policy.mjs            策略细化工具（符号链接/挂载检测，独立导出）
lib/snapshot-store.mjs    增量快照工具（独立导出）
lib/index.js              host 胶水：把上述模块接到 ctx.tools / ctx.on
bin/dsh-safety.mjs        独立 CLI（人侧：delete/undo/snapshot/restore/allow…）
```

本插件**没有浏览器半区**（历史 `lib/client.js` 已移除）——所有交互走模型侧工具与 CLI。

## 提交要求

- **纯逻辑放 `lib/safety-core.mjs` 或 `lib/state.mjs`**（零依赖、可单测），`lib/index.js` 只做 cordis 胶水。
- 任何新的"拦截/审批/删除/校验"行为都必须有对应的单元测试（`test/*.test.mjs`）或集成检查（`test/harness.mjs`）。
- **fail-soft 铁律**：插件在任何环境下都不允许让 DSH 启动失败——新增代码若可能抛错，必须包进降级路径。
- **审批安全**：审批只来自人类通道（CLI）；模型可自设的标志永远不能等于"已批准"。改动 `consumeApproval`/`safe_delete` 的放行逻辑前，先想清楚"模型能否自我批准"。
- 改 `README.md` 后必须同步 `README.zh.md`，并用以下命令更新 `README.i18n.yaml`：
  ```bash
  git hash-object README.md README.zh.md   # 重新生成双语一致性哈希 / regenerate the bilingual-consistency hashes
  ```
- 保持零外部依赖：`lib/` 的 import 只允许 Node 内置 + 仓库内模块——**不要** import `@deepseek-ai/*`（裸 `link:` 安装没有自带 `node_modules`，会启动失败）。
- 每次修改后跑 `npm test` 与 `node test/harness.mjs`（无需 junction、干净检出即可通过）。

## 报告问题

- Bug / 绕过 guard 的方式 / 自我批准漏洞：先看 [SECURITY.md](SECURITY.md) 的私密报告通道。
- 功能请求、文档改进：开 issue 即可。

## 版本

语义化版本（SemVer）。行为变化（默认策略、拒绝/审批逻辑）视为破坏性变更，升 minor。
