# devtools

Maintainer-side scripts for this repo. Not shipped to npm; not intended
for end users of the published packages.

| Script | Purpose |
| --- | --- |
| [`devmode.sh`](devmode.sh) | Toggle SDK consumers between local `file:` links and registry ranges for development checks. It is not release tooling. |
| [`release/release.py`](release/release.py) | Validate the complete package graph, create tracked-only clean stages with exact internal versions, freeze dependency inputs, build artifacts once, and verify recorded hashes. |

The release ladder is documented in [`../README-DEV.md`](../README-DEV.md)
under "Releasing SDKs and integrations". Release commands and their
fail-closed publication prerequisites are documented in
[`release/README.md`](release/README.md). Run `./devtools/devmode.sh --help`
for the local helper's command surface.

## Why these scripts live here

Tooling that the repo's release flow depends on belongs alongside the
code it releases. A future maintainer (or a CI job) cloning this repo
should be able to ship a release without first hunting down a sibling
"internal tools" checkout.

Anything genuinely deployment-specific (e.g. a particular operator's
docker-container redeploy script) doesn't fit this folder — those live
out-of-tree.
