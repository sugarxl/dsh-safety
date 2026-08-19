# 已知限制（Known Limitations）

本插件是**安全网**，不是沙箱，也不是 DSH 内核修复。以下限制如实列出。

## 1. 拦截只对模型工具调用生效

guard 在 `ctx.tools.guard()` 层拦截**模型的工具调用**。用户在真实终端执行的命令（如 `rm -rf`）不在拦截范围内——那是 DSH 沙箱的职责。本插件能提供的是事后恢复（回收站/快照）。

## 2. `run_code` 是文本扫描，不是隔离

guard 扫描 `run_code` 代码体，覆盖主流的直白写法（`fs.rmSync`/`shutil.rmtree`/`require('fs')`、`import { rmSync/unlinkSync } from 'node:fs'` 后的裸调用、`fs.writeFileSync(绝对路径)` 写受保护路径等）。但：
- **动态拼接路径 / 运行时构造调用 / import 别名**（`import { rmSync as purge }` 之类）无法靠文本确定，可能绕过；
- **相对路径/变量拼接的写**（`fs.writeFileSync('.dsh/profiles/...')`）不做 marker 兜底（会误杀 confirm 区合法编辑），只拦显式绝对路径——相对写法是已知局限；
- `run_code` 是任意代码执行，**真正隔离它只能靠 DSH 沙箱**。

## 3. shell 命令是文本匹配，有误报/漏报

- 递归识别靠常见写法（`-Recurse`/`-r`/`-rf`/`--recursive`/`/s`/`shutil.rmtree`/`fs.rm recursive` 等）；冷门等价写法（管道删除 `Get-ChildItem | Remove-Item`、`Get-ChildItem ... -Recurse | Remove-Item` 等）可能漏判。
- 变量引用检测覆盖 `$env:X`/`$X`/`${X}`/`%X%`；其中 **已知变量**（`HOME`/`USERPROFILE`/`DSH_HOME`/`APPDATA`/`TEMP`/`TMP`）会被解析成字面路径后按 protected/DSH-home 分类拦截（自定义 DSH_HOME 也能挡住）；**未知变量**、通配符、命令注入、跨行拼接仍可能逃过。
- 保护标记（`.dsh`、`node_modules`…）可能误伤**恰好提到这些字样的**非破坏性命令——因此只在"命中破坏性动词"后才触发标记检查。实测案例：一条命令里出现 `Remove-Item node_modules` 的字样（哪怕是给人看的说明文字）也会被拦——`node_modules` 标记与破坏性动词同时出现即判为危险。
- 相对路径按**dsh 进程的 cwd** 解析判断，可能与模型会话的工作区根不同——所以相对路径写入 protected 区时可能判不准（绝对路径无此问题）。

## 4. 不改 DSH 内核，所以治不了"启动即崩"

安全启动、故障隔离、事务化安装、插件子进程隔离，都需要改 DSH 本体。本插件的 `safety_check` 是**预防**，`safety_restore`/`recover.ps1` 是**事后**，都不是"不会崩"的保证。

## 5. `safety_check` 是行级扫描，不是完整 YAML 解析器

能抓 UTF-8/乱码/JSON/重复行 id；复杂的 `!!js` 表达式运行时错误只能靠 `dsh --dump-config` 兜底。

## 6. 回收站/快照存在同一卷

`trashMove` 用 rename 实现（跨卷时回退到 copy+rm）；同卷下最快且无中间态，跨卷删除存在理论上的中间态。

## 7. 无多进程文件锁

`journal/trash/snapshots/state.json` 没有跨进程锁；两个 dsh 进程（如 web + headless）同时操作时可能出现竞争（罕见，但存在）。审批的"一次性"在极端并发下可能被同时消费两次（随后一次放行、审计留痕）。

## 8. 单 DSH home 假设

面向 `$DSH_HOME`（默认 `~/.dsh`）与 `@deepseek-ai/*`。OCL（`OCL_HOME`、`@ocl/*`）需要适配层，社区版未内置。

## 9. 快照目录请勿公开

`$DSH_HOME/.dsh-safety/` 含日志与（默认已排除凭据后的）快照，仍不建议推上公开仓库。

## 10. 审批只发生在人机通道

删除/改写敏感文件的批准走 `dsh-safety allow`（CLI）等**人类入口**；同进程插件与 dsh 同权，若它直接篡改 `$DSH_HOME/.dsh-safety/state.json` 里的审批记录仍可绕过——真正的多租户隔离需 DSH 提供权限模型。

## 11. 审批依赖"人会认真看"

`dsh-safety allow <id>` 只需要一条命令，模型可以"请用户批准"并催促——若用户**无脑放行**（橡皮图章），审批门禁就退化为"带审计的自动放行"。缓解：审批一次性 + 限时（5 分钟） + 全审计，且灾难级操作（改 protected、删目录树）仍默认硬拒（`strict` 模式递归删除不可批准）。但最终安全水位取决于用户的确认习惯。

## 12. 教育式拒绝不是强制行为约束

反绕过条款写在 systemPrompt 与拒绝消息里，是**软约束**：模型可能不服从（或被提示词注入带偏）。真正的强制只发生在守卫拦截层；教育只是降低对抗尝试的概率，不能替代硬拦截。

