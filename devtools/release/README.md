# Release machinery

This directory implements the clean, build-once contract in
[`../../docs/sdk-release-rollout-roadmap.md`](../../docs/sdk-release-rollout-roadmap.md).
It never rewrites the checkout and it never publishes on its own.

## Files

- `plan.json` is the complete package inventory and dependency DAG. A newly
  tracked `package.json` or `pyproject.toml` fails validation until it is
  classified. Fixture/vendor exclusions require a reason.
- `versions.rehearsal.json` contains deliberately non-publishable versions for
  branch artifact rehearsals.
- `versions.json` is filled by the reviewed release/version PR. Null values
  intentionally block candidate staging before then.
- `cooldown-policy.json` is filled from the real organization policy. Its
  unresolved state blocks publication preflight, but not branch rehearsal.
- `freeze-baseline.json` hashes every manifest, lock, release workflow, and
  pinned tool input. Any tracing dependency addition must update it as an
  explicit reviewed change.
- `python-build-constraints.txt` freezes and hashes the isolated Python build
  backend.

## Rehearsal

Run from a clean committed source SHA. The output must be outside the repo:

```sh
python3 devtools/release/release.py validate-source
python3 -m unittest discover -s devtools/release/tests -v

stage="$(mktemp -d)/stage"
python3 devtools/release/release.py stage \
  --source HEAD \
  --versions devtools/release/versions.rehearsal.json \
  --output "$stage"
python3 devtools/release/release.py validate-stage --stage "$stage"
```

Build commands create each final-format output once, pack npm with lifecycle
scripts disabled, install the tarballs/wheels/sdists outside the source tree,
and write an immutable digest record. Python resolution also applies the
recorded external freeze cutoff to runtime and isolated-build dependencies:

```sh
python3 devtools/release/release.py build-npm \
  --stage "$stage" --output "$(dirname "$stage")/npm-artifacts"
python3 devtools/release/release.py build-python \
  --stage "$stage" --output "$(dirname "$stage")/python-artifacts"
```

Rehearsal proves exact local artifact compatibility. The private
`open-agent-vercel` evidence project explicitly retains its private
`open-agent` source edge; all of its release SDK edges are still exact. No
publishable package receives this exception. Rehearsal does **not** claim that
registry locks exist. OpenClaw, PI, dependent npm locks, Python consumer locks,
and the Claude marketplace lock become registry-ready only layer by layer
after their exact prerequisites have been uploaded.

The npm rehearsal's unlocked external install is only build/artifact evidence;
it is not the dependency-freeze or cooldown gate. Candidate proof regenerates
the registry locks under the measured age policy and then uses frozen installs.
The tooling asserts that rehearsal installs cannot rewrite a staged manifest.

## Freeze

The checked-in baseline prevents ordinary dependency drift during rollout:

```sh
python3 devtools/release/release.py freeze check
```

Only after reviewing an intentional dependency/tooling change (for example,
the tracing addition) regenerate it with:

```sh
python3 devtools/release/release.py freeze write
```

## Candidate gate

The release PR puts final, unique versions in source manifests/changelogs and
in `versions.json`, resolves `cooldown-policy.json`, then creates registry-only
locks in DAG order. Candidate staging refuses to hide an own-version mismatch.
Publication preflight additionally rejects missing/stale locks, local/editable
sources, unresolved cooldown configuration, and non-exact internal edges:

```sh
python3 devtools/release/release.py publication-preflight \
  --stage /absolute/path/to/candidate-stage
```

Bun's minimum-age setting applies only during new resolution; it does not
re-check versions already present in a lock. Therefore exit-aging proof must
first perform a clean **no-lock** resolution of the exact internal versions
under the normal policy with no exclusions, and then separately verify the
approved frozen locks and graph hashes.

Publication remains a separately approved operation. npm receives only the
recorded tarball, never a package directory, and lifecycle scripts stay off:

```sh
npm publish /absolute/path/to/approved-package.tgz \
  --ignore-scripts --access public --tag next --provenance
```

The Python tag workflows likewise publish downloaded, digest-checked build
artifacts; the publish jobs do not rebuild.
