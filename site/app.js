const workspaceForm = document.querySelector("#workspace-form");
const quickstartForm = document.querySelector("#quickstart-form");
const dailyCommandForm = document.querySelector("#daily-command-form");
const zendeskImportForm = document.querySelector("#zendesk-import-form");
const ticketForm = document.querySelector("#ticket-form");
const proofForm = document.querySelector("#proof-form");

const quickstartStatus = document.querySelector("#quickstart-status");
const dailyCommandStatus = document.querySelector("#daily-command-status");
const zendeskImportStatus = document.querySelector("#zendesk-import-status");
const workspaceStatus = document.querySelector("#workspace-status");
const triageStatus = document.querySelector("#triage-status");
const paymentStatus = document.querySelector("#payment-status");

const quickstartBtn = document.querySelector("#quickstart-btn");
const dailyCommandBtn = document.querySelector("#daily-command-btn");
const dailyCommandSampleBtn = document.querySelector("#daily-command-sample-btn");
const zendeskImportBtn = document.querySelector("#zendesk-import-btn");
const workspaceBtn = document.querySelector("#workspace-btn");
const triageBtn = document.querySelector("#triage-btn");
const checkoutBtn = document.querySelector("#checkout-btn");
const proofBtn = document.querySelector("#proof-btn");
const exportBtn = document.querySelector("#export-btn");
const digestBtn = document.querySelector("#digest-btn");
const commandWorkspaceBtn = document.querySelector("#command-workspace-btn");
const instantDemoBtn = document.querySelector("#instant-demo-btn");
const advancedDetails = document.querySelector(".advanced-details");
const githubActionInstallLink = document.querySelector("#github-action-install-link");
const githubWorkflowExampleLink = document.querySelector("#github-workflow-example-link");
const githubReleaseLink = document.querySelector("#github-release-link");

const blueprintSection = document.querySelector("#blueprint-section");
const triageSection = document.querySelector("#triage-section");
const paymentSection = document.querySelector("#payment-section");
const exportSection = document.querySelector("#export-section");
const decisionCard = document.querySelector("#decision-card");
const dailyCommandOutput = document.querySelector("#daily-command-output");
const digestOutput = document.querySelector("#digest-output");
const demoStatus = document.querySelector("#demo-status");

const blueprintSummary = document.querySelector("#blueprint-summary");
const matrixBody = document.querySelector("#matrix-body");
const routingList = document.querySelector("#routing-list");
const signalsList = document.querySelector("#signals-list");

const decisionHeadline = document.querySelector("#decision-headline");
const decisionReason = document.querySelector("#decision-reason");
const decisionOwner = document.querySelector("#decision-owner");
const decisionResponse = document.querySelector("#decision-response");
const decisionEscalation = document.querySelector("#decision-escalation");
const decisionActions = document.querySelector("#decision-actions");
const exportContent = document.querySelector("#export-content");
const dailyCommandHeadline = document.querySelector("#daily-command-headline");
const dailyCommandSummary = document.querySelector("#daily-command-summary");
const dailyCommandActions = document.querySelector("#daily-command-actions");
const dailyCommandTickets = document.querySelector("#daily-command-tickets");
const dailyCommandOwnerCheckpoints = document.querySelector("#daily-command-owner-checkpoints");
const boardCriticalCount = document.querySelector("#board-critical-count");
const boardEscalationCount = document.querySelector("#board-escalation-count");
const boardSweepMinutes = document.querySelector("#board-sweep-minutes");
const digestHeadline = document.querySelector("#digest-headline");
const digestSummary = document.querySelector("#digest-summary");
const digestRisks = document.querySelector("#digest-risks");
const digestFollowups = document.querySelector("#digest-followups");
const digestNextShift = document.querySelector("#digest-next-shift");

const query = new URLSearchParams(window.location.search);
const source = query.get("source") || "web";
const selfTest = ["1", "true", "yes"].includes((query.get("selfTest") || "").toLowerCase());
const instant = ["1", "true", "yes"].includes((query.get("instant") || "").toLowerCase());
const prefill = (query.get("prefill") || "").toLowerCase();
const useSamplePrefill = ["sample", "1", "true", "yes"].includes(prefill);
const autoRunParam = (query.get("autorun") || "").toLowerCase();
const autoRunExplicitlyEnabled = ["1", "true", "yes"].includes(autoRunParam);
const autoRunExplicitlyDisabled = ["0", "false", "no"].includes(autoRunParam);
const autoRunMode = autoRunExplicitlyEnabled
  ? "explicit"
  : autoRunExplicitlyDisabled || selfTest || instant
    ? "off"
    : "first_interaction";
const autoRun = autoRunMode !== "off";
const FIRST_INTERACTION_ACTIONABLE_FALLBACK_DELAY_MS = 1200;
const FIRST_INTERACTION_IDLE_AUTORUN_DELAY_MS = 9000;
const SAMPLE_QUEUE_SNAPSHOT = [
  "ZD-81231 | enterprise | 14m to breach | owner=tier-2-billing | Billing API timeout after deploy",
  "ZD-81277 | priority | 28m to breach | owner=tier-1-chat | Refund thread escalated twice",
  "ZD-81310 | standard | 65m to breach | owner=tier-2-support | Integration webhook retries failing"
].join("\n");

let currentSessionId = query.get("sessionId") || null;
let checkoutUrl = null;
let unlocked = false;
let billingReady = true;
let billingMode = "live";
let landingInteractiveTracked = false;
let autoRunStarted = false;
let onboardingIntentStarted = false;
let firstInteractionObserved = false;
let firstInteractionActionableFallbackTimer = null;
let firstInteractionIdleAutoRunTimer = null;
let dailyCommandWorkspaceDefaults = null;
let dailyCommandRecommendedTicket = null;
const SESSION_STORAGE_KEY = "sla-triage-session-id";

function canUseStorage() {
  try {
    return Boolean(window.localStorage);
  } catch {
    return false;
  }
}

function syncSessionIdToUrl(sessionId) {
  const nextUrl = new URL(window.location.href);
  if (sessionId) {
    nextUrl.searchParams.set("sessionId", sessionId);
  } else {
    nextUrl.searchParams.delete("sessionId");
  }
  window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
}

function persistSessionId(sessionId) {
  if (sessionId && canUseStorage()) {
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }
  syncSessionIdToUrl(sessionId);
}

function clearSessionPersistence() {
  if (canUseStorage()) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }
  syncSessionIdToUrl(null);
}

function resolveInitialSessionId() {
  if (currentSessionId) {
    return currentSessionId;
  }
  if (!canUseStorage()) {
    return null;
  }
  return window.localStorage.getItem(SESSION_STORAGE_KEY);
}

function setStatus(target, message, tone = "neutral") {
  if (!target) {
    return;
  }
  target.textContent = message;
  target.dataset.tone = tone;
}

function setProofFormDisabled(disabled) {
  if (!proofForm || !proofForm.elements) {
    return;
  }

  for (const element of Array.from(proofForm.elements)) {
    if (element && typeof element === "object" && "disabled" in element) {
      element.disabled = disabled;
    }
  }
}

function safeErrorCode(error) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message.slice(0, 80);
  }
  return "unknown_error";
}

function clearFirstInteractionActionableFallbackTimer() {
  if (firstInteractionActionableFallbackTimer !== null) {
    window.clearTimeout(firstInteractionActionableFallbackTimer);
    firstInteractionActionableFallbackTimer = null;
  }
}

function clearFirstInteractionIdleAutoRunTimer() {
  if (firstInteractionIdleAutoRunTimer !== null) {
    window.clearTimeout(firstInteractionIdleAutoRunTimer);
    firstInteractionIdleAutoRunTimer = null;
  }
}

function clearFirstInteractionAutoRunTimers() {
  clearFirstInteractionActionableFallbackTimer();
  clearFirstInteractionIdleAutoRunTimer();
}

function scheduleFirstInteractionIdleAutoRun() {
  if (autoRunMode !== "first_interaction" || !autoRun || instant || currentSessionId) {
    return;
  }
  if (autoRunStarted || onboardingIntentStarted) {
    return;
  }
  if (document.visibilityState !== "visible") {
    return;
  }
  if (firstInteractionIdleAutoRunTimer !== null) {
    return;
  }

  firstInteractionIdleAutoRunTimer = window.setTimeout(() => {
    firstInteractionIdleAutoRunTimer = null;
    if (autoRunMode !== "first_interaction" || !autoRun || instant || currentSessionId) {
      return;
    }
    if (autoRunStarted || onboardingIntentStarted) {
      return;
    }
    if (document.visibilityState !== "visible") {
      return;
    }
    startAutoSampleDailyCommand("first_interaction_idle");
  }, FIRST_INTERACTION_IDLE_AUTORUN_DELAY_MS);
}

function markOnboardingIntent() {
  clearFirstInteractionAutoRunTimers();
  onboardingIntentStarted = true;
  autoRunStarted = true;
}

function isActionableInteractionTarget(target) {
  if (!target || typeof target !== "object" || !("closest" in target)) {
    return false;
  }
  if (typeof target.closest !== "function") {
    return false;
  }
  return Boolean(target.closest("button, a, input, textarea, select, label, summary, details, form"));
}

function focusWorkflowSection() {
  if (!triageSection) {
    return;
  }
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  triageSection.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start"
  });
}

async function jsonRequest(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data && typeof data.error === "string" ? data.error : `http_${response.status}`;
    throw new Error(code);
  }

  return data;
}

async function trackOnboardingAction(action, details = {}, sessionIdOverride = null) {
  if (!action || typeof action !== "string") {
    return;
  }

  const eventSessionId = typeof sessionIdOverride === "string" ? sessionIdOverride : currentSessionId;

  try {
    await fetch("/api/events/onboarding-action", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        action,
        source,
        selfTest,
        sessionId: eventSessionId,
        details
      })
    });
  } catch {
    // Ignore telemetry failures so onboarding remains responsive.
  }
}

async function trackLandingInteractive(trigger = "unknown") {
  if (landingInteractiveTracked) {
    return;
  }
  landingInteractiveTracked = true;

  try {
    await fetch("/api/events/landing-interactive", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source,
        selfTest,
        path: window.location.pathname,
        trigger
      })
    });
  } catch {
    // Ignore telemetry failures so onboarding remains responsive.
  }
}

function registerTrackedOutboundLink(link, action, placement) {
  if (!link) {
    return;
  }
  link.addEventListener("click", () => {
    void trackLandingInteractive(`outbound_${action}`);
    void trackOnboardingAction(action, {
      placement
    });
  });
}

function registerInteractiveTracking(onFirstInteraction = null) {
  const listeners = [
    { event: "pointerdown", trigger: "pointerdown", options: { passive: true } },
    { event: "keydown", trigger: "keydown", options: undefined },
    { event: "touchstart", trigger: "touchstart", options: { passive: true } }
  ];

  const handleInteractive = (trigger, target = null) => {
    for (const listener of listeners) {
      window.removeEventListener(listener.event, listener.handler, listener.options);
    }
    firstInteractionObserved = true;
    if (typeof onFirstInteraction === "function") {
      onFirstInteraction(trigger, target);
    }
    void trackLandingInteractive(trigger);
  };

  for (const listener of listeners) {
    listener.handler = (event) => {
      const target = event && typeof event === "object" && "target" in event ? event.target : null;
      handleInteractive(listener.trigger, target);
    };
    window.addEventListener(listener.event, listener.handler, listener.options);
  }
}

function collectWorkspacePayload() {
  const formData = new FormData(workspaceForm);
  return {
    teamName: String(formData.get("teamName") || "").trim(),
    helpdeskPlatform: String(formData.get("helpdeskPlatform") || "").trim(),
    primaryQueue: String(formData.get("primaryQueue") || "").trim(),
    slaTargetMinutes: Number(formData.get("slaTargetMinutes") || 0),
    monthlyTicketVolume: Number(formData.get("monthlyTicketVolume") || 0),
    breachRatePercent: Number(formData.get("breachRatePercent") || 0),
    timezone: String(formData.get("timezone") || "").trim(),
    escalationCoverage: String(formData.get("escalationCoverage") || "").trim(),
    highValueDefinition: String(formData.get("highValueDefinition") || "").trim(),
    source,
    selfTest
  };
}

function collectQuickstartPayload() {
  return {
    source,
    selfTest
  };
}

function findDailyCommandField(name) {
  if (!dailyCommandForm || !dailyCommandForm.elements) {
    return null;
  }
  const field = dailyCommandForm.elements.namedItem(name);
  if (!field || typeof field !== "object" || !("value" in field)) {
    return null;
  }
  return field;
}

function applySampleDailyCommandPreset(force = false) {
  const queueField = findDailyCommandField("queueSnapshot");
  if (queueField) {
    const currentValue = String(queueField.value || "").trim();
    if (force || !currentValue) {
      queueField.value = SAMPLE_QUEUE_SNAPSHOT;
    }
  }

  const primaryQueueField = findDailyCommandField("primaryQueue");
  if (primaryQueueField && (force || !String(primaryQueueField.value || "").trim())) {
    primaryQueueField.value = "billing-escalations";
  }

  const teamNameField = findDailyCommandField("teamName");
  if (teamNameField && (force || !String(teamNameField.value || "").trim())) {
    teamNameField.value = "Support Ops Team";
  }

  const slaTargetField = findDailyCommandField("slaTargetMinutes");
  if (slaTargetField && (force || !String(slaTargetField.value || "").trim())) {
    slaTargetField.value = "45";
  }

  const maxTicketsField = findDailyCommandField("maxTickets");
  if (maxTicketsField && (force || !String(maxTicketsField.value || "").trim())) {
    maxTicketsField.value = "4";
  }
}

function collectDailyCommandPayload() {
  const formData = new FormData(dailyCommandForm);
  return {
    queueSnapshot: String(formData.get("queueSnapshot") || "").trim(),
    teamName: String(formData.get("teamName") || "").trim(),
    primaryQueue: String(formData.get("primaryQueue") || "").trim(),
    slaTargetMinutes: Number(formData.get("slaTargetMinutes") || 0),
    maxTickets: Number(formData.get("maxTickets") || 0),
    sessionId: currentSessionId,
    source,
    selfTest
  };
}

function collectZendeskImportPayload() {
  const formData = new FormData(zendeskImportForm);
  return {
    csvData: String(formData.get("csvData") || "").trim(),
    teamName: String(formData.get("teamName") || "").trim(),
    primaryQueue: String(formData.get("primaryQueue") || "").trim(),
    slaTargetMinutes: Number(formData.get("slaTargetMinutes") || 0),
    maxTickets: Number(formData.get("maxTickets") || 0),
    sessionId: currentSessionId,
    source,
    selfTest
  };
}

function collectTicketPayload() {
  const formData = new FormData(ticketForm);
  return {
    sessionId: currentSessionId,
    ticketId: String(formData.get("ticketId") || "").trim(),
    subject: String(formData.get("subject") || "").trim(),
    summary: String(formData.get("summary") || "").trim(),
    customerTier: String(formData.get("customerTier") || "standard"),
    minutesUntilBreach: Number(formData.get("minutesUntilBreach") || 0),
    backlogAgeMinutes: Number(formData.get("backlogAgeMinutes") || 0),
    currentOwner: String(formData.get("currentOwner") || "").trim(),
    channel: String(formData.get("channel") || "email"),
    source,
    selfTest
  };
}

function renderDailyCommand(data) {
  if (!dailyCommandOutput) {
    return;
  }

  const actions = Array.isArray(data?.immediateActions) ? data.immediateActions : [];
  const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
  const actionBoard = data?.actionBoard && typeof data.actionBoard === "object" ? data.actionBoard : {};
  const fallbackCriticalCount = tickets.filter((ticket) => ticket?.riskLevel === "critical").length;
  const fallbackEscalationCount = tickets.filter((ticket) => ticket?.escalateNow).length;
  const fallbackSweepMinutes = Math.max(
    5,
    Math.min(
      30,
      ...tickets
        .map((ticket) => (typeof ticket?.minutesUntilBreach === "number" ? ticket.minutesUntilBreach : 30))
        .filter((minutes) => Number.isFinite(minutes) && minutes > 0)
        .map((minutes) => Math.floor(minutes / 2))
    )
  );
  const checkpoints = Array.isArray(actionBoard?.ownerCheckpoints)
    ? actionBoard.ownerCheckpoints.filter((item) => typeof item === "string" && item.trim())
    : [];

  dailyCommandHeadline.textContent = data?.shiftHeadline || "No command headline available.";
  dailyCommandSummary.textContent = data?.queueSummary || "No queue summary available.";

  if (boardCriticalCount) {
    const value =
      typeof actionBoard?.criticalCount === "number" && Number.isFinite(actionBoard.criticalCount)
        ? actionBoard.criticalCount
        : fallbackCriticalCount;
    boardCriticalCount.textContent = String(value);
  }
  if (boardEscalationCount) {
    const value =
      typeof actionBoard?.escalationNowCount === "number" && Number.isFinite(actionBoard.escalationNowCount)
        ? actionBoard.escalationNowCount
        : fallbackEscalationCount;
    boardEscalationCount.textContent = String(value);
  }
  if (boardSweepMinutes) {
    const value =
      typeof actionBoard?.nextSweepInMinutes === "number" && Number.isFinite(actionBoard.nextSweepInMinutes)
        ? actionBoard.nextSweepInMinutes
        : fallbackSweepMinutes;
    boardSweepMinutes.textContent = String(value);
  }

  if (dailyCommandOwnerCheckpoints) {
    dailyCommandOwnerCheckpoints.innerHTML = "";
    const list = checkpoints.length
      ? checkpoints
      : ["Assign owner checkpoints for each P0/P1 ticket and post next-update ETAs before the next sweep."];
    for (const checkpoint of list) {
      const li = document.createElement("li");
      li.textContent = checkpoint;
      dailyCommandOwnerCheckpoints.appendChild(li);
    }
  }

  dailyCommandActions.innerHTML = "";
  for (const action of actions) {
    const li = document.createElement("li");
    li.textContent = action;
    dailyCommandActions.appendChild(li);
  }

  dailyCommandTickets.innerHTML = "";
  for (const ticket of tickets) {
    const li = document.createElement("li");
    const priority = typeof ticket?.priority === "string" ? ticket.priority : "P2";
    const risk = typeof ticket?.riskLevel === "string" ? ticket.riskLevel.toUpperCase() : "MEDIUM";
    const subject = typeof ticket?.subject === "string" ? ticket.subject : "Untitled ticket";
    const ticketId = typeof ticket?.ticketId === "string" ? ticket.ticketId : "TICKET";
    const minutes =
      typeof ticket?.minutesUntilBreach === "number" && Number.isFinite(ticket.minutesUntilBreach)
        ? ticket.minutesUntilBreach
        : "?";
    const owner = typeof ticket?.currentOwner === "string" ? ticket.currentOwner : "unassigned";
    const action = typeof ticket?.immediateAction === "string" ? ticket.immediateAction : "Confirm owner and next update ETA.";
    li.textContent = `${priority}/${risk} ${ticketId} (${minutes}m): ${subject}. Owner: ${owner}. Next: ${action}`;
    dailyCommandTickets.appendChild(li);
  }

  dailyCommandOutput.classList.remove("hidden");
  dailyCommandWorkspaceDefaults =
    data?.workspaceDefaults && typeof data.workspaceDefaults === "object" ? data.workspaceDefaults : null;
  dailyCommandRecommendedTicket = data?.recommendedTicket && typeof data.recommendedTicket === "object" ? data.recommendedTicket : null;
  if (commandWorkspaceBtn) {
    commandWorkspaceBtn.disabled = !dailyCommandWorkspaceDefaults;
  }
}

function renderBlueprint(blueprint) {
  matrixBody.innerHTML = "";
  routingList.innerHTML = "";
  signalsList.innerHTML = "";

  blueprintSummary.textContent = blueprint.summary;

  for (const row of blueprint.priorityMatrix) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.priority}</td>
      <td>${row.trigger}</td>
      <td>${row.targetResponseMinutes}</td>
      <td>${row.escalationPath}</td>
    `;
    matrixBody.appendChild(tr);
  }

  for (const item of blueprint.routingRules) {
    const li = document.createElement("li");
    li.textContent = item;
    routingList.appendChild(li);
  }

  for (const signal of blueprint.breachWatchSignals) {
    const li = document.createElement("li");
    li.textContent = signal;
    signalsList.appendChild(li);
  }
}

function renderDecision(decision) {
  decisionCard.classList.remove("hidden");
  decisionActions.innerHTML = "";

  decisionHeadline.textContent = `${decision.priority} / ${decision.riskLevel.toUpperCase()} risk`;
  decisionReason.textContent = decision.reason;
  decisionOwner.textContent = decision.recommendedOwner;
  decisionResponse.textContent = decision.firstResponse;
  decisionEscalation.textContent = decision.escalationMessage;

  for (const action of decision.nextActions) {
    const li = document.createElement("li");
    li.textContent = action;
    decisionActions.appendChild(li);
  }
}

function renderDigest(data) {
  if (!digestOutput) {
    return;
  }

  const topRisks = Array.isArray(data?.topRisks) ? data.topRisks : [];
  const ownerFollowups = Array.isArray(data?.ownerFollowups) ? data.ownerFollowups : [];
  const nextShiftPlan = Array.isArray(data?.nextShiftPlan) ? data.nextShiftPlan : [];

  if (digestHeadline) {
    digestHeadline.textContent = data?.headline || "No digest headline available.";
  }
  if (digestSummary) {
    digestSummary.textContent = data?.summary || "No digest summary available.";
  }

  const renderList = (target, items, fallback) => {
    if (!target) {
      return;
    }
    target.innerHTML = "";
    const lines = items.length ? items : [fallback];
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = String(line);
      target.appendChild(li);
    }
  };

  renderList(digestRisks, topRisks, "No risk entries available.");
  renderList(digestFollowups, ownerFollowups, "No owner follow-up entries available.");
  renderList(digestNextShift, nextShiftPlan, "No next-shift plan entries available.");
  digestOutput.classList.remove("hidden");
}

function applyWorkspaceState(data) {
  currentSessionId = data.sessionId;
  persistSessionId(currentSessionId);
  checkoutUrl = data?.paywall?.paymentUrl || null;
  unlocked = data.subscriptionStatus === "active";
  billingReady = data?.paywall?.billingReady !== false;
  billingMode = data?.paywall?.paymentMode || (billingReady ? "live" : "test");

  renderBlueprint(data.blueprint);
  blueprintSection.classList.remove("hidden");
  triageSection.classList.remove("hidden");
  paymentSection.classList.remove("hidden");
  exportSection.classList.add("hidden");
  exportBtn.disabled = !unlocked;
  if (digestBtn) {
    digestBtn.disabled = !unlocked;
  }
  if (digestOutput && !unlocked) {
    digestOutput.classList.add("hidden");
  }
  checkoutBtn.disabled = !billingReady;
  setProofFormDisabled(!billingReady);

  setStatus(
    workspaceStatus,
    `Workspace ready. Trial remaining: ${data.trialRemainingDays} day(s). Start triaging live tickets now.`,
    "ok"
  );
  if (billingReady) {
    setStatus(paymentStatus, "Checkout is ready when you want to activate subscription.", "neutral");
    return;
  }

  setStatus(
    paymentStatus,
    `Billing is not live yet (mode: ${billingMode}). Checkout is temporarily disabled until production Stripe link is configured.`,
    "error"
  );
}

function applyDemoTicket(ticket) {
  if (!ticket || typeof ticket !== "object") {
    return;
  }
  const entries = Object.entries(ticket);
  for (const [key, value] of entries) {
    const field = ticketForm.elements.namedItem(key);
    if (!field) {
      continue;
    }
    if ("value" in field) {
      field.value = String(value);
    }
  }
}

function collectWorkspaceFromDailyCommand() {
  if (!dailyCommandWorkspaceDefaults || typeof dailyCommandWorkspaceDefaults !== "object") {
    return collectQuickstartPayload();
  }

  return {
    ...dailyCommandWorkspaceDefaults,
    source,
    selfTest
  };
}

async function openWorkspaceFromDailyCommand(options = {}) {
  if (!dailyCommandWorkspaceDefaults) {
    setStatus(dailyCommandStatus, "Run the daily command first.", "error");
    return null;
  }

  const {
    pendingMessage = "Creating workspace from daily command...",
    successMessage = "Workspace created from command. Continue ticket triage below.",
    failedPrefix = "Could not open workspace",
    startAction = "daily_command_workspace_start",
    successAction = "daily_command_workspace_success",
    failedAction = "daily_command_workspace_failed"
  } = options;

  markOnboardingIntent();
  if (commandWorkspaceBtn) {
    commandWorkspaceBtn.disabled = true;
  }
  setStatus(dailyCommandStatus, pendingMessage, "neutral");
  void trackOnboardingAction(startAction);

  try {
    const data = await jsonRequest("/api/workspaces/quickstart", collectWorkspaceFromDailyCommand());
    applyWorkspaceState(data);
    if (dailyCommandRecommendedTicket) {
      applyDemoTicket(dailyCommandRecommendedTicket);
    }
    focusWorkflowSection();
    setStatus(dailyCommandStatus, successMessage, "ok");
    void trackOnboardingAction(successAction, {}, data.sessionId);
    return data;
  } catch (error) {
    setStatus(dailyCommandStatus, `${failedPrefix}: ${error.message}`, "error");
    void trackOnboardingAction(failedAction, {
      error: safeErrorCode(error)
    });
    return null;
  } finally {
    if (commandWorkspaceBtn) {
      commandWorkspaceBtn.disabled = !dailyCommandWorkspaceDefaults;
    }
  }
}

async function restorePersistedWorkspace() {
  const initialSessionId = resolveInitialSessionId();
  if (!initialSessionId) {
    return;
  }

  currentSessionId = initialSessionId;
  try {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(initialSessionId)}`);
    if (!response.ok) {
      throw new Error(response.status === 404 ? "session_not_found" : `http_${response.status}`);
    }
    const data = await response.json();
    applyWorkspaceState(data);
    setStatus(workspaceStatus, "Previous workspace restored. Continue triage below.", "ok");
    void trackOnboardingAction("workspace_restore_success", {}, initialSessionId);
  } catch {
    currentSessionId = null;
    clearSessionPersistence();
    void trackOnboardingAction("workspace_restore_failed", {}, initialSessionId);
  }
}

async function runInstantDemo(trigger) {
  if (!instantDemoBtn) {
    return;
  }

  markOnboardingIntent();
  void trackLandingInteractive(trigger === "auto" ? "instant_demo_auto" : "instant_demo_manual");
  void trackOnboardingAction(trigger === "auto" ? "instant_demo_auto_start" : "instant_demo_manual_start");
  instantDemoBtn.disabled = true;
  setStatus(
    demoStatus,
    trigger === "auto" ? "Launching instant demo..." : "Running instant demo...",
    "neutral"
  );

  try {
    const data = await jsonRequest("/api/demo/instant", {
      source,
      selfTest
    });

    applyWorkspaceState(data);
    applyDemoTicket(data.demoTicket);
    renderDecision(data.demoDecision);
    focusWorkflowSection();
    setStatus(triageStatus, "Instant demo triage is ready. Replace sample data and run your own ticket next.", "ok");
    setStatus(demoStatus, "Instant demo completed. Continue with your real queue data.", "ok");
    void trackOnboardingAction(trigger === "auto" ? "instant_demo_auto_success" : "instant_demo_manual_success", {}, data.sessionId);
  } catch (error) {
    setStatus(demoStatus, `Instant demo failed: ${error.message}`, "error");
    void trackOnboardingAction(trigger === "auto" ? "instant_demo_auto_failed" : "instant_demo_manual_failed", {
      error: safeErrorCode(error)
    });
  } finally {
    instantDemoBtn.disabled = false;
  }
}

function setDailyCommandControlsDisabled(disabled) {
  if (dailyCommandBtn) {
    dailyCommandBtn.disabled = disabled;
  }
  if (dailyCommandSampleBtn) {
    dailyCommandSampleBtn.disabled = disabled;
  }
}

function setZendeskImportControlsDisabled(disabled) {
  if (zendeskImportBtn) {
    zendeskImportBtn.disabled = disabled;
  }
}

async function runDailyCommand(options = {}) {
  if (!dailyCommandForm) {
    return;
  }

  const {
    prefillSample = false,
    interactiveTrigger = "daily_command_submit",
    startAction = "daily_command_submit",
    successAction = "daily_command_success",
    failedAction = "daily_command_failed",
    pendingMessage = "Running daily command...",
    autoOpenWorkspace = false,
    workspaceStartAction = "daily_command_workspace_autorun_start",
    workspaceSuccessAction = "daily_command_workspace_autorun_success",
    workspaceFailedAction = "daily_command_workspace_autorun_failed"
  } = options;

  markOnboardingIntent();
  if (prefillSample) {
    applySampleDailyCommandPreset(true);
  }

  void trackLandingInteractive(interactiveTrigger);
  void trackOnboardingAction(startAction, {
    prefillSample
  });
  setDailyCommandControlsDisabled(true);
  setStatus(dailyCommandStatus, pendingMessage, "neutral");

  try {
    const data = await jsonRequest("/api/daily-command", collectDailyCommandPayload());
    renderDailyCommand(data);
    setStatus(
      dailyCommandStatus,
      `Daily command ready with ${Array.isArray(data?.tickets) ? data.tickets.length : 0} prioritized ticket(s).`,
      "ok"
    );
    void trackOnboardingAction(successAction, {
      prefillSample,
      ticketCount: Array.isArray(data?.tickets) ? data.tickets.length : 0
    });
    if (autoOpenWorkspace && !currentSessionId && dailyCommandWorkspaceDefaults) {
      await openWorkspaceFromDailyCommand({
        pendingMessage: "Daily command ready. Opening trial workspace automatically...",
        successMessage: "Trial workspace opened from your command output. Continue with ticket triage below.",
        failedPrefix: "Auto workspace open failed",
        startAction: workspaceStartAction,
        successAction: workspaceSuccessAction,
        failedAction: workspaceFailedAction
      });
    }
  } catch (error) {
    setStatus(dailyCommandStatus, `Daily command failed: ${error.message}`, "error");
    void trackOnboardingAction(failedAction, {
      prefillSample,
      error: safeErrorCode(error)
    });
  } finally {
    setDailyCommandControlsDisabled(false);
  }
}

async function runZendeskImport() {
  if (!zendeskImportForm) {
    return;
  }

  markOnboardingIntent();
  void trackLandingInteractive("zendesk_import_submit");
  void trackOnboardingAction("zendesk_import_submit");
  setZendeskImportControlsDisabled(true);
  setStatus(zendeskImportStatus, "Importing Zendesk CSV and running daily command...", "neutral");

  try {
    const data = await jsonRequest("/api/daily-command/import-zendesk", collectZendeskImportPayload());
    renderDailyCommand(data);

    const importSummary = data?.importSummary && typeof data.importSummary === "object" ? data.importSummary : {};
    const selectedRows = Number(importSummary?.selectedRows || 0);
    const parsedRows = Number(importSummary?.parsedRows || 0);
    const droppedRows = Number(importSummary?.droppedRows || 0);

    setStatus(
      zendeskImportStatus,
      `Imported ${selectedRows} ticket(s) from ${parsedRows} parsed row(s). Dropped: ${droppedRows}.`,
      "ok"
    );
    setStatus(
      dailyCommandStatus,
      `Daily command ready with ${Array.isArray(data?.tickets) ? data.tickets.length : 0} prioritized ticket(s).`,
      "ok"
    );

    void trackOnboardingAction("zendesk_import_success", {
      parsedRows,
      selectedRows,
      droppedRows
    });

    if (!currentSessionId && dailyCommandWorkspaceDefaults) {
      await openWorkspaceFromDailyCommand({
        pendingMessage: "CSV import complete. Opening trial workspace...",
        successMessage: "Trial workspace opened from imported queue output. Continue triage below.",
        failedPrefix: "CSV import workspace open failed",
        startAction: "zendesk_import_workspace_start",
        successAction: "zendesk_import_workspace_success",
        failedAction: "zendesk_import_workspace_failed"
      });
    }
  } catch (error) {
    setStatus(zendeskImportStatus, `CSV import failed: ${error.message}`, "error");
    void trackOnboardingAction("zendesk_import_failed", {
      error: safeErrorCode(error)
    });
  } finally {
    setZendeskImportControlsDisabled(false);
  }
}

function startAutoSampleDailyCommand(mode = autoRunMode) {
  if (autoRunStarted || onboardingIntentStarted || !autoRun || instant || currentSessionId) {
    return;
  }
  if (document.visibilityState !== "visible") {
    return;
  }
  if ((mode === "first_interaction" || mode === "first_interaction_actionable") && !firstInteractionObserved) {
    return;
  }
  clearFirstInteractionAutoRunTimers();
  autoRunStarted = true;

  const autoRunModeConfig =
    mode === "first_interaction"
      ? {
          statusMessage: "Interaction detected. Running sample queue command and opening a trial workspace...",
          pendingMessage: "Interaction detected. Running sample queue command...",
          interactiveTrigger: "daily_command_first_interaction_autorun",
          startAction: "daily_command_first_interaction_start",
          successAction: "daily_command_first_interaction_success",
          failedAction: "daily_command_first_interaction_failed",
          workspaceStartAction: "daily_command_workspace_first_interaction_start",
          workspaceSuccessAction: "daily_command_workspace_first_interaction_success",
          workspaceFailedAction: "daily_command_workspace_first_interaction_failed"
        }
      : mode === "first_interaction_actionable"
        ? {
            statusMessage: "No workflow started yet. Running sample queue command automatically...",
            pendingMessage: "No workflow selected yet. Running sample queue command...",
            interactiveTrigger: "daily_command_first_interaction_actionable_autorun",
            startAction: "daily_command_first_interaction_actionable_start",
            successAction: "daily_command_first_interaction_actionable_success",
            failedAction: "daily_command_first_interaction_actionable_failed",
            workspaceStartAction: "daily_command_workspace_first_interaction_actionable_start",
            workspaceSuccessAction: "daily_command_workspace_first_interaction_actionable_success",
            workspaceFailedAction: "daily_command_workspace_first_interaction_actionable_failed"
          }
        : mode === "first_interaction_idle"
          ? {
              statusMessage: "Running sample queue command after idle preview...",
              pendingMessage: "No interaction yet. Running sample queue command...",
              interactiveTrigger: "daily_command_first_interaction_idle_autorun",
              startAction: "daily_command_first_interaction_idle_start",
              successAction: "daily_command_first_interaction_idle_success",
              failedAction: "daily_command_first_interaction_idle_failed",
              workspaceStartAction: "daily_command_workspace_first_interaction_idle_start",
              workspaceSuccessAction: "daily_command_workspace_first_interaction_idle_success",
              workspaceFailedAction: "daily_command_workspace_first_interaction_idle_failed"
            }
          : {
              statusMessage: "Running sample queue command automatically...",
              pendingMessage: "Running sample queue command automatically...",
              interactiveTrigger: "daily_command_autorun",
              startAction: "daily_command_autorun_start",
              successAction: "daily_command_autorun_success",
              failedAction: "daily_command_autorun_failed",
              workspaceStartAction: "daily_command_workspace_autorun_start",
              workspaceSuccessAction: "daily_command_workspace_autorun_success",
              workspaceFailedAction: "daily_command_workspace_autorun_failed"
            };

  setStatus(
    dailyCommandStatus,
    autoRunModeConfig.statusMessage,
    "neutral"
  );
  void runDailyCommand({
    prefillSample: true,
    interactiveTrigger: autoRunModeConfig.interactiveTrigger,
    startAction: autoRunModeConfig.startAction,
    successAction: autoRunModeConfig.successAction,
    failedAction: autoRunModeConfig.failedAction,
    pendingMessage: autoRunModeConfig.pendingMessage,
    autoOpenWorkspace: true,
    workspaceStartAction: autoRunModeConfig.workspaceStartAction,
    workspaceSuccessAction: autoRunModeConfig.workspaceSuccessAction,
    workspaceFailedAction: autoRunModeConfig.workspaceFailedAction
  });
}

if (dailyCommandForm && dailyCommandBtn) {
  dailyCommandForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runDailyCommand();
  });
}

if (dailyCommandSampleBtn) {
  dailyCommandSampleBtn.addEventListener("click", async () => {
    await runDailyCommand({
      prefillSample: true,
      interactiveTrigger: "daily_command_sample_click",
      startAction: "daily_command_sample_submit",
      successAction: "daily_command_sample_success",
      failedAction: "daily_command_sample_failed",
      pendingMessage: "Running sample queue command..."
    });
  });
}

if (zendeskImportForm && zendeskImportBtn) {
  zendeskImportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runZendeskImport();
  });
}

workspaceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  markOnboardingIntent();
  void trackLandingInteractive("workspace_submit");
  void trackOnboardingAction("workspace_custom_submit");
  workspaceBtn.disabled = true;
  setStatus(workspaceStatus, "Building SLA workspace...", "neutral");

  try {
    const data = await jsonRequest("/api/workspaces", collectWorkspacePayload());
    applyWorkspaceState(data);
    focusWorkflowSection();
    void trackOnboardingAction("workspace_custom_success", {}, data.sessionId);
  } catch (error) {
    setStatus(workspaceStatus, `Could not create workspace: ${error.message}`, "error");
    void trackOnboardingAction("workspace_custom_failed", {
      error: safeErrorCode(error)
    });
  } finally {
    workspaceBtn.disabled = false;
  }
});

if (quickstartForm && quickstartBtn) {
  quickstartForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const previousSessionId = currentSessionId;
    quickstartBtn.disabled = true;
    setStatus(
      quickstartStatus,
      "Running sample command and opening a quick workspace...",
      "neutral"
    );

    try {
      await runDailyCommand({
        prefillSample: true,
        interactiveTrigger: "quickstart_submit",
        startAction: "quickstart_submit",
        successAction: "quickstart_success",
        failedAction: "quickstart_failed",
        pendingMessage: "Quickstart: running sample queue command...",
        autoOpenWorkspace: true,
        workspaceStartAction: "quickstart_workspace_start",
        workspaceSuccessAction: "quickstart_workspace_success",
        workspaceFailedAction: "quickstart_workspace_failed"
      });

      if (currentSessionId && currentSessionId !== previousSessionId) {
        setStatus(
          quickstartStatus,
          "Quick workspace is ready. Continue with ticket triage and activation below.",
          "ok"
        );
      } else if (currentSessionId) {
        setStatus(quickstartStatus, "Quickstart refreshed your active workspace path.", "ok");
      } else {
        setStatus(
          quickstartStatus,
          "Quickstart could not open workspace automatically. Use section 1 to continue.",
          "error"
        );
      }
    } catch (error) {
      setStatus(quickstartStatus, `Quickstart failed: ${error.message}`, "error");
    } finally {
      quickstartBtn.disabled = false;
    }
  });
}

if (commandWorkspaceBtn) {
  commandWorkspaceBtn.addEventListener("click", async () => {
    await openWorkspaceFromDailyCommand();
  });
}

ticketForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  void trackLandingInteractive("ticket_submit");
  if (!currentSessionId) {
    setStatus(triageStatus, "Create workspace first.", "error");
    return;
  }

  triageBtn.disabled = true;
  setStatus(triageStatus, "Triaging ticket...", "neutral");

  try {
    const data = await jsonRequest("/api/workspaces/triage", collectTicketPayload());
    renderDecision(data.decision);
    setStatus(
      triageStatus,
      `Decision saved (#${data.decisionCount}). Trial remaining: ${data.trialRemainingDays} day(s).`,
      "ok"
    );
  } catch (error) {
    if (error.message === "trial_expired") {
      setStatus(triageStatus, "Trial expired. Activate subscription to continue triage.", "error");
      return;
    }
    setStatus(triageStatus, `Triage failed: ${error.message}`, "error");
  } finally {
    triageBtn.disabled = false;
  }
});

checkoutBtn.addEventListener("click", async () => {
  if (!currentSessionId) {
    setStatus(paymentStatus, "Create workspace first.", "error");
    return;
  }

  if (!billingReady) {
    setStatus(paymentStatus, "Billing is not live yet. Checkout is temporarily disabled.", "error");
    return;
  }

  checkoutBtn.disabled = true;
  setStatus(paymentStatus, "Preparing checkout...", "neutral");

  try {
    const data = await jsonRequest("/api/billing/checkout", {
      sessionId: currentSessionId,
      source,
      selfTest
    });

    const url = data.paymentUrl || checkoutUrl;
    if (!url) {
      throw new Error("missing_payment_url");
    }

    window.open(url, "_blank", "noopener,noreferrer");
    setStatus(paymentStatus, "Checkout opened in a new tab. Submit payment proof after payment.", "ok");
  } catch (error) {
    if (error.message === "billing_not_live") {
      billingReady = false;
      checkoutBtn.disabled = true;
      setProofFormDisabled(true);
      setStatus(
        paymentStatus,
        "Billing is still in Stripe test mode. Checkout is disabled until production billing is configured.",
        "error"
      );
      return;
    }
    setStatus(paymentStatus, `Checkout failed: ${error.message}`, "error");
  } finally {
    if (billingReady) {
      checkoutBtn.disabled = false;
    }
  }
});

proofForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentSessionId) {
    setStatus(paymentStatus, "Create workspace first.", "error");
    return;
  }

  if (!billingReady) {
    setStatus(paymentStatus, "Billing is not live yet. Payment proof is disabled.", "error");
    return;
  }

  proofBtn.disabled = true;
  setStatus(paymentStatus, "Submitting payment proof...", "neutral");

  try {
    const formData = new FormData(proofForm);
    await jsonRequest("/api/billing/proof", {
      sessionId: currentSessionId,
      payerEmail: String(formData.get("payerEmail") || "").trim(),
      transactionId: String(formData.get("transactionId") || "").trim(),
      evidenceUrl: String(formData.get("evidenceUrl") || "").trim(),
      note: String(formData.get("note") || "").trim(),
      source,
      selfTest
    });

    unlocked = true;
    exportBtn.disabled = false;
    if (digestBtn) {
      digestBtn.disabled = false;
    }
    setStatus(paymentStatus, "Payment proof accepted. Digest and export are now unlocked.", "ok");
  } catch (error) {
    setStatus(paymentStatus, `Payment proof failed: ${error.message}`, "error");
  } finally {
    proofBtn.disabled = false;
  }
});

exportBtn.addEventListener("click", async () => {
  if (!currentSessionId || !unlocked) {
    setStatus(paymentStatus, "Activate subscription first.", "error");
    return;
  }

  exportBtn.disabled = true;
  setStatus(paymentStatus, "Building export...", "neutral");

  try {
    const data = await jsonRequest("/api/workspaces/export", {
      sessionId: currentSessionId,
      source,
      selfTest
    });

    exportContent.textContent = data.content || "";
    exportSection.classList.remove("hidden");
    setStatus(paymentStatus, "Export generated.", "ok");
  } catch (error) {
    setStatus(paymentStatus, `Export failed: ${error.message}`, "error");
  } finally {
    exportBtn.disabled = false;
  }
});

if (digestBtn) {
  digestBtn.addEventListener("click", async () => {
    if (!currentSessionId || !unlocked) {
      setStatus(paymentStatus, "Activate subscription first.", "error");
      return;
    }

    digestBtn.disabled = true;
    setStatus(paymentStatus, "Generating daily digest...", "neutral");

    try {
      const data = await jsonRequest("/api/workspaces/digest", {
        sessionId: currentSessionId,
        source,
        selfTest
      });

      renderDigest(data);
      setStatus(paymentStatus, "Daily digest generated.", "ok");
    } catch (error) {
      setStatus(paymentStatus, `Digest failed: ${error.message}`, "error");
    } finally {
      if (unlocked) {
        digestBtn.disabled = false;
      }
    }
  });
}

if (useSamplePrefill) {
  applySampleDailyCommandPreset();
  if (autoRun) {
    setStatus(
      dailyCommandStatus,
      autoRunMode === "first_interaction"
        ? "Sample queue loaded. Interact once to run command automatically."
        : "Sample queue loaded. Running command automatically...",
      "neutral"
    );
  } else {
    setStatus(dailyCommandStatus, "Sample queue loaded. Click Run Daily Command for an immediate brief.", "neutral");
  }
  void trackOnboardingAction("daily_command_prefill_sample_loaded");
}

registerInteractiveTracking((_trigger, target) => {
  if (autoRunMode !== "first_interaction") {
    return;
  }
  if (isActionableInteractionTarget(target)) {
    void trackOnboardingAction("daily_command_first_interaction_actionable_wait");
    clearFirstInteractionActionableFallbackTimer();
    firstInteractionActionableFallbackTimer = window.setTimeout(() => {
      firstInteractionActionableFallbackTimer = null;
      if (autoRunMode !== "first_interaction") {
        return;
      }
      if (autoRunStarted || onboardingIntentStarted || currentSessionId) {
        return;
      }
      if (document.visibilityState !== "visible") {
        return;
      }
      startAutoSampleDailyCommand("first_interaction_actionable");
    }, FIRST_INTERACTION_ACTIONABLE_FALLBACK_DELAY_MS);
    return;
  }
  clearFirstInteractionActionableFallbackTimer();
  window.setTimeout(() => {
    startAutoSampleDailyCommand("first_interaction");
  }, 160);
});
void restorePersistedWorkspace();

if (autoRunMode === "explicit" && !instant) {
  if (document.visibilityState === "visible") {
    window.setTimeout(() => {
      startAutoSampleDailyCommand("explicit");
    }, 350);
  } else {
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      document.removeEventListener("visibilitychange", onVisible);
      startAutoSampleDailyCommand("explicit");
    };
    document.addEventListener("visibilitychange", onVisible);
  }
}

if (autoRunMode === "first_interaction" && !useSamplePrefill) {
  setStatus(
    dailyCommandStatus,
    "Click or tap once to run a sample queue command and open a trial workspace automatically.",
    "neutral"
  );
}

if (autoRunMode === "first_interaction") {
  scheduleFirstInteractionIdleAutoRun();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleFirstInteractionIdleAutoRun();
      return;
    }
    clearFirstInteractionIdleAutoRunTimer();
  });
}

if (advancedDetails) {
  advancedDetails.addEventListener("toggle", () => {
    void trackOnboardingAction(advancedDetails.open ? "advanced_setup_opened" : "advanced_setup_closed");
  });
}

if (instantDemoBtn) {
  instantDemoBtn.addEventListener("click", () => {
    void runInstantDemo("manual");
  });
}

registerTrackedOutboundLink(githubActionInstallLink, "github_action_install_click", "hero");
registerTrackedOutboundLink(githubWorkflowExampleLink, "github_action_workflow_example_click", "hero");
registerTrackedOutboundLink(githubReleaseLink, "github_action_release_click", "hero");

if (instant) {
  void runInstantDemo("auto");
}
