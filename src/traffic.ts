type EventSnapshot = {
  eventType: string;
  source: string;
  selfTest: boolean;
  details?: Record<string, unknown>;
};

const AUTOMATION_SOURCES = new Set([
  "automation",
  "healthcheck",
  "monitor",
  "monitoring",
  "selfcheck",
  "smoke"
]);

const AUTOMATION_USER_AGENT_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bhttpie\b/i,
  /\bpython-requests\b/i,
  /\bgo-http-client\b/i,
  /\bokhttp\b/i,
  /\bpostmanruntime\b/i,
  /\bnode-fetch\b/i,
  /\baxios\b/i,
  /\bheadlesschrome\b/i,
  /\bappengine-google\b/i,
  /\bgoogleother\b/i,
  /\blet'?s encrypt\b/i,
  /\bl9scan\b/i,
  /\bleakix\b/i,
  /\bvirustotalcloud\b/i,
  /\bcensysinspect\b/i,
  /\buptimerobot\b/i,
  /\bstatuscake\b/i,
  /\bcheckly\b/i,
  /\bhealthcheck\b/i,
  /\bbot\b/i,
  /\bspider\b/i,
  /\bcrawler\b/i
];

export function normalizeUserAgent(raw: unknown): string {
  if (typeof raw !== "string") {
    return "unknown";
  }
  const normalized = raw.trim();
  if (!normalized) {
    return "unknown";
  }
  return normalized.slice(0, 300);
}

export function isLikelyAutomationUserAgent(userAgent: string, acceptHeader = ""): boolean {
  const normalizedUserAgent = normalizeUserAgent(userAgent).toLowerCase();
  if (AUTOMATION_USER_AGENT_PATTERNS.some((pattern) => pattern.test(normalizedUserAgent))) {
    return true;
  }

  const normalizedAccept = acceptHeader.trim().toLowerCase();
  if (
    normalizedAccept &&
    !normalizedAccept.includes("text/html") &&
    (normalizedUserAgent.includes("http-client") || normalizedUserAgent.includes("curl"))
  ) {
    return true;
  }

  return false;
}

function hasBrowserNavigationSignals(details?: Record<string, unknown>): boolean {
  if (!details || typeof details !== "object") {
    return false;
  }

  const acceptLanguage = typeof details.acceptLanguage === "string" ? details.acceptLanguage.trim() : "";
  const secFetchMode = typeof details.secFetchMode === "string" ? details.secFetchMode.trim() : "";
  const secFetchSite = typeof details.secFetchSite === "string" ? details.secFetchSite.trim() : "";
  const secChUa = typeof details.secChUa === "string" ? details.secChUa.trim() : "";

  return Boolean(acceptLanguage || secFetchMode || secFetchSite || secChUa);
}

function hasStrongBrowserSignals(details?: Record<string, unknown>): boolean {
  if (!details || typeof details !== "object") {
    return false;
  }

  const secFetchMode = typeof details.secFetchMode === "string" ? details.secFetchMode.trim() : "";
  const secFetchSite = typeof details.secFetchSite === "string" ? details.secFetchSite.trim() : "";
  const secChUa = typeof details.secChUa === "string" ? details.secChUa.trim() : "";

  return Boolean(secFetchMode || secFetchSite || secChUa);
}

function hasInteractiveTrigger(details?: Record<string, unknown>): boolean {
  if (!details || typeof details !== "object") {
    return false;
  }

  const trigger = typeof details.trigger === "string" ? details.trigger.trim().toLowerCase() : "";
  if (!trigger) {
    return false;
  }

  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/.test(trigger)) {
    return false;
  }

  return true;
}

function parseModernChromiumMajor(userAgent: string): number | null {
  const normalized = userAgent.toLowerCase();
  const match = /(?:chrome|crios|edg)\/(\d{2,3})/.exec(normalized);
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  if (!Number.isInteger(major)) {
    return null;
  }

  return major;
}

function isImpossibleMobileChromiumProfile(userAgent: string): boolean {
  const normalized = userAgent.toLowerCase();
  if (!normalized.includes("android 6.0") && !normalized.includes("android 6.0.1")) {
    return false;
  }

  if (!normalized.includes("nexus 5")) {
    return false;
  }

  const chromiumMajor = parseModernChromiumMajor(userAgent);
  return chromiumMajor !== null && chromiumMajor >= 120;
}

function isLikelySpoofedBrowserAutomation(event: EventSnapshot): boolean {
  const normalizedSource = typeof event.source === "string" ? event.source.trim().toLowerCase() : "";
  if (normalizedSource && normalizedSource !== "direct" && normalizedSource !== "web") {
    return false;
  }

  const userAgent = normalizeUserAgent(event.details?.userAgent).toLowerCase();
  const appearsBrowserLike =
    userAgent.includes("mozilla/5.0") || userAgent.includes("applewebkit") || userAgent.includes("chrome/");
  if (!appearsBrowserLike) {
    return false;
  }

  if (isImpossibleMobileChromiumProfile(userAgent)) {
    return true;
  }

  if (!hasBrowserNavigationSignals(event.details)) {
    return true;
  }

  const chromiumMajor = parseModernChromiumMajor(userAgent);
  if (chromiumMajor !== null && chromiumMajor >= 100 && !hasStrongBrowserSignals(event.details)) {
    return true;
  }

  return false;
}

export function deriveEffectiveSelfTest(event: EventSnapshot): boolean {
  if (event.selfTest) {
    return true;
  }

  if (event.eventType !== "landing_view" && event.eventType !== "landing_interactive") {
    return false;
  }

  const normalizedSource = typeof event.source === "string" ? event.source.trim().toLowerCase() : "";
  if (AUTOMATION_SOURCES.has(normalizedSource)) {
    return true;
  }

  const userAgent = normalizeUserAgent(event.details?.userAgent);
  if (isLikelyAutomationUserAgent(userAgent)) {
    return true;
  }

  if (event.eventType === "landing_interactive") {
    if (isLikelySpoofedBrowserAutomation(event)) {
      return true;
    }

    if (!hasInteractiveTrigger(event.details) && !hasBrowserNavigationSignals(event.details)) {
      return true;
    }

    return false;
  }

  return isLikelySpoofedBrowserAutomation(event);
}
