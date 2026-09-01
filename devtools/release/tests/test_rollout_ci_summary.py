from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / ".github" / "scripts" / "rollout-ci-summary.sh"
TARGET_SHA = "a" * 40


def workflow_run(
    *,
    name: str = "CI — release rehearsal",
    event: str = "push",
    head_sha: str = TARGET_SHA,
    status: str = "completed",
    conclusion: str | None = "success",
    run_id: int = 1,
    created_at: str = "2026-09-01T10:00:00Z",
    run_attempt: int = 1,
) -> dict[str, Any]:
    return {
        "id": run_id,
        "name": name,
        "event": event,
        "head_sha": head_sha,
        "status": status,
        "conclusion": conclusion,
        "created_at": created_at,
        "run_attempt": run_attempt,
    }


class RolloutSummaryTests(unittest.TestCase):
    def state(
        self,
        runs: list[dict[str, Any]],
        *,
        name: str = "CI — release rehearsal",
        event: str = "pull_request",
        self_run_id: str = "999",
        target_sha: str = TARGET_SHA,
    ) -> str:
        env = {
            **os.environ,
            "ROLLOUT_CI_SUMMARY_SOURCE_ONLY": "1",
        }
        completed = subprocess.run(
            [
                "bash",
                "-c",
                'source "$1"; workflow_state "$2" "$3" "$4" "$5"',
                "rollout-summary-test",
                str(SCRIPT),
                name,
                event,
                self_run_id,
                target_sha,
            ],
            check=True,
            input=json.dumps({"workflow_runs": runs}),
            text=True,
            capture_output=True,
            env=env,
        )
        return completed.stdout.rstrip("\n")

    def fetch_arguments(self, event: str) -> str:
        env = {
            **os.environ,
            "ROLLOUT_CI_SUMMARY_SOURCE_ONLY": "1",
        }
        completed = subprocess.run(
            [
                "bash",
                "-c",
                (
                    'source "$1"; '
                    'GITHUB_REPOSITORY="synadia-ai/synadia-agents"; '
                    'gh() { printf "%s\\n" "$*"; }; '
                    'fetch_workflow_runs "$2" "$3"'
                ),
                "rollout-summary-test",
                str(SCRIPT),
                event,
                TARGET_SHA,
            ],
            check=True,
            text=True,
            capture_output=True,
            env=env,
        )
        return completed.stdout.strip()

    def run_summary(
        self,
        runs: list[dict[str, Any]],
        *,
        discovery_timeout_seconds: int = 0,
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as temporary:
            fake_gh = Path(temporary) / "gh"
            fake_gh.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *repos/synadia-ai/synadia-agents/pulls/1/files*)
    printf '%s\\n' "$FAKE_CHANGED_PATH"
    ;;
  *repos/synadia-ai/synadia-agents/actions/runs*)
    printf '%s\\n' "$FAKE_RUNS_JSON"
    ;;
  *)
    printf 'unexpected gh invocation: %s\\n' "$*" >&2
    exit 2
    ;;
esac
""",
                encoding="utf-8",
            )
            fake_gh.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{temporary}{os.pathsep}{os.environ['PATH']}",
                "GH_TOKEN": "test-token",
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_REPOSITORY": "synadia-ai/synadia-agents",
                "GITHUB_RUN_ID": "999",
                "TARGET_SHA": TARGET_SHA,
                "PR_NUMBER": "1",
                "BEFORE_SHA": "",
                "FAKE_CHANGED_PATH": "devtools/release/release.py",
                "FAKE_RUNS_JSON": json.dumps({"workflow_runs": runs}),
                "ROLLOUT_CI_SUMMARY_COMPLETION_TIMEOUT_SECONDS": "30",
                "ROLLOUT_CI_SUMMARY_DISCOVERY_TIMEOUT_SECONDS": str(
                    discovery_timeout_seconds
                ),
                "ROLLOUT_CI_SUMMARY_POLL_SECONDS": "0",
            }
            return subprocess.run(
                ["bash", str(SCRIPT)],
                cwd=REPO,
                text=True,
                capture_output=True,
                env=env,
            )

    def test_pr_query_fetches_both_events_for_the_narrow_fallback(self) -> None:
        arguments = self.fetch_arguments("pull_request")
        self.assertIn(f"head_sha={TARGET_SHA}", arguments)
        self.assertNotIn("event=pull_request", arguments)

    def test_push_query_remains_event_scoped(self) -> None:
        arguments = self.fetch_arguments("push")
        self.assertIn(f"head_sha={TARGET_SHA}", arguments)
        self.assertIn("event=push", arguments)

    def test_release_rehearsal_accepts_same_sha_push_when_pr_run_is_absent(
        self,
    ) -> None:
        state = self.state([workflow_run()])
        self.assertEqual(state, "push\tcompleted\tsuccess")

    def test_pr_run_takes_precedence_over_successful_push_fallback(self) -> None:
        runs = [
            workflow_run(event="push", status="completed", conclusion="success"),
            workflow_run(
                event="pull_request",
                status="in_progress",
                conclusion=None,
                run_id=2,
            ),
        ]
        self.assertEqual(
            self.state(runs),
            "pull_request\tin_progress\t",
        )

    def test_failed_fallback_is_reported_as_failed_state(self) -> None:
        state = self.state([workflow_run(conclusion="failure")])
        self.assertEqual(state, "push\tcompleted\tfailure")

    def test_non_rehearsal_workflow_cannot_reuse_a_push_run(self) -> None:
        name = "CI — client-sdk/typescript"
        state = self.state([workflow_run(name=name)], name=name)
        self.assertEqual(state, "missing")

    def test_stale_sha_cannot_satisfy_the_fallback(self) -> None:
        state = self.state([workflow_run(head_sha="b" * 40)])
        self.assertEqual(state, "missing")

    def test_latest_attempt_wins_within_the_selected_event(self) -> None:
        runs = [
            workflow_run(conclusion="success"),
            workflow_run(
                conclusion="failure",
                run_id=2,
                created_at="2026-09-01T10:01:00Z",
                run_attempt=2,
            ),
        ]
        self.assertEqual(self.state(runs), "push\tcompleted\tfailure")

    def test_full_summary_accepts_successful_same_sha_push_rehearsal(self) -> None:
        completed = self.run_summary([workflow_run()])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(
            "Accepted the successful same-SHA push run for CI — release rehearsal.",
            completed.stdout,
        )
        self.assertIn("All expected rollout workflows succeeded.", completed.stdout)

    def test_full_summary_rejects_failed_same_sha_push_rehearsal(self) -> None:
        completed = self.run_summary([workflow_run(conclusion="failure")])
        self.assertEqual(completed.returncode, 1)
        self.assertIn(
            "FAILED: CI — release rehearsal (push\tcompleted\tfailure)",
            completed.stdout,
        )

    def test_full_summary_rejects_failed_pr_run_instead_of_using_push(self) -> None:
        runs = [
            workflow_run(event="push", conclusion="success"),
            workflow_run(event="pull_request", conclusion="failure", run_id=2),
        ]
        completed = self.run_summary(runs)
        self.assertEqual(completed.returncode, 1)
        self.assertIn(
            "FAILED: CI — release rehearsal (pull_request\tcompleted\tfailure)",
            completed.stdout,
        )
        self.assertNotIn("Accepted the successful same-SHA push run", completed.stdout)

    def test_missing_workflow_fails_fast_with_its_name(self) -> None:
        completed = self.run_summary([])
        self.assertEqual(completed.returncode, 1)
        self.assertIn(
            "Expected workflow runs did not appear within 0 seconds:",
            completed.stderr,
        )
        self.assertIn("CI — release rehearsal", completed.stderr)

    def test_script_has_valid_bash_syntax(self) -> None:
        subprocess.run(["bash", "-n", str(SCRIPT)], check=True)


if __name__ == "__main__":
    unittest.main()
