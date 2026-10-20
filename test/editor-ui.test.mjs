import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageScope } from "@niho/web/core";
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent === text);
const input = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
async function click(text) { const target = button(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }
async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  if (target.tagName !== "SELECT") await act(async () => target.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
  await flush();
}
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const calls = { saves: [], prepares: [], releases: [] }; let stored = structuredClone(options.document ?? fixture), version = "v1";
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" }],
    readDocument: async (target) => ({ document: { ...structuredClone(stored), pageId: target.pageId }, version, releases: [{ revision: 1, label: "最初の公開" }], ...(options.locks ? { locks: options.locks } : {}) }),
    saveDraft: async (request) => {
      calls.saves.push(structuredClone(request));
      if (options.save) return options.save(request);
      stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision };
    },
    prepareRelease: async (request) => { calls.prepares.push(request); return { ...request, confirmationToken: "reviewed-token", domain: options.domain ?? "https://example.test", changes: [{ path: "見出し", before: "現在の見出し", after: "編集した見出し" }] }; },
    release: async (request) => { calls.releases.push(request); return { status: "released", snapshot: { document: stored, version: "released-v3" } }; }
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, ...(options.blocks ? { blocks: options.blocks } : {}) }))); await flush();
  const frame = document.querySelector("iframe"); if (frame) await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
  return { calls, adapter, root, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("three rails edit live text, color, size, position and viewport before draft save", async () => {
  const app = await setup();
  try {
    assert.ok(document.querySelector('[aria-label="サイト・ページ・レイヤー"]'));
    assert.ok(document.querySelector('[aria-label="インスペクタ"]'));
    const frame = document.querySelector("iframe");
    await act(async () => frame.contentDocument.querySelector("h1").dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true })));
    await change(input("テキスト"), "編集した見出し");
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("編集した見出し"));
    assert.equal(button("公開前の確認").disabled, true);
    await click("section · hero"); await change(input("文字色"), "#ff0000"); await change(input("文字サイズ"), "24");
    await change(input("配置の基準"), "absolute"); await change(input("上から"), "12");
    await change(document.querySelector('[aria-label="表示幅"]'), "375"); assert.equal(document.querySelector("iframe").style.width, "375px");
    await click("下書き保存"); assert.equal(app.calls.saves[0].expectedVersion, "v1");
    const saved = app.calls.saves[0].document; assert.equal(saved.body[0].children[0].children[0].text, "編集した見出し");
    assert.equal(saved.body[0].style.base.color, "#ff0000"); assert.equal(saved.body[0].style.base.fontSize, 24); assert.equal(saved.body[0].style.base.top, 12);
    assert.equal(saved.revision, 1); assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-scope]').getAttribute("data-nw-scope"), pageScope({ ...fixture, revision: 2 }));
    assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("invalid URL buffers stay visible, block saving, and can be cancelled", async () => {
  const app = await setup();
  try {
    await click("a · link"); await change(input("リンク先 URL"), "javascript:alert(1)");
    assert.equal(input("リンク先 URL").value, "javascript:alert(1)");
    assert.ok(document.body.textContent.includes("文書のルールに合いません"));
    assert.equal(button("下書き保存").disabled, true);
    assert.equal(document.querySelector("iframe").contentDocument.querySelector("a").getAttribute("href"), "/about");
    await click("入力を取り消す"); assert.equal(input("リンク先 URL").value, "/about");
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
});
test("409 and network failures retain edits, history and expectedVersion for retry", async () => {
  let mode = "conflict";
  const app = await setup({ save: async () => { if (mode === "throw") throw new Error("offline"); if (mode === "throw409") throw { status: 409 }; return mode === "conflict" ? { status: "conflict" } : { status: "saved", version: "v2", revision: 2 }; } });
  try {
    await click("文字: 海のそばで過ごす"); await change(input("テキスト"), "失わない編集");
    await click("下書き保存"); assert.ok(document.body.textContent.includes("409")); assert.equal(input("テキスト").value, "失わない編集");
    mode = "throw"; await click("下書き保存"); assert.ok(document.body.textContent.includes("編集内容を保持しています"));
    mode = "throw409"; await click("下書き保存"); assert.ok(document.body.textContent.includes("409"));
    mode = "saved"; await click("下書き保存"); assert.equal(app.calls.saves.length, 4); assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1"));
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("in-flight save checkpoints the captured document without losing later edits", async () => {
  let finish; let saves = 0;
  const app = await setup({ save: () => ++saves === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ status: "saved", version: "v3", revision: 3 }) });
  try {
    await click("文字: 海のそばで過ごす"); await change(input("テキスト"), "保存開始時"); await click("下書き保存");
    await change(input("テキスト"), "保存中に続けた編集");
    await act(async () => finish({ status: "saved", version: "v2", revision: 2 })); await flush();
    assert.equal(input("テキスト").value, "保存中に続けた編集"); assert.equal(button("下書き保存").disabled, false);
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, true);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, false);
    await click("下書き保存"); assert.equal(app.calls.saves[1].expectedVersion, "v2"); assert.equal(app.calls.saves[1].document.revision, 2); assert.equal(app.calls.saves[1].document.body[0].children[0].children[0].text, "保存中に続けた編集");
    assert.equal(button("下書き保存").disabled, true);
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, true);
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-scope]').getAttribute("data-nw-scope"), pageScope({ ...fixture, revision: 3 }));
  } finally { await app.cleanup(); }
});
test("data-linked props show a lock reason while display props remain editable", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "表示名", count: 5 } });
  const blocks = { Notice: { props: { heading: { type: "string", required: true }, count: { type: "number", required: true } }, lockedProps: { count: "外部データから取得します" }, component: ({ heading, count }) => createElement("p", null, `${heading}: ${count}`) } };
  const app = await setup({ document: doc, blocks });
  try {
    await click("Notice · notice"); assert.equal(input("count").disabled, true); assert.ok(document.body.textContent.includes("ロック: 外部データから取得します"));
    await change(input("heading"), "編集後の表示名"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).props, { heading: "編集後の表示名", count: 5 });
  } finally { await app.cleanup(); }
});
test("publishing and rollback require the allowed domain, authoritative diff and explicit confirmation", async () => {
  const app = await setup();
  try {
    await click("公開前の確認"); assert.ok(document.querySelector('[role="dialog"]'));
    assert.ok(document.body.textContent.includes("https://example.test")); assert.ok(document.body.textContent.includes("現在の見出し"));
    assert.equal(button("この内容を公開").disabled, true); assert.equal(app.calls.releases.length, 0);
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
    await click("この内容を公開"); assert.equal(app.calls.releases[0].confirmationToken, "reviewed-token");
    assert.equal(app.calls.releases[0].expectedVersion, "v1");
  } finally { await app.cleanup(); }
  const invalid = await setup({ domain: "https://other.example" });
  try { await click("公開前の確認"); assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(invalid.calls.releases.length, 0); } finally { await invalid.cleanup(); }
});
test("dirty navigation requires explicit discard and can keep editing", async () => {
  const app = await setup();
  try {
    await change(input("ページタイトル"), "変更したタイトル");
    await change(document.querySelector('[aria-label="ページ"]'), "other/ja-JP");
    assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける"); assert.equal(input("ページタイトル").value, "変更したタイトル");
    await change(document.querySelector('[aria-label="ページ"]'), "other/ja-JP"); await click("変更を破棄して移動");
    assert.equal(document.querySelector('[aria-label="ページ"]').value, "other/ja-JP"); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("rollback uses its own confirmation bound to the selected published revision", async () => {
  const app = await setup();
  try {
    await change(document.querySelector('[aria-label="戻す版"]'), "1"); await click("戻す内容を確認");
    assert.equal(app.calls.prepares[0].action, "rollback"); assert.equal(app.calls.prepares[0].revision, 1);
    assert.equal(button("この版に戻す").disabled, true);
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click()); await click("この版に戻す");
    assert.equal(app.calls.releases[0].action, "rollback"); assert.equal(app.calls.releases[0].revision, 1);
  } finally { await app.cleanup(); }
});
test("discarding a pending invalid buffer resets fields even when the loaded value is unchanged", async () => {
  const app = await setup();
  try {
    await change(input("ページタイトル"), ""); assert.equal(input("ページタイトル").value, "");
    await click("最新の文書を再読込"); await click("変更を破棄して移動");
    assert.equal(input("ページタイトル").value, fixture.title); assert.equal(button("公開前の確認").disabled, false);
  } finally { await app.cleanup(); }
});
test("invalid saved revision responses retain edits and do not advance the optimistic lock", async () => {
  let invalidRevision = 1;
  const app = await setup({ save: async () => ({ status: "saved", version: "v2", revision: invalidRevision }) });
  try {
    await change(input("ページタイトル"), "保持する編集"); await click("下書き保存");
    assert.equal(input("ページタイトル").value, "保持する編集"); assert.equal(button("下書き保存").disabled, false);
    invalidRevision = 2; await click("下書き保存");
    assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1" && request.document.revision === 1));
    assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
