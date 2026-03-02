import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCompliancePacket,
  buildDailyCommand,
  buildDailyDigest,
  buildSlaBlueprint,
  buildTicketDecision,
  type CompliancePacketDecision,
  type DailyCommandOutput,
  type DailyDigestOutput,
  sanitizeTicketInput,
  sanitizeWorkspaceInput,
  type SlaBlueprint,
  type SlaWorkspaceInput,
  type TicketDecision,
  type TicketTriageInput
} from "./triage.js";
import { deriveEffectiveSelfTest, isLikelyAutomationUserAgent, normalizeUserAgent } from "./traffic.js";
import { buildQueueSnapshotFromZendeskCsv } from "./intake.js";
import { buildQueueSnapshotFromGithubIssuesJson } from "./github-intake.js";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MAX_BODY_BYTES = 512 * 1024;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://sla-breach-triage.devtoolbox.dedyn.io";
const PAYMENT_URL = (process.env.PAYMENT_URL || "https://github.com/autonomy414941/profit/issues/33").trim();
const PRICE_USD = Number.parseFloat(process.env.PRICE_USD || "9");
const TRIAL_DAYS = Number.parseInt(process.env.TRIAL_DAYS || "14", 10);

const STATE_FILE = path.join(DATA_DIR, "state.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const SITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../site");

const STATIC_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

type EventType =
  | "landing_view"
  | "landing_interactive"
  | "onboarding_action"
  | "integration_ingested"
  | "workspace_created"
  | "blueprint_generated"
  | "ticket_triaged"
  | "daily_command_run"
  | "digest_generated"
  | "checkout_started"
  | "payment_evidence_submitted"
  | "packet_exported";

type PaymentProof = {
  submittedAt: string;
  payerEmail: string;
  transactionId: string;
  evidenceUrl?: string;
  note?: string;
};

type SubscriptionStatus = "trial" | "active";

type DecisionRecord = TicketDecision & {
  decisionId: string;
  ticket: TicketTriageInput;
};

type WorkspaceSession = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  selfTest: boolean;
  input: SlaWorkspaceInput;
  blueprint: SlaBlueprint;
  decisions: DecisionRecord[];
  trialEndsAt: string;
  subscriptionStatus: SubscriptionStatus;
  paymentProof?: PaymentProof;
};

type EventRecord = {
  eventId: string;
  eventType: EventType;
  timestamp: string;
  source: string;
  selfTest: boolean;
  sessionId: string | null;
  details: Record<string, unknown>;
};

type State = {
  sessions: Record<string, WorkspaceSession>;
  events: EventRecord[];
  workspaceKeys: Record<string, string>;
};

type JsonObject = Record<string, unknown>;
type MetricsCounts = Record<EventType, number>;
type OnboardingCounts = Record<string, number>;
type SessionSummary = { total: number; trialing: number; active: number; expired: number };

const EVENT_TYPES: EventType[] = [
  "landing_view",
  "landing_interactive",
  "onboarding_action",
  "integration_ingested",
  "workspace_created",
  "blueprint_generated",
  "ticket_triaged",
  "daily_command_run",
  "digest_generated",
  "checkout_started",
  "payment_evidence_submitted",
  "packet_exported"
];

const state: State = {
  sessions: {},
  events: [],
  workspaceKeys: {}
};

let stateWriteQueue: Promise<void> = Promise.resolve();
let eventWriteQueue: Promise<void> = Promise.resolve();

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  response.end(JSON.stringify(payload));
}

function parseBoolean(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function normalizeSource(value: unknown, fallback = "web"): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function asOptionalString(payload: JsonObject, key: string, maxLength = 200): string | undefined {
  const raw = payload[key];
  if (raw == null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error(`invalid_${key}`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`invalid_${key}`);
  }
  return trimmed;
}

function asRequiredString(payload: JsonObject, key: string, maxLength = 200): string {
  const value = asOptionalString(payload, key, maxLength);
  if (!value) {
    throw new Error(`invalid_${key}`);
  }
  return value;
}

function asInteger(value: unknown, key: string, min: number, max: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid_${key}`);
  }
  return parsed;
}

function asNumber(value: unknown, key: string, min: number, max: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid_${key}`);
  }
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function asEmail(payload: JsonObject, key: string): string {
  const value = asRequiredString(payload, key, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    throw new Error(`invalid_${key}`);
  }
  return value;
}

function parseSessionId(payload: JsonObject): string {
  const sessionId = asRequiredString(payload, "sessionId", 120);
  if (!/^[a-zA-Z0-9-]{8,120}$/.test(sessionId)) {
    throw new Error("invalid_sessionId");
  }
  return sessionId;
}

function parseSessionIdFromPath(pathname: string): string | null {
  const match = /^\/api\/workspaces\/([a-zA-Z0-9-]{8,120})$/.exec(pathname);
  if (!match) {
    return null;
  }
  return match[1];
}

function parseOptionalSessionId(payload: JsonObject): string | null {
  const sessionId = asOptionalString(payload, "sessionId", 120);
  if (!sessionId) {
    return null;
  }
  if (!/^[a-zA-Z0-9-]{8,120}$/.test(sessionId)) {
    throw new Error("invalid_sessionId");
  }
  return sessionId;
}

function parseOptionalWorkspaceKey(payload: JsonObject): string | null {
  const workspaceKey = asOptionalString(payload, "workspaceKey", 120);
  if (!workspaceKey) {
    return null;
  }

  const normalized = workspaceKey
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!/^[a-z0-9][a-z0-9_.:-]{5,119}$/.test(normalized)) {
    throw new Error("invalid_workspaceKey");
  }

  return normalized;
}

function normalizeOnboardingAction(action: string): string {
  const normalized = action.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(normalized)) {
    throw new Error("invalid_action");
  }
  return normalized;
}

function emptyCounts(): MetricsCounts {
  return {
    landing_view: 0,
    landing_interactive: 0,
    onboarding_action: 0,
    integration_ingested: 0,
    workspace_created: 0,
    blueprint_generated: 0,
    ticket_triaged: 0,
    daily_command_run: 0,
    digest_generated: 0,
    checkout_started: 0,
    payment_evidence_submitted: 0,
    packet_exported: 0
  };
}

function isBillingLive(): boolean {
  let parsed: URL;
  try {
    parsed = new URL(PAYMENT_URL);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }

  const normalized = PAYMENT_URL.toLowerCase();
  if (normalized.includes("/test_")) {
    return false;
  }
  if (normalized.includes("github.com/autonomy414941/profit/issues/")) {
    return false;
  }
  if (normalized.includes("github.com/autonomy414941/profit/issues/new")) {
    return false;
  }
  return true;
}

function deriveSessionSelfTest(session: WorkspaceSession): boolean {
  const source = typeof session.source === "string" ? session.source.trim().toLowerCase() : "";
  return session.selfTest || source === "automation" || source === "healthcheck" || source === "selfcheck" || source === "smoke";
}

function effectiveSelfTestForEvent(event: EventRecord): boolean {
  let effectiveSelfTest = deriveEffectiveSelfTest({
    eventType: event.eventType,
    source: event.source,
    selfTest: event.selfTest,
    details: event.details
  });

  if (!effectiveSelfTest && event.sessionId) {
    const session = state.sessions[event.sessionId];
    if (session && deriveSessionSelfTest(session)) {
      effectiveSelfTest = true;
    }
  }

  return effectiveSelfTest;
}

function calculateCounts(selfTestFilter?: boolean): MetricsCounts {
  const counts = emptyCounts();
  for (const event of state.events) {
    const effectiveSelfTest = effectiveSelfTestForEvent(event);
    if (typeof selfTestFilter === "boolean" && effectiveSelfTest !== selfTestFilter) {
      continue;
    }
    counts[event.eventType] += 1;
  }
  return counts;
}

function calculateOnboardingActionCounts(selfTestFilter?: boolean): OnboardingCounts {
  const counts: OnboardingCounts = {};
  for (const event of state.events) {
    if (event.eventType !== "onboarding_action") {
      continue;
    }

    const effectiveSelfTest = effectiveSelfTestForEvent(event);
    if (typeof selfTestFilter === "boolean" && effectiveSelfTest !== selfTestFilter) {
      continue;
    }

    const actionRaw = typeof event.details.action === "string" ? event.details.action : "";
    if (!actionRaw) {
      continue;
    }
    counts[actionRaw] = (counts[actionRaw] || 0) + 1;
  }
  return counts;
}

function summarizeSessions(selfTestFilter?: boolean): SessionSummary {
  let trialing = 0;
  let active = 0;
  let expired = 0;
  let total = 0;

  for (const session of Object.values(state.sessions)) {
    const effectiveSelfTest = deriveSessionSelfTest(session);
    if (typeof selfTestFilter === "boolean" && effectiveSelfTest !== selfTestFilter) {
      continue;
    }

    total += 1;

    if (!Array.isArray(session.decisions)) {
      session.decisions = [];
    }

    if (session.subscriptionStatus === "active") {
      active += 1;
      continue;
    }

    if (Date.parse(session.trialEndsAt) > Date.now()) {
      trialing += 1;
    } else {
      expired += 1;
    }
  }

  return {
    total,
    trialing,
    active,
    expired
  };
}

function summarizeSessionsByAudience(): {
  includingSelfTests: SessionSummary;
  excludingSelfTests: SessionSummary;
  selfTestsOnly: SessionSummary;
} {
  return {
    includingSelfTests: summarizeSessions(),
    excludingSelfTests: summarizeSessions(false),
    selfTestsOnly: summarizeSessions(true)
  };
}

function toRatePercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return Math.round(((numerator / denominator) * 100 + Number.EPSILON) * 100) / 100;
}

async function saveState(): Promise<void> {
  const payload = JSON.stringify(state);
  stateWriteQueue = stateWriteQueue
    .catch(() => undefined)
    .then(() => writeFile(STATE_FILE, payload, "utf8"));
  await stateWriteQueue;
}

async function appendEvent(record: EventRecord): Promise<void> {
  eventWriteQueue = eventWriteQueue
    .catch(() => undefined)
    .then(() => appendFile(EVENTS_FILE, `${JSON.stringify(record)}\n`, "utf8"));
  await eventWriteQueue;
}

async function recordEvent(
  eventType: EventType,
  options: {
    source: string;
    selfTest: boolean;
    sessionId?: string | null;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const event: EventRecord = {
    eventId: randomUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    source: options.source,
    selfTest: options.selfTest,
    sessionId: options.sessionId ?? null,
    details: options.details || {}
  };
  state.events.push(event);
  await Promise.all([saveState(), appendEvent(event)]);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    if (
      /^invalid_[a-zA-Z0-9_]+$/.test(error.message) ||
      error.message === "session_not_found" ||
      error.message === "trial_expired" ||
      error.message === "billing_not_live" ||
      error.message === "payment_required" ||
      /^llm_/.test(error.message)
    ) {
      return error.message;
    }
  }
  return "invalid_request";
}

async function parseBody(request: http.IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("invalid_body_too_large");
    }
    chunks.push(buffer);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_json");
  }

  return parsed as JsonObject;
}

async function serveStatic(requestPath: string, response: http.ServerResponse): Promise<boolean> {
  const pathname = requestPath === "/" ? "/index.html" : requestPath;
  const normalized = path.posix.normalize(pathname);
  if (normalized.includes("..")) {
    return false;
  }

  const filePath = path.join(SITE_DIR, normalized);
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "content-type": STATIC_MIME[ext] || "application/octet-stream"
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

function createTrialEndsAt(): string {
  return new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function hasAccess(session: WorkspaceSession): boolean {
  if (session.subscriptionStatus === "active") {
    return true;
  }
  return Date.parse(session.trialEndsAt) > Date.now();
}

function trialRemainingDays(session: WorkspaceSession): number {
  const remainingMs = Date.parse(session.trialEndsAt) - Date.now();
  if (remainingMs <= 0) {
    return 0;
  }
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

function formatPrice(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function trimmedHeaderSlice(value: string | string[] | undefined, maxLength: number): string | undefined {
  const normalized = headerValue(value).trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

function browserSignalDetails(request: http.IncomingMessage): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  const acceptLanguage = trimmedHeaderSlice(request.headers["accept-language"], 120);
  if (acceptLanguage) {
    details.acceptLanguage = acceptLanguage;
  }

  const secFetchMode = trimmedHeaderSlice(request.headers["sec-fetch-mode"], 40);
  if (secFetchMode) {
    details.secFetchMode = secFetchMode;
  }

  const secFetchSite = trimmedHeaderSlice(request.headers["sec-fetch-site"], 40);
  if (secFetchSite) {
    details.secFetchSite = secFetchSite;
  }

  const secChUa = trimmedHeaderSlice(request.headers["sec-ch-ua"], 240);
  if (secChUa) {
    details.secChUa = secChUa;
  }

  return details;
}

function inferPublicBaseUrl(request: http.IncomingMessage): string {
  const fallbackUrl = (() => {
    try {
      return new URL(PUBLIC_BASE_URL);
    } catch {
      return new URL("https://sla-breach-triage.devtoolbox.dedyn.io");
    }
  })();

  const rawHost = headerValue(request.headers.host).trim().toLowerCase();
  const host = /^[a-z0-9.-]+(?::\d{1,5})?$/.test(rawHost) ? rawHost : fallbackUrl.host;

  const rawProto = headerValue(request.headers["x-forwarded-proto"])
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  const protocol = rawProto === "http" || rawProto === "https" ? rawProto : fallbackUrl.protocol.replace(":", "");

  return `${protocol}://${host}`;
}

function requestTrafficContext(
  request: http.IncomingMessage,
  payload: JsonObject,
  fallbackSource: string,
  fallbackSelfTest: boolean
): { source: string; selfTest: boolean } {
  const userAgent = normalizeUserAgent(headerValue(request.headers["user-agent"]));
  const acceptHeader = headerValue(request.headers.accept);
  const automation = isLikelyAutomationUserAgent(userAgent, acceptHeader);
  const source = normalizeSource(payload.source, automation ? "automation" : fallbackSource);
  const payloadSelfTest = "selfTest" in payload ? parseBoolean(payload.selfTest) : fallbackSelfTest;
  return {
    source,
    selfTest: payloadSelfTest || automation
  };
}

function ensureBillingReady(selfTest: boolean): void {
  if (isBillingLive() || selfTest) {
    return;
  }
  throw new Error("billing_not_live");
}

function countReclassifiedLandingViews(): number {
  let count = 0;
  for (const event of state.events) {
    if (event.eventType !== "landing_view" || event.selfTest) {
      continue;
    }
    if (
      deriveEffectiveSelfTest({
        eventType: event.eventType,
        source: event.source,
        selfTest: event.selfTest,
        details: event.details
      })
    ) {
      count += 1;
    }
  }
  return count;
}

async function createWorkspaceSession(input: SlaWorkspaceInput, source: string, selfTest: boolean): Promise<WorkspaceSession> {
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const blueprint = await buildSlaBlueprint(input);

  const session: WorkspaceSession = {
    sessionId,
    createdAt: now,
    updatedAt: now,
    source,
    selfTest,
    input,
    blueprint,
    decisions: [],
    trialEndsAt: createTrialEndsAt(),
    subscriptionStatus: "trial"
  };

  state.sessions[sessionId] = session;

  await recordEvent("workspace_created", {
    source,
    selfTest,
    sessionId,
    details: {
      teamName: input.teamName,
      helpdeskPlatform: input.helpdeskPlatform,
      slaTargetMinutes: input.slaTargetMinutes
    }
  });

  await recordEvent("blueprint_generated", {
    source,
    selfTest,
    sessionId,
    details: {
      priorityRows: blueprint.priorityMatrix.length,
      routingRules: blueprint.routingRules.length,
      breachSignals: blueprint.breachWatchSignals.length
    }
  });

  return session;
}

async function resolveWorkspaceFromRequest(options: {
  workspaceInput: SlaWorkspaceInput;
  requestedSessionId: string | null;
  workspaceKey: string | null;
  source: string;
  selfTest: boolean;
}): Promise<{ sessionId: string | null; workspaceCreated: boolean }> {
  const { workspaceInput, requestedSessionId, workspaceKey, source, selfTest } = options;
  if (requestedSessionId) {
    if (!state.sessions[requestedSessionId]) {
      throw new Error("session_not_found");
    }

    if (workspaceKey && state.workspaceKeys[workspaceKey] !== requestedSessionId) {
      state.workspaceKeys[workspaceKey] = requestedSessionId;
      await saveState();
    }

    return {
      sessionId: requestedSessionId,
      workspaceCreated: false
    };
  }

  if (!workspaceKey) {
    return {
      sessionId: null,
      workspaceCreated: false
    };
  }

  const mappedSessionId = state.workspaceKeys[workspaceKey];
  if (mappedSessionId && state.sessions[mappedSessionId]) {
    return {
      sessionId: mappedSessionId,
      workspaceCreated: false
    };
  }

  const session = await createWorkspaceSession(workspaceInput, source, selfTest);
  state.workspaceKeys[workspaceKey] = session.sessionId;
  await saveState();

  return {
    sessionId: session.sessionId,
    workspaceCreated: true
  };
}

async function createTriageDecision(
  session: WorkspaceSession,
  ticket: TicketTriageInput,
  source: string,
  selfTest: boolean
): Promise<DecisionRecord> {
  const decision = await buildTicketDecision(session.input, session.blueprint, ticket);

  const storedDecision: DecisionRecord = {
    ...decision,
    decisionId: randomUUID(),
    ticket
  };

  session.decisions.push(storedDecision);
  session.updatedAt = new Date().toISOString();

  await recordEvent("ticket_triaged", {
    source,
    selfTest,
    sessionId: session.sessionId,
    details: {
      decisionId: storedDecision.decisionId,
      priority: storedDecision.priority,
      riskLevel: storedDecision.riskLevel,
      escalateNow: storedDecision.escalateNow,
      minutesUntilBreach: ticket.minutesUntilBreach,
      decisionCount: session.decisions.length
    }
  });

  return storedDecision;
}

function createDemoWorkspaceInput(): SlaWorkspaceInput {
  return {
    teamName: "Demo GitHub Support Ops",
    helpdeskPlatform: "GitHub Issues",
    primaryQueue: "repo-issues",
    slaTargetMinutes: 45,
    monthlyTicketVolume: 2800,
    breachRatePercent: 9.2,
    timezone: "UTC",
    escalationCoverage: "24/7 follow-the-sun",
    highValueDefinition: "Enterprise contracts with 99.9% SLA"
  };
}

function createDemoTicketInput(): TicketTriageInput {
  return {
    ticketId: "GH-1001",
    subject: "P1: Enterprise billing API timeout after deploy",
    summary:
      "Billing jobs stalled for 18 minutes after deploy. Finance close is blocked and three enterprise accounts are waiting for invoices.",
    customerTier: "enterprise",
    minutesUntilBreach: 14,
    backlogAgeMinutes: 180,
    currentOwner: "tier-2-billing",
    channel: "api"
  };
}

async function warmQuickstartBlueprintCache(): Promise<void> {
  try {
    await buildSlaBlueprint(buildQuickstartWorkspaceInput({}));
  } catch (error) {
    console.error("quickstart blueprint warmup failed", error);
  }
}

function buildQuickstartWorkspaceInput(payload: JsonObject): SlaWorkspaceInput {
  const teamName = asOptionalString(payload, "teamName", 120) || "Support Ops Team";
  const helpdeskPlatform = asOptionalString(payload, "helpdeskPlatform", 80) || "GitHub Issues";
  const primaryQueue = asOptionalString(payload, "primaryQueue", 100) || "repo-issues";
  const timezone = asOptionalString(payload, "timezone", 80) || "UTC";
  const escalationCoverage =
    asOptionalString(payload, "escalationCoverage", 160) || "24/7 follow-the-sun with duty-manager escalation";
  const highValueDefinition =
    asOptionalString(payload, "highValueDefinition", 180) || "Enterprise and contract-backed SLA accounts";

  const rawSlaTargetMinutes = payload.slaTargetMinutes;
  const rawMonthlyTicketVolume = payload.monthlyTicketVolume;
  const rawBreachRatePercent = payload.breachRatePercent;

  const slaTargetMinutes =
    rawSlaTargetMinutes == null || (typeof rawSlaTargetMinutes === "string" && !rawSlaTargetMinutes.trim())
      ? 45
      : asInteger(rawSlaTargetMinutes, "slaTargetMinutes", 5, 240);
  const monthlyTicketVolume =
    rawMonthlyTicketVolume == null || (typeof rawMonthlyTicketVolume === "string" && !rawMonthlyTicketVolume.trim())
      ? 4200
      : asInteger(rawMonthlyTicketVolume, "monthlyTicketVolume", 1, 500000);
  const breachRatePercent =
    rawBreachRatePercent == null || (typeof rawBreachRatePercent === "string" && !rawBreachRatePercent.trim())
      ? 8.5
      : asNumber(rawBreachRatePercent, "breachRatePercent", 0, 100);

  return {
    teamName,
    helpdeskPlatform,
    primaryQueue,
    slaTargetMinutes,
    monthlyTicketVolume,
    breachRatePercent,
    timezone,
    escalationCoverage,
    highValueDefinition
  };
}

function buildDailyCommandRequest(payload: JsonObject): {
  workspaceInput: SlaWorkspaceInput;
  queueSnapshot: string;
  maxTickets: number;
} {
  const workspaceInput = buildQuickstartWorkspaceInput(payload);
  const queueSnapshot = asRequiredString(payload, "queueSnapshot", 9000);
  const maxTickets = parseMaxTickets(payload.maxTickets);

  return {
    workspaceInput,
    queueSnapshot,
    maxTickets
  };
}

function parseMaxTickets(value: unknown): number {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return 4;
  }
  return asInteger(value, "maxTickets", 1, 8);
}

function buildDailyCommandCsvImportRequest(payload: JsonObject): {
  workspaceInput: SlaWorkspaceInput;
  csvData: string;
  maxTickets: number;
} {
  const workspaceInput = buildQuickstartWorkspaceInput(payload);
  const csvData = asRequiredString(payload, "csvData", 180000);
  const maxTickets = parseMaxTickets(payload.maxTickets);

  return {
    workspaceInput,
    csvData,
    maxTickets
  };
}

function buildDailyCommandGithubImportRequest(payload: JsonObject): {
  workspaceInput: SlaWorkspaceInput;
  githubIssuesJson: string;
  maxTickets: number;
} {
  const workspaceInput = buildQuickstartWorkspaceInput(payload);
  const githubIssuesJson = asRequiredString(payload, "githubIssuesJson", 260000);
  const maxTickets = parseMaxTickets(payload.maxTickets);

  return {
    workspaceInput,
    githubIssuesJson,
    maxTickets
  };
}

function buildDailyCommandResponse(command: DailyCommandOutput, workspaceInput: SlaWorkspaceInput): Record<string, unknown> {
  return {
    generatedAt: command.generatedAt,
    shiftHeadline: command.shiftHeadline,
    queueSummary: command.queueSummary,
    immediateActions: command.immediateActions,
    actionBoard: command.actionBoard,
    tickets: command.tickets,
    workspaceDefaults: workspaceInput,
    recommendedTicket: command.tickets[0] || null
  };
}

function buildWorkspaceResponse(session: WorkspaceSession, publicBaseUrl = PUBLIC_BASE_URL): Record<string, unknown> {
  if (!Array.isArray(session.decisions)) {
    session.decisions = [];
  }

  const billingMode = isBillingLive() ? "live" : "test";

  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workspace: session.input,
    blueprint: session.blueprint,
    decisions: session.decisions,
    decisionCount: session.decisions.length,
    trialRemainingDays: trialRemainingDays(session),
    access: hasAccess(session),
    subscriptionStatus: session.subscriptionStatus,
    paywall: {
      monthlyPriceUsd: formatPrice(PRICE_USD),
      trialDays: TRIAL_DAYS,
      trialEndsAt: session.trialEndsAt,
      paymentUrl: PAYMENT_URL,
      paymentMode: billingMode,
      billingReady: billingMode === "live",
      checkoutUrl: `${publicBaseUrl}/?sessionId=${session.sessionId}`
    }
  };
}

function toCompliancePacketDecisions(session: WorkspaceSession): CompliancePacketDecision[] {
  if (!Array.isArray(session.decisions)) {
    return [];
  }

  return session.decisions.slice(-20).map((decision) => ({
    ticketId: decision.ticket.ticketId,
    subject: decision.ticket.subject,
    priority: decision.priority,
    riskLevel: decision.riskLevel,
    reason: decision.reason,
    recommendedOwner: decision.recommendedOwner,
    firstResponse: decision.firstResponse,
    nextActions: Array.isArray(decision.nextActions) ? decision.nextActions.slice(0, 8) : [],
    escalateNow: Boolean(decision.escalateNow)
  }));
}

function buildDailyDigestResponse(digest: DailyDigestOutput): Record<string, unknown> {
  return {
    generatedAt: digest.generatedAt,
    headline: digest.headline,
    summary: digest.summary,
    topRisks: digest.topRisks,
    ownerFollowups: digest.ownerFollowups,
    nextShiftPlan: digest.nextShiftPlan
  };
}

async function loadState(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed.sessions && typeof parsed.sessions === "object") {
      state.sessions = parsed.sessions as Record<string, WorkspaceSession>;
      for (const session of Object.values(state.sessions)) {
        if (!Array.isArray(session.decisions)) {
          session.decisions = [];
        }
      }
    }
    if (parsed.workspaceKeys && typeof parsed.workspaceKeys === "object") {
      const nextWorkspaceKeys: Record<string, string> = {};
      for (const [workspaceKey, sessionId] of Object.entries(parsed.workspaceKeys)) {
        if (typeof sessionId !== "string") {
          continue;
        }
        if (
          /^[a-z0-9][a-z0-9_.:-]{5,119}$/.test(workspaceKey) &&
          /^[a-zA-Z0-9-]{8,120}$/.test(sessionId)
        ) {
          nextWorkspaceKeys[workspaceKey] = sessionId;
        }
      }
      state.workspaceKeys = nextWorkspaceKeys;
    }
    if (Array.isArray(parsed.events)) {
      state.events = parsed.events.filter((event): event is EventRecord => {
        return Boolean(event && typeof event === "object" && EVENT_TYPES.includes((event as EventRecord).eventType));
      });
    }
  } catch {
    await saveState();
  }

  await appendFile(EVENTS_FILE, "", "utf8");
}

const server = http.createServer(async (request, response) => {
  const method = request.method || "GET";
  const host = request.headers.host || "localhost";
  const url = new URL(request.url || "/", `http://${host}`);
  const pathname = url.pathname;

  if (method === "OPTIONS" && pathname.startsWith("/api/")) {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    response.end();
    return;
  }

  try {
    if (method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
      const billingMode = isBillingLive() ? "live" : "test";
      sendJson(response, 200, {
        status: "ok",
        service: "sla-breach-triage-inbox",
        paymentMode: billingMode,
        billingReady: billingMode === "live",
        timestamp: new Date().toISOString(),
        sessions: summarizeSessionsByAudience()
      });
      return;
    }

    if (method === "GET" && pathname === "/api/metrics") {
      const totalsAll = calculateCounts();
      const totalsExternal = calculateCounts(false);
      const billingMode = isBillingLive() ? "live" : "test";
      const onboardingAll = calculateOnboardingActionCounts();
      const onboardingExternal = calculateOnboardingActionCounts(false);

      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        totals: {
          includingSelfTests: totalsAll,
          excludingSelfTests: totalsExternal,
          selfTestsOnly: calculateCounts(true)
        },
        conversion: {
          externalLandingToInteractivePct: toRatePercent(
            totalsExternal.landing_interactive,
            totalsExternal.landing_view
          ),
          externalLandingToDailyCommandPct: toRatePercent(totalsExternal.daily_command_run, totalsExternal.landing_view),
          externalInteractiveToDailyCommandPct: toRatePercent(
            totalsExternal.daily_command_run,
            totalsExternal.landing_interactive
          ),
          externalDailyCommandToWorkspacePct: toRatePercent(
            totalsExternal.workspace_created,
            totalsExternal.daily_command_run
          ),
          externalLandingToWorkspacePct: toRatePercent(totalsExternal.workspace_created, totalsExternal.landing_view),
          externalInteractiveToWorkspacePct: toRatePercent(
            totalsExternal.workspace_created,
            totalsExternal.landing_interactive
          ),
          externalWorkspaceToTriagePct: toRatePercent(totalsExternal.ticket_triaged, totalsExternal.workspace_created),
          externalCheckoutToPaymentPct: toRatePercent(
            totalsExternal.payment_evidence_submitted,
            totalsExternal.checkout_started
          )
        },
        dataQuality: {
          landingViewsReclassifiedAsAutomation: countReclassifiedLandingViews()
        },
        onboarding: {
          includingSelfTests: onboardingAll,
          excludingSelfTests: onboardingExternal,
          selfTestsOnly: calculateOnboardingActionCounts(true),
          conversion: {
            externalInteractiveToOnboardingPct: toRatePercent(
              totalsExternal.onboarding_action,
              totalsExternal.landing_interactive
            ),
            externalOnboardingToWorkspacePct: toRatePercent(
              totalsExternal.workspace_created,
              totalsExternal.onboarding_action
            )
          }
        },
        sessions: summarizeSessionsByAudience(),
        billing: {
          mode: billingMode,
          ready: billingMode === "live"
        }
      });
      return;
    }

    if (method === "GET") {
      const sessionId = parseSessionIdFromPath(pathname);
      if (sessionId) {
        const session = state.sessions[sessionId];
        if (!session) {
          sendJson(response, 404, { error: "session_not_found" });
          return;
        }
        sendJson(response, 200, buildWorkspaceResponse(session, inferPublicBaseUrl(request)));
        return;
      }
    }

    if (method === "POST" && pathname === "/api/events/landing-interactive") {
      const payload = await parseBody(request);
      const { source, selfTest } = requestTrafficContext(request, payload, "web", false);
      const pathHint = asOptionalString(payload, "path", 240);
      const triggerHint = asOptionalString(payload, "trigger", 80);
      const userAgent = normalizeUserAgent(headerValue(request.headers["user-agent"]));
      const browserSignals = browserSignalDetails(request);

      await recordEvent("landing_interactive", {
        source,
        selfTest,
        details: {
          path: pathHint || "/",
          trigger: triggerHint || "unknown",
          userAgent,
          ...browserSignals
        }
      });

      sendJson(response, 202, { status: "accepted" });
      return;
    }

    if (method === "POST" && pathname === "/api/events/onboarding-action") {
      const payload = await parseBody(request);
      const action = normalizeOnboardingAction(asRequiredString(payload, "action", 80));
      const actionSessionId = parseOptionalSessionId(payload);
      const context = requestTrafficContext(request, payload, "web", false);
      const details =
        payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
          ? (payload.details as Record<string, unknown>)
          : {};
      const detailsWithAction: Record<string, unknown> = {
        ...details,
        action
      };

      await recordEvent("onboarding_action", {
        source: context.source,
        selfTest: context.selfTest,
        sessionId: actionSessionId,
        details: detailsWithAction
      });

      sendJson(response, 202, { status: "accepted" });
      return;
    }

    if (method === "POST" && pathname === "/api/daily-command/import-zendesk") {
      const payload = await parseBody(request);
      const { workspaceInput, csvData, maxTickets } = buildDailyCommandCsvImportRequest(payload);
      const { source, selfTest } = requestTrafficContext(request, payload, "web", false);
      const requestedSessionId = parseOptionalSessionId(payload);
      const workspaceKey = parseOptionalWorkspaceKey(payload);
      const sessionResolution = await resolveWorkspaceFromRequest({
        workspaceInput,
        requestedSessionId,
        workspaceKey,
        source,
        selfTest
      });
      const sessionId = sessionResolution.sessionId;

      const importResult = buildQueueSnapshotFromZendeskCsv(csvData, maxTickets);
      const command = await buildDailyCommand(workspaceInput, importResult.queueSnapshot, maxTickets);

      await recordEvent("integration_ingested", {
        source,
        selfTest,
        sessionId,
        details: {
          integration: "zendesk_csv",
          parsedRows: importResult.parsedRows,
          selectedRows: importResult.selectedRows,
          droppedRows: importResult.droppedRows,
          workspaceKey,
          workspaceCreated: sessionResolution.workspaceCreated
        }
      });

      await recordEvent("daily_command_run", {
        source,
        selfTest,
        sessionId,
        details: {
          primaryQueue: workspaceInput.primaryQueue,
          ticketCount: command.tickets.length,
          highestPriority: command.tickets[0]?.priority || null,
          escalationsRecommended: command.tickets.filter((ticket) => ticket.escalateNow).length,
          ingestionMode: "zendesk_csv",
          parsedRows: importResult.parsedRows,
          selectedRows: importResult.selectedRows,
          workspaceKey,
          workspaceCreated: sessionResolution.workspaceCreated
        }
      });

      const publicBaseUrl = inferPublicBaseUrl(request);

      sendJson(response, 200, {
        ...buildDailyCommandResponse(command, workspaceInput),
        sessionId,
        workspaceKey,
        workspaceAutoCreated: sessionResolution.workspaceCreated,
        workspaceCheckoutUrl: sessionId ? `${publicBaseUrl}/?sessionId=${sessionId}` : null,
        importSummary: {
          integration: "zendesk_csv",
          parsedRows: importResult.parsedRows,
          selectedRows: importResult.selectedRows,
          droppedRows: importResult.droppedRows,
          ticketIds: importResult.ticketIds
        }
      });
      return;
    }

    if (method === "POST" && pathname === "/api/daily-command/import-github-issues") {
      const payload = await parseBody(request);
      const { workspaceInput, githubIssuesJson, maxTickets } = buildDailyCommandGithubImportRequest(payload);
      const { source, selfTest } = requestTrafficContext(request, payload, "web", false);
      const requestedSessionId = parseOptionalSessionId(payload);
      const workspaceKey = parseOptionalWorkspaceKey(payload);
      const sessionResolution = await resolveWorkspaceFromRequest({
        workspaceInput,
        requestedSessionId,
        workspaceKey,
        source,
        selfTest
      });
      const sessionId = sessionResolution.sessionId;

      const importResult = buildQueueSnapshotFromGithubIssuesJson(githubIssuesJson, maxTickets);
      const command = await buildDailyCommand(workspaceInput, importResult.queueSnapshot, maxTickets);

      await recordEvent("integration_ingested", {
        source,
        selfTest,
        sessionId,
        details: {
          integration: "github_issues",
          parsedIssues: importResult.parsedIssues,
          selectedIssues: importResult.selectedIssues,
          droppedIssues: importResult.droppedIssues,
          workspaceKey,
          workspaceCreated: sessionResolution.workspaceCreated
        }
      });

      await recordEvent("daily_command_run", {
        source,
        selfTest,
        sessionId,
        details: {
          primaryQueue: workspaceInput.primaryQueue,
          ticketCount: command.tickets.length,
          highestPriority: command.tickets[0]?.priority || null,
          escalationsRecommended: command.tickets.filter((ticket) => ticket.escalateNow).length,
          ingestionMode: "github_issues",
          parsedIssues: importResult.parsedIssues,
          selectedIssues: importResult.selectedIssues,
          workspaceKey,
          workspaceCreated: sessionResolution.workspaceCreated
        }
      });

      const publicBaseUrl = inferPublicBaseUrl(request);

      sendJson(response, 200, {
        ...buildDailyCommandResponse(command, workspaceInput),
        sessionId,
        workspaceKey,
        workspaceAutoCreated: sessionResolution.workspaceCreated,
        workspaceCheckoutUrl: sessionId ? `${publicBaseUrl}/?sessionId=${sessionId}` : null,
        importSummary: {
          integration: "github_issues",
          parsedIssues: importResult.parsedIssues,
          selectedIssues: importResult.selectedIssues,
          droppedIssues: importResult.droppedIssues,
          issueNumbers: importResult.issueNumbers
        }
      });
      return;
    }

    if (method === "POST" && pathname === "/api/daily-command") {
      const payload = await parseBody(request);
      const { workspaceInput, queueSnapshot, maxTickets } = buildDailyCommandRequest(payload);
      const { source, selfTest } = requestTrafficContext(request, payload, "web", false);
      const sessionId = parseOptionalSessionId(payload);
      if (sessionId && !state.sessions[sessionId]) {
        throw new Error("session_not_found");
      }
      const command = await buildDailyCommand(workspaceInput, queueSnapshot, maxTickets);

      await recordEvent("daily_command_run", {
        source,
        selfTest,
        sessionId,
        details: {
          primaryQueue: workspaceInput.primaryQueue,
          ticketCount: command.tickets.length,
          highestPriority: command.tickets[0]?.priority || null,
          escalationsRecommended: command.tickets.filter((ticket) => ticket.escalateNow).length
        }
      });

      sendJson(response, 200, buildDailyCommandResponse(command, workspaceInput));
      return;
    }

    if (method === "POST" && pathname === "/api/workspaces/quickstart") {
      const payload = await parseBody(request);
      const input = buildQuickstartWorkspaceInput(payload);
      const { source, selfTest } = requestTrafficContext(request, payload, "web", false);
      const session = await createWorkspaceSession(input, source, selfTest);

      sendJson(response, 201, buildWorkspaceResponse(session, inferPublicBaseUrl(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/workspaces") {
      const payload = await parseBody(request);
      const input = sanitizeWorkspaceInput(payload);
      const { source, selfTest } = requestTrafficContext(request, payload, "web", false);
      const session = await createWorkspaceSession(input, source, selfTest);

      sendJson(response, 201, buildWorkspaceResponse(session, inferPublicBaseUrl(request)));
      return;
    }

    if (method === "POST" && pathname === "/api/demo/instant") {
      const payload = await parseBody(request);
      const { source, selfTest } = requestTrafficContext(request, payload, "web", false);
      const session = await createWorkspaceSession(createDemoWorkspaceInput(), source, selfTest);
      const demoTicket = createDemoTicketInput();
      const demoDecision = await createTriageDecision(session, demoTicket, source, selfTest);

      sendJson(response, 201, {
        ...buildWorkspaceResponse(session, inferPublicBaseUrl(request)),
        demoTicket,
        demoDecision
      });
      return;
    }

    if (method === "POST" && pathname === "/api/workspaces/triage") {
      const payload = await parseBody(request);
      const sessionId = parseSessionId(payload);
      const session = state.sessions[sessionId];
      if (!session) {
        throw new Error("session_not_found");
      }

      if (!hasAccess(session)) {
        throw new Error("trial_expired");
      }

      const ticket = sanitizeTicketInput(payload);
      const { source, selfTest } = requestTrafficContext(request, payload, session.source, session.selfTest);
      const storedDecision = await createTriageDecision(session, ticket, source, selfTest);

      sendJson(response, 200, {
        sessionId,
        decision: storedDecision,
        decisionCount: session.decisions.length,
        trialRemainingDays: trialRemainingDays(session),
        subscriptionStatus: session.subscriptionStatus
      });
      return;
    }

    if (method === "POST" && pathname === "/api/workspaces/digest") {
      const payload = await parseBody(request);
      const sessionId = parseSessionId(payload);
      const session = state.sessions[sessionId];
      if (!session) {
        throw new Error("session_not_found");
      }

      if (session.subscriptionStatus !== "active") {
        throw new Error("payment_required");
      }

      const { source, selfTest } = requestTrafficContext(request, payload, session.source, session.selfTest);
      const decisionSummaries = toCompliancePacketDecisions(session);
      const digest = await buildDailyDigest(session.input, session.blueprint, decisionSummaries);

      await recordEvent("digest_generated", {
        source,
        selfTest,
        sessionId,
        details: {
          decisionCount: decisionSummaries.length,
          topRiskCount: digest.topRisks.length
        }
      });

      sendJson(response, 200, buildDailyDigestResponse(digest));
      return;
    }

    if (method === "POST" && pathname === "/api/billing/checkout") {
      const payload = await parseBody(request);
      const sessionId = parseSessionId(payload);
      const session = state.sessions[sessionId];
      if (!session) {
        throw new Error("session_not_found");
      }

      const { source, selfTest } = requestTrafficContext(request, payload, session.source, session.selfTest);
      ensureBillingReady(selfTest);

      await recordEvent("checkout_started", {
        source,
        selfTest,
        sessionId,
        details: {
          paymentUrl: PAYMENT_URL,
          monthlyPriceUsd: formatPrice(PRICE_USD)
        }
      });

      sendJson(response, 200, {
        status: "checkout_ready",
        checkoutMode: "payment_link",
        paymentUrl: PAYMENT_URL,
        monthlyPriceUsd: formatPrice(PRICE_USD),
        paymentMode: isBillingLive() ? "live" : "test",
        billingReady: isBillingLive()
      });
      return;
    }

    if (method === "POST" && pathname === "/api/billing/proof") {
      const payload = await parseBody(request);
      const sessionId = parseSessionId(payload);
      const session = state.sessions[sessionId];
      if (!session) {
        throw new Error("session_not_found");
      }

      const payerEmail = asEmail(payload, "payerEmail");
      const transactionId = asRequiredString(payload, "transactionId", 120);
      const evidenceUrl = asOptionalString(payload, "evidenceUrl", 400);
      const note = asOptionalString(payload, "note", 600);
      const { source, selfTest } = requestTrafficContext(request, payload, session.source, session.selfTest);
      ensureBillingReady(selfTest);

      session.subscriptionStatus = "active";
      session.updatedAt = new Date().toISOString();
      session.paymentProof = {
        submittedAt: session.updatedAt,
        payerEmail,
        transactionId,
        evidenceUrl,
        note
      };

      await recordEvent("payment_evidence_submitted", {
        source,
        selfTest,
        sessionId,
        details: {
          transactionId,
          payerEmail,
          evidenceProvided: Boolean(evidenceUrl)
        }
      });

      sendJson(response, 200, {
        status: "accepted",
        sessionId,
        subscriptionStatus: session.subscriptionStatus,
        unlockedAt: session.paymentProof.submittedAt
      });
      return;
    }

    if (method === "POST" && pathname === "/api/workspaces/export") {
      const payload = await parseBody(request);
      const sessionId = parseSessionId(payload);
      const session = state.sessions[sessionId];
      if (!session) {
        throw new Error("session_not_found");
      }

      if (session.subscriptionStatus !== "active") {
        throw new Error("payment_required");
      }

      const { source, selfTest } = requestTrafficContext(request, payload, session.source, session.selfTest);
      const decisionSummaries = toCompliancePacketDecisions(session);
      const content = await buildCompliancePacket(session.input, session.blueprint, decisionSummaries);

      await recordEvent("packet_exported", {
        source,
        selfTest,
        sessionId,
        details: {
          decisionCount: decisionSummaries.length
        }
      });

      sendJson(response, 200, {
        status: "ok",
        fileName: `sla-triage-inbox-${sessionId.slice(0, 8)}.txt`,
        content
      });
      return;
    }

    if (method === "GET" && pathname === "/") {
      const userAgent = normalizeUserAgent(headerValue(request.headers["user-agent"]));
      const acceptHeader = headerValue(request.headers.accept);
      const automation = isLikelyAutomationUserAgent(userAgent, acceptHeader);
      const source = normalizeSource(url.searchParams.get("source"), automation ? "healthcheck" : "direct");
      const selfTest = parseBoolean(url.searchParams.get("selfTest")) || automation;
      const browserSignals = browserSignalDetails(request);
      await recordEvent("landing_view", {
        source,
        selfTest,
        details: {
          userAgent,
          automation,
          ...browserSignals
        }
      });
    }

    if (method === "GET") {
      const served = await serveStatic(pathname, response);
      if (served) {
        return;
      }
    }

    sendJson(response, 404, {
      error: "not_found"
    });
  } catch (error) {
    const code = safeErrorCode(error);

    if (code === "session_not_found") {
      sendJson(response, 404, { error: code });
      return;
    }

    if (code === "trial_expired") {
      sendJson(response, 402, {
        error: code,
        paymentUrl: PAYMENT_URL,
        monthlyPriceUsd: formatPrice(PRICE_USD)
      });
      return;
    }

    if (code === "billing_not_live") {
      sendJson(response, 409, {
        error: code,
        paymentUrl: PAYMENT_URL,
        paymentMode: isBillingLive() ? "live" : "test",
        billingReady: isBillingLive(),
        message: "billing_not_live"
      });
      return;
    }

    if (code === "payment_required") {
      sendJson(response, 402, {
        error: code,
        paymentUrl: PAYMENT_URL,
        monthlyPriceUsd: formatPrice(PRICE_USD)
      });
      return;
    }

    sendJson(response, 400, {
      error: code
    });
  }
});

async function main(): Promise<void> {
  await loadState();
  server.listen(PORT, HOST, () => {
    console.log(`sla-breach-triage-inbox listening on http://${HOST}:${PORT}`);
  });
  void warmQuickstartBlueprintCache();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
