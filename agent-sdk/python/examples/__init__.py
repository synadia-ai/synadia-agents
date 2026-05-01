"""Agent-sdk runnable examples.

The headline example is :mod:`examples._reference_agent` — a
spec-compliant echo agent that doubles as the harness for the
client-sdk's numbered demos in
``../../client-sdk/python/examples/`` and as the wire-compat
counterparty for cross-SDK interop.

The ``_`` prefix on :mod:`examples._connect_cli` and
:mod:`examples._reference_agent` marks them as internal plumbing —
runnable, but not the kind of headline demo a user opens first.
Numbered demos that exercise specific agent-side features (an
attachment-aware echo, a query-asking agent, a stream-error agent)
land here as follow-ups.
"""
