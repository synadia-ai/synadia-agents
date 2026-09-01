#!/usr/bin/env bash

set -euo pipefail

fetch_workflow_runs() {
  local event_name="$1"
  local target_sha="$2"
  local -a query_args=(
    --method GET
    -f head_sha="$target_sha"
    -F per_page=100
  )

  # A rollout PR to main intentionally reuses the release rehearsal that ran
  # when the exact same SHA was pushed to sdk-release-rollout. Fetch both
  # events for PR evaluation; workflow_state still prefers a PR run whenever
  # one exists and permits the push fallback for release rehearsal only.
  if [[ "$event_name" != "pull_request" ]]; then
    query_args+=(-f event="$event_name")
  fi

  gh api "repos/$GITHUB_REPOSITORY/actions/runs" "${query_args[@]}"
}

workflow_state() {
  local name="$1"
  local event_name="$2"
  local self_run_id="$3"
  local target_sha="$4"

  jq -r \
    --arg name "$name" \
    --arg event "$event_name" \
    --arg self "$self_run_id" \
    --arg target "$target_sha" \
    '
      def latest: sort_by([.created_at, .run_attempt]) | last;

      ([.workflow_runs[]
        | select(
            .head_sha == $target
            and .name == $name
            and (.id | tostring) != $self
            and .event == $event
          )]
        | latest) as $primary
      | if $primary != null then
          $primary
        elif $event == "pull_request" and $name == "CI — release rehearsal" then
          ([.workflow_runs[]
            | select(
                .head_sha == $target
                and .name == $name
                and (.id | tostring) != $self
                and .event == "push"
              )]
            | latest)
        else
          null
        end
      | if . == null then
          "missing"
        else
          [.event, .status, (.conclusion // "")] | @tsv
        end
    '
}

# Unit tests source the two functions above without executing the workflow.
if [[ "${ROLLOUT_CI_SUMMARY_SOURCE_ONLY:-0}" == "1" ]]; then
  if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
    return 0
  fi
  exit 0
fi

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID must be set}"
: "${TARGET_SHA:?TARGET_SHA must be set}"

declare -a changed_paths=()

if [[ "$GITHUB_EVENT_NAME" == "pull_request" ]]; then
  : "${PR_NUMBER:?PR_NUMBER must be set for pull_request runs}"
  paths_output="$(
    gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/files" \
      --paginate --jq '.[].filename'
  )"
  if [[ -n "$paths_output" ]]; then
    while IFS= read -r path; do
      changed_paths+=("$path")
    done <<<"$paths_output"
  fi
else
  : "${BEFORE_SHA:?BEFORE_SHA must be set for push runs}"
  if [[ "$BEFORE_SHA" == "0000000000000000000000000000000000000000" ]]; then
    # A new branch has no meaningful comparison base. Requiring the complete
    # rollout suite is conservative and gives the branch its first baseline.
    changed_paths=("__all_rollout_components__")
  else
    # The GitHub compare API silently caps its file list at 300. Diff the
    # commits locally instead so a large push cannot hide an affected
    # component from the evaluator. A force-push may leave BEFORE_SHA outside
    # the checked-out history, so fetch that exact commit when necessary.
    if ! git cat-file -e "$BEFORE_SHA^{commit}" 2>/dev/null; then
      git fetch --no-tags --depth=1 origin "$BEFORE_SHA"
    fi
    paths_output="$(git diff --name-only "$BEFORE_SHA" "$TARGET_SHA")"
    if [[ -n "$paths_output" ]]; then
      while IFS= read -r path; do
        changed_paths+=("$path")
      done <<<"$paths_output"
    fi
  fi
fi

if (( ${#changed_paths[@]} == 0 )); then
  echo "No changed paths reported; no component workflows are expected."
  exit 0
fi

declare -a expected_names=()
expected_count=0

expect() {
  local candidate="$1"
  local existing
  if (( expected_count > 0 )); then
    for existing in "${expected_names[@]}"; do
      if [[ "$existing" == "$candidate" ]]; then
        return
      fi
    done
  fi
  expected_names+=("$candidate")
  expected_count=$((expected_count + 1))
}

for path in "${changed_paths[@]}"; do
  case "$path" in
    __all_rollout_components__)
      expect "CI — client-sdk/typescript"
      expect "CI — agent-sdk/typescript"
      expect "CI — agents (TypeScript)"
      expect "CI — examples (TypeScript)"
      expect "CI — client-sdk/python"
      expect "CI — agent-sdk/python"
      expect "CI — agents/deerflow"
      expect "CI — Python identity workbook"
      expect "CI — release rehearsal"
      ;;
    client-sdk/typescript/*|agent-sdk/typescript/*|test-fixtures/*|.github/workflows/client-sdk-typescript.yml)
      expect "CI — client-sdk/typescript"
      ;;
  esac

  case "$path" in
    client-sdk/typescript/*|agent-sdk/typescript/*|test-fixtures/*|.github/workflows/agent-sdk-typescript.yml)
      expect "CI — agent-sdk/typescript"
      ;;
  esac

  case "$path" in
    agents/pi/*|agents/openclaw/*|agents/opencode/*|agents/codex/*|agents/acp/*|agents/grok/*|agents/eve/*|agents/flue/*|agents/claude-code/*|agents/open-agent/*|.claude-plugin/*|client-sdk/typescript/*|agent-sdk/typescript/*|.github/workflows/agents-typescript.yml)
      expect "CI — agents (TypeScript)"
      ;;
  esac

  case "$path" in
    examples/*|client-sdk/typescript/*|agent-sdk/typescript/*|.github/workflows/examples-typescript.yml)
      expect "CI — examples (TypeScript)"
      ;;
  esac

  case "$path" in
    client-sdk/python/*|test-fixtures/*|client-sdk/typescript/*|agent-sdk/typescript/*|.github/workflows/client-sdk-python.yml)
      expect "CI — client-sdk/python"
      ;;
  esac

  case "$path" in
    agent-sdk/python/*|client-sdk/python/*|test-fixtures/*|client-sdk/typescript/*|agent-sdk/typescript/*|.github/workflows/client-sdk-python-agent-service.yml)
      expect "CI — agent-sdk/python"
      ;;
  esac

  case "$path" in
    agents/deerflow/*|client-sdk/python/*|agent-sdk/python/*|.github/workflows/agents-deerflow-python.yml)
      expect "CI — agents/deerflow"
      ;;
  esac

  case "$path" in
    examples/identity-workbook/python/*|client-sdk/python/*|agent-sdk/python/*|.github/workflows/python-identity-workbook.yml)
      expect "CI — Python identity workbook"
      ;;
  esac

  case "$path" in
    client-sdk/*|client-sdk/**/*|agent-sdk/*|agent-sdk/**/*|agents/*|agents/**/*|examples/*|examples/**/*|devtools/release/*|devtools/release/**/*|.github/workflows/release-*.yml|LICENSE)
      expect "CI — release rehearsal"
      ;;
  esac
done

if (( expected_count == 0 )); then
  echo "No path-filtered rollout workflows are expected for this change."
  exit 0
fi

echo "Waiting for rollout workflows on $TARGET_SHA:"
printf '  - %s\n' "${expected_names[@]}"

completion_timeout_seconds="${ROLLOUT_CI_SUMMARY_COMPLETION_TIMEOUT_SECONDS:-2700}"
discovery_timeout_seconds="${ROLLOUT_CI_SUMMARY_DISCOVERY_TIMEOUT_SECONDS:-300}"
poll_seconds="${ROLLOUT_CI_SUMMARY_POLL_SECONDS:-15}"
deadline=$((SECONDS + completion_timeout_seconds))
discovery_deadline=$((SECONDS + discovery_timeout_seconds))
while (( SECONDS < deadline )); do
  runs_json="$(fetch_workflow_runs "$GITHUB_EVENT_NAME" "$TARGET_SHA")"

  pending=0
  missing=0
  failed=0
  pending_names=()
  missing_names=()
  for name in "${expected_names[@]}"; do
    state="$(
      workflow_state \
        "$name" "$GITHUB_EVENT_NAME" "$GITHUB_RUN_ID" "$TARGET_SHA" \
        <<<"$runs_json"
    )"

    case "$state" in
      $'pull_request\tcompleted\tsuccess'|$'push\tcompleted\tsuccess')
        if [[
          "$GITHUB_EVENT_NAME" == "pull_request"
          && "$name" == "CI — release rehearsal"
          # The unquoted * intentionally matches the state fields after the event.
          && "$state" == $'push\t'*
        ]]; then
          echo "Accepted the successful same-SHA push run for $name."
        fi
        ;;
      $'pull_request\tcompleted\t'*|$'push\tcompleted\t'*)
        echo "FAILED: $name ($state)"
        failed=1
        ;;
      missing)
        pending=$((pending + 1))
        missing=$((missing + 1))
        pending_names+=("$name ($state)")
        missing_names+=("$name")
        ;;
      *)
        pending=$((pending + 1))
        pending_names+=("$name ($state)")
        ;;
    esac
  done

  if (( failed != 0 )); then
    exit 1
  fi
  if (( pending == 0 )); then
    echo "All expected rollout workflows succeeded."
    exit 0
  fi
  if (( missing != 0 && SECONDS >= discovery_deadline )); then
    echo \
      "Expected workflow runs did not appear within ${discovery_timeout_seconds} seconds:" \
      >&2
    printf '  - %s\n' "${missing_names[@]}" >&2
    exit 1
  fi

  echo "$pending workflow(s) not complete yet; checking again in $poll_seconds seconds."
  printf '  - %s\n' "${pending_names[@]}"
  sleep "$poll_seconds"
done

echo "Timed out waiting for expected rollout workflows to complete:" >&2
printf '  - %s\n' "${pending_names[@]}" >&2
exit 1
