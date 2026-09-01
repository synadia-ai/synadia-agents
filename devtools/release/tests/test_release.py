from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


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
                },
                {
                    "id": "b",
                    "path": "b/package.json",
                    "name": "b",
                    "role": "publishable",
                    "layer": 1,
                    "internal_edges": [],
                },
            ],
            "python": [],
            "excluded_manifests": [],
        }
        with self.assertRaisesRegex(release.ReleaseError, "non-topological"):
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
