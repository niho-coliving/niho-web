import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnalyticsPagePath, parseSiteAnalyticsSnapshot, AnalyticsValidationError } from "@niho/web/analytics";

const scope = { projectId: "project_one", siteId: "site_one", period: "7d" };
const meta = (timezone) => ({ range: { start: "2026-10-14", end: "2026-10-20", timezone }, previousRange: { start: "2026-10-07", end: "2026-10-13", timezone }, lastUpdatedAt: "2026-10-21T08:00:00+09:00", dataThrough: "2026-10-19" });
const comparison = (current, previous) => ({ current, previous });
const fixture = () => ({ ...scope,
  ga4: { state: "delayed", lastUpdatedAt: meta("Asia/Tokyo").lastUpdatedAt, dataThrough: "2026-10-19", report: { range: meta("Asia/Tokyo").range, previousRange: meta("Asia/Tokyo").previousRange, sessions: comparison(0, null), activeUsers: comparison(2, 1), pageViews: comparison(3, 2), daily: [{ date: "2026-10-14", sessions: 0 }, { date: "2026-10-15", sessions: null }], sources: [{ name: "自然検索", sessions: comparison(0, null) }], topPages: [{ page: { path: "/about", title: "会社概要" }, pageViews: comparison(3, 2) }] } },
  searchConsole: { state: "available", lastUpdatedAt: meta("America/Los_Angeles").lastUpdatedAt, dataThrough: "2026-10-19", report: { range: meta("America/Los_Angeles").range, previousRange: meta("America/Los_Angeles").previousRange, clicks: comparison(0, null), impressions: comparison(50, 40), ctr: comparison(0, 0.1), averagePosition: comparison(0, 8.2), daily: [{ date: "2026-10-14", clicks: 0, impressions: null }], topPages: [{ page: { path: "/", title: "ホーム" }, clicks: comparison(0, 2), impressions: comparison(50, 40) }] } } });

test("parser accepts independent source reports and keeps zero distinct from null", () => {
  const input = fixture(), parsed = parseSiteAnalyticsSnapshot(input, scope);
  assert.equal(parsed.ga4.report.sessions.current, 0);
  assert.equal(parsed.ga4.report.sessions.previous, null);
  assert.equal(parsed.searchConsole.report.daily[0].impressions, null);
  assert.notEqual(parsed.ga4.report, input.ga4.report);
  assert.equal(parsed.ga4.report.range.timezone, "Asia/Tokyo");
  assert.equal(parsed.searchConsole.report.range.timezone, "America/Los_Angeles");
});
test("scope and period mismatch are rejected before rendering", () => {
  for (const patch of [{ projectId: "project_other" }, { siteId: "site_other" }, { period: "28d" }]) {
    assert.throws(() => parseSiteAnalyticsSnapshot({ ...fixture(), ...patch }, scope), AnalyticsValidationError);
  }
});
test("source states are independent and empty keeps its own metadata", () => {
  const input = fixture(); input.ga4 = { state: "failed" }; input.searchConsole = { state: "empty", metadata: meta("America/Los_Angeles") };
  const parsed = parseSiteAnalyticsSnapshot(input, scope);
  assert.equal(parsed.ga4.state, "failed"); assert.equal(parsed.searchConsole.state, "empty");
  for (const state of ["not-connected", "permission-expired", "failed"]) { input.ga4 = { state }; assert.equal(parseSiteAnalyticsSnapshot(input, scope).ga4.state, state); }
});
test("unsafe paths and malformed source boundaries fail closed", () => {
  for (const path of ["https://evil.test/", "//evil.test/", "/x?query=1", "/x#frag", "/x\nfoo", "/../x", "/%2e%2e/x", "/x\\y"]) {
    assert.throws(() => parseAnalyticsPagePath(path), AnalyticsValidationError, path);
  }
  assert.equal(parseAnalyticsPagePath("/"), "/"); assert.equal(parseAnalyticsPagePath("/safe/path"), "/safe/path");
  const input = fixture(); input.ga4.report.topPages[0].page.path = "//evil.test";
  assert.throws(() => parseSiteAnalyticsSnapshot(input, scope), AnalyticsValidationError);
  const timezoneInput = fixture(); timezoneInput.searchConsole.report.range.timezone = "Asia/Tokyo";
  assert.throws(() => parseSiteAnalyticsSnapshot(timezoneInput, scope), AnalyticsValidationError);
  const datesInput = fixture(); datesInput.ga4.report.daily[0].date = "2026-10-21";
  assert.throws(() => parseSiteAnalyticsSnapshot(datesInput, scope), AnalyticsValidationError);
});
