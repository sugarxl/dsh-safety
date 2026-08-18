# Contributing

欢迎贡献。本项目很小，原则很简单：**安全网自己绝不能变成事故源**。

## 开发

```bash
node --test test/safety.test.mjs   # 纯逻辑单测（零依赖，任何环境可跑）
npm run check                      # 语法检查
node test/harness.mjs              # 集成检查（需要真实 @deepseek-ai 包：
                                   #   在 dsh 环境里跑，或建一个指向
                                   #   profiles/node_modules/@deepseek-ai 的
                                   #   node_modules/@deepseek-ai junction）
```

## 提交要求

- **纯逻辑放 `lib/safety-core.mjs`**（零依赖、可单测），`lib/index.js` 只做 cordis 胶水。
- 任何新的"拦截/删除/校验"行为都必须有对应的单元测试。
- **fail-soft 铁律**：插件在任何环境下都不允许让 DSH 启动失败——新增代码若可能抛错，必须包进降级路径。
- 改 `README.md` 后必须同步 `README.zh.md`，并用以下命令更新 `README.i18n.yaml`：
  ```bash
  git hash-object README.md README.zh.md
  ```
- 保持零外部依赖：`lib/` 的 import 只允许 Node 内置 + 仓库内模块——**不要** import `@deepseek-ai/*`（裸 `link:` 安装没有自带 `node_modules`，会启动失败）。
- 每次修改后跑 `node test/harness.mjs`（无需 junction、干净检出即可通过）。

## 报告问题

- Bug / 绕过 guard 的方式：先看 [SECURITY.md](SECURITY.md) 的私密报告通道。
- 功能请求、文档改进：开 issue 即可。

## 版本

语义化版本（SemVer）。行为变化（默认策略、拒绝逻辑）视为破坏性变更，升 minor。
