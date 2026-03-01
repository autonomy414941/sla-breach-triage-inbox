# SLA Breach Triage Inbox

SLA Breach Triage Inbox is a GitHub Action plus hosted API for recurring support-operations triage.
It converts Zendesk CSV exports into a shift-ready action board with priority, escalation, and owner checkpoints.

## Quickstart

1. Commit your Zendesk export to the repo (example: `ops/zendesk-export.csv`).
2. Add `.github/workflows/sla-triage-command.yml`:

```yaml
name: SLA Breach Triage Command

on:
  workflow_dispatch:
  schedule:
    - cron: "15 * * * *"

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run SLA breach triage
        id: triage
        uses: autonomy414941/sla-breach-triage-inbox@v0.1.0
        with:
          zendesk_csv_path: ./ops/zendesk-export.csv
          source: github_action
          self_test: "false"
          output_markdown_path: ./ops/sla-triage-report.md

      - name: Upload triage report
        uses: actions/upload-artifact@v4
        with:
          name: sla-triage-report
          path: ./ops/sla-triage-report.md
```

3. Run the workflow from the Actions tab.
4. Review the generated step summary and `sla-triage-report` artifact.

See [`distribution/github-action/workflow-example.yml`](distribution/github-action/workflow-example.yml) for the same template.

## Zendesk CSV format

Use a CSV export that includes ticket id, subject, priority/severity, SLA remaining minutes or deadline, assignee, and channel.
An example is in [`distribution/github-action/zendesk-sample.csv`](distribution/github-action/zendesk-sample.csv).

## Pricing

- Free tier: run daily command outputs and validate queue risk.
- Paid tier: `$9/month` per team for recurring workspace continuity, digest generation, and export workflow.
- Trial: `14 days` before activation.

## Hosted API

- Base URL: `https://sla-breach-triage.devtoolbox.dedyn.io`
- Daily command endpoint: `POST /api/daily-command/import-zendesk`
- Health endpoint: `GET /health`

