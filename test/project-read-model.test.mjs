import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProjectDirectoryResult, parseProjectDashboardResult } from "@niho/web/project-read-model";
import { parseProject } from "@niho/web/projects";
import { at, dashboard, directory, entry, project } from "./project-view-fixtures.mjs";

test("directory preserves separate Project truth and copied, identity-bound host summaries", () => {
  const input = directory(), checked = parseProjectDirectoryResult(input, () => true);
  assert.equal(checked.entries.length, 2);
  assert.equal(checked.entries[0].project.members[0].userId, checked.entries[1].project.members[0].userId);
  assert.deepEqual(parseProject(checked.entries[0].project), project());
  input.entries[0].project.name = "mutated"; input.entries[0].summary.thumbnail.url = "https://evil.example.test/a";
  assert.equal(checked.entries[0].project.name, project().name);
  assert.equal(checked.entries[0].summary.thumbnail.url, "https://assets.example.test/one.png");
  const mismatch = directory(); mismatch.entries[0].summary.siteId = "wrong";
  assert.throws(() => parseProjectDirectoryResult(mismatch, () => true), /identity mismatch/u);
  const mismatchProject = directory(); mismatchProject.entries[0].summary.projectId = "wrong";
  assert.throws(() => parseProjectDirectoryResult(mismatchProject, () => true), /identity mismatch/u);
  assert.throws(() => parseProjectDirectoryResult({ status: "ready", entries: [entry(), entry()] }, () => true), /duplicate/u);
});

test("only safe host-approved preview URLs reach image rendering", () => {
  for (const url of ["javascript:alert(1)", "data:image/svg+xml,test", "https://private.example.test/secret.png", "//evil.example.test/a", "#anchor"]) {
    const input = directory(); input.entries[0].summary.thumbnail.url = url;
    assert.equal(parseProjectDirectoryResult(input, (candidate) => candidate.startsWith("https://assets.example.test/")).entries[0].summary.thumbnail, null);
  }
  const local = directory(); local.entries[0].summary.thumbnail.url = "/public-preview.svg";
  assert.equal(parseProjectDirectoryResult(local, (url) => url === "/public-preview.svg").entries[0].summary.thumbnail.url, "/public-preview.svg");
  assert.equal(parseProjectDirectoryResult(directory(), () => false).entries[0].summary.thumbnail, null);
});

test("published URL must belong to the unique selected Site", () => {
  for (const publishedUrl of ["https://other.example.test", "javascript:alert(1)", "/unscoped", "https://one.example.test@evil.example.test"]) {
    const input = dashboard(); input.overview.data.publishedUrl = publishedUrl;
    assert.throws(() => parseProjectDashboardResult(input, project()), /published URL/u);
  }
  const input = directory(); input.entries[0].summary.publicationStatus = "unpublished";
  assert.throws(() => parseProjectDirectoryResult(input, () => true), /published URL/u);
});

test("dashboard rejects wrong Project/Site, malformed statistics, timestamps, and periods", () => {
  for (const field of ["projectId", "siteId"]) {
    const input = dashboard(); input[field] = "wrong";
    assert.throws(() => parseProjectDashboardResult(input, project()), /identity mismatch/u);
  }
  for (const value of [-1, NaN, Infinity, 1.1, "5", undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const input = dashboard(); input.overview.data.publishedPageCount = value;
    assert.throws(() => parseProjectDashboardResult(input, project()));
  }
  const period = dashboard(); period.analytics.data.period.start = "2026-10-21T00:00:00Z";
  assert.throws(() => parseProjectDashboardResult(period, project()), /period/u);
  const invalidDate = dashboard(); invalidDate.fetchedAt = "2026-10-20";
  assert.throws(() => parseProjectDashboardResult(invalidDate, project()), /timestamp/u);
  for (const value of ["2026-02-30T09:00:00Z", "2026-13-01T09:00:00Z", "2026-10-20T25:00:00Z", "2026-10-20T09:00:00+24:00"]) {
    const malformed = dashboard(); malformed.fetchedAt = value;
    assert.throws(() => parseProjectDashboardResult(malformed, project()), /timestamp/u);
  }
  const extra = dashboard(); extra.overview.data.siteId = "wrong";
  assert.throws(() => parseProjectDashboardResult(extra, project()), /unknown field/u);
});

test("unavailable, disconnected, unknown, true zero and forbidden retain distinct meanings", () => {
  const input = dashboard(); const checked = parseProjectDashboardResult(input, project());
  assert.equal(checked.overview.data.assetBytes, null);
  assert.equal(checked.analytics.data.uniqueVisitors, 0);
  assert.equal(checked.analytics.data.pageViews, null);
  input.overview = { status: "unavailable" }; input.analytics = { status: "disconnected" };
  assert.deepEqual(parseProjectDashboardResult(input, project()), { ...input, fetchedAt: at });
  assert.deepEqual(parseProjectDashboardResult({ status: "forbidden", projectId: "project_one", siteId: "site_one" }, project()), { status: "forbidden", projectId: "project_one", siteId: "site_one" });
  assert.deepEqual(parseProjectDirectoryResult({ status: "forbidden" }, () => true), { status: "forbidden" });
});
