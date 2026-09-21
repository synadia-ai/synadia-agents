# Python sender identity workbook

This workbook runs sender identity end to end with the monorepo's Python SDKs:

- Echo runs an `AgentService` under its signed NKEY identity. It accepts prompts at
  `min_sender_trust="any"`, logs each sender, and echoes the prompt.
- Hello runs a second `AgentService` under a different signed NKEY identity. It then uses the
  `Agents` client with that same identity to forward every received prompt to Echo, prefixed with
  `Hello! `.
- A separate CLI user discovers and verifies either service, and demonstrates calls with and
  without a sender identity.

The three generated users are throwaway local NKEY users in the global `$G` account. Private
seeds live under the gitignored `.local/` directory with mode `0600`; none of the programs logs
seeds, credentials, nonces, or raw signatures. Every program uses the SDK's
connection-bundle helper, so one credential snapshot supplies both NATS
authentication and the matching signer; the examples contain no separate
credential-reading or signer-derivation path.

## Set up once

Prerequisites: Python 3.11 or newer, `uv`, `nats-server`, the `nats` CLI, and `jq` on `PATH`.

Sender identity is merged here but the corresponding Python releases are not on PyPI yet. This
project therefore resolves both SDK distributions from the local monorepo as editable packages;
do not replace those sources with PyPI pins until the identity-bearing releases are published.

```console
cd examples/identity-workbook/python
uv sync --frozen
uv run python prepare_nkeys.py
```

The last command prints only the three public identities (`$G.U…`) and file locations. It never
prints a seed. Keep `.local/` if you want stable identities while repeating the exercises.

## Terminal 1 — NATS

```console
cd examples/identity-workbook/python
nats-server -c .local/nats-server.conf
```

## Terminal 2 — signed Echo

```console
cd examples/identity-workbook/python
uv run python echo_agent.py
```

Expected startup shape (the actual public NKEY differs):

```text
identity_workbook.echo INFO Echo identity=$G.U… min_sender_trust=any subject=agents.prompt.echo.identity-workbook.main
Echo is ready; press Ctrl+C to stop
```

Echo logs every accepted request from `stream.sender`. After Terminal 5 it should show:

```text
identity_workbook.echo INFO incoming sender=$G.U… (verified user, claimed account)
```

`verified user, claimed account` is the expected trust label for this simple single-account local
server: the user signature is verified, while operator-level account attestation is not enabled.

## Terminal 3 — signed forwarding Hello agent

Leave Echo running, then run:

```console
cd examples/identity-workbook/python
uv run python hello_agent.py
```

Expected log shape:

```text
identity_workbook.hello INFO Hello identity=$G.U… min_sender_trust=any subject=agents.prompt.hello.identity-workbook.main
Hello is ready; press Ctrl+C to stop
```

Hello uses one NATS connection and one signer for both its `ServiceIdentity` registration and its
outbound `Agents(identity=Identity(...))` calls. It waits for a prompt before calling Echo.

## Terminal 4 — inspect both services with the NATS CLI

Both agents are NATS microservice instances named `agents`; their `agent` metadata distinguishes
Echo from Hello. List the running instances using the CLI user's NKEY:

```console
cd examples/identity-workbook/python
nats micro list --nkey .local/cli.nkey
```

The table should contain two `agents` rows, one described as Echo and one as Hello. To inspect the
identity and prompt-endpoint metadata, select only safe public fields from the JSON response:

```console
nats micro list --json --nkey .local/cli.nkey \
  | jq 'map({
      description,
      identity: ("$G." + .metadata.user_nkey),
      metadata: {
        account: .metadata.account,
        agent: .metadata.agent,
        owner: .metadata.owner,
        protocol_version: .metadata.protocol_version,
        session: .metadata.session
      },
      prompt: (
        .endpoints[]
        | select(.name == "prompt")
        | {subject, metadata}
      )
    })'
```

Expected shape, abbreviated:

```json
[
  {
    "description": "Python sender-identity workbook Echo",
    "identity": "$G.U…",
    "metadata": {"account": "$G", "agent": "echo", "owner": "identity-workbook"},
    "prompt": {
      "subject": "agents.prompt.echo.identity-workbook.main",
      "metadata": {"attachments_ok": "true", "max_payload": "1MB", "min_sender_trust": "any"}
    }
  },
  {
    "description": "Python sender-identity workbook Hello",
    "identity": "$G.U…",
    "metadata": {"account": "$G", "agent": "hello", "owner": "identity-workbook"},
    "prompt": {
      "subject": "agents.prompt.hello.identity-workbook.main",
      "metadata": {"attachments_ok": "true", "max_payload": "1MB", "min_sender_trust": "any"}
    }
  }
]
```

The projection deliberately omits `id_sig`; the workbook never prints raw signatures.

## Terminal 5 — prompt Hello and follow the identity chain

Use the CLI user's signed identity to prompt Hello:

```console
cd examples/identity-workbook/python
uv run python call_echo.py --agent hello "identity workbook"
```

Expected CLI log shape:

```text
identity_workbook.cli INFO discovered Hello identity=$G.U… id_sig_verified=True
identity_workbook.cli INFO outgoing prompt identity=$G.U… mode=signed recipient=$G.U… prompt='identity workbook'
Hello! identity workbook
```

Hello receives and verifies the CLI sender, prefixes the prompt, calls Echo as Hello, prints
Echo's reply, and returns that reply to the CLI:

```text
identity_workbook.hello INFO incoming sender=$G.U… (verified user, claimed account)
identity_workbook.hello INFO discovered Echo identity=$G.U… id_sig_verified=True
identity_workbook.hello INFO outgoing prompt identity=$G.U… mode=signed recipient=$G.U… prompt='Hello! identity workbook'
identity_workbook.hello INFO Echo replied='Hello! identity workbook'
```

Echo sees Hello—not the original CLI—as its verified immediate sender:

```text
identity_workbook.echo INFO incoming sender=$G.U… (verified user, claimed account)
```

Because Hello also advertises `min_sender_trust=any`, repeat the same path without a sender
identity on the first hop:

```console
uv run python call_echo.py --agent hello --without-identity "anonymous"
```

The CLI prints `Hello! anonymous`. Hello logs `incoming sender=(unknown sender)`, then signs the
prefixed request with its own identity, so Echo still observes Hello as a verified sender.

## Terminal 6 — call Echo directly with signed identity

```console
cd examples/identity-workbook/python
uv run python call_echo.py "hello from CLI"
```

Expected log shape:

```text
identity_workbook.cli INFO discovered Echo identity=$G.U… id_sig_verified=True
identity_workbook.cli INFO outgoing prompt identity=$G.U… mode=signed recipient=$G.U… prompt='hello from CLI'
hello from CLI
```

Echo should log a second verified sender, this time matching the CLI public identity printed by
`prepare_nkeys.py`.

## Terminal 7 — call Echo directly without sender identity

The NATS connection still authenticates with the CLI NKEY, but `--without-identity` deliberately
constructs `Agents(identity=None)`, so the request carries no `Agent-Sender` header:

```console
cd examples/identity-workbook/python
uv run python call_echo.py --without-identity "hello without identity"
```

Expected log shape:

```text
identity_workbook.cli INFO discovered Echo identity=$G.U… id_sig_verified=True
identity_workbook.cli INFO outgoing prompt identity=(none) mode=without-identity recipient=$G.U… prompt='hello without identity'
hello without identity
```

Echo accepts the request because it advertises `min_sender_trust=any`, and makes the achieved
identity state explicit:

```text
identity_workbook.echo INFO incoming sender=(unknown sender)
```

## Automated proof

The end-to-end test starts a real `nats-server`, generates fresh Echo/Hello/CLI users, and asserts
the three distinct identities, both signed service registrations, verified discovery identities
and `id_sig_verified`, signed and identity-free CLI → Hello calls, the signed Hello → Echo hop,
Hello's `Hello! ` prefix and returned responses, direct signed and identity-free Echo calls, and
the `(unknown sender)` classification.

```console
uv run ruff format --check .
uv run ruff check --no-cache .
uv run mypy --no-incremental
uv run pytest -v
```

Requests may be signed; responses are not yet. A verified `Agent-Sender` proves the immediate
sender of a signed request: Hello verifies CLI on the first hop, and Echo verifies Hello on the
second. An identity-free request makes no sender assertion. Response chunks currently carry no
equivalent responder signature, so neither Echo's response to Hello nor Hello's response to the
CLI is signed. Each caller verifies the target's signed service registration during discovery,
not the response payload.
