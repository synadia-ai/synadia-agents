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
- `.github/workflows/release-rehearsal.yml` runs both complete artifact graphs
  for every rollout PR that changes a release input. It uploads evidence only;
  it has no registry credentials or publication step.

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
python3 devtools/release/release.py verify-python-artifacts \
  --record "$(dirname "$stage")/python-artifacts/artifacts.json" \
  --artifacts "$(dirname "$stage")/python-artifacts"
```

The artifact inspectors enforce npm file allowlists and executable bin modes,
strict Python sdist roots, package metadata name/version consistency, required
licenses, the public-terminology boundary, and a streaming seed-shaped secret
check over every packed file regardless of size. Every publishable npm package
has a clean-install import/CLI runtime smoke or a documented host-extension
waiver in `plan.json`. Python sdists are built first, wheels are built from
those sdists, and both forms are installed and imported on every Python version
listed in the frozen toolchain.

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
sources, unresolved cooldown configuration, non-exact internal edges, and a
Python lock whose complete external solution fails `uv lock --check --offline`:

```sh
python3 devtools/release/release.py publication-preflight \
  --stage /absolute/path/to/candidate-stage \
  --package-id py-caller
```

Use the package IDs and topological layers in `plan.json`. Preflight may be
scoped to the package being uploaded, because downstream registry locks cannot
exist until their exact prerequisites have been uploaded. Omitting
`--package-id` validates every final lock.

Candidate artifact builds are deliberately one package at a time. Unlike the
all-local rehearsal, npm candidate builds require the selected package's
registry-only lock and run `bun install --frozen-lockfile --ignore-scripts`
before building:

```sh
python3 devtools/release/release.py build-npm \
  --stage /absolute/path/to/candidate-stage \
  --package-id ts-caller \
  --output /absolute/path/to/ts-caller-artifacts
```

The Python tag workflows use the same package IDs (`py-caller`, `py-host`, and
`deerflow`). Each workflow source-tests all supported Python versions, builds
one sdist and one wheel exactly once, uploads them, downloads and install-tests
both forms, then downloads and digest-checks the same files in the trusted
publishing job. The publishing job never checks out a different commit and
never runs a build command.

The global Python cutoff continues to constrain external dependencies. Names in
`python_internal_exclusions` receive only a package-scoped date override, and
only when they are an internal edge of the package under test. Remove those
names before exit-aging proof. npm's corresponding scoped exception must be
filled from the real enforcing policy rather than inferred here.

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
