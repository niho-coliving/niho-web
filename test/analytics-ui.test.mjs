import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://manager.example.test" });
for (const key of ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SiteAnalytics } = await import("@niho/web/analytics");
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const meta = (timezone, period = "28d") => {
  const days = period === "7d" ? 7 : 28;
  const shift = (offset) => new Date(Date.parse("2026-10-20T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
  return { range: { start: shift(1 - days), end: shift(0), timezone }, previousRange: { start: shift(1 - 2 * days), end: shift(-days), timezone }, lastUpdatedAt: "2026-10-21T08:00:00+09:00", dataThrough: "2026-10-19" };
};
const metric = (current, previous) => ({ current, previous });
const report = { range: meta("Asia/Tokyo").range, previousRange: meta("Asia/Tokyo").previousRange, sessions: metric(0, null), activeUsers: metric(10, 8), pageViews: metric(11, 9), daily: [{ date: "2026-10-14", sessions: 0 }, { date: "2026-10-15", sessions: null }], sources: [{ name: "自然検索", sessions: metric(0, null) }], topPages: [{ page: { path: "/about", title: "会社概要" }, pageViews: metric(11, 9) }] };
const snapshot = (scope) => ({ ...scope, ga4: { state: "delayed", lastUpdatedAt: meta("Asia/Tokyo").lastUpdatedAt, dataThrough: "2026-10-19", report: { ...report, range: meta("Asia/Tokyo", scope.period).range, previousRange: meta("Asia/Tokyo", scope.period).previousRange } }, searchConsole: { state: "failed" } });
async function setup(adapter) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = async (props = {}) => { await act(async () => root.render(createElement(SiteAnalytics, { projectId: "project_one", siteId: "site_one", adapter, ...props }))); await flush(); };
  await render();
  return { container, render, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
test("UI keeps sources separate, shows zero, missing values and local metadata", async () => {
  const calls = []; const adapter = { loadAnalytics: async (scope, signal) => { calls.push({ scope, signal }); return snapshot(scope); } };
  const app = await setup(adapter);
  try {
    assert.equal(calls[0].scope.period, "28d");
    assert.match(app.container.textContent, /GA4/); assert.match(app.container.textContent, /Search Console/);
    assert.match(app.container.textContent, /セッション0直前の同期間: —/);
    assert.match(app.container.textContent, /Asia\/Tokyo/); assert.match(app.container.textContent, /America\/Los_Angeles|取得失敗/);
    assert.match(app.container.textContent, /会社概要/); assert.equal(app.container.querySelector("a"), null);
    assert.equal(app.container.querySelectorAll("svg").length, 1);
    assert.equal(app.container.querySelectorAll("polyline").length, 1); // null cuts the line
    const option = [...app.container.querySelectorAll("button")].find((node) => node.textContent === "7日");
    await act(async () => option.click()); await flush();
    assert.equal(calls.at(-1).scope.period, "7d"); assert.equal(option.getAttribute("aria-pressed"), "true");
  } finally { await app.cleanup(); }
});
test("bad scope response is hidden and retry loads a valid response", async () => {
  let calls = 0; const adapter = { loadAnalytics: async (scope) => ++calls === 1 ? { ...snapshot(scope), siteId: "wrong_site" } : snapshot(scope) };
  const app = await setup(adapter);
  try {
    assert.match(app.container.textContent, /読み込めませんでした/); assert.doesNotMatch(app.container.textContent, /会社概要/);
    const button = [...app.container.querySelectorAll("button")].find((node) => node.textContent === "再読み込み");
    await act(async () => button.click()); await flush();
    assert.equal(calls, 2); assert.match(app.container.textContent, /会社概要/);
  } finally { await app.cleanup(); }
});
test("a missing calendar day breaks the chart line", async () => {
  const adapter = { loadAnalytics: async (scope) => {
    const result = snapshot(scope);
    return { ...result, ga4: { ...result.ga4, report: { ...result.ga4.report, daily: [{ date: "2026-10-14", sessions: 2 }, { date: "2026-10-16", sessions: 4 }] } } };
  } };
  const app = await setup(adapter);
  try { assert.equal(app.container.querySelectorAll("polyline").length, 2); }
  finally { await app.cleanup(); }
});
test("site switch aborts old read and ignores a late result", async () => {
  let resolveOld, oldSignal, calls = 0;
  const adapter = { loadAnalytics: (scope, signal) => { calls++; if (calls === 1) { oldSignal = signal; return new Promise((resolve) => { resolveOld = resolve; }); } return Promise.resolve({ ...snapshot(scope), ga4: { state: "empty", metadata: meta("Asia/Tokyo") } }); } };
  const app = await setup(adapter);
  try {
    await app.render({ siteId: "site_two" });
    assert.equal(oldSignal.aborted, true);
    assert.match(app.container.textContent, /この期間の集計はありません/);
    await act(async () => resolveOld(snapshot({ projectId: "project_one", siteId: "site_one", period: "28d" })));
    await flush();
    assert.doesNotMatch(app.container.textContent, /会社概要/);
  } finally { await app.cleanup(); }
});
