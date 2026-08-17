# dsh-safety

一个针对 DeepSeek Harness (DSH) 的**个人安全插件**：把"AI/工具无脑删文件、改配置把 DSH 搞到打不开、装插件把 GUI 弄崩"这类问题兜住。不依赖任何第三方包（只用 dsh 自带的 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-fs`）。

> ⚠️ 教训：本插件就是为一次真实事故写的——一条脚本因 PowerShell `$HOME` 只读变量把路径错位，`Remove-Item -Recurse -Force` 删掉了一个真实的引擎运行根目录。如果当时有这个插件的 guard + safe_delete + 快照，事故会被拦截或一键撤销。那次能恢复只因为被删目录是**可再生成的**（链接指向真实内容）；**自定义内容一旦被删就无可挽回**——这正是本插件存在的意义。

## 它能做什么

### 1. 强制拦截（不是提示词劝告，是执行前拒绝）

注册 `ctx.tools.guard()` 单调守卫，在**任何工具真正执行前**检查：

| 操作 | 路径 / 场景 | 结果 |
|---|---|---|
| **递归删除目录**（`rm -r/-rf`、`Remove-Item -Recurse`、`rd /s`、`rmdir`、`shutil.rmtree`、`fs.rm recursive`） | **任何路径** | ❌ **一律拒绝** → 强制走 `safe_delete`（事故原型：`Remove-Item -Recurse -Force` 删掉整目录） |
| `write` / `edit` / `str_replace_editor` | protected 区（profile 的 `package.json`、`cordis.patch.yml`、`cordis.yml`、lockfile、`node_modules`、安装目录、home 级 `cordis.patch.yml`/`settings.yaml`） | ❌ 拒绝 |
| 删除命令命中 confirm 区（**`$HOME` 整区**、`profiles/*/plugins`、`.agent-presets`） | — | ❌ 拒绝 → 用 `safe_delete`（force 仍只进回收站） |
| 非递归删除 | 普通自由路径 | ✅ 放行（记审计日志） |
| 插件源码编辑（`profiles/*/plugins/.../lib/*.js`） | — | ✅ 放行（正常开发流） |

第二道防线：`fs/write-intent` / `fs/edit-intent` 瀑布钩子，任何途径的写/改 protected 路径都会抛 `FS_DENIED`。

### 2. safe_delete —— 删除永远可撤销、先预览

删除一律走 `safe_delete`（进 `$DSH_HOME/.dsh-safety/trash/`，带时间戳 + 原路径 + 操作者），`safety_undo` 一键还原。受保护/confirm 路径需 `force:true`，**但即便如此也进回收站、永不真正删除**。

- **`preview:true`**：只描述将删除什么（文件大小 / 目录条目数 + 顶层名单），**不动任何文件**——删之前先看。
- 目录删除的结果里始终附上内容清单。
- **绝对拒绝**：文件系统根（`C:\`）、DSH 状态根、以及插件自己的 `.dsh-safety` 状态目录（回收站/快照/日志所在地），`force` 也不行。
- 删除事件全部记入审计日志。

### 3. 快照 / 回滚（last-known-good）

`safety_snapshot` 把整套组合（每个 profile 的 `package.json`/`cordis.patch.yml`/`cordis.yml`/lockfile、home 补丁与设置、所有插件的 `package.json`+`cordis.patch.yml`、agent-preset 组合）带 SHA-256 存进 `$DSH_HOME/.dsh-safety/snapshots/`。改任何组合/插件文件**之前**先快照；启动失败后 `safety_restore`（需 `confirm:true`，现行文件先自动备份）一键回滚。

### 4. safety_check —— 重启前体检（"打不开"的预防）

检查每个组合/配置文件：UTF-8 合法性、**乱码检测**（GBK→UTF-8 错误往返，就是真实发生过的 `鈥?` 事故）、JSON 可解析性、补丁行 id 扫描、**跨层重复 id**（"同一插件行只能出现在一个层"规则）。启动前跑一遍，FAIL 先修再重启。

### 5. 审计日志 + 安全中心面板

- `safety_journal`：回收站、快照、拦截、还原全部留痕。
- `safety_status`：受保护根、拦截计数、回收站/快照数量、最近日志。
- 设置页新增「安全中心」分区（浏览器半区），可视化回收站/快照/日志，可一键还原、回滚、体检。

## 工具一览

| 工具 | 作用 |
|---|---|
| `safe_delete` | 删除进回收站（可撤销；**`preview:true` 先预览**；confirm/受保护路径需 `force`，仍非永久；拒绝根/状态目录） |
| `safety_trash` / `safety_undo` | 列出回收站 / 还原某个条目 |
| `safety_snapshot` / `safety_restore` | 快照整套组合 / 从快照回滚（需 `confirm:true`） |
| `safety_check` | 重启前体检（UTF-8/乱码/JSON/重复 id） |
| `safety_journal` / `safety_status` | 审计日志 / 当前状态（含 guard 是否武装、各策略区） |

## 默认策略（三级）

```
blockWrite（禁写禁删）:
  <DSH_HOME>/profiles/<name>/{package.json,cordis.patch.yml,cordis.yml,pnpm-workspace.yaml,pnpm-lock.yaml}
  <DSH_HOME>/profiles/<name>/node_modules
  <DSH_HOME>/profiles/node_modules
  <DSH_HOME>/cordis.patch.yml  <DSH_HOME>/settings.yaml
  部署安装目录（AppData\Roaming\npm\node_modules\@deepseek-ai\dsh）

confirmDelete（禁删、允许编辑；删除须 safe_delete force，仍只进回收站）:
  $HOME（OS 用户主目录，整区）—— 事故复盘：被误删的目录正属此区
  <DSH_HOME>/profiles（含 plugins 插件源码，可编辑）
  <DSH_HOME>/.agent-presets
```

可在补丁行配置追加 `blockWriteRoots` / `confirmDeleteRoots`（旧名 `blockDeleteRoots` 兼容），或关闭某道防线（`blockWrites: false` / `blockShellDestructive: false` / `audit: false` / `homeIsConfirm: false`）。

## 安装（个人插件，按本机统一规则）

**个人插件统一收进聚合包** `profiles/web/plugins/dsh-personal-plugin/`，子插件直接放聚合包根下，行只插入聚合包的 `cordis.patch.yml` **一次**：

```powershell
# 1) 复制到聚合包根下（直接在聚合包根，不要套 plugins/ 子目录）
Copy-Item -Recurse .\dsh-safety "$env:USERPROFILE\.dsh\profiles\web\plugins\dsh-personal-plugin\dsh-safety"

# 2) 在聚合包 cordis.patch.yml 追加一行（先确认没有重复）
#    - insert:
#        - id: dsh-safety
#          name: dsh-safety

# 3) 聚合包 package.json 的 dependencies 加
#    "dsh-safety": "workspace:*"

# 4) 在 profiles/web 目录跑
pnpm install

# 5) 重启前体检 + 验证
dsh --profile web --dump-config | findstr dsh-safety
# 6) 重启 dsh web
```

**推荐用 `install.ps1`**：自动先快照 → 复制 → 改两处 → pnpm install → dump-config 校验 → 失败自动回滚（详见下文）。

## 测试

```sh
node --test test/safety.test.mjs   # 14 个纯逻辑单元测试
node test/harness.mjs              # 38 项真实加载 @deepseek-ai 包的 apply() 集成检查
```

## 文件

- `lib/safety-core.mjs` — 纯逻辑（保护路径/删除识别/乱码/JSON/重复 id/回收站/快照/校验），零依赖，可单测
- `lib/index.js` — host 半区：工具注册 + guard + fs 瀑布 + 审计 + `/safety/api` 路由
- `lib/client.js` — browser 半区：「安全中心」设置页
- `cordis.patch.yml` / `package.json` — bundle 插件清单
- `test/safety.test.mjs` / `test/harness.mjs` — 测试
- `install.ps1` / `recover.ps1` — 安全安装（快照→装→验→回滚）/ 启动失败急救

## 已知边界（诚实说明）

- **shell 删除是"软拦截"**：`tools.guard` 只能拦截模型工具调用（`pwsh`/`bash` 命令文本命中破坏性动词 + 路径/标记）；若用户自己在真实终端执行删除，插件拦不住——但 safe_delete + 快照仍可事后恢复。
- **递归删除识别靠命令文本**：`isRecursiveDelete` 匹配常见写法（`-Recurse`/`-r`/`-rf`/`/s`/`shutil.rmtree`/`fs.rm recursive`）。冷门的等价写法（如 `Get-ChildItem | Remove-Item` 管道）可能漏判——但路径命中 confirm/protected 区仍会被拦。
- `safety_check` 的补丁解析是**行级扫描**（非完整 YAML 解析器），能抓重复 id / 乱码 / JSON 错误，但复杂 `!!js` 表达式运行时错误只能靠 `--dump-config` 兜底。
- confirm 区（尤其 `$HOME`）的**编辑不受限**——只限制删除。这是有意为之：不能因保护而阻塞正常开发。
- 普通项目文件（不在 `$HOME`/DSH 目录下的工作区）只受"递归删除拦截 + safe_delete 习惯"保护。

## License

MIT。
