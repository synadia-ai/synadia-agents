# NATS Channel for Claude Code

Connect Claude Code to NATS messaging as a spec-compliant
[Synadia Agent Protocol for NATS](https://github.com/synadia-ai/synadia-agent-sdk-docs) v0.3 agent
(verb-first subjects + `status` endpoint).

The MCP server registers an `agents` micro service, exposes a
`prompt` endpoint at `agents.prompt.cc.<owner>.<name>`, a `status`
endpoint at `agents.status.cc.<owner>.<name>` (replies with the same
payload as a heartbeat), publishes heartbeats at
`agents.hb.cc.<owner>.<name>` (the verb is the abbreviation `hb`,
§8.1 v0.3), and bridges prompt requests into the Claude Code session.
Replies stream back as typed JSON chunks
(`{"type":"response","data":"..."}`) terminated by an empty headerless
message - the protocol's uniform end-of-stream signal.

The marketplace copy contains a self-contained server bundle. Starting the
channel does not install or update npm dependencies at runtime.

## Prerequisites

- [Bun](https://bun.sh) - the MCP server and the plugin's [hooks](#hooks) run on Bun. Install with `curl -fsSL https://bun.sh/install | bash`, and make sure `bun` is on your `PATH`.
- [NATS CLI](https://github.com/nats-io/natscli) - for managing contexts and testing.
- A NATS server to connect to (local or remote) - the plugin defaults to `demo.nats.io`.

## Quick Setup

**1. Add the marketplace.**

These are Claude Code commands - run `claude` to start a session first.

```
/plugin marketplace add synadia-ai/synadia-agents
```

**2. Install the plugin.**

```
/plugin install nats-channel@synadia-plugins
```

**3. Launch with the channel flag.**

```sh
claude --dangerously-load-development-channels plugin:nats-channel@synadia-plugins
```

By default, the server connects to `demo.nats.io` (no credentials required)
and registers a micro service on `agents.prompt.cc.<owner>.<name>`, where
`<name>` defaults to the working directory name.

**4. (Optional) Configure the channel.**

The `/nats-channel:configure` skill manages connection, session naming,
sender identity, inbound trust, and permissions. All state lives in
`~/.claude/channels/nats/config.json`.

| Command | Description |
| --- | --- |
| `/nats-channel:configure` | Show current config, list available contexts, and offer to switch |
| `/nats-channel:configure list` | List available NATS CLI contexts |
| `/nats-channel:configure <context-name>` | Select a NATS CLI context to connect to |
| `/nats-channel:configure session <name>` | Override the session name (5th token in `agents.prompt.cc.<owner>.<name>`) |
| `/nats-channel:configure session clear` | Remove session name override, revert to CWD basename |
| `/nats-channel:configure owner <name>` | Override the owner (4th token in `agents.prompt.cc.<owner>.<name>`) |
| `/nats-channel:configure owner clear` | Remove owner override, revert to sanitized `$USER` |
| `/nats-channel:configure identity off` | Do not look up or register a host identity (default) |
| `/nats-channel:configure identity signed` | Register a signed identity derived from the selected connection credentials |
| `/nats-channel:configure trust any` | Accept headerless, claimed, and verified senders (default) |
| `/nats-channel:configure trust signed` | Require a verified signed sender before Claude sees a prompt |
| `/nats-channel:configure permissions terminal` | Prompt for permissions in the terminal (default) |
| `/nats-channel:configure permissions query` | Relay permission prompts as protocol query chunks |
| `/nats-channel:configure permissions clear` | Reset permissions to default |
| `/nats-channel:configure clear` | Remove all configuration |

To connect to your own NATS server, use a NATS CLI context. List your contexts
with `nats context ls`, then:

```
/nats-channel:configure <context-name>
```

This writes the selected context to `~/.claude/channels/nats/config.json`.
The server reads connection details (URL, credentials) from
`~/.config/nats/context/<name>.json`.

**5. Send a prompt.**

With the [`@synadia-ai/agents`](../../client-sdk/typescript)
TypeScript SDK:

```ts
import { connect } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";

const nc = await connect({ servers: "nats://localhost:4222" });
const agents = new Agents({ nc });
const [agent] = await agents.discover();
for await (const msg of await agent!.prompt("hello Claude")) {
  if (msg.type === "response") process.stdout.write(msg.text);
}
await agents.close();
await nc.close();
```

Or directly via the NATS CLI (plain-text shorthand per spec §5.1):

```sh
nats req agents.prompt.cc.<owner>.<name> "Hello Claude" \
  --replies=0 --reply-timeout=30s --timeout=90s
```

Claude's response streams back as typed JSON chunks on the reply subject;
an empty headerless message signals completion.

## Protocol compliance

This plugin implements the **Synadia Agent Protocol for NATS v0.3** end-to-end:

- Registers as an `agents` NATS micro service (§3.1 - the bare subject-safe
  token).
- Service metadata includes `agent`, `owner`, `session`, and
  `protocol_version: "0.3"` (§3.2).
- `prompt` endpoint declares the server-negotiated `max_payload` (read
  from `nc.info.max_payload` at startup and formatted into the §2.1
  `\d+(B|KB|MB|GB)` grammar — `1MB` against a default `nats-server`,
  larger if the operator bumped `--max_payload`), `attachments_ok:
  "true"` (§2.1), and queue group `"agents"` (§3.3).
- Accepts both plain-text shorthand and JSON envelopes with optional
  base64-encoded attachments (§5.1, §5.2, §5.3). Inbound attachments
  are staged to a per-request temp directory and exposed to Claude via
  file paths.
- Rejects malformed envelopes, empty payloads, oversize requests, and
  invalid base64 with `Nats-Service-Error-Code: 400` (§9).
- Emits typed response chunks `{"type":"response","data":"..."}`
  (§6.3) terminated by an empty headerless message (§6.5). Large
  responses are split into multiple UTF-8-safe chunks that each fit
  under `max_payload`.
- Emits the required leading `{"type":"status","data":"ack"}` only after
  envelope validation and sender admission, then publishes periodic ack
  keep-alives every 30 s while a request is open.
- Publishes heartbeats at `agents.hb.cc.<owner>.<name>` (§8.1 v0.3) every 5 s with the full
  §8.3 payload including `instance_id` (§8).
- Relays Claude Code permission prompts as mid-stream `query` chunks
  (§7) when `permissions.mode = query`.
- Uses the host SDK for sender classification, pre-ack admission, replay
  protection, status classification, identity registration, and stream
  termination. `min_sender_trust` is always advertised and defaults to `any`.

The caller-side SDK at
[`client-sdk/typescript/`](../../client-sdk/typescript) is the
canonical counterpart.

## Session names

The micro service prompt subject is `agents.prompt.cc.<owner>.<name>` (v0.3 verb-first §2). Heartbeats go to `agents.hb.cc.<owner>.<name>` and the status endpoint replies on `agents.status.cc.<owner>.<name>`.

- **Default:** sanitized basename of the working directory (e.g., `my-project`)
- **Override:** set `SYNADIA_CLAUDE_CODE_NAME` (or the fleet-wide
  `SYNADIA_NAME`, or the legacy `NATS_SESSION_NAME`) env var, or use
  `/nats-channel:configure session <name>`
- **Owner:** the 4th token defaults to the sanitized `$USER`; override
  with `SYNADIA_CLAUDE_CODE_OWNER` (or the fleet-wide `SYNADIA_OWNER`),
  or `/nats-channel:configure owner <name>`
- **Multiple sessions:** if the default name is already taken by another
  claude-code instance owned by the same user, the plugin auto-appends
  `-2`, `-3`, etc.

Discover running sessions via the protocol's discovery subjects:

```sh
nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s
nats req '$SRV.PING.agents' '' --replies=0 --timeout=2s
```

Or via the NATS Micro CLI:

```sh
nats micro ls
nats micro info agents
```

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send a response over NATS. Takes `request_id` + `text`. The server wraps the text in a `{"type":"response","data":...}` chunk. Set `done=false` for intermediate replies; `done=true` (default) emits the empty-body terminator. |
| `request_info` | Return the safely classified sender of an active request, and the [extensions](#extensions) loaded. Identity is available only on explicit inspection and is never inserted into the incoming model prompt or channel metadata. |
| `discover_agents`, `prompt_agent`, `answer_agent` | The [agent tools](#agent-tools): find other agents on NATS, prompt one and wait for its reply, answer a question it asks back. Offered by default. |
| `wait_agent`, `cancel_agent`, `list_agent_calls` | The rest of the agent tools, for calls that run while the model does other work. Offered with `agentTools: "all"`. |

### Agent tools

The channel offers the SDK's agent tools, so the session can reach other
agents on the same NATS as tools of its own. They are built on the caller
API: the agent being prompted sees an ordinary prompt, signed with the
channel's identity when `senderIdentity` is `signed`.

The `agentTools` setting (`NATS_AGENT_TOOLS` wins over it) picks the set:

| Value | Tools |
| --- | --- |
| `blocking` (default) | `discover_agents`, `prompt_agent`, `answer_agent` |
| `all` | the six, adding `wait_agent`, `cancel_agent`, `list_agent_calls` |
| `off` | none |

Each agent tool takes one more optional argument, `request_id`: the inbound
channel request the call is made for, the last active request when it is
omitted. A call made for a request belongs to it: it runs in that request's
context, and the calls it started that are still open end when the request
completes (`reply` with `done=true`). A call made while no request is active
is the local user's and lives as long as the session. A `request_id` that
names no active request is refused.

When a prompted agent asks a question, it comes back as the tool's result
for the model to answer with `answer_agent`. The channel's own address is
left out of discovery and refused, so the session cannot prompt itself.
Permission prompts are unaffected: they follow the [permissions](#permissions)
setting.

The model's id for each agent-tool call reaches the tools through the
`PreToolUse` hook (see [Hooks](#hooks)); an MCP tool call does not carry it.

### When the model stops without replying

A request is answered only through `reply` with `done=true`. When Claude
Code's turn ends without it, the plugin ends the request rather than leave
its caller waiting until the 30-minute request TTL. The caller gets the
protocol's error frame (§9), then the terminator, and no response text, so
it cannot mistake the end for the model's words:

```
Nats-Service-Error-Code: 500
Nats-Service-Error: the Claude Code turn ended without a reply to this prompt
```

A caller using the SDK's agent tools sees its `prompt_agent` call fail with
that description. When the request ends depends on whether the plugin
knows which turn was the request's (see [Which caller is
asked](#which-caller-is-asked)); both rest on the [hooks](#hooks):

- **The request owned its turn** (delivered while Claude Code was quiet):
  it is ended at that turn's `Stop`, when the `Stop` says no background
  tasks or session crons are left, since nothing else can come back to it.
- **Any other request** (delivered while a turn ran, which Claude Code may
  fold into that turn or queue for the next, or whose turn stopped with
  background work left): it survives the `Stop`. It is ended once a `Stop`
  has come after its delivery and no turn has started within
  `turnStartGraceMs` (5 minutes by default) of the latest `Stop`. The
  plugin sees a turn start at its first tool call, so the grace period has
  to outlast the model's first reply; a turn that starts in time keeps the
  request open, and the grace period runs again from that turn's `Stop`.

A request ended this way is logged as `request ended without a reply` with
its request id and the reason, and the [extensions](#extensions) hear
`promptEnded` with the outcome `error`. A later `reply` to it is refused as
not active. The request TTL stays the last guard: without the hooks, or in
a session where a turn starts within the grace period after every `Stop`,
nothing else ends a request.

## Permissions

When Claude Code needs permission to run a tool, the plugin can either
prompt in the terminal (default) or relay the request as a protocol
query chunk on the active NATS stream. This is controlled by the
`permissions` config.

### Terminal mode (default)

Permission prompts appear directly in the Claude Code terminal. No extra
configuration needed.

### Query mode

Permission requests are emitted as `{"type":"query","data":{...}}`
chunks on the reply subject of the request whose turn made the tool call
(spec §7). The caller replies on the query's dynamic `_INBOX` with
`yes`/`no`, and the plugin forwards the decision back to the harness.

```
/nats-channel:configure permissions query
```

To switch back to terminal mode:

```
/nats-channel:configure permissions terminal
```

The legacy value `"nats"` is still accepted as an alias for `"query"` so
old configs keep working. The older `permissions.subject` override field
has been removed - query chunks always use a fresh NATS inbox per
request.

#### Which caller is asked

A question goes to the caller of the turn that asked it, never to a
newer prompt. Claude Code's permission request does not name its turn,
so the plugin works it out from its [hooks](#hooks): the `Stop` hook
marks the end of each turn, and the `PreToolUse` hook records the prompt
id of every tool call, which Claude Code runs before it asks. A NATS
request owns a turn when it was delivered while Claude Code was quiet —
the last turn had stopped with no background tasks or session crons left,
no tool call since, and no other request that might still be waiting to
start a turn — so the next turn is the one it starts. It owns that turn
until the turn's `Stop`.

The plugin denies at once, without asking anyone, when:

- no request owns the turn: the question comes from direct terminal
  input, from a turn that background work started, from a turn that went
  on after its request's `Stop`, or from a turn whose prompt id changed
  without a `Stop`;
- the owning request is already finished — replied with `done=true`,
  expired, or shut down;
- the owning request's caller is gone: before asking, and every 2 seconds
  while a question is open, the plugin checks that someone still
  subscribes to the request's reply subject; a caller whose connection
  closed fails that check and its open question is denied.

When Claude Code does not make the turn's owner certain, the plugin
chooses deny:

- A request delivered while a turn is running owns nothing in that turn
  or the next — Claude Code may fold it into the running turn or queue it,
  and does not say which — and it holds back ownership for later requests
  until it finishes or a second turn has stopped. With two callers at
  once, only the first one's turn relays questions.
- A Claude Code that does not report the hook fields the plugin reads
  (`prompt_id` on `PreToolUse`, `background_tasks` and `session_crons` on
  `Stop`), or runs without the plugin's hooks, gets every question denied.
- A turn interrupted from the terminal may end without a `Stop`; until
  the next one, new requests own nothing.
- One race stays open the other way: a turn the local user starts in the
  terminal, before its first tool call, looks quiet to the plugin, so a
  request arriving in that moment is taken to start the next turn. The
  terminal shows that user the same permission dialog.

A caller that cancels its prompt but keeps its NATS connection open
still looks present: the protocol has no cancel message (§6.7), and the
connection's shared reply inbox stays subscribed. Its question is
denied after the timeout below. Use `permissions terminal` if you want
interactive approval for questions the plugin denies.

### Handling permission queries with the SDK

```ts
for await (const msg of await remote.prompt("rm -rf /tmp/stale")) {
  if (msg.type === "query") {
    await msg.reply("yes");  // or "no"
  }
  if (msg.type === "response") {
    process.stdout.write(msg.text);
  }
}
```

Or with the NATS CLI, by publishing to the `reply_subject` from the
query chunk:

```sh
nats pub _INBOX.Xj7k9Q2pA "yes"
```

If a caller that is still there does not reply within 2 minutes, the
permission defaults to **deny**.

## Access control

NATS server authentication and authorization handle access control. If a
user can connect and publish to `agents.prompt.cc.<owner>.<name>`, they can
interact with Claude. No additional pairing or allowlist is needed.

`minSenderTrust: "signed"` adds a sender-signature requirement, but it is
separate from NATS authorization and separate from the channel's own identity.
The default is `"any"`, so existing headerless callers continue to work.

## Sender identity

Host identity is optional and off by default. Set `senderIdentity` to
`"signed"` when the selected NATS CLI context contains a user seed (`creds`,
`nkey`, or `user_jwt` plus `user_seed`). The channel reads that connection
source once and derives both NATS authentication and the signer from the same
immutable snapshot. There is deliberately no second identity credential.

Signed startup validates that the signer is the NATS user authenticated on the
live connection. Missing user-info permission, seedless authentication, or a
binding mismatch fails signed startup rather than silently falling back. Set
identity to `"off"` for token/password servers or deployments without identity
lookup permission. Credential rotation takes effect after restarting Claude
Code or reloading the plugin.

Inbound trust is independent: an identity-free channel may still require
signed callers, and an identified channel remains permissive unless
`minSenderTrust` is explicitly set to `"signed"`. Responses and permission
query replies are not independently signed.

## Anthropic auth

Set `ANTHROPIC_API_KEY` in your environment before launching `claude`.
Claude Code uses the env var in preference to any `~/.claude/`
credentials, so logging out is unnecessary.

Bedrock / Vertex / Azure deployments work too — set the standard
provider env vars before launching `claude` and Claude Code will use
those instead.

## Configuration

State lives in `~/.claude/channels/nats/`:

| File | Purpose |
| --- | --- |
| `config.json` | Selected NATS context, owner and session name overrides, identity, trust, permission, agent-tools and extension settings |
| `attachments/<request_id>/` | Per-request staged attachments; auto-cleaned on reply completion |
| `sessions/` | What the plugin's [hooks](#hooks) record, per Claude Code process; a dead process's files are removed when a server starts |

NATS CLI contexts live in `~/.config/nats/context/<name>.json`.

### config.json

```json
{
  "context": "my-context",
  "owner": "my-team",
  "sessionName": "my-session",
  "senderIdentity": "signed",
  "minSenderTrust": "any",
  "permissions": {
    "mode": "query"
  },
  "agentTools": "blocking",
  "extensions": ["some-extension", { "module": "/abs/path/to/extension", "options": {} }]
}
```

| Field | Default | Description |
| --- | --- | --- |
| `context` | *(none - uses demo.nats.io)* | NATS CLI context name |
| `owner` | sanitized `$USER` | Override the owner (4th subject token) |
| `sessionName` | CWD basename | Override the session name |
| `senderIdentity` | `off` | `off` or `signed`; signed mode uses the selected connection credentials |
| `minSenderTrust` | `any` | `any` or `signed`; controls inbound prompt admission independently |
| `permissions.mode` | `terminal` | `terminal` or `query` (`nats` accepted as legacy alias for `query`) |
| `agentTools` | `blocking` | `blocking`, `all` or `off`; the [agent tools](#agent-tools) offered |
| `turnStartGraceMs` | `300000` | How long after a `Stop` a request not tied to a turn waits for one to start before it is ended; see [When the model stops without replying](#when-the-model-stops-without-replying) |
| `extensions` | *(none)* | Extension modules: package names or absolute paths, or `{ "module", "options" }` objects; see [Extensions](#extensions) |

### Environment variables

Owner and session vars follow the `SYNADIA_*` convention shared across the
agent plugins. Connection, identity, and trust use the `NATS_*` variables
shown below; environment settings override the corresponding config fields.

| Variable | Overrides | Default |
| --- | --- | --- |
| `SYNADIA_CLAUDE_CODE_OWNER`, `SYNADIA_OWNER` | Owner (4th token in `agents.prompt.cc.<owner>.<name>`); per-agent var wins, then fleet-wide, then config `owner` | sanitized `$USER` |
| `SYNADIA_CLAUDE_CODE_NAME`, `SYNADIA_NAME` | Session name (5th token); per-agent var wins, then fleet-wide, then the legacy `NATS_SESSION_NAME`, then config `sessionName` | sanitized basename of `$CLAUDE_CWD` |
| `NATS_SESSION_NAME` | Session name — legacy alias, still honored below the `SYNADIA_*` vars | *(unset — falls through to config `sessionName`, then the `$CLAUDE_CWD` basename)* |
| `NATS_CONTEXT` | NATS CLI context to connect with (wins over config `context`) | — |
| `NATS_URL` | Raw NATS URL; used when no context is set via env or config | `demo.nats.io` |
| `NATS_SENDER_IDENTITY` | Host identity mode: `off` or `signed` | config `senderIdentity`, then `off` |
| `NATS_MIN_SENDER_TRUST` | Inbound sender policy: `any` or `signed` | config `minSenderTrust`, then `any` |
| `NATS_AGENT_TOOLS` | The agent tools offered: `blocking`, `all` or `off`; empty means `blocking` | config `agentTools`, then `blocking` |
| `SYNADIA_CLAUDE_CODE_EXTENSIONS`, `SYNADIA_AGENT_EXTENSIONS` | Extension modules, comma-separated; per-agent var wins, then fleet-wide, then config `extensions`. A set variable wins even when empty | *(none)* |
| `SYNADIA_CLAUDE_CODE_TURN_START_GRACE_MS` | `turnStartGraceMs`, in milliseconds, a whole number above 0; empty means unset | config `turnStartGraceMs`, then `300000` |
| `NATS_STATE_DIR` | State directory location | `~/.claude/channels/nats` |
| `CLAUDE_CWD` | Working directory whose basename seeds the default session name | — |
| `CLAUDE_PID` | Set by Claude Code for its MCP servers and hooks; keys the hooks' files | the server's parent pid |

## Extensions

The channel can load extension modules that add behaviour around it:
interceptors for its client and service, keys for its registration
metadata, extensions for its agent tools, and handlers for the session's
events. The plugin's hooks
(`hooks/hooks.json`) record the session id at `SessionStart`, the turn's
end at `Stop` and the tool-call id at `PreToolUse` under
`<state dir>/sessions/`, keyed by the Claude Code process; the server
reads them to follow `/clear`, to close a turn when Claude Code is done,
and to pass the model's tool-call id to its agent tools. Name extensions
in `SYNADIA_CLAUDE_CODE_EXTENSIONS` or `SYNADIA_AGENT_EXTENSIONS`, or as
the `extensions` array in `config.json`; `request_info` lists the modules
loaded. The contract is [`../EXTENSIONS.md`](../EXTENSIONS.md).

## Hooks

The plugin ships Claude Code hooks (`hooks/hooks.json`), all running
`hooks/session-event.ts` with `bun`. They record what the MCP server cannot
see itself, under `<state dir>/sessions/`, keyed by the Claude Code process
(`CLAUDE_PID`), each file written atomically:

| Hook | File | Records | Why |
| --- | --- | --- | --- |
| `SessionStart` | `<pid>` | `{ "session_id", "source", "at_ms" }` | the session Claude Code uses now; `/clear` starts a new one under the same MCP server |
| `Stop` | `<pid>.stop` | `{ "session_id", "background", "at_ms" }` | when a turn really ends: Claude Code writes its closing text after the `reply` call; `background` says whether background tasks or session crons could start another turn by themselves; a request the turn left without its reply is ended (see [When the model stops without replying](#when-the-model-stops-without-replying)) |
| `PreToolUse` (every tool) | `<pid>.turn` | `{ "prompt_id", "first_ms", "at_ms" }` | the turn the latest tool call belongs to and when its first call was made, so a permission question goes to the request that owns the turn (see [Which caller is asked](#which-caller-is-asked)) |
| `PreToolUse` (agent tools) | `<pid>.tools/<tool_use_id>` | `{ "tool_use_id", "tool_name", "tool_input", "at_ms" }` | the model's id for the tool call, which the server hands to the agent tools; the server removes the file when the call arrives |

The hooks write whether or not an extension is loaded, print nothing, and
always exit 0, so a failing hook never interrupts the session. Without
them the channel still works: the session id falls back to
`CLAUDE_CODE_SESSION_ID`, agent-tool calls run without the model's
tool-call id, `query` mode denies every permission question, and a request
the model never replies to stays open until the request TTL.
