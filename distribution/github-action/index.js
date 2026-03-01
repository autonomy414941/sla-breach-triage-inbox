import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACTION_VERSION = "0.1.1";
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const ACTION_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SAMPLE_CSV = path.join(ACTION_DIR, "zendesk-sample.csv");

function getInput(name, fallback = "") {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const value = process.env[key];
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

function parseBooleanInput(value, fallback = false) {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseIntegerInput(name, value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid_${name}`);
  }
  return parsed;
}

function parseNumberInput(name, value, min, max) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`invalid_${name}`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  const normalized = (value || "").trim();
  if (!normalized) {
    throw new Error("invalid_api_base_url");
  }
  return normalized.replace(/\/+$/, "");
}

function oneLine(value) {
  return String(value ?? "")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

async function loadZendeskCsvData(zendeskCsvPath, useSampleCsv) {
  const trimmedPath = (zendeskCsvPath || "").trim();
  if (trimmedPath) {
    const csvAbsolutePath = path.resolve(process.cwd(), trimmedPath);
    try {
      const csvData = await readFile(csvAbsolutePath, "utf8");
      return { csvData, csvSource: "workspace_file" };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
      if (!(useSampleCsv && code === "ENOENT")) {
        if (code === "ENOENT") {
          throw new Error("zendesk_csv_not_found");
        }
        throw error;
      }
      console.warn(`zendesk_csv_not_found_using_bundled_sample path=${oneLine(trimmedPath)}`);
    }
  } else if (!useSampleCsv) {
    throw new Error("zendesk_csv_path_required");
  }

  const csvData = await readFile(BUNDLED_SAMPLE_CSV, "utf8");
  return { csvData, csvSource: "bundled_sample" };
}

async function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  await appendFile(outputPath, `${name}=${oneLine(value)}\n`, "utf8");
}

async function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`, "utf8");
}

function highestPriority(tickets) {
  let winner = "none";
  let winnerRank = Number.POSITIVE_INFINITY;
  for (const ticket of tickets) {
    const candidate = typeof ticket.priority === "string" ? ticket.priority : "";
    if (!(candidate in PRIORITY_ORDER)) {
      continue;
    }
    const rank = PRIORITY_ORDER[candidate];
    if (rank < winnerRank) {
      winner = candidate;
      winnerRank = rank;
    }
  }
  return winner;
}

function toMarkdownTable(tickets) {
  if (!tickets.length) {
    return ["No tickets were recommended in this run."];
  }

  const lines = [
    "| Ticket | Priority | Risk | Minutes to breach | Owner | Escalate |",
    "|---|---|---|---:|---|---|"
  ];

  for (const ticket of tickets) {
    const ticketId = oneLine(ticket.ticketId || "n/a");
    const priority = oneLine(ticket.priority || "n/a");
    const riskLevel = oneLine(ticket.riskLevel || "n/a");
    const minutes = Number.isFinite(ticket.minutesUntilBreach) ? String(ticket.minutesUntilBreach) : "n/a";
    const owner = oneLine(ticket.currentOwner || "n/a");
    const escalate = ticket.escalateNow ? "yes" : "no";
    lines.push(`| ${ticketId} | ${priority} | ${riskLevel} | ${minutes} | ${owner} | ${escalate} |`);
  }

  return lines;
}

function buildSummary(result, metadata) {
  const highest = highestPriority(result.tickets);
  const escalationCount = result.tickets.filter((ticket) => ticket.escalateNow).length;
  const lines = [
    "## SLA Breach Triage Command",
    "",
    `- Headline: ${oneLine(result.shiftHeadline || "n/a")}`,
    `- Queue summary: ${oneLine(result.queueSummary || "n/a")}`,
    `- Highest priority: ${highest}`,
    `- Escalations recommended: ${escalationCount}`,
    `- API base URL: ${metadata.apiBaseUrl}`,
    `- Source: ${metadata.source}`,
    `- CSV source: ${metadata.csvSource}`,
    ""
  ];

  if (Array.isArray(result.immediateActions) && result.immediateActions.length) {
    lines.push("### Immediate Actions");
    for (const action of result.immediateActions) {
      lines.push(`- ${oneLine(action)}`);
    }
    lines.push("");
  }

  lines.push("### Recommended Tickets");
  lines.push(...toMarkdownTable(result.tickets));

  if (result.importSummary) {
    lines.push("");
    lines.push("### Zendesk Import");
    lines.push(`- Parsed rows: ${oneLine(result.importSummary.parsedRows)}`);
    lines.push(`- Selected rows: ${oneLine(result.importSummary.selectedRows)}`);
    lines.push(`- Dropped rows: ${oneLine(result.importSummary.droppedRows)}`);
  }

  return lines.join("\n");
}

async function writeReportFile(outputPath, markdown) {
  const target = outputPath.trim();
  if (!target) {
    return;
  }
  const absolutePath = path.resolve(process.cwd(), target);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${markdown}\n`, "utf8");
}

function extractResultBody(rawBody) {
  if (!rawBody || typeof rawBody !== "object") {
    throw new Error("invalid_api_response");
  }
  const tickets = Array.isArray(rawBody.tickets) ? rawBody.tickets : [];
  return {
    shiftHeadline: typeof rawBody.shiftHeadline === "string" ? rawBody.shiftHeadline : "",
    queueSummary: typeof rawBody.queueSummary === "string" ? rawBody.queueSummary : "",
    immediateActions: Array.isArray(rawBody.immediateActions) ? rawBody.immediateActions : [],
    tickets,
    importSummary: rawBody.importSummary && typeof rawBody.importSummary === "object" ? rawBody.importSummary : null,
    recommendedTicket: rawBody.recommendedTicket && typeof rawBody.recommendedTicket === "object" ? rawBody.recommendedTicket : null
  };
}

async function main() {
  const zendeskCsvPath = getInput("zendesk_csv_path");
  const useSampleCsv = parseBooleanInput(getInput("use_sample_csv", "false"), false);
  const apiBaseUrl = normalizeBaseUrl(getInput("api_base_url", "https://sla-breach-triage.devtoolbox.dedyn.io"));
  const source = getInput("source", "github_action") || "github_action";
  const selfTest = parseBooleanInput(getInput("self_test", "false"), false);
  const failOnP0 = parseBooleanInput(getInput("fail_on_p0", "true"), true);
  const maxTickets = parseIntegerInput("max_tickets", getInput("max_tickets", "4"), 1, 8);

  const payload = {
    teamName: getInput("team_name", "Support Ops Team"),
    helpdeskPlatform: getInput("helpdesk_platform", "Zendesk"),
    primaryQueue: getInput("primary_queue", "billing-escalations"),
    slaTargetMinutes: parseIntegerInput("sla_target_minutes", getInput("sla_target_minutes", "45"), 5, 240),
    monthlyTicketVolume: parseIntegerInput(
      "monthly_ticket_volume",
      getInput("monthly_ticket_volume", "4200"),
      1,
      500000
    ),
    breachRatePercent: parseNumberInput("breach_rate_percent", getInput("breach_rate_percent", "8.5"), 0, 100),
    timezone: getInput("timezone", "UTC"),
    escalationCoverage: getInput(
      "escalation_coverage",
      "24/7 follow-the-sun with duty-manager escalation"
    ),
    highValueDefinition: getInput(
      "high_value_definition",
      "Enterprise and contract-backed SLA accounts"
    ),
    maxTickets,
    source,
    selfTest
  };

  const csvInput = await loadZendeskCsvData(zendeskCsvPath, useSampleCsv);
  payload.csvData = csvInput.csvData;

  const response = await fetch(`${apiBaseUrl}/api/daily-command/import-zendesk`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "user-agent": `sla-breach-triage-github-action/${ACTION_VERSION}`,
      "x-github-repository": process.env.GITHUB_REPOSITORY || "",
      "x-github-run-id": process.env.GITHUB_RUN_ID || ""
    },
    body: JSON.stringify(payload)
  });

  let rawBody = null;
  try {
    rawBody = await response.json();
  } catch (error) {
    rawBody = null;
  }

  if (!response.ok) {
    const code = rawBody && typeof rawBody.error === "string" ? rawBody.error : `http_${response.status}`;
    throw new Error(`api_error_${code}`);
  }

  const result = extractResultBody(rawBody);
  const markdown = buildSummary(result, { apiBaseUrl, source, csvSource: csvInput.csvSource });
  const reportPath = getInput("output_markdown_path");

  if (reportPath) {
    await writeReportFile(reportPath, markdown);
  }
  await appendStepSummary(markdown);

  const highest = highestPriority(result.tickets);
  const escalationCount = result.tickets.filter((ticket) => ticket.escalateNow).length;
  const recommendedTicketId = result.recommendedTicket ? oneLine(result.recommendedTicket.ticketId || "") : "";
  const recommendedOwner = result.recommendedTicket ? oneLine(result.recommendedTicket.currentOwner || "") : "";

  await setOutput("highest_priority", highest);
  await setOutput("escalation_count", escalationCount);
  await setOutput("recommended_ticket_id", recommendedTicketId);
  await setOutput("recommended_owner", recommendedOwner);
  await setOutput("csv_source", csvInput.csvSource);

  if (failOnP0 && highest === "P0") {
    process.exitCode = 1;
    console.error("run_failed_due_to_p0_ticket");
  }
}

await main();
