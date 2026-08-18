# dsh-safety

[English](README.md) | 中文

<p align="center">
  <a href="https://github.com/sugarxl/dsh-safety/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license"></a>
  &nbsp;
  <a href="https://github.com/sugarxl/dsh-safety/blob/main/package.json"><img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="dependencies"></a>
  &nbsp;
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square" alt="node"></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@suagr_xl/dsh-safety"><img src="https://img.shields.io/npm/v/@suagr_xl/dsh-safety?style=flat-square" alt="npm version"></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@suagr_xl/dsh-safety"><img src="https://img.shields.io/npm/dm/@suagr_xl/dsh-safety?style=flat-square" alt="npm downloads"></a>
  &nbsp;
  <a href="https://github.com/sugarxl/dsh-safety/releases"><img src="https://img.shields.io/github/v/release/sugarxl/dsh-safety?style=flat-square" alt="github release"></a>
  &nbsp;
  <a href="https://github.com/sugarxl/dsh-safety/stargazers"><img src="https://img.shields.io/github/stars/sugarxl/dsh-safety?style=flat-square" alt="stars"></a>
  &nbsp;
  <a href="https://github.com/sugarxl/dsh-safety/commits/main"><img src="https://img.shields.io/github/last-commit/sugarxl/dsh-safety?style=flat-square" alt="last commit"></a>
  &nbsp;
  <a href="https://github.com/sugarxl/dsh-safety/actions"><img src="https://img.shields.io/github/actions/workflow/status/sugarxl/dsh-safety/test.yml?style=flat-square&label=CI" alt="ci"></a>
</p>

<p align="center">
  <strong>DeepSeek Harness 文件系统安全护栏：拦截破坏性操作 · 删除可恢复 · 组合可回滚 · 启动前校验</strong><br>
  <em>execution-time guard · safe_delete · composition snapshots · pre-restart check · standalone CLI</em>
</p>

<div align="center">

[是什么](#是什么) · [功能](#功能) · [安装](#安装) · [快速上手](#快速上手) · [CLI](#cli-参考) · [配置](#配置) · [设计](docs/DESIGN.md) · [常见问题](docs/FAQ.md) · [已知限制](docs/KNOWN-LIMITATIONS.md)

</div>

## 是什么

DeepSeek Harness（DSH）的文件系统安全护栏。它在工具执行边界强制一套三级文件策略：破坏性调用在执行前被拒绝、每次删除都走可恢复的回收站、插件组合可快照并回滚、重启前对组合做校验。

零运行时依赖。既可安装为标准的 DSH profile bundle，也附带独立 CLI——DSH 本身无法启动时，恢复层依然可用。

> **背景**——护栏规则源于一次真实生产事故：脚本因 PowerShell `$HOME` 是只读变量而静默解析错路径，`Remove-Item -Recurse -Force` 删除了整个引擎运行根目录。该目录能恢复，仅因为它属于可再生成的生成内容；手写文件则会永久丢失。插件将这次事故的教训实现为强制机制，而非文档说明。

## 功能

- **执行前守卫**（`ctx.tools.guard`）：在工具真正运行**之前**拒绝破坏性调用。
  - **递归删除目录在任意路径一律拒绝**（`rm -r/-rf`、`Remove-Item -Recurse`、`rd /s`、`rmdir`、`shutil.rmtree`、`fs.rm recursive`、`require('fs').rmSync`…）——不管删哪里，都强制走 `safe_delete`。
  - `write`/`edit`/`str_replace_editor` 写 **protected** 区（profile 的 `package.json`、`cordis.patch.yml`、`cordis.yml`、lockfile、`node_modules`、部署安装目录、home 级补丁/设置）→ 拒绝。
  - 删除命中 **confirm** 区（整个 OS 用户主目录、插件源码、agent-preset）→ 拒绝并引导走 `safe_delete`。
  - **`run_code` 代码体同样被扫描**——任意代码执行不能靠"绕过工具边界"把对受保护区的 `fs.rmSync`/`shutil.rmtree` 藏起来。
  - **变量引用删除也能拦**——`Remove-Item "$env:USERPROFILE\.dsh\…"` 这种展开后才是真实路径的命令，会把引用+尾段与保护标记比对并拒绝。
- **`safe_delete`** —— 唯一合法的删除通道。删除=移动进回收站（`safety_undo` 可还原）；`preview:true` 先看再删；拒绝文件系统根和自身状态目录；每次删除都进审计日志。
- **组合快照** —— `safety_snapshot` 把整套插件组合（每个 profile 的 manifest/补丁/lockfile、插件 `package.json`+`cordis.patch.yml`、agent-preset）带 SHA-256 存起来；`safety_restore` 一键回滚到 last-known-good（现行文件先自动备份）。默认排除含凭据的文件。
- **重启前体检** —— `safety_check` 检查 UTF-8、**乱码检测**（错误编码往返，就是"DSH 打不开"的经典原因）、JSON 可解析、**跨补丁层重复插件行 id**（"一行只能在一个层"规则）。
- **审计日志 + 网页面板** —— 拦截/删除/快照/回滚全部留痕；设置页新增「安全中心」分区，可视化回收站/快照/日志，可一键还原/回滚。
- **独立 CLI** —— `dsh-safety` 不依赖 DSH：在你自己终端就能 delete/undo/snapshot/restore/check，DSH 打不开时也能用。

## 安装

系统要求：已装好 DeepSeek Harness（`dsh web` 能启动）。npm 安装无额外要求；从仓库安装需要 Node.js >= 22 与 pnpm。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add @suagr_xl/dsh-safety
```

`dsh plugin` 会跑 pnpm，并因本包声明了 `dsh.bundle` 自动把它加进 `dsh.profile.bundles`。装完重启 `dsh web`，守卫即生效、`safety_*` 工具可用。

### 从仓库安装（开发调试）

```sh
git clone https://github.com/sugarxl/dsh-safety.git
cd dsh-safety
dsh plugin --profile web add link:$(pwd)     # 把仓库软链进 profile
```

用 `link:` 是软链（改 `lib/` 重启即生效），`file:` 则是复制快照。`dsh plugin` 会自动 reconcile 进 bundles。注意：profile 目录不是 pnpm workspace，`workspace:*` 依赖会回退到 npm 仓库——本插件**完全没有运行时依赖**（import 只有 Node 内置 + 自己的 `safety-core.mjs`），所以裸 `link:` 安装不需要它自己的 `node_modules`，也不存在回退问题。

### 官方安装布局

两种方式都走官方 `dsh plugin` 机制，装完无需任何手工配置：

```
$DSH_HOME/profiles/<name>/package.json                # 新增依赖 + dsh.profile.bundles
$DSH_HOME/profiles/<name>/node_modules/dsh-safety/    # 安装的包本体
```

bundle 层在启动时从包内的 `cordis.patch.yml` 读取。`dsh-safety` 这个行 id 只能出现在这一个层（包内文件）——**不要**再写进 profile 或 home 的 `cordis.patch.yml`。

### 验证与卸载

```bash
dsh --profile web --dump-config | grep -i dsh-safety   # 确认行出现
dsh-safety check                                        # 重启前体检
# 重启 dsh web

# 卸载：
dsh plugin --profile web remove @suagr_xl/dsh-safety
# 重启 dsh web
```

### 独立 CLI（不装插件也能用）

```bash
npm link   # 或直接: node bin/dsh-safety.mjs ...
dsh-safety status
```

CLI 与插件读写同一个 `$DSH_HOME/.dsh-safety` 状态目录，DSH 挂了也能 undo/restore。

### 安装排障

- **装了也重启了，但没生效**：要重启整个 `dsh web` 进程，刷新页面不够；用 `dsh --profile web --dump-config` 确认行已挂载。
- **`ERR_PNPM_IGNORED_BUILDS`**：pnpm 拒绝依赖的构建脚本，把提示的包加进 profile 的 `pnpm-workspace.yaml` `allowBuilds` 后重跑。
- **pnpm 发布年龄门禁装到旧版**：pnpm 11 的 `minimumReleaseAge` 会在发布后约 10 天内静默装旧版；在 profile 的 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude: ['@suagr_xl/dsh-safety']`，再执行 `dsh plugin --profile web update @suagr_xl/dsh-safety` 升级。

## 快速上手

```bash
# 1. 查看当前策略分区
dsh-safety policy

# 2. 修改任何组合文件之前，先快照
dsh-safety snapshot before-edit

# 3. 通过安全通道删除（先预览，再执行）
dsh-safety delete path/to/file --preview
dsh-safety delete path/to/file

# 4. 恢复误删
dsh-safety trash
dsh-safety undo <trash-id>

# 5. 启动失败时：先校验，再回滚
dsh-safety check
dsh-safety status          # 查看快照列表
dsh-safety restore <snapshot-id> --confirm
```

## CLI 参考

```
dsh-safety status                  状态：回收站/快照/日志
dsh-safety delete <path> [--force] [--preview]
dsh-safety trash [--limit N]
dsh-safety undo <id>
dsh-safety snapshot [label] [--exclude a,b]
dsh-safety restore <id> --confirm
dsh-safety check                   失败时 exit 1（适合 CI）
dsh-safety journal [n]
dsh-safety policy                  当前策略分区
dsh-safety help
```

`--home <path>` 可覆盖状态根（默认 `$DSH_HOME` 或 `~/.dsh`）。

## 模型侧工具（以插件方式安装后）

| 工具 | 作用 |
|---|---|
| `safe_delete` | 回收站式删除（preview / force / 可撤销） |
| `safety_trash` / `safety_undo` | 列回收站 / 还原条目 |
| `safety_snapshot` / `safety_restore` | 快照组合 / 回滚（需 `confirm:true`） |
| `safety_check` | 重启前校验（UTF-8 / 乱码 / JSON / 重复 id） |
| `safety_journal` / `safety_status` | 审计日志 / 状态 |

## 配置

在补丁层覆盖插件行配置（例如 profile 的 `cordis.patch.yml`）：

```yaml
- id: dsh-safety
  config:
    blockWriteRoots: ["C:\\extra\\protected"]
    confirmDeleteRoots: ["D:\\data"]
    snapshotExclude: ["settings.yaml", ".credentials.yaml"]
    blockWrites: true
    blockShellDestructive: true
    audit: true
    keepTrash: 200
    keepSnapshots: 10
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `blockWriteRoots` | profile manifest/补丁/lockfile/node_modules、安装目录、home 补丁/设置 | 禁写/改/删 |
| `confirmDeleteRoots` | `$HOME`、`profiles/*`、`.agent-presets` | 禁删（`force` 也只进回收站） |
| `snapshotExclude` | `["settings.yaml", ".credentials.yaml"]` | 永不复制进快照的文件 |
| `blockWrites` | `true` | 开/关写保护守卫 |
| `blockShellDestructive` | `true` | 开/关 shell 删除守卫 |
| `audit` | `true` | 记录破坏性工具调用 |
| `keepTrash` / `keepSnapshots` | `200` / `10` | 保留上限 |

## 原理

三级策略：

| 级别 | 允许 | 禁止 | 默认覆盖 |
|---|---|---|---|
| `protected` | 读 | 写 / 改 / 删 | profile 的 `package.json`/`cordis.patch.yml`/`cordis.yml`/lockfile/`node_modules`、安装目录、home 补丁与设置 |
| `confirm` | 读、编辑 | 删（需 `safe_delete --force`，仍只进回收站） | 整个 `$HOME`、插件源码、agent-preset |
| `free` | 读写删 | 递归删 | 普通工作区文件 |

守卫对每次工具调用的判定链：有破坏性动词？→ 是不是递归删除？→ 显式路径是否命中 protected/confirm？→ 变量引用片段（`$env:X\…`、`%X%\…`、`${X}/…`）是否展开进受保护区？→ 命令文本是否命中保护标记（`~`/相对路径形式）？→ **`run_code` 代码体走同一条链** → 递归删除在最后无条件拒绝。拒绝会写审计日志并作为错误返回给模型（绝不会导致进程崩溃）。

第二层：挂 `fs/write-intent` / `fs/edit-intent` 瀑布，任何途径写 protected 路径都抛 `FS_DENIED`。

`buildPolicy` 位于 `safety-core.mjs`，插件守卫和独立 CLI **共用同一份策略**，两套表面永远不会漂移。`restoreSnapshot` 是事务化的：先备份现行文件、再从快照复制回去，任一阶段失败就整体回滚——**失败的恢复永远不会把组合留成半恢复状态**。

## 目录结构

```
dsh-safety/
├── bin/
│   └── dsh-safety.mjs        # 独立 CLI（零依赖）
├── lib/
│   ├── safety-core.mjs       # 纯逻辑：策略/守卫/回收站/快照/校验
│   ├── index.js              # host 半区：工具、guard、fs 钩子、web 路由
│   └── client.js             # browser 半区：「安全中心」设置面板
├── test/
│   ├── safety.test.mjs       # 20 个单测（零依赖）
│   └── harness.mjs           # 38 项集成检查（干净检出，零依赖）
├── cordis.patch.yml          # bundle 补丁（插入 dsh-safety 行）
├── package.json              # dsh.bundle + dsh.client + bin
├── install.ps1 / recover.ps1 # 本地便捷脚本（快照→安装→校验→回滚）
├── README.md / README.zh.md  # 文档（中英双语，官方配对）
└── LICENSE / NOTICE / SECURITY.md
```

## 测试

```bash
node --test test/safety.test.mjs   # 20 个单测，零依赖
node test/harness.mjs              # 38 项集成检查，干净检出（无需 @deepseek-ai）
npm run check                      # 语法检查
```

## 故障排查

- **改完插件后 DSH 打不开**：跑 `dsh-safety check` 找乱码/JSON/重复 id；`dsh --profile web --dump-default-config` 看不带用户层的 bundle 层；`dsh-safety restore <id> --confirm` 回滚快照。
- **守卫拦了合法操作**：守卫从不拦读和插件源码编辑；它拦的是 `$HOME`/插件/配置区的删除——用 `safe_delete`（可撤销）代替裸 `rm`。
- **需要删除受保护路径**：`safe_delete` 加 `force:true`（或 `dsh-safety delete --force`）——仍然只进回收站，永不真正删除。

## 安全

见 [SECURITY.md](SECURITY.md)。要点：守卫拦截的是**模型工具调用**，不是你在自己终端敲的命令；`safety_check` 是行级扫描，不是完整 YAML 解析器。它是**安全网**，不是沙箱——真正的隔离请配好 DSH 自带的沙箱/审批，用本插件补 DSH 缺失的**恢复层**。

## License

MIT。集成模式参考 DeepSeek Harness（MIT），见 [NOTICE](NOTICE)。
