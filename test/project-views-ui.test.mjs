import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { dashboard, directory, project } from "./project-view-fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://host.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProjectDirectory } = await import("@niho/web/project-directory");
const { ProjectDashboard } = await import("@niho/web/project-dashboard");
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (name) => [...document.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent) === name);
const click = async (name) => { assert.ok(button(name), name); await act(async () => button(name).click()); await flush(); };
const directoryAdapter = (loadDirectory = async () => directory()) => ({ loadDirectory, isThumbnailUrlAllowed: (url) => url.startsWith("https://assets.example.test/") });
const dashboardAdapter = (loadDashboard = async () => dashboard()) => ({ loadDashboard });
async function setup(Component, inputProps) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), calls = { creates: 0, dashboards: [], editors: [], settings: [], backs: 0 };
  const callbacks = { onCreateProject: () => calls.creates++, onOpenDashboard: (value) => calls.dashboards.push(value), onOpenEditor: (value) => calls.editors.push(value), onOpenSettings: (value, section) => calls.settings.push([value, section]), onBackToProjects: () => calls.backs++ };
  let props = { ...callbacks, ...inputProps };
  const rerender = async (next) => { props = { ...props, ...next }; await act(async () => root.render(createElement(Component, props))); await flush(); };
  await rerender({});
  return { calls, rerender, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function search(value) {
  const input = document.querySelector('input[type="search"]');
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); await flush();
}
const cards = () => [...document.querySelectorAll(".pv-card")];

test("directory is independent from management and supports two Projects, search, sort and scoped routes", async () => {
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter() });
  try {
    assert.equal(document.querySelector(".nw-project-manager"), null);
    assert.equal(cards().length, 2); assert.ok(cards()[0].textContent.includes("twoの"));
    assert.ok(document.body.textContent.includes("共通参加者（架空）"));
    assert.equal(document.querySelectorAll("textarea").length, 0);
    await click("作成"); assert.equal(app.calls.creates, 1);
    await click(`${project("two").name}（${project("two").site.name}）のダッシュボード`); assert.deepEqual(app.calls.dashboards[0], project("two"));
    await act(async () => cards()[0].querySelectorAll(".pv-actions button")[1].click()); assert.equal(app.calls.editors[0].site.id, "site_two");
    await search("one.example.test"); assert.equal(cards().length, 1); assert.ok(cards()[0].textContent.includes("oneの"));
    await search("存在しない名前"); assert.ok(document.body.textContent.includes("条件に一致する"));
    await click("検索解除"); assert.equal(cards().length, 2);
    const select = document.querySelector("select"); await act(async () => { select.value = "name"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.ok(cards()[0].textContent.includes("oneの"));
    const open = button(`${project().name}（${project().site.name}）のダッシュボード`); open.focus(); assert.equal(document.activeElement, open);
    assert.ok([...document.querySelectorAll("button")].every((node) => node.type === "button"));
    const img = cards()[0].querySelector("img"); assert.ok(img.alt); await act(async () => img.dispatchEvent(new Event("error")));
    assert.equal(cards()[0].querySelector("img"), null); assert.ok(cards()[0].textContent.includes("プレビューなし"));
  } finally { await app.cleanup(); }
});

test("directory empty, loading, failed, forbidden and retry states never retain previous cards", async () => {
  let resolveLoad, mode = "loading";
  const adapter = directoryAdapter(async () => {
    if (mode === "loading") return new Promise((resolve) => { resolveLoad = resolve; });
    if (mode === "failed") throw new Error("private internal details");
    if (mode === "forbidden") return { status: "forbidden" };
    return directory();
  });
  const app = await setup(ProjectDirectory, { adapter });
  try {
    assert.ok(document.querySelector('[aria-busy="true"]')); assert.equal(cards().length, 0);
    await act(async () => resolveLoad({ status: "ready", entries: [] })); await flush();
    assert.ok(document.body.textContent.includes("参加中のプロジェクトはまだありません"));
    mode = "ready"; await click("再読込"); assert.equal(cards().length, 2);
    mode = "failed"; await click("再読込"); assert.equal(cards().length, 0); assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(document.body.textContent.includes("private internal"), false);
    mode = "forbidden"; await click("再試行"); assert.ok(document.body.textContent.includes("権限がありません")); assert.equal(cards().length, 0);
    assert.equal(button("エディター"), undefined);
    mode = "ready"; await click("再試行"); assert.equal(cards().length, 2);
  } finally { await app.cleanup(); }
});

test("directory adapter replacement and unmount abort and discard ignored-abort responses", async () => {
  let finishOld, oldSignal;
  const old = directoryAdapter(async (signal) => { oldSignal = signal; return new Promise((resolve) => { finishOld = resolve; }); });
  const app = await setup(ProjectDirectory, { adapter: old });
  try {
    await app.rerender({ adapter: directoryAdapter(async () => ({ status: "ready", entries: [] })) });
    assert.equal(oldSignal.aborted, true);
    await act(async () => finishOld(directory())); await flush(); assert.equal(cards().length, 0);
    let signal;
    await app.rerender({ adapter: directoryAdapter(async (value) => { signal = value; return new Promise(() => {}); }) });
    await app.cleanup(); assert.equal(signal.aborted, true);
  } catch (error) { await app.cleanup(); throw error; }
});

test("returning to the directory restores focus after delayed loading, once per session", async () => {
  let finish;
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter(async () => new Promise((resolve) => { finish = resolve; })), initialFocusProjectId: "project_two" });
  try {
    await act(async () => finish(directory())); await flush();
    assert.equal(document.activeElement.getAttribute("aria-label"), `${project("two").name}（${project("two").site.name}）のダッシュボード`);
    document.querySelector("input").focus(); await search("one");
    assert.equal(document.activeElement, document.querySelector("input"));
    await app.rerender({ adapter: directoryAdapter(), initialFocusProjectId: "project_absent" });
    assert.equal(document.activeElement.classList.contains("pv-open"), false);
  } finally { await app.cleanup(); }
});

test("dashboard shows only selected Site facts, zero versus unknown, analytic dates, and real host actions", async () => {
  const selected = project(); const requests = [];
  const app = await setup(ProjectDashboard, { project: selected, adapter: dashboardAdapter(async (target) => { requests.push(target); return dashboard(); }) });
  try {
    assert.deepEqual(requests, [{ projectId: selected.id, siteId: selected.site.id }]);
    assert.ok(document.body.textContent.includes("公開中")); assert.ok(document.body.textContent.includes("合成ページを更新"));
    assert.equal(document.querySelector(".pv-stats dd").textContent, "7"); assert.equal(document.querySelectorAll(".pv-stats dd")[1].textContent, "未取得");
    assert.equal(document.querySelector('a.pv-link').href, "https://one.example.test/");
    await click("エディター"); assert.deepEqual(app.calls.editors[0], selected);
    await click("サイト設定"); assert.deepEqual(app.calls.settings[0], [selected, "site"]);
    await click("アクセス解析"); assert.equal(button("アクセス解析").getAttribute("aria-current"), "page");
    assert.equal(document.querySelector(".pv-stats dd").textContent, "0"); assert.equal(document.querySelectorAll(".pv-stats dd")[1].textContent, "未取得");
    assert.ok(document.body.textContent.includes("対象期間")); assert.ok(document.body.textContent.includes("解析取得日時")); assert.ok(document.querySelectorAll("time[datetime]").length >= 4);
    await click("解析接続設定"); assert.deepEqual(app.calls.settings[1], [selected, "analytics"]);
    await click("‹ プロジェクト一覧"); assert.equal(app.calls.backs, 1);
    for (const text of ["CMS", "フォーム", "課金"]) assert.equal(document.body.textContent.includes(text), false);
  } finally { await app.cleanup(); }
});

test("dashboard unpublished, empty changes, disconnected Analytics, and partial failure are actionable", async () => {
  const input = dashboard(); input.overview.data = { publicationStatus: "unpublished", publishedUrl: null, lastPublishedAt: null, publishedPageCount: 0, assetBytes: 0, recentChanges: [] }; input.analytics = { status: "disconnected" };
  const app = await setup(ProjectDashboard, { project: project(), adapter: dashboardAdapter(async () => input) });
  try {
    assert.ok(document.body.textContent.includes("未公開")); assert.ok(document.body.textContent.includes("直近の変更はありません")); assert.equal(document.querySelector("a"), null);
    await click("アクセス解析"); assert.ok(document.body.textContent.includes("まだ接続されていません")); assert.equal(document.querySelector(".pv-stats"), null);
    await click("解析接続設定"); assert.equal(app.calls.settings[0][1], "analytics");
    const partial = dashboard(); partial.overview = { status: "unavailable" };
    await app.rerender({ adapter: dashboardAdapter(async () => partial) });
    assert.ok(document.body.textContent.includes("公開情報を取得できませんでした")); assert.ok(button("エディター"));
    await click("アクセス解析"); assert.equal(document.querySelector(".pv-stats dd").textContent, "0");
    partial.analytics = { status: "unavailable" };
    await app.rerender({ adapter: dashboardAdapter(async () => partial) }); await click("アクセス解析");
    assert.ok(document.body.textContent.includes("アクセス解析を取得できませんでした")); assert.ok(button("再試行"));
  } finally { await app.cleanup(); }
});

test("dashboard mismatch, failure and permission loss clear all sensitive facts and actions", async () => {
  let result = dashboard(), fail = false;
  const app = await setup(ProjectDashboard, { project: project(), adapter: dashboardAdapter(async () => { if (fail) throw new Error("secret"); return result; }) });
  try {
    for (const field of ["projectId", "siteId"]) {
      result = dashboard(); result[field] = "mismatch"; await click(button("再読込") ? "再読込" : "再試行");
      assert.ok(document.body.textContent.includes("読み込めませんでした")); assert.equal(button("エディター"), undefined); assert.equal(document.querySelector("a"), null);
    }
    result = dashboard(); await click("再試行"); assert.ok(button("エディター"));
    result = { status: "forbidden", projectId: "project_one", siteId: "site_one" }; await click("再読込");
    assert.ok(document.body.textContent.includes("権限がありません")); assert.equal(document.body.textContent.includes(project().name), false); assert.equal(button("サイト設定"), undefined);
    fail = true; await click("再試行"); assert.ok(document.body.textContent.includes("読み込めませんでした")); assert.equal(document.body.textContent.includes("secret"), false);
  } finally { await app.cleanup(); }
});

test("dashboard Project/Site switching, adapter replacement and unmount discard stale results", async () => {
  const pending = []; const adapter = dashboardAdapter(async (target, signal) => new Promise((resolve) => pending.push({ target, signal, resolve })));
  const selected = project(), next = project("two");
  const app = await setup(ProjectDashboard, { project: selected, adapter });
  try {
    await app.rerender({ project: next }); assert.equal(pending[0].signal.aborted, true);
    await act(async () => pending[1].resolve(dashboard(next))); await flush();
    await act(async () => pending[0].resolve(dashboard(selected))); await flush();
    assert.ok(document.body.textContent.includes(next.name)); assert.equal(document.body.textContent.includes(selected.name), false);
    await app.rerender({ adapter: dashboardAdapter(async () => ({ status: "forbidden", projectId: next.id, siteId: next.site.id })) });
    assert.equal(button("エディター"), undefined);
    await app.rerender({ adapter }); const last = pending.at(-1); await app.cleanup(); assert.equal(last.signal.aborted, true);
    await act(async () => last.resolve(dashboard(next))); await flush();
  } catch (error) { await app.cleanup(); throw error; }
});

test("long Japanese names and URLs remain complete and the stylesheet defines 320px-friendly layouts", async () => {
  const input = directory(); input.entries[0].project.name = "長い日本語のプロジェクト".repeat(8); input.entries[0].project.site.domains = [`https://${"long".repeat(15)}.example.test`]; input.entries[0].summary.publishedUrl = input.entries[0].project.site.domains[0];
  input.entries[0].summary.updatedAt = null;
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter(async () => input) });
  try {
    assert.ok(document.body.textContent.includes(input.entries[0].project.name)); assert.ok(document.body.textContent.includes(input.entries[0].project.site.domains[0]));
    const css = document.querySelector("style").textContent; assert.ok(css.includes("overflow-wrap:anywhere")); assert.ok(css.includes("@media(max-width:600px)")); assert.ok(css.includes("grid-template-columns:86px minmax(0,1fr)")); assert.ok(css.includes(":focus-visible"));
  } finally { await app.cleanup(); }
});
