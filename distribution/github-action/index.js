import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACTION_VERSION = "0.1.6";
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const ACTION_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SAMPLE_CSV = path.join(ACTION_DIR, "zendesk-sample.csv");
const BUNDLED_SAMPLE_GITHUB_ISSUES = path.join(ACTION_DIR, "github-issues-sample.json");

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

function parseIngestionMode(value) {
  const normalized = oneLine(value).toLowerCase();
  if (!normalized || normalized === "github" || normalized === "github_issues") {
    return "github_issues";
  }
  if (normalized === "zendesk" || normalized === "zendesk_csv") {
    return "zendesk_csv";
  }
  throw new Error("invalid_ingestion_mode");
}

function sanitizeWorkspaceKey(value) {
  const normalized = oneLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!normalized || normalized.length < 6) {
    return "";
  }
  return normalized;
}

function buildDefaultWorkspaceKey(teamName, primaryQueue) {
  const repository = sanitizeWorkspaceKey(String(process.env.GITHUB_REPOSITORY || "").replace(/\//g, "-"));
  if (repository) {
    return sanitizeWorkspaceKey(`gh-${repository}`) || "gh-support-ops-default";
  }

  const teamPart = sanitizeWorkspaceKey(teamName) || "support-ops-team";
  const queuePart = sanitizeWorkspaceKey(primaryQueue) || "repo-issues";
  return sanitizeWorkspaceKey(`team-${teamPart}-${queuePart}`) || "team-support-ops-repo-issues";
}

function resolveWorkspaceKey(inputValue, teamName, primaryQueue) {
  const explicit = sanitizeWorkspaceKey(inputValue);
  if (explicit) {
    return explicit;
  }
  return buildDefaultWorkspaceKey(teamName, primaryQueue);
}

function oneLine(value) {
  return String(value ?? "")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

function normalizeToken(value) {
  return oneLine(value);
}

function ensureValidIssuesJson(rawJson, invalidCode) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(invalidCode);
  }

  if (Array.isArray(parsed)) {
    return rawJson;
  }

  if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
    return rawJson;
  }

  throw new Error(invalidCode);
}

async function fetchGithubIssuesFromApi(githubToken) {
  const repository = oneLine(process.env.GITHUB_REPOSITORY || "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("github_repository_missing");
  }

  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": `sla-breach-triage-github-action/${ACTION_VERSION}`,
    "x-github-api-version": "2022-11-28"
  };

  const token = normalizeToken(githubToken);
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/issues?state=open&sort=updated&direction=desc&per_page=100`,
    {
      method: "GET",
      headers
    }
  );

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`github_issues_http_${response.status}`);
  }

  return ensureValidIssuesJson(bodyText, "invalid_github_issues_api_payload");
}

async function loadGithubIssuesJsonData(githubIssuesJsonPath, useSampleGithubIssues, githubToken) {
  const trimmedPath = oneLine(githubIssuesJsonPath);
  if (trimmedPath) {
    const jsonAbsolutePath = path.resolve(process.cwd(), trimmedPath);
    try {
      const githubIssuesJson = await readFile(jsonAbsolutePath, "utf8");
      return {
        githubIssuesJson: ensureValidIssuesJson(githubIssuesJson, "invalid_github_issues_json"),
        inputSource: "workspace_file"
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
      if (!(useSampleGithubIssues && code === "ENOENT")) {
        if (code === "ENOENT") {
          throw new Error("github_issues_json_not_found");
        }
        throw error;
      }
      console.warn(`github_issues_json_not_found_using_fallback path=${trimmedPath}`);
    }
  }

  try {
    const githubIssuesJson = await fetchGithubIssuesFromApi(githubToken);
    return {
      githubIssuesJson,
      inputSource: "github_api"
    };
  } catch (error) {
    if (!useSampleGithubIssues) {
      throw error;
    }
    const code =
      error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "unknown";
    console.warn(`github_api_fetch_failed_using_sample reason=${oneLine(code)}`);
  }

  const githubIssuesJson = await readFile(BUNDLED_SAMPLE_GITHUB_ISSUES, "utf8");
  return {
    githubIssuesJson: ensureValidIssuesJson(githubIssuesJson, "invalid_github_issues_sample"),
    inputSource: "bundled_sample"
  };
}

async function loadZendeskCsvData(zendeskCsvPath, useSampleCsv) {
  const trimmedPath = (zendeskCsvPath || "").trim();
  if (trimmedPath) {
    const csvAbsolutePath = path.resolve(process.cwd(), trimmedPath);
    try {
      const csvData = await readFile(csvAbsolutePath, "utf8");
      return { csvData, inputSource: "workspace_file" };
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
  return { csvData, inputSource: "bundled_sample" };
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
    "## GitHub SLA Policy Guard Command",
    "",
    `- Headline: ${oneLine(result.shiftHeadline || "n/a")}`,
    `- Queue summary: ${oneLine(result.queueSummary || "n/a")}`,
    `- Highest priority: ${highest}`,
    `- Escalations recommended: ${escalationCount}`,
    `- API base URL: ${metadata.apiBaseUrl}`,
    `- Source: ${metadata.source}`,
    `- Workspace key: ${metadata.workspaceKey}`,
    `- Ingestion mode: ${metadata.ingestionMode}`,
    `- Input source: ${metadata.inputSource}`,
    ""
  ];

  if (result.sessionId) {
    lines.push(`- Session ID: ${oneLine(result.sessionId)}`);
  }
  if (result.workspaceAutoCreated === true) {
    lines.push("- Workspace lifecycle: created");
  } else if (result.workspaceAutoCreated === false && result.sessionId) {
    lines.push("- Workspace lifecycle: resumed");
  }
  if (result.workspaceCheckoutUrl) {
    lines.push(`- Resume URL: ${oneLine(result.workspaceCheckoutUrl)}`);
  }
  if (result.sessionId || result.workspaceCheckoutUrl) {
    lines.push("");
  }

  if (Array.isArray(result.immediateActions) && result.immediateActions.length) {
    lines.push("### Immediate Actions");
    for (const action of result.immediateActions) {
      lines.push(`- ${oneLine(action)}`);
    }
    lines.push("");
  }

  lines.push("### Recommended Tickets");
  lines.push(...toMarkdownTable(result.tickets));

  if (result.importSummary && result.importSummary.integration === "github_issues") {
    lines.push("");
    lines.push("### GitHub Issues Import");
    lines.push(`- Parsed issues: ${oneLine(result.importSummary.parsedIssues)}`);
    lines.push(`- Selected issues: ${oneLine(result.importSummary.selectedIssues)}`);
    lines.push(`- Dropped issues: ${oneLine(result.importSummary.droppedIssues)}`);
  } else if (result.importSummary && result.importSummary.integration === "zendesk_csv") {
    lines.push("");
    lines.push("### Zendesk CSV Import");
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
    recommendedTicket: rawBody.recommendedTicket && typeof rawBody.recommendedTicket === "object" ? rawBody.recommendedTicket : null,
    sessionId: typeof rawBody.sessionId === "string" ? rawBody.sessionId : "",
    workspaceAutoCreated: typeof rawBody.workspaceAutoCreated === "boolean" ? rawBody.workspaceAutoCreated : null,
    workspaceCheckoutUrl: typeof rawBody.workspaceCheckoutUrl === "string" ? rawBody.workspaceCheckoutUrl : ""
  };
}

async function main() {
  const ingestionMode = parseIngestionMode(getInput("ingestion_mode", "github_issues"));
  const zendeskCsvPath = getInput("zendesk_csv_path");
  const githubIssuesJsonPath = getInput("github_issues_json_path");
  const useSampleCsv = parseBooleanInput(getInput("use_sample_csv", "false"), false);
  const useSampleGithubIssues = parseBooleanInput(getInput("use_sample_github_issues", "true"), true);
  const githubToken = getInput("github_token") || process.env.GITHUB_TOKEN || "";
  const apiBaseUrl = normalizeBaseUrl(getInput("api_base_url", "https://sla-breach-triage.devtoolbox.dedyn.io"));
  const source = getInput("source", "github_action") || "github_action";
  const selfTest = parseBooleanInput(getInput("self_test", "false"), false);
  const failOnP0 = parseBooleanInput(getInput("fail_on_p0", "true"), true);
  const maxTickets = parseIntegerInput("max_tickets", getInput("max_tickets", "4"), 1, 8);
  const teamName = getInput("team_name", "Support Ops Team");
  const defaultHelpdeskPlatform = ingestionMode === "github_issues" ? "GitHub Issues" : "Zendesk";
  const defaultPrimaryQueue = ingestionMode === "github_issues" ? "repo-issues" : "billing-escalations";
  const helpdeskPlatform = getInput("helpdesk_platform", defaultHelpdeskPlatform);
  const primaryQueue = getInput("primary_queue", defaultPrimaryQueue);
  const workspaceKey = resolveWorkspaceKey(getInput("workspace_key"), teamName, primaryQueue);

  const payload = {
    teamName,
    helpdeskPlatform,
    primaryQueue,
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
    workspaceKey,
    source,
    selfTest
  };

  let endpointPath = "/api/daily-command/import-zendesk";
  let inputSource = "workspace_file";
  if (ingestionMode === "github_issues") {
    endpointPath = "/api/daily-command/import-github-issues";
    const githubInput = await loadGithubIssuesJsonData(githubIssuesJsonPath, useSampleGithubIssues, githubToken);
    payload.githubIssuesJson = githubInput.githubIssuesJson;
    inputSource = githubInput.inputSource;
  } else {
    const csvInput = await loadZendeskCsvData(zendeskCsvPath, useSampleCsv);
    payload.csvData = csvInput.csvData;
    inputSource = csvInput.inputSource;
  }

  const response = await fetch(`${apiBaseUrl}${endpointPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": `sla-breach-triage-github-action/${ACTION_VERSION}`,
      "x-github-repository": process.env.GITHUB_REPOSITORY || "",
      "x-github-run-id": process.env.GITHUB_RUN_ID || ""
    },
    body: JSON.stringify(payload)
  });

  let rawBody = null;
  try {
    rawBody = await response.json();
  } catch {
    rawBody = null;
  }

  if (!response.ok) {
    const code = rawBody && typeof rawBody.error === "string" ? rawBody.error : `http_${response.status}`;
    throw new Error(`api_error_${code}`);
  }

  const result = extractResultBody(rawBody);
  const markdown = buildSummary(result, {
    apiBaseUrl,
    source,
    workspaceKey,
    ingestionMode,
    inputSource
  });
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
  await setOutput("ingestion_mode", ingestionMode);
  await setOutput("input_source", inputSource);
  await setOutput("csv_source", ingestionMode === "zendesk_csv" ? inputSource : "not_used");
  await setOutput("session_id", result.sessionId || "");
  await setOutput("workspace_key", workspaceKey);

  if (failOnP0 && highest === "P0") {
    process.exitCode = 1;
    console.error("run_failed_due_to_p0_ticket");
  }
}

await main();
