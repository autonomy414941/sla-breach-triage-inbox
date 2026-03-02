#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://sla-breach-triage.devtoolbox.dedyn.io}"

get_with_retry() {
  local url="$1"
  local attempts="${2:-8}"
  local sleep_seconds=1
  local try=1

  while [[ "$try" -le "$attempts" ]]; do
    local payload
    if payload="$(curl -fsS "$url" 2>/dev/null)"; then
      printf '%s' "$payload"
      return 0
    fi

    if [[ "$try" -lt "$attempts" ]]; then
      sleep "$sleep_seconds"
      sleep_seconds=$((sleep_seconds + 1))
      try=$((try + 1))
      continue
    fi

    echo "request failed after retries: $url" >&2
    return 1
  done
}

health_payload="$(get_with_retry "$BASE_URL/health")"
status="$(printf '%s' "$health_payload" | jq -r '.status')"
if [[ "$status" != "ok" ]]; then
  echo "health check failed: $health_payload" >&2
  exit 1
fi

get_with_retry "$BASE_URL/?source=smoke&selfTest=true" >/dev/null

curl -fsS -X POST "$BASE_URL/api/events/landing-interactive" \
  -H 'content-type: application/json' \
  --data '{"source":"smoke","selfTest":true,"path":"/"}' >/dev/null

github_import_payload="$(curl -fsS -X POST "$BASE_URL/api/daily-command/import-github-issues" \
  -H 'content-type: application/json' \
  --data '{"teamName":"Self Test Support","helpdeskPlatform":"GitHub Issues","primaryQueue":"repo-issues","slaTargetMinutes":45,"monthlyTicketVolume":5200,"breachRatePercent":9.4,"timezone":"UTC","escalationCoverage":"24/7 follow-the-sun","highValueDefinition":"Enterprise ARR > 10k","maxTickets":4,"workspaceKey":"smoke-github-repo-issues","source":"smoke","selfTest":true,"githubIssuesJson":"[{\"number\":8801,\"title\":\"P0 enterprise outage after deploy\",\"labels\":[{\"name\":\"p0\"},{\"name\":\"enterprise\"}],\"assignees\":[{\"login\":\"ops-oncall\"}],\"created_at\":\"2026-03-01T23:20:00.000Z\"},{\"number\":8802,\"title\":\"Priority refund escalation\",\"labels\":[{\"name\":\"priority\"},{\"name\":\"sla:45m\"}],\"assignees\":[{\"login\":\"support-lead\"}],\"created_at\":\"2026-03-01T22:50:00.000Z\"}]"}')"

github_import_integration="$(printf '%s' "$github_import_payload" | jq -r '.importSummary.integration')"
github_import_selected="$(printf '%s' "$github_import_payload" | jq -r '.importSummary.selectedIssues')"
if [[ "$github_import_integration" != "github_issues" ]]; then
  echo "github import failed: $github_import_payload" >&2
  exit 1
fi
if [[ "$github_import_selected" == "null" || "$github_import_selected" -lt 1 ]]; then
  echo "github import selectedIssues missing: $github_import_payload" >&2
  exit 1
fi

daily_command_payload="$(curl -fsS -X POST "$BASE_URL/api/daily-command" \
  -H 'content-type: application/json' \
  --data '{"queueSnapshot":"ZD-81231 | enterprise | 14m to breach | owner=tier-2-billing | Billing API timeout after deploy\nZD-81277 | priority | 28m to breach | owner=tier-1-chat | Refund thread escalated twice\nZD-81310 | standard | 65m to breach | owner=tier-2-support | Integration webhook retries failing","primaryQueue":"billing-escalations","slaTargetMinutes":45,"teamName":"Self Test Support","maxTickets":4,"source":"smoke","selfTest":true}')"

daily_command_tickets="$(printf '%s' "$daily_command_payload" | jq -r '.tickets | length')"
daily_command_headline="$(printf '%s' "$daily_command_payload" | jq -r '.shiftHeadline')"
board_critical_count="$(printf '%s' "$daily_command_payload" | jq -r '.actionBoard.criticalCount')"
board_sweep_minutes="$(printf '%s' "$daily_command_payload" | jq -r '.actionBoard.nextSweepInMinutes')"
if [[ "$daily_command_tickets" == "null" || "$daily_command_tickets" -lt 1 ]]; then
  echo "daily command failed: $daily_command_payload" >&2
  exit 1
fi
if [[ -z "$daily_command_headline" || "$daily_command_headline" == "null" ]]; then
  echo "daily command headline missing: $daily_command_payload" >&2
  exit 1
fi
if [[ "$board_critical_count" == "null" || "$board_sweep_minutes" == "null" ]]; then
  echo "daily command action board missing: $daily_command_payload" >&2
  exit 1
fi

workspace_payload="$(curl -fsS -X POST "$BASE_URL/api/workspaces" \
  -H 'content-type: application/json' \
  --data '{"teamName":"Self Test Support","helpdeskPlatform":"Zendesk","primaryQueue":"billing-escalations","slaTargetMinutes":45,"monthlyTicketVolume":5200,"breachRatePercent":9.4,"timezone":"UTC","escalationCoverage":"24/7 follow-the-sun","highValueDefinition":"Enterprise ARR > 10k","source":"smoke","selfTest":true}')"

session_id="$(printf '%s' "$workspace_payload" | jq -r '.sessionId')"
priority_rows="$(printf '%s' "$workspace_payload" | jq -r '.blueprint.priorityMatrix | length')"
if [[ -z "$session_id" || "$session_id" == "null" ]]; then
  echo "workspace creation failed: $workspace_payload" >&2
  exit 1
fi
if [[ "$priority_rows" -lt 3 ]]; then
  echo "blueprint priority matrix too short: $workspace_payload" >&2
  exit 1
fi

triage_payload="$(curl -fsS -X POST "$BASE_URL/api/workspaces/triage" \
  -H 'content-type: application/json' \
  --data "{\"sessionId\":\"$session_id\",\"ticketId\":\"ZD-1001\",\"subject\":\"Enterprise invoice API timeout\",\"summary\":\"Customer reports invoice generation has timed out for 30 minutes after deploy. Two retries failed and finance close is blocked.\",\"customerTier\":\"enterprise\",\"minutesUntilBreach\":12,\"backlogAgeMinutes\":180,\"currentOwner\":\"tier-2-billing\",\"channel\":\"chat\",\"source\":\"smoke\",\"selfTest\":true}")"

priority="$(printf '%s' "$triage_payload" | jq -r '.decision.priority')"
decision_count="$(printf '%s' "$triage_payload" | jq -r '.decisionCount')"
if [[ "$priority" == "null" || -z "$priority" ]]; then
  echo "ticket triage failed: $triage_payload" >&2
  exit 1
fi
if [[ "$decision_count" -lt 1 ]]; then
  echo "decision count invalid: $triage_payload" >&2
  exit 1
fi

checkout_payload="$(curl -fsS -X POST "$BASE_URL/api/billing/checkout" \
  -H 'content-type: application/json' \
  --data "{\"sessionId\":\"$session_id\",\"source\":\"smoke\",\"selfTest\":true}")"

checkout_mode="$(printf '%s' "$checkout_payload" | jq -r '.checkoutMode')"
if [[ "$checkout_mode" != "payment_link" ]]; then
  echo "checkout failed: $checkout_payload" >&2
  exit 1
fi

proof_payload="$(curl -fsS -X POST "$BASE_URL/api/billing/proof" \
  -H 'content-type: application/json' \
  --data "{\"sessionId\":\"$session_id\",\"payerEmail\":\"selftest@example.com\",\"transactionId\":\"smoke-$(date +%s)\",\"source\":\"smoke\",\"selfTest\":true}")"

proof_status="$(printf '%s' "$proof_payload" | jq -r '.status')"
subscription_status="$(printf '%s' "$proof_payload" | jq -r '.subscriptionStatus')"
if [[ "$proof_status" != "accepted" || "$subscription_status" != "active" ]]; then
  echo "payment proof failed: $proof_payload" >&2
  exit 1
fi

digest_payload="$(curl -fsS -X POST "$BASE_URL/api/workspaces/digest" \
  -H 'content-type: application/json' \
  --data "{\"sessionId\":\"$session_id\",\"source\":\"smoke\",\"selfTest\":true}")"

digest_headline="$(printf '%s' "$digest_payload" | jq -r '.headline')"
digest_owner_followups="$(printf '%s' "$digest_payload" | jq -r '.ownerFollowups | length')"
if [[ -z "$digest_headline" || "$digest_headline" == "null" ]]; then
  echo "digest failed: $digest_payload" >&2
  exit 1
fi
if [[ "$digest_owner_followups" == "null" || "$digest_owner_followups" -lt 1 ]]; then
  echo "digest owner followups missing: $digest_payload" >&2
  exit 1
fi

export_payload="$(curl -fsS -X POST "$BASE_URL/api/workspaces/export" \
  -H 'content-type: application/json' \
  --data "{\"sessionId\":\"$session_id\",\"source\":\"smoke\",\"selfTest\":true}")"

export_file="$(printf '%s' "$export_payload" | jq -r '.fileName')"
if [[ -z "$export_file" || "$export_file" == "null" ]]; then
  echo "export failed: $export_payload" >&2
  exit 1
fi

resume_payload="$(curl -fsS "$BASE_URL/api/workspaces/$session_id")"
resume_decision_count="$(printf '%s' "$resume_payload" | jq -r '.decisionCount')"
resume_subscription="$(printf '%s' "$resume_payload" | jq -r '.subscriptionStatus')"
if [[ "$resume_decision_count" -lt 1 || "$resume_subscription" != "active" ]]; then
  echo "workspace restore failed: $resume_payload" >&2
  exit 1
fi

metrics_payload="$(curl -fsS "$BASE_URL/api/metrics")"
landing_interactive="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.landing_interactive')"
daily_command_runs="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.daily_command_run')"
digest_generated="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.digest_generated')"
workspace_created="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.workspace_created')"
ticket_triaged="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.ticket_triaged')"
if [[ "$landing_interactive" == "null" || "$landing_interactive" -lt 1 ]]; then
  echo "metrics missing landing_interactive: $metrics_payload" >&2
  exit 1
fi
if [[ "$daily_command_runs" == "null" || "$daily_command_runs" -lt 1 ]]; then
  echo "metrics missing daily_command_run: $metrics_payload" >&2
  exit 1
fi
if [[ "$digest_generated" == "null" || "$digest_generated" -lt 1 ]]; then
  echo "metrics missing digest_generated: $metrics_payload" >&2
  exit 1
fi
if [[ "$workspace_created" == "null" || "$workspace_created" -lt 1 ]]; then
  echo "metrics missing workspace_created: $metrics_payload" >&2
  exit 1
fi
if [[ "$ticket_triaged" == "null" || "$ticket_triaged" -lt 1 ]]; then
  echo "metrics missing ticket_triaged: $metrics_payload" >&2
  exit 1
fi

echo "healthStatus=$status"
echo "githubImportIntegration=$github_import_integration"
echo "githubImportSelectedIssues=$github_import_selected"
echo "sessionId=$session_id"
echo "priorityRows=$priority_rows"
echo "triagePriority=$priority"
echo "actionBoardCriticalCount=$board_critical_count"
echo "actionBoardNextSweepMinutes=$board_sweep_minutes"
echo "checkoutMode=$checkout_mode"
echo "proofStatus=$proof_status"
echo "subscriptionStatus=$subscription_status"
echo "digestHeadline=$digest_headline"
echo "digestOwnerFollowups=$digest_owner_followups"
echo "exportFile=$export_file"
echo "landingInteractiveIncludingSelfTests=$landing_interactive"
echo "dailyCommandRunsIncludingSelfTests=$daily_command_runs"
echo "digestGeneratedIncludingSelfTests=$digest_generated"
echo "workspaceCreatedIncludingSelfTests=$workspace_created"
echo "ticketTriagedIncludingSelfTests=$ticket_triaged"
