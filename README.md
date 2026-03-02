# SLA Breach Triage Inbox

SLA Breach Triage Inbox is a GitHub-native SLA policy guard GitHub Action plus hosted API for recurring support triage.
It turns open issue queues into shift-ready escalation actions with priority, owner routing, and handoff checkpoints.

## Install and run in under 2 minutes

- Install workflow template: [`distribution/github-action/workflow-example.yml`](distribution/github-action/workflow-example.yml)
- Open live app with sample data: `https://sla-breach-triage.devtoolbox.dedyn.io/?source=github_readme_open_app_prefill&prefill=sample&autorun=1`
- View sample output format: `https://profit.devtoolbox.dedyn.io/sample-triage-report.html?source=github_readme_sample_report`

## Why teams run this action

- Generate a prioritized SLA command brief directly from GitHub Issues.
- Keep escalation ownership consistent with a stable `workspace_key`.
- Run on schedule in GitHub Actions and export markdown evidence artifacts.

## Quickstart

1. Add `.github/workflows/sla-triage-command.yml`:

```yaml
name: GitHub SLA Policy Guard Command

on:
  workflow_dispatch:
  schedule:
    - cron: "15 * * * *"

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run SLA policy guard
        id: triage
        uses: autonomy414941/sla-breach-triage-inbox@v0.1.6
        with:
          ingestion_mode: github_issues
          github_token: ${{ github.token }}
          use_sample_github_issues: "true"
          workspace_key: acme-support-prod
          source: github_action
          self_test: "false"
          output_markdown_path: ./ops/sla-triage-report.md

      - name: Upload triage report
        uses: actions/upload-artifact@v4
        with:
          name: sla-triage-report
          path: ./ops/sla-triage-report.md
```

2. Run the workflow from the Actions tab. The action fetches open issues from the current repository and falls back to bundled sample issues for first-run validation.
3. Review the generated step summary and `sla-triage-report` artifact. The action now returns `session_id` and `workspace_key` outputs for follow-up automation.
4. Keep `workspace_key` stable per team/repository so recurring runs resume the same hosted workspace session.
5. Optional legacy mode: set `ingestion_mode: zendesk_csv` and provide `zendesk_csv_path` to import Zendesk exports instead of GitHub Issues.

See [`distribution/github-action/workflow-example.yml`](distribution/github-action/workflow-example.yml) for the same template.

## Discoverability checks

Run this before/after each release so discoverability status is explicit across both GitHub Marketplace and GitHub repository search intents (GitHub SLA, issue triage, customer support escalation):

```bash
npm run check:discoverability
```

The script uses `gh api search/repositories` so query-rank checks stay stable even when GitHub web HTML changes.

Marketplace-only verification remains available:

```bash
npm run check:marketplace
```

If Marketplace is still unavailable, install remains available directly from the repository release tag:

```yaml
uses: autonomy414941/sla-breach-triage-inbox@v0.1.6
```

## Inputs

- Default mode: `ingestion_mode: github_issues` reads open issues from the current repository via GitHub API.
- Optional file mode: `github_issues_json_path` accepts JSON arrays or `search/issues` payloads.
- Legacy mode: `ingestion_mode: zendesk_csv` reads CSV exports from `zendesk_csv_path` (sample at [`distribution/github-action/zendesk-sample.csv`](distribution/github-action/zendesk-sample.csv)).

## Pricing

- Free tier: run daily command outputs and validate queue risk.
- Paid tier: `$9/month` per team for recurring workspace continuity, digest generation, and export workflow.
- Trial: `14 days` before activation.

## Hosted API

- Base URL: `https://sla-breach-triage.devtoolbox.dedyn.io`
- Daily command endpoint (GitHub): `POST /api/daily-command/import-github-issues`
- Daily command endpoint (Zendesk CSV): `POST /api/daily-command/import-zendesk`
- Health endpoint: `GET /health`

## License

MIT
