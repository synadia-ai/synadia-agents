#!/usr/bin/env python3
"""Fail-closed release staging and artifact tooling.

The checkout is a development input.  Release artifacts are always produced
from a tracked-only ``git archive`` in a separate directory, with exact
internal dependency versions written only into that stage.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any


HERE = Path(__file__).resolve().parent
DEFAULT_REPO = HERE.parent.parent
DEFAULT_PLAN = HERE / "plan.json"
DEFAULT_REHEARSAL_VERSIONS = HERE / "versions.rehearsal.json"
DEFAULT_CANDIDATE_VERSIONS = HERE / "versions.json"
DEFAULT_COOLDOWN = HERE / "cooldown-policy.json"
DEFAULT_FREEZE = HERE / "freeze-baseline.json"
STAGE_MARKER = ".release-stage.json"
DEPENDENCY_SECTIONS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
FORBIDDEN_SPEC_PREFIXES = (
    "file:",
    "link:",
    "workspace:",
    "path:",
    "git:",
    "git+",
    "github:",
    "http:",
    "https:",
    "catalog:",
)


class ReleaseError(RuntimeError):
    """A release invariant was violated."""


def fail(message: str) -> None:
    raise ReleaseError(message)


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read JSON {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"expected a JSON object in {path}")
    return value


def write_json(path: Path, value: Any, *, overwrite: bool = True) -> None:
    if path.exists() and not overwrite:
        fail(f"refusing to overwrite {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def run(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    capture: bool = False,
) -> str:
    rendered = " ".join(command)
    print(f"+ ({cwd}) {rendered}", flush=True)
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if completed.returncode != 0:
        detail = ""
        if capture:
            detail = f"\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        fail(f"command failed ({completed.returncode}): {rendered}{detail}")
    return completed.stdout if capture else ""


def package_dir(entry: dict[str, Any]) -> Path:
    return Path(entry["path"]).parent


def release_entries(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        *[
            item
            for item in plan["npm"]
            if item["role"] in {"publishable", "marketplace"}
        ],
        *[item for item in plan["python"] if item["role"] == "publishable"],
    ]


def validate_plan(plan: dict[str, Any]) -> None:
    if plan.get("schema_version") != 1:
        fail("unsupported release plan schema")

    ids: set[str] = set()
    paths: set[str] = set()
    names: set[str] = set()
    all_entries = [*plan.get("npm", []), *plan.get("python", [])]
    for entry in all_entries:
        for key in ("id", "path", "name", "role"):
            if not entry.get(key):
                fail(f"release plan entry is missing {key}: {entry!r}")
        if entry["id"] in ids:
            fail(f"duplicate release-plan id: {entry['id']}")
        if entry["path"] in paths:
            fail(f"duplicate release-plan manifest: {entry['path']}")
        if entry["name"] in names:
            fail(f"duplicate release-plan package name: {entry['name']}")
        ids.add(entry["id"])
        paths.add(entry["path"])
        names.add(entry["name"])

    excluded_paths: set[str] = set()
    for entry in plan.get("excluded_manifests", []):
        path = entry.get("path")
        reason = entry.get("reason")
        if not path or not reason:
            fail("every excluded manifest needs a path and reason")
        if path in paths or path in excluded_paths:
            fail(f"duplicate manifest classification: {path}")
        excluded_paths.add(path)

    release_names = {entry["name"] for entry in release_entries(plan)}
    npm_names = {entry["name"] for entry in plan["npm"]}
    python_names = {entry["name"] for entry in plan["python"]}
    for entry in all_entries:
        for edge in entry.get("internal_edges", []):
            if edge not in npm_names | python_names:
                fail(f"{entry['id']} has unknown internal edge {edge}")
            if (
                entry["role"] in {"publishable", "marketplace"}
                and edge not in release_names
            ):
                fail(
                    f"release package {entry['id']} depends on non-release package {edge}"
                )

    # Enforce the release DAG rather than trusting a hand-written layer number.
    layers = {entry["name"]: entry.get("layer", 0) for entry in release_entries(plan)}
    for entry in release_entries(plan):
        for edge in entry.get("internal_edges", []):
            if layers[edge] >= layers[entry["name"]]:
                fail(f"non-topological edge: {entry['name']} -> {edge}")


def git_tracked_manifests(repo: Path) -> set[str]:
    output = run(
        [
            "git",
            "ls-files",
            "--",
            "client-sdk/**/package.json",
            "agent-sdk/**/package.json",
            "agents/**/package.json",
            "examples/**/package.json",
            "client-sdk/**/pyproject.toml",
            "agent-sdk/**/pyproject.toml",
            "agents/**/pyproject.toml",
            "examples/**/pyproject.toml",
        ],
        cwd=repo,
        capture=True,
    )
    return {line for line in output.splitlines() if line}


def is_forbidden_spec(spec: Any) -> bool:
    if not isinstance(spec, str):
        return True
    normalized = spec.strip().lower()
    return normalized in {"", "*", "latest"} or normalized.startswith(
        FORBIDDEN_SPEC_PREFIXES
    )


def npm_dependencies(manifest: dict[str, Any]) -> dict[str, tuple[str, Any]]:
    result: dict[str, tuple[str, Any]] = {}
    for section in DEPENDENCY_SECTIONS:
        values = manifest.get(section, {})
        if values is None:
            continue
        if not isinstance(values, dict):
            fail(f"package.json {section} must be an object")
        for name, spec in values.items():
            result[name] = (section, spec)
    return result


def python_dependencies(project: dict[str, Any]) -> dict[str, str]:
    dependencies = project.get("project", {}).get("dependencies", [])
    if not isinstance(dependencies, list):
        fail("pyproject project.dependencies must be a list")
    result: dict[str, str] = {}
    for requirement in dependencies:
        if not isinstance(requirement, str):
            fail(f"non-string Python requirement: {requirement!r}")
        match = re.match(r"^([A-Za-z0-9_.-]+)", requirement)
        if match:
            result[match.group(1).lower().replace("_", "-")] = requirement
    return result


def validate_source(repo: Path, plan_path: Path) -> None:
    plan = read_json(plan_path)
    validate_plan(plan)
    classified = {
        *[entry["path"] for entry in plan["npm"]],
        *[entry["path"] for entry in plan["python"]],
        *[entry["path"] for entry in plan["excluded_manifests"]],
    }
    tracked = git_tracked_manifests(repo)
    missing = sorted(tracked - classified)
    stale = sorted(classified - tracked)
    if missing or stale:
        fail(
            f"manifest classification mismatch; unclassified={missing}, missing={stale}"
        )

    npm_names = {entry["name"] for entry in plan["npm"]}
    for entry in plan["npm"]:
        manifest_path = repo / entry["path"]
        manifest = read_json(manifest_path)
        if manifest.get("name") != entry["name"]:
            fail(f"name mismatch in {entry['path']}")
        actual_edges = {
            name for name in npm_dependencies(manifest) if name in npm_names
        }
        expected_edges = set(entry.get("internal_edges", []))
        # The caller's test-only host back-edge is deliberately removed in stage.
        for removal in entry.get("stage_remove", []):
            _, name = removal.split(":", 1)
            expected_edges.add(name)
        if actual_edges != expected_edges:
            fail(
                f"internal edge mismatch in {entry['path']}: "
                f"expected {sorted(expected_edges)}, found {sorted(actual_edges)}"
            )
        for name, (section, spec) in npm_dependencies(manifest).items():
            if name not in npm_names and is_forbidden_spec(spec):
                fail(
                    f"mutable external dependency {section}:{name}={spec!r} in {entry['path']}"
                )
        if entry["role"] == "publishable":
            if manifest.get("private") is True:
                fail(f"publishable package is private: {entry['path']}")
            if manifest.get("publishConfig", {}).get("access") != "public":
                fail(f"publishable package lacks public publishConfig: {entry['path']}")
            if not isinstance(manifest.get("files"), list):
                fail(f"publishable package lacks a files allowlist: {entry['path']}")
        if entry["role"] == "marketplace" and manifest.get("private") is not True:
            fail(f"marketplace-only package must be private: {entry['path']}")
        lock = entry.get("lock")
        if (
            lock
            and not (repo / lock).is_file()
            and not entry.get("source_lock_optional")
        ):
            fail(f"missing source lock for {entry['id']}: {lock}")

    python_names = {entry["name"] for entry in plan["python"]}
    for entry in plan["python"]:
        path = repo / entry["path"]
        with path.open("rb") as stream:
            project = tomllib.load(stream)
        if project.get("project", {}).get("name") != entry["name"]:
            fail(f"name mismatch in {entry['path']}")
        actual_edges = set(python_dependencies(project)) & python_names
        if actual_edges != set(entry.get("internal_edges", [])):
            fail(f"internal edge mismatch in {entry['path']}")
        lock = entry.get("lock")
        if lock and not (repo / lock).is_file():
            fail(f"missing Python lock for {entry['id']}: {lock}")

    print(f"validated {len(classified)} classified manifests")


def resolve_source(repo: Path, source: str) -> tuple[str, int]:
    sha = run(
        ["git", "rev-parse", f"{source}^{{commit}}"], cwd=repo, capture=True
    ).strip()
    epoch_text = run(
        ["git", "show", "-s", "--format=%ct", sha], cwd=repo, capture=True
    ).strip()
    return sha, int(epoch_text)


def safe_extract_git_archive(repo: Path, sha: str, destination: Path) -> None:
    archive = subprocess.run(
        ["git", "archive", "--format=tar", sha],
        cwd=repo,
        check=False,
        stdout=subprocess.PIPE,
    )
    if archive.returncode != 0:
        fail(f"git archive failed for {sha}")
    with tarfile.open(
        fileobj=__import__("io").BytesIO(archive.stdout), mode="r:"
    ) as tar:
        for member in tar.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts:
                fail(f"unsafe path in git archive: {member.name}")
        tar.extractall(destination)  # noqa: S202 - members were checked above


def load_versions(path: Path, plan: dict[str, Any]) -> tuple[str, dict[str, str]]:
    document = read_json(path)
    phase = document.get("phase")
    if phase not in {"rehearsal", "candidate"}:
        fail(f"invalid versions phase in {path}: {phase!r}")
    values = document.get("versions")
    if not isinstance(values, dict):
        fail(f"versions must be an object in {path}")
    required = {entry["name"] for entry in release_entries(plan)}
    missing = sorted(required - set(values))
    unknown = sorted(set(values) - required)
    unset = sorted(
        name
        for name in required
        if not isinstance(values.get(name), str) or not values[name]
    )
    if missing or unknown or unset:
        fail(
            f"version map invalid; missing={missing}, unknown={unknown}, unset={unset}"
        )
    return phase, {name: values[name] for name in required}


def rewrite_npm_manifest(
    manifest: dict[str, Any],
    entry: dict[str, Any],
    versions: dict[str, str],
    phase: str,
) -> dict[str, Any]:
    result = json.loads(json.dumps(manifest))
    if entry["role"] in {"publishable", "marketplace"}:
        expected = versions[entry["name"]]
        if phase == "candidate" and result.get("version") != expected:
            fail(
                f"candidate source version mismatch for {entry['name']}: "
                f"source={result.get('version')!r}, plan={expected!r}"
            )
        if phase == "rehearsal":
            result["version"] = expected
    for removal in entry.get("stage_remove", []):
        section, name = removal.split(":", 1)
        values = result.get(section)
        if isinstance(values, dict):
            values.pop(name, None)
            if not values:
                result.pop(section, None)
    for section in DEPENDENCY_SECTIONS:
        dependencies = result.get(section)
        if not isinstance(dependencies, dict):
            continue
        for dependency in list(dependencies):
            if dependency in versions:
                dependencies[dependency] = versions[dependency]
    return result


def rewrite_pyproject(
    text: str,
    entry: dict[str, Any],
    versions: dict[str, str],
    phase: str,
    hatchling: str,
) -> str:
    lines = text.splitlines(keepends=True)
    output: list[str] = []
    section = ""
    removed_uv_sources = False
    own_version_done = False
    build_requires_done = False
    dependency_replacements = {
        name: f"{name}=={versions[name]}" for name in entry["internal_edges"]
    }

    for line in lines:
        heading = re.match(r"^\s*\[([^]]+)]\s*$", line)
        if heading:
            section = heading.group(1)
            if section == "tool.uv.sources":
                removed_uv_sources = True
                continue
        if section == "tool.uv.sources":
            continue
        if section == "project" and re.match(r"^version\s*=", line):
            if entry["role"] == "publishable":
                expected = versions[entry["name"]]
                current_match = re.match(r'^version\s*=\s*"([^"]+)"', line)
                current = current_match.group(1) if current_match else None
                if phase == "candidate" and current != expected:
                    fail(
                        f"candidate source version mismatch for {entry['name']}: "
                        f"source={current!r}, plan={expected!r}"
                    )
                if phase == "rehearsal":
                    line = f'version = "{expected}"\n'
                own_version_done = True
        if section == "project" and dependency_replacements:
            match = re.match(r'^(\s*)"([A-Za-z0-9_.-]+)(?:[^";]*)"(,?\s*)$', line)
            if match:
                canonical = match.group(2).lower().replace("_", "-")
                if canonical in dependency_replacements:
                    line = f'{match.group(1)}"{dependency_replacements[canonical]}"{match.group(3)}\n'
        if section == "build-system" and re.match(r"^requires\s*=", line):
            line = f'requires = ["hatchling=={hatchling}"]\n'
            build_requires_done = True
        output.append(line)

    result = "".join(output)
    if entry["role"] == "publishable" and not own_version_done:
        fail(f"did not find project version in {entry['path']}")
    if entry["role"] == "publishable" and not build_requires_done:
        fail(f"did not find build-system.requires in {entry['path']}")
    # Evidence projects may not have build metadata, but all source overrides
    # must still disappear from the stage.
    if "[tool.uv.sources]" in text and not removed_uv_sources:
        fail(f"failed to remove tool.uv.sources from {entry['path']}")
    parsed = tomllib.loads(result)
    dependencies = python_dependencies(parsed)
    for name, expected in dependency_replacements.items():
        if dependencies.get(name) != expected:
            fail(f"failed to exact-pin {name} in {entry['path']}")
    return result


def stage_release(
    repo: Path, plan_path: Path, versions_path: Path, source: str, output: Path
) -> None:
    plan = read_json(plan_path)
    validate_plan(plan)
    phase, versions = load_versions(versions_path, plan)
    sha, epoch = resolve_source(repo, source)
    output = output.resolve()
    repo_resolved = repo.resolve()
    if output == repo_resolved or repo_resolved in output.parents:
        fail("release stage must be outside the repository")
    if output.exists():
        fail(f"release stage already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        safe_extract_git_archive(repo, sha, temp)
        for entry in plan["npm"]:
            path = temp / entry["path"]
            manifest = read_json(path)
            rewritten = rewrite_npm_manifest(manifest, entry, versions, phase)
            write_json(path, rewritten)
            if license_source := entry.get("stage_license_from"):
                shutil.copyfile(temp / license_source, path.parent / "LICENSE")
            descriptor = entry.get("plugin_descriptor")
            if descriptor:
                descriptor_path = temp / descriptor
                plugin = read_json(descriptor_path)
                plugin["version"] = versions[entry["name"]]
                write_json(descriptor_path, plugin)

        hatchling = plan["toolchain"]["hatchling"]
        for entry in plan["python"]:
            path = temp / entry["path"]
            rewritten = rewrite_pyproject(
                path.read_text(encoding="utf-8"), entry, versions, phase, hatchling
            )
            path.write_text(rewritten, encoding="utf-8")
            if license_source := entry.get("stage_license_from"):
                shutil.copyfile(temp / license_source, path.parent / "LICENSE")

        marker = {
            "schema_version": 1,
            "source_sha": sha,
            "source_epoch": epoch,
            "phase": phase,
            "plan_sha256": sha256_file(plan_path),
            "versions_sha256": sha256_file(versions_path),
            "versions": versions,
        }
        write_json(temp / STAGE_MARKER, marker)
        temp.rename(output)
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    print(f"staged {sha} at {output}")


def parse_bun_lock(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    # Bun's text lock is JSON with trailing commas.  It currently contains no
    # comments; deliberately fail if it grows syntax this small parser cannot
    # understand instead of silently accepting an incomplete graph.
    cleaned = re.sub(r",(\s*[}\]])", r"\1", text)
    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        fail(f"cannot parse Bun lock {path}: {exc}")
    if not isinstance(result, dict):
        fail(f"invalid Bun lock root in {path}")
    return result


def validate_bun_lock(
    root: Path,
    entry: dict[str, Any],
    manifest: dict[str, Any],
    versions: dict[str, str],
) -> None:
    lock_path = root / entry["lock"]
    if not lock_path.is_file():
        fail(f"missing registry-stage lock: {entry['lock']}")
    raw = lock_path.read_text(encoding="utf-8")
    lowered = raw.lower()
    for token in ("file:", "workspace:", "link:", "git+", "catalog:"):
        if token in lowered:
            fail(f"forbidden locator {token} in {entry['lock']}")
    lock = parse_bun_lock(lock_path)
    workspace = lock.get("workspaces", {}).get("")
    if not isinstance(workspace, dict):
        fail(f"missing root workspace in {entry['lock']}")
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        expected = manifest.get(section, {}) or {}
        actual = workspace.get(section, {}) or {}
        if expected != actual:
            fail(f"stale {section} root in {entry['lock']}")
    packages = lock.get("packages", {})
    for dependency in entry.get("internal_edges", []):
        record = packages.get(dependency)
        if not isinstance(record, list) or not record:
            fail(f"missing internal lock entry {dependency} in {entry['lock']}")
        expected_prefix = f"{dependency}@{versions[dependency]}"
        if record[0] != expected_prefix:
            fail(f"wrong locked internal version for {dependency} in {entry['lock']}")
        if (
            len(record) < 4
            or not isinstance(record[-1], str)
            or not record[-1].startswith("sha512-")
        ):
            fail(f"missing registry integrity for {dependency} in {entry['lock']}")


def validate_python_lock(
    root: Path,
    entry: dict[str, Any],
    versions: dict[str, str],
) -> None:
    lock_path = root / entry["lock"]
    if not lock_path.is_file():
        fail(f"missing Python lock: {entry['lock']}")
    raw = lock_path.read_text(encoding="utf-8")
    for pattern in (
        r"source\s*=\s*\{\s*editable",
        r"source\s*=\s*\{\s*directory",
        r"source\s*=\s*\{\s*git",
    ):
        if re.search(pattern, raw):
            fail(f"local/editable/Git source in {entry['lock']}")
    with lock_path.open("rb") as stream:
        lock = tomllib.load(stream)
    packages = defaultdict(list)
    for package in lock.get("package", []):
        packages[package.get("name")].append(package)
    for dependency in entry.get("internal_edges", []):
        matches = packages.get(dependency, [])
        if not any(
            package.get("version") == versions[dependency] for package in matches
        ):
            fail(
                f"wrong or missing locked internal version {dependency} in {entry['lock']}"
            )


def validate_stage(
    root: Path, plan_path: Path, *, require_registry_locks: bool
) -> None:
    plan = read_json(plan_path)
    validate_plan(plan)
    marker = read_json(root / STAGE_MARKER)
    versions = marker.get("versions")
    if not isinstance(versions, dict):
        fail("stage marker has no version map")
    if marker.get("plan_sha256") != sha256_file(plan_path):
        fail("stage was created with a different release plan")

    npm_names = {entry["name"] for entry in plan["npm"]}
    for entry in plan["npm"]:
        manifest = read_json(root / entry["path"])
        if entry["role"] in {"publishable", "marketplace"}:
            if manifest.get("version") != versions[entry["name"]]:
                fail(f"wrong staged version for {entry['name']}")
        if (
            entry.get("stage_license_from")
            and not (root / package_dir(entry) / "LICENSE").is_file()
        ):
            fail(f"staged license is missing for {entry['name']}")
        dependencies = npm_dependencies(manifest)
        for name, (section, spec) in dependencies.items():
            if is_forbidden_spec(spec) and name not in entry.get(
                "allowed_stage_local_edges", []
            ):
                fail(
                    f"forbidden staged dependency {section}:{name}={spec!r} in {entry['path']}"
                )
            if name in versions and spec != versions[name]:
                fail(
                    f"non-exact internal dependency {name}={spec!r} in {entry['path']}"
                )
        actual_edges = set(dependencies) & npm_names
        if actual_edges != set(entry.get("internal_edges", [])):
            fail(f"staged internal edge mismatch in {entry['path']}")
        if entry["role"] == "marketplace":
            if manifest.get("private") is not True:
                fail("marketplace package is npm-publishable")
            plugin = read_json(root / entry["plugin_descriptor"])
            if plugin.get("version") != manifest.get("version"):
                fail("Claude marketplace package/plugin version mismatch")
            if not (root / entry["runtime_bundle"]).is_file():
                fail("Claude marketplace runtime bundle is missing")
        if require_registry_locks and entry.get("lock"):
            validate_bun_lock(root, entry, manifest, versions)

    python_names = {entry["name"] for entry in plan["python"]}
    for entry in plan["python"]:
        path = root / entry["path"]
        text = path.read_text(encoding="utf-8")
        if "[tool.uv.sources]" in text:
            fail(f"Python source override remains in {entry['path']}")
        with path.open("rb") as stream:
            project = tomllib.load(stream)
        if (
            entry["role"] == "publishable"
            and project["project"].get("version") != versions[entry["name"]]
        ):
            fail(f"wrong staged Python version for {entry['name']}")
        if (
            entry.get("stage_license_from")
            and not (root / package_dir(entry) / "LICENSE").is_file()
        ):
            fail(f"staged license is missing for {entry['name']}")
        dependencies = python_dependencies(project)
        for name in set(dependencies) & python_names:
            expected = f"{name}=={versions[name]}"
            if dependencies[name] != expected:
                fail(f"non-exact Python internal requirement {dependencies[name]!r}")
        if require_registry_locks:
            validate_python_lock(root, entry, versions)

    qualifier = " with registry locks" if require_registry_locks else ""
    print(f"validated staged graph{qualifier}: {root}")


def freeze_paths(repo: Path, plan: dict[str, Any]) -> list[str]:
    paths = {
        *[entry["path"] for entry in plan["npm"]],
        *[entry["path"] for entry in plan["python"]],
        *[entry["lock"] for entry in plan["npm"] if entry.get("lock")],
        *[entry["lock"] for entry in plan["python"] if entry.get("lock")],
        "devtools/release/plan.json",
        "devtools/release/versions.rehearsal.json",
        "devtools/release/cooldown-policy.json",
        ".github/workflows/release-rehearsal.yml",
        ".github/workflows/release-python.yml",
        ".github/workflows/release-python-agent-service.yml",
        ".github/workflows/release-python-deerflow.yml",
    }
    return sorted(path for path in paths if (repo / path).is_file())


def make_freeze(repo: Path, plan: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "files": {
            path: {
                "sha256": sha256_file(repo / path),
                "size": (repo / path).stat().st_size,
            }
            for path in freeze_paths(repo, plan)
        },
        "toolchain": plan["toolchain"],
    }


def freeze_command(repo: Path, plan_path: Path, baseline: Path, *, write: bool) -> None:
    plan = read_json(plan_path)
    validate_plan(plan)
    current = make_freeze(repo, plan)
    if write:
        write_json(baseline, current)
        print(f"wrote dependency freeze baseline: {baseline}")
        return
    recorded = read_json(baseline)
    if recorded != current:
        recorded_files = recorded.get("files", {})
        current_files = current["files"]
        changed = sorted(
            path
            for path in set(recorded_files) | set(current_files)
            if recorded_files.get(path) != current_files.get(path)
        )
        fail(f"dependency freeze drift: {changed}")
    print(f"dependency freeze matches {baseline}")


def ensure_empty_output(path: Path) -> None:
    if path.exists():
        if not path.is_dir() or any(path.iterdir()):
            fail(f"artifact directory must not exist or must be empty: {path}")
    else:
        path.mkdir(parents=True)


def internal_closure(
    entry: dict[str, Any], entries_by_name: dict[str, dict[str, Any]]
) -> list[str]:
    """Return a dependency-first transitive internal closure for an entry."""
    result: list[str] = []
    visiting: set[str] = set()

    def visit(name: str) -> None:
        if name in result:
            return
        if name in visiting:
            fail(f"internal dependency cycle at {name}")
        dependency = entries_by_name.get(name)
        if dependency is None:
            fail(f"unknown internal dependency in artifact build: {name}")
        visiting.add(name)
        for child in dependency.get("internal_edges", []):
            visit(child)
        visiting.remove(name)
        result.append(name)

    for edge in entry.get("internal_edges", []):
        visit(edge)
    return result


def inspect_npm_tarball(tarball: Path, staged_manifest: dict[str, Any]) -> None:
    with tarfile.open(tarball, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        members_by_name = {member.name: member for member in members}
        for name in names:
            lowered = name.lower()
            if (
                "/node_modules/" in f"/{lowered}/"
                or "/.git/" in f"/{lowered}/"
                or lowered.endswith((".tgz", ".tar.gz"))
                or PurePosixPath(lowered).name in {".env", ".npmrc"}
            ):
                fail(f"forbidden file in {tarball.name}: {name}")
        try:
            package_file = archive.extractfile("package/package.json")
        except KeyError:
            package_file = None
        if package_file is None:
            fail(f"missing package/package.json in {tarball}")
        packed_manifest = json.load(package_file)
        if packed_manifest != staged_manifest:
            fail(f"packed manifest differs from staged manifest: {tarball}")
        if (
            "LICENSE" in staged_manifest.get("files", [])
            and "package/LICENSE" not in names
        ):
            fail(f"declared LICENSE is missing from {tarball}")
        bins = staged_manifest.get("bin", {})
        if isinstance(bins, str):
            bins = {staged_manifest["name"].rsplit("/", 1)[-1]: bins}
        for binary, target in bins.items():
            member_name = f"package/{str(target).removeprefix('./')}"
            member = members_by_name.get(member_name)
            if member is None:
                fail(f"bin {binary} target is missing from {tarball}: {target}")
            if member.mode & 0o111 == 0:
                fail(f"bin {binary} is not executable in {tarball}: {target}")


def artifact_record(stage: Path, files: list[Path], kind: str) -> dict[str, Any]:
    marker = read_json(stage / STAGE_MARKER)
    return {
        "schema_version": 1,
        "kind": kind,
        "source_sha": marker["source_sha"],
        "source_epoch": marker["source_epoch"],
        "phase": marker["phase"],
        "plan_sha256": marker["plan_sha256"],
        "versions": marker["versions"],
        "artifacts": [
            {
                "file": path.name,
                "sha256": sha256_file(path),
                "size": path.stat().st_size,
            }
            for path in sorted(files)
        ],
    }


def build_npm(stage: Path, plan_path: Path, output: Path) -> None:
    validate_stage(stage, plan_path, require_registry_locks=False)
    plan = read_json(plan_path)
    marker = read_json(stage / STAGE_MARKER)
    ensure_empty_output(output)
    env = os.environ.copy()
    env["SOURCE_DATE_EPOCH"] = str(marker["source_epoch"])
    env["npm_config_audit"] = "false"
    env["npm_config_fund"] = "false"
    env["npm_config_package_lock"] = "false"
    tarballs: dict[str, Path] = {}

    entries = sorted(
        (entry for entry in plan["npm"] if entry["role"] == "publishable"),
        key=lambda item: (item["layer"], item["id"]),
    )
    entries_by_name = {entry["name"]: entry for entry in entries}
    for entry in entries:
        directory = stage / package_dir(entry)
        manifest_path = directory / "package.json"
        manifest_before_install = manifest_path.read_bytes()
        internal = [
            str(tarballs[name]) for name in internal_closure(entry, entries_by_name)
        ]
        install = [
            "npm",
            "install",
            "--no-save",
            "--ignore-scripts",
            "--no-package-lock",
            "--no-audit",
            "--no-fund",
            "--include=dev",
            *internal,
        ]
        run(install, cwd=directory, env=env)
        if manifest_path.read_bytes() != manifest_before_install:
            fail(f"dependency install mutated staged manifest for {entry['id']}")
        build = entry.get("build")
        if build:
            run(build, cwd=directory, env=env)
        before = set(output.glob("*.tgz"))
        packed = run(
            [
                "npm",
                "pack",
                "--ignore-scripts",
                "--json",
                "--pack-destination",
                str(output),
            ],
            cwd=directory,
            env=env,
            capture=True,
        )
        try:
            metadata = json.loads(packed)
            filename = metadata[0]["filename"]
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            fail(f"cannot parse npm pack result for {entry['id']}: {exc}")
        tarball = output / filename
        if tarball in before or not tarball.is_file():
            fail(f"npm pack did not create one new artifact for {entry['id']}")
        manifest = read_json(directory / "package.json")
        inspect_npm_tarball(tarball, manifest)
        tarballs[entry["name"]] = tarball

    # Install all exact tarballs together outside the source/stage tree.  Root
    # direct tarball specs satisfy transitive exact internal edges without a
    # local registry and cannot leak into any package artifact.
    harness = Path(tempfile.mkdtemp(prefix="synadia-npm-artifact-smoke-"))
    try:
        dependencies = {name: f"file:{tarball}" for name, tarball in tarballs.items()}
        write_json(
            harness / "package.json",
            {
                "name": "release-artifact-smoke",
                "private": True,
                "type": "module",
                "dependencies": dependencies,
            },
        )
        run(
            [
                "npm",
                "install",
                "--ignore-scripts",
                "--no-package-lock",
                "--no-audit",
                "--no-fund",
            ],
            cwd=harness,
            env=env,
        )
        imports = [
            module for entry in entries for module in entry.get("import_smoke", [])
        ]
        for module in imports:
            run(
                ["bun", "-e", f"await import({json.dumps(module)})"],
                cwd=harness,
                env=env,
            )
        for entry in entries:
            for binary, arguments in entry.get("bin_smoke", {}).items():
                run(
                    ["bun", str(harness / "node_modules/.bin" / binary), *arguments],
                    cwd=harness,
                    env=env,
                )
    finally:
        shutil.rmtree(harness, ignore_errors=True)

    files = list(output.glob("*.tgz"))
    record = artifact_record(stage, files, "npm")
    record["packages"] = {
        entry["id"]: tarballs[entry["name"]].name for entry in entries
    }
    write_json(output / "artifacts.json", record, overwrite=False)
    write_json(
        output / "SHA256SUMS.json",
        {item["file"]: item["sha256"] for item in record["artifacts"]},
        overwrite=False,
    )
    print(f"built and artifact-tested {len(files)} npm tarballs")


def build_python(stage: Path, plan_path: Path, constraints: Path, output: Path) -> None:
    validate_stage(stage, plan_path, require_registry_locks=False)
    plan = read_json(plan_path)
    marker = read_json(stage / STAGE_MARKER)
    ensure_empty_output(output)
    env = os.environ.copy()
    env["SOURCE_DATE_EPOCH"] = str(marker["source_epoch"])
    cooldown = read_json(stage / "devtools/release/cooldown-policy.json")
    cutoff = cooldown.get("external_freeze_cutoff")
    if not isinstance(cutoff, str) or not cutoff:
        fail("Python artifact rehearsal requires an external freeze cutoff")
    env["UV_EXCLUDE_NEWER"] = cutoff
    entries = sorted(
        (entry for entry in plan["python"] if entry["role"] == "publishable"),
        key=lambda item: (item["layer"], item["id"]),
    )
    by_id: dict[str, list[Path]] = {}
    for entry in entries:
        directory = stage / package_dir(entry)
        before = set(output.iterdir())
        common = [
            "--out-dir",
            str(output),
            "--no-sources",
            "--build-constraints",
            str(constraints.resolve()),
            "--require-hashes",
            "--no-progress",
        ]
        run(["uv", "build", str(directory), "--sdist", *common], cwd=stage, env=env)
        new_sdists = sorted(set(output.glob("*.tar.gz")) - before)
        if len(new_sdists) != 1:
            fail(f"expected one new sdist for {entry['id']}, found {new_sdists}")
        sdist = new_sdists[0]
        before_wheels = set(output.glob("*.whl"))
        run(["uv", "build", str(sdist), "--wheel", *common], cwd=stage, env=env)
        new_wheels = sorted(set(output.glob("*.whl")) - before_wheels)
        if len(new_wheels) != 1:
            fail(f"expected one new wheel for {entry['id']}, found {new_wheels}")
        by_id[entry["id"]] = [sdist, new_wheels[0]]

    for artifact_kind, pattern in (("wheel", "*.whl"), ("sdist", "*.tar.gz")):
        harness = Path(
            tempfile.mkdtemp(prefix=f"synadia-python-{artifact_kind}-smoke-")
        )
        try:
            python = harness / ".venv/bin/python"
            run(
                ["uv", "venv", "--python", "3.11", str(harness / ".venv")],
                cwd=harness,
                env=env,
            )
            artifacts = [str(path.resolve()) for path in sorted(output.glob(pattern))]
            run(
                [
                    "uv",
                    "pip",
                    "install",
                    "--python",
                    str(python),
                    "--build-constraints",
                    str(constraints.resolve()),
                    "--no-progress",
                    *artifacts,
                ],
                cwd=harness,
                env=env,
            )
            for entry in entries:
                run(
                    [str(python), "-c", f"import {entry['import']}"],
                    cwd=harness,
                    env=env,
                )
        finally:
            shutil.rmtree(harness, ignore_errors=True)

    files = [*output.glob("*.whl"), *output.glob("*.tar.gz")]
    record = artifact_record(stage, files, "python")
    record["packages"] = {
        entry_id: [path.name for path in paths] for entry_id, paths in by_id.items()
    }
    write_json(output / "artifacts.json", record, overwrite=False)
    write_json(
        output / "SHA256SUMS.json",
        {item["file"]: item["sha256"] for item in record["artifacts"]},
        overwrite=False,
    )
    print(f"built and artifact-tested {len(files)} Python distributions")


def verify_record(record_path: Path, artifact_dir: Path) -> None:
    record = read_json(record_path)
    expected = record.get("artifacts")
    if not isinstance(expected, list) or not expected:
        fail("artifact record is empty")
    expected_names = {item["file"] for item in expected}
    actual_names = {
        path.name
        for path in artifact_dir.iterdir()
        if path.is_file()
        and path.name not in {record_path.name, "artifacts.json", "SHA256SUMS.json"}
    }
    if actual_names != expected_names:
        fail(
            f"artifact set mismatch: expected={sorted(expected_names)}, actual={sorted(actual_names)}"
        )
    for item in expected:
        path = artifact_dir / item["file"]
        if path.stat().st_size != item["size"] or sha256_file(path) != item["sha256"]:
            fail(f"artifact digest mismatch: {path}")
    print(f"verified {len(expected)} recorded artifacts")


def publication_preflight(
    stage: Path,
    plan_path: Path,
    versions_path: Path,
    cooldown_path: Path,
) -> None:
    plan = read_json(plan_path)
    phase, _ = load_versions(versions_path, plan)
    if phase != "candidate":
        fail("publication requires the candidate version map")
    cooldown = read_json(cooldown_path)
    if (
        cooldown.get("status") != "resolved"
        or not isinstance(cooldown.get("minimum_age_seconds"), int)
        or cooldown["minimum_age_seconds"] <= 0
        or not cooldown.get("enforcement_points")
    ):
        fail("cooldown policy is unresolved; registry publication is blocked")
    validate_stage(stage, plan_path, require_registry_locks=True)
    print("publication preflight passed")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    result.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    commands = result.add_subparsers(dest="command", required=True)

    commands.add_parser("validate-source")

    stage = commands.add_parser("stage")
    stage.add_argument("--source", default="HEAD")
    stage.add_argument("--versions", type=Path, default=DEFAULT_REHEARSAL_VERSIONS)
    stage.add_argument("--output", type=Path, required=True)

    validate = commands.add_parser("validate-stage")
    validate.add_argument("--stage", type=Path, required=True)
    validate.add_argument("--require-registry-locks", action="store_true")

    freeze = commands.add_parser("freeze")
    freeze.add_argument("action", choices=("write", "check"))
    freeze.add_argument("--baseline", type=Path, default=DEFAULT_FREEZE)

    npm = commands.add_parser("build-npm")
    npm.add_argument("--stage", type=Path, required=True)
    npm.add_argument("--output", type=Path, required=True)

    python = commands.add_parser("build-python")
    python.add_argument("--stage", type=Path, required=True)
    python.add_argument(
        "--constraints", type=Path, default=HERE / "python-build-constraints.txt"
    )
    python.add_argument("--output", type=Path, required=True)

    verify = commands.add_parser("verify-record")
    verify.add_argument("--record", type=Path, required=True)
    verify.add_argument("--artifacts", type=Path, required=True)

    publish = commands.add_parser("publication-preflight")
    publish.add_argument("--stage", type=Path, required=True)
    publish.add_argument("--versions", type=Path, default=DEFAULT_CANDIDATE_VERSIONS)
    publish.add_argument("--cooldown", type=Path, default=DEFAULT_COOLDOWN)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    repo = args.repo.resolve()
    plan_path = args.plan.resolve()
    try:
        if args.command == "validate-source":
            validate_source(repo, plan_path)
        elif args.command == "stage":
            stage_release(
                repo, plan_path, args.versions.resolve(), args.source, args.output
            )
        elif args.command == "validate-stage":
            validate_stage(
                args.stage.resolve(),
                plan_path,
                require_registry_locks=args.require_registry_locks,
            )
        elif args.command == "freeze":
            freeze_command(
                repo, plan_path, args.baseline.resolve(), write=args.action == "write"
            )
        elif args.command == "build-npm":
            build_npm(args.stage.resolve(), plan_path, args.output.resolve())
        elif args.command == "build-python":
            build_python(
                args.stage.resolve(),
                plan_path,
                args.constraints.resolve(),
                args.output.resolve(),
            )
        elif args.command == "verify-record":
            verify_record(args.record.resolve(), args.artifacts.resolve())
        elif args.command == "publication-preflight":
            publication_preflight(
                args.stage.resolve(),
                plan_path,
                args.versions.resolve(),
                args.cooldown.resolve(),
            )
        else:  # pragma: no cover - argparse prevents this
            fail(f"unknown command: {args.command}")
    except ReleaseError as exc:
        print(f"release error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
