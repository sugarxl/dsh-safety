# dsh-safety

English | [中文](README.zh.md)

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
  &nbsp;
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square" alt="Dependencies">
  &nbsp;
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square" alt="Node">
  &nbsp;
  <img src="https://img.shields.io/badge/version-0.1.0-blue?style=flat-square" alt="v0.1.0">
  &nbsp;
  <img src="https://img.shields.io/github/actions/workflow/status/sugarxl/dsh-safety/test.yml?style=flat-square&label=CI" alt="CI">
</p>

<p align="center">
  <strong>DSH 安全兜底：拦截无脑删文件 · 删除可撤销 · 组合可回滚 · 重启前体检</strong><br>
  <em>plugin guard · safe_delete · snapshots · pre-restart check · standalone CLI</em>
</p>

<div align="center">

[What](#what) · [Features](#features) · [Install](#install) · [Quick start](#quick-start) · [CLI](#cli-reference) · [Config](#configuration) · [Design](docs/DESIGN.md) · [FAQ](docs/FAQ.md) · [Known limitations](docs/KNOWN-LIMITATIONS.md)

</div>

## What

**A safety harness for DeepSeek Harness (DSH).** Stops the AI agent from
deleting or rewriting the files that make DSH unbootable, makes every delete
recoverable, snapshots the whole plugin composition for one-command rollback,
and checks the composition before you restart.

Zero third-party dependencies. Works as a DSH profile bundle plugin **and** as
a standalone CLI — so the safety net is usable even when DSH is down.

> Why this exists: a real incident — a script silently resolved the wrong
> path (PowerShell's `$HOME` is read-only) and `Remove-Item -Recurse -Force`
> deleted an entire engine runtime root. The only reason it was recoverable is
> that the deleted directory was *generated* content. Anything hand-authored
> would have been gone forever. dsh-safety encodes the lessons of that
> incident as enforced mechanisms, not advice.

## Features

- **Execution-time guard** (`ctx.tools.guard`): denies destructive tool calls
  *before* they run.
  - **Recursive directory deletes are blocked everywhere** (`rm -r/-rf`,
    `Remove-Item -Recurse`, `rd /s`, `rmdir`, `shutil.rmtree`,
    `fs.rm recursive`, `require('fs').rmSync`…) — no matter which path,
    routed to `safe_delete`.
  - `write`/`edit`/`str_replace_editor` on **protected** paths (profile
    `package.json`, `cordis.patch.yml`, `cordis.yml`, lockfiles,
    `node_modules`, the deployment install dir, home patch/settings) are
    denied.
  - Deletes on **confirm** zones (the whole OS home dir, plugin sources,
    agent presets) are denied and routed to `safe_delete`.
  - **`run_code` bodies are scanned too** — arbitrary code execution cannot
    hide an `fs.rmSync`/`shutil.rmtree` on a protected zone behind a tool
    call boundary.
  - **Variable-reference deletes are caught** — `Remove-Item
    "$env:USERPROFILE\.dsh\…"` whose literal path only exists after expansion
    is denied (the reference + tail fragment is matched against protected
    markers).
- **`safe_delete`** — the only sanctioned delete channel. Moves to a trash
  directory (recoverable via `safety_undo`), `preview:true` shows what would
  be removed first, refuses filesystem roots and its own state dir, and
  journals every delete.
- **Composition snapshots** — `safety_snapshot` saves the whole plugin
  composition (per-profile manifests, patches, lockfiles, plugin
  `package.json` + `cordis.patch.yml`, agent presets) with SHA-256 hashes;
  `safety_restore` rolls back to a last-known-good state (current files are
  backed up first). Credential-bearing files are excluded by default.
- **Pre-restart check** — `safety_check` validates UTF-8, detects mojibake
  (wrong-encoding round-trips, the classic "DSH won't open" cause), JSON
  parse errors, and **duplicate plugin row ids across patch layers** (the
  "one row, one layer" rule).
- **Audit journal + web panel** — every block/delete/snapshot/restore is
  journaled; a "Safety Center" settings section shows trash, snapshots,
  journal, and one-click restore/rollback.
- **Standalone CLI** — `dsh-safety` works without DSH: delete/undo/snapshot/
  restore/check from your own terminal, even when DSH won't boot.

## Install

System requirements: a working DeepSeek Harness (`dsh web` boots). npm
install has no extra requirements; installing from the repository needs
Node.js >= 22 and pnpm.

### From npm (recommended)

```sh
dsh plugin --profile web add @sugarxl/dsh-safety
```

`dsh plugin` runs pnpm and reconciles `dsh.profile.bundles` automatically
because this package declares `dsh.bundle`. Restart `dsh web` — the guard is
then active and the `safety_*` tools appear.

> Not published to npm yet — until then use the repository install below.

### From the repository (development)

```sh
git clone https://github.com/sugarxl/dsh-safety.git
cd dsh-safety
dsh plugin --profile web add link:$(pwd)     # symlink the repo into the profile
```

The `link:` protocol symlinks the repo (changes to `lib/` apply after a
restart), unlike `file:` which copies a snapshot. `dsh plugin` reconciles the
bundle automatically. Note: the profile directory is not a pnpm workspace, so
any `workspace:*` deps would fall back to the npm registry — this plugin has
no runtime deps beyond dsh's own peer packages, so no fallback is needed.

### Where it lands (official layout)

Both installs go through the official `dsh plugin` mechanism — nothing else to
configure:

```
$DSH_HOME/profiles/<name>/package.json                # + dependency + dsh.profile.bundles
$DSH_HOME/profiles/<name>/node_modules/dsh-safety/    # the installed package
```

The bundle layer is read at boot from the package's own `cordis.patch.yml`.
The `dsh-safety` row id appears in exactly one layer (that file); never add it
to the profile or home `cordis.patch.yml`.

### Verify & uninstall

```bash
dsh --profile web --dump-config | grep -i dsh-safety   # row present
dsh-safety check                                        # pre-restart gate
# restart dsh web

# uninstall:
dsh plugin --profile web remove @sugarxl/dsh-safety
# restart dsh web
```

### Install troubleshooting

- **Installed, restarted, but nothing changed**: restart the whole `dsh web`
  process — a page refresh is not enough. Confirm the row is mounted with
  `dsh --profile web --dump-config`.
- **`ERR_PNPM_IGNORED_BUILDS`**: pnpm blocks dependency build scripts; add
  the listed packages to `pnpm-workspace.yaml` `allowBuilds` and re-run.
- **pnpm release-age gate installs an old version**: pnpm 11's
  `minimumReleaseAge` can silently pick an older publish within ~10 days; add
  `minimumReleaseAgeExclude: ['@sugarxl/dsh-safety']` to the profile's
  `pnpm-workspace.yaml` and run `dsh plugin --profile web update @sugarxl/dsh-safety`.

### Standalone CLI (no plugin install needed)

```bash
npm link   # or: node bin/dsh-safety.mjs ...
dsh-safety status
```

The CLI reads the same `$DSH_HOME/.dsh-safety` state the plugin uses, so you
can undo/restore from your terminal even if DSH is down.

## Quick start

```bash
# 1. See what's protected
dsh-safety policy

# 2. Before touching any composition file, snapshot
dsh-safety snapshot before-edit

# 3. Delete the safe way (preview first!)
dsh-safety delete path/to/file --preview
dsh-safety delete path/to/file

# 4. Oops — undo it
dsh-safety trash
dsh-safety undo <trash-id>

# 5. DSH won't boot? Check then roll back
dsh-safety check
dsh-safety status          # list snapshots
dsh-safety restore <snapshot-id> --confirm
```

## CLI reference

```
dsh-safety status                  state: trash, snapshots, journal
dsh-safety delete <path> [--force] [--preview]
dsh-safety trash [--limit N]
dsh-safety undo <id>
dsh-safety snapshot [label] [--exclude a,b]
dsh-safety restore <id> --confirm
dsh-safety check                   exit 1 on failure (CI-friendly)
dsh-safety journal [n]
dsh-safety policy                  effective policy zones
dsh-safety help
```

`--home <path>` overrides the state root (`$DSH_HOME` or `~/.dsh` by default).

## Model-facing tools (when installed as a plugin)

| Tool | Purpose |
|---|---|
| `safe_delete` | trash-based delete (preview / force / undoable) |
| `safety_trash` / `safety_undo` | list trash / restore an item |
| `safety_snapshot` / `safety_restore` | snapshot composition / rollback (`confirm:true`) |
| `safety_check` | pre-restart validation (UTF-8 / mojibake / JSON / duplicate ids) |
| `safety_journal` / `safety_status` | audit log / state |

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
```

| Field | Default | Meaning |
|---|---|---|
| `blockWriteRoots` | profile manifests/patches/lockfiles/node_modules, install dir, home patch/settings | no write/edit/delete |
| `confirmDeleteRoots` | `$HOME`, `profiles/*`, `.agent-presets` | no delete without `force` (still trash-only) |
| `snapshotExclude` | `["settings.yaml", ".credentials.yaml"]` | files never copied into snapshots |
| `blockWrites` | `true` | enable the write/edit guard |
| `blockShellDestructive` | `true` | enable the shell-delete guard |
| `audit` | `true` | journal destructive tool calls |
| `keepTrash` / `keepSnapshots` | `200` / `10` | retention limits |

## How it works

Three-tier policy:

| Tier | Allowed | Denied | Default coverage |
|---|---|---|---|
| `protected` | read | write / edit / delete | profile `package.json`/`cordis.patch.yml`/`cordis.yml`/lockfiles/`node_modules`, install dir, home patch & settings |
| `confirm` | read, edit | delete (needs `safe_delete --force`, still trash-only) | entire `$HOME`, plugin sources, agent presets |
| `free` | read/write/delete | recursive delete | regular workspace files |

The guard decision chain, per tool call: destructive verb? → is it a
recursive delete? → does an explicit path hit a protected/confirm zone? → does
a variable-reference fragment (`$env:X\…`, `%X%\…`, `${X}/…`) expand into a
protected zone? → does the command text hit a protected marker (`~`/relative
forms)? → `run_code` code bodies go through the same chain → recursive deletes
are denied **everywhere** as a final rule. Denials are journaled and returned
to the model as errors (never a crash).

A second layer hooks the `fs/write-intent` / `fs/edit-intent` waterfalls and
throws `FS_DENIED` on protected paths regardless of which tool writes.

`buildPolicy` lives in `safety-core.mjs` and is shared by the plugin guard and
the standalone CLI, so the two surfaces can never drift apart.
`restoreSnapshot` is transactional: it backs up live files first, then copies
snapshot files back, and rolls the whole thing back if either phase fails — a
failed rollback never leaves the composition half-restored.

## Structure

```
dsh-safety/
├── bin/
│   └── dsh-safety.mjs        # standalone CLI (zero deps)
├── lib/
│   ├── safety-core.mjs       # pure logic: policy/guard/trash/snapshot/check
│   ├── index.js              # host half: tools, guard, fs hooks, web route
│   └── client.js             # browser half: "Safety Center" settings panel
├── test/
│   ├── safety.test.mjs       # 19 unit tests (zero deps)
│   └── harness.mjs           # 38 integration checks (loads @deepseek-ai)
├── cordis.patch.yml          # bundle patch (inserts the dsh-safety row)
├── package.json              # dsh.bundle + dsh.client + bin
├── install.ps1 / recover.ps1 # local convenience scripts (snapshot→install→verify→rollback)
├── README.md / README.zh.md  # docs (bilingual, officially paired)
└── LICENSE / NOTICE / SECURITY.md
```

## Testing

```bash
node --test test/safety.test.mjs   # 19 unit tests, zero dependencies
node test/harness.mjs              # 38 integration checks against real @deepseek-ai packages
npm run check                      # syntax checks
```

## Troubleshooting

- **DSH won't boot after a plugin change**: run `dsh-safety check` to find
  mojibake / JSON / duplicate-id problems; `dsh --profile web
  --dump-default-config` to see the bundle layer without the user layer;
  `dsh-safety restore <id> --confirm` to roll back a snapshot.
- **The guard blocks something legitimate**: the guard never blocks reads or
  edits of plugin sources; it blocks deletes on `$HOME`/plugin/config zones —
  use `safe_delete` (undoable) instead of raw `rm`.
- **I want to delete something on a protected path**: `safe_delete` with
  `force:true` (or `dsh-safety delete --force`) — it still goes to trash,
  never permanent.

## Security

See [SECURITY.md](SECURITY.md). In short: the guard intercepts **model tool
calls**, not commands you run in your own terminal; `safety_check` is a
line-level scanner, not a full YAML parser. It is a safety net, not a sandbox
— configure DSH's own sandbox/approval for real containment, and use this
plugin for the recovery layer DSH lacks.

## License

MIT. Integration patterns modeled after DeepSeek Harness (MIT); see
[NOTICE](NOTICE).
