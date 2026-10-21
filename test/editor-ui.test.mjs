import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { pageScope, parsePageDocument } from "@niho/web/core";
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { PageEditor } = await import("@niho/web/editor");
const { createMemoryAssetLibrary } = await import("../examples/memory-asset-library.mjs");
const { renderPageToHtml } = await import("@niho/web/server");
const { parseResolvedAssets, uniqueAssetReferences } = await import("@niho/web/assets");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
test("editor CSS remains literal in server-rendered HTML", () => {
  const html = renderToString(createElement(PageEditor, { adapter: {} }));
  const stylesheet = html.match(/<style>([^]*?)<\/style>/)?.[1];
  assert.ok(stylesheet?.includes('"Segoe UI"'));
  assert.ok(!stylesheet.includes("&quot;"));
});
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent === text);
const input = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
async function click(text) { const target = button(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }
async function editorTab(name) { const target = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name); assert.ok(target, name); if (target.getAttribute("aria-selected") !== "true") await act(async () => target.click()); await flush(); }
const pageRow = (title) => [...document.querySelectorAll("button.e-page")].find((node) => node.querySelector(".e-page-name")?.textContent === title);
async function clickPage(title) { const target = pageRow(title); assert.ok(target, title); await act(async () => target.click()); await flush(); }
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
  const calls = { reads: [], saves: [], prepares: [], releases: [] }; let stored = structuredClone(options.document ?? fixture), version = "v1";
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" }],
    readDocument: async (target) => { calls.reads.push(structuredClone(target)); return { document: { ...structuredClone(stored), pageId: target.pageId }, version, releases: [{ revision: 1, label: "最初の公開" }], ...(options.locks ? { locks: options.locks } : {}), ...(options.readOnly ? { readOnly: options.readOnly } : {}) }; },
    saveDraft: async (request) => {
      calls.saves.push(structuredClone(request));
      if (options.save) return options.save(request);
      stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision };
    },
    prepareRelease: async (request) => { calls.prepares.push(request); return { ...request, confirmationToken: "reviewed-token", domain: options.domain ?? "https://example.test", changes: [{ path: "見出し", before: "現在の見出し", after: "編集した見出し" }] }; },
    release: async (request) => { calls.releases.push(request); return { status: "released", snapshot: { document: stored, version: "released-v3" } }; },
    ...options.adapter
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.insertableBlocks ? { insertableBlocks: options.insertableBlocks } : {}), ...(options.assets ? { assets: options.assets } : {}), ...options.props }))); await flush();
  const frame = document.querySelector("iframe"); if (frame) await act(async () => frame.dispatchEvent(new dom.window.Event("load")));
  return { calls, adapter, root, stored: () => stored, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("editor opens the page tree in a full-width quiet workspace", async () => {
  const app = await setup();
  try {
    assert.equal(document.querySelector('.e-tools button[title="ページ"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[aria-label="ページ一覧"]').hidden, false);
    assert.equal(document.querySelector('[aria-label="要素を追加"]').hidden, true);
    assert.ok(pageRow("ホーム")); assert.ok(document.querySelector('.e-canvas-tools select[aria-label="表示幅"]'));
    const css = document.querySelector(".nw-editor style").textContent;
    assert.ok(css.includes("min-height:100vh")); assert.ok(css.includes("grid-template-columns:364px minmax(0,1fr) 320px")); assert.ok(css.includes("@media(max-width:1150px){.nw-editor .e-body{grid-template-columns:300px minmax(0,1fr) 300px}"));
    assert.ok(css.includes("max-height:none;background:#f5f7f5")); assert.ok(css.includes("@media(max-width:800px)"));
  } finally { await app.cleanup(); }
});

test("three rails edit live text, color, size, position and viewport before draft save", async () => {
  const app = await setup();
  try {
    assert.ok(document.querySelector('[aria-label="サイト・ページ・レイヤー"]'));
    assert.ok(document.querySelector('[aria-label="インスペクタ"]'));
    const frame = document.querySelector("iframe");
    await act(async () => frame.contentDocument.querySelector("h1").dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true })));
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["テキスト", "ボックス", "変形", "設定"]);
    assert.equal(document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]').textContent, "テキスト");
    assert.equal(button("直し終える"), undefined);
    const textTab = document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]');
    await act(async () => textTab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await flush(); assert.equal(document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]').textContent, "ボックス");
    assert.equal(document.activeElement.textContent, "ボックス"); assert.ok(input("幅")); assert.equal(input("テキスト"), undefined);
    await editorTab("設定"); assert.ok(input("文字の種類"));
    await editorTab("テキスト");
    await change(input("テキスト"), "編集した見出し");
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("編集した見出し"));
    assert.equal(button("公開前の確認").disabled, true);
    await click("section · hero"); await editorTab("テキスト"); await change(input("文字色"), "#ff0000"); await change(input("文字サイズ"), "24");
    await editorTab("ボックス"); await change(input("配置の基準"), "absolute"); await change(input("上から"), "12");
    await change(document.querySelector('[aria-label="表示幅"]'), "375"); assert.equal(document.querySelector("iframe").style.width, "375px");
    await click("下書き保存"); assert.equal(app.calls.saves[0].expectedVersion, "v1"); assert.equal("trigger" in app.calls.saves[0], false);
    const saved = app.calls.saves[0].document; assert.equal(saved.body[0].children[0].children[0].text, "編集した見出し");
    assert.equal(saved.body[0].style.base.color, "#ff0000"); assert.equal(saved.body[0].style.base.fontSize, 24); assert.equal(saved.body[0].style.base.top, 12);
    assert.equal(saved.revision, 1); assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-scope]').getAttribute("data-nw-scope"), pageScope({ ...fixture, revision: 2 }));
    assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("host adapters receive only the documented editor target fields", async () => {
  const app = await setup(), target = { siteId: "demo", pageId: "home", locale: "ja-JP" };
  try {
    assert.deepEqual(app.calls.reads[0], target);
    await change(input("ページタイトル"), "変更したタイトル"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].target, target);
    await click("公開前の確認"); assert.deepEqual(app.calls.prepares[0].target, target);
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
    await click("この内容を公開"); assert.deepEqual(app.calls.releases[0].target, target);
  } finally { await app.cleanup(); }
});
test("read-only documents stay selectable and navigable but block every document write path", async () => {
  const recoveryCalls = { read: 0, write: 0, remove: 0 }, recovery = {
    read: async () => { recoveryCalls.read++; return null; }, write: async () => { recoveryCalls.write++; }, remove: async () => { recoveryCalls.remove++; }
  };
  const revision = { id: "rev-one", revision: 1, kind: "draft", createdAt: "2026-10-21T00:00:00.000Z" };
  const readOnly = { reason: "公開テキストの原文は業務編集画面が正本です。", editUrl: "/staff/business/public-text/home", editLabel: "業務原稿を編集" };
  const app = await setup({ readOnly, props: { recovery }, adapter: {
    preparePageChange: async () => { throw new Error("must not prepare"); }, applyPageChange: async () => { throw new Error("must not apply"); },
    listRevisions: async () => ({ entries: [revision] }), readRevision: async () => ({ document: structuredClone(fixture) }),
    createSnapshot: async () => { throw new Error("must not snapshot"); }
  } });
  try {
    assert.ok(document.body.textContent.includes("原文（読み取り専用）")); assert.ok(document.body.textContent.includes(readOnly.reason));
    const canonical = [...document.querySelectorAll("a")].find((node) => node.textContent === "業務原稿を編集"); assert.equal(canonical?.getAttribute("href"), readOnly.editUrl);
    assert.equal(input("ページタイトル").disabled, true); assert.equal(button("下書き保存").disabled, true); assert.equal(button("公開前の確認").disabled, true);
    const openTool = async (name) => { const target = [...document.querySelectorAll(".e-tools button")].find((node) => node.querySelector("small")?.textContent === name); assert.ok(target); await act(async () => target.click()); await flush(); };
    await openTool("レイヤー"); const heading = button("h1 · heading"); assert.equal(heading.disabled, false); await act(async () => heading.click()); await flush(); assert.equal(input("テキスト").disabled, true);
    await openTool("ページ"); assert.equal(document.querySelector('button[aria-label="ページを追加"]').disabled, true); assert.equal(document.querySelector('button[aria-label="ホーム の操作"]').disabled, true);
    await click("履歴"); await act(async () => [...document.querySelectorAll("button")].find((node) => node.textContent.includes("2026/10/21"))?.click()); await flush();
    assert.equal(button("この版を復元").disabled, true); assert.ok(document.body.textContent.includes(readOnly.reason));
    assert.deepEqual(recoveryCalls, { read: 0, write: 0, remove: 0 }); assert.equal(app.calls.saves.length, 0); assert.equal(app.calls.prepares.length, 0);
  } finally { await app.cleanup(); }
});
test("invalid URL buffers stay visible, block saving, and can be cancelled", async () => {
  const app = await setup();
  try {
    await click("a · link"); await editorTab("設定"); await change(input("リンク先 URL"), "javascript:alert(1)");
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
    await click("Notice · notice"); await editorTab("設定"); assert.equal(input("count").disabled, true); assert.ok(document.body.textContent.includes("ロック: 外部データから取得します"));
    await change(input("heading"), "編集後の表示名"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).props, { heading: "編集後の表示名", count: 5 });
  } finally { await app.cleanup(); }
});
test("host can hide business block insertion while retaining existing block editing", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "Before" } });
  const blocks = { Notice: { props: { heading: { type: "string", required: true } }, component: ({ heading }) => createElement("p", null, heading) } };
  const app = await setup({ document: doc, blocks, insertableBlocks: [] });
  try {
    assert.equal(document.querySelector('select[aria-label="追加する要素"] option[value="block:Notice"]'), null);
    await click("Notice · notice"); await editorTab("設定"); await change(input("heading"), "After"); await click("下書き保存");
    assert.equal(app.calls.saves[0].document.body.at(-1).props.heading, "After");
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
    await clickPage("別ページ");
    assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける"); assert.equal(input("ページタイトル").value, "変更したタイトル");
    await clickPage("別ページ"); await click("変更を破棄して移動");
    assert.equal(pageRow("別ページ").getAttribute("aria-current"), "page"); assert.equal(app.calls.reads.at(-1).pageId, "other"); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});
test("rollback uses its own confirmation bound to the selected published revision", async () => {
  const app = await setup();
  try {
    await change(document.querySelector('[aria-label="戻す版"]'), "1"); await click("戻す内容を確認");
    assert.equal(app.calls.prepares[0].action, "rollback"); assert.equal(app.calls.prepares[0].revision, 1);
    assert.equal(button("この版に戻す").disabled, true);
    assert.ok(!document.querySelector('[role="dialog"]').textContent.includes("検索結果に出る情報"));
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

const sitePages = () => [
  { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" },
  { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about" },
  { siteId: "demo", pageId: "badminton", locale: "ja-JP", title: "バドミントン", path: "/circles/badminton" },
  { siteId: "demo", pageId: "go", locale: "ja-JP", title: "囲碁", path: "/circles/kamakura-go", visibility: "private" },
  { siteId: "demo", pageId: "experience", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template" },
  { siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared" }
];
/** ページ操作とサイト設定を実装したホスト。 */
function pageHost(overrides = {}) {
  const calls = { lists: 0, prepares: [], applies: [], settingsReads: 0, settingsSaves: [] };
  let pages = sitePages(), settings = { title: "デモサイト", description: "サイトの説明", locale: "ja" }, settingsVersion = 1;
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"], structuredData: [{ id: "organization", label: "組織", description: "運営者の名前とロゴ" }] }, { id: "second", name: "別サイト", domains: ["https://second.example.test"] }],
    listPages: async (siteId) => { calls.lists++; return siteId === "demo" ? structuredClone(pages) : [{ siteId, pageId: "home", locale: "ja-JP", title: "別のホーム", path: "/" }]; },
    preparePageChange: async (change) => {
      calls.prepares.push(structuredClone(change));
      return overrides.prepare?.(change) ?? { change, confirmationToken: "page-token", domain: "https://example.test", impact: { before: "https://example.test/about", after: "https://example.test/company",
        redirect: { from: "https://example.test/about", to: "https://example.test/company" }, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 2 }], navigation: ["ヘッダー"], notes: ["sitemap の URL が変わります。"] } };
    },
    applyPageChange: async (plan) => {
      calls.applies.push(structuredClone(plan));
      if (overrides.apply) return overrides.apply(plan);
      pages = pages.map((page) => page.pageId === plan.change.target.pageId ? { ...page, title: plan.change.title, path: plan.change.path } : page);
      return { status: "applied", page: pages.find((page) => page.pageId === plan.change.target.pageId) };
    },
    readSiteSettings: async () => { calls.settingsReads++; return { settings: structuredClone(settings), version: `s${settingsVersion}` }; },
    saveSiteSettings: async (request) => {
      calls.settingsSaves.push(structuredClone(request));
      if (overrides.saveSettings) return overrides.saveSettings(request);
      if (request.expectedVersion !== `s${settingsVersion}`) return { status: "conflict" };
      settings = request.settings; settingsVersion++; return { status: "saved", version: `s${settingsVersion}` };
    }
  };
  return { calls, adapter, setSettings: (next) => { settings = next; settingsVersion++; } };
}
const dialog = () => document.querySelector('[role="dialog"]');
/** 右レールの対象セレクタから「ページ」「サイト」を開き、その内容を返す。 */
async function panel(name) {
  const select = document.querySelector('.e-inspector-context select[aria-label="編集する対象"]');
  assert.ok(select, name); await change(select, name === "ページ" ? "page" : "site");
  return document.querySelector(".e-right .e-inspector-content");
}
const inputIn = (root, text) => [...root.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
const buttonIn = (root, text) => [...root.querySelectorAll("button")].find((node) => node.textContent === text);
async function press(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
const treeShape = (list = document.querySelector(".e-page-tree")) => [...list.children].map((item) => {
  const folder = item.querySelector(":scope > .e-folder");
  return folder ? { [folder.textContent]: treeShape(item.querySelector(":scope > ul")) } : item.querySelector(".e-page-name").textContent;
});

test("page panel shows the path tree, kinds, states and counts, and selecting a row loads that page", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    assert.equal(document.querySelector('[aria-label="ページ"]')?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(treeShape(), ["ホーム", "私たちについて", { circles: ["バドミントン", "囲碁"] }, { experiences: ["体験詳細"] }, "ヘッダー"]);
    assert.equal(pageRow("ホーム").getAttribute("aria-current"), "page"); assert.ok(pageRow("ホーム").textContent.includes("/"));
    assert.ok(pageRow("囲碁").textContent.includes("/circles/kamakura-go")); assert.ok(pageRow("囲碁").textContent.includes("非公開"));
    assert.ok(pageRow("体験詳細").textContent.includes("テンプレート")); assert.ok(pageRow("ヘッダー").textContent.includes("共通枠"));
    assert.ok(document.body.textContent.includes("公開中 3 / 4 ページ"));
    assert.equal(document.querySelector('[aria-label="体験詳細 の操作"]'), null); assert.equal(document.querySelector('[aria-label="ヘッダー の操作"]'), null);
    assert.ok(document.querySelector('[aria-label="私たちについて の操作"]'));
    const folder = [...document.querySelectorAll(".e-folder")].find((node) => node.textContent === "circles");
    assert.equal(folder.getAttribute("aria-expanded"), "true"); await press(folder);
    assert.equal(folder.getAttribute("aria-expanded"), "false"); assert.equal(pageRow("バドミントン"), undefined); await press(folder);
    await clickPage("私たちについて");
    assert.deepEqual(app.calls.reads.at(-1), { siteId: "demo", pageId: "about", locale: "ja-JP" }); assert.equal(pageRow("私たちについて").getAttribute("aria-current"), "page");
    await press(document.querySelector('[aria-label="検索"]'));
    await change(document.querySelector('input[aria-label="ページを検索"]'), "circles");
    assert.deepEqual(treeShape(), ["バドミントン", "囲碁"]);
    await change(document.querySelector('input[aria-label="ページを検索"]'), "存在しない");
    assert.ok(document.body.textContent.includes("一致するページはありません"));
    await press(document.querySelector('[aria-label="検索"]')); assert.equal(document.querySelector('input[aria-label="ページを検索"]'), null);
    assert.equal(treeShape().length, 5);
  } finally { await app.cleanup(); }
});

test("public information edits are undoable document edits saved in meta", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const page = await panel("ページ");
    await change(inputIn(page, "説明文"), "海のそばの暮らしを\n紹介します。");
    assert.equal(document.querySelector('[role="status"]').textContent, "未保存の変更あり");
    assert.ok(page.textContent.includes("16 / 500")); assert.ok(page.textContent.includes("検索結果に表示される文章です。"));
    assert.equal(buttonIn(page, "画像を選ぶ"), undefined); assert.equal(inputIn(page, "画像 URL").closest("details"), null);
    await change(inputIn(page, "画像 URL"), "javascript:alert(1)");
    assert.ok(page.textContent.includes("URL は https:// か / から始まる形式")); assert.equal(button("下書き保存").disabled, true);
    await change(inputIn(page, "画像 URL"), "/cover.jpg"); await change(inputIn(page, "画像の説明"), "海の写真");
    await act(async () => [...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("noindex")).querySelector("input").click()); await flush();
    await act(async () => [...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("組織")).querySelector("input").click()); await flush();
    assert.ok(page.textContent.includes("検索エンジンには表示されません"));
    assert.ok(page.textContent.includes("https://example.test/")); assert.ok(page.textContent.includes("海のそばの暮らしを 紹介します。"));
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.meta, { description: "海のそばの暮らしを 紹介します。", ogImage: { src: "/cover.jpg", alt: "海の写真" }, noindex: true, structuredData: ["organization"] });
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    assert.equal([...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("組織")).querySelector("input").checked, false);
  } finally { await app.cleanup(); }
});

test("unsupported structured data stays visible and can be removed", async () => {
  const doc = { ...structuredClone(fixture), meta: { structuredData: ["event"] } };
  const host = pageHost(), app = await setup({ document: doc, adapter: host.adapter });
  try {
    const page = await panel("ページ"); assert.ok(page.textContent.includes("未対応: event"));
    await press(page.querySelector('[aria-label="event を外す"]'));
    await click("下書き保存"); assert.equal("meta" in app.calls.saves[0].document, false);
  } finally { await app.cleanup(); }
});

test("renaming a page validates input, reviews impact, applies the exact plan and reloads", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]'));
    assert.ok(document.querySelector('[role="menu"]')); await press(button("名前とURLを変更"));
    assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて"); assert.equal(inputIn(dialog(), "URL パス").value, "/about");
    assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "URL パス"), "/About");
    assert.match(dialog().querySelector('[role="alert"]').textContent, /半角英小文字/); assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "URL パス"), "/experiences/kayak");
    assert.match(dialog().querySelector('[role="alert"]').textContent, /テンプレート「体験詳細」/);
    assert.equal(host.calls.prepares.length, 0);
    await change(inputIn(dialog(), "URL パス"), "/company"); assert.equal(dialog().querySelector('[role="alert"]'), null);
    await press(buttonIn(dialog(), "影響を確認"));
    assert.deepEqual(host.calls.prepares[0], { action: "update", target: { siteId: "demo", pageId: "about", locale: "ja-JP" }, title: "私たちについて", path: "/company" });
    const text = dialog().textContent;
    for (const expected of ["https://example.test", "https://example.test/about", "https://example.test/company", "ホーム · 2 件", "ヘッダー", "sitemap の URL が変わります。"]) assert.ok(text.includes(expected), expected);
    assert.equal(buttonIn(dialog(), "変更を反映").disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    const lists = host.calls.lists; await press(buttonIn(dialog(), "変更を反映"));
    assert.equal(host.calls.applies.length, 1);
    assert.deepEqual(host.calls.applies[0], { change: host.calls.prepares[0], confirmationToken: "page-token", domain: "https://example.test", impact: { before: "https://example.test/about", after: "https://example.test/company",
      redirect: { from: "https://example.test/about", to: "https://example.test/company" }, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 2 }], navigation: ["ヘッダー"], notes: ["sitemap の URL が変わります。"] } });
    assert.equal(dialog(), null); assert.equal(host.calls.lists, lists + 1);
    assert.ok(document.body.textContent.includes("ページ名とURLを変更しました。"));
    assert.deepEqual(app.calls.reads.at(-1), { siteId: "demo", pageId: "about", locale: "ja-JP" });
    assert.ok(pageRow("私たちについて").textContent.includes("/company")); assert.equal(pageRow("私たちについて").getAttribute("aria-current"), "page");
  } finally { await app.cleanup(); }
});

test("page edits stay disabled while the page list reloads after an applied change", async () => {
  const host = pageHost(), listPages = host.adapter.listPages;
  let waitForList = false, releaseList;
  const listGate = new Promise((resolve) => { releaseList = resolve; });
  host.adapter.listPages = async (...args) => {
    if (waitForList) { waitForList = false; await listGate; }
    return listPages(...args);
  };
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]'));
    await press(button("名前とURLを変更"));
    await change(inputIn(dialog(), "URL パス"), "/company");
    await press(buttonIn(dialog(), "影響を確認"));
    await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    waitForList = true;
    await press(buttonIn(dialog(), "変更を反映"));
    assert.equal(dialog(), null);
    assert.equal(input("ページタイトル").disabled, true);
    assert.equal(button("要素を追加").disabled, true);
    await act(async () => releaseList()); await flush();
    assert.equal(input("ページタイトル").disabled, false);
  } finally { releaseList(); await app.cleanup(); }
});

test("page change conflicts keep inputs and reload the list; unknown results are not retried", async () => {
  let mode = "conflict";
  const host = pageHost({ apply: async () => { if (mode === "throw") throw new Error("offline"); return { status: "conflict" }; } }), app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("複製"));
    assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて のコピー"); assert.equal(inputIn(dialog(), "URL パス").value, "/about-copy");
    await change(inputIn(dialog(), "URL パス"), "/company");
    await press(buttonIn(dialog(), "影響を確認")); await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    const lists = host.calls.lists; await press(buttonIn(dialog(), "変更を反映"));
    assert.ok(dialog()); assert.match(dialog().textContent, /競合しました（409）/);
    assert.equal(inputIn(dialog(), "URL パス").value, "/company"); assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて のコピー"); assert.equal(host.calls.lists, lists + 1);
    mode = "throw"; await press(buttonIn(dialog(), "影響を確認")); await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    await press(buttonIn(dialog(), "変更を反映"));
    assert.match(dialog().textContent, /反映されたか確認できません/); assert.equal(buttonIn(dialog(), "変更を反映"), undefined);
    const reads = app.calls.reads.length; await press(buttonIn(dialog(), "ページ一覧を再読込"));
    assert.equal(dialog(), null); assert.equal(app.calls.reads.length, reads + 1); assert.equal(host.calls.applies.length, 2);
  } finally { await app.cleanup(); }
});

test("invalid plans and private changes use their own confirmation", async () => {
  let domain = "https://evil.example.test";
  const host = pageHost({ prepare: (change) => ({ change, confirmationToken: "t", domain, impact: { before: `${domain}/about`, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 1 }], navigation: [], notes: [] } }),
    apply: async (plan) => ({ status: "applied", page: { ...sitePages()[1], visibility: plan.change.visibility } }) });
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("非公開にする"));
    assert.ok(dialog().textContent.includes("公開中のURLは表示されなくなり")); await press(buttonIn(dialog(), "影響を確認"));
    assert.match(dialog().textContent, /影響を確認できませんでした/); assert.ok(buttonIn(dialog(), "影響を確認"));
    domain = "https://example.test"; await press(buttonIn(dialog(), "影響を確認"));
    assert.ok(dialog().textContent.includes("公開サイトに表示されなくなります")); assert.ok(dialog().textContent.includes("ホーム · 1 件"));
    const confirm = [...dialog().querySelectorAll("button")].find((node) => node.textContent === "非公開にする");
    assert.ok(confirm.className.includes("e-danger-primary")); assert.equal(confirm.disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click()); await press(confirm);
    assert.deepEqual(host.calls.applies[0].change, { action: "visibility", target: { siteId: "demo", pageId: "about", locale: "ja-JP" }, visibility: "private" });
    assert.ok(document.body.textContent.includes("ページを非公開にしました。"));
  } finally { await app.cleanup(); }
});

test("page operations wait for unsaved edits and the page tab switch opens the visibility dialog", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const page = await panel("ページ"), toggle = page.querySelector('[role="switch"]');
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await change(input("ページタイトル"), "未保存のタイトル");
    assert.equal(document.querySelector('[aria-label="ページを追加"]').disabled, true); assert.equal(toggle.disabled, true);
    assert.equal(document.querySelector('[aria-label="私たちについて の操作"]').disabled, true);
    assert.ok(document.body.textContent.includes("未保存の変更を保存してから操作できます。"));
    await click("下書き保存"); assert.equal(toggle.disabled, false);
    await press(toggle); assert.equal(dialog().getAttribute("aria-label"), "ページを非公開にする");
    await act(async () => dialog().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await flush();
    assert.equal(dialog(), null);
    await press(document.querySelector('[aria-label="ページを追加"]'));
    assert.equal(inputIn(dialog(), "URL パス").value, "/new-page"); assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "ページ名"), "新しいページ"); assert.equal(buttonIn(dialog(), "影響を確認").disabled, false);
    await press(buttonIn(dialog(), "影響を確認"));
    assert.deepEqual(host.calls.prepares[0], { action: "create", siteId: "demo", locale: "ja-JP", title: "新しいページ", path: "/new-page" });
  } finally { await app.cleanup(); }
  const legacy = await setup();
  try {
    assert.equal(document.querySelector('[aria-label="ページを追加"]'), null); assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(document.querySelector('[aria-label="ホーム の操作"]'), null);
    assert.ok((await panel("サイト")).textContent.includes("このサイトではサイト設定を編集できません。"));
  } finally { await legacy.cleanup(); }
});

test("site settings load, save with the optimistic version, keep input on 409 and guard site switching", async () => {
  let mode = "normal";
  const host = pageHost({ saveSettings: (request) => mode === "conflict" ? { status: "conflict" } : mode === "throw" ? Promise.reject(new Error("offline")) : { status: "saved", version: `s-${request.expectedVersion}-next` } });
  const app = await setup({ adapter: host.adapter });
  try {
    const site = await panel("サイト"); assert.equal(document.querySelector(".e-page-settings"), null);
    assert.ok(site.textContent.includes("https://example.test"));
    assert.equal(inputIn(site, "サイトタイトル").value, "デモサイト"); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    await change(inputIn(site, "言語"), "Japanese");
    assert.match(site.querySelector('[role="alert"]').textContent, /ja や ja-JP/); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    await change(inputIn(site, "言語"), "ja-JP"); await change(inputIn(site, "サイトタイトル"), "新しいサイト名");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[0], { siteId: "demo", settings: { title: "新しいサイト名", description: "サイトの説明", locale: "ja-JP" }, expectedVersion: "s1" });
    assert.ok(site.textContent.includes("サイト設定を保存しました。")); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    mode = "conflict"; await change(inputIn(site, "説明文"), "競合する説明"); await press(buttonIn(site, "サイト設定を保存"));
    assert.equal(host.calls.settingsSaves[1].expectedVersion, "s-s1-next");
    assert.ok(site.textContent.includes("サイト設定が競合しました（409）。入力を保持しています。")); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    mode = "throw"; await press(buttonIn(site, "サイト設定を保存"));
    assert.ok(site.textContent.includes("サイト設定を保存できませんでした。入力を保持しています。")); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    await change(document.querySelector('[aria-label="編集するサイト"]'), "second");
    assert.ok(dialog()); await click("編集を続ける"); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    mode = "conflict"; await press(buttonIn(site, "サイト設定を保存"));
    host.setSettings({ title: "他の人の変更", locale: "ja" });
    const reads = host.calls.settingsReads; await press(buttonIn(site, "最新の設定を読み込む（入力を破棄）"));
    assert.equal(host.calls.settingsReads, reads + 1); assert.equal(inputIn(site, "サイトタイトル").value, "他の人の変更"); assert.equal(inputIn(site, "説明文").value, "");
    await change(document.querySelector('[aria-label="編集するサイト"]'), "second"); assert.equal(dialog(), null);
  } finally { await app.cleanup(); }
});

test("site settings load failures can be retried", async () => {
  let fail = true;
  const host = pageHost(), read = host.adapter.readSiteSettings;
  host.adapter.readSiteSettings = async (...args) => { if (fail) throw new Error("offline"); return read(...args); };
  const app = await setup({ adapter: host.adapter });
  try {
    const site = await panel("サイト"); assert.ok(site.textContent.includes("サイト設定を読み込めませんでした。"));
    fail = false; await press(buttonIn(site, "再試行")); assert.equal(inputIn(site, "サイトタイトル").value, "デモサイト");
  } finally { await app.cleanup(); }
});

test("release confirmation shows the public URL and the search result information", async () => {
  const doc = { ...structuredClone(fixture), meta: { description: "公開する説明文" } };
  const host = pageHost(), app = await setup({ document: doc, adapter: host.adapter });
  try {
    await click("公開前の確認");
    const text = dialog().textContent;
    for (const expected of ["公開URL", "https://example.test/", "検索結果に出る情報", fixture.title, "公開する説明文", "表示する", "現在の見出し"]) assert.ok(text.includes(expected), expected);
  } finally { await app.cleanup(); }
});

const assetPanel = () => document.querySelector('[aria-label="素材ライブラリ"]');
async function tool(name) { const target = document.querySelector(`.e-tools button[title="${name}"]`); assert.ok(target, name); await act(async () => target.click()); await flush(); }
const assetCard = (name) => [...(assetPanel()?.querySelectorAll(".e-asset-card") ?? [])].find((node) => node.getAttribute("aria-label").startsWith(`${name}（`));
const settle = async () => { await flush(); await flush(); };
async function chooseAsset(name) { const target = assetCard(name); assert.ok(target, name); await act(async () => target.click()); await settle(); }
async function uploadFiles(files) {
  const target = assetPanel().querySelector('input[type="file"]'); assert.ok(target, "file input");
  Object.defineProperty(target, "files", { configurable: true, value: files });
  await act(async () => target.dispatchEvent(new dom.window.Event("change", { bubbles: true }))); await settle();
}
async function clickCanvas(nodeId) {
  const frame = document.querySelector("iframe");
  await act(async () => frame.contentDocument.querySelector(`[data-nw-node="${nodeId}"]`).dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true }))); await settle();
}
const canvasNode = (nodeId) => document.querySelector("iframe").contentDocument.querySelector(`[data-nw-node="${nodeId}"]`);
const png = (name, size) => new File([new Uint8Array(size)], name, { type: "image/png" });
const imageTypes = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];
const garden = { id: "garden", name: "庭の緑.png", mimeType: "image/png", bytes: 2048, width: 600, height: 400, alt: "庭の緑", src: "/media/garden.png", thumbnailUrl: "/media/garden.png" };
function withImage(node = { attrs: { src: "/photo.webp", alt: "古い写真" } }) { const doc = structuredClone(fixture); doc.body[0].children.push({ type: "element", id: "photo", tag: "img", children: [], ...node }); return doc; }

test("failed asset preview resolution can be retried", async () => {
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  let attempts = 0;
  const assets = { ...library, resolveAssets: async (request, signal) => {
    attempts++;
    if (attempts === 1) throw new Error("temporary failure");
    return library.resolveAssets(request, signal);
  } };
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets });
  try {
    await settle();
    assert.equal(attempts, 1);
    assert.ok(button("素材を再読み込み"));
    await click("素材を再読み込み");
    await settle();
    assert.equal(attempts, 2);
    assert.equal(button("素材を再読み込み"), undefined);
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/garden.png"));
    await clickCanvas("photo"); await editorTab("設定"); assert.equal(input("レスポンシブ画像 URL"), undefined);
  } finally { await app.cleanup(); }
});

test("changing the asset adapter does not retain the previous session's resolved image", async () => {
  const first = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  const second = createMemoryAssetLibrary({ siteId: "demo", seed: [{ ...garden, src: "/media/new-garden.png" }] });
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets: first });
  try {
    await settle();
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/garden.png"));
    await act(async () => app.root.render(createElement(PageEditor, { adapter: app.adapter, assets: second })));
    await settle();
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/new-garden.png"));
  } finally { await app.cleanup(); }
});

test("staff upload an image, set its alt, replace a page image, save the draft and see it after reload", async () => {
  let app;
  const library = createMemoryAssetLibrary({
    siteId: "demo", seed: [garden, { id: "guide", name: "利用案内.pdf", mimeType: "application/pdf", bytes: 4096, src: "/media/guide.pdf" }],
    upload: { accept: imageTypes, maxBytes: 1024 * 1024 }, quota: { limitBytes: 10 * 1024 * 1024 },
    documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [],
    store: async (_file, meta) => ({ src: `/media/${meta.id}.png`, thumbnailUrl: `/media/${meta.id}.png`, width: 1200, height: 800 })
  });
  app = await setup({ document: withImage(), assets: library });
  try {
    assert.equal(assetPanel().closest("[hidden]") !== null, true);
    await tool("素材"); assert.equal(assetPanel().closest("[hidden]"), null);
    assert.ok(assetCard("庭の緑.png").getAttribute("aria-label").startsWith("庭の緑.png（画像・600×400・2 KB"));
    assert.ok(assetCard("利用案内.pdf").getAttribute("aria-label").startsWith("利用案内.pdf（PDF・4 KB"));
    assert.ok(assetPanel().textContent.includes("ストレージ使用量 6 KB / 10 MB"));
    await uploadFiles([png("海辺の朝.png", 1500)]);
    assert.ok(assetPanel().textContent.includes("海辺の朝.png: 追加しました。"));
    assert.equal(document.activeElement, input("代替テキスト"));
    await change(input("代替テキスト"), "朝の海辺"); await click("変更を保存");
    assert.ok(assetPanel().textContent.includes("保存しました。"));
    await click("一覧に戻る");
    const first = assetPanel().querySelector(".e-asset-card");
    assert.ok(first.getAttribute("aria-label").startsWith("海辺の朝.png（画像・1200×800")); assert.equal(document.activeElement, first);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("設定");
    await click("画像を置き換え");
    assert.equal(assetPanel().closest("[hidden]"), null); assert.equal(assetPanel().querySelector("h2").textContent, "画像を選ぶ");
    assert.equal(assetCard("利用案内.pdf"), undefined);
    await chooseAsset("海辺の朝.png");
    assert.ok(document.body.textContent.includes("画像を置き換えました。代替テキストを確認してください。"));
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/asset-1.png"); assert.equal(canvasNode("photo").getAttribute("alt"), "朝の海辺");
    assert.equal(assetPanel().closest("[hidden]") !== null, true);
    await editorTab("設定"); assert.equal(input("画像の説明").value, "朝の海辺");
    await click("下書き保存");
    const saved = app.calls.saves[0].document.body[0].children.at(-1);
    assert.deepEqual(saved.asset, { provider: "uploads", id: "asset-1" }); assert.deepEqual(saved.attrs, { alt: "朝の海辺" });
    await click("最新の文書を再読込");
    assert.equal(app.calls.reads.length, 2); assert.equal(canvasNode("photo").getAttribute("src"), "/media/asset-1.png");
  } finally { await app.cleanup(); }
});

const night = { id: "night", name: "夜の海.avif", mimeType: "image/avif", bytes: 1024, width: 1200, height: 630, alt: "夜の海", src: "/media/night.avif", thumbnailUrl: "/media/night.avif" };
const coverFrame = (root) => root.querySelector(".e-cover-frame");
test("staff choose the page social cover from the library, save it as an asset reference and see it after reload", async () => {
  let app;
  const terrace = { id: "terrace", name: "テラス.jpg", mimeType: "image/jpeg", bytes: 1024, width: 1200, height: 630, alt: "テラス", src: "/media/terrace.jpg", thumbnailUrl: "/media/terrace.jpg" };
  const host = pageHost(), library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden, night, terrace], documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [] });
  app = await setup({ adapter: host.adapter, assets: library });
  try {
    let page = await panel("ページ");
    assert.equal(coverFrame(page).textContent, "画像は未設定です"); assert.equal(buttonIn(page, "画像を外す"), undefined);
    await press(buttonIn(page, "画像を選ぶ"));
    assert.equal(assetPanel().closest("[hidden]"), null); assert.equal(assetPanel().querySelector("h2").textContent, "ソーシャルカバーを選ぶ");
    await chooseAsset("夜の海.avif");
    assert.equal(assetPanel().querySelector('[role="alert"]').textContent, "ソーシャルカバーに使えるのは JPEG・PNG・WebP・GIF の画像です。");
    assert.equal(app.stored().meta, undefined); assert.equal(button("下書き保存").disabled, true);
    await chooseAsset("庭の緑.png");
    assert.ok(document.body.textContent.includes("ソーシャルカバーを設定しました。画像の説明を確認してください。"));
    assert.equal(assetPanel().closest("[hidden]") !== null, true);
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/garden.png");
    assert.ok(page.textContent.includes("素材ライブラリの画像")); assert.equal(inputIn(page, "画像の説明").value, "庭の緑");
    assert.equal(inputIn(page, "画像 URL").value, ""); assert.equal(inputIn(page, "画像 URL").closest("details").open, false);
    await change(inputIn(page, "画像の説明"), "庭に面したリビング");
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.meta, { ogImage: { asset: { provider: "uploads", id: "garden" }, alt: "庭に面したリビング" } });
    await click("最新の文書を再読込");
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/garden.png"); assert.equal(inputIn(page, "画像の説明").value, "庭に面したリビング");
    // ソーシャルカバーで使っている素材は削除できず、使用箇所の置き換えでカバーも差し替わる（SNS で表示できない形式は拒否）。
    await tool("素材"); await chooseAsset("庭の緑.png");
    assert.equal(button("削除…").disabled, true); assert.ok(assetPanel().textContent.includes("このページで使用中です。"));
    await click("このページの使用箇所を置き換え"); await chooseAsset("夜の海.avif");
    assert.equal(assetPanel().querySelector('[role="alert"]').textContent, "この画像はソーシャルカバーにも使われています。ソーシャルカバーに使えるのは JPEG・PNG・WebP・GIF の画像です。");
    await chooseAsset("テラス.jpg"); assert.ok(document.body.textContent.includes("このページの使用箇所を置き換えました。"));
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/terrace.jpg"); assert.equal(inputIn(page, "画像の説明").value, "庭に面したリビング");
    // URL を空で確定しても素材の画像は外れない。URL を入れると URL の画像へ切り替わる。
    await change(inputIn(page, "画像 URL"), ""); assert.ok(page.textContent.includes("素材ライブラリの画像")); assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/terrace.jpg");
    await change(inputIn(page, "画像 URL"), "/cover.jpg");
    assert.ok(page.textContent.includes("URL で指定した画像")); assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "https://example.test/cover.jpg");
    await press(buttonIn(page, "画像を外す")); assert.equal(coverFrame(page).textContent, "画像は未設定です");
    await click("下書き保存"); assert.equal(app.calls.saves[1].document.meta, undefined);
  } finally { await app.cleanup(); }
});

test("the site social cover is chosen from the library, saved with site settings and resolved after reload", async () => {
  const host = pageHost(), library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  let app = await setup({ adapter: host.adapter, assets: library });
  try {
    const site = await panel("サイト");
    assert.equal(inputIn(site, "画像の説明").disabled, true);
    await press(buttonIn(site, "画像を選ぶ"));
    assert.equal(assetPanel().querySelector("h2").textContent, "ソーシャルカバーを選ぶ");
    await chooseAsset("庭の緑.png");
    assert.equal(assetPanel().closest("[hidden]") !== null, true); assert.equal(button("下書き保存").disabled, true);
    assert.equal(coverFrame(site).querySelector("img").getAttribute("src"), "/media/garden.png"); assert.equal(inputIn(site, "画像の説明").value, "庭の緑");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[0].settings, { title: "デモサイト", description: "サイトの説明", ogImage: { asset: { provider: "uploads", id: "garden" }, alt: "庭の緑" }, locale: "ja" });
    const page = await panel("ページ"); assert.equal(coverFrame(page).textContent, "サイト共通の画像を使います");
  } finally { await app.cleanup(); }
  app = await setup({ adapter: host.adapter, assets: library });
  try {
    const site = await panel("サイト");
    assert.equal(coverFrame(site).querySelector("img").getAttribute("src"), "/media/garden.png");
    assert.ok(site.textContent.includes("素材ライブラリの画像"));
    await press(buttonIn(site, "画像を外す")); assert.equal(inputIn(site, "画像の説明").value, "");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[1].settings, { title: "デモサイト", description: "サイトの説明", locale: "ja" });
  } finally { await app.cleanup(); }
});

test("library images can be added inside the selected element and used as its background", async () => {
  const app = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try {
    await click("section · hero"); await tool("素材"); await chooseAsset("庭の緑.png");
    await click("ページに追加");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "img · node_1");
    assert.equal(canvasNode("node_1").parentElement.getAttribute("data-nw-node"), "hero");
    assert.equal(canvasNode("node_1").getAttribute("src"), "/media/garden.png"); assert.equal(canvasNode("node_1").getAttribute("width"), "600");
    await tool("レイヤー"); await click("section · hero"); assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, "ボックス"); await click("背景画像を選ぶ");
    assert.equal(assetPanel().querySelector("h2").textContent, "背景画像を選ぶ");
    await chooseAsset("庭の緑.png");
    const css = () => document.querySelector("iframe").contentDocument.querySelector("style[data-nw-style]").textContent;
    assert.ok(css().includes('background-image:url("/media/garden.png");'));
    await change(input("背景のサイズ"), "cover"); assert.ok(css().includes("background-size:cover;"));
    await click("下書き保存");
    const hero = app.calls.saves[0].document.body[0];
    assert.deepEqual(hero.style.base.backgroundImage, { asset: { provider: "uploads", id: "garden" } }); assert.equal(hero.style.base.backgroundSize, "cover");
    assert.deepEqual(hero.children.at(-1), { type: "element", id: "node_1", tag: "img", asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭の緑" }, style: { base: { maxWidth: "100%", height: "auto" } }, children: [] });
    await click("背景画像を外す"); assert.ok(!css().includes("background-image"));
  } finally { await app.cleanup(); }
});

test("uploads explain rejected formats, sizes, quota, scans and permissions, and cross-site listings fail closed", async () => {
  let mode = "host";
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [{ id: "existing", name: "既存.png", mimeType: "image/png", bytes: 1000, src: "/media/existing.png" }], upload: { accept: ["image/png"], maxBytes: 1000 }, quota: { limitBytes: 1500 } });
  const guarded = { ...library, uploadAsset: async (request, signal) => {
    if (mode === "scan") return { status: "rejected", reason: "scan" };
    if (mode === "forbidden") throw Object.assign(new Error("forbidden"), { status: 403 });
    return library.uploadAsset(request, signal);
  } };
  const app = await setup({ assets: guarded });
  try {
    await tool("素材");
    await uploadFiles([new File(["%PDF"], "案内.pdf", { type: "application/pdf" }), png("大きい.png", 2000), png("中くらい.png", 600)]);
    const text = () => assetPanel().querySelector(".e-asset-uploads").textContent;
    assert.ok(text().includes("案内.pdf: この形式はアップロードできません。アップロードできる形式: PNG"));
    assert.ok(text().includes("大きい.png: ファイルが大きすぎます（上限 1000 B）。"));
    assert.ok(text().includes("中くらい.png: 容量の上限を超えるためアップロードできません。"));
    mode = "scan"; await uploadFiles([png("検査.png", 10)]); assert.ok(text().includes("検査.png: 安全性の確認で受け付けられませんでした。"));
    mode = "forbidden"; await uploadFiles([png("権限.png", 10)]); assert.ok(text().includes("権限.png: 素材を追加する権限がありません。"));
    assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 1);
    await act(async () => assetPanel().querySelector('[aria-label="案内.pdf の通知を閉じる"]').click()); assert.ok(!text().includes("案内.pdf"));
  } finally { await app.cleanup(); }
  const foreign = { ...library, listAssets: async (query, signal) => { const result = await library.listAssets(query, signal); return { ...result, assets: [...result.assets, { ...result.assets[0], id: "foreign", siteId: "other" }] }; } };
  const crossSite = await setup({ assets: foreign });
  try {
    await tool("素材");
    assert.ok(assetPanel().textContent.includes("素材を読み込めませんでした。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
  } finally { await crossSite.cleanup(); }
  const readOnly = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try {
    await tool("素材");
    assert.equal(button("アップロード"), undefined); assert.ok(assetPanel().textContent.includes("このサイトに素材を追加する権限がありません。"));
  } finally { await readOnly.cleanup(); }
});

test("assets used on this page or other pages cannot be deleted; unused assets are deleted after confirmation", async () => {
  const other = withImage({ asset: { provider: "uploads", id: "elsewhere" }, attrs: { alt: "" } }); other.pageId = "about";
  const image = (id, name) => ({ id, name, mimeType: "image/png", bytes: 1024, src: `/media/${id}.png` });
  let hideUsages = false;
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [image("here", "使用中.png"), image("spare", "未使用.png"), image("trash", "削除する.png"), image("elsewhere", "他ページ.png")],
    documents: () => [{ pageId: "about", locale: "ja-JP", title: "紹介", state: "published", document: other }] });
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "here" }, attrs: { alt: "ここ" } }), assets: { ...library, listAssetUsages: async (request, signal) => hideUsages ? [] : library.listAssetUsages(request, signal) } });
  try {
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/here.png");
    await tool("素材");
    assert.ok(assetCard("使用中.png").getAttribute("aria-label").endsWith("・使用中）")); assert.ok(assetCard("他ページ.png").getAttribute("aria-label").endsWith("・使用中）"));
    await chooseAsset("使用中.png");
    assert.equal(button("削除…").disabled, true);
    assert.ok(assetPanel().textContent.includes("このページ: 1 か所")); assert.ok(assetPanel().textContent.includes("このページで使用中です。先に別の画像へ置き換えてください。"));
    await click("このページの使用箇所を置き換え");
    assert.equal(assetPanel().querySelector("h2").textContent, "置き換える画像を選ぶ");
    await chooseAsset("未使用.png");
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/spare.png"); assert.ok(document.body.textContent.includes("このページの使用箇所を置き換えました。"));
    assert.ok(assetPanel().textContent.includes("このページ: 0 か所"));
    await click("一覧に戻る"); await chooseAsset("削除する.png");
    await click("削除…"); assert.ok(assetPanel().textContent.includes("「削除する.png」を削除します。元に戻せません。"));
    await click("削除する"); assert.equal(assetCard("削除する.png"), undefined);
    await chooseAsset("他ページ.png");
    assert.equal(button("削除…").disabled, true); assert.ok(assetPanel().textContent.includes("紹介（ja-JP）・公開中"));
    assert.ok(assetPanel().textContent.includes("公開中または下書きのページで使用中のため削除できません。"));
    hideUsages = true; await click("使用状況を再確認"); assert.equal(button("削除…").disabled, false);
    await click("削除…"); await click("削除する");
    assert.ok(assetCard("他ページ.png") === undefined && assetPanel().textContent.includes("公開中または下書きのページで使用中のため削除できません。"));
    assert.ok(assetPanel().textContent.includes("紹介（ja-JP）・公開中"));
  } finally { await app.cleanup(); }
});

test("without an asset adapter the editor keeps the URL image fields and shows no library", async () => {
  const app = await setup({ document: withImage() });
  try {
    assert.ok(document.querySelector('.e-tools button[aria-label="素材"]')); assert.equal(assetPanel(), null);
    await clickCanvas("photo"); await editorTab("設定");
    assert.equal(input("画像 URL").value, "/photo.webp"); assert.equal(button("画像を置き換え"), undefined); assert.equal(button("背景画像を選ぶ"), undefined);
    await change(input("画像 URL"), "/other.webp"); assert.equal(canvasNode("photo").getAttribute("src"), "/other.webp");
  } finally { await app.cleanup(); }
});

test("image URL locks disable responsive replacement and keep alt editable", async () => {
  for (const field of ["attrs.src", "attrs.srcSet", "asset"]) {
    const app = await setup({ document: withImage({ attrs: { src: "/photo.webp", srcSet: "/large.webp", alt: "Sea" } }), locks: [{ nodeId: "photo", fields: [field], reason: "業務画像" }] });
    try {
      await clickCanvas("photo"); await editorTab("設定");
      assert.equal(input("画像 URL").disabled, true);
      assert.equal(input("レスポンシブ画像 URL").disabled, true);
      assert.equal(input("画像の説明").disabled, false);
      assert.equal(button("下書き保存").disabled, true);
    } finally { await app.cleanup(); }
  }
});

const caps = (extra = {}) => ({ upload: false, editMetadata: false, delete: false, folders: false, acquire: false, ...extra });
const yoga = { id: "yoga", name: "朝ヨガ.png", mimeType: "image/png", bytes: 3072, width: 800, height: 600, alt: "海辺で朝ヨガ", sourceLabel: "体験「鎌倉の朝ヨガ」の写真", src: "/cms/yoga.png", thumbnailUrl: "/cms/yoga.png" };
const wave = { id: "wave", name: "波.png", mimeType: "image/png", bytes: 1024, width: 640, height: 480, alt: "波の模様", src: "/stock/wave.png", thumbnailUrl: "/stock/wave.png",
  license: { name: "テスト用ライセンス", url: "https://license.example.test/terms", attribution: "見本ストック", terms: "テストの中だけで使えます。" } };
function sourceLibrary({ stock = false, documents } = {}) {
  return createMemoryAssetLibrary({
    siteId: "demo", folders: [{ id: "photos", name: "写真" }], upload: { accept: imageTypes, maxBytes: 1024 * 1024 }, ...(documents ? { documents } : {}),
    store: async (_file, meta) => ({ src: `/media/${meta.id}.png`, thumbnailUrl: `/media/${meta.id}.png`, width: 10, height: 10 }),
    providers: [
      { id: "uploads", kind: "upload", label: "サイト", origin: "このサイトにアップロードした素材", status: "available", capabilities: caps({ upload: true, editMetadata: true, delete: true, folders: true }), seed: [garden] },
      { id: "experience", kind: "cms", label: "体験写真", origin: "NIHO の体験原稿で公開を許可された写真", terms: "体験の公開中だけ表示されます。写真の差し替え・非公開は体験原稿で行います。", status: "available", capabilities: caps(), seed: [yoga] },
      stock ? { id: "stock", kind: "stock", label: "ストック", origin: "ライセンス確認済みのストック素材", status: "available", capabilities: caps({ acquire: true }), seed: [wave] }
        : { id: "stock", kind: "stock", label: "ストック", origin: "ライセンス確認済みのストック素材", status: "unavailable", unavailableReason: "ストック素材はまだ接続されていません。", capabilities: caps() }
    ]
  });
}
function spy(library) {
  const calls = { lists: [], acquires: [] };
  return { calls, adapter: { ...library, listAssets: async (query, signal) => { calls.lists.push(structuredClone(query)); return library.listAssets(query, signal); },
    acquireAsset: async (request, signal) => { calls.acquires.push(structuredClone(request)); return library.acquireAsset(request, signal); } } };
}
const sourceTabs = () => [...assetPanel().querySelectorAll('[aria-label="素材の出所"] button')];
const cardNames = () => [...assetPanel().querySelectorAll(".e-asset-card")].map((node) => node.getAttribute("aria-label").split("（")[0]);

test("one picker lists site uploads and allowed CMS photos by source and places CMS photos by reference only", async () => {
  const { calls, adapter } = spy(sourceLibrary());
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    await tool("素材");
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["すべて", "サイト", "体験写真", "ストック（未接続）"]);
    assert.equal(sourceTabs()[0].getAttribute("aria-pressed"), "true"); assert.equal("provider" in calls.lists.at(-1), false);
    assert.deepEqual(cardNames(), ["庭の緑.png", "朝ヨガ.png"]);
    assert.ok(assetCard("庭の緑.png").getAttribute("aria-label").endsWith("・出所: サイト）")); assert.ok(assetCard("朝ヨガ.png").getAttribute("aria-label").endsWith("・出所: 体験写真）"));
    assert.equal(assetCard("朝ヨガ.png").querySelector(".e-asset-source").textContent, "体験写真");
    assert.equal(button("アップロード").title, "サイトへ追加"); assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("設定"); await click("画像を置き換え");
    assert.equal(assetPanel().querySelector("h2").textContent, "画像を選ぶ"); assert.equal(sourceTabs().length, 4);
    await chooseAsset("朝ヨガ.png");
    assert.equal(canvasNode("photo").getAttribute("src"), "/cms/yoga.png"); assert.equal(canvasNode("photo").getAttribute("alt"), "海辺で朝ヨガ");
    await click("下書き保存");
    const saved = app.calls.saves[0].document;
    assert.deepEqual(saved.body[0].children.at(-1).asset, { provider: "experience", id: "yoga" }); assert.ok(!JSON.stringify(saved).includes("/cms/"));
  } finally { await app.cleanup(); }
});

test("CMS photos show their origin and terms read-only, without save, upload, folders or delete", async () => {
  const { calls, adapter } = spy(sourceLibrary());
  const app = await setup({ assets: adapter });
  try {
    await tool("素材"); await chooseAsset("朝ヨガ.png");
    assert.equal(input("名前").readOnly, true); assert.equal(input("代替テキスト").readOnly, true); assert.equal(input("保存先フォルダ"), undefined);
    assert.equal(button("変更を保存"), undefined); assert.equal(button("削除…"), undefined); assert.ok(button("ページに追加"));
    const text = assetPanel().textContent;
    for (const expected of ["出所体験写真NIHO の体験原稿で公開を許可された写真体験「鎌倉の朝ヨガ」の写真", "利用条件体験の公開中だけ表示されます。写真の差し替え・非公開は体験原稿で行います。",
      "この素材は「体験写真」で管理しています。名前・説明・写真の差し替えは出所で行ってください。", "「体験写真」の素材はここでは削除できません。", "このページ: 0 か所"]) assert.ok(text.includes(expected), expected);
    await click("一覧に戻る"); await chooseAsset("庭の緑.png");
    assert.equal(input("名前").readOnly, false); assert.ok(button("変更を保存")); assert.ok(button("削除…")); assert.ok(input("保存先フォルダ"));
    await click("一覧に戻る"); await click("体験写真");
    assert.equal(calls.lists.at(-1).provider, "experience"); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    assert.ok(assetPanel().textContent.includes("NIHO の体験原稿で公開を許可された写真"));
    assert.equal(button("アップロード"), undefined); assert.equal(button("フォルダを追加"), undefined); assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null);
    assert.ok(!assetPanel().textContent.includes("このサイトに素材を追加する権限がありません。"));
    await click("サイト"); assert.ok(button("アップロード")); assert.ok(assetPanel().querySelector('select[aria-label="フォルダ"]')); assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("an unconnected stock source explains why without requesting a listing", async () => {
  const { calls, adapter } = spy(sourceLibrary()), errors = [], original = console.error;
  console.error = (...args) => { errors.push(args); };
  const app = await setup({ assets: adapter });
  try {
    await tool("素材"); const before = calls.lists.length;
    await click("ストック未接続");
    assert.equal(sourceTabs()[3].getAttribute("aria-pressed"), "true");
    assert.ok(assetPanel().textContent.includes("ストック素材はまだ接続されていません。")); assert.ok(assetPanel().textContent.includes("ライセンス確認済みのストック素材"));
    assert.equal(calls.lists.length, before); assert.ok(calls.lists.every((query) => query.provider !== "stock"));
    assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0); assert.equal(assetPanel().querySelector('[role="alert"]'), null); assert.equal(button("アップロード"), undefined);
    await click("すべて"); assert.deepEqual(cardNames(), ["庭の緑.png", "朝ヨガ.png"]);
    assert.deepEqual(errors, []);
  } finally { console.error = original; await app.cleanup(); }
});

test("connected stock shows its license and is acquired into site uploads before placement", async () => {
  const { calls, adapter } = spy(sourceLibrary({ stock: true }));
  const app = await setup({ assets: adapter });
  try {
    await tool("素材"); await click("ストック");
    assert.equal(calls.lists.at(-1).provider, "stock");
    assert.ok(assetCard("波.png").getAttribute("aria-label").endsWith("・ライセンスあり）")); assert.ok(assetCard("波.png").querySelector(".e-asset-badges").textContent.includes("ライセンス"));
    await chooseAsset("波.png");
    const link = [...assetPanel().querySelectorAll("a")].find((node) => node.textContent === "ライセンスを確認");
    assert.equal(link.getAttribute("href"), "https://license.example.test/terms"); assert.equal(link.getAttribute("target"), "_blank"); assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    for (const expected of ["出所ストックライセンス確認済みのストック素材", "ライセンステスト用ライセンス", "クレジット: 見本ストック", "テストの中だけで使えます。"]) assert.ok(assetPanel().textContent.includes(expected), expected);
    await click("ページに追加");
    assert.deepEqual(calls.acquires, [{ siteId: "demo", reference: { provider: "stock", id: "wave" }, expectedVersion: "1" }]);
    assert.ok(assetPanel().textContent.includes("ライセンス情報を記録して配置しました。"));
    assert.ok(assetPanel().textContent.includes("出所サイトこのサイトにアップロードした素材「ストック」から取り込んだ素材")); assert.ok(assetPanel().textContent.includes("ライセンステスト用ライセンス"));
    assert.equal(canvasNode("node_1").getAttribute("src"), "/stock/wave.png");
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).asset, { provider: "uploads", id: "asset-1" }); assert.ok(!JSON.stringify(app.calls.saves[0].document).includes('"stock"'));
    await click("一覧に戻る"); assert.deepEqual(cardNames(), ["波.png"]);
    await click("サイト"); assert.equal(calls.lists.at(-1).provider, "uploads");
    assert.deepEqual(cardNames(), ["波.png", "庭の緑.png"]); assert.ok(assetCard("波.png").getAttribute("aria-label").includes("・ライセンスあり"));
  } finally { await app.cleanup(); }
});

test("a removed provider leaves its open asset detail read-only and blocks placement", async () => {
  const library = sourceLibrary(); let removed = false;
  const adapter = { ...library, listProviders: async (request, signal) => {
    const providers = await library.listProviders(request, signal);
    return removed ? providers.filter((provider) => provider.id !== "experience") : providers;
  } };
  const app = await setup({ assets: adapter });
  try {
    await tool("素材"); await chooseAsset("朝ヨガ.png");
    removed = true;
    await tool("ページ"); await click("最新の文書を再読込"); await settle(); await tool("素材");
    assert.equal(input("名前").readOnly, true);
    assert.equal(input("代替テキスト").readOnly, true);
    assert.equal(button("変更を保存"), undefined);
    assert.equal(button("削除…"), undefined);
    assert.equal(button("ページに追加").disabled, true);
    assert.ok(assetPanel().textContent.includes("出所が確認できない素材は利用できません。"));
  } finally { await app.cleanup(); }
});

test("acquisition cannot place an asset returned from an unavailable provider", async () => {
  const library = sourceLibrary({ stock: true });
  const adapter = { ...library, listProviders: async (request, signal) => [
    ...await library.listProviders(request, signal),
    { id: "offline", kind: "stock", label: "未接続", origin: "未接続の出所", status: "unavailable", capabilities: caps() }
  ], acquireAsset: async (request, signal) => {
    const result = await library.acquireAsset(request, signal);
    return result.status === "ready" ? { ...result, asset: { ...result.asset, provider: "offline" } } : result;
  } };
  const app = await setup({ assets: adapter });
  try {
    await tool("素材"); await click("ストック"); await chooseAsset("波.png");
    await click("ページに追加");
    assert.equal(canvasNode("node_1"), null);
    assert.ok(assetPanel().textContent.includes("この出所は現在利用できません。"));
  } finally { await app.cleanup(); }
});

test("photos unpublished in the CMS become placeholders after the editor reloads and are left out of public HTML", async () => {
  const library = sourceLibrary(), reference = { provider: "experience", id: "yoga" }, doc = withImage({ asset: reference, attrs: { alt: "海辺で朝ヨガ" } });
  const publicHtml = async () => renderPageToHtml(doc, {}, { assets: parseResolvedAssets(await library.resolveAssets({ siteId: "demo", references: uniqueAssetReferences(parsePageDocument(doc)) }, new AbortController().signal)) });
  const app = await setup({ document: doc, assets: library });
  try {
    assert.equal(canvasNode("photo").getAttribute("src"), "/cms/yoga.png"); assert.ok((await publicHtml()).includes('src="/cms/yoga.png"'));
    library.setPublished(reference, false);
    // エディター内の再読込で解決をやり直し、非公開になった写真をプレビューから外す。
    await click("最新の文書を再読込"); await settle();
    assert.equal(canvasNode("photo").hasAttribute("data-nw-missing-asset"), true); assert.equal(canvasNode("photo").getAttribute("src"), null);
    await clickCanvas("photo"); await editorTab("設定"); assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("画像を表示できません"));
    const html = await publicHtml(); assert.ok(!html.includes("/cms/yoga.png")); assert.ok(!html.includes('data-nw-node="photo"'));
    await tool("素材"); assert.equal(!!assetCard("朝ヨガ.png"), false);
  } finally { await app.cleanup(); }
});

test("source listing failures and assets from undeclared or other sources fail closed", async () => {
  let failing = true, mode = "ok";
  const library = sourceLibrary(), lists = [], uploads = [];
  const adapter = { ...library,
    listProviders: async (request, signal) => { if (failing) throw new Error("offline"); return library.listProviders(request, signal); },
    listAssets: async (query, signal) => {
      lists.push(query); const result = await library.listAssets(query, signal);
      if (mode === "unknown") return { ...result, assets: [...result.assets, { ...result.assets[0], provider: "other", id: "x" }] };
      if (mode === "mixed" && query.provider === "uploads") return { ...result, assets: [...result.assets, ...(await library.listAssets({ ...query, provider: "experience" }, signal)).assets] };
      return result;
    },
    uploadAsset: async (request, signal) => {
      uploads.push(request.provider); const result = await library.uploadAsset(request, signal);
      return mode === "upload" && result.status === "uploaded" ? { ...result, asset: { ...result.asset, provider: "experience" } } : result;
    } };
  const app = await setup({ assets: adapter });
  try {
    await tool("素材");
    assert.ok(assetPanel().textContent.includes("素材の出所を読み込めませんでした。")); assert.ok(button("再読み込み"));
    assert.equal(lists.length, 0); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0); assert.equal(assetPanel().querySelector('input[type="search"]'), null);
    failing = false; await click("再読み込み"); assert.equal(sourceTabs().length, 4); assert.deepEqual(cardNames(), ["庭の緑.png", "朝ヨガ.png"]);
    mode = "unknown"; await click("体験写真");
    assert.ok(assetPanel().textContent.includes("素材を読み込めませんでした。出所が確認できない素材は利用できません。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
    mode = "mixed"; await click("サイト");
    assert.ok(assetPanel().textContent.includes("出所が確認できない素材は利用できません。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
    mode = "ok"; await click("再読み込み"); assert.deepEqual(cardNames(), ["庭の緑.png"]);
    mode = "upload"; await uploadFiles([png("混入.png", 10)]);
    assert.deepEqual(uploads, ["uploads"]);
    assert.ok(assetPanel().querySelector(".e-asset-uploads").textContent.includes("混入.png: 出所が確認できない素材は利用できません。")); assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("recently used assets are requested with recent, also while picking, and legacy adapters show no sources", async () => {
  let app;
  const { calls, adapter } = spy(sourceLibrary({ documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [] }));
  app = await setup({ document: withImage({ asset: { provider: "experience", id: "yoga" }, attrs: { alt: "朝ヨガ" } }), assets: adapter });
  try {
    await tool("素材"); assert.equal(button("最近使った").getAttribute("aria-pressed"), "false"); assert.equal("recent" in calls.lists.at(-1), false);
    await click("最近使った");
    assert.equal(button("最近使った").getAttribute("aria-pressed"), "true"); assert.equal(calls.lists.at(-1).recent, true); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("設定"); await click("画像を置き換え");
    assert.equal(button("最近使った").getAttribute("aria-pressed"), "true"); assert.equal(calls.lists.at(-1).recent, true); assert.equal(calls.lists.at(-1).kind, "image");
  } finally { await app.cleanup(); }
  const legacy = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try { await tool("素材"); assert.equal(button("最近使った"), undefined); assert.equal(document.querySelector('[aria-label="素材の出所"]'), null); } finally { await legacy.cleanup(); }
});
// 保存状態・自動保存・端末内の復元・競合の比較・版履歴（docs/save-history-contract.md）
const { createBrowserRecoveryStore, RecoveryTooLargeError } = await import("@niho/web/history");
const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const status = () => document.querySelector('[role="status"]').textContent;
const toolbarButton = (text) => [...document.querySelectorAll(".e-toolbar button")].find((node) => node.textContent === text);
const homeTarget = { siteId: "demo", pageId: "home", locale: "ja-JP" };
const localTime = (value) => { const date = new Date(value), pad = (number) => String(number).padStart(2, "0"); return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };
function memoryStorage() {
  const data = new Map();
  return { get length() { return data.size; }, key: (index) => [...data.keys()][index] ?? null, getItem: (key) => data.has(key) ? data.get(key) : null, setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); } };
}
const recoveryKey = "niho-web:recovery:v1:staff:demo/home/ja-JP";

test("a host without the new methods and props keeps manual saving and shows no history, autosave or recovery controls", async () => {
  const app = await setup();
  try {
    assert.equal(toolbarButton("履歴"), undefined); assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(document.querySelector(".e-recovery"), null); assert.equal(document.querySelector(".e-versions"), null);
    assert.equal(status(), "保存済み");
    await change(input("ページタイトル"), "手動の編集"); assert.equal(status(), "未保存の変更あり");
    await wait(150); assert.equal(app.calls.saves.length, 0);
    await click("下書き保存"); assert.match(status(), /^保存済み（\d{2}:\d{2}）$/);
    await click("公開前の確認"); assert.ok(!dialog().textContent.includes("影響する共通部品"));
  } finally { await app.cleanup(); }
});

test("save problems show conflict, login and failure states with retry or compare while keeping the edit", async () => {
  let mode = "auth";
  const app = await setup({ save: async () => {
    if (mode === "auth") throw { status: 401 }; if (mode === "forbidden") throw { status: 403 }; if (mode === "fail") throw new Error("server");
    return mode === "conflict" ? { status: "conflict" } : { status: "saved", version: "v2", revision: 2 };
  } });
  try {
    await change(input("ページタイトル"), "残す編集"); await click("下書き保存");
    assert.equal(status(), "ログインを確認してください"); assert.ok(toolbarButton("再試行")); assert.equal(toolbarButton("比較する"), undefined);
    assert.ok(document.querySelector(".e-notice").textContent.includes("再度ログイン"));
    mode = "forbidden"; await press(toolbarButton("再試行")); assert.equal(status(), "ログインを確認してください");
    mode = "fail"; await press(toolbarButton("再試行")); assert.equal(status(), "保存できませんでした");
    mode = "conflict"; await press(toolbarButton("再試行"));
    assert.equal(status(), "競合しています"); assert.ok(toolbarButton("比較する")); assert.equal(toolbarButton("再試行"), undefined);
    assert.ok(dialog(), "a manual conflict opens the comparison"); await press(buttonIn(dialog(), "閉じて編集を続ける")); assert.equal(dialog(), null);
    await press(toolbarButton("比較する")); assert.ok(dialog()); await press(buttonIn(dialog(), "閉じて編集を続ける"));
    mode = "saved"; await click("下書き保存");
    assert.match(status(), /^保存済み（\d{2}:\d{2}）$/); assert.equal(toolbarButton("再試行"), undefined); assert.equal(toolbarButton("比較する"), undefined);
    assert.equal(input("ページタイトル").value, "残す編集"); assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1"));
  } finally { await app.cleanup(); }
});

test("autosave saves the scheduled target after the delay, waits for valid input, can be switched off and pauses after a conflict", async () => {
  let version = 1, conflict = false;
  const app = await setup({ props: { autosave: { delayMs: 100 } }, save: async (request) => conflict ? { status: "conflict" } : { status: "saved", version: `v${++version}`, revision: request.document.revision + 1 } });
  try {
    const toggle = document.querySelector('[role="switch"]');
    assert.equal(toggle.textContent, "自動保存"); assert.equal(toggle.getAttribute("aria-checked"), "true");
    await change(input("ページタイトル"), "自動で保存"); assert.equal(status(), "自動保存を待っています"); assert.equal(app.calls.saves.length, 0);
    await wait(300);
    assert.equal(app.calls.saves.length, 1); assert.deepEqual(app.calls.saves[0].target, homeTarget); assert.equal(app.calls.saves[0].expectedVersion, "v1"); assert.equal(app.calls.saves[0].trigger, "autosave");
    assert.equal(app.calls.saves[0].document.title, "自動で保存"); assert.match(status(), /^保存済み（\d{2}:\d{2}）$/);
    await press(toggle); assert.equal(toggle.getAttribute("aria-checked"), "false");
    await click("a · link"); await editorTab("設定"); await change(input("リンク先 URL"), "/news"); await change(input("リンク先 URL"), "javascript:alert(1)");
    assert.equal(status(), "入力を確認中");
    await press(toggle); await wait(300); assert.equal(app.calls.saves.length, 1, "no autosave while an invalid input is pending");
    await click("入力を取り消す"); await wait(300);
    assert.equal(app.calls.saves.length, 2); assert.equal(app.calls.saves[1].expectedVersion, "v2"); assert.equal(app.calls.saves[1].document.body[0].children[2].attrs.href, "/news");
    conflict = true; await click("ページ全体"); await change(input("ページタイトル"), "競合する編集"); await wait(300);
    assert.equal(app.calls.saves.length, 3); assert.equal(status(), "競合しています"); assert.ok(toolbarButton("比較する")); assert.equal(dialog(), null);
    await change(input("ページタイトル"), "さらに編集"); await wait(300); assert.equal(app.calls.saves.length, 3, "autosave pauses after a conflict");
  } finally { await app.cleanup(); }
});

test("an offline autosave failure retries once when the connection returns", async () => {
  let online = true, drop = true, fail = true, version = 1;
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, get: () => online });
  const app = await setup({ props: { autosave: { delayMs: 100 } }, save: async (request) => {
    if (drop) { drop = false; online = false; throw new Error("network"); }
    if (fail) throw new Error("server");
    return { status: "saved", version: `v${++version}`, revision: request.document.revision + 1 };
  } });
  try {
    await change(input("ページタイトル"), "オフラインの編集"); await wait(300);
    assert.equal(app.calls.saves.length, 1); assert.equal(status(), "オフラインです"); assert.ok(toolbarButton("再試行"));
    await wait(300); assert.equal(app.calls.saves.length, 1);
    online = true; await act(async () => dom.window.dispatchEvent(new dom.window.Event("online"))); await flush();
    assert.equal(app.calls.saves.length, 2); assert.equal(status(), "保存できませんでした");
    await wait(300); await act(async () => dom.window.dispatchEvent(new dom.window.Event("online"))); await flush();
    assert.equal(app.calls.saves.length, 2, "only one retry per offline failure");
    fail = false; await press(toolbarButton("再試行")); assert.equal(app.calls.saves.length, 3); assert.match(status(), /^保存済み/);
  } finally { delete dom.window.navigator.onLine; await app.cleanup(); }
});

test("the unsaved-changes dialog can save and then move, and stays on the page when that save fails", async () => {
  let fail = true;
  const app = await setup({ save: async () => { if (fail) throw new Error("server"); return { status: "saved", version: "v2", revision: 2 }; } });
  try {
    await change(input("ページタイトル"), "移動前の編集"); await clickPage("別ページ");
    await click("保存して移動");
    assert.equal(dialog(), null); assert.equal(status(), "保存できませんでした"); assert.equal(pageRow("ホーム").getAttribute("aria-current"), "page"); assert.equal(input("ページタイトル").value, "移動前の編集");
    fail = false; await clickPage("別ページ"); await click("保存して移動");
    assert.equal(app.calls.saves.length, 2); assert.equal(app.calls.saves[1].document.title, "移動前の編集");
    assert.equal(pageRow("別ページ").getAttribute("aria-current"), "page"); assert.equal(app.calls.reads.at(-1).pageId, "other"); assert.equal(status(), "保存済み");
    await change(input("ページタイトル"), "別の編集"); await change(input("ページタイトル"), "");
    await clickPage("ホーム"); assert.ok(dialog()); assert.equal(buttonIn(dialog(), "保存して移動"), undefined, "pending input cannot be saved");
  } finally { await app.cleanup(); }
});

test("the conflict comparison shows the diff, overwrites with the latest version only after confirmation, or discards to the latest", async () => {
  const latest = { ...structuredClone(fixture), title: "他の人のタイトル", revision: 5 };
  function host(saveResults, readFails = 0) {
    let reads = 0, failures = readFails;
    return { save: async () => saveResults.shift(), adapter: { readDocument: async (target) => {
      if (++reads === 1) return { document: { ...structuredClone(fixture), pageId: target.pageId }, version: "v1" };
      if (failures-- > 0) throw new Error("offline");
      return { document: { ...structuredClone(latest), pageId: target.pageId }, version: "v9" };
    } } };
  }
  const app = await setup(host([{ status: "conflict" }, { status: "saved", version: "v10", revision: 6 }], 1));
  try {
    await change(input("ページタイトル"), "私の編集"); await click("下書き保存");
    assert.ok(dialog().textContent.includes("最新の内容を取得できませんでした。編集内容は保持しています。"));
    await press(buttonIn(dialog(), "再試行"));
    const text = dialog().textContent;
    for (const expected of ["変更箇所", "最新の保存内容", "あなたの編集", "ページタイトル", "他の人のタイトル", "私の編集"]) assert.ok(text.includes(expected), expected);
    const overwrite = buttonIn(dialog(), "あなたの編集で上書き保存"); assert.equal(overwrite.disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click()); assert.equal(overwrite.disabled, false);
    await press(overwrite);
    assert.equal(app.calls.saves.length, 2); assert.equal(app.calls.saves[1].expectedVersion, "v9"); assert.equal(app.calls.saves[1].document.revision, 5); assert.equal(app.calls.saves[1].document.title, "私の編集");
    assert.equal(dialog(), null); assert.match(status(), /^保存済み/); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
  const discard = await setup(host([{ status: "conflict" }]));
  try {
    await change(input("ページタイトル"), "捨てる編集"); await click("下書き保存");
    await press(buttonIn(dialog(), "最新の内容を読み込む（あなたの編集を破棄）"));
    assert.equal(dialog(), null); assert.equal(input("ページタイトル").value, "他の人のタイトル"); assert.equal(status(), "保存済み"); assert.equal(button("下書き保存").disabled, true);
    await change(input("ページタイトル"), "最新から編集"); await click("下書き保存"); assert.equal(discard.calls.saves.at(-1).expectedVersion, "v9");
  } finally { await discard.cleanup(); }
});

test("recovery offers unsaved work after a load, restores it as an undoable edit and is cleared after saving", async () => {
  const storage = memoryStorage(), store = createBrowserRecoveryStore({ scope: "staff", storage });
  const updatedAt = "2026-10-21T01:02:00.000Z";
  store.write({ target: homeTarget, baseVersion: "v1", baseRevision: 1, document: { ...structuredClone(fixture), title: "端末の編集" }, updatedAt });
  const app = await setup({ props: { recovery: store } });
  try {
    await flush();
    const banner = document.querySelector(".e-recovery");
    assert.equal(banner.getAttribute("role"), "status");
    assert.ok(banner.textContent.includes(`保存されていない変更があります（${localTime(updatedAt)}）`)); assert.ok(!banner.textContent.includes("その後"));
    await press(buttonIn(banner, "比較する")); assert.ok(dialog().textContent.includes("端末に残っていた内容")); assert.ok(dialog().textContent.includes("保存済みの内容"));
    await press(buttonIn(dialog(), "閉じる"));
    await press(buttonIn(document.querySelector(".e-recovery"), "復元する"));
    assert.equal(document.querySelector(".e-recovery"), null); assert.equal(input("ページタイトル").value, "端末の編集"); assert.equal(status(), "未保存の変更あり");
    assert.ok(document.querySelector(".e-notice").textContent.includes("端末に残っていた変更を復元しました。保存すると新しい版として記録されます。"));
    await click("元に戻す"); assert.equal(input("ページタイトル").value, fixture.title); await click("やり直す");
    await wait(900);
    const stored = JSON.parse(storage.getItem(recoveryKey));
    assert.equal(stored.document.title, "端末の編集"); assert.equal(stored.baseVersion, "v1"); assert.deepEqual(Object.keys(stored), ["v", "target", "baseVersion", "baseRevision", "document", "updatedAt"]);
    await click("下書き保存"); await flush(); assert.equal(storage.getItem(recoveryKey), null);
  } finally { await app.cleanup(); }
});

test("stale recovery compares before restoring, discard removes it, identical entries are dropped and discarded navigation clears it", async () => {
  const storage = memoryStorage(), store = createBrowserRecoveryStore({ scope: "staff", storage });
  const write = (document, baseVersion = "v1") => store.write({ target: homeTarget, baseVersion, baseRevision: 1, document, updatedAt: new Date().toISOString() });
  write({ ...structuredClone(fixture), title: "古い基準の編集" }, "v0");
  let app = await setup({ props: { recovery: store } });
  try {
    await flush(); const banner = document.querySelector(".e-recovery");
    assert.ok(banner.textContent.includes("その後、別の保存がありました。"));
    await press(buttonIn(banner, "復元する")); assert.ok(dialog(), "a stale entry is compared first"); assert.equal(input("ページタイトル").value, fixture.title);
    assert.ok(dialog().textContent.includes("古い基準の編集"));
    await press(buttonIn(dialog(), "復元した内容で編集を続ける")); assert.equal(dialog(), null); assert.equal(input("ページタイトル").value, "古い基準の編集");
  } finally { await app.cleanup(); }
  write({ ...structuredClone(fixture), title: "捨てる退避" });
  app = await setup({ props: { recovery: store } });
  try {
    await flush(); await press(buttonIn(document.querySelector(".e-recovery"), "破棄")); await flush();
    assert.equal(document.querySelector(".e-recovery"), null); assert.equal(storage.getItem(recoveryKey), null); assert.equal(input("ページタイトル").value, fixture.title);
  } finally { await app.cleanup(); }
  write({ ...structuredClone(fixture), revision: 9 });
  app = await setup({ props: { recovery: store } });
  try {
    await flush(); assert.equal(document.querySelector(".e-recovery"), null); assert.equal(storage.getItem(recoveryKey), null);
    await change(input("ページタイトル"), "退避される編集"); await wait(900);
    assert.equal(JSON.parse(storage.getItem(recoveryKey)).document.title, "退避される編集");
    await clickPage("別ページ"); await click("変更を破棄して移動"); await flush();
    assert.equal(storage.getItem(recoveryKey), null);
  } finally { await app.cleanup(); }
  const failing = { read: () => null, write: () => { throw new RecoveryTooLargeError(); }, remove: () => {} };
  app = await setup({ props: { recovery: failing } });
  try {
    await change(input("ページタイトル"), "大きな編集"); await wait(900);
    assert.ok(document.querySelector(".e-notice").textContent.includes("変更が大きすぎるため端末へ退避していません。保存して作業を残してください。"));
  } finally { await app.cleanup(); }
});

function historyHost(overrides = {}) {
  const calls = { lists: [], reads: [], snapshots: [] };
  const old = structuredClone(fixture); old.title = "以前のタイトル"; old.body[0].children[0].children[0].text = "以前の見出し";
  const entries = [
    { id: "rev_3", revision: 3, kind: "autosave", createdAt: "2026-10-21T03:00:00.000Z", actor: "編集者A" },
    { id: "rev_2", revision: 2, kind: "snapshot", createdAt: "2026-10-20T02:00:00.000Z", actor: "編集者B", label: "公開前の確認" },
    { id: "rev_1", revision: 1, kind: "publish", createdAt: "2026-10-19T01:00:00.000Z", actor: "編集者A" }
  ];
  const adapter = {
    listRevisions: async (request) => {
      calls.lists.push(structuredClone(request)); const start = request.cursor ? Number(request.cursor) : 0;
      return { entries: entries.slice(start, start + 2), ...(start + 2 < entries.length ? { next: String(start + 2) } : {}) };
    },
    readRevision: async (request) => { calls.reads.push(structuredClone(request)); return { document: { ...structuredClone(old), pageId: request.target.pageId } }; },
    createSnapshot: async (request) => { calls.snapshots.push(structuredClone(request)); return overrides.snapshot?.(request) ?? { status: "saved", entry: { id: "snap_new", revision: 1, kind: "snapshot", createdAt: "2026-10-21T05:00:00.000Z", actor: "あなた", label: request.label } }; }
  };
  return { calls, adapter, entries };
}
const versionRows = () => [...document.querySelectorAll(".e-versions .e-version")];

test("the version panel lists revisions, loads more, shows a revision read-only, compares it and restores it as an edit", async () => {
  const host = historyHost(), app = await setup({ adapter: host.adapter });
  try {
    await press(toolbarButton("履歴")); assert.equal(toolbarButton("履歴").getAttribute("aria-pressed"), "true");
    assert.ok(document.querySelector('.e-right [aria-label="バージョン管理"]')); assert.equal(document.querySelector(".e-inspector-tabs"), null);
    assert.deepEqual(host.calls.lists[0], { target: homeTarget });
    assert.deepEqual(versionRows().map((row) => row.querySelector(".e-version-time").textContent), ["現在の編集内容", localTime(host.entries[0].createdAt), localTime(host.entries[1].createdAt)]);
    assert.ok(versionRows()[1].textContent.includes("自動保存") && versionRows()[1].textContent.includes("編集者A"));
    assert.ok(versionRows()[2].textContent.includes("スナップショット") && versionRows()[2].textContent.includes("公開前の確認"));
    await click("さらに表示"); assert.deepEqual(host.calls.lists[1], { target: homeTarget, cursor: "2" });
    assert.equal(versionRows().length, 4); assert.ok(versionRows()[3].textContent.includes("公開")); assert.equal(button("さらに表示"), undefined);
    await press(versionRows()[1]);
    assert.deepEqual(host.calls.reads[0], { target: homeTarget, id: "rev_3" });
    const bar = document.querySelector(".e-history-bar");
    assert.ok(bar.textContent.includes(`${localTime(host.entries[0].createdAt)} · 自動保存`));
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("以前の見出し"));
    for (const name of ["下書き保存", "公開前の確認", "プレビュー", "元に戻す"]) assert.equal(toolbarButton(name).disabled, true, name);
    assert.equal(buttonIn(bar, "公開版をこの版に戻す…"), undefined);
    await press(buttonIn(bar, "差分を見る"));
    for (const expected of ["現在の編集内容", "この版", "ページタイトル", "以前のタイトル", fixture.title]) assert.ok(dialog().textContent.includes(expected), expected);
    await press(buttonIn(dialog(), "閉じる"));
    await press(buttonIn(document.querySelector(".e-history-bar"), "この版を復元"));
    assert.equal(document.querySelector(".e-history-bar"), null); assert.equal(status(), "未保存の変更あり"); assert.equal(toolbarButton("下書き保存").disabled, false);
    assert.ok(document.querySelector(".e-notice").textContent.includes(`${localTime(host.entries[0].createdAt)} の版を作業コピーに復元しました。`));
    await press(toolbarButton("履歴")); assert.equal(input("ページタイトル").value, "以前のタイトル");
    await click("元に戻す"); assert.equal(input("ページタイトル").value, fixture.title);
  } finally { await app.cleanup(); }
});

test("published revisions can start the rollback confirmation, snapshots require a saved state, and page switches close the panel", async () => {
  let snapshotResult;
  const host = historyHost({ snapshot: () => snapshotResult }), app = await setup({ adapter: host.adapter });
  try {
    await press(toolbarButton("履歴")); await click("さらに表示");
    await press(versionRows()[3]);
    assert.ok(document.querySelector(".e-versions").textContent.includes("版の表示を閉じてから作成できます。"));
    await press(buttonIn(document.querySelector(".e-history-bar"), "公開版をこの版に戻す…"));
    assert.equal(app.calls.prepares[0].action, "rollback"); assert.equal(app.calls.prepares[0].revision, 1); assert.ok(dialog().textContent.includes("版 1 に戻す前の確認"));
    await press(buttonIn(dialog(), "編集に戻る")); assert.equal(document.querySelector(".e-history-bar"), null);
    const plus = document.querySelector('[aria-label="スナップショットを作成"]'); assert.equal(plus.disabled, false);
    await press(plus); const name = inputIn(dialog(), "スナップショット名"); assert.match(name.value, /^スナップショット \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    await change(name, "a\u0007b"); await press(buttonIn(dialog(), "作成する")); assert.ok(dialog().textContent.includes("120文字以内")); assert.equal(host.calls.snapshots.length, 0);
    snapshotResult = { status: "conflict" }; await change(inputIn(dialog(), "スナップショット名"), "公開前"); await press(buttonIn(dialog(), "作成する"));
    assert.ok(dialog().textContent.includes("保存先が更新されています（409）。最新の状態を確認してから作成してください。"));
    snapshotResult = undefined; await press(buttonIn(dialog(), "作成する"));
    assert.deepEqual(host.calls.snapshots.at(-1), { target: homeTarget, expectedVersion: "v1", label: "公開前" });
    assert.equal(dialog(), null); assert.ok(versionRows()[1].textContent.includes("公開前")); assert.ok(document.querySelector(".e-notice").textContent.includes("スナップショットを作成しました。"));
    await press(versionRows()[2]); await press(buttonIn(document.querySelector(".e-history-bar"), "この版を復元"));
    assert.equal(document.querySelector('[aria-label="スナップショットを作成"]').disabled, true, "snapshots need a saved state");
    assert.ok(document.querySelector(".e-versions").textContent.includes("スナップショットは保存済みの状態にだけ作成できます。"));
    await press(versionRows()[4]); assert.equal(buttonIn(document.querySelector(".e-history-bar"), "公開版をこの版に戻す…").disabled, true);
    assert.ok(document.querySelector(".e-versions").textContent.includes("スナップショットは保存済みの状態にだけ作成できます。"));
    await press(buttonIn(document.querySelector(".e-history-bar"), "閉じる"));
    await click("下書き保存"); assert.equal(document.querySelector('[aria-label="スナップショットを作成"]').disabled, false);
    await clickPage("別ページ"); assert.equal(document.querySelector(".e-versions"), null); assert.equal(toolbarButton("履歴").getAttribute("aria-pressed"), "false");
  } finally { await app.cleanup(); }
});

test("release confirmation shows the plan URL and the affected shared parts, pages and site settings", async () => {
  const app = await setup({ adapter: { prepareRelease: async (request) => ({ ...request, confirmationToken: "t", domain: "https://example.test", changes: [], url: "https://example.test/about-us",
    affected: [{ kind: "shared", name: "ヘッダー", detail: "全ページのナビゲーション" }, { kind: "page", name: "ホーム" }, { kind: "site", name: "サイト共通の設定" }] }) } });
  try {
    await click("公開前の確認"); const text = dialog().textContent;
    for (const expected of ["公開URL", "https://example.test/about-us", "影響する共通部品・ページ・サイト設定", "共通部品", "ヘッダー", "全ページのナビゲーション", "ページ", "サイト設定", "サイト共通の設定"]) assert.ok(text.includes(expected), expected);
  } finally { await app.cleanup(); }
});
