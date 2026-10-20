import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SiteAnalyticsContractError,
  assertSiteAnalyticsTarget,
  parseSearchConsoleVerificationPlan,
  parseSiteAnalyticsChangePlan,
  parseSiteAnalyticsConnection,
  parseSiteAnalyticsReport,
  parseSiteAnalyticsTarget
} from "@niho/web/site-analytics";

const target = { projectId: "project_kamakura", siteId: "site_kamakura", siteOrigin: "https://www.kamakura.example" };
const connection = () => ({
  target: { ...target },
  ga4: { measurementId: "G-8V6DDHH9TV", trackingTagState: "published", propertyId: "487223355", reportingState: "connected", propertyTimeZone: "Asia/Tokyo", lastSyncedAt: "2026-10-20T01:00:00Z" },
  searchConsole: { property: { kind: "url-prefix", value: "https://www.kamakura.example/" }, ownershipState: "verified", verificationMethod: "meta-tag", reportingState: "connected", lastSyncedAt: "2026-10-20T01:00:00Z" }
});
const source = (timeZone, daily = []) => ({ state: daily.length ? "available" : "empty", dataEndDate: "2026-10-18", timeZone, daily, pages: [] });
const report = () => ({
  target: { ...target }, period: "28d", from: "2026-09-21", through: "2026-10-18",
  ga4: source("Asia/Tokyo", [{ date: "2026-10-18", sessions: 0, activeUsers: 0, pageViews: 0 }]),
  searchConsole: source("America/Los_Angeles", [{ date: "2026-10-18", clicks: 0, impressions: 0, ctr: 0, averagePosition: null }])
});

test("target accepts one exact HTTPS origin and rejects paths or credentials", () => {
  assert.deepEqual(parseSiteAnalyticsTarget(target), target);
  for (const siteOrigin of ["http://example.test", "https://user:pass@example.test", "https://example.test/", "https://example.test/path", "//example.test"]) {
    assert.throws(() => parseSiteAnalyticsTarget({ ...target, siteOrigin }), SiteAnalyticsContractError);
  }
});

test("late responses for another project, site, or origin are rejected", () => {
  assert.throws(() => assertSiteAnalyticsTarget({ ...target, siteId: "other_site" }, target), /scope does not match/u);
  assert.throws(() => parseSiteAnalyticsConnection({ ...connection(), target: { ...target, projectId: "other_project" } }, target), /scope does not match/u);
});

test("GA4 measurement ID and reporting property ID remain separate states", () => {
  const parsed = parseSiteAnalyticsConnection(connection(), target);
  assert.equal(parsed.ga4.measurementId, "G-8V6DDHH9TV");
  assert.equal(parsed.ga4.propertyId, "487223355");
  const disconnectedReport = connection();
  disconnectedReport.ga4.reportingState = "not-connected";
  assert.equal(parseSiteAnalyticsConnection(disconnectedReport, target).ga4.trackingTagState, "published");
  assert.throws(() => parseSiteAnalyticsConnection({ ...connection(), ga4: { ...connection().ga4, propertyId: "G-8V6DDHH9TV" } }), SiteAnalyticsContractError);
});

test("Search Console ownership verification is separate from API permission", () => {
  const input = connection();
  input.searchConsole.reportingState = "permission-required";
  assert.equal(parseSiteAnalyticsConnection(input, target).searchConsole.reportingState, "permission-required");
  input.searchConsole.property.value = "https://kamakura.example/";
  assert.equal(parseSiteAnalyticsConnection(input, target).searchConsole.property.value, "https://kamakura.example/");
  assert.throws(() => parseSiteAnalyticsConnection({ ...connection(), oauthAccessToken: "must-not-cross-the-host-boundary" }), /unknown field/u);
});

test("Search Console property scope preserves www, slash, and domain/path distinctions", () => {
  const input = connection();
  assert.equal(parseSiteAnalyticsConnection(input).searchConsole.property.value, "https://www.kamakura.example/");
  input.searchConsole.property = { kind: "domain", value: "sc-domain:kamakura.example" };
  input.searchConsole.verificationMethod = "dns";
  input.searchConsole.reportingState = "property-mismatch";
  assert.equal(parseSiteAnalyticsConnection(input).searchConsole.property.value, "sc-domain:kamakura.example");
  input.searchConsole.property = { kind: "url-prefix", value: "https://www.kamakura.example/pages/" };
  assert.equal(parseSiteAnalyticsConnection(input).searchConsole.property.value, "https://www.kamakura.example/pages/");
  input.searchConsole.reportingState = "connected";
  assert.throws(() => parseSiteAnalyticsConnection(input, target), /exact URL-prefix property/u);
  input.searchConsole.property = { kind: "url-prefix", value: "https://kamakura.example/" };
  assert.throws(() => parseSiteAnalyticsConnection(input, target), /exact URL-prefix property/u);
  for (const value of ["https://www.kamakura.example", "http://www.kamakura.example/", "https://www.kamakura.example/?x=1", "sc-domain:kamakura.example"]) {
    input.searchConsole.property = { kind: "url-prefix", value };
    assert.throws(() => parseSiteAnalyticsConnection(input), SiteAnalyticsContractError);
  }
});

test("Search Console domain properties cannot claim meta-tag verification", () => {
  const input = connection();
  input.searchConsole.property = { kind: "domain", value: "sc-domain:kamakura.example" };
  input.searchConsole.verificationMethod = "meta-tag";
  input.searchConsole.reportingState = "property-mismatch";
  assert.throws(() => parseSiteAnalyticsConnection(input), /domain properties require DNS verification/u);
  input.searchConsole.verificationMethod = "dns";
  assert.equal(parseSiteAnalyticsConnection(input).searchConsole.verificationMethod, "dns");
});

test("UTC timestamps reject impossible calendar dates and clock values", () => {
  for (const lastSyncedAt of [
    "2026-02-30T01:00:00Z",
    "2026-13-01T01:00:00Z",
    "2026-10-20T24:00:00Z",
    "2026-10-20T01:60:00Z",
    "2026-10-20T01:00:60Z"
  ]) {
    const input = connection();
    input.ga4.lastSyncedAt = lastSyncedAt;
    assert.throws(() => parseSiteAnalyticsConnection(input), SiteAnalyticsContractError, lastSyncedAt);
  }
  const valid = connection();
  valid.ga4.lastSyncedAt = "2024-02-29T23:59:59.999Z";
  assert.equal(parseSiteAnalyticsConnection(valid).ga4.lastSyncedAt, "2024-02-29T23:59:59.999Z");
});

test("reports distinguish known zero from unavailable and retain provider date bases", () => {
  const parsed = parseSiteAnalyticsReport(report(), target);
  assert.equal(parsed.ga4.daily[0].sessions, 0);
  assert.equal(parsed.searchConsole.daily[0].clicks, 0);
  assert.equal(parsed.ga4.timeZone, "Asia/Tokyo");
  assert.equal(parsed.searchConsole.timeZone, "America/Los_Angeles");
  const partial = report();
  partial.searchConsole.state = "partial";
  partial.searchConsole.daily[0].clicks = null;
  assert.equal(parseSiteAnalyticsReport(partial, target).searchConsole.daily[0].clicks, null);
  const unavailableAsZero = report();
  unavailableAsZero.ga4.daily[0].sessions = null;
  assert.throws(() => parseSiteAnalyticsReport(unavailableAsZero), SiteAnalyticsContractError);
});

test("report rejects cross-scope rows, query strings, duplicate dates, and query text", () => {
  const wrong = report(); wrong.target.siteOrigin = "https://other.example";
  assert.throws(() => parseSiteAnalyticsReport(wrong, target), /scope does not match/u);
  const withQuery = report(); withQuery.ga4.pages = [{ path: "/?email=user@example.org", sessions: 1, activeUsers: 1, pageViews: 1 }];
  assert.throws(() => parseSiteAnalyticsReport(withQuery), SiteAnalyticsContractError);
  const duplicate = report(); duplicate.ga4.daily.push({ ...duplicate.ga4.daily[0] });
  assert.throws(() => parseSiteAnalyticsReport(duplicate), SiteAnalyticsContractError);
  const hasSearchTerm = report(); hasSearchTerm.searchConsole.queries = ["private query"];
  assert.throws(() => parseSiteAnalyticsReport(hasSearchTerm), SiteAnalyticsContractError);
  const badCtr = report(); badCtr.searchConsole.daily[0].ctr = 1.2;
  assert.throws(() => parseSiteAnalyticsReport(badCtr), SiteAnalyticsContractError);
  const staleAfterRevocation = report(); staleAfterRevocation.ga4.state = "permission-required";
  assert.throws(() => parseSiteAnalyticsReport(staleAfterRevocation), /cannot contain cached rows/u);
});

test("verification plan is bound to the exact project, origin, property, and public method", () => {
  const plan = {
    target: { ...target },
    property: { kind: "url-prefix", value: "https://www.kamakura.example/" },
    publishedOrigin: target.siteOrigin,
    instructions: { method: "meta-tag", name: "google-site-verification", content: "public_code-123" },
    confirmationToken: "one-time-host-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  assert.equal(parseSearchConsoleVerificationPlan(plan, target).instructions.method, "meta-tag");
  assert.throws(() => parseSearchConsoleVerificationPlan({ ...plan, publishedOrigin: "https://other.example" }, target), SiteAnalyticsContractError);
  assert.throws(() => parseSearchConsoleVerificationPlan({ ...plan, instructions: { ...plan.instructions, name: "other" } }, target), SiteAnalyticsContractError);
  assert.throws(() => parseSearchConsoleVerificationPlan({ ...plan, confirmationToken: "expired", expiresAt: "2026-10-20T02:00:00Z" }, target), SiteAnalyticsContractError);
});

test("change plans identify the exact public origin and impact before a confirmed action", () => {
  const plan = {
    target: { ...target },
    action: "connect-ga4",
    publicOrigin: target.siteOrigin,
    summary: "このサイトの閲覧データ接続を確認します。",
    changes: [{ label: "GA4プロパティ", currentValue: null, nextValue: "487223355" }],
    confirmationToken: "one-time-host-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  assert.equal(parseSiteAnalyticsChangePlan(plan, target).changes[0].nextValue, "487223355");
  assert.throws(() => parseSiteAnalyticsChangePlan({ ...plan, publicOrigin: "https://other.example" }, target), SiteAnalyticsContractError);
  assert.throws(() => parseSiteAnalyticsChangePlan({ ...plan, changes: [] }, target), SiteAnalyticsContractError);
});
