# OpenCode plugin-first implementation spec

Date: 2026-06-10
Scope: production implementation plan for the next `agents/opencode` path after the plugin lifecycle and real-permission evidence gate.

## Decision

Build the next OpenCode integration as an OpenCode plugin first.

The plugin should register the current OpenCode project/session as a Synadia Agent Protocol agent from inside the running OpenCode process. The existing external `opencode-agent start` server adapter remains useful, but its role becomes fallback, smoke harness, and external reconciler rather than the primary heavy-user UX.

This is not a rewrite of the protocol. The production plugin must still use `@synadia-ai/agent-service` and the same TypeScript/Bun package. No hand-rolled NATS subject plumbing, framing, heartbeats, or terminators.

## Accepted caveats

The implementation should not block on these known OpenCode quirks:

- OpenCode `serve` may not call plugin `dispose` on SIGINT. Process death stops AgentService heartbeats, NATS service discovery ages out, and restart has been proven to come back with one registration.
- Same-process double plugin initialization can happen. Treat it as a normal lifecycle case and guard it with an idempotent singleton keyed by NATS target plus Synadia identity.
- OpenCode permission reply APIs may differ between plugin context and HTTP/SDK surfaces. Prefer the typed plugin client when present, but keep a direct HTTP/SDK fallback behind one adapter function.

## Non-goals

- Do not make manager mode the default user journey for this phase.
- Do not claim every existing OpenCode session is automatically exposed unless the plugin has a deterministic identity and session-routing rule for it.
- Do not expose local filesystem paths, worktree names, project ids, NATS credentials, or server passwords in discovery metadata, logs, or docs.
- Do not set `attachments_ok=true` until file ingestion is implemented and tested end-to-end.
- Do not invent an upstream command such as `opencode serve nats`; this remains a Synadia package that installs an OpenCode plugin.

## Package shape

Keep one publishable package:

```text
agents/opencode/
  README.md
  PLUGIN_FIRST_IMPLEMENTATION_SPEC.md
  package.json
  src/
    index.ts
    cli.ts
    config.ts
    service.ts              # shared AgentService option builder where reusable
    permissions.ts          # shared reply mapping and question formatting
    event-mapper.ts         # shared OpenCode event-to-protocol chunk mapping
    plugin/
      index.ts              # OpenCode plugin export
      channel.ts            # creates/stops the in-process Synadia channel
      config.ts             # plugin env/file config resolution
      identity.ts           # owner/session derivation and metadata hashing
      lifecycle.ts          # singleton/idempotency guard
      permissions.ts        # plugin permission reply adapter
      prompt.ts             # prompt/session routing and active prompt correlation
    manager/
      reconciler.ts         # fallback/external reconciler, not default UX
  test/
    plugin-*.test.ts
  scripts/
    opencode-plugin-lifecycle-smoke.ts
    opencode-plugin-permission-smoke.ts
```

`package.json` should continue to publish:

- binary: `opencode-agent`;
- dependencies: `@synadia-ai/agents`, `@synadia-ai/agent-service`, `@nats-io/*`, and `@opencode-ai/sdk` pinned to tested compatible ranges;
- README and this implementation spec in the package tarball.

Add an export only if OpenCode plugin loading can import it directly from the package:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./opencode-plugin": "./src/plugin/index.ts"
  }
}
```

If OpenCode plugin loading cannot import package subpath exports reliably, the installer should generate a thin `.opencode/plugins/synadia-channel.ts` wrapper that imports the package root or copies a small self-contained loader. Do not duplicate the protocol implementation in the wrapper.

## Plugin installation and config UX

### Commands

Add plugin-focused commands under the existing binary:

```sh
opencode-agent plugin install --directory /path/to/repo --owner team --session frontend
opencode-agent plugin doctor --directory /path/to/repo
opencode-agent plugin uninstall --directory /path/to/repo
opencode-agent plugin print-env-template
```

`plugin install` should:

1. create `.opencode/plugins/synadia-channel.ts`;
2. create or update `.opencode/package.json` with the Synadia package dependency when OpenCode requires project-local plugin dependencies;
3. avoid writing secrets into project files;
4. preserve existing OpenCode config and unrelated plugins;
5. print the environment variables needed to start `opencode serve` safely.

Expected runtime shape:

```sh
export NATS_URL=nats://127.0.0.1:4222
export SYNADIA_OPENCODE_OWNER=team
export SYNADIA_OPENCODE_SESSION=frontend
export OPENCODE_PERMISSION_POLICY=query
opencode serve --hostname 127.0.0.1 --port 4096
```

Use the existing config precedence wherever possible:

```text
CLI install flags > environment variables > config file > safe defaults
```

Plugin runtime should read only environment/config values available inside the OpenCode process. The installer can record non-secret defaults such as owner/session, but NATS creds paths, NKEYs, passwords, and API keys must stay in environment variables, NATS contexts, or user-owned config files outside public docs.

### Config fields

Minimum plugin config:

| Field | Env / config | Default | Notes |
| --- | --- | --- | --- |
| NATS URL/context/creds | `NATS_URL`, `NATS_CONTEXT`, `NATS_CREDS` | local URL | Use existing adapter names where possible. |
| Owner | `SYNADIA_OPENCODE_OWNER` | sanitized user or `opencode` | Fourth protocol token. |
| Session/name | `SYNADIA_OPENCODE_SESSION` | `session-<directory-hash>` | Fifth protocol token. Prefer explicit values for shared accounts. |
| Permission policy | `OPENCODE_PERMISSION_POLICY` | `query` | `query`, `local`, or `reject`. |
| Heartbeat interval | `SYNADIA_OPENCODE_HEARTBEAT_INTERVAL_S` | `30` | Positive integer. |
| Keepalive interval | `SYNADIA_OPENCODE_KEEPALIVE_INTERVAL_S` | `30` | Positive integer or documented disable value if supported. |
| Log level/path | plugin-specific env | off/info | Must redact credentials and local paths by default. |

## NATS identity mapping

The plugin registers exactly one Synadia identity per `(NATS target, owner, session)` in one OpenCode process.

Protocol subjects:

```text
agents.prompt.opencode.<owner>.<session>
agents.status.opencode.<owner>.<session>
agents.hb.opencode.<owner>.<session>
```

Use `AgentService` with:

- service name `agents`;
- endpoint name `prompt`;
- queue group `agents`;
- `agent: "opencode"`;
- `subjectToken: "opencode"`;
- `attachmentsOk: false` for v1;
- `version` from package metadata;
- `owner` and `session` from the explicit config or safe derivation.

Identity derivation rules:

1. If `SYNADIA_OPENCODE_SESSION` or installer config supplies a session name, sanitize and use it.
2. Otherwise derive `session-<sha256(directory/worktree/project-id)[0..12]>`.
3. Never use raw directory basenames, absolute paths, OpenCode project ids, Git remotes, or branch names in subject tokens unless explicitly provided by the operator.
4. Add only safe metadata:
   - `opencode_mode=plugin`;
   - `opencode_plugin=true`;
   - `opencode_identity_source=explicit|hashed-directory`;
   - short hashes for directory/worktree/project id;
   - safe server origin if available;
   - `permission_policy`.

## AgentService lifecycle

Implement a plugin channel singleton:

```text
channel key = hash(nats context/url + owner + session + project identity hash)
```

On plugin init:

1. resolve config;
2. derive identity;
3. if the key already exists, increment duplicate-init telemetry and return no-op duplicate hooks;
4. connect to NATS;
5. create `AgentService`;
6. install prompt handler;
7. start service;
8. return `event` and `dispose` hooks to OpenCode.

On plugin event:

1. count event types for diagnostics;
2. route session/message/permission events only to active prompts for the matching upstream OpenCode session id;
3. ignore unrelated sessions unless the implementation explicitly supports multi-session fan-out;
4. never let an event handler throw out into OpenCode without logging and converting to a controlled status/error path.

On dispose:

1. mark the channel disposed idempotently;
2. remove it from the singleton map;
3. stop `AgentService`;
4. drain/close NATS;
5. flush safe telemetry.

Because SIGINT dispose is not guaranteed in observed OpenCode versions, tests must also prove process death removes the service from discovery and restart returns one live registration. The plugin should do the right thing when dispose is called, but product correctness cannot depend on dispose being called every time.

## Prompt routing and streaming

The plugin prompt handler must bridge a Synadia prompt into the active OpenCode runtime instead of echoing.

Request/session selection:

1. Accept plain text and JSON envelopes through `AgentService`.
2. Reject unsupported attachments with `ProtocolError` so clients receive `400`.
3. If envelope metadata contains `opencode_session_id`, route to that upstream OpenCode session id.
4. Else use configured/default plugin upstream session when available.
5. Else create or select a session using OpenCode's plugin client or HTTP/SDK fallback.

Streaming behavior:

1. Send an early status chunk such as `OpenCode plugin bridge selected`.
2. Start tracking an active prompt by upstream OpenCode session id.
3. Trigger the OpenCode prompt using the best available in-process client; fall back to the local OpenCode HTTP server only behind a narrow adapter.
4. Convert assistant `message.part.delta` / `message.part.updated` text to Synadia `response` chunks.
5. Convert useful runtime state to `status` chunks.
6. Stop on `session.idle`, `session.done`, or prompt completion for the target session.
7. Do not emit raw upstream event objects as response text.
8. Do not emit an extra empty response frame after real text chunks; let `AgentService` write the zero-byte terminator.
9. Clean active prompt state in `finally`.

## Permission-event mapping

Permission policy remains explicit:

| Policy | Behavior |
| --- | --- |
| `query` | Convert OpenCode permission asks to Synadia protocol `query` chunks. |
| `reject` | Reply `reject` immediately and emit a status chunk. |
| `local` | Delegate to OpenCode's local permission surface and emit a status chunk; never hang silently. |

For `query`:

1. Detect `permission.asked` and `permission.v2.asked` for the active upstream session.
2. Format a concise question containing permission/tool/action and safe resource patterns.
3. Call `PromptResponse.ask()` with timeout.
4. Map replies:
   - `always`, `allow always`, `yes always` -> `always`;
   - `yes`, `y`, `once`, `allow`, `true` -> `once`;
   - `no`, `n`, `deny`, `reject`, `false`, empty, or ambiguous -> `reject`.
5. Reply to OpenCode through `client.permission.reply` when exposed.
6. Fall back to the observed HTTP/SDK permission reply endpoint when plugin client reply is absent.
7. Emit a status chunk naming the decision without leaking request internals.
8. Regression-test real tool-generated permission asks, not only synthetic events.

## Manager fallback / external reconciler

Keep the current external adapter code and manager-reconciler lessons available for these cases:

- plugin install is not possible in a user's environment;
- an operator wants a separate control-plane process;
- stale discovery or missed lifecycle events need external reconciliation;
- future multi-session auto-exposure needs list/reconcile across an OpenCode server.

Manager mode should not be the default plugin-first UX. If built further, it should be a separate `opencode-agent manager ...` or equivalent path with periodic relist because OpenCode SSE is not durable.

## Test and smoke plan

### Unit tests

Add tests for:

- plugin config precedence and validation;
- installer file generation without secret writes;
- identity sanitization and hash-only fallback metadata;
- singleton lifecycle and duplicate init no-op hooks;
- prompt session selection and active prompt cleanup;
- event mapping for `message.part.delta`, `message.part.updated`, `session.status`, `session.idle`, permission ask/reply variants;
- permission reply mapping and timeout rejection;
- unsupported attachments return `400` through `ProtocolError`;
- package metadata includes the plugin spec and any plugin export.

### Local protocol smoke

Promote the existing spike shape into maintained scripts:

```sh
bun run smoke:opencode-plugin-lifecycle
bun run smoke:opencode-plugin-permission
```

Required assertions:

- OpenCode loads the plugin on the pinned/tested version.
- NATS discovery finds exactly one `agents.prompt.opencode.<owner>.<session>` service.
- Duplicate plugin files or duplicate init produce one live service.
- Prompt stream starts with `ack/status`, emits response/status/query chunks as appropriate, and ends with the SDK terminator.
- `attachments_ok=false` is advertised.
- Unsupported attachments are rejected with service error `400`.
- Process stop removes the service from discovery even when plugin dispose is not observed.
- Restart returns exactly one live service.

### Real permission smoke

Use a deterministic provider/tool path:

1. configure OpenCode with a no-secret fake provider;
2. register a deterministic plugin probe tool that calls OpenCode's real tool permission ask path;
3. prompt the Synadia subject with an active upstream session id;
4. assert a protocol `query` chunk appears;
5. reply `always` over the query reply subject;
6. assert OpenCode emits `permission.replied` and the prompt completes.

### Regression scans

Run before review:

```sh
bun run typecheck
bun test
bun run smoke:protocol
bun run smoke:opencode-plugin-lifecycle
bun run smoke:opencode-plugin-permission
```

Also run targeted scans over committed OpenCode docs/code for:

- NATS seed-shaped strings (`S` plus 57 uppercase letters/digits);
- local absolute paths;
- personal names or private project names;
- raw API keys, bearer tokens, passwords, cookies, `.creds`, `.nkey`, and `.env` contents.

## Documentation updates

Update public docs in the implementation PR:

1. `agents/opencode/README.md`
   - make plugin install the first quickstart;
   - keep external `opencode-agent start` as fallback/manager-compatible mode;
   - document plugin config, permission policies, lifecycle caveats, and troubleshooting;
   - avoid saying the adapter attaches to arbitrary terminal TUI processes.
2. `.env.example`
   - include plugin-safe env names and no secret-shaped values.
3. `agents/README.md`
   - update the OpenCode row/per-agent note to mention plugin-first mode after implementation lands.
4. This spec
   - keep it aligned or remove it from package files once README becomes the canonical implementation docs.

## PR plan

1. Commit the plugin spec and README/package metadata link.
2. Implement plugin core behind small modules: config, identity, lifecycle, prompt, permissions.
3. Add installer/doctor commands.
4. Add unit tests before or with the implementation.
5. Promote lifecycle and permission spike scripts into maintained smokes.
6. Re-run the full validation ladder and secret/private-name scans.
7. Update README and `agents/README.md` only after behavior is implemented and verified.
8. Open a normal PR; do not publish or push release tags without explicit approval.

## Acceptance criteria

The implementation is ready for review when:

- plugin-first quickstart works in a clean disposable OpenCode project;
- discovery/status/heartbeat use protocol-shaped subjects from `AgentService`;
- duplicate plugin initialization is idempotent;
- stop/restart behavior has real NATS discovery evidence;
- a real OpenCode tool permission ask bridges to a Synadia query and back;
- manager mode remains available as fallback/external reconciler;
- `attachments_ok=false` remains honest and enforced;
- typecheck, unit tests, protocol smoke, plugin lifecycle smoke, plugin permission smoke, and scans all pass;
- public docs contain no internal planning language, private project identifiers, local absolute paths, or secret-shaped fixtures.
