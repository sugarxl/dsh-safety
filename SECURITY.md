# Security Policy

## Reporting a vulnerability

This plugin enforces filesystem-safety policies inside DeepSeek Harness. If you
find a way to bypass the guard (e.g. a shell delete that slips through, a path
that is not classified as protected/confirm, a way to self-approve a sensitive
operation, or a denial-of-service against DSH), please report it privately
**before** opening a public issue:

- Open a [GitHub Security Advisory](https://github.com/sugarxl/dsh-safety/security/advisories/new)
- or email the maintainers (address TBD)

Please include: the DSH version, the plugin version, a minimal reproduction
(the tool call / command that bypasses the guard), and the expected vs actual
behavior.

## Threat model

The plugin is a **safety net, not a sandbox**. It intercepts **model tool
calls** at the DSH tool-dispatch boundary and gates sensitive operations
behind a human approval flow. It does **not** contain malicious agents,
sandbox an OS user, or protect against:

| Not protected against | Why | Real containment |
|---|---|---|
| Commands the **user** types in their own terminal | The guard only sees model tool calls | DSH sandbox / OS policy |
| A **malicious plugin** running in the same DSH process | Same-process code has the same privileges as dsh-safety; it can read/write `$DSH_HOME/.dsh-safety/state.json` directly, including forging approvals | DSH process isolation / plugin trust model |
| **`run_code`** with dynamic/obfuscated filesystem calls | The scanner is text-based; `fs['rm'+'Sync']`, `import { rmSync as purge }`, runtime-constructed paths can evade it | DSH sandbox |
| Prompt injection steering the agent to try workarounds | The anti-bypass guidance is a soft constraint; only the guard is hard | The guard itself (educational denials + escalation) |

### What the guard protects

- **Protected (no write/edit/delete without a user approval):** profile
  `package.json` / `cordis.patch.yml` / `cordis.yml` / lockfiles /
  `node_modules`, the deployment install dir, home `cordis.patch.yml` and
  `settings.yaml`. Rewriting these can make DSH unbootable.
- **Confirm-delete (delete requires a granted user approval, still
  trash-only):** the entire OS home dir, plugin sources, `.agent-presets`.
- **Recursive directory deletes** are denied everywhere by default and routed
  to `safe_delete` (trash, undoable); `cooperative` mode lets the human grant
  a one-shot approval for free-path recursive shell deletes.
- **Approval integrity:** approvals are one-shot, time-limited (default 5
  minutes), audited, and serialized across processes by an atomic lock
  (`.approval-lock`) so web + headless cannot lose updates on the one-shot
  consume. `force:true` is *not* an approval — only a CLI action by the human
  is.
- **Trust anchor:** every approval request carries a **system-computed
  consequence** (`systemNote`) derived from the real path classification, shown
  separately from the model's self-reported narrative — the model's causal
  story is treated as unverified, not as fact.

### What the guard does NOT guarantee

- Deletes always go to trash and are recoverable — **unless** the human
  explicitly authorizes a `cooperative`-mode recursive shell delete (permanent
  by definition).
- `safety_check` is a line-level scanner, not a full YAML parser. Treat it as a
  tripwire, not a proof of safety.
- Approval *records* can be tampered with by a same-process plugin (see above).
- The approval request's causal narrative (`what`/`why`/`consequence`) is
  **model-authored and unverified**; the `systemNote` gives the human a
  system-backed verdict, but a rubber-stamping human remains the final line.

## Defense-in-depth checklist (recommended configuration)

1. Configure DSH's own **sandbox policy** (`dsh-sandbox-policy`) and
   **user-approval** (`dsh-user-approval`) — they are the first, stronger line.
2. Run dsh-safety in **`mode: strict`** unless you specifically need
   cooperative recursive deletes.
3. Keep `keepTrash` / `keepSnapshots` bounded (defaults 200 / 10) so the
   state dir cannot grow unbounded.
4. Never publish `$DSH_HOME/.dsh-safety/` (journals, snapshots) to a public
   repository.
5. If the agent ever appears to be "trying other ways" after a block, treat it
   as a possible prompt-injection or misbehavior signal and review the audit
   journal (`safety_journal`).
6. Approval writes to `state.json` are serialized by the cross-process lock
   (`.approval-lock`) — don't delete that directory by hand, and prefer keeping
   `$DSH_HOME/.dsh-safety` on a local filesystem (the lock's stale-steal window
   assumes local-disk write latencies).

## Reporting expectations

- Bugs in this plugin are **not** DSH bugs. Please first verify a bypass works
  against the plugin alone (it can be exercised standalone via
  `node test/harness.mjs` without a running DSH).
- We prioritize: guard bypasses > approval self-granting > recovery data loss >
  cosmetic issues.
