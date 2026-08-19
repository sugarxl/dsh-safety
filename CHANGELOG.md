# Changelog

本项目使用语义化版本（SemVer）。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.3] - 2026-08-19

### Fixed（深度逻辑/安全审查，第三轮）

- **`safety_undo`/`safety_restore` 路径穿越（真实安全洞）**：`trashRestore`/`restoreSnapshot` 把外部传入的 id 直接 `path.join` 进状态目录，`../../x` 这类 id 可读写 trash/snapshots 目录之外的文件。现新增 `validId`（拒绝含 `..` 或路径分隔符的 id），两类恢复入口统一校验，目录外文件不可触碰。
- **审批对「写」操作失效（真实逻辑错误）**：`fs/write-intent`/`fs/edit-intent` 瀑布层不认审批——即使人类批了写 protected 路径，第二道防线照样抛 `FS_DENIED`，已批准的写永远写不进去。现改为：守卫对「写」只做**非消费检查**（`hasActiveApproval`），瀑布层在放行时**消费**审批——批准后写真正成功，且保持一次性。
- **`run_code` 与 shell 行为不一致（缺口）**：shell 删除会按显式绝对路径分类拦截 protected/confirm，`run_code` 此前只查标记与递归，`fs.unlinkSync('C:\Users\a\...')` 这类非递归 confirm 区删除可绕过。现 `run_code` 代码体同样提取并分类绝对路径。
- **`$HOME`/`$DSH_HOME` 变量引用删除逃逸（缺口）**：标记匹配只认 `.dsh`/`node_modules` 等字样，自定义 DSH_HOME 下的 `$env:DSH_HOME\profiles\...` 可绕过。现新增 `resolveVariableRefs`：`HOME`/`USERPROFILE`/`DSH_HOME`/`APPDATA`/`TEMP`/`TMP` 解析为字面路径后按 protected / DSH-home 分类拦截（未知变量仍退回标记检查）。
- **protected/confirm 递归 shell 删除可被批准后真删（与文档承诺矛盾）**：此前「strict 永不可批准」只对 free 路径生效，protected/confirm 的递归删除带精确审批也能放行原始 shell 删除。现改为：递归删除仅在 **free 路径 + cooperative 模式**下可批准；protected/confirm 递归删除一律拒绝并引导 `safe_delete`（回收站）。文档同步修正「still trash-only」的误导性表述。
- **审批 target 匹配 Windows 大小写敏感（与分类不一致）**：`consumeApproval` 改用 `keyOf` 归一比较（Windows 大小写不敏感、POSIX 精确），`safe_delete` 与守卫的 pending 查找同步归一。
- **守卫自身异常静默 fail-open（可观测性）**：守卫 catch 现在把错误写入 journal（`guard-error`），保护被无声关闭时可事后审计；仍保持 fail-open 以免守卫拖垮 DSH。
- **审计写入 O(n²)（性能）**：`checkAlerts` 原先每次 append 全量读文件 5 遍（每阈值一遍），现改为单次扫描同时聚合 1 分钟/1 小时窗口。
- **CLI `delete --force` 遗留无用审批**：移除 CLI 删除路径上永不被消费的审批授权（CLI 直接走回收站，无需审批记录）。
- **`buildPolicy` POSIX 安装目录保护缺失**：此前两个候选均为 Windows 路径；补充 `/usr/lib`、`/usr/local/lib`、`/opt/homebrew/lib`、`~/.local/lib` 等常见 npm 全局安装根（存在才加入）。
- **`extractShellPaths` tilde 替换 `$` 注入**：改为函数式替换，home 含 `$`（如 `my$user`）时不会被当作替换模式。
- **`install.ps1`/`recover.ps1` 不认 `DSH_HOME`**：改为优先 `$env:DSH_HOME`，缺省回退 `%USERPROFILE%\.dsh`。
- 测试：新增 6 组回归（id 穿越 ×2、run_code 路径分类、变量引用解析、审批大小写、`hasActiveApproval` 非消费语义），harness 新增「已批准写通过瀑布层且一次性」「protected 递归删不可批准」端到端断言。51 单测 + harness 全绿。

### Fixed（深度逻辑/安全审查，第二轮：更多绕过面与健壮性）

- **`run_code` 写 protected 绕过（真实洞）**：`fs.writeFileSync(protectedPath)` 完全不经过写守卫——任意代码可直接改写 profile manifest/补丁。现 `run_code` 同样扫描写动词（`writeFile/appendFile/rename/copyFile/cp/truncate/createWriteStream` 等），对显式绝对路径按 protected 分类拦截；写操作不做 marker 兜底（会误杀 confirm 区合法编辑），相对路径写属于已记录局限。
- **`fs/delete-intent` 未挂钩（覆盖缺口）**：任何守卫不认识的 fs 服务删除工具（`delete_file` 等）可直接删 protected/confirm 路径。现挂钩 `fs/delete-intent`，与写瀑布一致：无审批一律 `FS_DENIED`，有已批审批则消费放行。
- **cooperative 递归审批对「具体目录」失效（真实 bug）**：`dsh-safety allow --path <dir> --recursive` 创建的审批带具体 target，但守卫的递归拒绝此前 `abs: null`（只匹配 target-null 的通用审批）——文档宣称的功能实际不生效。现递归拒绝携带首个显式目标路径，且递归审批语义升级为「覆盖被批准根目录及其整棵子树」（`isUnder` 匹配），通用审批不受影响。
- **`[IO.File]::Delete` / `[IO.Directory]::Delete` 无 `System.` 前缀漏检**：`[IO.File]::Delete("x")` 此前不被识别为破坏性动词；`git rm` 也未覆盖（`git rm` 会从工作树删除文件）；补上 PowerShell `ri`（Remove-Item 别名）。
- **正斜杠 Windows 路径漏检**：`C:/Users/a/.dsh/...` 不匹配反斜杠正则，可绕过 confirm/protected 路径分类。`extractShellPaths` 现同时接受 `C:\x` 与 `C:/x`。
- **编辑器 `delete` 命令未分类**：`str_replace_editor` 若含 `delete`/`remove` 命令，此前完全放行。现按删除分类（protected/confirm 拒绝并引导 `safe_delete`）。
- **审批列表无上限**：agent 可无限 `safety_ask` 刷 pending 记录撑爆 `state.json`。现上限 500 条（超限丢最旧）。
- **journal.jsonl 无限增长**：只删 trash/快照，日志文件永不裁剪。现超 8MB 自动裁剪保留最近 20000 行。
- **`restoreSnapshot` 同秒备份目录冲突**：同秒两次恢复共用同一备份目录会互相覆盖。备份目录加随机后缀。
- **审计 CSV 导出未转义**：含逗号/引号的字段会破坏 CSV 行。字段统一加引号转义。
- 测试：新增 7 组回归（新破坏性动词、正斜杠路径、编辑器 delete、run_code 写、递归目标携带、审批父目录覆盖、审批上限），harness 新增「cooperative 具体目录递归审批」「fs/delete-intent 拦截与放行」端到端断言。58 单测 + harness 全绿。

## [Unreleased]

### Docs（文档全方位改进）

- **README（中英）**：修英文副标题为英文；新增「审批流程」章节（ask→allow→retry 完整流程图 + 一次性/限时/严格模式说明）；功能清单补齐审批门禁、教育式拒绝、反绕过、strict/cooperative；三层表与判定链更新为"审批放行"语义；快速上手加入审批命令；目录结构去掉 `dsh.client`；故障排查更新 `force`→审批语义。
- **docs/DESIGN.md**：架构图移除浏览器面板，新增审批系统设计、教育式拒绝与"给 AI 的心智"、判定链含审批门禁；设计决策补审批/教育/递归门禁条目。
- **docs/FAQ.md**：`force:true` 语义改为审批；新增"被拦后正确流程""为什么 force 不够""strict vs cooperative""面板去哪了"等 FAQ。
- **docs/KNOWN-LIMITATIONS.md**：补审批相关限制（state.json 可被同进程插件篡改、审批依赖用户认真看/橡皮图章风险、并发消费、教育是软约束）。
- **SECURITY.md**：从 25 行扩为完整威胁模型（防不了什么/为什么/真实隔离靠什么）、防护范围、审批完整性、纵深防御检查清单、报告优先级。
- **CONTRIBUTING.md**：测试命令改为 `npm test`；补模块布局（无浏览器半区）；新增"审批安全"提交要求。
- **NOTICE**：移除已删除的 `lib/client.js` 浏览器模式引用。
- **CLI `help` 命令补全**：文档一直声明 `dsh-safety help` 但从未实现（此前返回 unknown command）；现已实现完整用法输出，并支持 `-h`/`--help`。

### Added（人机门禁：真实用户授权审批系统，阶段 2/3/4）

- **`force` 不再等于用户批准**：`safe_delete` 的 `force:true` 只是标记，删除 confirm/protected 目标前必须消费一个**已由用户批准**的一次性审批请求——模型永远无法自我批准。
- **新增 `safety_ask` 工具**：被拦后模型用它发起**带因果的结构化审批请求**（是什么 / 为什么 / 后果 / 替代方案），生成 request id 并写入审计；用户通过 `dsh-safety allow <id>` 批准。
- **守卫接入审批门禁**：同一操作存在已获批审批 → 一次性放行（消费后失效，审计记录 `approval-consume`）；存在待批准请求 → 拒绝消息直接给出请求 id 与批准命令，模型不再盲目重试。
- **CLI 审批命令**：`dsh-safety allow <id>`（批准模型请求）、`dsh-safety allow --path <p> [--kind delete|write] [--recursive]`（人类直接创建+批准）、`dsh-safety approvals`（列表）、`dsh-safety revoke <id>`；`status` 显示待批准请求。
- **移除浏览器「安全中心」面板**：按用户要求删除设置页的整个安全中心（`lib/client.js` 与 `/safety/api` web 路由、`webServer` 注入、`./client` 导出、`dsh.client` 配置全部移除）。管理/审批/审计全部走模型侧工具与独立 CLI（`safety_ask`、`dsh-safety allow/approvals/revoke`、`safety_journal`/`safety_status`），后台审批系统不受影响。
- **递归删除从"绝对拦截"改为可配置门禁**：`mode: strict`（默认）递归 shell 删除永不可批准；`mode: cooperative` 下人类可授予通用递归审批（`allow --path … --recursive` 或 `allow --path` + `--kind delete --recursive`）放行一次。
- **审批属性**：一次性 + 限时（默认 5 分钟，`approvalTtlMs` 可配）+ 全程审计（谁批准、何时、何时消费/过期），持久化于 `state.json`。
- 测试：审批生命周期/匹配/过期/撤销单测（state.test.mjs 新增 3 组），harness 新增 safety_ask、审批门禁、strict/cooperative 递归删除等断言。

### Fixed（真实部署暴露的两个启动 bug + 深度审查修复）

- **`link:` 裸装启动失败（真实 bug）**：`lib/index.js` 原先 `import` `@deepseek-ai/dsh-tools`/`dsh-fs`，但 `link:` 安装的插件没有自带 `node_modules` → Node 解析失败 → dsh 启动崩溃。已改为**零外部 import**（手写 JSON Schema 工具定义 + 稳定错误码），裸 `link:` 装、无需任何 junction 即可启动。
- **浏览器端 `Failed to load plugins`（真实 bug）**：`lib/client.js` 模块注册 id 从 `"dsh-safety"` 改为 scoped 全名 `"@suagr_xl/dsh-safety"`（dsh 客户端模块系统要求 scoped 包注册完整包名）。
- **run_code 裸 fs 调用绕过**（真实绕过）：`import { rmSync/unlinkSync/rmdirSync } from 'node:fs'` 后的**裸调用**（无 `.` 前缀）先前完全漏检，现已识别并拦截（配保护标记/递归判定）。
- **`rm --recursive` 漏检**：补进递归删除识别。
- **快照失败残留**：`createSnapshot` 中途失败会清理半成品目录，不再留下无 manifest 的垃圾快照。
- **还原定位窗口**：`trashRestore` 查找 original 从"最近 5000 条日志"改为读全量，老删除也能精确还原到原路径。
- **CLI `--home` 参数解析**：修复值被吞进 positional 的问题；删除未使用的 `ok` 死代码。
- **安全中心 web API 加固**：POST 写操作（undo/restore/snapshot）要求 `X-DSH-Safety: 1` 头；面板请求加 15s 超时。
- 已知限制补：`run_code` import 别名/动态构造仍可能绕过、相对路径按进程 cwd 解析、web API 护栏是轻量的、marker 误报真实案例。

### Fixed（深度审查第二轮：恢复被误删的 web API + 修复守卫/状态模块）

- **恢复 `/safety/api` Web 路由**：工作区未提交改动误删了整个 web panel API（约 93 行），导致「安全中心」面板全部 404、harness 断言失败；已从已提交版本恢复，client.js / inject / harness 三处对齐。
- **`str_replace_editor` 写保护失效（真实洞）**：守卫只读 `file_path`，而编辑器工具的参数名是 `path` → 对 protected 路径的 `str_replace_editor` 改写从未被拦。现同时接受 `file_path`/`path`，且仅拦截其写命令（create/str_replace/insert），view 读取放行。
- **`isDriveRoot` 对 POSIX `/` 失效**：`abs.length > 1` 把 `/` 排除，`safe_delete('/')` 在 Linux/macOS 上可落入"递归复制整个文件系统"的灾难路径；改为 `p.root === abs` 判断。**CLI `delete` 补上 `isDriveRoot` 检查**（此前 Windows 的 `C:\` 也漏过）。
- **符号链接逃逸兜底**：`classifyWithReal` 在守卫判定时同时检查路径字面量与 realpath，指向受保护区的软链无法绕过写/删拦截。
- **快照 id 碰撞**：`createSnapshot` 同秒同标签会覆盖旧快照；追加随机后缀；`snapshotList` 改按 `at` 排序。
- **`restoreSnapshot` 路径越界**：manifest 的 `rel` 未经校验可写出 home；现在对每条记录做 containment 校验，越界即中止且不动任何文件。
- **`lib/state.mjs` / `lib/audit.mjs` / `lib/policy.mjs` / `lib/snapshot-store.mjs` 全面修复并接线/导出**：这四个未提交模块原先从未被引用，其中 `policy.mjs` 与 `snapshot-store.mjs` 因在非 async 函数里用 `await` 连 import 都会语法崩溃。已修复所有逻辑错误（`sessions` 数组误用 `.has`、同步函数调 async `loadState`、JSONL 整体 `JSON.parse`、`stat` 误用为 `lstat`、`isUnder` 未导入、`/proc/mont` 拼写、`fd.read` 参数、diff 永不检测 modified、字符串数字排序、`access` 判断反了、`maxDepth` 不递减、硬编码 `os.homedir()` 等），并将 `state`（持久化守卫计数）与 `audit`（阈值告警）接入 `index.js`；四模块均通过 `exports` 公开。
- **CLI 策略覆盖**：新增 `--write-root` / `--confirm-root` / `--no-home-confirm` / `--keep-trash=N` / `--keep-snapshots=N`，让独立 CLI 的分类与插件配置根对齐。
- **`buildPolicy` 补 POSIX 安装目录候选**：Windows-only 的安装目录保护在 Linux/macOS 上完全缺失；补充常见 POSIX 全局路径（存在才加入）。
- 命名统一：`install.ps1`/`CHANGELOG` 中残留的 `@sugarxl` 拼写改为 `@suagr_xl`；README 安装布局路径补 scoped 全名。

### Changed（架构加固）

- **守卫从"执法"升级为"教育 + 门禁"**：
  - 拒绝消息改为**因果式教育**：为什么拦 / 目标是什么（文件大小/目录内容预览）/ 后果是什么（"改 profile manifest 会让 DSH 启动失败"等） / 正确通道（safe_delete 先预览、或问用户）。
  - systemPrompt 政策段重写为**决策心智**：删/改重要文件前先 preview，再向用户讲清"是什么/为什么/后果/替代方案"，用户明确同意后才动手。
  - 新增**反绕过条款**：一旦被拦就停止，禁止换工具/换路径/编码绕过——从源头掐掉"一直想别的办法"的对抗循环。
  - 新增**防循环升级**：同一目标被拦 2 次后，消息追加 STOP 警告并提示直接问用户；拦截次数进 journal 与审计。
- **策略单一来源**：`buildPolicy` 从插件迁到 `safety-core.mjs`，插件守卫与独立 CLI 共用同一份策略，杜绝两套表面漂移。
- **guard 覆盖 `run_code`**：任意代码执行体的代码文本同样走破坏性扫描（`fs.rmSync`/`shutil.rmtree`/`require('fs').rmSync` + 保护标记），堵住"绕工具边界删文件"的洞。
- **shell 变量引用删除可拦**：`Remove-Item "$env:USERPROFILE\.dsh\…"`、`%APPDATA%\npm\…`、`${HOME}/…` 这类展开后才是真实路径的命令，通过引用+尾段与保护标记比对后拒绝。
- **`restoreSnapshot` 事务化**：先备份现行文件、再从快照复制回，任一阶段失败整体回滚；备份按相对路径存放，修复同名文件互相覆盖的缺陷（曾导致回滚留下孤儿备份）。
- `prepublishOnly` / `pack` 脚本；README 补 `run_code`/变量引用/事务化恢复说明。
- 测试：零依赖单测扩展（新增 `state`/`audit`/`policy`/`snapshot-store` 模块测试与守卫新逻辑测试），`npm test` 跑 `test/` 全目录。

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
