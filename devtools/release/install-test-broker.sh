#!/usr/bin/env bash
# Install the pinned Linux CI broker in a new explicit directory.
set -euo pipefail

if [[ $# -ne 3 || ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! $2 =~ ^[0-9a-f]{64}$ || $3 != /* ]]; then
  printf '%s\n' 'usage: install-test-broker.sh VERSION SHA256 NEW_ABSOLUTE_DIRECTORY' >&2
  exit 2
fi
broker_version=$1
broker_digest=$2
broker_directory=$3
if [[ -e $broker_directory || -L $broker_directory ]]; then
  printf '%s\n' 'broker output already exists' >&2
  exit 2
fi
mkdir "$broker_directory"
archive="$broker_directory/nats-server.tar.gz"
curl -fsSL "https://github.com/nats-io/nats-server/releases/download/v$broker_version/nats-server-v$broker_version-linux-amd64.tar.gz" -o "$archive"
python3 - "$broker_digest" "$archive" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[2], "rb") as downloaded:
    for block in iter(lambda: downloaded.read(1024 * 1024), b""):
        digest.update(block)
if digest.hexdigest() != sys.argv[1]:
    raise SystemExit("broker archive digest mismatch")
PY
tar -xzf "$archive" -C "$broker_directory"
mkdir "$broker_directory/bin"
install -m 0755 "$broker_directory/nats-server-v$broker_version-linux-amd64/nats-server" "$broker_directory/bin/nats-server"
actual_version=$("$broker_directory/bin/nats-server" --version)
if [[ $actual_version != "nats-server: v$broker_version" ]]; then
  printf '%s\n' 'broker version differs from the pin' >&2
  exit 1
fi
printf '%s\n' "$actual_version"
if [[ -n ${GITHUB_PATH:-} ]]; then
  printf '%s\n' "$broker_directory/bin" >> "$GITHUB_PATH"
fi
