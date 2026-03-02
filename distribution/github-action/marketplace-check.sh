#!/usr/bin/env bash
set -euo pipefail

ACTION_REPO="${ACTION_REPO:-autonomy414941/sla-breach-triage-inbox}"
ACTION_NAME="${ACTION_NAME:-GitHub SLA Policy Guard Command}"
SEARCH_QUERY="${SEARCH_QUERY:-github sla policy guard}"

owner="${ACTION_REPO%%/*}"
repo="${ACTION_REPO##*/}"
action_slug="$(printf '%s' "$ACTION_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
search_query_encoded="$(printf '%s' "$SEARCH_QUERY" | sed 's/ /%20/g')"

declare -a candidate_slugs=(
  "$action_slug"
  "$repo"
  "github-sla-policy-guard-command"
  "sla-breach-triage-inbox"
)

for slug in "${candidate_slugs[@]}"; do
  [[ -z "$slug" ]] && continue
  code="$(curl -sS -o /dev/null -w '%{http_code}' "https://github.com/marketplace/actions/$slug")"
  if [[ "$code" == "200" ]]; then
    echo "Marketplace listing detected: https://github.com/marketplace/actions/$slug"
    exit 0
  fi
done

search_url="https://github.com/marketplace?type=actions&query=${search_query_encoded}"
search_page="$(curl -sS "$search_url")"

if printf '%s' "$search_page" | grep -qi "$owner" && printf '%s' "$search_page" | grep -qi "$repo"; then
  echo "Marketplace search includes $ACTION_REPO: $search_url"
  exit 0
fi

echo "Marketplace listing not detected for $ACTION_REPO." >&2
echo "Checked slug URLs and search page: $search_url" >&2
exit 1
