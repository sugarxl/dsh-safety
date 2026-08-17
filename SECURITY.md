# Security Policy

## Reporting a vulnerability

This plugin enforces filesystem-safety policies inside DeepSeek Harness. If you
find a way to bypass the guard (e.g. a shell delete that slips through, or a
path that is not classified as protected/confirm), please report it privately
**before** opening a public issue:

- Open a [GitHub Security Advisory](https://github.com/YOUR_NAME/dsh-safety/security/advisories/new)
- or email the maintainers (address TBD)

Please include: the DSH version, the plugin version, a minimal reproduction
(the tool call / command that bypasses the guard), and the expected vs actual
behavior.

## What is (and is not) protected

- The guard intercepts **model tool calls** (`pwsh`/`bash`/`write`/`edit`/
  `str_replace_editor`) before execution. It cannot intercept commands the
  user runs in their own terminal.
- The `confirmDelete` policy makes deletes go through the trash (recoverable);
  it does not make deletion impossible.
- `safety_check` is a line-level scanner, not a full YAML parser. Treat it as a
  tripwire, not a proof of safety.
