export type ZendeskCsvImportResult = {
  queueSnapshot: string;
  parsedRows: number;
  selectedRows: number;
  droppedRows: number;
  ticketIds: string[];
};

type ParsedRow = {
  ticketId: string;
  subject: string;
  customerTier: "standard" | "priority" | "enterprise";
  minutesUntilBreach: number;
  backlogAgeMinutes: number;
  owner: string;
  channel: "email" | "chat" | "phone" | "api";
};

const TICKET_ID_HEADERS = [
  "ticketid",
  "id",
  "ticket",
  "ticketnumber",
  "casenumber",
  "requestid"
];
const SUBJECT_HEADERS = ["subject", "title", "summary", "description", "problem"];
const OWNER_HEADERS = ["assignee", "assigneename", "owner", "currentowner", "group", "assignedto"];
const PRIORITY_HEADERS = ["priority", "urgency", "severity", "ticketpriority"];
const TIER_HEADERS = ["customertier", "tier", "segment", "plan", "accounttier", "requestertier"];
const CHANNEL_HEADERS = ["channel", "via", "source", "origin"];
const TAG_HEADERS = ["tags", "label", "labels"];
const MINUTES_TO_BREACH_HEADERS = [
  "minutestobreach",
  "remainingminutes",
  "slaremainingminutes",
  "timeleftminutes",
  "slatimeleft",
  "slaminutesremaining"
];
const DUE_AT_HEADERS = ["dueat", "sladueat", "sladeadline", "deadlineat", "breachat", "nextbreachat"];
const BACKLOG_AGE_HEADERS = ["backlogageminutes", "ageminutes", "waitminutes", "minutesopen", "openageminutes"];
const CREATED_AT_HEADERS = ["createdat", "created", "submittedat", "openedat"];
const MAX_LINE_LENGTH = 360;

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseCsvRows(csvData: string): string[][] {
  const normalized = csvData.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (inQuotes) {
      if (char === "\"") {
        if (normalized[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (inQuotes) {
    throw new Error("invalid_csv_unclosed_quote");
  }

  row.push(cell);
  rows.push(row);

  return rows
    .map((entry) => entry.map((value) => normalizeText(value)))
    .filter((entry) => entry.some((value) => value.length > 0));
}

function firstIndex(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const index = headers.indexOf(alias);
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

function cellValue(row: string[], index: number): string {
  if (index < 0 || index >= row.length) {
    return "";
  }
  return normalizeText(row[index] || "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseMinutes(value: string): number | null {
  if (!value) {
    return null;
  }
  const durationMatch = value.match(/^(-?\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (durationMatch) {
    const hours = Number.parseInt(durationMatch[1], 10);
    const minutes = Number.parseInt(durationMatch[2], 10);
    if (Number.isInteger(hours) && Number.isInteger(minutes) && minutes >= 0 && minutes <= 59) {
      return clamp(hours * 60 + minutes, -1440, 10080);
    }
  }

  const numericMatch = value.match(/-?\d{1,5}/);
  if (!numericMatch) {
    return null;
  }
  const parsed = Number.parseInt(numericMatch[0], 10);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return clamp(parsed, -1440, 10080);
}

function parseMinutesFromDate(value: string, now: Date): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const diffMinutes = Math.round((timestamp - now.getTime()) / 60000);
  return clamp(diffMinutes, -1440, 10080);
}

function parseAgeFromCreatedAt(value: string, now: Date): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const diffMinutes = Math.round((now.getTime() - timestamp) / 60000);
  return clamp(diffMinutes, 0, 10080);
}

function sanitizeTicketId(value: string, index: number): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized) {
    return normalized.slice(0, 40);
  }
  return `ZD-${1000 + index}`;
}

function sanitizeOwner(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized) {
    return normalized.slice(0, 60);
  }
  return "duty-manager";
}

function sanitizeSubject(value: string): string {
  const subject = normalizeText(value);
  if (!subject) {
    return "Ticket requires immediate SLA review.";
  }
  return subject.slice(0, 180);
}

function deriveCustomerTier(
  tierValue: string,
  priorityValue: string,
  tagValue: string,
  subjectValue: string
): "standard" | "priority" | "enterprise" {
  const combined = `${tierValue} ${priorityValue} ${tagValue} ${subjectValue}`.toLowerCase();
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
    combined.includes("urgent") ||
    combined.includes("high")
  ) {
    return "priority";
  }
  return "standard";
}

function deriveChannel(value: string): "email" | "chat" | "phone" | "api" {
  const normalized = value.toLowerCase();
  if (normalized.includes("chat") || normalized.includes("messag")) {
    return "chat";
  }
  if (normalized.includes("phone") || normalized.includes("call") || normalized.includes("voice")) {
    return "phone";
  }
  if (normalized.includes("api") || normalized.includes("webhook")) {
    return "api";
  }
  return "email";
}

function fallbackMinutes(priority: string): number {
  const normalized = priority.toLowerCase();
  if (normalized.includes("urgent") || normalized.includes("critical") || normalized.includes("p0")) {
    return 12;
  }
  if (normalized.includes("high") || normalized.includes("p1")) {
    return 24;
  }
  if (normalized.includes("normal") || normalized.includes("medium") || normalized.includes("p2")) {
    return 60;
  }
  return 120;
}

function lineForRow(row: ParsedRow): string {
  const line = `${row.ticketId} | ${row.customerTier} | ${row.minutesUntilBreach}m to breach | backlog=${row.backlogAgeMinutes}m | owner=${row.owner} | channel=${row.channel} | ${row.subject}`;
  return line.slice(0, MAX_LINE_LENGTH);
}

export function buildQueueSnapshotFromZendeskCsv(
  csvData: string,
  maxTickets: number,
  referenceNow = new Date()
): ZendeskCsvImportResult {
  const normalizedCsv = normalizeText(csvData);
  if (!normalizedCsv) {
    throw new Error("invalid_csvData");
  }
  if (!Number.isInteger(maxTickets) || maxTickets < 1 || maxTickets > 8) {
    throw new Error("invalid_maxTickets");
  }

  const rows = parseCsvRows(csvData);
  if (rows.length < 2) {
    throw new Error("invalid_csvData");
  }

  const headerRow = rows[0];
  const dataRows = rows.slice(1);
  const headers = headerRow.map((value) => normalizeHeader(value));

  const ticketIdIndex = firstIndex(headers, TICKET_ID_HEADERS);
  const subjectIndex = firstIndex(headers, SUBJECT_HEADERS);
  const ownerIndex = firstIndex(headers, OWNER_HEADERS);
  const priorityIndex = firstIndex(headers, PRIORITY_HEADERS);
  const tierIndex = firstIndex(headers, TIER_HEADERS);
  const channelIndex = firstIndex(headers, CHANNEL_HEADERS);
  const tagIndex = firstIndex(headers, TAG_HEADERS);
  const minutesToBreachIndex = firstIndex(headers, MINUTES_TO_BREACH_HEADERS);
  const dueAtIndex = firstIndex(headers, DUE_AT_HEADERS);
  const backlogAgeIndex = firstIndex(headers, BACKLOG_AGE_HEADERS);
  const createdAtIndex = firstIndex(headers, CREATED_AT_HEADERS);

  const parsed: ParsedRow[] = [];
  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index];
    if (!Array.isArray(row) || row.length === 0) {
      continue;
    }

    const priorityValue = cellValue(row, priorityIndex);
    const tierValue = cellValue(row, tierIndex);
    const tagValue = cellValue(row, tagIndex);
    const minutesUntilBreach =
      parseMinutes(cellValue(row, minutesToBreachIndex)) ??
      parseMinutesFromDate(cellValue(row, dueAtIndex), referenceNow) ??
      fallbackMinutes(priorityValue || tierValue);
    const backlogAgeMinutes =
      parseMinutes(cellValue(row, backlogAgeIndex)) ??
      parseAgeFromCreatedAt(cellValue(row, createdAtIndex), referenceNow) ??
      clamp(Math.max(30, minutesUntilBreach * 2), 0, 10080);

    const ticketId = sanitizeTicketId(cellValue(row, ticketIdIndex), index);
    const subject = sanitizeSubject(cellValue(row, subjectIndex));
    const owner = sanitizeOwner(cellValue(row, ownerIndex));
    const customerTier = deriveCustomerTier(tierValue, priorityValue, tagValue, subject);
    const channel = deriveChannel(cellValue(row, channelIndex));

    parsed.push({
      ticketId,
      subject,
      customerTier,
      minutesUntilBreach,
      backlogAgeMinutes,
      owner,
      channel
    });
  }

  if (!parsed.length) {
    throw new Error("invalid_csvData");
  }

  const tierRank: Record<ParsedRow["customerTier"], number> = {
    enterprise: 0,
    priority: 1,
    standard: 2
  };

  parsed.sort((a, b) => {
    if (a.minutesUntilBreach !== b.minutesUntilBreach) {
      return a.minutesUntilBreach - b.minutesUntilBreach;
    }
    if (tierRank[a.customerTier] !== tierRank[b.customerTier]) {
      return tierRank[a.customerTier] - tierRank[b.customerTier];
    }
    return b.backlogAgeMinutes - a.backlogAgeMinutes;
  });

  const selected = parsed.slice(0, maxTickets);
  const queueSnapshot = selected.map((row) => lineForRow(row)).join("\n");

  return {
    queueSnapshot,
    parsedRows: parsed.length,
    selectedRows: selected.length,
    droppedRows: Math.max(0, parsed.length - selected.length),
    ticketIds: selected.map((row) => row.ticketId)
  };
}
