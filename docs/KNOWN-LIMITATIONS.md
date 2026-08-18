# 已知限制（Known Limitations）

诚实说明——它是**安全网**，不是沙箱，也不是 DSH 内核修复。

## 1. 拦截只对模型工具调用生效

guard 在 `ctx.tools.guard()` 层拦截**模型的工具调用**。你在自己终端敲的 `rm -rf` 拦不住——那是 DSH 沙箱的职责。本插件能做的是：事后恢复（回收站/快照）。

## 2. `run_code` 是文本扫描，不是隔离

guard 扫描 `run_code` 代码体，覆盖主流的直白写法（`fs.rmSync`/`shutil.rmtree`/`require('fs')`、`import { rmSync/unlinkSync } from 'node:fs'` 后的裸调用等）。但：
- **动态拼接路径 / 运行时构造调用 / import 别名**（`import { rmSync as purge }` 之类）无法靠文本确定，可能绕过；
- `run_code` 是任意代码执行，**真正隔离它只能靠 DSH 沙箱**。

## 3. shell 命令是文本匹配，有误报/漏报

- 递归识别靠常见写法（`-Recurse`/`-r`/`-rf`/`--recursive`/`/s`/`shutil.rmtree`/`fs.rm recursive` 等）；冷门等价写法（管道删除 `Get-ChildItem | Remove-Item`、`Get-ChildItem ... -Recurse | Remove-Item` 等）可能漏判。
- 变量引用检测覆盖 `$env:X`/`$X`/`${X}`/`%X%`；通配符、命令注入、跨行拼接可能逃过。
- 保护标记（`.dsh`、`node_modules`…）可能误伤**恰好提到这些字样的**非破坏性命令——因此只在"命中破坏性动词"后才触发标记检查。**真实案例**：一条命令里出现 `Remove-Item node_modules` 的字样（哪怕是给人看的说明文字），会被拦——`node_modules` 标记 + 破坏性动词同时出现即判为危险。
- 相对路径按**dsh 进程的 cwd** 解析判断，可能与模型会话的工作区根不同——所以相对路径写入 protected 区时可能判不准（绝对路径无此问题）。

## 4. 不改 DSH 内核，所以治不了"启动即崩"

安全启动、故障隔离、事务化安装、插件子进程隔离，都需要改 DSH 本体。本插件的 `safety_check` 是**预防**，`safety_restore`/`recover.ps1` 是**事后**，都不是"不会崩"的保证。

## 5. `safety_check` 是行级扫描，不是完整 YAML 解析器

能抓 UTF-8/乱码/JSON/重复行 id；复杂的 `!!js` 表达式运行时错误只能靠 `dsh --dump-config` 兜底。

## 6. 回收站/快照存在同一卷

`trashMove` 用 rename（跨卷回退到 copy+rm），同卷最快也最安全。跨卷删除会变成 copy+rm，理论上有中间态。

## 7. 无多进程文件锁

`journal/trash/snapshots` 没有跨进程锁；两个 dsh 进程（如 web + headless）同时操作时可能出现竞争（罕见，但存在）。

## 8. 单 DSH home 假设

面向 `$DSH_HOME`（默认 `~/.dsh`）与 `@deepseek-ai/*`。OCL（`OCL_HOME`、`@ocl/*`）需要适配层，社区版未内置。

## 9. 快照目录请勿公开

`$DSH_HOME/.dsh-safety/` 含日志与（默认已排除凭据后的）快照，仍不建议推上公开仓库。

## 10. 安全中心 web API 的护栏是轻量的

`/safety/api` 的**写操作**（undo/restore/snapshot）要求面板发送的 `X-DSH-Safety: 1` 头——拦得住"碰巧的同源脚本"，但**防不了刻意构造请求的同进程插件**（插件与 dsh 同权）。真正的多租户隔离需 DSH 提供权限模型。

