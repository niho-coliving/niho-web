import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AnalyticsValidationError, parseSiteAnalyticsSnapshot } from "@niho/web/analytics-data";
import { parseSiteAnalyticsSnapshot as parseFromUi } from "@niho/web/analytics";

test("server and UI export the same analytics parser", () => {
  assert.equal(parseSiteAnalyticsSnapshot, parseFromUi);
  const scope = { projectId: "niho-corporate", siteId: "kamakura", period: "7d" };
  const snapshot = { ...scope, ga4: { state: "not-connected" }, searchConsole: { state: "failed" } };
  assert.deepEqual(parseSiteAnalyticsSnapshot(snapshot, scope), snapshot);
  assert.throws(() => parseSiteAnalyticsSnapshot({ ...snapshot, credential: "unexpected" }, scope), AnalyticsValidationError);
});

test("server entry works when React and React DOM cannot be resolved", () => {
  const loader = `export function resolve(specifier, context, next) {
    if (/^(?:react|react-dom)(?:\\/|$)/.test(specifier)) throw new Error("React is unavailable in the server fixture");
    return next(specifier, context);
  }`;
  const run = (entry) => spawnSync(process.execPath, [
    "--loader", `data:text/javascript,${encodeURIComponent(loader)}`,
    "--input-type=module", "--eval", `const api = await import(${JSON.stringify(entry)}); if (typeof api.parseSiteAnalyticsSnapshot !== 'function') process.exit(2);`,
  ], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" });
  const server = run("@niho/web/analytics-data");
  assert.equal(server.status, 0, server.stderr);
  const ui = run("@niho/web/analytics");
  assert.notEqual(ui.status, 0);
  assert.match(ui.stderr, /React is unavailable in the server fixture/);
});
