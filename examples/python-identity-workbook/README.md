# Python sender identity workbook

This workbook runs sender identity end to end with the monorepo's Python SDKs:

- Echo registers a signed identity and advertises `min_sender_trust="any"`.
- Hello registers its own signed `AgentService` with `min_sender_trust="any"`, then calls Echo as
  the same NKEY identity.
- A separate CLI user discovers and verifies Echo, then demonstrates calls with and without a
  sender identity.

The three generated users are throwaway local NKEY users in the global `$G` account. Private
seeds live under the gitignored `.local/` directory with mode `0600`; none of the programs logs
seeds, credentials, nonces, or raw signatures.

## Set up once

Prerequisites: Python 3.11 or newer, `uv`, and `nats-server` on `PATH`.

Sender identity is merged here but the corresponding Python releases are not on PyPI yet. This
project therefore resolves both SDK distributions from the local monorepo as editable packages;
do not replace those sources with PyPI pins until the identity-bearing releases are published.

```console
cd examples/python-identity-workbook
uv sync --frozen
uv run python prepare_nkeys.py
```

The last command prints only the three public identities (`$G.U…`) and file locations. It never
prints a seed. Keep `.local/` if you want stable identities while repeating the exercises.

## Terminal 1 — NATS

```console
cd examples/python-identity-workbook
nats-server -c .local/nats-server.conf
```

## Terminal 2 — signed Echo

```console
cd examples/python-identity-workbook
uv run python echo_agent.py
```

Expected startup shape (the actual public NKEY differs):

```text
identity_workbook.echo INFO Echo identity=$G.U… min_sender_trust=any subject=agents.prompt.echo.identity-workbook.main
Echo is ready; press Ctrl+C to stop
```

Echo logs every accepted request from `stream.sender`. After Terminal 3 it should show:

```text
identity_workbook.echo INFO incoming sender=$G.U… (verified user, claimed account)
```

`verified user, claimed account` is the expected trust label for this simple single-account local
server: the user signature is verified, while operator-level account attestation is not enabled.

## Terminal 3 — signed Hello agent calling Echo

Leave Echo running, then run:

```console
cd examples/python-identity-workbook
uv run python hello_agent.py
```

Expected log shape:

```text
identity_workbook.hello INFO Hello identity=$G.U… subject=agents.prompt.hello.identity-workbook.main
identity_workbook.hello INFO discovered Echo identity=$G.U… id_sig_verified=True
identity_workbook.hello INFO outgoing prompt identity=$G.U… mode=signed recipient=$G.U… prompt='hello'
hello
```

Hello uses one NATS connection and one signer for both its `ServiceIdentity` registration and its
`Agents(identity=Identity(...))` call. The Echo terminal's new sender line must contain Hello's
public identity and the `verified user` trust label.

## Terminal 4 — signed client-SDK CLI

```console
cd examples/python-identity-workbook
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

## Terminal 5 — client-SDK CLI without sender identity

The NATS connection still authenticates with the CLI NKEY, but `--without-identity` deliberately
constructs `Agents(identity=None)`, so the request carries no `Agent-Sender` header:

```console
cd examples/python-identity-workbook
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
identity_workbook.echo INFO incoming sender=(no sender)
```

## Automated proof

The end-to-end test starts a real `nats-server`, generates fresh Echo/Hello/CLI users, and asserts
the three distinct identities, both signed service registrations, Echo's verified discovery
identity and `id_sig_verified`, verified Hello and CLI senders, an accepted identity-free call,
the `(no sender)` classification, and exact echo responses.

```console
uv run ruff format --check .
uv run ruff check --no-cache .
uv run mypy --no-incremental
uv run pytest -v
```

Requests may be signed; responses are not yet. A verified `Agent-Sender` proves who sent a signed
request to Echo, while an identity-free request makes no sender assertion. Response chunks
currently carry no equivalent responder signature. The client verifies Echo's signed service
registration during discovery, not each response payload.
