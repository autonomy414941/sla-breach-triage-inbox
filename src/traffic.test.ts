import assert from "node:assert/strict";
import test from "node:test";

import { deriveEffectiveSelfTest, isLikelyAutomationUserAgent } from "./traffic.js";

test("isLikelyAutomationUserAgent flags curl traffic", () => {
  assert.equal(isLikelyAutomationUserAgent("curl/8.5.0"), true);
});

test("isLikelyAutomationUserAgent keeps normal browser traffic external", () => {
  assert.equal(
    isLikelyAutomationUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36",
      "text/html,application/xhtml+xml"
    ),
    false
  );
});

test("isLikelyAutomationUserAgent flags appengine scanners", () => {
  assert.equal(
    isLikelyAutomationUserAgent(
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/112.0.0.0 Safari/537.36 AppEngine-Google; (+http://code.google.com/appengine; appid: s~virustotalcloud)"
    ),
    true
  );
});

test("isLikelyAutomationUserAgent flags googleother crawler traffic", () => {
  assert.equal(
    isLikelyAutomationUserAgent(
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.132 Mobile Safari/537.36 (compatible; GoogleOther)"
    ),
    true
  );
});

test("isLikelyAutomationUserAgent flags letsencrypt validation traffic", () => {
  assert.equal(
    isLikelyAutomationUserAgent("Mozilla/5.0 (compatible; Let's Encrypt validation server; +https://www.letsencrypt.org)"),
    true
  );
});

test("isLikelyAutomationUserAgent flags okhttp traffic", () => {
  assert.equal(isLikelyAutomationUserAgent("okhttp/5.3.0"), true);
});

test("isLikelyAutomationUserAgent flags leakix scanners", () => {
  assert.equal(isLikelyAutomationUserAgent("Mozilla/5.0 (l9scan/2.0.9; +https://leakix.net)"), true);
});

test("isLikelyAutomationUserAgent flags censys scanners", () => {
  assert.equal(isLikelyAutomationUserAgent("Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)"), true);
});

test("deriveEffectiveSelfTest reclassifies automated landing events", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_view",
      source: "direct",
      selfTest: false,
      details: { userAgent: "curl/8.5.0" }
    }),
    true
  );
});

test("deriveEffectiveSelfTest reclassifies automated landing_interactive events", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_interactive",
      source: "web",
      selfTest: false,
      details: { userAgent: "curl/8.5.0" }
    }),
    true
  );
});

test("deriveEffectiveSelfTest keeps browser landing_interactive events external when trigger and browser signals are present", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_interactive",
      source: "web",
      selfTest: false,
      details: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/98.0.4758.82 Safari/537.36",
        trigger: "pointerdown",
        acceptLanguage: "en-US,en;q=0.9",
        secFetchMode: "cors",
        secFetchSite: "same-origin"
      }
    }),
    false
  );
});

test("deriveEffectiveSelfTest reclassifies landing_interactive events missing trigger metadata", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_interactive",
      source: "web",
      selfTest: false,
      details: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/98.0.4758.82 Safari/537.36"
      }
    }),
    true
  );
});

test("deriveEffectiveSelfTest reclassifies browser-spoofed landings with no browser signals", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_view",
      source: "direct",
      selfTest: false,
      details: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36"
      }
    }),
    true
  );
});

test("deriveEffectiveSelfTest keeps browser landings external when browser signals are present", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_view",
      source: "direct",
      selfTest: false,
      details: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0.0.0 Safari/537.36",
        acceptLanguage: "en-US,en;q=0.9",
        secFetchMode: "navigate"
      }
    }),
    false
  );
});

test("deriveEffectiveSelfTest reclassifies modern chromium landings with only accept-language", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_view",
      source: "direct",
      selfTest: false,
      details: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        acceptLanguage: "en-US,en;q=0.9"
      }
    }),
    true
  );
});

test("deriveEffectiveSelfTest reclassifies impossible Android6 + Chrome130 profile", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_view",
      source: "direct",
      selfTest: false,
      details: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        acceptLanguage: "en-US,en;q=0.9",
        secFetchMode: "navigate"
      }
    }),
    true
  );
});

test("deriveEffectiveSelfTest keeps firefox landing external when accept-language is present", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "landing_view",
      source: "direct",
      selfTest: false,
      details: {
        userAgent: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
        acceptLanguage: "en-US,en;q=0.9"
      }
    }),
    false
  );
});

test("deriveEffectiveSelfTest does not reclassify non-landing events", () => {
  assert.equal(
    deriveEffectiveSelfTest({
      eventType: "workspace_created",
      source: "direct",
      selfTest: false,
      details: { userAgent: "curl/8.5.0" }
    }),
    false
  );
});
