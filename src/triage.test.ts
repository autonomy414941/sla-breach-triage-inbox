import test from "node:test";
import assert from "node:assert/strict";

import { buildDailyCommand, sanitizeTicketInput, sanitizeWorkspaceInput } from "./triage.js";

const SAMPLE_WORKSPACE = {
  teamName: "Customer Support",
  helpdeskPlatform: "Zendesk",
  primaryQueue: "billing-escalations",
  slaTargetMinutes: 45,
  monthlyTicketVolume: 3800,
  breachRatePercent: 7.2,
  timezone: "America/Los_Angeles",
  escalationCoverage: "24/7 follow-the-sun",
  highValueDefinition: "ARR > 10k or enterprise contract"
} as const;

const SAMPLE_QUEUE = [
  "ZD-81231 | enterprise | 14m to breach | owner=tier-2-billing | Billing API timeout after deploy",
  "ZD-81277 | priority | 28m to breach | owner=tier-1-chat | Refund thread escalated twice"
].join("\n");

test("sanitizeWorkspaceInput accepts valid payload", () => {
  const result = sanitizeWorkspaceInput({
    teamName: "Customer Support",
    helpdeskPlatform: "Zendesk",
    primaryQueue: "billing-escalations",
    slaTargetMinutes: 45,
    monthlyTicketVolume: 3800,
    breachRatePercent: 7.2,
    timezone: "America/Los_Angeles",
    escalationCoverage: "24/7 follow-the-sun",
    highValueDefinition: "ARR > 10k or enterprise contract"
  });

  assert.equal(result.teamName, "Customer Support");
  assert.equal(result.breachRatePercent, 7.2);
  assert.equal(result.slaTargetMinutes, 45);
});

test("sanitizeWorkspaceInput rejects invalid SLA window", () => {
  assert.throws(
    () =>
      sanitizeWorkspaceInput({
        teamName: "Ops",
        helpdeskPlatform: "Intercom",
        primaryQueue: "default",
        slaTargetMinutes: 0,
        monthlyTicketVolume: 100,
        breachRatePercent: 5,
        escalationCoverage: "24/7",
        highValueDefinition: "VIP"
      }),
    /invalid_slaTargetMinutes/
  );
});

test("sanitizeTicketInput normalizes enums", () => {
  const ticket = sanitizeTicketInput({
    ticketId: "T-123",
    subject: "Checkout failure for enterprise tenant",
    summary: "Payment API times out after token refresh; two retries already failed.",
    customerTier: "Enterprise",
    minutesUntilBreach: 12,
    backlogAgeMinutes: 190,
    currentOwner: "tier-2",
    channel: "CHAT"
  });

  assert.equal(ticket.customerTier, "enterprise");
  assert.equal(ticket.channel, "chat");
  assert.equal(ticket.minutesUntilBreach, 12);
});

test("buildDailyCommand falls back when Anthropic transport fails", async (t) => {
  const originalFetch = global.fetch;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.OPENAI_API_KEY;
  global.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    if (previousAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }

    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  const result = await buildDailyCommand(SAMPLE_WORKSPACE, SAMPLE_QUEUE, 2);

  assert.equal(result.tickets.length, 2);
  assert.match(result.shiftHeadline, /Stabilize billing-escalations now/i);
  assert.equal(result.actionBoard.ownerCheckpoints.length >= 1, true);
});

test("buildDailyCommand falls back when Anthropic request times out", async (t) => {
  const originalFetch = global.fetch;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.OPENAI_API_KEY;
  global.fetch = (async () => {
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    throw timeoutError;
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    if (previousAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    }

    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  const result = await buildDailyCommand(SAMPLE_WORKSPACE, SAMPLE_QUEUE, 2);

  assert.equal(result.tickets.length, 2);
  assert.match(result.queueSummary, /Snapshot indicates immediate SLA pressure/i);
});
