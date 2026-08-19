# dsh-safety

English | [中文](README.zh.md)

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
  <strong>Filesystem safety harness for DeepSeek Harness</strong><br>
  <em>execution-time guard · user-gated approvals · trash-based deletes · composition snapshots · pre-restart checks · standalone CLI</em>
</p>

<div align="center">

[What](#what) · [Features](#features) · [Approval workflow](#approval-workflow) · [Install](#install) · [Quick start](#quick-start) · [CLI](#cli-reference) · [Tools](#model-facing-tools) · [Config](#configuration) · [How it works](#how-it-works) · [Structure](#structure) · [Testing](#testing) · [Troubleshooting](#troubleshooting) · [Security](#security) · [Design](docs/DESIGN.md) · [FAQ](docs/FAQ.md) · [Known limitations](docs/KNOWN-LIMITATIONS.md)

</div>

## What

A filesystem safety harness for DeepSeek Harness (DSH). It enforces a
three-tier file policy at the tool-execution boundary and, crucially, makes
the agent **ask the human before it deletes or rewrites anything important**:

- destructive agent calls are denied **before** they run, with an educational
  message explaining *what* the target is, *why* it matters, and *what* the
  sanctioned alternative is;
- every delete is routed through a recoverable trash;
- the plugin composition can be snapshotted and rolled back transactionally;
- the composition is validated before a restart;
- sensitive deletes/writes require a **one-shot, time-limited user approval** —
  the model can never authorize itself.

The package has zero runtime dependencies. It installs as a standard DSH
profile bundle and also ships a standalone CLI, so the recovery and approval
layer remains usable even when DSH itself will not start.

> **Background** — the guard rules are derived from a real production
> incident: a script silently resolved the wrong path (PowerShell's `$HOME`
> is read-only) and `Remove-Item -Recurse -Force` deleted an entire engine
> runtime root. The directory was recoverable only because it was generated
> content; hand-authored files would have been lost permanently. The plugin
> turns the lessons of that incident into enforced mechanisms rather than
> documentation.

## Features

- **Execution-time guard** (`ctx.tools.guard`) — denies destructive tool calls
  *before* they run.
  - **Recursive directory deletes** (`rm -r/-rf`, `Remove-Item -Recurse`,
    `rd /s`, `rmdir`, `shutil.rmtree`, `fs.rm recursive`,
    `require('fs').rmSync`…) are denied by default and routed to `safe_delete`
    (trash, undoable). In `cooperative` mode a human-granted approval can
    authorize a free-path recursive shell delete.
  - `write`/`edit`/`str_replace_editor` on **protected** paths (profile
    `package.json`, `cordis.patch.yml`, `cordis.yml`, lockfiles,
    `node_modules`, the deployment install dir, home patch/settings) are
    denied unless the user has granted an approval.
  - Deletes on **confirm** zones (the whole OS home dir, plugin sources,
    agent presets) are denied and require a granted user approval.
  - **`run_code` bodies are scanned too** — arbitrary code execution cannot
    hide an `fs.rmSync`/`shutil.rmtree` on a protected zone behind a tool
    call boundary.
  - **Variable-reference deletes are caught** — `Remove-Item
    "$env:USERPROFILE\.dsh\…"` whose literal path only exists after expansion
    is denied (the reference + tail fragment is matched against protected
    markers).
- **Educational, anti-bypass denials** — a blocked call returns *why* it was
  blocked, *what* the target is, *what* the consequence would be, and *what*
  the sanctioned path is; the system prompt tells the agent to stop trying
  workarounds and ask the user instead; after repeated blocks for the same
  target the guard escalates with an explicit STOP.
- **User-gated approval system** — `safety_ask` creates a structured request
  (what / why / consequence / alternative); the human approves via
  `dsh-safety allow <id>` (or `dsh-safety delete --force`); the approval is
  **one-shot, time-limited and audited**. The model can never grant itself one
  — a `force:true` flag alone is not an approval.
- **`safe_delete`** — the only sanctioned delete channel. Moves to a trash
  directory (recoverable via `safety_undo`), `preview:true` shows what would
  be removed first, refuses filesystem roots and its own state dir, and
  journals every delete.
- **Composition snapshots** — `safety_snapshot` saves the whole plugin
  composition (per-profile manifests, patches, lockfiles, plugin
  `package.json` + `cordis.patch.yml`, agent presets) with SHA-256 hashes;
  `safety_restore` rolls back to a last-known-good state transactionally
  (current files are backed up first; a failed rollback never leaves the
  composition half-restored). Credential-bearing files are excluded by default.
- **Pre-restart check** — `safety_check` validates UTF-8, detects mojibake
  (wrong-encoding round-trips, the classic "DSH won't open" cause), JSON
  parse errors, and **duplicate plugin row ids across patch layers** (the
  "one row, one layer" rule).
- **Audit journal** — every block/approval/delete/snapshot/restore is
  journaled and readable via `safety_journal` / `safety_status`.
- **Standalone CLI** — `dsh-safety` works without DSH: policy / delete /
  undo / snapshot / restore / check / approve from your own terminal, even
  when DSH won't boot.

## Approval workflow

The whole point of the approval system is that **the model can never approve
its own destructive calls**. A flag it can set (`force:true`) is not a
confirmation — only a human action (CLI) is.

```
agent calls delete/write on a confirm/protected zone
        │
        ▼
guard BLOCKS it (educational message: what / why / consequence / sanctioned path)
        │
        ▼
agent calls safety_ask { path, kind, what, why, consequence, alternative }
        │   → creates a request, returns an id, journals it
        ▼
agent tells the user:  "please approve: dsh-safety allow <id>"
        │
        ▼
USER runs  dsh-safety allow <id>        (or: dsh-safety delete --force)
        │   → grants a one-shot, time-limited approval (default 5 min)
        ▼
agent retries the original call → guard consumes the approval and LETS IT THROUGH
        │   (the approval is now spent; a second call is blocked again)
        ▼
everything is audited: who requested, who approved, when, when it was consumed
```

Practical details:

- **Requesting**: when a call is blocked, the denial message tells the agent
  to call `safety_ask` with the causality. The request carries
  `what`/`why`/`consequence`/`alternative`, so the user can make an informed
  decision.
- **Approving**: `dsh-safety allow <id>` approves an agent-created request.
  `dsh-safety allow --path <p> --kind delete|write [--recursive]` creates and
  approves one directly (you are the human). `dsh-safety delete --force` on a
  confirm/protected path also grants the approval it needs and then moves the
  item to trash.
- **One-shot**: an approval is consumed by the first matching call
  (exact kind + exact target; recursive approvals are exact on the flag and
  may be target-agnostic). After that it is spent.
- **Time-limited**: a granted approval expires after `approvalTtlMs`
  (default 5 minutes) and must be re-granted.
- **Approved calls run as written — `safe_delete` is the trash channel**: an
  approved raw retry (e.g. a `Remove-Item` re-run) executes as-is; that is
  exactly what the human authorized. If you want the operation recoverable,
  have the agent use `safe_delete` (always trash, undoable) instead of raw
  shell. Recursive raw deletes on **protected/confirm** paths are *never*
  approvable via raw shell — they always go through `safe_delete`.
- **Strict vs cooperative**: in `mode: strict` (default), raw recursive shell
  deletes are *never* approvable — the only way to remove a directory tree is
  `safe_delete` (trash, undoable). In `mode: cooperative`, the human can
  authorize a *free-path* recursive shell delete with a generic recursive
  approval (`dsh-safety allow --path … --recursive`).
- **Anti-loop**: if the agent retries the same blocked target repeatedly, the
  guard escalates and tells it to stop and ask the user.

## Install

System requirements: a working DeepSeek Harness (`dsh web` boots). npm
install has no extra requirements; installing from the repository needs
Node.js >= 22 and pnpm.

### From npm (recommended)

```sh
dsh plugin --profile web add @suagr_xl/dsh-safety   # install from the official npm registry / 从官方 npm registry 安装
```

`dsh plugin` runs pnpm and reconciles `dsh.profile.bundles` automatically
because this package declares `dsh.bundle`. Restart `dsh web` — the guard is
then active and the `safety_*` tools appear.

### From the repository (development)

```sh
git clone https://github.com/sugarxl/dsh-safety.git   # clone the repo / 克隆仓库
cd dsh-safety                                         # enter the directory / 进入目录
dsh plugin --profile web add link:$(pwd)              # symlink the repo into the profile / 把仓库软链进 profile
```

The `link:` protocol symlinks the repo (changes to `lib/` apply after a
restart), unlike `file:` which copies a snapshot. `dsh plugin` reconciles the
bundle automatically. Note: the profile directory is not a pnpm workspace, so
any `workspace:*` deps would fall back to the npm registry — this plugin has
**zero runtime dependencies at all** (its imports are only Node builtins + its
own `safety-core.mjs`/`state.mjs`/`audit.mjs`), so a bare `link:` install works
with no `node_modules` of its own and no fallback is needed.

### Where it lands (official layout)

Both installs go through the official `dsh plugin` mechanism — nothing else to
configure:

```
$DSH_HOME/profiles/<name>/package.json                # + dependency + dsh.profile.bundles / 新增依赖 + dsh.profile.bundles
$DSH_HOME/profiles/<name>/node_modules/@suagr_xl/dsh-safety/    # the installed package / 安装的包本体
```

The bundle layer is read at boot from the package's own `cordis.patch.yml`.
The `dsh-safety` row id appears in exactly one layer (that file); never add it
to the profile or home `cordis.patch.yml`.

### Verify & uninstall

```bash
dsh --profile web --dump-config | grep -i dsh-safety   # row present / 确认行出现
dsh-safety check                                        # pre-restart gate / 重启前体检
# restart dsh web / 重启 dsh web

# uninstall: / 卸载：
dsh plugin --profile web remove @suagr_xl/dsh-safety
# restart dsh web / 重启 dsh web
```

### Install troubleshooting

- **Installed, restarted, but nothing changed**: restart the whole `dsh web`
  process — a page refresh is not enough. Confirm the row is mounted with
  `dsh --profile web --dump-config`.
- **`ERR_PNPM_IGNORED_BUILDS`**: pnpm blocks dependency build scripts; add
  the listed packages to `pnpm-workspace.yaml` `allowBuilds` and re-run.
- **pnpm release-age gate installs an old version**: pnpm 11's
  `minimumReleaseAge` can silently pick an older publish within ~10 days; add
  `minimumReleaseAgeExclude: ['@suagr_xl/dsh-safety']` to the profile's
  `pnpm-workspace.yaml` and run `dsh plugin --profile web update @suagr_xl/dsh-safety`.

### Standalone CLI (no plugin install needed)

```bash
npm link   # or: node bin/dsh-safety.mjs ...
dsh-safety status
```

The CLI reads the same `$DSH_HOME/.dsh-safety` state the plugin uses, so you
can approve/undo/restore from your terminal even if DSH is down.

## Quick start

```bash
# 1. Inspect the effective policy zones
dsh-safety policy

# 2. Snapshot before editing any composition file
dsh-safety snapshot before-edit

# 3. Delete through the safe channel (preview first, then execute)
dsh-safety delete path/to/file --preview      # free path — just works
dsh-safety delete path/to/file                # moves to trash (undoable)
dsh-safety delete path/to/important --force   # confirm/protected zone:
                                              #   --force IS the human approval here

# 4. Recover a delete
dsh-safety trash
dsh-safety undo <trash-id>

# 5. Boot failure: validate, then roll back
dsh-safety check
dsh-safety status          # list snapshots + pending approvals
dsh-safety restore <snapshot-id> --confirm

# 6. Approve a request the agent created (model asked via safety_ask)
dsh-safety approvals
dsh-safety allow <request-id>
```

## CLI reference

```
dsh-safety status                  state: trash, snapshots, approvals, journal
dsh-safety delete <path> [--force] [--preview]
dsh-safety trash [--limit N]
dsh-safety undo <id>
dsh-safety snapshot [label] [--exclude a,b]
dsh-safety restore <id> --confirm
dsh-safety check                   exit 1 on failure (CI-friendly)
dsh-safety journal [n]
dsh-safety policy                  effective policy zones
dsh-safety approvals               list pending/granted approval requests
dsh-safety allow <id>              approve a request the agent created
dsh-safety allow --path <p> [--kind delete|write] [--recursive]   approve a new one directly
dsh-safety revoke <id>             revoke a request
dsh-safety help
```

`--home <path>` overrides the state root (`$DSH_HOME` or `~/.dsh` by default).

The plugin's configured roots live in the cordis patch layers, which a
standalone CLI cannot read — so `delete`/`policy` accept the same overrides to
align with the running guard:

```
--write-root <path>      add a protected (no write/edit/delete) root
--confirm-root <path>    add a confirm-delete (trash-only) root
--no-home-confirm        do NOT make the whole OS home a confirm zone
--keep-trash=N / --keep-snapshots=N    retention caps after delete/snapshot
```

> The CLI is the human side of the approval flow: `dsh-safety delete --force`
> and `dsh-safety allow` are REAL user authorizations (recorded in state); the
> model can never grant itself an approval.

## Model-facing tools (when installed as a plugin)

| Tool | Purpose |
|---|---|
| `safe_delete` | trash-based delete (preview / user approval / undoable). `force:true` is NOT a user approval — the deletion needs a granted approval first |
| `safety_ask` | request the user's approval with the causality (what / why / consequence / alternative); the user approves via `dsh-safety allow <id>` |
| `safety_trash` / `safety_undo` | list trash / restore an item |
| `safety_snapshot` / `safety_restore` | snapshot composition / rollback (`confirm:true`) |
| `safety_check` | pre-restart validation (UTF-8 / mojibake / JSON / duplicate ids) |
| `safety_journal` / `safety_status` | audit log / state (incl. pending approvals) |

## Configuration

Configure via the bundle row in a patch layer (e.g. the profile's
`cordis.patch.yml`):

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
    mode: strict            # strict | cooperative
    approvalTtlMs: 300000   # approval validity window (5 min default)
```

| Field | Default | Meaning |
|---|---|---|
| `blockWriteRoots` | profile manifests/patches/lockfiles/node_modules, install dir, home patch/settings | no write/edit/delete |
| `confirmDeleteRoots` | `$HOME`, `profiles/*`, `.agent-presets` | no delete without a granted user approval (still trash-only) |
| `snapshotExclude` | `["settings.yaml", ".credentials.yaml"]` | files never copied into snapshots |
| `blockWrites` | `true` | enable the write/edit guard |
| `blockShellDestructive` | `true` | enable the shell-delete guard |
| `audit` | `true` | journal destructive tool calls |
| `keepTrash` / `keepSnapshots` | `200` / `10` | retention limits |
| `mode` | `strict` | `strict`: recursive shell deletes are never approvable; `cooperative`: the human can authorize them via the approval flow |
| `approvalTtlMs` | `300000` | how long a granted approval stays valid before it must be re-granted |

## How it works

Three-tier policy:

| Tier | Allowed | Denied | Default coverage |
|---|---|---|---|
| `protected` | read | write / edit / delete (unless a user approval is granted) | profile `package.json`/`cordis.patch.yml`/`cordis.yml`/lockfiles/`node_modules`, install dir, home patch & settings |
| `confirm` | read, edit | delete (needs a granted user approval) | entire `$HOME`, plugin sources, agent presets |
| `free` | read/write/delete | recursive delete (approvable in `cooperative` mode) | regular workspace files |

The guard decision chain, per tool call: destructive verb? → is it a
recursive delete? → does an explicit path hit a protected/confirm zone? → does
a variable-reference fragment (`$env:X\…`, `%X%\…`, `${X}/…`) expand into a
protected zone? → does the command text hit a protected marker (`~`/relative
forms)? → `run_code` code bodies go through the same chain. A matching,
granted user approval lets the call through once; otherwise it is denied.

Denials are **educational**: they name the target, describe it, explain the
consequence (e.g. "rewriting this can make DSH fail to boot") and the
sanctioned path (`safe_delete` / `safety_ask`), and tell the agent not to try
workarounds. Repeated blocks for the same target escalate to an explicit STOP.
Denials are journaled and returned to the model as errors (never a crash).

A second layer hooks the `fs/write-intent` / `fs/edit-intent` waterfalls and
throws `FS_DENIED` on protected paths regardless of which tool writes.

`buildPolicy` lives in `safety-core.mjs` and is shared by the plugin guard and
the standalone CLI, so the two surfaces can never drift apart.
`restoreSnapshot` is transactional: it backs up live files first, then copies
snapshot files back, and rolls the whole thing back if either phase fails — a
failed rollback never leaves the composition half-restored. Approval state
lives in `$DSH_HOME/.dsh-safety/state.json`, shared by the guard, `safe_delete`
and the CLI.

## Structure

```
dsh-safety/
├── bin/
│   └── dsh-safety.mjs        # standalone CLI (zero deps)
├── lib/
│   ├── safety-core.mjs       # pure logic: policy/guard/trash/snapshot/check
│   ├── index.js              # host half: tools, guard, fs hooks
│   ├── state.mjs             # persisted state (approvals, guard counters, journal) — wired into index.js
│   ├── audit.mjs             # JSONL audit log + threshold alerts — wired into index.js
│   ├── policy.mjs            # policy refinement utilities (symlink/mount detection, exported)
│   └── snapshot-store.mjs    # incremental snapshot utilities (baseline/delta, exported)
├── test/
│   ├── safety.test.mjs       # unit tests: core guard/trash/snapshot/check
│   ├── state.test.mjs        # state persistence + approval lifecycle
│   ├── audit.test.mjs        # audit log + alerts
│   ├── policy.test.mjs       # policy refinement
│   ├── snapshot-store.test.mjs # incremental snapshots
│   └── harness.mjs           # integration checks (clean checkout, zero deps)
├── cordis.patch.yml          # bundle patch (inserts the dsh-safety row)
├── package.json              # dsh.bundle + bin
├── install.ps1 / recover.ps1 # local convenience scripts (snapshot→install→verify→rollback)
├── README.md / README.zh.md  # docs (bilingual, officially paired)
└── LICENSE / NOTICE / SECURITY.md
```

## Testing

```bash
npm test                        # all unit tests (core + state/audit/policy/snapshot-store)
node test/harness.mjs           # integration checks, clean checkout (no @deepseek-ai needed)
npm run check                   # syntax checks on every lib/bin module
```

## Troubleshooting

- **DSH won't boot after a plugin change**: run `dsh-safety check` to find
  mojibake / JSON / duplicate-id problems; `dsh --profile web
  --dump-default-config` to see the bundle layer without the user layer;
  `dsh-safety restore <id> --confirm` to roll back a snapshot.
- **The guard blocks something legitimate**: the guard never blocks reads or
  edits of plugin sources; it blocks deletes on `$HOME`/plugin/config zones
  and asks the human for approval. Use `safe_delete` (undoable) instead of raw
  `rm`; for a confirm/protected path, let the agent create a `safety_ask`
  request and approve it with `dsh-safety allow <id>`.
- **A protected path needs to be deleted**: from the CLI, `dsh-safety delete
  <path> --force` — the CLI user is the human, so `--force` is a real approval
  and the item still goes to trash, never permanent. From the model side, a
  granted approval is required (`force:true` alone is not enough).
- **The agent keeps trying workarounds after a block**: that is exactly what
  the guard is built to stop. Tell it to call `safety_ask` and wait for your
  approval, or deny the request.

## Security

See [SECURITY.md](SECURITY.md) for the full threat model. In short: the guard
intercepts **model tool calls**, not commands you run in your own terminal;
`run_code` scanning is text-based and can be outsmarted by dynamic/obfuscated
code; approval records in `state.json` can be tampered with by a
same-process plugin. It is a safety net, not a sandbox — configure DSH's own
sandbox/approval for real containment, and use this plugin for the recovery
and ask-the-human layer DSH lacks.

## License

MIT. Integration patterns modeled after DeepSeek Harness (MIT); see
[NOTICE](NOTICE).
