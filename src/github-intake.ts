export type GithubIssuesImportResult = {
  queueSnapshot: string;
  parsedIssues: number;
  selectedIssues: number;
  droppedIssues: number;
  issueNumbers: number[];
};

type JsonObject = Record<string, unknown>;

type ParsedIssue = {
  issueNumber: number;
  title: string;
  customerTier: "standard" | "priority" | "enterprise";
  minutesUntilBreach: number;
  backlogAgeMinutes: number;
  owner: string;
  channel: "api";
};

const MAX_LINE_LENGTH = 360;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return timestamp;
}

function sanitizeOwner(value: string): string {
  const normalized = compactWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return "unassigned";
  }
  return normalized.slice(0, 60);
}

function sanitizeTitle(value: string): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    return "GitHub issue requires immediate SLA review.";
  }
  return normalized.slice(0, 180);
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const labels: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const normalized = compactWhitespace(entry).toLowerCase();
      if (normalized) {
        labels.push(normalized);
      }
      continue;
    }

    const objectEntry = asObject(entry);
    const name = objectEntry && typeof objectEntry.name === "string" ? compactWhitespace(objectEntry.name).toLowerCase() : "";
    if (name) {
      labels.push(name);
    }
  }

  return labels;
}

function parseMinutesFromLabels(labels: string[]): number | null {
  for (const label of labels) {
    const match =
      label.match(/(?:^|[^a-z0-9])(?:sla|breach|due|target)[\s:_-]*(-?\d{1,4})\s*(?:m|min|mins|minute|minutes)?(?:$|[^a-z0-9])/i) ||
      label.match(/^(-?\d{1,4})\s*(?:m|min|mins|minute|minutes)$/i);
    if (!match?.[1]) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed)) {
      return clamp(parsed, -1440, 10080);
    }
  }
  return null;
}

function deriveCustomerTier(labels: string[], title: string, body: string): "standard" | "priority" | "enterprise" {
  const combined = `${labels.join(" ")} ${title} ${body}`.toLowerCase();
  if (
    combined.includes("enterprise") ||
    combined.includes("vip") ||
    combined.includes("contract") ||
    combined.includes("strategic")
  ) {
    return "enterprise";
  }
  if (
    combined.includes("priority") ||
    combined.includes("premium") ||
    combined.includes("high") ||
    combined.includes("urgent")
  ) {
    return "priority";
  }
  return "standard";
}

function baseMinutesFromSignals(labels: string[], title: string, body: string): number {
  const combined = `${labels.join(" ")} ${title} ${body}`.toLowerCase();

  if (/\bp0\b/.test(combined) || combined.includes("critical") || combined.includes("outage") || combined.includes("sev0")) {
    return 12;
  }
  if (
    /\bp1\b/.test(combined) ||
    combined.includes("urgent") ||
    combined.includes("sev1") ||
    combined.includes("high")
  ) {
    return 30;
  }
  if (/\bp2\b/.test(combined) || combined.includes("medium") || combined.includes("sev2")) {
    return 90;
  }
  if (/\bp3\b/.test(combined) || combined.includes("low")) {
    return 180;
  }
  return 150;
}

function deriveOwner(issue: JsonObject): string {
  const assignees = issue.assignees;
  if (Array.isArray(assignees)) {
    for (const assignee of assignees) {
      if (typeof assignee === "string") {
        const normalized = sanitizeOwner(assignee);
        if (normalized !== "unassigned") {
          return normalized;
        }
        continue;
      }

      const objectAssignee = asObject(assignee);
      const login =
        objectAssignee && typeof objectAssignee.login === "string" ? sanitizeOwner(objectAssignee.login) : "unassigned";
      if (login !== "unassigned") {
        return login;
      }
    }
  }

  const assignee = asObject(issue.assignee);
  const assigneeLogin = assignee && typeof assignee.login === "string" ? assignee.login : "";
  return sanitizeOwner(assigneeLogin);
}

function lineForIssue(issue: ParsedIssue): string {
  const line = `GH-${issue.issueNumber} | ${issue.customerTier} | ${issue.minutesUntilBreach}m to breach | backlog=${issue.backlogAgeMinutes}m | owner=${issue.owner} | channel=${issue.channel} | ${issue.title}`;
  return line.slice(0, MAX_LINE_LENGTH);
}

function parseIssuesCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const objectValue = asObject(value);
  if (objectValue && Array.isArray(objectValue.items)) {
    return objectValue.items;
  }

  throw new Error("invalid_githubIssuesJson");
}

function parseIssueEntry(entry: unknown, index: number, nowTimestamp: number): ParsedIssue | null {
  const issue = asObject(entry);
  if (!issue) {
    return null;
  }

  if (issue.pull_request && typeof issue.pull_request === "object") {
    return null;
  }

  const rawIssueNumber = asNumber(issue.number) ?? asNumber(issue.id) ?? index + 1;
  const issueNumber = Math.max(1, Math.min(99999999, Math.trunc(rawIssueNumber)));

  const title = sanitizeTitle(typeof issue.title === "string" ? issue.title : "");
  const body = compactWhitespace(typeof issue.body === "string" ? issue.body : "");
  const labels = labelNames(issue.labels);
  const customerTier = deriveCustomerTier(labels, title, body);
  const owner = deriveOwner(issue);

  const createdAt = asTimestamp(issue.created_at) ?? asTimestamp(issue.createdAt);
  const updatedAt = asTimestamp(issue.updated_at) ?? asTimestamp(issue.updatedAt);
  const ageTimestamp = createdAt ?? updatedAt ?? nowTimestamp - 90 * 60000;
  const backlogAgeMinutes = clamp(Math.round((nowTimestamp - ageTimestamp) / 60000), 0, 10080);

  const explicitMinutes = parseMinutesFromLabels(labels);
  const baseMinutes = baseMinutesFromSignals(labels, title, body);
  const commentCount = clamp(asNumber(issue.comments) ?? 0, 0, 9999);
  const agePenalty = Math.floor(backlogAgeMinutes / 20);
  const commentPenalty = Math.min(45, Math.floor(commentCount * 3));
  const minutesUntilBreach = clamp(
    explicitMinutes ?? baseMinutes - agePenalty - commentPenalty,
    -1440,
    10080
  );

  return {
    issueNumber,
    title,
    customerTier,
    minutesUntilBreach,
    backlogAgeMinutes,
    owner,
    channel: "api"
  };
}

function tierRank(tier: "standard" | "priority" | "enterprise"): number {
  if (tier === "enterprise") {
    return 0;
  }
  if (tier === "priority") {
    return 1;
  }
  return 2;
}

export function buildQueueSnapshotFromGithubIssuesJson(
  githubIssuesJson: string,
  maxTickets: number,
  referenceNow = new Date()
): GithubIssuesImportResult {
  const normalizedInput = compactWhitespace(githubIssuesJson);
  if (!normalizedInput) {
    throw new Error("invalid_githubIssuesJson");
  }
  if (!Number.isInteger(maxTickets) || maxTickets < 1 || maxTickets > 8) {
    throw new Error("invalid_maxTickets");
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(githubIssuesJson);
  } catch {
    throw new Error("invalid_githubIssuesJson");
  }

  const entries = parseIssuesCollection(parsedValue);
  if (!entries.length) {
    throw new Error("invalid_githubIssuesJson");
  }

  const nowTimestamp = referenceNow.getTime();
  const parsedIssues: ParsedIssue[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsedIssue = parseIssueEntry(entries[index], index, nowTimestamp);
    if (!parsedIssue) {
      continue;
    }
    parsedIssues.push(parsedIssue);
  }

  if (!parsedIssues.length) {
    throw new Error("invalid_githubIssuesJson");
  }

  parsedIssues.sort((left, right) => {
    if (left.minutesUntilBreach !== right.minutesUntilBreach) {
      return left.minutesUntilBreach - right.minutesUntilBreach;
    }
    if (left.backlogAgeMinutes !== right.backlogAgeMinutes) {
      return right.backlogAgeMinutes - left.backlogAgeMinutes;
    }
    if (tierRank(left.customerTier) !== tierRank(right.customerTier)) {
      return tierRank(left.customerTier) - tierRank(right.customerTier);
    }
    return left.issueNumber - right.issueNumber;
  });

  const selected = parsedIssues.slice(0, maxTickets);
  const queueSnapshot = selected.map((issue) => lineForIssue(issue)).join("\n");

  return {
    queueSnapshot,
    parsedIssues: parsedIssues.length,
    selectedIssues: selected.length,
    droppedIssues: Math.max(0, parsedIssues.length - selected.length),
    issueNumbers: selected.map((issue) => issue.issueNumber)
  };
}
