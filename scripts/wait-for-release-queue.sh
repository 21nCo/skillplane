#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: wait-for-release-queue.sh <workflow-file> <release-kind>" >&2
  exit 2
fi

workflow="$1"
release_kind="$2"

case "${workflow}" in
  deploy-cloudflare-tag.yml | publish-tag.yml) ;;
  *)
    echo "Unsupported release workflow: ${workflow}" >&2
    exit 2
    ;;
esac

case "${release_kind}" in
  package | production) ;;
  *)
    echo "Unsupported release kind: ${release_kind}" >&2
    exit 2
    ;;
esac

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${CURRENT_RUN_ID:?CURRENT_RUN_ID is required}"
: "${CURRENT_RUN_NUMBER:?CURRENT_RUN_NUMBER is required}"
: "${CURRENT_RUN_ATTEMPT:?CURRENT_RUN_ATTEMPT is required}"

if [[ "${CURRENT_RUN_ATTEMPT}" != "1" ]]; then
  echo "Job re-runs are not supported for ${release_kind} releases; start a fresh workflow_dispatch run for the release tag" >&2
  exit 1
fi

poll_interval=60
while true; do
  blocker_ids="$(
    gh api --paginate --method GET \
      "repos/${REPOSITORY}/actions/workflows/${workflow}/runs" \
      -f per_page=100 \
      --jq ".workflow_runs[] | select(.id != ${CURRENT_RUN_ID}) | select(.run_number < ${CURRENT_RUN_NUMBER}) | select(.status == \"requested\" or .status == \"waiting\" or .status == \"pending\" or .status == \"queued\" or .status == \"in_progress\") | .id"
  )"
  blockers=()
  while IFS= read -r run_id; do
    [[ -n "${run_id}" ]] && blockers+=("${run_id}")
  done <<< "${blocker_ids}"
  if [[ "${#blockers[@]}" -eq 0 ]]; then
    break
  fi
  echo "Waiting for ${#blockers[@]} earlier ${release_kind} release run(s): ${blockers[*]}"
  sleep "${poll_interval}"
  if ((poll_interval < 600)); then
    poll_interval=$((poll_interval * 2))
    if ((poll_interval > 600)); then
      poll_interval=600
    fi
  fi
done
