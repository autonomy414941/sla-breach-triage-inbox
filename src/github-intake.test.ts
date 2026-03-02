import assert from "node:assert/strict";
import test from "node:test";

import { buildQueueSnapshotFromGithubIssuesJson } from "./github-intake.js";

test("buildQueueSnapshotFromGithubIssuesJson prioritizes urgent issues and ignores PR entries", () => {
  const issues = [
    {
      number: 41,
      title: "P0: production webhook outage for enterprise tenant",
      labels: [{ name: "p0" }, { name: "enterprise" }],
      assignees: [{ login: "ops-oncall" }],
      created_at: "2026-03-01T23:00:00.000Z",
      comments: 2
    },
    {
      number: 42,
      title: "Refund queue is getting stale",
      labels: [{ name: "sla:45m" }, { name: "priority" }],
      assignees: [],
      created_at: "2026-03-01T22:30:00.000Z",
      comments: 1
    },
    {
      number: 43,
      title: "PR should not be treated as an issue",
      pull_request: { url: "https://api.github.com/repos/autonomy414941/sample/pulls/43" }
    }
  ];

  const result = buildQueueSnapshotFromGithubIssuesJson(
    JSON.stringify(issues),
    2,
    new Date("2026-03-02T00:00:00.000Z")
  );

  assert.equal(result.parsedIssues, 2);
  assert.equal(result.selectedIssues, 2);
  assert.equal(result.droppedIssues, 0);
  assert.deepEqual(result.issueNumbers, [41, 42]);
  assert.match(result.queueSnapshot, /^GH-41 \| enterprise \|/m);
  assert.match(result.queueSnapshot, /owner=ops-oncall/);
  assert.match(result.queueSnapshot, /GH-42 \| priority \| 45m to breach/);
});

test("buildQueueSnapshotFromGithubIssuesJson accepts search API payload format", () => {
  const payload = {
    items: [
      {
        number: 120,
        title: "Issue from search payload",
        labels: ["high", "customer"],
        assignee: { login: "triage-owner" },
        created_at: "2026-03-01T23:20:00.000Z"
      }
    ]
  };

  const result = buildQueueSnapshotFromGithubIssuesJson(
    JSON.stringify(payload),
    4,
    new Date("2026-03-02T00:00:00.000Z")
  );

  assert.equal(result.selectedIssues, 1);
  assert.deepEqual(result.issueNumbers, [120]);
  assert.match(result.queueSnapshot, /^GH-120 \| priority \|/m);
});

test("buildQueueSnapshotFromGithubIssuesJson rejects invalid payloads", () => {
  assert.throws(() => buildQueueSnapshotFromGithubIssuesJson("{", 4), /invalid_githubIssuesJson/);
  assert.throws(() => buildQueueSnapshotFromGithubIssuesJson("[]", 4), /invalid_githubIssuesJson/);
});
