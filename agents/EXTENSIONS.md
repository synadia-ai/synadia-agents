# Extensions

The Claude Code, OpenClaw and PI plugins can load extension modules. An
extension adds behaviour around the plugin without changing the plugin or
the protocol: it can add fields and headers to the prompts the plugin's
agent tools send, publish signed messages of its own alongside them,
refuse an incoming prompt with a protocol error, add fields to the
heartbeat, extend the agent tools through their extension hooks, and
follow the harness's events. Without an extension the plugin behaves as
this README describes.

**Naming an extension.** Set `SYNADIA_AGENT_EXTENSIONS` to one or more
module specifiers separated by commas, or the per-harness variable that
wins over it (`SYNADIA_PI_EXTENSIONS`, `SYNADIA_OPENCLAW_EXTENSIONS`,
`SYNADIA_CLAUDE_CODE_EXTENSIONS`), or the `extensions` array in the
plugin's configuration. A specifier is a package name, resolved from the
plugin's own directory upward like any import, or an absolute path to a
package directory or a file. A configuration entry may be an object,
`{ "module": "…", "options": { … } }`, whose `options` the plugin hands to
the module unread. Relative paths are refused.

**What a module exports.** One default export: a factory, called once at
start with the harness's name, the plugin's name and version, its resolved
settings (owner, name, identity and trust modes, its state directory, its
configuration as read), the entry's `options` and the plugin's logger. It
returns the extension, or a promise of it.

**What the plugin takes from the extension.** Prompt interceptors, given
to the plugin's `Agents` client; request interceptors and a heartbeat
extras provider, given to the plugin's `AgentService`, the extensions'
interceptors running before the plugin's own; extensions for `AgentTools`;
a `started` callback with the live client and service once the plugin is
on the bus, and a `stopping` callback before it leaves; and handlers for
the harness's events. These are the SDK's own types
(`PromptInterceptor` and `AgentToolsExtension` in `@synadia-ai/agents`,
`RequestInterceptor` and `heartbeatExtras` in `@synadia-ai/agent-service`).

**The harness's events.** Every plugin reports a prompt accepted, called
synchronously inside the prompt handler after the interceptors ran, and a
prompt ended with its outcome; every plugin runs each agent-tool call
inside the extension's `aroundToolCall` wrapper, naming the served prompt
the model works in. PI also runs the hand-over of a prompt to its loop
inside `aroundInject`, and asks `providerHeaders` for headers to add to
the provider request of an active prompt. OpenClaw runs the turn's
dispatch inside `aroundDispatch`. Claude Code reports `sessionStarted`
and `turnStopped` from its hooks. A wrapper must call its `run` argument
once, synchronously, and return its value. A wrapper may be an async
function: the plugin still takes `run`'s own value, and the wrapper must
call `run` once, before its first `await`, so the step keeps its timing.

**Failure.** A module that cannot be loaded is logged once and the plugin
starts without it. An event handler that throws is logged and ignored; a
wrapper that does not call `run` has it called by the plugin. Interceptors
keep the SDK's rules: a request interceptor that throws before `next()`
refuses the request, with the code of a `RequestRejectedError` or `500`;
a prompt interceptor's first phase that throws fails that prompt.

**Limits.** An extension may not set the protocol's fields or the
`Agent-Sender` header, may not change the tools offered, and sees nothing
of the plugin beyond the context, the handles and the events above. It
runs on its own installed copy of the SDK packages; the plugin's status
output names the extensions it loaded.
