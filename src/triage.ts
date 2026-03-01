export type SlaWorkspaceInput = {
  teamName: string;
  helpdeskPlatform: string;
  primaryQueue: string;
  slaTargetMinutes: number;
  monthlyTicketVolume: number;
  breachRatePercent: number;
  timezone: string;
  escalationCoverage: string;
  highValueDefinition: string;
};

export type PriorityMatrixRow = {
  priority: string;
  trigger: string;
  targetResponseMinutes: number;
  escalationPath: string;
};

export type SlaBlueprint = {
  generatedAt: string;
  summary: string;
  priorityMatrix: PriorityMatrixRow[];
  routingRules: string[];
  firstResponseMacros: string[];
  shiftCadence: string[];
  breachWatchSignals: string[];
  managerBrief: string;
};

export type TicketTriageInput = {
  ticketId: string;
  subject: string;
  summary: string;
  customerTier: "standard" | "priority" | "enterprise";
  minutesUntilBreach: number;
  backlogAgeMinutes: number;
  currentOwner: string;
  channel: "email" | "chat" | "phone" | "api";
};

export type TicketDecision = {
  generatedAt: string;
  priority: "P0" | "P1" | "P2" | "P3";
  riskLevel: "low" | "medium" | "high" | "critical";
  reason: string;
  recommendedOwner: string;
  firstResponse: string;
  nextActions: string[];
  escalateNow: boolean;
  escalationMessage: string;
};

export type DailyCommandTicket = {
  ticketId: string;
  subject: string;
  customerTier: "standard" | "priority" | "enterprise";
  minutesUntilBreach: number;
  backlogAgeMinutes: number;
  currentOwner: string;
  channel: "email" | "chat" | "phone" | "api";
  priority: "P0" | "P1" | "P2" | "P3";
  riskLevel: "low" | "medium" | "high" | "critical";
  reason: string;
  immediateAction: string;
  escalateNow: boolean;
};

export type DailyCommandActionBoard = {
  criticalCount: number;
  escalationNowCount: number;
  nextSweepInMinutes: number;
  ownerCheckpoints: string[];
};

export type DailyCommandOutput = {
  generatedAt: string;
  shiftHeadline: string;
  queueSummary: string;
  immediateActions: string[];
  tickets: DailyCommandTicket[];
  actionBoard: DailyCommandActionBoard;
};

export type DailyDigestOutput = {
  generatedAt: string;
  headline: string;
  summary: string;
  topRisks: string[];
  ownerFollowups: string[];
  nextShiftPlan: string[];
};

export type CompliancePacketDecision = {
  ticketId: string;
  subject: string;
  priority: "P0" | "P1" | "P2" | "P3";
  riskLevel: "low" | "medium" | "high" | "critical";
  reason: string;
  recommendedOwner: string;
  firstResponse: string;
  nextActions: string[];
  escalateNow: boolean;
};

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
const ANTHROPIC_MAX_TOKENS = Number.parseInt(process.env.ANTHROPIC_MAX_TOKENS || "900", 10);
const ANTHROPIC_TIMEOUT_MS = Number.parseInt(process.env.ANTHROPIC_TIMEOUT_MS || "25000", 10);

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MAX_TOKENS = Number.parseInt(process.env.OPENAI_MAX_TOKENS || "900", 10);
const OPENAI_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || "25000", 10);
const LLM_MAX_ATTEMPTS = Number.parseInt(process.env.LLM_MAX_ATTEMPTS || "2", 10);
const BLUEPRINT_CACHE_MAX_ENTRIES = Number.parseInt(process.env.BLUEPRINT_CACHE_MAX_ENTRIES || "48", 10);
const BLUEPRINT_CACHE_TTL_MS = Number.parseInt(process.env.BLUEPRINT_CACHE_TTL_MS || "21600000", 10);

type JsonObject = Record<string, unknown>;
type AnthropicMessage = { type?: string; text?: string };
type AnthropicResponse = { content?: AnthropicMessage[] };
type OpenAiChoice = { message?: { content?: string | null } };
type OpenAiResponse = { choices?: OpenAiChoice[] };
type BlueprintCacheEntry = {
  cachedAt: number;
  expiresAt: number;
  blueprint: SlaBlueprint;
};

const blueprintCache = new Map<string, BlueprintCacheEntry>();

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeCacheText(value: string): string {
  return compactWhitespace(value).toLowerCase();
}

function cloneBlueprint(blueprint: SlaBlueprint): SlaBlueprint {
  return {
    ...blueprint,
    priorityMatrix: blueprint.priorityMatrix.map((row) => ({ ...row })),
    routingRules: [...blueprint.routingRules],
    firstResponseMacros: [...blueprint.firstResponseMacros],
    shiftCadence: [...blueprint.shiftCadence],
    breachWatchSignals: [...blueprint.breachWatchSignals]
  };
}

function createBlueprintCacheKey(input: SlaWorkspaceInput): string {
  return JSON.stringify({
    teamName: normalizeCacheText(input.teamName),
    helpdeskPlatform: normalizeCacheText(input.helpdeskPlatform),
    primaryQueue: normalizeCacheText(input.primaryQueue),
    slaTargetMinutes: input.slaTargetMinutes,
    monthlyTicketVolume: input.monthlyTicketVolume,
    breachRatePercent: input.breachRatePercent,
    timezone: normalizeCacheText(input.timezone),
    escalationCoverage: normalizeCacheText(input.escalationCoverage),
    highValueDefinition: normalizeCacheText(input.highValueDefinition),
    anthropicModel: ANTHROPIC_MODEL,
    openAiModel: OPENAI_MODEL
  });
}

function getCachedBlueprint(key: string): SlaBlueprint | null {
  const entry = blueprintCache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    blueprintCache.delete(key);
    return null;
  }

  blueprintCache.delete(key);
  blueprintCache.set(key, entry);
  return cloneBlueprint(entry.blueprint);
}

function setCachedBlueprint(key: string, blueprint: SlaBlueprint): void {
  if (
    !Number.isInteger(BLUEPRINT_CACHE_MAX_ENTRIES) ||
    BLUEPRINT_CACHE_MAX_ENTRIES <= 0 ||
    !Number.isInteger(BLUEPRINT_CACHE_TTL_MS) ||
    BLUEPRINT_CACHE_TTL_MS <= 0
  ) {
    return;
  }

  const now = Date.now();
  const entry: BlueprintCacheEntry = {
    cachedAt: now,
    expiresAt: now + BLUEPRINT_CACHE_TTL_MS,
    blueprint: cloneBlueprint(blueprint)
  };

  if (blueprintCache.has(key)) {
    blueprintCache.delete(key);
  }
  blueprintCache.set(key, entry);

  while (blueprintCache.size > BLUEPRINT_CACHE_MAX_ENTRIES) {
    const oldestKey = blueprintCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    blueprintCache.delete(oldestKey);
  }
}

function asObject(value: unknown, key: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid_${key}`);
  }
  return value as JsonObject;
}

function asNonEmptyString(value: unknown, key: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`invalid_${key}`);
  }
  const normalized = compactWhitespace(value);
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`invalid_${key}`);
  }
  return normalized;
}

function asOptionalString(value: unknown, key: string, maxLength: number): string | undefined {
  if (value == null) {
    return undefined;
  }
  return asNonEmptyString(value, key, maxLength);
}

function asOptionalMultilineString(value: unknown, key: string, maxLength: number): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid_${key}`);
  }
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`invalid_${key}`);
  }
  return normalized;
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

function sanitizeStringArray(value: unknown, key: string, minCount: number, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid_${key}`);
  }

  const items: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = compactWhitespace(raw);
    if (!normalized || normalized.length > maxLength) {
      continue;
    }
    items.push(normalized);
    if (items.length >= maxCount) {
      break;
    }
  }

  if (items.length < minCount) {
    throw new Error(`invalid_${key}`);
  }

  return items;
}

function parseModelJson(raw: string): unknown {
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("llm_invalid_json");
  }

  const candidate = raw.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("llm_invalid_json");
  }
}

function isRetryableLlmError(error: unknown): boolean {
  return error instanceof Error && /^llm_/.test(error.message);
}

function toLlmTransportError(provider: "anthropic" | "openai", error: unknown): Error {
  if (error instanceof Error && /^llm_/.test(error.message)) {
    return error;
  }

  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new Error(`llm_timeout_${provider}`);
  }

  return new Error(`llm_transport_${provider}`);
}

async function withLlmRetries(run: () => Promise<unknown>): Promise<unknown> {
  const attempts = Number.isInteger(LLM_MAX_ATTEMPTS) ? Math.max(1, Math.min(LLM_MAX_ATTEMPTS, 4)) : 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRetryableLlmError(error) || attempt >= attempts) {
        break;
      }
    }
  }

  throw lastError;
}

async function callAnthropic(prompt: string, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      }),
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)
    });
  } catch (error) {
    throw toLlmTransportError("anthropic", error);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`llm_http_${response.status}`);
  }

  let payload: AnthropicResponse;
  try {
    payload = JSON.parse(text) as AnthropicResponse;
  } catch {
    throw new Error("llm_invalid_response");
  }

  const combined = (payload.content || [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text || "")
    .join("\n")
    .trim();

  if (!combined) {
    throw new Error("llm_empty_response");
  }

  return parseModelJson(combined);
}

async function callOpenAi(prompt: string, apiKey: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: OPENAI_MAX_TOKENS,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You generate practical support-operations triage workflows. Return JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });
  } catch (error) {
    throw toLlmTransportError("openai", error);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`llm_http_${response.status}`);
  }

  let payload: OpenAiResponse;
  try {
    payload = JSON.parse(text) as OpenAiResponse;
  } catch {
    throw new Error("llm_invalid_response");
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("llm_empty_response");
  }

  return parseModelJson(content);
}

async function callModelWithFallback(prompt: string): Promise<unknown> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  let firstError: unknown;

  if (anthropicKey) {
    try {
      return await withLlmRetries(() => callAnthropic(prompt, anthropicKey));
    } catch (error) {
      firstError = error;
      if (!openAiKey) {
        throw error;
      }
    }
  }

  if (openAiKey) {
    try {
      return await withLlmRetries(() => callOpenAi(prompt, openAiKey));
    } catch (error) {
      if (firstError) {
        throw firstError;
      }
      throw error;
    }
  }

  throw new Error("llm_not_configured");
}

function isLlmError(error: unknown): boolean {
  return error instanceof Error && /^llm_/.test(error.message);
}

async function callModelWithGracefulFallback(prompt: string): Promise<unknown> {
  try {
    return await callModelWithFallback(prompt);
  } catch (error) {
    if (isLlmError(error)) {
      return {};
    }
    throw error;
  }
}

function sanitizePriority(priority: unknown): "P0" | "P1" | "P2" | "P3" {
  if (typeof priority !== "string") {
    throw new Error("invalid_priority");
  }
  const normalized = priority.trim().toUpperCase();
  if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
    return normalized;
  }
  throw new Error("invalid_priority");
}

function sanitizeRiskLevel(value: unknown): "low" | "medium" | "high" | "critical" {
  if (typeof value !== "string") {
    throw new Error("invalid_riskLevel");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical") {
    return normalized;
  }
  throw new Error("invalid_riskLevel");
}

function sanitizeCustomerTier(value: unknown, key = "customerTier"): "standard" | "priority" | "enterprise" {
  const normalized = asOptionalString(value, key, 20)?.toLowerCase() || "standard";
  if (normalized === "standard" || normalized === "priority" || normalized === "enterprise") {
    return normalized;
  }
  throw new Error(`invalid_${key}`);
}

function sanitizeChannel(value: unknown, key = "channel"): "email" | "chat" | "phone" | "api" {
  const normalized = asOptionalString(value, key, 20)?.toLowerCase() || "email";
  if (normalized === "email" || normalized === "chat" || normalized === "phone" || normalized === "api") {
    return normalized;
  }
  throw new Error(`invalid_${key}`);
}

function fallbackPriorityMatrix(input: SlaWorkspaceInput): PriorityMatrixRow[] {
  const p0Target = Math.max(1, Math.min(15, Math.floor(input.slaTargetMinutes * 0.25)));
  const p1Target = Math.max(p0Target + 1, Math.min(30, Math.floor(input.slaTargetMinutes * 0.5)));
  const p2Target = Math.max(p1Target + 1, Math.min(60, input.slaTargetMinutes));
  const p3Target = Math.max(p2Target + 1, Math.min(180, input.slaTargetMinutes * 2));

  return [
    {
      priority: "P0",
      trigger: `SLA already breached or ${input.highValueDefinition} with outage-level impact`,
      targetResponseMinutes: p0Target,
      escalationPath: `Immediately page on-call lead and ${input.escalationCoverage}`
    },
    {
      priority: "P1",
      trigger: `Breach risk under ${Math.max(10, p1Target)} minutes with multi-customer impact`,
      targetResponseMinutes: p1Target,
      escalationPath: `Escalate to ${input.primaryQueue} lead and duty manager`
    },
    {
      priority: "P2",
      trigger: "Breach risk later in current shift or single-customer high friction",
      targetResponseMinutes: p2Target,
      escalationPath: "Assign to tier-2 owner with hourly status checkpoints"
    },
    {
      priority: "P3",
      trigger: "No immediate breach risk and low customer impact",
      targetResponseMinutes: p3Target,
      escalationPath: "Keep in backlog with next-shift review"
    }
  ];
}

function sanitizePriorityMatrixWithFallback(value: unknown, input: SlaWorkspaceInput): PriorityMatrixRow[] {
  try {
    return sanitizePriorityMatrix(value);
  } catch {
    return fallbackPriorityMatrix(input);
  }
}

function sanitizeStringArrayWithFallback(
  value: unknown,
  key: string,
  minCount: number,
  maxCount: number,
  maxLength: number,
  fallback: string[]
): string[] {
  let entries: string[] = [];
  try {
    entries = sanitizeStringArray(value, key, 1, maxCount, maxLength);
  } catch {
    entries = [];
  }

  for (const candidate of fallback) {
    if (entries.length >= minCount) {
      break;
    }
    const normalized = compactWhitespace(candidate);
    if (!normalized || normalized.length > maxLength || entries.includes(normalized)) {
      continue;
    }
    entries.push(normalized);
  }

  return entries.slice(0, maxCount);
}

function fallbackPriority(minutesUntilBreach: number): "P0" | "P1" | "P2" | "P3" {
  if (minutesUntilBreach <= 0) {
    return "P0";
  }
  if (minutesUntilBreach <= 20) {
    return "P1";
  }
  if (minutesUntilBreach <= 90) {
    return "P2";
  }
  return "P3";
}

function fallbackRisk(priority: "P0" | "P1" | "P2" | "P3"): "low" | "medium" | "high" | "critical" {
  if (priority === "P0") {
    return "critical";
  }
  if (priority === "P1") {
    return "high";
  }
  if (priority === "P2") {
    return "medium";
  }
  return "low";
}

function sanitizePriorityMatrix(value: unknown): PriorityMatrixRow[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid_priorityMatrix");
  }

  const rows: PriorityMatrixRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const item = raw as JsonObject;
    rows.push({
      priority: sanitizePriority(item.priority),
      trigger: asNonEmptyString(item.trigger, "priorityMatrix_trigger", 220),
      targetResponseMinutes: asInteger(item.targetResponseMinutes, "priorityMatrix_targetResponseMinutes", 1, 480),
      escalationPath: asNonEmptyString(item.escalationPath, "priorityMatrix_escalationPath", 220)
    });
    if (rows.length >= 6) {
      break;
    }
  }

  if (rows.length < 3) {
    throw new Error("invalid_priorityMatrix");
  }

  return rows;
}

function buildBlueprintPrompt(input: SlaWorkspaceInput): string {
  return [
    "Return strict JSON only.",
    "Design an SLA breach triage operating blueprint for a support team.",
    "Schema:",
    `{
  "summary": "string",
  "priorityMatrix": [
    {
      "priority": "P0|P1|P2|P3",
      "trigger": "when to apply",
      "targetResponseMinutes": 15,
      "escalationPath": "who gets paged"
    }
  ],
  "routingRules": ["rule"],
  "firstResponseMacros": ["macro text"],
  "shiftCadence": ["operating cadence item"],
  "breachWatchSignals": ["leading indicator"],
  "managerBrief": "short brief for support manager"
}`,
    "Requirements:",
    "- Optimize for preventing SLA breaches under queue pressure.",
    "- Include concrete ownership actions, not generic advice.",
    "- Assume this is recurring daily operations, not a one-off incident.",
    "Workspace context:",
    JSON.stringify(input, null, 2)
  ].join("\n\n");
}

function buildDecisionPrompt(
  input: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  ticket: TicketTriageInput
): string {
  return [
    "Return strict JSON only.",
    "You are triaging one support ticket for SLA risk.",
    "Schema:",
    `{
  "priority": "P0|P1|P2|P3",
  "riskLevel": "low|medium|high|critical",
  "reason": "why this priority was chosen",
  "recommendedOwner": "role or queue owner",
  "firstResponse": "first response message to send now",
  "nextActions": ["ordered next action"],
  "escalateNow": true,
  "escalationMessage": "message to escalation channel"
}`,
    "Requirements:",
    "- Use the workspace blueprint and SLA window to decide urgency.",
    "- firstResponse must be directly sendable to customer.",
    "- nextActions must be concrete and immediately executable.",
    "Workspace:",
    JSON.stringify(input, null, 2),
    "Blueprint:",
    JSON.stringify(blueprint, null, 2),
    "Ticket:",
    JSON.stringify(ticket, null, 2)
  ].join("\n\n");
}

function buildDailyCommandPrompt(input: SlaWorkspaceInput, queueSnapshot: string, maxTickets: number): string {
  return [
    "Return strict JSON only.",
    "You are running an SLA daily command for a support operations manager.",
    "Review the queue snapshot and prioritize at-risk tickets for this shift.",
    "Schema:",
    `{
  "shiftHeadline": "single-sentence command for the next 60 minutes",
  "queueSummary": "short summary of current queue risk",
  "immediateActions": ["ordered action to run now"],
  "actionBoard": {
    "criticalCount": 1,
    "escalationNowCount": 2,
    "nextSweepInMinutes": 10,
    "ownerCheckpoints": ["owner checkpoint line"]
  },
  "tickets": [
    {
      "ticketId": "string",
      "subject": "string",
      "customerTier": "standard|priority|enterprise",
      "minutesUntilBreach": 20,
      "backlogAgeMinutes": 180,
      "currentOwner": "owner",
      "channel": "email|chat|phone|api",
      "priority": "P0|P1|P2|P3",
      "riskLevel": "low|medium|high|critical",
      "reason": "short justification",
      "immediateAction": "next action for owner",
      "escalateNow": true
    }
  ]
}`,
    "Requirements:",
    `- Return between 1 and ${maxTickets} tickets.`,
    "- Prioritize must-do actions for this shift, not generic policy.",
    "- Keep each reason and immediateAction specific and executable.",
    "- ownerCheckpoints must be concrete, named follow-ups for the next sweep.",
    "Workspace defaults:",
    JSON.stringify(input, null, 2),
    "Queue snapshot from user:",
    queueSnapshot
  ].join("\n\n");
}

function buildDailyDigestPrompt(
  workspace: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  decisions: CompliancePacketDecision[]
): string {
  return [
    "Return strict JSON only.",
    "Generate a recurring SLA operations digest for support leadership.",
    "Schema:",
    `{
  "headline": "single-sentence status headline",
  "summary": "short operational summary for this shift/day",
  "topRisks": ["risk statement"],
  "ownerFollowups": ["owner + next update checkpoint"],
  "nextShiftPlan": ["specific next shift action"]
}`,
    "Requirements:",
    "- Keep the digest concise and operational, not generic advice.",
    "- If decisions are present, reference concrete owner accountability.",
    "- If decisions are empty, clearly state what data is missing and what to run next.",
    "Workspace:",
    JSON.stringify(workspace, null, 2),
    "Blueprint:",
    JSON.stringify(blueprint, null, 2),
    "Recent decisions:",
    JSON.stringify(decisions, null, 2)
  ].join("\n\n");
}

function buildCompliancePacketPrompt(
  workspace: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  decisions: CompliancePacketDecision[]
): string {
  return [
    "Return strict JSON only.",
    "Create a customer-shareable SLA compliance packet in markdown.",
    "Schema:",
    `{
  "packetMarkdown": "full markdown content"
}`,
    "Requirements:",
    "- Include sections: Executive Summary, Triage Decisions, Owner Accountability, Next Shift Controls.",
    "- Keep language concrete and tied to provided decisions/blueprint.",
    "- Avoid placeholders and avoid generic boilerplate.",
    "Workspace:",
    JSON.stringify(workspace, null, 2),
    "Blueprint:",
    JSON.stringify(blueprint, null, 2),
    "Recent decisions:",
    JSON.stringify(decisions, null, 2)
  ].join("\n\n");
}

function sanitizeIntegerWithFallback(
  value: unknown,
  key: string,
  min: number,
  max: number,
  fallback: number
): number {
  try {
    return asInteger(value, key, min, max);
  } catch {
    return fallback;
  }
}

function inferTicketIdFromLine(line: string, index: number): string {
  const ticketIdMatch = line.match(/\b([A-Z][A-Z0-9]{1,10}-\d{1,8})\b/);
  if (ticketIdMatch?.[1]) {
    return ticketIdMatch[1];
  }

  const leadingToken = line.match(/^[#*\-\s]*([A-Za-z0-9][A-Za-z0-9_.-]{1,20})/);
  if (leadingToken?.[1]) {
    return leadingToken[1].toUpperCase();
  }

  return `TKT-${index + 1}`;
}

function inferMinutesFromLine(line: string, fallback: number): number {
  const timedMatch = line.match(/(-?\d{1,4})\s*(?:m|min|mins|minute|minutes)\b/i);
  if (timedMatch?.[1]) {
    const parsed = Number.parseInt(timedMatch[1], 10);
    if (Number.isInteger(parsed) && parsed >= -1440 && parsed <= 10080) {
      return parsed;
    }
  }

  const numericMatch = line.match(/\b(-?\d{1,4})\b/);
  if (numericMatch?.[1]) {
    const parsed = Number.parseInt(numericMatch[1], 10);
    if (Number.isInteger(parsed) && parsed >= -1440 && parsed <= 10080) {
      return parsed;
    }
  }

  return fallback;
}

function inferBacklogAge(line: string, fallback: number): number {
  const backlogMatch = line.match(/(?:backlog|age|waiting)[^\d-]*(-?\d{1,4})/i);
  if (backlogMatch?.[1]) {
    const parsed = Number.parseInt(backlogMatch[1], 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10080) {
      return parsed;
    }
  }
  return fallback;
}

function inferOwnerFromLine(line: string): string {
  const ownerMatch = line.match(/(?:owner|assignee|queue)\s*[:=]\s*([a-zA-Z0-9_.-]{2,60})/i);
  if (ownerMatch?.[1]) {
    return ownerMatch[1];
  }
  return "duty-manager";
}

function inferCustomerTier(line: string): "standard" | "priority" | "enterprise" {
  const lower = line.toLowerCase();
  if (lower.includes("enterprise") || lower.includes("vip") || lower.includes("contract")) {
    return "enterprise";
  }
  if (lower.includes("priority") || lower.includes("premium")) {
    return "priority";
  }
  return "standard";
}

function inferChannel(line: string): "email" | "chat" | "phone" | "api" {
  const lower = line.toLowerCase();
  if (lower.includes("chat")) {
    return "chat";
  }
  if (lower.includes("phone") || lower.includes("call")) {
    return "phone";
  }
  if (lower.includes("api")) {
    return "api";
  }
  return "email";
}

function parseQueueSnapshotFallback(queueSnapshot: string, maxTickets: number): DailyCommandTicket[] {
  const lines = queueSnapshot
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean)
    .slice(0, maxTickets);

  if (!lines.length) {
    lines.push("enterprise billing issue 15m to SLA owner=tier-2-billing");
  }

  return lines.map((line, index) => {
    const minutesUntilBreach = inferMinutesFromLine(line, 45 + index * 20);
    const backlogAgeMinutes = inferBacklogAge(line, Math.min(10080, Math.max(30, minutesUntilBreach * 3)));
    const customerTier = inferCustomerTier(line);
    const priority = fallbackPriority(minutesUntilBreach);
    const riskLevel = fallbackRisk(priority);

    return {
      ticketId: inferTicketIdFromLine(line, index),
      subject: line.slice(0, 180),
      customerTier,
      minutesUntilBreach,
      backlogAgeMinutes,
      currentOwner: inferOwnerFromLine(line),
      channel: inferChannel(line),
      priority,
      riskLevel,
      reason: `Queue snapshot indicates ${priority} risk due to SLA timing and described customer impact.`,
      immediateAction:
        priority === "P0" || priority === "P1"
          ? "Acknowledge immediately, reassign to active responder, and post escalation update."
          : "Confirm owner, add next update ETA, and review again in the next queue sweep.",
      escalateNow: priority === "P0" || priority === "P1"
    };
  });
}

function buildFallbackActionBoard(
  tickets: DailyCommandTicket[],
  primaryQueue: string,
  defaultSweepMinutes = 15
): DailyCommandActionBoard {
  const criticalCount = tickets.filter((ticket) => ticket.riskLevel === "critical").length;
  const escalationNowCount = tickets.filter((ticket) => ticket.escalateNow).length;
  const minPositiveBreach = tickets
    .map((ticket) => ticket.minutesUntilBreach)
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0)
    .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);

  const nextSweepInMinutes = Number.isFinite(minPositiveBreach)
    ? Math.max(5, Math.min(defaultSweepMinutes, Math.floor(minPositiveBreach / 2)))
    : defaultSweepMinutes;

  const ownerCheckpoints = tickets.slice(0, 4).map((ticket) => {
    const breachMinutes = ticket.minutesUntilBreach <= 0 ? "breached" : `${ticket.minutesUntilBreach}m`;
    return `${ticket.currentOwner}: ${ticket.ticketId} (${ticket.priority}, ${breachMinutes}) -> ${ticket.immediateAction}`;
  });

  if (!ownerCheckpoints.length) {
    ownerCheckpoints.push(
      `duty-manager: run immediate ${primaryQueue} queue sweep and assign owners for every ticket under 30 minutes to breach.`
    );
  }

  return {
    criticalCount,
    escalationNowCount,
    nextSweepInMinutes,
    ownerCheckpoints
  };
}

function buildFallbackDailyCommandOutput(
  input: SlaWorkspaceInput,
  queueSnapshot: string,
  maxTickets: number
): DailyCommandOutput {
  const tickets = parseQueueSnapshotFallback(queueSnapshot, maxTickets);
  const p0Count = tickets.filter((ticket) => ticket.priority === "P0").length;
  const p1Count = tickets.filter((ticket) => ticket.priority === "P1").length;
  const highestMinutes = tickets.reduce((current, ticket) => Math.min(current, ticket.minutesUntilBreach), 10080);

  const immediateActions = [
    `Run a ${input.primaryQueue} sweep now and confirm owners for every ticket under 30 minutes to breach.`,
    "Post one escalation update in the team channel with named owners and next-update ETAs.",
    "Schedule the next risk sweep in 15 minutes and carry unresolved P1/P0 tickets forward."
  ];

  return {
    generatedAt: new Date().toISOString(),
    shiftHeadline: `Stabilize ${input.primaryQueue} now: ${p0Count} P0 and ${p1Count} P1 risks with lowest breach window at ${highestMinutes} minutes.`,
    queueSummary: `Snapshot indicates immediate SLA pressure on ${tickets.length} at-risk tickets for ${input.teamName}.`,
    immediateActions,
    tickets,
    actionBoard: buildFallbackActionBoard(tickets, input.primaryQueue)
  };
}

function sanitizeDailyCommandTicketPayload(value: unknown, fallbackTicket: DailyCommandTicket): DailyCommandTicket {
  let obj: JsonObject = {};
  try {
    obj = asObject(value, "dailyCommandTicket");
  } catch {
    return { ...fallbackTicket };
  }

  const ticketId = asOptionalString(obj.ticketId, "ticketId", 120) || fallbackTicket.ticketId;
  const subject = asOptionalString(obj.subject, "subject", 220) || fallbackTicket.subject;
  const customerTier = (() => {
    try {
      return sanitizeCustomerTier(obj.customerTier, "customerTier");
    } catch {
      return fallbackTicket.customerTier;
    }
  })();
  const channel = (() => {
    try {
      return sanitizeChannel(obj.channel, "channel");
    } catch {
      return fallbackTicket.channel;
    }
  })();
  const currentOwner = asOptionalString(obj.currentOwner, "currentOwner", 120) || fallbackTicket.currentOwner;
  const minutesUntilBreach = sanitizeIntegerWithFallback(
    obj.minutesUntilBreach,
    "minutesUntilBreach",
    -1440,
    10080,
    fallbackTicket.minutesUntilBreach
  );
  const backlogAgeMinutes = sanitizeIntegerWithFallback(
    obj.backlogAgeMinutes,
    "backlogAgeMinutes",
    0,
    10080,
    fallbackTicket.backlogAgeMinutes
  );

  const priority = (() => {
    try {
      return sanitizePriority(obj.priority);
    } catch {
      return fallbackPriority(minutesUntilBreach);
    }
  })();
  const riskLevel = (() => {
    try {
      return sanitizeRiskLevel(obj.riskLevel);
    } catch {
      return fallbackRisk(priority);
    }
  })();
  const reason =
    asOptionalString(obj.reason, "reason", 600) ||
    `Ticket ${ticketId} is prioritized as ${priority} based on SLA timing and queue impact.`;
  const immediateAction =
    asOptionalString(obj.immediateAction, "immediateAction", 320) || fallbackTicket.immediateAction;
  const escalateNow = typeof obj.escalateNow === "boolean" ? obj.escalateNow : priority === "P0" || priority === "P1";

  return {
    ticketId,
    subject,
    customerTier,
    minutesUntilBreach,
    backlogAgeMinutes,
    currentOwner,
    channel,
    priority,
    riskLevel,
    reason,
    immediateAction,
    escalateNow
  };
}

function sanitizeDailyCommandActionBoard(
  value: unknown,
  fallback: DailyCommandActionBoard
): DailyCommandActionBoard {
  let obj: JsonObject = {};
  try {
    obj = asObject(value, "actionBoard");
  } catch {
    return { ...fallback, ownerCheckpoints: [...fallback.ownerCheckpoints] };
  }

  const criticalCount = sanitizeIntegerWithFallback(obj.criticalCount, "criticalCount", 0, 100000, fallback.criticalCount);
  const escalationNowCount = sanitizeIntegerWithFallback(
    obj.escalationNowCount,
    "escalationNowCount",
    0,
    100000,
    fallback.escalationNowCount
  );
  const nextSweepInMinutes = sanitizeIntegerWithFallback(
    obj.nextSweepInMinutes,
    "nextSweepInMinutes",
    5,
    240,
    fallback.nextSweepInMinutes
  );
  const ownerCheckpoints = sanitizeStringArrayWithFallback(
    obj.ownerCheckpoints,
    "ownerCheckpoints",
    2,
    8,
    260,
    fallback.ownerCheckpoints
  );

  return {
    criticalCount,
    escalationNowCount,
    nextSweepInMinutes,
    ownerCheckpoints
  };
}

function sanitizeDailyCommandPayload(
  payload: unknown,
  input: SlaWorkspaceInput,
  queueSnapshot: string,
  maxTickets: number
): DailyCommandOutput {
  const fallback = buildFallbackDailyCommandOutput(input, queueSnapshot, maxTickets);

  let obj: JsonObject = {};
  try {
    obj = asObject(payload, "dailyCommand");
  } catch {
    return fallback;
  }

  const shiftHeadline = asOptionalString(obj.shiftHeadline, "shiftHeadline", 260) || fallback.shiftHeadline;
  const queueSummary = asOptionalString(obj.queueSummary, "queueSummary", 700) || fallback.queueSummary;
  const immediateActions = sanitizeStringArrayWithFallback(
    obj.immediateActions,
    "immediateActions",
    2,
    8,
    240,
    fallback.immediateActions
  );

  let tickets: DailyCommandTicket[] = [];
  if (Array.isArray(obj.tickets)) {
    for (let index = 0; index < obj.tickets.length && tickets.length < maxTickets; index += 1) {
      const fallbackTicket = fallback.tickets[Math.min(index, fallback.tickets.length - 1)];
      const ticket = sanitizeDailyCommandTicketPayload(obj.tickets[index], fallbackTicket);
      tickets.push(ticket);
    }
  }

  if (!tickets.length) {
    tickets = fallback.tickets;
  }

  const fallbackActionBoard = buildFallbackActionBoard(tickets, input.primaryQueue);
  const actionBoard = sanitizeDailyCommandActionBoard(obj.actionBoard, fallbackActionBoard);

  return {
    generatedAt: new Date().toISOString(),
    shiftHeadline,
    queueSummary,
    immediateActions,
    tickets,
    actionBoard
  };
}

function buildFallbackDailyDigest(
  workspace: SlaWorkspaceInput,
  decisions: CompliancePacketDecision[]
): DailyDigestOutput {
  const activeDecisions = decisions.slice(-5);
  const topRisks = activeDecisions
    .filter((decision) => decision.priority === "P0" || decision.priority === "P1")
    .slice(0, 4)
    .map(
      (decision) =>
        `${decision.ticketId} (${decision.priority}/${decision.riskLevel}) owned by ${decision.recommendedOwner}: ${decision.reason}`
    );
  if (!topRisks.length) {
    topRisks.push(
      `No triage decisions captured yet for ${workspace.primaryQueue}. Run today's at-risk queue command to generate decision evidence.`
    );
  }

  const ownerFollowups = activeDecisions
    .slice(0, 4)
    .map(
      (decision) =>
        `${decision.recommendedOwner}: next update for ${decision.ticketId} should include owner ETA and escalation checkpoint.`
    );
  if (!ownerFollowups.length) {
    ownerFollowups.push("duty-manager: assign named owners to all high-risk tickets before the next queue sweep.");
    ownerFollowups.push("queue-lead: publish an escalation checkpoint message for any ticket under 30 minutes to breach.");
  }

  const nextShiftPlan = [
    `Run the first ${workspace.primaryQueue} risk sweep at shift start and confirm ownership on all P0/P1 tickets.`,
    "Require a timed escalation checkpoint update in the team channel every 15 minutes for unresolved risks.",
    "Close shift with an explicit owner handoff list for open critical tickets."
  ];

  return {
    generatedAt: new Date().toISOString(),
    headline: `${workspace.teamName} SLA risk digest: ${topRisks.length} immediate risk signal(s) requiring owner follow-up.`,
    summary: `Digest generated from ${activeDecisions.length} recent decision(s) in ${workspace.primaryQueue}.`,
    topRisks,
    ownerFollowups,
    nextShiftPlan
  };
}

function sanitizeDailyDigestPayload(
  payload: unknown,
  workspace: SlaWorkspaceInput,
  decisions: CompliancePacketDecision[]
): DailyDigestOutput {
  const fallback = buildFallbackDailyDigest(workspace, decisions);

  let obj: JsonObject = {};
  try {
    obj = asObject(payload, "dailyDigest");
  } catch {
    return fallback;
  }

  const headline = asOptionalString(obj.headline, "headline", 280) || fallback.headline;
  const summary = asOptionalString(obj.summary, "summary", 900) || fallback.summary;
  const topRisks = sanitizeStringArrayWithFallback(obj.topRisks, "topRisks", 1, 8, 320, fallback.topRisks);
  const ownerFollowups = sanitizeStringArrayWithFallback(
    obj.ownerFollowups,
    "ownerFollowups",
    2,
    8,
    320,
    fallback.ownerFollowups
  );
  const nextShiftPlan = sanitizeStringArrayWithFallback(
    obj.nextShiftPlan,
    "nextShiftPlan",
    2,
    8,
    320,
    fallback.nextShiftPlan
  );

  return {
    generatedAt: new Date().toISOString(),
    headline,
    summary,
    topRisks,
    ownerFollowups,
    nextShiftPlan
  };
}

function buildFallbackCompliancePacket(
  workspace: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  decisions: CompliancePacketDecision[]
): string {
  const latestDecisions = decisions.slice(-8);
  const ticketLines =
    latestDecisions.length > 0
      ? latestDecisions
          .map(
            (decision) =>
              `- **${decision.ticketId}** (${decision.priority}/${decision.riskLevel}) owned by ${decision.recommendedOwner}: ${decision.reason}`
          )
          .join("\n")
      : "- No ticket decisions recorded yet. Run ticket triage to generate compliance evidence.";

  return [
    `# SLA Compliance Packet`,
    ``,
    `## Executive Summary`,
    `${workspace.teamName} is operating ${workspace.primaryQueue} with a ${workspace.slaTargetMinutes}-minute SLA target.`,
    ``,
    `## Triage Decisions`,
    ticketLines,
    ``,
    `## Owner Accountability`,
    `- Primary queue: ${workspace.primaryQueue}`,
    `- Escalation coverage: ${workspace.escalationCoverage}`,
    `- High-value customer definition: ${workspace.highValueDefinition}`,
    ``,
    `## Next Shift Controls`,
    ...blueprint.shiftCadence.slice(0, 3).map((item) => `- ${item}`)
  ].join("\n");
}

function sanitizeCompliancePacketPayload(
  payload: unknown,
  workspace: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  decisions: CompliancePacketDecision[]
): string {
  const fallback = buildFallbackCompliancePacket(workspace, blueprint, decisions);

  let obj: JsonObject = {};
  try {
    obj = asObject(payload, "compliancePacket");
  } catch {
    return fallback;
  }

  return asOptionalMultilineString(obj.packetMarkdown, "packetMarkdown", 28000) || fallback;
}

function sanitizeBlueprintPayload(payload: unknown, input: SlaWorkspaceInput): SlaBlueprint {
  const obj = asObject(payload, "blueprint");
  const summaryRaw = asOptionalString(obj.summary, "summary", 700);
  const summary = summaryRaw || `SLA triage blueprint for ${input.teamName} on ${input.helpdeskPlatform} ${input.primaryQueue}.`;

  const routingFallback = [
    `Auto-route ${input.highValueDefinition} tickets to senior queue owner within 5 minutes.`,
    `Reassign any ticket with under ${Math.max(10, Math.floor(input.slaTargetMinutes * 0.5))} minutes to breach to active responder.`,
    `Escalate queue spikes above ${Math.max(20, Math.floor(input.monthlyTicketVolume / 40))} open items to duty manager.`
  ];
  const macroFallback = [
    "We are actively working on your request and have moved it to our priority response queue. Next update is within your SLA window.",
    "Thanks for reporting this. I have escalated to the owning team now and will post a concrete ETA in this thread shortly."
  ];
  const cadenceFallback = [
    "Run 15-minute breach-risk sweep at the start of each shift.",
    "Hold an end-of-shift handoff with unresolved P1/P2 tickets and explicit owner assignment."
  ];
  const signalFallback = [
    "Tickets under 30 minutes to breach without owner response.",
    "Backlog age above one SLA cycle in the primary queue.",
    "Repeated customer follow-ups on high-value accounts."
  ];
  const managerBriefRaw = asOptionalString(obj.managerBrief, "managerBrief", 1000);

  return {
    generatedAt: new Date().toISOString(),
    summary,
    priorityMatrix: sanitizePriorityMatrixWithFallback(obj.priorityMatrix, input),
    routingRules: sanitizeStringArrayWithFallback(obj.routingRules, "routingRules", 3, 10, 240, routingFallback),
    firstResponseMacros: sanitizeStringArrayWithFallback(
      obj.firstResponseMacros,
      "firstResponseMacros",
      2,
      8,
      420,
      macroFallback
    ),
    shiftCadence: sanitizeStringArrayWithFallback(obj.shiftCadence, "shiftCadence", 2, 8, 240, cadenceFallback),
    breachWatchSignals: sanitizeStringArrayWithFallback(
      obj.breachWatchSignals,
      "breachWatchSignals",
      3,
      10,
      240,
      signalFallback
    ),
    managerBrief:
      managerBriefRaw ||
      `Queue health is ${input.breachRatePercent}% breaches against a ${input.slaTargetMinutes}-minute SLA target. Use this blueprint for daily triage reviews and owner accountability.`
  };
}

function sanitizeDecisionPayload(payload: unknown, ticket: TicketTriageInput): TicketDecision {
  let obj: JsonObject = {};
  try {
    obj = asObject(payload, "decision");
  } catch {
    obj = {};
  }

  let priority: "P0" | "P1" | "P2" | "P3";
  try {
    priority = sanitizePriority(obj.priority);
  } catch {
    priority = fallbackPriority(ticket.minutesUntilBreach);
  }

  if (ticket.minutesUntilBreach <= 0) {
    priority = "P0";
  } else if (ticket.minutesUntilBreach <= 15 && (priority === "P2" || priority === "P3")) {
    priority = "P1";
  } else if (
    ticket.customerTier === "enterprise" &&
    ticket.minutesUntilBreach <= 30 &&
    (priority === "P2" || priority === "P3")
  ) {
    priority = "P1";
  }

  let riskLevel: "low" | "medium" | "high" | "critical";
  try {
    riskLevel = sanitizeRiskLevel(obj.riskLevel);
  } catch {
    riskLevel = fallbackRisk(priority);
  }

  if (priority === "P0" && riskLevel !== "critical") {
    riskLevel = "critical";
  } else if (priority === "P1" && (riskLevel === "low" || riskLevel === "medium")) {
    riskLevel = "high";
  }

  const reasonRaw = asOptionalString(obj.reason, "reason", 600);
  const ownerRaw = asOptionalString(obj.recommendedOwner, "recommendedOwner", 160);
  const firstResponseRaw = asOptionalString(obj.firstResponse, "firstResponse", 900);
  const escalationMessageRaw = asOptionalString(obj.escalationMessage, "escalationMessage", 700);
  const nextActions = sanitizeStringArrayWithFallback(obj.nextActions, "nextActions", 2, 8, 220, [
    `Acknowledge ticket ${ticket.ticketId} and confirm ownership in queue.`,
    "Set a concrete next update deadline inside the SLA window."
  ]);
  const shouldEscalate = typeof obj.escalateNow === "boolean" ? obj.escalateNow : priority === "P0" || priority === "P1";

  return {
    generatedAt: new Date().toISOString(),
    priority,
    riskLevel,
    reason: reasonRaw || `Ticket ${ticket.ticketId} is prioritized as ${priority} based on SLA timing and customer impact.`,
    recommendedOwner: ownerRaw || ticket.currentOwner,
    firstResponse:
      firstResponseRaw ||
      "Thanks for the report. I am taking ownership now and have escalated to the responsible team. I will send the next update shortly.",
    nextActions,
    escalateNow: shouldEscalate,
    escalationMessage:
      escalationMessageRaw ||
      `Escalation required for ${ticket.ticketId}: ${ticket.subject}. Priority ${priority}, ${ticket.minutesUntilBreach} minutes to SLA breach.`
  };
}

export function sanitizeWorkspaceInput(payload: JsonObject): SlaWorkspaceInput {
  return {
    teamName: asNonEmptyString(payload.teamName, "teamName", 120),
    helpdeskPlatform: asNonEmptyString(payload.helpdeskPlatform, "helpdeskPlatform", 80),
    primaryQueue: asNonEmptyString(payload.primaryQueue, "primaryQueue", 100),
    slaTargetMinutes: asInteger(payload.slaTargetMinutes, "slaTargetMinutes", 5, 240),
    monthlyTicketVolume: asInteger(payload.monthlyTicketVolume, "monthlyTicketVolume", 1, 500000),
    breachRatePercent: asNumber(payload.breachRatePercent, "breachRatePercent", 0, 100),
    timezone: asOptionalString(payload.timezone, "timezone", 80) || "UTC",
    escalationCoverage: asNonEmptyString(payload.escalationCoverage, "escalationCoverage", 160),
    highValueDefinition: asNonEmptyString(payload.highValueDefinition, "highValueDefinition", 180)
  };
}

export function sanitizeTicketInput(payload: JsonObject): TicketTriageInput {
  return {
    ticketId: asNonEmptyString(payload.ticketId, "ticketId", 120),
    subject: asNonEmptyString(payload.subject, "subject", 220),
    summary: asNonEmptyString(payload.summary, "summary", 2200),
    customerTier: sanitizeCustomerTier(payload.customerTier),
    minutesUntilBreach: asInteger(payload.minutesUntilBreach, "minutesUntilBreach", -1440, 10080),
    backlogAgeMinutes: asInteger(payload.backlogAgeMinutes, "backlogAgeMinutes", 0, 10080),
    currentOwner: asNonEmptyString(payload.currentOwner, "currentOwner", 120),
    channel: sanitizeChannel(payload.channel)
  };
}

export async function buildSlaBlueprint(input: SlaWorkspaceInput): Promise<SlaBlueprint> {
  const cacheKey = createBlueprintCacheKey(input);
  const cached = getCachedBlueprint(cacheKey);
  if (cached) {
    return cached;
  }

  const prompt = buildBlueprintPrompt(input);
  const payload = await callModelWithGracefulFallback(prompt);
  const blueprint = sanitizeBlueprintPayload(payload, input);
  setCachedBlueprint(cacheKey, blueprint);
  return cloneBlueprint(blueprint);
}

export async function buildTicketDecision(
  workspace: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  ticket: TicketTriageInput
): Promise<TicketDecision> {
  const prompt = buildDecisionPrompt(workspace, blueprint, ticket);
  const payload = await callModelWithGracefulFallback(prompt);
  return sanitizeDecisionPayload(payload, ticket);
}

export async function buildDailyCommand(
  workspace: SlaWorkspaceInput,
  queueSnapshot: string,
  maxTickets = 4
): Promise<DailyCommandOutput> {
  const normalizedSnapshot = compactWhitespace(queueSnapshot).slice(0, 9000);
  if (!normalizedSnapshot) {
    throw new Error("invalid_queueSnapshot");
  }

  const boundedMaxTickets = Number.isInteger(maxTickets) ? Math.max(1, Math.min(maxTickets, 8)) : 4;
  const prompt = buildDailyCommandPrompt(workspace, queueSnapshot.trim().slice(0, 9000), boundedMaxTickets);
  const payload = await callModelWithGracefulFallback(prompt);
  return sanitizeDailyCommandPayload(payload, workspace, queueSnapshot, boundedMaxTickets);
}

export async function buildDailyDigest(
  workspace: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  decisions: CompliancePacketDecision[]
): Promise<DailyDigestOutput> {
  const prompt = buildDailyDigestPrompt(workspace, blueprint, decisions.slice(-20));
  const payload = await callModelWithGracefulFallback(prompt);
  return sanitizeDailyDigestPayload(payload, workspace, decisions);
}

export async function buildCompliancePacket(
  workspace: SlaWorkspaceInput,
  blueprint: SlaBlueprint,
  decisions: CompliancePacketDecision[]
): Promise<string> {
  const prompt = buildCompliancePacketPrompt(workspace, blueprint, decisions.slice(-20));
  const payload = await callModelWithGracefulFallback(prompt);
  return sanitizeCompliancePacketPayload(payload, workspace, blueprint, decisions);
}
