#!/usr/bin/env bash
set -euo pipefail

ACTION_REPO="${ACTION_REPO:-autonomy414941/sla-breach-triage-inbox}"
PRIMARY_SEARCH_QUERIES="${PRIMARY_SEARCH_QUERIES:-support sla github action;zendesk github action;github issues triage action}"
EXPANSION_SEARCH_QUERIES="${EXPANSION_SEARCH_QUERIES:-ticket triage github action;helpdesk github action;customer support github action}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
marketplace_output_file="$(mktemp)"

marketplace_status=0
if bash "$script_dir/marketplace-check.sh" >"$marketplace_output_file" 2>&1; then
  marketplace_status=0
else
  marketplace_status=$?
fi

cat "$marketplace_output_file"
rm -f "$marketplace_output_file"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for repository search checks." >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required for repository search checks." >&2
  exit 2
fi

split_queries() {
  local input="$1"
  local raw trimmed
  IFS=';' read -r -a raw_queries <<<"$input"
  for raw in "${raw_queries[@]}"; do
    trimmed="$(printf '%s' "$raw" | xargs)"
    if [[ -n "$trimmed" ]]; then
      printf '%s\n' "$trimmed"
    fi
  done
}

count_queries() {
  local input="$1"
  local count=0
  while IFS= read -r query; do
    [[ -z "$query" ]] && continue
    count=$((count + 1))
  done < <(split_queries "$input")
  printf '%s' "$count"
}

query_rank() {
  local query="$1"
  local response total position
  local error_output status
  local attempt
  response=""
  error_output=""
  for attempt in 1 2 3; do
    response="$(gh api -X GET search/repositories -f q="$query" -f per_page=30 2>&1)"
    status=$?
    if [[ "$status" -eq 0 ]]; then
      break
    fi
    error_output="$response"
    if printf '%s' "$error_output" | grep -qi "rate limit exceeded"; then
      echo "- ${query}: api_rate_limited"
      return 3
    fi
    sleep "$attempt"
  done

  if [[ -n "$error_output" ]] && [[ "$status" -ne 0 ]]; then
    echo "- ${query}: api_error"
    return 2
  fi

  if [[ -z "$response" ]]; then
    echo "- ${query}: api_error"
    return 2
  fi

  total="$(printf '%s' "$response" | jq -r '.total_count // 0' 2>/dev/null || echo 0)"
  position="$(
    printf '%s' "$response" | jq -r --arg repo "$ACTION_REPO" '
      [.items[]?.full_name]
      | index($repo)
      | if . == null then -1 else . + 1 end
    ' 2>/dev/null || echo -1
  )"

  if [[ "$position" =~ ^[0-9]+$ ]] && [[ "$position" -gt 0 ]]; then
    echo "- ${query}: found at position ${position} (top-30 total results: ${total})"
    return 0
  fi

  echo "- ${query}: not found in top 30 (top-30 total results: ${total})"
  return 1
}

echo "Repository search visibility (primary intents):"
primary_hits=0
primary_errors=0
primary_rate_limited=0
quota_exhausted=0
required_queries="$(count_queries "$PRIMARY_SEARCH_QUERIES")"
required_queries="$((required_queries + $(count_queries "$EXPANSION_SEARCH_QUERIES")))"
search_remaining="$(
  gh api rate_limit 2>/dev/null | jq -r '.resources.search.remaining // 0' 2>/dev/null || echo 0
)"

if [[ "$search_remaining" =~ ^[0-9]+$ ]] && [[ "$required_queries" -gt "$search_remaining" ]]; then
  quota_exhausted=1
  echo "Repository search visibility skipped: search API quota too low (remaining=${search_remaining}, needed=${required_queries})."
fi

if [[ "$quota_exhausted" -eq 0 ]]; then
while IFS= read -r query; do
  [[ -z "$query" ]] && continue
  if query_rank "$query"; then
    primary_hits=$((primary_hits + 1))
  else
    status=$?
    if [[ "$status" -eq 2 ]]; then
      primary_errors=$((primary_errors + 1))
    elif [[ "$status" -eq 3 ]]; then
      primary_rate_limited=$((primary_rate_limited + 1))
    fi
  fi
done < <(split_queries "$PRIMARY_SEARCH_QUERIES")

echo "Repository search visibility (expansion intents):"
expansion_hits=0
expansion_errors=0
expansion_rate_limited=0
while IFS= read -r query; do
  [[ -z "$query" ]] && continue
  if query_rank "$query"; then
    expansion_hits=$((expansion_hits + 1))
  else
    status=$?
    if [[ "$status" -eq 2 ]]; then
      expansion_errors=$((expansion_errors + 1))
    elif [[ "$status" -eq 3 ]]; then
      expansion_rate_limited=$((expansion_rate_limited + 1))
    fi
  fi
done < <(split_queries "$EXPANSION_SEARCH_QUERIES")
else
  expansion_hits=0
  expansion_errors=0
  expansion_rate_limited=0
fi

total_hits=$((primary_hits + expansion_hits))
if [[ "$primary_hits" -gt 0 ]]; then
  echo "Repository search discoverability: PASS (primary hits=${primary_hits}, expansion hits=${expansion_hits})"
elif [[ "$expansion_hits" -gt 0 ]]; then
  echo "Repository search discoverability: PASS_WITH_EXPANSION_ONLY (primary hits=0, expansion hits=${expansion_hits})"
else
  echo "Repository search discoverability: FAIL (primary hits=0, expansion hits=${expansion_hits})" >&2
fi

if [[ "$primary_errors" -gt 0 || "$expansion_errors" -gt 0 ]]; then
  echo "Repository search warning: query errors detected (primary=${primary_errors}, expansion=${expansion_errors})." >&2
fi

if [[ "$primary_rate_limited" -gt 0 || "$expansion_rate_limited" -gt 0 ]]; then
  echo "Repository search warning: query rate-limited (primary=${primary_rate_limited}, expansion=${expansion_rate_limited})." >&2
fi

if [[ "$quota_exhausted" -ne 0 ]] && [[ "$marketplace_status" -ne 0 ]]; then
  echo "Discoverability check inconclusive: Marketplace unavailable and search API quota is exhausted." >&2
  exit 2
fi

if [[ "$marketplace_status" -ne 0 ]] && [[ "$total_hits" -eq 0 ]]; then
  if [[ "$primary_rate_limited" -gt 0 ]] && [[ "$primary_errors" -eq 0 ]]; then
    echo "Discoverability check inconclusive: Marketplace unavailable and primary query checks were rate-limited." >&2
    exit 2
  fi
  echo "Discoverability check failed: Marketplace unavailable and repository search does not surface $ACTION_REPO." >&2
  exit 1
fi

if [[ "$marketplace_status" -ne 0 ]]; then
  echo "Marketplace unavailable, but repository search surfaces $ACTION_REPO."
  exit 0
fi

echo "Marketplace and repository search both surface $ACTION_REPO."
