# Changelog

本项目使用语义化版本（SemVer）。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.2.1] - 2026-08-19

### Fixed（Linux/macOS 审批匹配跨平台 bug + CI 自诊断盲区）

- **`keyOf` 未归一反斜杠（Linux/macOS 审批子树匹配失效）**：`path.resolve` 在 POSIX 上把 `\` 当字面字符，导致为 `C:\Temp\coop-project` 授予的递归审批在 Linux/macOS 上覆盖不了 `C:\Temp\coop-project\sub\build`——`isUnder` 前缀匹配（`\sub` vs `/`）静默失败。`keyOf` 现把 POSIX 上的反斜杠归一为平台分隔符（Windows 上 no-op），一处修复同时覆盖策略分类（`isUnder`）与审批匹配（`sameTarget`）。补跨平台回归测试。
- **CI 自诊断盲区（导致上一轮误判）**：test.yml 的「Publish failure log」步骤排在 harness 之前——harness 失败时日志永远不会被推送，`ci-logs 无日志` 只代表单测通过、不代表 harness 通过。现发布步骤移到末尾，且 Syntax check 也纳入失败捕获——任何一步失败都会推送到 `ci-logs` 分支，外部可 `git fetch` 读取。
- 测试：69 单测 + harness 全绿。

## [0.2.0] - 2026-08-19

### 发布概览（0.1.x 未正式发布到 npm，全部并入 0.2.0）

- **破坏性变更**：`lib/state.mjs` 移除了 18 个未接线的导出（trash/快照/journal/降级/关停元数据，实际由 `safety-core.mjs` 的文件系统存储承担）——`@suagr_xl/dsh-safety/state` 的 API 面收窄为「守卫计数 + 审批」。
- **信任锚点**：审批请求新增系统计算的权威后果 `systemNote`（真实路径分类得出），CLI 把 `[system]` 判定与模型自述分开呈现——模型因果陈述不再被当作可信输入。
- **跨进程原子锁**：审批「读→改→写」临界区由 `.approval-lock`（mkdir 原子 + 限时重试 + stamp 陈旧窃取）串行化，web + headless 不再并发丢更新。
- **完整性与健壮性**：快照恢复校验 fail-closed（缺 checksum 即拒绝）、`recordBlock` 合并落盘、描述缓存、守卫异常可观测、符号链接父目录逃逸封堵、变量引用归一（Linux）、`state.json` 原子写。
- **文档/工程清理**：死代码、author 乱码、CI 自诊断（失败日志可 `git fetch` 读取）、6 轮审查 CHANGELOG。
- **测试**：68 单测 + 集成 harness，Windows + Linux CI（Node 22/24）全绿。

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

### Fixed（深度逻辑/安全审查，第三轮：路径解析、持久化与解析器边界）

- **符号链接父目录逃逸（真实洞）**：`classifyWithReal` 只解析目标本身——若目标尚不存在（如 `link/newfile`，`newfile` 待创建）而**父目录**是指向受保护区的符号链接，realpath 抛 ENOENT 后按字面路径（free）放行，写入可直达受保护区。现向上爬取**最深已存在祖先**并解析其 realpath，最严格级别生效。
- **`state.json` 非原子写（崩溃损坏）**：整文件直接覆写，写一半崩溃会留下截断/损坏的 JSON（审批记录可能静默丢失）。`saveState`/`saveStateSync` 改为 tmp + rename 原子写。
- **审批压缩会误删已批准的授权**：上一轮「超 500 丢最旧」可能把用户刚批准还没用的授权挤掉。现压缩语义精确：已消费/撤销/过期记录保留最近 250 条历史；pending（未批准）上限 200 条；**已批准未过期的授权永不删除**。
- **写审批可变成不可消费的死记录**：`safety_ask` 带 `recursive:true` 的写请求永远匹配不上写瀑布（写瀑布按 `recursive:false` 消费）。`createApproval` 对写强制 `recursive:false`。
- **审计/告警文件无限增长**：`audit.jsonl`/`alerts.json` 永不裁剪。现超 8MB 自动裁剪（审计保留最近 2 万行、告警 1 万行）。
- **`del /s` / `erase /s` 未判递归**：cmd 递归删文件（含子目录）此前按非递归放行。补入递归识别。
- **`rmSync(...,{recursive:1})` / `{recursive:!0}` 漏检**：仅 `recursive:true` 被识别。正则扩展到 `true|1|!0`。
- **`-Path "C:\...\my file.txt"` 带空格引号路径截断**：flag 正则只抓无空格 token，带空格路径被截断后按 free 放行。现捕获完整引号串（双引号/单引号）。
- **`scanPatchIds` 行内注释漏扫**：`- id: foo # comment` 因行尾锚点失败整行跳过，跨层重复 id 检测失效。支持引号 id 与行内注释。
- 测试：新增 6 组回归（符号链接父目录、`del /s`/`erase /s`/`{recursive:1}`、带空格引号路径、行内注释 id、压缩保护已批准授权、写审批非递归归一）。64 单测 + harness 全绿。

### Fixed（深度逻辑/安全审查，第四轮：恢复完整性、瀑布一致性、CLI 与 I/O 边界）

- **损坏快照可能把损坏传播到现行组合（完整性缺口）**：`restoreSnapshot` 相位 B 之前盲拷快照文件，若快照内容被篡改/损坏（hash 对不上），恢复会把坏内容覆写到 profile。现恢复前逐文件**校验 SHA-256**，与 manifest 不符即中止并整体回滚——恢复永远不会把损坏写回。
- **瀑布层与守卫的符号链接分类不一致（一致性缺口）**：`fs/write-intent`/`fs/edit-intent`/`fs/delete-intent` 用普通 `classify`，守卫已用 `classifyWithReal`——未知名称的写/删工具走瀑布时仍可借符号链接父目录逃逸。瀑布统一改 `classifyWithReal`（最深已存在祖先 realpath）。
- **CLI 缺值静默回退（误操作风险）**：`--home`/`--path`/`--kind`/`--write-root`/`--confirm-root` 缺值时此前静默用默认值，`dsh-safety --home`（忘带路径）会在错误的 home 上执行。现缺值直接报错退出；`=` 形式（`--path=/x`）始终可用。
- **`sha256File` 整文件读入内存**：大 lockfile 等全量载入。改为 64KB 分块流式哈希（与 snapshot-store 一致）。
- 测试：新增 2 组回归（损坏快照校验门、瀑布符号链接父目录），harness 端到端断言 `fs/write-intent` 拦截「经符号链接父目录写受保护区」。65 单测 + harness 全绿。

### Fixed（Linux CI 暴露的跨平台 bug）

- **`resolveVariableRefs` 在 POSIX 上不归一反斜杠（Linux CI 失败根因）**：尾段如 `%DSH_HOME%\profiles\web\x.js` 在 Linux 上 `path.join` 后 `profiles\web\x.js` 仍是**一个含字面反斜杠的文件名组件**，`isUnder`/`classify` 前缀匹配失败 → protected 路径被当成 free，误走 `var-ref` 分支（CI 实测 `actual: 'var-ref' expected: 'protected'`）。现尾段反斜杠统一归一为 `path.sep`（Windows 为 no-op）。新增跨平台回归测试。
- CI 自诊断：`npm test` 失败时完整输出经 `permissions: contents: write` 推送到 `ci-logs` 分支（`branches-ignore` 防循环），外部可直接 `git fetch` 读取失败日志；测试输出同时 `tee` 到步骤日志。66 单测 + harness 全绿。

### Fixed（Linux harness 暴露的 state.json 并发写竞争）

- **审批被并发写覆盖丢（Linux CI 根因）**：守卫拒绝时异步触发 `recordBlock` → `saveState`（先 `await writeFile(tmp)` 再 `await rename`），而审批授予/消费走同步 `saveStateSync`——两者共用同一个 `state.json.tmp`。Linux 上交错时：同步写把共享 tmp rename 走，异步写再 rename 报 **ENOENT**；且异步写提交的是加载时的**旧状态**，会覆盖掉刚批准的审批（harness 实测 `cooperative: a specific-directory recursive approval covers its subtree` 失败）。Windows 调度时序不同未触发。
- **修复**：所有 state 变更（recordBlock/降级/关停/journal/trash/快照记录 + 审批）统一经 `saveStateSync` **同步原子提交**（load→mutate→save 在一个事件循环切片内不可中断）；`saveState`（异步）仅保留给外部消费者，且临时文件名改为**每写唯一**（pid+时间戳+随机），从根上消除共享 tmp 的 ENOENT。66 单测 + harness 全绿（Windows 本地验证）。

### Fixed（整洁度重构：死代码清理、IO 合并、跨进程锁、元数据修正）

- **删除 `state.mjs` 未接线的死代码（18 个导出）**：`addTrashEntry`/`listTrash`/`restoreTrashEntry`/`createSnapshotRecord`/`listSnapshots`/`getSnapshot`/`deleteSnapshot`/`appendJournal`/`journalTail`/`journalByKind`/`journalBySession`/`setDegraded`/`getDegraded`/`getDegradedReason`/`clearDegraded`/`recordShutdown`/`getShutdownReason`/`getState` 及其 SCHEMA 字段（trash/snapshots/journal/degraded/shutdown）。这些与 `safety-core.mjs` 的文件系统存储（trash 目录 / snapshots 目录 / journal.jsonl）重复且无人引用；删除后 state.json 只承载守卫计数 + 审批，单进程内不再有两套状态系统。
- **`recordBlock` 热路径 IO 合并**：拦截计数改为内存累计 + `setImmediate` 合并落盘（同一事件循环片内多次拒绝只写一次磁盘），`getBlockCounts` 合并未落盘计数、立即可见；落盘前重新加载最新 state（不覆盖并发审批），并在跨进程锁内执行。
- **审批跨进程锁**：`createApproval`/`grantApproval`/`revokeApproval`/`consumeApproval` 在 `mkdirSync` 原子锁（`.approval-lock`）内执行读改写临界区——web + headless 双进程下「一次性消费」不再可能被并发丢更新；获取限时重试（5×5ms），超时强制窃取（临界区亚毫秒，活更久必是崩溃残留）。同步实现，守卫热路径可用。
- **author 乱码修正**：package.json `"author"` 由 GBK mojibake `灏忓叞` 更正为 `小兰 (sugarxl)`。
- 测试：state 测试同步适配（合并落盘、新增「flush 不覆盖审批」回归、锁释放与陈旧窃取测试）。66 单测 + harness 全绿。

### Fixed（信任模型与完整性边界，第六轮）

- **审批的因果陈述信任模型（设计级修复）**：`safety_ask` 的 `what`/`why`/`consequence`/`alternative` 此前全部由模型单方填写、系统零核验——而"模型不可信"恰是本插件立身之本。现审批请求新增 `systemNote` 字段：由 `safety_ask` 用真实路径分类（`classifyWithReal`）调用 `explainConsequence` 计算**系统权威后果**，与模型自述分开存储；CLI `approvals` 列表把 `[system]` 判定与 `(model: …)` 自述分开呈现，用户在批准前看到的是系统背书的事实 + 模型孤证，而非混为一谈。
- **跨进程锁的误窃窗口（稳健性修复）**：stale 窃取重试窗口由 25ms（5×5ms）扩到 200ms（10×20ms），并新增基于 stamp 的即时窃取——stamp 年龄超过 5s 的崩溃残留立即清理；stamp 新鲜的锁**永不提前窃取**，慢盘/杀软扫描下活锁不再被误判为死锁、互斥不再被破坏。
- **快照完整性门 fail-closed**：`restoreSnapshot` 此前"manifest 有 sha256 就校验、没有就跳过"——删掉 sha256 字段即可绕过完整性门。现条目缺 checksum 一律拒绝并整体回滚（createSnapshot 始终写 checksum，缺失即篡改/损坏）。
- **`describeTarget` 目录枚举缓存**：守卫拒绝消息的目录内容预览（前 20 项）按 `路径|mtime|size` 记忆化——同一目标反复被拦（防循环场景）不再每次全量 `readdirSync` 大目录阻塞事件循环；缓存上限 100 条。
- 测试：新增 3 组（systemNote 分开存储与呈现、缺 checksum 拒绝恢复、harness 端 `safety_ask` 请求携带系统判定）。68 单测 + harness 全绿。

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
