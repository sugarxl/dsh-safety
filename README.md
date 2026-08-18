# dsh-safety

English | [中文](README.zh.md)

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
    `fs.rm recursive`) — no matter which path, routed to `safe_delete`.
  - `write`/`edit`/`str_replace_editor` on **protected** paths (profile
    `package.json`, `cordis.patch.yml`, `cordis.yml`, lockfiles,
    `node_modules`, the deployment install dir, home patch/settings) are
    denied.
  - Deletes on **confirm** zones (the whole OS home dir, plugin sources,
    agent presets) are denied and routed to `safe_delete`.
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

The plugin is a standard DSH profile bundle. Pick one:

### Option A — install into any profile via `dsh plugin` (recommended)

```bash
# from the repo root
dsh plugin --profile web add file:$(pwd)
# or with an absolute path:
#   dsh plugin --profile web add file:/abs/path/to/dsh-safety
```

`dsh plugin` runs pnpm and automatically adds the package to
`dsh.profile.bundles` when it declares `dsh.bundle` (this package does).

### Option B — local `link:` dependency

```bash
cd ~/.dsh/profiles/web
pnpm add "link:/abs/path/to/dsh-safety"
# reconcile adds it to dsh.profile.bundles automatically on next boot
```

### Option C — personal-plugin aggregate (this machine's convention)

If your deployment keeps personal plugins in a `dsh-personal-plugin`
aggregate bundle, copy the directory under the aggregate root, add one insert
row to the aggregate's `cordis.patch.yml`, add `"dsh-safety": "workspace:*"`
to its `package.json`, then `pnpm install` in the profile dir. See
`install.ps1` for a scripted, snapshot-and-rollback version of this path.

### Verify + restart

```bash
dsh --profile web --dump-config | grep -i dsh-safety   # row present
dsh-safety check                                        # pre-restart gate
# restart dsh web
```

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
the command text hit a protected marker (`~`/relative forms)? → recursive
deletes are denied **everywhere** as a final rule. Denials are journaled and
returned to the model as errors (never a crash).

A second layer hooks the `fs/write-intent` / `fs/edit-intent` waterfalls and
throws `FS_DENIED` on protected paths regardless of which tool writes.

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
│   ├── safety.test.mjs       # 14 unit tests (zero deps)
│   └── harness.mjs           # 38 integration checks (loads @deepseek-ai)
├── cordis.patch.yml          # bundle patch (inserts the dsh-safety row)
├── package.json              # dsh.bundle + dsh.client + bin
├── install.ps1 / recover.ps1 # local convenience scripts (snapshot→install→verify→rollback)
├── README.md / README.zh.md  # docs (bilingual, officially paired)
└── LICENSE / NOTICE / SECURITY.md
```

## Testing

```bash
node --test test/safety.test.mjs   # 14 unit tests, zero dependencies
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
