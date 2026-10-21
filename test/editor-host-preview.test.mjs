import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, createContext, useContext, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const context = createContext("missing");
const fixture = { schemaVersion: 1, siteId: "demo", pageId: "home", locale: "en", revision: 1, title: "Synthetic page", tokens: {}, body: [{ type: "element", id: "heading", tag: "h1", children: [{ type: "text", text: "Synthetic heading" }] }] };
const flush = async () => { for (let index = 0; index < 4; index++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); };
async function press(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
const toolbar = (label) => [...document.querySelectorAll(".e-inspector-actions button,.e-preview-exit")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  await flush();
}
async function setup(previewComponent) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const old = { ...structuredClone(fixture), revision: 1, title: "Earlier page" };
  const adapter = {
    listSites: async () => [{ id: "demo", name: "Synthetic site", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "en", title: fixture.title }],
    readDocument: async () => ({ document: structuredClone(fixture), version: "v1" }),
    saveDraft: async () => { throw new Error("No save expected"); },
    prepareRelease: async () => { throw new Error("No release expected"); },
    release: async () => { throw new Error("No release expected"); },
    listRevisions: async () => ({ entries: [{ id: "old", revision: 1, kind: "snapshot", createdAt: "2026-10-20T00:00:00.000Z", label: "Earlier" }] }),
    readRevision: async () => ({ document: old }),
  };
  await act(async () => root.render(createElement(context.Provider, { value: "host context" }, createElement(PageEditor, { adapter, ...(previewComponent ? { previewComponent } : {}) }))));
  await flush();
  const frame = document.querySelector("iframe"); assert.ok(frame, document.body.textContent);
  await act(async () => frame.dispatchEvent(new dom.window.Event("load"))); await flush();
  return { frame, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("an omitted preview component keeps the default iframe renderer", async () => {
  const app = await setup();
  try {
    assert.equal(app.frame.getAttribute("sandbox"), "allow-same-origin");
    assert.equal(app.frame.contentDocument.documentElement.lang, "en");
    assert.equal(app.frame.contentDocument.querySelector("h1").textContent, "Synthetic heading");
    assert.equal(app.frame.contentDocument.querySelector("[data-host-preview]"), null);
  } finally { await app.cleanup(); }
});

test("the host component shares context, current width and read-only preview/history inside the same iframe", async () => {
  function Preview(props) {
    return createElement("section", { "data-host-preview": "", "data-base-version": props.baseVersion, "data-history-id": props.historyRevision?.id ?? "", "data-context": useContext(context), "data-width": props.width, "data-mode": props.mode, "data-readonly": String(props.readOnly), "data-title": props.document.title },
      createElement("form", { "data-host-form": "" }, createElement("button", { type: "submit" }, "Synthetic submit")),
      createElement("a", { href: "/synthetic", "data-host-link": "" }, "Synthetic link"), props.children);
  }
  const app = await setup(Preview);
  const host = () => app.frame.contentDocument.querySelector("[data-host-preview]");
  try {
    assert.equal(document.querySelector("[data-host-preview]"), null);
    assert.equal(host().dataset.context, "host context");
    assert.equal(host().dataset.baseVersion, "v1");
    assert.equal(host().dataset.historyId, "");
    assert.equal(host().dataset.mode, "edit"); assert.equal(host().dataset.readonly, "false");
    assert.equal(host().querySelector("h1").textContent, "Synthetic heading");
    await change(document.querySelector('[aria-label="表示幅"]'), "375"); assert.equal(host().dataset.width, "375");
    const form = app.frame.contentDocument.querySelector("[data-host-form]");
    const submit = new app.frame.contentWindow.Event("submit", { bubbles: true, cancelable: true });
    await act(async () => form.dispatchEvent(submit)); assert.equal(submit.defaultPrevented, true);
    const link = new app.frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => app.frame.contentDocument.querySelector("[data-host-link]").dispatchEvent(link)); assert.equal(link.defaultPrevented, true);
    await press(toolbar("プレビュー")); assert.equal(host().dataset.mode, "preview"); assert.equal(host().dataset.readonly, "true");
    await press(toolbar("編集に戻る")); await press(toolbar("履歴"));
    await press(document.querySelector(".e-version:not(.is-current)"));
    assert.equal(host().dataset.mode, "history"); assert.equal(host().dataset.readonly, "true");
    assert.equal(host().dataset.title, "Earlier page");
    assert.equal(host().dataset.historyId, "old");
  } finally { await app.cleanup(); }
});
