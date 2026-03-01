import assert from "node:assert/strict";
import test from "node:test";

import { buildQueueSnapshotFromZendeskCsv } from "./intake.js";

test("buildQueueSnapshotFromZendeskCsv sorts by breach urgency and limits tickets", () => {
  const csv = [
    "id,subject,priority,sla_remaining_minutes,assignee_name,via",
    "81231,\"Billing API timeout after deploy\",urgent,14,tier-2-billing,api",
    "81277,\"Refund thread escalated twice\",high,28,tier-1-chat,chat",
    "81310,\"Webhook retries failing\",normal,65,tier-2-support,email"
  ].join("\n");

  const result = buildQueueSnapshotFromZendeskCsv(csv, 2, new Date("2026-03-01T00:00:00.000Z"));

  assert.equal(result.parsedRows, 3);
  assert.equal(result.selectedRows, 2);
  assert.equal(result.droppedRows, 1);
  assert.deepEqual(result.ticketIds, ["81231", "81277"]);
  assert.match(result.queueSnapshot, /^81231 \| priority \| 14m to breach/m);
});

test("buildQueueSnapshotFromZendeskCsv derives breach minutes from due date", () => {
  const csv = [
    "ticket_id,subject,due_at,created_at,owner,channel",
    "9001,\"Enterprise contract escalation\",2026-03-01T00:20:00.000Z,2026-02-28T22:00:00.000Z,duty-manager,email"
  ].join("\n");

  const result = buildQueueSnapshotFromZendeskCsv(csv, 4, new Date("2026-03-01T00:00:00.000Z"));

  assert.equal(result.selectedRows, 1);
  assert.match(result.queueSnapshot, /9001 \| enterprise \| 20m to breach/);
  assert.match(result.queueSnapshot, /backlog=120m/);
});

test("buildQueueSnapshotFromZendeskCsv supports quoted commas in subject", () => {
  const csv = [
    "id,subject,sla_remaining_minutes,assignee_name,via,priority",
    "9901,\"Billing, tax, and invoice mismatch\",30,team-alpha,chat,high"
  ].join("\n");

  const result = buildQueueSnapshotFromZendeskCsv(csv, 4, new Date("2026-03-01T00:00:00.000Z"));

  assert.equal(result.selectedRows, 1);
  assert.match(result.queueSnapshot, /Billing, tax, and invoice mismatch/);
  assert.match(result.queueSnapshot, /channel=chat/);
});

test("buildQueueSnapshotFromZendeskCsv rejects empty csv", () => {
  assert.throws(() => buildQueueSnapshotFromZendeskCsv("   ", 4), /invalid_csvData/);
});
