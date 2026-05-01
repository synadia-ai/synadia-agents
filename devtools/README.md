# devtools

Maintainer-side scripts for this repo. Not shipped to npm; not intended
for end users of the published packages.

| Script | Purpose |
| --- | --- |
| [`devmode.sh`](devmode.sh) | Toggle every consumer between `file:` links to local SDK source (dev) and `^semver` pins from npm (release). The release ladder runs it twice — once `off` before `npm publish`, once `on` after — so the working tree on `main` keeps the contributor-friendly `file:` default while the published tarballs carry resolvable version refs. |

The release ladder is documented in [`../README-DEV.md`](../README-DEV.md)
under "Releasing the SDKs". Run `./devtools/devmode.sh --help` for the
full flag and command surface.

## Why these scripts live here

Tooling that the repo's release flow depends on belongs alongside the
code it releases. A future maintainer (or a CI job) cloning this repo
should be able to ship a release without first hunting down a sibling
"internal tools" checkout.

Anything genuinely deployment-specific (e.g. a particular operator's
docker-container redeploy script) doesn't fit this folder — those live
out-of-tree.
