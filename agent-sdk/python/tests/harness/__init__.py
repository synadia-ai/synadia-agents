"""Test harness — spawns real nats-server and records evidence per test.

This harness intentionally does NOT mock NATS. Protocol tests that mock the
broker prove nothing about wire compliance; see CLAUDE.md "no-bullshit
testing". The evidence files written under `tests/_evidence/<nodeid>/` are
the artifact that makes tests reviewable — a human should be able to
inspect them and confirm protocol behavior by eye.
"""
