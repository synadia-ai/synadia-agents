---
name: configure
description: Configure NATS channel — select context, set session name, configure permissions. Use when user asks to set up NATS, connect to NATS, change context, or configure permissions.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(nats context ls *)
  - Bash(cat *)
  - Bash(*list-contexts*)
effort: low
---

# /nats-channel:configure — NATS Channel Configuration

Configures the NATS channel plugin: connection context, session name, and
permission handling. State lives in `~/.claude/channels/nats/config.json`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status, list, and offer to change

Read state and give the user a complete picture, then ask:

1. **Current config** — read `~/.claude/channels/nats/config.json`. Show:
   - Selected context name (or "none — using demo.nats.io")
   - Session name override (if set)
   - Connection URL and description from the context file
   - Permission mode (`terminal` or `query`) and whether permission prompts
     will be relayed as NATS query chunks or handled in the local terminal

2. **Available contexts** — run the `list-contexts.sh` script bundled
   alongside this skill file to list all NATS CLI contexts with their
   URL and description.

3. **Ask the user** — show the numbered list of available contexts and
   ask if they'd like to switch. Example:
   - *"Currently using `<name>`. Available contexts:"*
   - *(numbered list)*
   - *"Would you like to switch? Enter a context name or number, or
     'no' to keep the current selection."*
   If no config is set, skip straight to asking them to pick one.

### `list` — list available NATS contexts

Two separate steps — do NOT combine into one Bash call:

1. Bash: run the `list-contexts.sh` script bundled alongside this skill
   file. It produces no stdout — it writes to a file.
2. Read: open `~/.claude/channels/nats/.contexts` and present the
   markdown table to the user.

### `<context-name>` — select a context

1. Treat `$ARGUMENTS` as the context name (trim whitespace).
2. Verify `~/.config/nats/context/<name>.json` exists. If not, show
   available contexts and error.
3. Read the context file. Show the URL and description so the user can
   confirm it's correct.
4. `mkdir -p ~/.claude/channels/nats`
5. Read existing `config.json` if present; update/add the `context` field,
   preserve other fields (like `sessionName`, `permissions`). Write back.
6. Confirm, then show the status view so the user sees where they stand.

### `session <name>` — set session name override

1. The session name is the fourth token in the subject
   `agents.ccc.<user>.<name>`. It defaults to the working directory
   basename. This command overrides it.
2. Read existing `config.json` (or start fresh). Set `sessionName` field.
   Write back.
3. Confirm the override.

### `session clear` — remove session name override

Remove the `sessionName` field from `config.json` so the default
(CWD basename) is used.

### `permissions terminal` — use terminal for permission prompts

Set `permissions.mode` to `terminal`. Permission prompts will appear in the
Claude Code terminal session. This is the simplest option when the operator
has direct terminal access, and the default when no permissions block is set.

1. Read existing `config.json` (or start fresh).
2. Set `permissions` to `{ "mode": "terminal" }`.
3. Write back and confirm.

### `permissions query` — relay permissions as query chunks

Set `permissions.mode` to `query`. When Claude needs permission to use a
tool during an active NATS prompt, the plugin emits a protocol `query`
chunk (§7 of the NATS Agent Protocol) on the active stream's reply
subject. The caller replies with `yes`/`no` on the query's dynamic reply
inbox, and the plugin forwards the decision back to the Claude Code
harness. The legacy value `"nats"` is accepted as an alias for
backward compatibility.

If Claude asks for permission while no NATS request is active, the request
is denied (there is no open stream to carry a query chunk on). Operators
who need terminal-style prompting in that case should use `permissions
terminal` instead.

1. Read existing `config.json` (or start fresh).
2. Set `permissions` to `{ "mode": "query" }`.
3. Write back and confirm.

### `permissions clear` — reset to default

Remove the `permissions` field from `config.json`, restoring the default
behavior (terminal-mode prompts).

### `clear` — remove config

Delete `~/.claude/channels/nats/config.json`.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing
  file = not configured, not an error.
- The server reads `config.json` once at boot. Config changes need a
  session restart or `/reload-plugins`. Say so after saving.
- NATS CLI contexts live in `~/.config/nats/context/<name>.json`. Each
  file contains `url`, `description`, `creds`, `nkey`, `user`, `password`,
  `token`, `cert`, `key`, `ca`, and other fields.
- Do not modify NATS CLI context files — only read them.
- Legacy configs with `"mode": "nats"` are still accepted and treated as
  the new `"query"` mode; they do not need to be rewritten.
- Legacy configs with `permissions.subject` are silently ignored — query
  chunks use a dynamic reply inbox per request, not a fixed subject.
