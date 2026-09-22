# The agent tools: discover, prompt, wait, answer, cancel, list

**Status:** draft · **Applies to:** `@synadia-ai/agents` (TypeScript) and `synadia-ai-agents` (Python) · **Protocol:** [Synadia Agent Protocol for NATS 0.3](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md), unchanged

An agent built on this repo's SDKs can see the other agents on its NATS
system and prompt them. It does so through tools its model calls. This
document fixes those tools once, for every agent that offers them: the names,
the parameters, the descriptions the model reads, the results it gets back,
and the rules behind them. Both SDKs ship the same tools as a helper,
`AgentTools`, so a model reads the same words whichever agent it runs in.

The definitions (`name`, `description`, `parameters` as JSON Schema) and the
result schemas are in [`test-fixtures/agent-tools/`](../test-fixtures/agent-tools/).
Each SDK embeds a copy and tests that it equals those files.

The tools add nothing to the wire. They are built from what protocol 0.3
already has: discovery, a prompt, its response stream, mid-stream questions,
and dropping the subscription to cancel. The agent being prompted sees an
ordinary prompt from an ordinary caller. Section 8 lists the protocol sections
they rest on.

## 1. The tools

| Tool | Parameters | Does | Returns |
| --- | --- | --- | --- |
| `discover_agents` | `agent?`, `owner?`, `name?` | lists the agents that can be prompted, one entry per address | `{"agents": [...]}` |
| `prompt_agent` | `address`, `prompt`, `attachments?`, `label?`, `wait?` | prompts one agent. With `wait` true (the default) it waits for the reply or a question; with `wait` false it returns at once | a call's result |
| `wait_agent` | `call_ids`, `timeout_ms?` | waits for the first of the given calls that finished or asked a question | a call's result with `remaining`, or `{"state": "running", "call_ids": [...]}` on timeout |
| `answer_agent` | `call_id`, `answer`, `wait?` | answers the open question of a call, then waits again or returns at once | a call's result |
| `cancel_agent` | `call_ids` | stops calls: each open call becomes `cancelled` | `{"calls": [...]}` |
| `list_agent_calls` | none | lists the calls tracked in the current scope | `{"calls": [...]}` |

A **call** is one prompt sent by `prompt_agent`, tracked from the moment it is
sent until it is dropped (section 3.4). Its `call_id` is opaque and names it in
`wait_agent`, `answer_agent` and `cancel_agent`.

### 1.1 States

| State | Open? | Meaning | The call's result carries |
| --- | --- | --- | --- |
| `running` | open | the agent works on it | nothing more |
| `input_required` | open | the agent asked a question (protocol §7) that waits for `answer_agent` | `question`, and `attachments` that came with it |
| `completed` | finished | the stream ended with its terminator | `reply`, and `attachments` that came with it |
| `failed` | finished | no reply came: the prompt was refused (`401`, `403`, another §9 error), the stream stalled, or the transport failed | `error` in words, and `partial_reply` when some text came first |
| `cancelled` | finished | `cancel_agent` stopped it, or the prompt it belonged to ended (section 3.3) | `partial_reply` when some text came first |
| `expired` | finished | it ran past its runtime limit (section 5) | `error` in words, and `partial_reply` when some text came first |

A finished state is final. Fetching a finished call's result, with `wait_agent`
or `cancel_agent`, returns the same result every time until the call is
dropped.

## 2. Results

Every result is a JSON object, handed to the model as JSON text.

**A call's result** has `call_id` and `state`, `label` when the call was given
one, and the fields its state carries (section 1.1). A returned file is listed as
`{"filename", "size_bytes", "path"}`, or with `"path": null` and `skipped`
(`over_limit` or `invalid_content`) when it was not saved (section 3.9).

A blocking `prompt_agent` keeps the fields a blocking call has always had:
`reply`, or `question` with `call_id`, or `error`, plus `attachments`. It adds
`state`, and `call_id` on every result.

**A refusal** is `{"error": "..."}` alone, without `call_id` or `state`: the
tool did nothing. Nothing was sent and no call changed. Refusals cover bad
arguments, a tool the helper does not offer (section 5), an unknown
address, an unknown `call_id`, a loop (section 3.8), a file outside the
allowed roots (section 3.9), a prompt the SDK refuses before sending (too
large for the target, attachments to an agent that takes none), and the
limit on tracked calls (section 5).

**Open calls.** While calls in the current scope are open, every result of
every tool carries `open_calls`, how many there are, and `open_calls_note`,
the same in words with what happens to them. Inside a served prompt the note
says they end with that prompt, so the model collects them before it answers.

| Tool | Result |
| --- | --- |
| `discover_agents` | `agents`: one entry per address with `address`, `agent`, `owner`, `name`, `description`, `identity`, `identity_verified`, `requires_signed_prompts`, `accepts_attachments` and `instances` |
| `prompt_agent` | a call's result: `wait` true, the first state other than `running`; `wait` false, `running` |
| `answer_agent` | a call's result: waiting, the first state other than `running` after the answer; not waiting, the call's state right after the answer, usually `running` |
| `wait_agent` | a call's result with `remaining`, the ids of the other given calls still open; on timeout `{"state": "running", "call_ids": [...]}` with the given calls, all still running |
| `cancel_agent` | `calls`: one call's result per id, in order; `{"call_id", "error"}` for an id not tracked |
| `list_agent_calls` | `calls`: `call_id`, `label`, `address`, `state`, `started_at`, and `ended_at` once finished (UTC, ISO 8601), in the order started |

## 3. The rules

### 3.1 Blocking is the default

`prompt_agent` waits unless the model passes `wait: false`. The simple case —
prompt, reply — stays one call, and a model that never passes `wait` gets
exactly the blocking behaviour. `wait: false` is for running several prompts
at once: the model starts them, keeps working, and collects each result
with `wait_agent`. A host that offers no `wait_agent` makes blocking the only
mode (section 5).

### 3.2 Questions go to the model

A prompted agent may ask its caller a question mid-stream (protocol §7): a
permission prompt, a clarification. The call becomes `input_required`, and the
question reaches the model: as the result of a blocking `prompt_agent` or
`answer_agent`, or through `wait_agent`. The model answers with
`answer_agent`. Nothing answers a question on the model's behalf, in either
mode, and no answer is ever preset.

- `answer_agent` goes on in the mode the call was started in, unless it is
  given `wait`: a blocking call waits again, a detached one returns at once.
- A stream may carry several questions at once (§7.3). The result shows the
  oldest open one; `answer_agent` answers it, and the next one follows.
- The asking agent chooses how long it waits for an answer (§7.3). An answer
  after that is lost, or the agent ends the stream with an error and the call
  becomes `failed`. If the stream ends with its terminator while a question
  is still open, the question is moot and the call is `completed`.
- A call that fails or expires while a question is open refuses that
  question, as the end of a served prompt does (section 3.3), so the asking
  agent does not wait out its own timeout for an answer that cannot come.
  That includes a question whose files could not be saved or whose reply
  look failed (section 6.3): it failed the call before the model saw it.

### 3.3 A call belongs to the prompt being served

An agent that calls these tools while it serves a prompt of its own is in
that prompt's **scope**.

- A call started in a served prompt belongs to it. Only tool calls in the
  same scope see it; its `call_id` means nothing anywhere else.
- When the served prompt ends — its handler returns or throws — the scope
  closes: each open question gets a refusal (a reply starting with `no`), and
  each open call is cancelled.
- While calls are open, every tool result says how many (section 2), so the model
  collects them before it answers.

The reason: a host answers the prompt it serves when its turn ends. A call
that outlived that prompt would bring back a result that nobody can deliver.

The SDK opens the scope from a request interceptor around the prompt
handler: `AgentService` hosts add the helper's interceptor to their
`interceptors`, and the scope closes after the handler's `next()` returns. A
host that serves prompts some other way opens the scope itself (section 6.2).

### 3.4 Outside a served prompt

Tool calls outside any served prompt — a person's own session, a long-running
agent loop — share one scope that lives as long as the helper. There, calls
live until they finish, and after that until they are dropped: at most 256
calls are tracked per scope; when a new call would pass the limit, the call
that finished longest ago is dropped. Only finished calls are dropped. When
every tracked call is still open, `prompt_agent` refuses with an error.

The helper reports every call that finishes outside a served prompt to an
`onSettled` / `on_settled` callback, with the call's result and whether a
tool call was waiting for it at that moment (its result then went to the
model already). A host may pass it on as a notification. A notification is
only a signal: the tracked result is authoritative, and `wait_agent` returns
it.

### 3.5 Waiting is bounded

- **By liveness.** The prompted agent's SDK sends an `ack` while it works
  (§6.4). The caller treats 60 seconds without a message as a failure
  (§6.6). A dead or unreachable agent becomes `failed` within a minute.
  Detached calls keep reading their stream in the background, so their acks
  keep them alive and their reply is complete when the model asks for it.
- **By the runtime limit.** A call that runs past it becomes `expired`
  (10 minutes by default; section 5).
- **By `wait_agent`'s `timeout_ms`**, which is capped by configuration. `0`
  polls. Without it, `wait_agent` waits up to the cap.

The model never sets a call's runtime limit.

### 3.6 Agents are named by address

The address is the agent's prompt subject, `agents.prompt.<agent>.<owner>.<name>`.
All running instances of one agent share it and the `agents` queue group
(§3.3–3.4), so any of them may take a prompt. An instance ID does not say
who answers, and it changes on every restart, so the model never sees one:
`discover_agents` returns one entry per address with the number of
instances behind it. Discovery leaves out the agent's own address.

### 3.7 Errors are results

Anything the model can act on comes back in words: a refusal, or a `failed`
call with `error`. A failure of the tool call itself, at the host level, is
for bugs only.

### 3.8 Loops are refused

The protocol has no depth limit, and a model with the tool in reach will use
it. Two guards, each a refusal in words:

- `prompt_agent` refuses the agent's own address.
- It refuses the agent whose prompt is being served: the model answers its
  caller instead of prompting it back. The guard compares the served
  prompt's sender, as the host verified its signature (§13.7), with the
  identity the target registered (§13.10).

### 3.9 Files

Agents usually run on different machines, and a local path means nothing on
another one. A path never goes into a prompt's text: a file travels as an
attachment (§5.2), inside the message.

- **Sending.** `prompt_agent` passes the model's paths to the SDK's
  `prompt()`, which reads and encodes each file, and refuses before sending
  when the target does not accept attachments or the message is over its
  `max_payload` (§5.4). The tool accepts only paths under configured roots
  and refuses any other path. A path is checked after following its links.
  Without the limit a model could send any file the process can read.
- **The staging directory is always a root**, the default one or one the
  host sets. It holds the helper's own output, the files other agents sent
  back, so the model can send one on with no configuration. Roots a host
  names add to it, and by default there are none: the working directory is
  not a root unless named. It can hold the agent's own `.env` with its
  credentials, and a model can be talked into attaching it. A host that
  wants the working directory, or any other, names it (section 5); a coding
  agent's host names its project directory.
- **Receiving.** Every file that comes back, with the reply or with a
  question (§6.3, §7.1), is saved on the caller's machine before the result
  that lists it is returned: with the SDK's `saveAttachments` /
  `save_attachments`, one directory per call under the staging directory,
  within a total per call (64 MiB by default). Those helpers give each file
  a name that is safe on every operating system, never overwrite and never
  follow a link, and make the files readable by their owner only. The model
  opens a saved file with its own tools; the bytes never enter the result.

### 3.10 Cancelling drops the stream

`cancel_agent`, a host's abort of a blocking tool call, and the end of a
served prompt all do the same: end the call as `cancelled`, drop its
subscription, then refuse its open questions, including a question still
being taken in (section 6.3). A refusal goes to the question's own reply
subject, so it reaches the asking agent without the subscription. The
protocol has no cancel message (§6.7). The prompted agent works on until it
finishes, and whatever it sends is discarded.

`wait_agent` is different: aborting it stops the wait, and the calls it
waited for keep running.

### 3.11 The tool-call ID

The host passes the model's tool-call ID to the helper, which puts it into
the prompt options' `context` for every prompt `prompt_agent` sends: as
`toolCallId` in TypeScript (`PromptOptions.context`) and as `tool_call_id`
in Python (`prompt(context=...)`). The SDK never reads it and never sends
it; any prompt interceptor that wants it reads it from `ctx.context`, for
example to record which model call started which prompt.

`label` stays local: it names the call in the model's own lists and is never
sent to the target.

## 4. Parameters

| Tool | Parameter | |
| --- | --- | --- |
| `discover_agents` | `agent`, `owner`, `name` | optional filters, exact and combined; without them, every agent |
| `prompt_agent` | `address` | as `discover_agents` returned it |
| | `prompt` | the task, complete in itself |
| | `attachments` | optional local paths under the configured roots, only to an agent that accepts them |
| | `label` | optional, for the model's lists; never sent |
| | `wait` | optional, default `true` |
| `wait_agent` | `call_ids` | one or more calls of the current scope |
| | `timeout_ms` | optional; `0` polls; capped by configuration, which is also the default |
| `answer_agent` | `call_id` | a call whose state is `input_required` |
| | `answer` | the answer, in the form the question asks for |
| | `wait` | optional; default: the mode the call was started in |
| `cancel_agent` | `call_ids` | one or more calls of the current scope |
| `list_agent_calls` | — | |

The descriptions the model reads are in the definitions.

## 5. Configuration and limits

Limits are configuration, never parameters, except `wait_agent`'s
`timeout_ms`, which the configuration caps.

| Setting | TypeScript | Python | Default |
| --- | --- | --- | --- |
| The caller-side client | `agents` | `agents` | required |
| The tools offered | `tools` | `tools` | all six |
| The agent's own address, left out of discovery and refused | `selfAddress` | `self_address` | none |
| How long one discovery waits | `discoverTimeoutMs` | `discover_timeout` (s) | the SDK's discovery default |
| The runtime limit per call; past it the call is `expired` | `maxWaitMs` | `max_wait_s` | 10 minutes, the SDK's default |
| The cap on `wait_agent`'s `timeout_ms` | `maxWaitAgentMs` | `max_wait_agent_s` | the runtime limit |
| Calls tracked per scope | `maxCalls` | `max_calls` | 256 |
| The roots files may be sent from, besides the staging directory | `attachmentRoots` | `attachment_roots` | none |
| The staging directory for returned files | `stagingDir` | `staging_dir` | a new private directory under the system's temporary directory, removed when the helper closes |
| The total saved per call | `maxSavedBytesPerCall` | `max_saved_bytes_per_call` | 64 MiB |
| Finished calls outside a served prompt | `onSettled` | `on_settled` | none |
| Extensions | `extensions` | `extensions` | none |

The staging directory is always a root, whether the default or set, and
roots given add to it: a host that names its project directory still lets
the model send returned files on. A relative root or staging directory is
taken from the working directory when the helper is made, as the model's
relative paths are, so a process that changes its directory later sends
from and saves to the same places.

**Offering fewer tools.** Every definition a model is shown costs input
tokens on every model call: about 1.5k for all six, a little over half that
for three. An agent that does not need to run calls at once offers
`discover_agents`, `prompt_agent` and `answer_agent`, which both SDKs export
as `BLOCKING_AGENT_TOOLS`; `AGENT_TOOL_NAMES` names all six. The helper shows
only the definitions of the tools it offers, in the order of section 1, and
refuses any other tool in words.

- **Without `wait_agent` nothing can be detached**, or the model could start
  a call it cannot collect. `prompt_agent` and `answer_agent` have no `wait`
  parameter, and a `wait: false` that arrives anyway is refused.
- **The definitions are derived, never rewritten:** the same definitions
  without their `wait` parameter, and the same descriptions, except that a
  description that mentions `wait_agent` is replaced by its blocking-only
  words in [`test-fixtures/agent-tools/blocking.json`](../test-fixtures/agent-tools/blocking.json).
- **A set that makes no sense is refused** when the helper is made, with
  the reason in the error:
  - no tool at all;
  - `answer_agent`, `wait_agent`, `cancel_agent` or `list_agent_calls`
    without `prompt_agent`, which starts the calls they work on;
  - `prompt_agent` without `answer_agent`: a question the prompted agent
    asks would reach a model with no way to answer it, and the asking agent
    would wait out its timeout.
- **A result points the model only to tools offered.** The note on open
  calls (section 2) and a refusal's advice (list your calls, discover the
  current agents, collect or stop some calls) name a tool only when the
  helper offers it. Without `wait_agent`, the note tells the model to answer
  the calls' questions with `answer_agent` rather than to collect them.

Whether the tools are offered at all is the host's choice: a role that must
never delegate is offered none.

## 6. Using the helper

### 6.1 Definitions and execution

The helper holds the definitions of its tools, all six unless `tools` names
fewer (section 5), and executes a tool call by name. Each host maps the
definitions to its own tool format and hands the result, as JSON text, back
to the model.

- TypeScript: `tools.definitions`; `await tools.execute(name, args, { toolCallId, signal })`.
  `args` is an object or the JSON text a model produced. `signal` aborts a
  blocking call (section 3.10).
- Python: `tools.definitions`; `await tools.execute(name, args, tool_call_id=...)`.
  Cancelling the task that runs a blocking call cancels the call.
- Fewer tools: `new AgentTools({ agents, tools: BLOCKING_AGENT_TOOLS })` in
  TypeScript, `AgentTools(agents, tools=BLOCKING_AGENT_TOOLS)` in Python.

### 6.2 The scope

- On an `AgentService` host, add the helper's request interceptor:
  `interceptors: [tools.requestInterceptor]` in TypeScript,
  `interceptors=[tools.request_interceptor]` in Python.
- A host that serves prompts some other way runs each served prompt inside a
  scope of its own: `await tools.runInPromptScope(fn, { caller })` in
  TypeScript, `async with tools.prompt_scope(caller=...)` in Python. `caller`
  is the served prompt's verified sender ID, for the loop guard; without it
  the guard of section 3.8 against the caller does not apply.
- `close()` / `aclose()` cancels every open call and removes a staging
  directory the helper created.

### 6.3 Extension hooks

An extension adds to the tools without changing them. It implements any of
three hooks; several extensions run in the order given.

| Hook | When | May |
| --- | --- | --- |
| discovery fields | for each `discover_agents` entry, with the agent's live handle | add fields to the entry |
| prompt rewrite | before `prompt_agent` sends, after the guards, with the address, the text, the attachment paths, the target, the `call_id`, the label, the tool-call ID and the served caller | change the prompt's text, add prompt `context`, add fields to the call's results, or refuse the prompt with an error in words |
| reply look | when a reply completes and when a question arrives, with the text and the saved files | add fields to that result |

A hook may not replace a field the contract defines; one that tries is a bug.
The discovery fields and the prompt rewrite throw it. The reply look runs in
the call's reader, outside any tool call, so there is nothing to throw to: it
fails the call and logs an error, and the call's `error` says an extension
has a bug, not the prompted agent. A reply look that throws fails the call.

## 7. Stated honestly

- **Nothing is durable.** If the caller's process stops, its open calls are
  lost and the prompted agents work on without knowing (§6.6, §6.7).
- **Cancelling drops the stream, not the work.** The protocol has no cancel
  message (§6.7): the prompted agent works on until it finishes, and its
  reply is discarded.
- **A question left unanswered is lost.** The asking agent waits only as long
  as it chooses (§7.3). After that an answer reaches nobody, and the agent
  either ends the stream with an error or goes on with a default of its own,
  without telling the caller. A refusal (sections 3.2, 3.10) is sent once
  and never confirmed: when the connection is gone, it reaches nobody
  either, and the asking agent waits out its timeout.
- **The caller guard needs a signed sender.** It compares the served
  prompt's verified sender with the target's registered identity. An unsigned
  or merely claimed sender, or a target that registered no identity, cannot
  be matched, and the guard does not apply. The own-address guard always
  does.
- **Calls end with the served prompt.** A call cannot outlive the prompt it
  was started in; a model that answers before collecting its calls loses
  them.
- **The calling model decides what the prompted agent asks**, permission
  prompts included. The prompted agent's own settings decide which actions
  ask at all.
- **Saved files last as long as the helper.** A reply's attachments have no
  size limit in the protocol, so the total per call is the only guard against
  a flood of files.

## 8. What it rests on

No wire change and no protocol version change. The tools use these sections
of [the protocol](https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md)
as they are:

| Section | Used for |
| --- | --- |
| §2.1, §4 | discovery, the address, `attachments_ok`, `max_payload` |
| §3.3–3.4 | one address for all instances of an agent, the `agents` queue group |
| §5.2, §5.4 | attachments, and the caller's checks before sending |
| §5.6 | extra envelope fields an extension's prompt interceptor may add |
| §6.3–6.5 | the reply, its files, the terminator |
| §6.6 | the inactivity timeout, and no durable delivery |
| §6.7 | cancelling by dropping the subscription |
| §7 | questions, their files, one reply per question, the asker's timeout |
| §9 | refusals and errors in a stream |
| §13.7, §13.10 | the verified sender and the registered identity the caller guard compares |
