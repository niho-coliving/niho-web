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
const { renderToString } = await import("react-dom/server");
const { PageEditor } = await import("@niho/web/editor");
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
    readDocument: async (target) => { calls.reads.push(structuredClone(target)); return { document: { ...structuredClone(stored), pageId: target.pageId }, version, releases: [{ revision: 1, label: "最初の公開" }], ...(options.locks ? { locks: options.locks } : {}) }; },
    saveDraft: async (request) => {
      calls.saves.push(structuredClone(request));
      if (options.save) return options.save(request);
      stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision };
    },
    prepareRelease: async (request) => { calls.prepares.push(request); return { ...request, confirmationToken: "reviewed-token", domain: options.domain ?? "https://example.test", changes: [{ path: "見出し", before: "現在の見出し", after: "編集した見出し" }] }; },
    release: async (request) => { calls.releases.push(request); return { status: "released", snapshot: { document: stored, version: "released-v3" } }; },
    ...options.adapter
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.insertableBlocks ? { insertableBlocks: options.insertableBlocks } : {}) }))); await flush();
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
test("host can hide business block insertion while retaining existing block editing", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "Before" } });
  const blocks = { Notice: { props: { heading: { type: "string", required: true } }, component: ({ heading }) => createElement("p", null, heading) } };
  const app = await setup({ document: doc, blocks, insertableBlocks: [] });
  try {
    assert.equal(document.querySelector('select[aria-label="追加する要素"] option[value="block:Notice"]'), null);
    await click("Notice · notice"); await change(input("heading"), "After"); await click("下書き保存");
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
/** 右レールの「ページ」「サイト」タブを開き、その内容を返す。 */
async function panel(name) {
  const tab = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name);
  assert.ok(tab, name); if (tab.getAttribute("aria-selected") !== "true") await press(tab);
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
    assert.equal(document.querySelector('[aria-label="ページ"]'), null);
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
