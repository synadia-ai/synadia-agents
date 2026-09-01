from __future__ import annotations

import base64
import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "release.py"
SPEC = importlib.util.spec_from_file_location("release_tool", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class DependencySpecTests(unittest.TestCase):
    def test_rejects_mutable_and_local_specs(self) -> None:
        for value in (
            "",
            "*",
            "latest",
            "file:../sdk",
            "workspace:*",
            "git+https://example.test/repo",
            "https://example.test/package.tgz",
            "catalog:",
        ):
            with self.subTest(value=value):
                self.assertTrue(release.is_forbidden_spec(value))

    def test_accepts_registry_ranges_and_exact_versions(self) -> None:
        for value in ("1.2.3", "^1.2.3", ">=1 <2", "~5.6.0"):
            with self.subTest(value=value):
                self.assertFalse(release.is_forbidden_spec(value))

    def test_sha512_integrity_requires_a_complete_digest(self) -> None:
        complete = "sha512-" + base64.b64encode(b"x" * 64).decode()
        self.assertTrue(release.valid_sha512_integrity(complete))
        for value in ("sha512-", "sha512-YQ==", "sha256-" + complete[7:]):
            with self.subTest(value=value):
                self.assertFalse(release.valid_sha512_integrity(value))


class StagingTransformTests(unittest.TestCase):
    def test_npm_transform_breaks_cycle_and_exact_pins_edges(self) -> None:
        manifest = {
            "name": "@example/caller",
            "version": "1.0.0",
            "dependencies": {"external": "^2.0.0"},
            "devDependencies": {"@example/host": "file:../host"},
        }
        entry = {
            "name": "@example/caller",
            "role": "publishable",
            "stage_remove": ["devDependencies:@example/host"],
        }
        result = release.rewrite_npm_manifest(
            manifest,
            entry,
            {
                "@example/caller": "1.1.0-rehearsal.0",
                "@example/host": "1.1.0-rehearsal.0",
            },
            "rehearsal",
        )
        self.assertEqual(result["version"], "1.1.0-rehearsal.0")
        self.assertNotIn("devDependencies", result)
        self.assertEqual(manifest["version"], "1.0.0")

    def test_local_evidence_exception_is_explicit_in_plan(self) -> None:
        plan = release.read_json(release.DEFAULT_PLAN)
        entries = {entry["id"]: entry for entry in plan["npm"]}
        self.assertEqual(
            entries["open-agent-vercel"]["allowed_stage_local_edges"],
            ["@synadia-ai/open-agent"],
        )
        for entry in plan["npm"]:
            if entry["role"] in {"publishable", "marketplace"}:
                self.assertNotIn("allowed_stage_local_edges", entry)

    def test_candidate_transform_does_not_hide_own_version_mismatch(self) -> None:
        with self.assertRaisesRegex(release.ReleaseError, "source version mismatch"):
            release.rewrite_npm_manifest(
                {"name": "@example/pkg", "version": "1.0.0"},
                {"name": "@example/pkg", "role": "publishable"},
                {"@example/pkg": "1.0.1"},
                "candidate",
            )

    def test_python_transform_removes_sources_and_exact_pins(self) -> None:
        source = """\
[project]
name = "example-host"
version = "1.0.0"
dependencies = [
    "external>=2",
    "example-caller>=1",
]

[tool.uv.sources]
example-caller = { path = "../caller", editable = true }

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
"""
        result = release.rewrite_pyproject(
            source,
            {
                "name": "example-host",
                "path": "host/pyproject.toml",
                "role": "publishable",
                "internal_edges": ["example-caller"],
            },
            {"example-host": "1.1.0.dev0", "example-caller": "2.0.0.dev0"},
            "rehearsal",
            "1.32.0",
        )
        self.assertNotIn("tool.uv.sources", result)
        self.assertIn('version = "1.1.0.dev0"', result)
        self.assertIn('"example-caller==2.0.0.dev0"', result)
        self.assertIn('requires = ["hatchling==1.32.0"]', result)


class ValidationTests(unittest.TestCase):
    def test_internal_closure_is_dependency_first(self) -> None:
        entries = {
            "caller": {"name": "caller", "internal_edges": []},
            "host": {"name": "host", "internal_edges": ["caller"]},
            "adapter": {"name": "adapter", "internal_edges": ["caller", "host"]},
            "wrapper": {"name": "wrapper", "internal_edges": ["adapter"]},
        }
        self.assertEqual(
            release.internal_closure(entries["wrapper"], entries),
            ["caller", "host", "adapter"],
        )

    def test_plan_rejects_non_topological_edge(self) -> None:
        plan = {
            "schema_version": 1,
            "npm": [
                {
                    "id": "a",
                    "path": "a/package.json",
                    "name": "a",
                    "role": "publishable",
                    "layer": 1,
                    "internal_edges": ["b"],
                    "smoke_waiver": "test fixture",
                },
                {
                    "id": "b",
                    "path": "b/package.json",
                    "name": "b",
                    "role": "publishable",
                    "layer": 1,
                    "internal_edges": [],
                    "smoke_waiver": "test fixture",
                },
            ],
            "python": [],
            "excluded_manifests": [],
        }
        with self.assertRaisesRegex(release.ReleaseError, "non-topological"):
            release.validate_plan(plan)

    def test_plan_requires_runtime_smoke_or_explicit_waiver(self) -> None:
        entry = {
            "id": "extension",
            "path": "extension/package.json",
            "name": "extension",
            "role": "publishable",
            "layer": 1,
            "internal_edges": [],
        }
        plan = {
            "schema_version": 1,
            "npm": [entry],
            "python": [],
            "excluded_manifests": [],
            "toolchain": {"python": ["3.11"]},
        }
        with self.assertRaisesRegex(release.ReleaseError, "runtime smoke"):
            release.validate_plan(plan)
        entry["smoke_waiver"] = "host-loaded extension"
        release.validate_plan(plan)

    def test_tampered_artifact_fails_record_verification(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "package.tgz"
            artifact.write_bytes(b"approved")
            record = root / "record.json"
            release.write_json(
                record,
                {
                    "artifacts": [
                        {
                            "file": artifact.name,
                            "size": artifact.stat().st_size,
                            "sha256": release.sha256_file(artifact),
                        }
                    ]
                },
            )
            artifact.write_bytes(b"tampered")
            with self.assertRaisesRegex(release.ReleaseError, "digest mismatch"):
                release.verify_record(record, root)

    def test_artifact_record_rejects_unsafe_and_duplicate_names(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            record = root / "record.json"
            for filename in ("../outside.tgz", "/tmp/outside.tgz", "dir\\file.tgz"):
                with self.subTest(filename=filename):
                    release.write_json(
                        record,
                        {
                            "artifacts": [
                                {"file": filename, "size": 0, "sha256": "0" * 64}
                            ]
                        },
                    )
                    with self.assertRaisesRegex(release.ReleaseError, "unsafe"):
                        release.verify_record(record, root)

            artifact = root / "package.tgz"
            artifact.write_bytes(b"approved")
            item = {
                "file": artifact.name,
                "size": artifact.stat().st_size,
                "sha256": release.sha256_file(artifact),
            }
            release.write_json(record, {"artifacts": [item, item]})
            with self.assertRaisesRegex(release.ReleaseError, "duplicate"):
                release.verify_record(record, root)

    def test_git_archive_extraction_rejects_escaping_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "stage"
            destination.mkdir()
            payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode="w") as archive:
                link = tarfile.TarInfo("link")
                link.type = tarfile.SYMTYPE
                link.linkname = "../outside"
                archive.addfile(link)
                member = tarfile.TarInfo("link/payload")
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
            payload.seek(0)
            with tarfile.open(fileobj=payload, mode="r:") as archive:
                with self.assertRaisesRegex(release.ReleaseError, "unsafe member"):
                    release.extract_checked_tar(archive, destination)
            self.assertFalse((root / "outside" / "payload").exists())

    def test_public_scan_covers_large_files_and_all_nkey_seed_types(self) -> None:
        artifact = Path("package.tgz")
        stream = io.BytesIO(b"x" * (2 * 1024 * 1024 + 1) + b"synadia-agent-fabric")
        with self.assertRaisesRegex(release.ReleaseError, "private product"):
            release.inspect_public_stream(artifact, "large.bin", stream)

        for prefix in (b"SU", b"SA", b"SO", b"SN", b"SC"):
            with self.subTest(prefix=prefix):
                seed = prefix + b"A" * 56
                with self.assertRaisesRegex(release.ReleaseError, "NKEY seed"):
                    release.inspect_public_text(artifact, "secret.txt", seed)

    def test_python_lock_validation_delegates_complete_solution_to_uv(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            package.mkdir()
            (package / "uv.lock").write_text(
                """\
version = 1
revision = 3
requires-python = \">=3.11\"

[[package]]
name = \":root-package\"
version = \"1.0.0\"
source = { editable = \".\" }
""".replace(":root-package", "root-package"),
                encoding="utf-8",
            )
            entry = {
                "id": "root",
                "name": "root-package",
                "path": "package/pyproject.toml",
                "lock": "package/uv.lock",
                "internal_edges": [],
            }
            with mock.patch.object(release, "run") as run_mock:
                release.validate_python_lock(root, entry, {})
            run_mock.assert_called_once_with(
                [
                    "uv",
                    "lock",
                    "--check",
                    "--offline",
                    "--project",
                    "package",
                ],
                cwd=root,
            )

    def test_python_artifact_smoke_covers_every_supported_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifacts = [root / "package.whl", root / "package.tar.gz"]
            for artifact in artifacts:
                artifact.touch()
            constraints = root / "constraints.txt"
            constraints.touch()
            commands: list[list[str]] = []

            def capture(command: list[str], **_: object) -> str:
                commands.append(command)
                return ""

            with mock.patch.object(release, "run", side_effect=capture):
                release.smoke_python_artifacts(
                    [{"import": "package", "internal_edges": []}],
                    artifacts,
                    constraints,
                    {"python_internal_exclusions": []},
                    {},
                    ["3.11", "3.12", "3.13"],
                )

            venv_commands = [
                command for command in commands if command[:2] == ["uv", "venv"]
            ]
            self.assertEqual(len(venv_commands), 6)
            self.assertEqual(
                [command[command.index("--python") + 1] for command in venv_commands],
                ["3.11", "3.12", "3.13", "3.11", "3.12", "3.13"],
            )

    def test_repository_manifest_inventory_is_complete(self) -> None:
        release.validate_plan(release.read_json(release.DEFAULT_PLAN))
        classified = {
            *[
                entry["path"]
                for entry in release.read_json(release.DEFAULT_PLAN)["npm"]
            ],
            *[
                entry["path"]
                for entry in release.read_json(release.DEFAULT_PLAN)["python"]
            ],
            *[
                entry["path"]
                for entry in release.read_json(release.DEFAULT_PLAN)[
                    "excluded_manifests"
                ]
            ],
        }
        self.assertEqual(
            classified, release.git_tracked_manifests(release.DEFAULT_REPO)
        )


if __name__ == "__main__":
    unittest.main()
