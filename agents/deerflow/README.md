# DeerFlow NATS Channel

External channel wrapper that exposes a running DeerFlow instance as a Synadia Agent Protocol host on NATS.

This package is specifically about the **Synadia Agent Protocol for NATS**. It does not provide generic NATS tools, KV/Object Store helpers, raw JetStream access, or a DeerFlow fork.

## Install

```shell
pip install synadia-ai-nats-deerflow-channel
```

For local development from this monorepo:

```shell
cd agents/deerflow
uv sync
uv run deerflow-nats-channel doctor
```

## Run

Start DeerFlow normally, then run the channel wrapper:

```shell
NATS_CONTEXT=prod \
DEERFLOW_URL=http://localhost:2026 \
NATS_OWNER=rene \
NATS_AGENT_NAME=deerflow \
deerflow-nats-channel start
```

The wrapper registers DeerFlow as:

```text
agents.prompt.df.<owner>.<session>
agents.status.df.<owner>.<session>
agents.hb.df.<owner>.<session>
```

Only `prompt` calls DeerFlow. Status and heartbeat are wrapper-owned protocol liveness concerns.

## Configuration

Config resolution order:

1. CLI flags
2. Environment variables
3. Channel config file
4. Defaults

Default config file path:

```text
~/.config/synadia/deerflow-channel/config.toml
```

Example:

```toml
nats_context = "prod"
deerflow_url = "http://localhost:2026"
owner = "rene"
session = "deerflow"
agent = "df"
```

Secrets should live in NATS CLI contexts, credentials files, or environment variables. Do not put secrets in DeerFlow config or commit them here.

## Commands

```shell
deerflow-nats-channel doctor
deerflow-nats-channel start
deerflow-nats-channel configure
```

`doctor` verifies configuration and reports shallow DeerFlow Gateway reachability via `/health`. `start` hosts the Synadia Agent Protocol wrapper; only `prompt` forwards to DeerFlow's LangGraph-compatible `/api/threads/{session}/runs/stream` SSE endpoint. Status and heartbeat remain wrapper-owned protocol liveness concerns.
