# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report them privately via one of:

- **Email:** security@synadia.com
- **GitHub private advisory:** use the "Report a vulnerability" button
  under the repo's **Security** tab. GitHub notifies the maintainers
  privately and creates a draft advisory we can publish once a fix is
  available.

When reporting, please include (as much as applies):

- The natsagent version (or git SHA) affected.
- A minimal reproduction or proof-of-concept.
- The impact you believe the issue has (data exposure, auth bypass,
  remote exec, etc.).
- Whether you're aware of the issue being exploited in the wild.
- Any CVE / CWE classification you've already done.

## Scope

In-scope:

- Any code shipped in the `natsagent` PyPI package (the contents of
  `src/natsagent/`).
- SDK behaviour that violates the spec in a way that allows an agent to
  impersonate another, leak credentials, or bypass a documented
  safeguard (e.g. `attachments_ok` / `max_payload` enforcement).

Out of scope:

- Vulnerabilities in `nats-server` itself - those belong at
  [nats-io/nats-server](https://github.com/nats-io/nats-server).
- Vulnerabilities in transitive dependencies that do not affect users of
  natsagent at default settings - report them upstream; we'll bump when
  a fixed version is available.
- Theoretical issues without a concrete attack path.

## Response expectations

We aim to acknowledge reports within **3 working days** and to ship a
patched release within **30 days** of confirming a vulnerability.
Complex issues may take longer; we'll communicate the timeline on the
advisory.

Fixes are published as a patch release on the current minor line with
an accompanying advisory. Older minor lines are not actively backported
while the project is on the 0.x unstable track (see spec §11.2 and
[`CHANGELOG.md`](CHANGELOG.md)).

## Credit

We're happy to credit reporters in the release notes and GitHub
advisory. Let us know how you'd like to be credited, or if you'd prefer
to remain anonymous.
