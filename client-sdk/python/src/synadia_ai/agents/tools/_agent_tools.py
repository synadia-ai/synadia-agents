"""``AgentTools`` — the agent tools of ``docs/agent-tools.md`` as one helper.

The definitions a model is shown, and the execution of a tool call by name:

- ``discover_agents``: the agents that can be prompted, one entry per address
- ``prompt_agent``: a prompt to one of them; waits for the reply or a
  question, or (``wait: false``) returns at once
- ``wait_agent``: the first of some calls that finished or asked
- ``answer_agent``: the answer to a call's open question
- ``cancel_agent``: stop calls, refusing their questions and dropping their streams
- ``list_agent_calls``: the calls tracked in the current scope

Everything is built on the caller API — :meth:`Agents.discover`,
:meth:`Agent.prompt`, :meth:`Query.reply`, :func:`save_attachments` — so
nothing changes on the wire: the agent being prompted sees an ordinary
prompt.

A host may offer a subset of the six (``tools``). Without ``wait_agent``
nothing can be detached, and a result points the model only to tools it
has.

A call is one prompt. Every call, blocking or not, is read by a task of its
own from the moment it is sent: it collects the text, saves returned files
and queues questions, so its acks keep the stream alive while nobody waits
and the reply is complete when the model asks for it. A blocking tool call
only waits for that task to reach a state other than ``running``.

Calls live in a scope. A served prompt is one: :attr:`AgentTools.request_interceptor`
(for an ``AgentService`` host) or :meth:`AgentTools.prompt_scope` (for any
other) binds the scope in a :mod:`contextvars` variable the tool calls made
from the handler see, and cancels the calls still open when the handler is
done. Outside any served prompt, tool calls share one scope that lives as
long as the helper, and ``on_settled`` reports each call that finishes
there.

Errors the model can act on come back as results in words; the helper
raises only for bugs (a misconfiguration, an extension that breaks the
contract, use after :meth:`AgentTools.aclose`). The TypeScript SDK's
``AgentTools`` is the same helper.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import functools
import inspect
import json
import logging
import os
import re
import secrets
import shutil
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Protocol

from ..agent import DEFAULT_PROMPT_MAX_WAIT_S, Query
from ..attachments import DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES, save_attachments
from ..discovery import DiscoverFilter
from ..envelope import Attachment
from ..errors import (
    AgentsClosedError,
    StreamMaxWaitExceededError,
    StreamStalledError,
)
from ..messages import ResponseChunk, StatusChunk
from ._args import (
    ArgsError,
    DiscoverArgs,
    parse_answer_args,
    parse_cancel_args,
    parse_discover_args,
    parse_prompt_args,
    parse_wait_args,
)

if TYPE_CHECKING:
    from ..agent import Agent, StreamMessage
    from ..agents import Agents
    from ..identity.sender_header import SenderInfo

log = logging.getLogger(__name__)

#: Default for ``max_calls``: calls tracked per scope.
DEFAULT_AGENT_TOOLS_MAX_CALLS = 256

#: What an open question is answered with when its call is cancelled — by
#: ``cancel_agent``, a host's cancellation, or the end of the served prompt —
#: and when it fails or expires. It starts with ``no``, so an agent that asked
#: for a permission reads a denial.
AGENT_TOOLS_QUESTION_REFUSAL = "no: the caller stopped waiting for this prompt and cannot answer"

AgentCallState = Literal["running", "input_required", "completed", "failed", "cancelled", "expired"]

#: A tool's result: a JSON object the host hands its model as JSON text. The
#: shapes are in ``test-fixtures/agent-tools/*.result.json``.
AgentToolResult = dict[str, Any]

_OPEN_STATES = ("running", "input_required")

#: The six, in the contract's order.
_TOOL_NAMES = (
    "discover_agents",
    "prompt_agent",
    "wait_agent",
    "answer_agent",
    "cancel_agent",
    "list_agent_calls",
)

# The fields the contract defines. An extension may not set them.
_CALL_RESULT_FIELDS = frozenset(
    {
        "call_id",
        "state",
        "label",
        "reply",
        "question",
        "error",
        "partial_reply",
        "attachments",
        "remaining",
        "call_ids",
        "open_calls",
        "open_calls_note",
    }
)
_DISCOVERY_ENTRY_FIELDS = frozenset(
    {
        "address",
        "agent",
        "owner",
        "name",
        "description",
        "identity",
        "identity_verified",
        "requires_signed_prompts",
        "accepts_attachments",
        "instances",
    }
)

_SERVICE_ERROR_RE = re.compile(r"^service error (\S+): ?(.*)$", re.DOTALL)


@functools.cache
def _package_json(name: str) -> str:
    return resources.files("synadia_ai.agents.tools").joinpath(name).read_text("utf-8")


def agent_tool_definitions() -> list[dict[str, Any]]:
    """The six definitions, as a fresh copy on every call.

    A copy of ``test-fixtures/agent-tools/<name>.json`` (the package cannot
    read files outside itself), in the order the contract lists them. A host
    may change its copy — add a parameter of its own, say — without touching
    anyone else's.
    """
    definitions: list[dict[str, Any]] = json.loads(_package_json("definitions.json"))
    return definitions


def _offered_definitions(offered: frozenset[str]) -> list[dict[str, Any]]:
    """The definitions of the tools offered, in the contract's order, as a fresh copy.

    Without ``wait_agent`` nothing can be detached: each definition loses its
    ``wait`` parameter, and a description that mentions ``wait_agent`` is
    replaced by its blocking-only words, a copy of
    ``test-fixtures/agent-tools/blocking.json``. Nothing else changes.
    """
    definitions = [d for d in agent_tool_definitions() if d["name"] in offered]
    if "wait_agent" in offered:
        return definitions
    blocking: dict[str, str] = json.loads(_package_json("blocking.json"))
    for definition in definitions:
        definition["parameters"]["properties"].pop("wait", None)
        if "wait_agent" in definition["description"]:
            definition["description"] = blocking[definition["name"]]
    return definitions


def _offered_tools(tools: Sequence[str] | None) -> frozenset[str]:
    """The tools offered, checked.

    A set that makes no sense is a misconfiguration and raises: a name not of
    the six, no tool at all, a tool that works on calls without
    ``prompt_agent``, which starts them, or ``prompt_agent`` without
    ``answer_agent``, which answers their questions.
    """
    if tools is None:
        return frozenset(_TOOL_NAMES)
    if isinstance(tools, str):
        raise ValueError(f"tools must be a list of tool names (got {tools!r})")
    for name in tools:
        if name not in _TOOL_NAMES:
            raise ValueError(f"tools names {name!r}, which is not one of {', '.join(_TOOL_NAMES)}")
    offered = frozenset(tools)
    if not offered:
        raise ValueError("tools names no tool; a role that must not delegate needs no AgentTools")
    orphans = [n for n in _TOOL_NAMES if n in offered and n != "discover_agents"]
    if "prompt_agent" not in offered and orphans:
        them = "it works on" if len(orphans) == 1 else "they work on"
        raise ValueError(
            f"tools offers {', '.join(orphans)} without prompt_agent, which starts the calls {them}"
        )
    if "prompt_agent" in offered and "answer_agent" not in offered:
        raise ValueError(
            "tools offers prompt_agent without answer_agent, so a question the prompted agent "
            "asks would reach a model with no way to answer it, and the asking agent would wait "
            "out its timeout"
        )
    return offered


@dataclass(frozen=True, slots=True)
class SettledInfo:
    """What ``on_settled`` is told besides the result."""

    #: ``True`` when a tool call was waiting for this call as it finished, so
    #: its result went to the model already.
    awaited: bool


@dataclass(frozen=True, slots=True)
class AgentToolsPromptContext:
    """What a prompt rewrite sees (docs/agent-tools.md, section 6.3)."""

    address: str
    #: The prompt text, as the extensions before this one left it.
    prompt: str
    #: The attachments' paths, resolved and checked against the roots.
    attachments: tuple[str, ...]
    #: The agent the prompt goes to.
    target: Agent
    #: The call's ID, as the model will see it.
    call_id: str
    label: str | None
    tool_call_id: str | None
    #: The served prompt's verified sender, when there is one.
    caller: str | None


@dataclass(frozen=True, slots=True)
class AgentToolsPromptRewrite:
    """What a prompt rewrite may return; every field optional."""

    #: The prompt's new text.
    prompt: str | None = None
    #: Values added to the prompt's ``context``.
    context: Mapping[str, object] | None = None
    #: Fields added to every result of the call.
    fields: Mapping[str, Any] | None = None
    #: Refuse the prompt: nothing is sent, and the model gets this error.
    error: str | None = None


@dataclass(frozen=True, slots=True)
class AgentToolsReplyContext:
    """What a reply look sees (docs/agent-tools.md, section 6.3)."""

    call_id: str
    address: str
    target: Agent
    #: A completed reply, or a question as it arrives.
    kind: Literal["reply", "question"]
    #: The whole reply, or the question.
    text: str
    #: The files that came with it, saved, as the result lists them.
    attachments: tuple[dict[str, Any], ...]


class AgentToolsExtension:
    """An extension: override any of the three hooks.

    Several extensions run in the order given. A hook may not set a field
    the contract defines; one that does is a bug. The discovery and prompt
    hooks raise it; a reply look fails the call and logs an error.
    """

    async def discovery_fields(self, agent: Agent) -> Mapping[str, Any] | None:
        """Extra fields for a ``discover_agents`` entry."""
        return None

    async def before_prompt(self, ctx: AgentToolsPromptContext) -> AgentToolsPromptRewrite | None:
        """A rewrite of the prompt before it is sent."""
        return None

    async def after_reply(self, ctx: AgentToolsReplyContext) -> Mapping[str, Any] | None:
        """A look at a completed reply or an arriving question; may add fields to that result.

        An exception fails the call.
        """
        return None


class _RequestContext(Protocol):
    """What the helper's request interceptor reads of a host's request context."""

    @property
    def sender(self) -> SenderInfo | None: ...


OnSettled = Callable[[AgentToolResult, SettledInfo], Awaitable[None] | None]

# The served-prompt scope of each helper, keyed by the helper's id: one
# module-level variable, so no helper creates variables of its own.
_SERVED: ContextVar[Mapping[int, _Scope]] = ContextVar("synadia_ai_agent_tools_scope")


class AgentTools:
    """The helper. See the module docstring and ``docs/agent-tools.md``."""

    def __init__(
        self,
        agents: Agents,
        *,
        tools: Sequence[str] | None = None,
        self_address: str | None = None,
        discover_timeout: float | None = None,
        max_wait_s: float = DEFAULT_PROMPT_MAX_WAIT_S,
        max_wait_agent_s: float | None = None,
        max_calls: int = DEFAULT_AGENT_TOOLS_MAX_CALLS,
        attachment_roots: Sequence[str | os.PathLike[str]] | None = None,
        staging_dir: str | os.PathLike[str] | None = None,
        max_saved_bytes_per_call: int | None = DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES,
        on_settled: OnSettled | None = None,
        extensions: Sequence[AgentToolsExtension] = (),
        logger: logging.Logger | None = None,
    ) -> None:
        """Configure the helper; every limit is configuration, never a parameter.

        - ``tools``: the tools offered, of the six; ``None`` means all six.
          :attr:`definitions` holds only these, in the contract's order, and
          :meth:`execute` refuses any other. Without ``wait_agent`` nothing can be
          detached: ``prompt_agent`` and ``answer_agent`` lose their ``wait``
          parameter and refuse ``wait: false``. Every tool but ``discover_agents``
          needs ``prompt_agent``, which starts the calls they work on, and
          ``prompt_agent`` needs ``answer_agent``, or a question the prompted
          agent asks could not be answered. Each definition costs input tokens
          on every model call, so an agent that needs no async calls offers
          ``discover_agents``, ``prompt_agent`` and ``answer_agent``.
        - ``self_address``: the agent's own address, left out of discovery and refused.
        - ``discover_timeout``: how long one discovery waits, in seconds; ``None``
          uses the SDK's discovery default.
        - ``max_wait_s``: the runtime limit per call; past it the call is ``expired``.
        - ``max_wait_agent_s``: the cap on ``wait_agent``'s ``timeout_ms``, and its
          default; ``None`` means ``max_wait_s``.
        - ``max_calls``: calls tracked per scope.
        - ``attachment_roots``: directories files may be sent from besides the
          staging directory, which always is one, the default or ``staging_dir``:
          it holds the files other agents sent back, so the model can send one on.
          A path is checked after its links are followed, and a relative one is
          taken from the working directory at construction. ``None`` means none,
          so only returned files can be sent. Name the working directory, say, to
          allow its files.
        - ``staging_dir``: where returned files are saved, one directory per call;
          ``None`` means a new private directory under the system's temporary
          directory, removed by :meth:`aclose`. A directory given here is kept.
        - ``max_saved_bytes_per_call``: the total of returned files saved per call;
          ``None`` disables the limit.
        - ``on_settled``: called for every call that finishes outside a served
          prompt, with its result; a signal only. An exception is logged.
        - ``extensions``: run in order.
        - ``logger``: for a failing ``on_settled``, and an extension's bug in a
          reply look; ``None`` means this module's logger.
        """
        offered = _offered_tools(tools)
        if discover_timeout is not None and not discover_timeout > 0:
            raise ValueError(f"discover_timeout must be > 0 (got {discover_timeout!r})")
        if not max_wait_s > 0:
            raise ValueError(f"max_wait_s must be > 0 (got {max_wait_s!r})")
        if max_wait_agent_s is not None and not max_wait_agent_s >= 0:
            raise ValueError(f"max_wait_agent_s must be 0 or more (got {max_wait_agent_s!r})")
        if isinstance(max_calls, bool) or not isinstance(max_calls, int) or max_calls < 1:
            raise ValueError(f"max_calls must be a whole number above 0 (got {max_calls!r})")
        if max_saved_bytes_per_call is not None and max_saved_bytes_per_call < 0:
            raise ValueError(
                f"max_saved_bytes_per_call must be 0 or more (got {max_saved_bytes_per_call!r})"
            )
        self._agents = agents
        self._offered = offered
        self._self_address = self_address
        self._discover_timeout = discover_timeout
        self._max_wait_s = max_wait_s
        self._max_wait_agent_s = max_wait_agent_s if max_wait_agent_s is not None else max_wait_s
        self._max_calls = max_calls
        self._attachment_roots = [Path(r) for r in attachment_roots or ()]
        self._staging_option = Path(staging_dir) if staging_dir is not None else None
        self._max_saved_bytes = max_saved_bytes_per_call
        self._on_settled = on_settled
        self._extensions = tuple(extensions)
        self._log = logger if logger is not None else log
        self._cwd = Path.cwd()
        self._root = _Scope(served=False, caller=None)
        self._served: set[_Scope] = set()
        # Live handles by address, from the last discovery that saw them:
        # `prompt_agent` needs a handle, and the model only has the address.
        self._known: dict[str, Agent] = {}
        self._staging: Path | None = None
        self._owns_staging = False
        # Orders the events `wait_agent` picks from: a question, or a finish.
        self._seq = 0
        self._closed = False
        self._background: set[asyncio.Task[Any]] = set()
        #: The definitions of the tools offered, the helper's own copy: a host
        #: maps them to its tool format, and may change this copy without
        #: touching another's.
        self.definitions: list[dict[str, Any]] = _offered_definitions(offered)
        #: Opens a scope per served prompt. Structurally a ``RequestInterceptor``
        #: of ``synadia_ai.agent_service``, which depends on this package and not
        #: the other way round: pass it in ``AgentService(interceptors=[...])``.
        self.request_interceptor = _ToolsRequestInterceptor(self)

    async def __aenter__(self) -> AgentTools:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def execute(
        self,
        name: str,
        args: Any = None,
        *,
        tool_call_id: str | None = None,
    ) -> AgentToolResult:
        """Execute one tool call from the model and return its result.

        The host hands the result back as JSON text (``json.dumps(result)``).
        ``args`` is the call's arguments as the model produced them: a dict,
        or the JSON text; none counts as ``{}``. ``tool_call_id`` is the
        model's ID for this call: ``prompt_agent`` puts it into the prompt's
        ``context`` as ``tool_call_id``, where every prompt interceptor of the
        client finds it in ``ctx.context``; it is never sent. Cancelling the
        task that runs a blocking ``prompt_agent`` or ``answer_agent``
        cancels the call; cancelling ``wait_agent`` only stops the wait. A
        tool the helper does not offer is refused like any other mistake.
        Never raises for something the model got wrong.
        """
        self._ensure_open()
        scope = _SERVED.get({}).get(id(self), self._root)
        result: AgentToolResult
        if name in _TOOL_NAMES and name not in self._offered:
            offered = ", ".join(n for n in _TOOL_NAMES if n in self._offered)
            result = {"error": f'the tool "{name}" is not offered; your tools are {offered}'}
        elif name == "discover_agents":
            result = await self._discover_agents(args)
        elif name == "prompt_agent":
            result = await self._prompt_agent(scope, args, tool_call_id)
        elif name == "wait_agent":
            result = await self._wait_agent(scope, args)
        elif name == "answer_agent":
            result = await self._answer_agent(scope, args)
        elif name == "cancel_agent":
            result = await self._cancel_agent(scope, args)
        elif name == "list_agent_calls":
            result = self._list_agent_calls(scope)
        else:
            result = {"error": f'unknown tool "{name}"'}
        return self._with_open_calls(scope, result)

    @contextlib.asynccontextmanager
    async def prompt_scope(self, *, caller: str | None = None) -> AsyncIterator[None]:
        """Serve one prompt inside a scope of its own.

        The tool calls made inside the ``async with`` share the scope; when
        it exits, the calls still open are cancelled and their questions
        refused. ``caller`` is the served prompt's sender ID when its
        signature verified: ``prompt_agent`` refuses the agent that
        registered it. For hosts that serve prompts without
        ``AgentService``; on one, use :attr:`request_interceptor`.
        """
        self._ensure_open()
        scope = _Scope(served=True, caller=caller)
        self._served.add(scope)
        token = _SERVED.set({**_SERVED.get({}), id(self): scope})
        try:
            yield
        finally:
            _SERVED.reset(token)
            self._served.discard(scope)
            await self._close_scope(scope)

    async def aclose(self) -> None:
        """Cancel every open call, in every scope; remove a staging directory the helper made.

        Idempotent.
        """
        if self._closed:
            return
        self._closed = True
        for scope in [self._root, *self._served]:
            await self._close_scope(scope)
        if self._owns_staging and self._staging is not None:
            await asyncio.to_thread(shutil.rmtree, self._staging, True)

    # --- discover_agents -----------------------------------------------------

    async def _discover_agents(self, args: Any) -> AgentToolResult:
        parsed = parse_discover_args(args)
        if isinstance(parsed, ArgsError):
            return {"error": parsed.error}
        try:
            found = await self._discover(parsed)
        except Exception as err:
            return {"error": f"discovery failed: {_describe(err)}"}
        # Instances of one agent share its address and SHOULD register alike
        # (§3.4). When they do not, the entry shows one whose identity verifies.
        by_address: dict[str, list[Any]] = {}
        for handle in found:
            address = handle.prompt_subject
            if address == self._self_address:
                continue
            seen = by_address.get(address)
            if seen is None:
                by_address[address] = [handle, 1]
            else:
                seen[1] += 1
                if not seen[0].id_sig_verified and handle.id_sig_verified:
                    seen[0] = handle
        agents: list[dict[str, Any]] = []
        for address, (handle, instances) in by_address.items():
            extra: dict[str, Any] = {}
            for extension in self._extensions:
                _add_fields(
                    extra,
                    await extension.discovery_fields(handle),
                    _DISCOVERY_ENTRY_FIELDS,
                    "a discovery entry",
                )
            agents.append(
                {
                    "address": address,
                    "agent": handle.agent,
                    "owner": handle.owner,
                    "name": handle.session_name,
                    "description": handle.description,
                    "identity": str(handle.identity) if handle.identity is not None else None,
                    "identity_verified": handle.id_sig_verified,
                    "requires_signed_prompts": handle.min_sender_trust == "signed",
                    # As the SDK reads it: only an agent that says `false` refuses files.
                    "accepts_attachments": handle.prompt_endpoint.attachments_ok is not False,
                    "instances": instances,
                    **extra,
                }
            )
        return {"agents": agents}

    async def _discover(self, filt: DiscoverArgs) -> list[Agent]:
        """Discover, and remember the handle behind each address."""
        wanted = (
            DiscoverFilter(agent=filt.agent, owner=filt.owner, session_name=filt.name)
            if filt.agent is not None or filt.owner is not None or filt.name is not None
            else None
        )
        found = await self._agents.discover(timeout=self._discover_timeout, filter=wanted)
        for handle in found:
            known = self._known.get(handle.prompt_subject)
            if known is None or handle.id_sig_verified or not known.id_sig_verified:
                self._known[handle.prompt_subject] = handle
        return found

    async def _lookup(self, address: str) -> Agent | None:
        """The handle for an address: from an earlier discovery, else from a fresh one."""
        known = self._known.get(address)
        if known is not None:
            return known
        await self._discover(DiscoverArgs())
        return self._known.get(address)

    # --- prompt_agent --------------------------------------------------------

    async def _prompt_agent(  # noqa: PLR0911, PLR0912
        self, scope: _Scope, args: Any, tool_call_id: str | None
    ) -> AgentToolResult:
        parsed = parse_prompt_args(args)
        if isinstance(parsed, ArgsError):
            return {"error": parsed.error}
        if not parsed.wait and "wait_agent" not in self._offered:
            return {
                "error": 'prompt_agent: "wait" cannot be false here; '
                "the call waits for the reply or a question"
            }
        address = parsed.address
        if scope.closed:
            return {"error": "the prompt you were answering has ended; no call can start in it"}
        if address == self._self_address:
            return {"error": f'"{address}" is your own address; answer the prompt yourself'}
        try:
            target = await self._lookup(address)
        except Exception as err:
            return {"error": f'could not look up "{address}": {_describe(err)}'}
        if target is None:
            return {"error": self._no_agent_at(address)}
        if scope.caller is not None and target.identity == scope.caller:
            return {
                "error": f'the agent at "{address}" sent the prompt you are answering; '
                "answer it rather than prompting it back"
            }
        paths = await self._resolve_attachments(parsed.attachments)
        if isinstance(paths, ArgsError):
            return {"error": paths.error}
        if not self._reserve(scope):
            actions = [a for a in self._open_call_actions("some", "their") if a is not None]
            then = (
                f"{' or '.join(actions)} before you start another"
                if actions
                else "another can start when one of them finishes"
            )
            return {"error": f"all {self._max_calls} tracked calls are still open; {then}"}

        reserved = True
        try:
            call_id = _new_call_id()
            text = parsed.prompt
            context: dict[str, object] = {}
            fields: dict[str, Any] = {}
            for extension in self._extensions:
                rewrite = await extension.before_prompt(
                    AgentToolsPromptContext(
                        address=address,
                        prompt=text,
                        attachments=paths,
                        target=target,
                        call_id=call_id,
                        label=parsed.label,
                        tool_call_id=tool_call_id,
                        caller=scope.caller,
                    )
                )
                if rewrite is None:
                    continue
                if rewrite.error is not None:
                    return {"error": rewrite.error}
                if rewrite.prompt is not None:
                    text = rewrite.prompt
                context.update(rewrite.context or {})
                _add_fields(fields, rewrite.fields, _CALL_RESULT_FIELDS, "a call's result")
            if tool_call_id is not None:
                context["tool_call_id"] = tool_call_id
            try:
                attachments = (
                    await asyncio.to_thread(lambda: [Attachment.from_path(p) for p in paths])
                    if paths
                    else None
                )
                # `prompt()` checks before sending, and raises right away.
                stream = target.prompt(
                    text, attachments=attachments, max_wait_s=self._max_wait_s, context=context
                )
            except Exception as err:
                return {"error": f"the prompt was not sent: {_describe(err)}"}
            if scope.closed:
                # Nothing went out yet: a stream publishes on its first step.
                await _aclose(stream)
                return {"error": "the prompt you were answering has ended; no call can start in it"}
            call = _Call(
                id=call_id,
                scope=scope,
                address=address,
                target=target,
                label=parsed.label,
                detached=not parsed.wait,
                fields=fields,
                stream=stream,
            )
            scope.reserved -= 1
            reserved = False
            scope.calls[call_id] = call
            call.task = asyncio.get_running_loop().create_task(
                self._read(call), name=f"agent-tools:{call_id}"
            )
            if not parsed.wait:
                return self._call_result(call)
            return await self._until_ready(call)
        finally:
            if reserved:
                scope.reserved -= 1

    def _reserve(self, scope: _Scope) -> bool:
        """Make room for one more call in ``scope``.

        Drops finished calls, the one that finished longest ago first;
        ``False`` when every tracked call is open.
        """
        while len(scope.calls) + scope.reserved >= self._max_calls:
            finished = [c for c in scope.calls.values() if not c.open]
            if not finished:
                return False
            oldest = min(finished, key=lambda c: c.seq)
            del scope.calls[oldest.id]
        scope.reserved += 1
        return True

    async def _resolve_attachments(self, paths: tuple[str, ...]) -> tuple[str, ...] | ArgsError:
        """Each path, links followed, if it is a file under an allowed root."""
        if not paths:
            return ()
        configured = [await self._staging_dir(), *self._attachment_roots]
        roots = [Path(os.path.realpath(r)) for r in configured]
        out: list[str] = []
        for path in paths:
            real = Path(os.path.realpath(self._cwd / path))
            if not real.exists():
                return ArgsError(f'prompt_agent: the attachment "{path}" does not exist')
            if not real.is_file():
                return ArgsError(f'prompt_agent: the attachment "{path}" is not a file')
            if not any(real == root or real.is_relative_to(root) for root in roots):
                listed = ", ".join(str(r) for r in roots)
                return ArgsError(
                    f'prompt_agent: "{path}" is outside the directories you may send files from '
                    f"({listed})"
                )
            out.append(str(real))
        return tuple(out)

    # --- the call's own task -------------------------------------------------

    async def _read(self, call: _Call) -> None:  # noqa: PLR0912
        """Read a call's stream to its end; see the module docstring."""
        try:
            async for msg in call.stream:
                if isinstance(msg, StatusChunk):
                    continue
                if not call.open:
                    # Cancelled while this message was on its way.
                    if isinstance(msg, Query):
                        await _refuse(msg)
                    continue
                if isinstance(msg, ResponseChunk):
                    call.text += msg.text
                    if msg.attachments:
                        call.reply_files.extend(await self._save(call, msg.attachments))
                    continue
                call.arriving = msg
                files = await self._save(call, msg.attachments) if msg.attachments else []
                fields = await self._after_reply(call, "question", msg.prompt, files)
                # Cancelled meanwhile: `_cancel` took the question and refused it.
                if not call.open:
                    continue
                call.arriving = None
                call.questions.append(_OpenQuestion(query=msg, files=files, fields=fields))
                if call.state == "running":
                    self._set_state(call, "input_required")
            if call.open:
                call.reply_fields = await self._after_reply(
                    call, "reply", call.text, call.reply_files
                )
                self._finish(call, "completed")
        except asyncio.CancelledError:
            # `_cancel` stops this task after it set the call's state, and
            # refuses the questions itself, the one being taken in too.
            if call.open:
                raise
        except Exception as err:
            if call.open:
                if isinstance(err, StreamMaxWaitExceededError):
                    open_questions = self._finish(
                        call,
                        "expired",
                        f"the call ran past its runtime limit of {_duration(err.max_wait_s)} and "
                        "was stopped; the agent may still be working on it",
                    )
                else:
                    open_questions = self._finish(call, "failed", self._failure(call, err))
                # Nobody can answer them now: the asking agent hears so at
                # once rather than waiting out its own timeout.
                for query in open_questions:
                    await _refuse(query)
        finally:
            await _aclose(call.stream)

    async def _save(self, call: _Call, attachments: Iterable[Attachment]) -> list[dict[str, Any]]:
        try:
            directory = await self._staging_dir() / call.id
            budget = (
                None
                if self._max_saved_bytes is None
                else max(0, self._max_saved_bytes - call.saved_bytes)
            )
            saved = await asyncio.to_thread(
                save_attachments, list(attachments), directory, max_total_bytes=budget
            )
        except Exception as err:
            raise _CallFailure(
                f"a file the agent sent could not be saved: {_describe(err)}"
            ) from err
        files: list[dict[str, Any]] = []
        for item in saved:
            if item.path is not None:
                call.saved_bytes += item.size_bytes
            entry: dict[str, Any] = {
                "filename": item.filename,
                "size_bytes": item.size_bytes,
                "path": str(item.path) if item.path is not None else None,
            }
            if item.skipped is not None:
                entry["skipped"] = item.skipped
            files.append(entry)
        return files

    async def _after_reply(
        self,
        call: _Call,
        kind: Literal["reply", "question"],
        text: str,
        attachments: Sequence[dict[str, Any]],
    ) -> dict[str, Any]:
        fields: dict[str, Any] = {}
        try:
            for extension in self._extensions:
                added = await extension.after_reply(
                    AgentToolsReplyContext(
                        call_id=call.id,
                        address=call.address,
                        target=call.target,
                        kind=kind,
                        text=text,
                        attachments=tuple(copy.deepcopy(list(attachments))),
                    )
                )
                _add_fields(fields, added, _CALL_RESULT_FIELDS, "a call's result")
        except _ReservedFieldError as err:
            # The discovery and prompt hooks raise this bug. The reply look
            # runs in the call's reader, outside any tool call, with nobody to
            # raise to: it fails the call, loudly.
            self._log.error(
                'AgentTools: an extension bug: after_reply set "%s", a field the contract '
                "defines; the call fails (call_id=%s, kind=%s)",
                err.field,
                call.id,
                kind,
            )
            raise _CallFailure(
                f'an extension of these tools has a bug (it set "{err.field}" on the {kind}, '
                f'a field the tools define); the agent at "{call.address}" is not at fault'
            ) from err
        except Exception as err:
            raise _CallFailure(f"an extension failed on the {kind}: {_describe(err)}") from err
        return fields

    def _failure(self, call: _Call, err: BaseException) -> str:
        if isinstance(err, _CallFailure):
            return str(err)
        if isinstance(err, StreamStalledError):
            return (
                f'the agent at "{call.address}" sent nothing for {_duration(err.timeout_s)}, '
                "so the call was given up; the agent may have stopped"
            )
        if isinstance(err, AgentsClosedError):
            return "the client the call ran on was closed"
        match = _SERVICE_ERROR_RE.match(str(err))
        if match is not None:
            detail = f" {match.group(2)}" if match.group(2) else ""
            return f'the agent at "{call.address}" answered with an error: {match.group(1)}{detail}'
        return _describe(err)

    # --- state ---------------------------------------------------------------

    def _set_state(self, call: _Call, state: Literal["running", "input_required"]) -> None:
        call.state = state
        if state == "input_required":
            self._seq += 1
            call.seq = self._seq
        call.notify()

    def _finish(
        self,
        call: _Call,
        state: Literal["completed", "failed", "cancelled", "expired"],
        error: str | None = None,
    ) -> list[Query]:
        """The call's final state; the first one wins.

        Returns the questions that were open and the one being taken in,
        taken off the call: the caller refuses them, except on ``completed``,
        where the stream has ended and they are moot.
        """
        if not call.open:
            return []
        awaited = call.awaited
        call.state = state
        call.error = error
        call.ended_at = datetime.now(UTC)
        self._seq += 1
        call.seq = self._seq
        open_questions = [q.query for q in call.questions]
        call.questions.clear()
        if call.arriving is not None:
            open_questions.append(call.arriving)
            call.arriving = None
        call.notify()
        if call.scope is self._root and self._on_settled is not None:
            self._spawn(self._report(self._on_settled, self._call_result(call), awaited, call.id))
        return open_questions

    async def _report(
        self, report: OnSettled, result: AgentToolResult, awaited: bool, call_id: str
    ) -> None:
        try:
            outcome = report(result, SettledInfo(awaited=awaited))
            if inspect.isawaitable(outcome):
                await outcome
        except Exception:
            self._log.error("AgentTools on_settled failed (call_id=%s)", call_id)

    async def _cancel(self, call: _Call) -> None:
        """Refuse the call's open questions, and the one being taken in; drop its stream."""
        if not call.open:
            return
        questions = self._finish(call, "cancelled")
        if call.task is not None and call.task is not asyncio.current_task():
            call.task.cancel()
        for query in questions:
            await _refuse(query)

    async def _close_scope(self, scope: _Scope) -> None:
        scope.closed = True
        for call in list(scope.calls.values()):
            await self._cancel(call)

    async def _until_ready(self, call: _Call) -> AgentToolResult:
        """Wait until the call is no longer ``running``; a cancellation cancels it."""
        try:
            while call.state == "running":
                await _next_change([call], None)
        except asyncio.CancelledError:
            # The host gave up on this tool call: so does the call. The
            # refusals go out in the background; this task is cancelled.
            self._spawn(self._cancel(call))
            raise
        return self._call_result(call)

    # --- wait_agent, answer_agent, cancel_agent, list_agent_calls ------------

    async def _wait_agent(self, scope: _Scope, args: Any) -> AgentToolResult:
        parsed = parse_wait_args(args)
        if isinstance(parsed, ArgsError):
            return {"error": parsed.error}
        calls = self._calls(scope, parsed.call_ids)
        if isinstance(calls, ArgsError):
            return {"error": calls.error}
        cap = self._max_wait_agent_s
        wait_s = cap if parsed.timeout_ms is None else min(parsed.timeout_ms / 1000, cap)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_s
        while True:
            ready = [c for c in calls if c.state != "running"]
            if ready:
                first = min(ready, key=lambda c: c.seq)
                return {
                    **self._call_result(first),
                    "remaining": [c.id for c in calls if c is not first and c.open],
                }
            if loop.time() >= deadline:
                return {"state": "running", "call_ids": [c.id for c in calls]}
            await _next_change(calls, deadline)

    async def _answer_agent(self, scope: _Scope, args: Any) -> AgentToolResult:  # noqa: PLR0911
        parsed = parse_answer_args(args)
        if isinstance(parsed, ArgsError):
            return {"error": parsed.error}
        if parsed.wait is False and "wait_agent" not in self._offered:
            return {
                "error": 'answer_agent: "wait" cannot be false here; '
                "the call waits for the reply or the next question"
            }
        call = scope.calls.get(parsed.call_id)
        if call is None:
            return {"error": self._unknown_calls([parsed.call_id])}
        if call.state != "input_required" or not call.questions:
            suffix = (
                ""
                if call.open
                else self._if_offered("wait_agent", "; wait_agent returns its result")
            )
            return {"error": f'call "{call.id}" has no open question: it is {call.state}{suffix}'}
        # Taken off before the answer goes out, so a concurrent tool call never
        # sees a question that is being answered.
        question = call.questions.pop(0)
        self._set_state(call, "input_required" if call.questions else "running")
        try:
            await question.query.reply(parsed.answer)
        except Exception as err:
            if call.open:
                call.questions.insert(0, question)
                self._set_state(call, "input_required")
            return {"error": f"the answer could not be sent: {_describe(err)}"}
        wait = parsed.wait if parsed.wait is not None else not call.detached
        if not wait:
            return self._call_result(call)
        return await self._until_ready(call)

    async def _cancel_agent(self, scope: _Scope, args: Any) -> AgentToolResult:
        parsed = parse_cancel_args(args)
        if isinstance(parsed, ArgsError):
            return {"error": parsed.error}
        results: list[AgentToolResult] = []
        for call_id in parsed.call_ids:
            call = scope.calls.get(call_id)
            if call is None:
                results.append({"call_id": call_id, "error": self._unknown_calls([call_id])})
                continue
            await self._cancel(call)
            results.append(self._call_result(call))
        return {"calls": results}

    def _list_agent_calls(self, scope: _Scope) -> AgentToolResult:
        calls: list[AgentToolResult] = []
        for call in scope.calls.values():
            entry: AgentToolResult = {"call_id": call.id}
            if call.label is not None:
                entry["label"] = call.label
            entry["address"] = call.address
            entry["state"] = call.state
            entry["started_at"] = _iso(call.started_at)
            if call.ended_at is not None:
                entry["ended_at"] = _iso(call.ended_at)
            calls.append(entry)
        return {"calls": calls}

    def _calls(self, scope: _Scope, ids: tuple[str, ...]) -> list[_Call] | ArgsError:
        """The calls ``ids`` name in ``scope``, or an error naming the ones it does not track."""
        unknown = [i for i in ids if i not in scope.calls]
        if unknown:
            return ArgsError(self._unknown_calls(unknown))
        return [scope.calls[i] for i in ids]

    # --- words ---------------------------------------------------------------
    #
    # What a result tells the model to do next points only to tools the
    # helper offers: the model can call no other.

    def _if_offered(self, tool: str, words: str) -> str:
        return words if tool in self._offered else ""

    def _unknown_calls(self, ids: Sequence[str]) -> str:
        listed = ", ".join(f'"{i}"' for i in ids)
        return f"{listed}: no such call in your calls" + self._if_offered(
            "list_agent_calls", "; list_agent_calls shows them"
        )

    def _no_agent_at(self, address: str) -> str:
        return f'no agent answers at "{address}"' + self._if_offered(
            "discover_agents", "; call discover_agents for the current list"
        )

    def _open_call_actions(self, them: str, their: str) -> tuple[str | None, str | None]:
        """What the model can do about open calls with the tools it has: collect, stop.

        Without ``wait_agent`` nothing is detached, so collecting a call is
        answering its questions.
        """
        if "wait_agent" in self._offered:
            collect: str | None = f"collect {them} with wait_agent"
        elif "answer_agent" in self._offered:
            collect = f"answer {their} questions with answer_agent"
        else:
            collect = None
        stop = f"stop {them} with cancel_agent" if "cancel_agent" in self._offered else None
        return collect, stop

    # --- results ---------------------------------------------------------------

    def _call_result(self, call: _Call) -> AgentToolResult:
        result: AgentToolResult = {**call.fields, "call_id": call.id, "state": call.state}
        if call.label is not None:
            result["label"] = call.label
        if call.state == "input_required":
            question = call.questions[0]
            result.update(question.fields)
            result["question"] = question.query.prompt
            if question.files:
                result["attachments"] = copy.deepcopy(question.files)
            return result
        if call.state == "completed":
            result.update(call.reply_fields)
            result["reply"] = call.text
        elif call.state in ("failed", "expired"):
            result["error"] = call.error or "the call failed"
        if call.state in ("failed", "cancelled", "expired") and call.text:
            result["partial_reply"] = call.text
        if call.state != "running" and call.reply_files:
            result["attachments"] = copy.deepcopy(call.reply_files)
        return result

    def _with_open_calls(self, scope: _Scope, result: AgentToolResult) -> AgentToolResult:
        """Say how many calls are open, when any is."""
        open_calls = sum(1 for c in scope.calls.values() if c.open)
        if open_calls == 0:
            return result
        counted = (
            "1 call you started is" if open_calls == 1 else f"{open_calls} calls you started are"
        )
        collect, stop = self._open_call_actions(
            "it" if open_calls == 1 else "them", "its" if open_calls == 1 else "their"
        )
        if scope.served:
            then = f": {collect} before you answer." if collect is not None else "."
            note = f"{counted} still open. Calls end with the prompt you are answering{then}"
        else:
            actions = [a for a in (collect, stop) if a is not None]
            then = f": {', or '.join(actions)}." if actions else "."
            note = f"{counted} still open{then}"
        return {**result, "open_calls": open_calls, "open_calls_note": note}

    # --- files and housekeeping ----------------------------------------------

    async def _staging_dir(self) -> Path:
        if self._staging is None:
            if self._staging_option is not None:
                directory = self._staging_option.resolve()
                await asyncio.to_thread(directory.mkdir, 0o700, True, True)
            else:
                directory = Path(await asyncio.to_thread(tempfile.mkdtemp, None, "agent-tools-"))
                self._owns_staging = True
            self._staging = directory
        return self._staging

    def _spawn(self, work: Awaitable[None]) -> None:
        async def run() -> None:
            await work

        task = asyncio.get_running_loop().create_task(run())
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("AgentTools: the helper is closed")


class _ToolsRequestInterceptor:
    """The helper's request interceptor: a scope around each served prompt."""

    def __init__(self, tools: AgentTools) -> None:
        self._tools = tools

    async def around_request(
        self, ctx: _RequestContext, call_next: Callable[[], Awaitable[None]]
    ) -> None:
        tools = self._tools
        # A closed helper must not keep an agent from serving.
        if tools._closed:
            await call_next()
            return
        sender = ctx.sender
        caller = str(sender.id) if sender is not None and sender.trust == "verified" else None
        async with tools.prompt_scope(caller=caller):
            await call_next()


@dataclass(eq=False, slots=True)
class _Scope:
    """Where calls live: one per served prompt, and one for everything else."""

    served: bool
    caller: str | None
    #: In the order started.
    calls: dict[str, _Call] = field(default_factory=dict)
    #: Calls admitted but not yet started.
    reserved: int = 0
    closed: bool = False


@dataclass(frozen=True, slots=True)
class _OpenQuestion:
    """One question a call's stream asked, while it is open."""

    query: Query
    files: list[dict[str, Any]]
    fields: dict[str, Any]


@dataclass(eq=False, slots=True)
class _Call:
    """One prompt and what came back so far."""

    id: str
    scope: _Scope
    address: str
    target: Agent
    label: str | None
    #: Started with ``wait: false``.
    detached: bool
    #: Fields a prompt rewrite added.
    fields: dict[str, Any]
    stream: AsyncIterator[StreamMessage]
    state: AgentCallState = "running"
    #: When it last became ready (a question, or its finish), for ``wait_agent``'s order.
    seq: int = 0
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ended_at: datetime | None = None
    text: str = ""
    reply_files: list[dict[str, Any]] = field(default_factory=list)
    #: Oldest first; the first is the one the call's result shows.
    questions: list[_OpenQuestion] = field(default_factory=list)
    #: A question whose files are being saved and whose reply look runs: not
    #: yet in ``questions``, and either step may fail the call.
    arriving: Query | None = None
    error: str | None = None
    reply_fields: dict[str, Any] = field(default_factory=dict)
    saved_bytes: int = 0
    task: asyncio.Task[None] | None = None
    waiters: set[asyncio.Future[None]] = field(default_factory=set)

    @property
    def open(self) -> bool:
        return self.state in _OPEN_STATES

    @property
    def awaited(self) -> bool:
        """Whether a tool call waits for this call right now."""
        return bool(self.waiters)

    def notify(self) -> None:
        """Wake every tool call waiting for this call."""
        waiters = list(self.waiters)
        self.waiters.clear()
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)


class _CallFailure(Exception):
    """A call's failure, in words, raised inside its task."""


class _ReservedFieldError(ValueError):
    """An extension set a field the contract defines: a bug in the extension."""

    def __init__(self, field: str, where: str) -> None:
        super().__init__(f'AgentTools: an extension may not set "{field}" on {where}')
        self.field = field


async def _next_change(calls: Sequence[_Call], deadline: float | None) -> None:
    """Return on the next change of any of ``calls``, or at ``deadline`` (loop time)."""
    loop = asyncio.get_running_loop()
    waiter: asyncio.Future[None] = loop.create_future()
    for call in calls:
        call.waiters.add(waiter)
    try:
        timeout = None if deadline is None else max(0.0, deadline - loop.time())
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(asyncio.shield(waiter), timeout)
    finally:
        for call in calls:
            call.waiters.discard(waiter)


async def _refuse(query: Query) -> None:
    with contextlib.suppress(Exception):
        # Already answered, or the connection is gone: nothing more to say.
        await query.reply(AGENT_TOOLS_QUESTION_REFUSAL)


async def _aclose(stream: AsyncIterator[StreamMessage]) -> None:
    aclose = getattr(stream, "aclose", None)
    if aclose is not None:
        with contextlib.suppress(Exception):
            await aclose()


def _add_fields(
    into: dict[str, Any],
    added: Mapping[str, Any] | None,
    reserved: frozenset[str],
    where: str,
) -> None:
    """Merge an extension's fields, refusing the ones the contract defines."""
    if not added:
        return
    for key, value in added.items():
        if key in reserved:
            raise _ReservedFieldError(key, where)
        into[key] = value


def _new_call_id() -> str:
    return f"call_{secrets.token_hex(6)}"


def _describe(err: BaseException) -> str:
    return str(err) or type(err).__name__


def _iso(moment: datetime) -> str:
    """UTC, milliseconds, ``Z``: the form JavaScript's ``toISOString`` writes."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


_MS_PER_MINUTE = 60_000
_MS_PER_SECOND = 1_000


def _duration(seconds: float) -> str:
    """A limit in words, as the TypeScript SDK writes it: ``10 minutes``, ``300 ms``."""
    ms = round(seconds * 1000)
    if ms >= _MS_PER_MINUTE and ms % _MS_PER_MINUTE == 0:
        minutes = ms // _MS_PER_MINUTE
        return "1 minute" if minutes == 1 else f"{minutes} minutes"
    if ms >= _MS_PER_SECOND and ms % _MS_PER_SECOND == 0:
        whole = ms // _MS_PER_SECOND
        return "1 second" if whole == 1 else f"{whole} seconds"
    return f"{ms} ms"
