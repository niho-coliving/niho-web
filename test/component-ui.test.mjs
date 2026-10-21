import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { parseComponentLibrary, parsePageDocument } from "@niho/web/core";
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

const header = () => ({
  id: "site_header", name: "サイトヘッダー", kind: "navigation", version: 1,
  root: { type: "element", id: "n1", tag: "nav", attrs: { "aria-label": "サイト内" }, children: [
    { type: "element", id: "n2", tag: "a", attrs: { href: "/" }, children: [{ type: "text", text: "ホーム" }] },
    { type: "element", id: "n3", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "紹介" }] }
  ] },
  props: { secondLabel: { label: "2つ目のリンク", node: "n3", field: "text" } }
});
const heading = () => ({
  id: "section_heading", name: "セクション見出し", kind: "section", version: 1,
  root: { type: "element", id: "n1", tag: "h2", children: [{ type: "text", text: "お知らせ" }] },
  props: { title: { label: "見出しの文字", node: "n1", field: "text" } }
});
const spare = () => ({ id: "spare", name: "予備の帯", kind: "part", version: 1, root: { type: "element", id: "n1", tag: "div", children: [{ type: "element", id: "n2", tag: "p", children: [{ type: "text", text: "予備" }] }] } });
// 一覧の並び（種類順）と配列の順を変えておく。
const library = () => ({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [spare(), heading(), header()] });
const page = (instance = {}) => ({ ...structuredClone(fixture), body: [{ type: "instance", id: "top_nav", component: "site_header", ...instance }, ...structuredClone(fixture.body)] });
const target = (pageId) => ({ siteId: "demo", pageId, locale: "ja-JP" });
// role の無い共通枠は、ページ一覧の kind（shared）から種類を補う。
const defaultUsage = () => [
  { target: target("home"), title: "ホーム", role: "page", components: { site_header: 1 } },
  { target: target("other"), title: "別ページ", role: "template", components: { site_header: 1, section_heading: 1 } },
  { target: target("chrome"), title: "サイトの共通枠", reach: 2, components: { site_header: 1 } }
];

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const button = (text, scope = document) => [...scope.querySelectorAll("button")].find((node) => node.textContent === text);
const input = (text, scope = document) => [...scope.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
async function click(target, scope) { const element = typeof target === "string" ? button(target, scope) : target; assert.ok(element, String(target)); await act(async () => element.click()); await flush(); }
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
const pageRow = (title) => [...document.querySelectorAll("button.e-page")].find((node) => node.querySelector(".e-page-name")?.textContent === title);
const canvas = () => document.querySelector('iframe[title="ページのライブキャンバス"]');
const rendered = (id) => canvas().contentDocument.querySelector(`[data-nw-node="${id}"]`);
async function loadCanvas() { const frame = canvas(); assert.ok(frame); await act(async () => frame.dispatchEvent(new dom.window.Event("load"))); await flush(); }
async function canvasEvent(id, type) {
  const frame = canvas(), element = rendered(id); assert.ok(element, id);
  await act(async () => element.dispatchEvent(new frame.contentWindow.MouseEvent(type, { bubbles: true, cancelable: true }))); await flush();
}
// jsdom には DragEvent が無いため、React が読む dataTransfer だけを持つイベントを送る。
async function drag(target, type, win = dom.window) {
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", dropEffect: "", setData() {}, getData: () => "" } });
  await act(async () => target.dispatchEvent(event)); await flush();
}
const card = (name) => document.querySelector(`article.e-part-card[aria-label="${name}"]`);
const cardNames = () => [...document.querySelectorAll("article.e-part-card")].map((node) => node.getAttribute("aria-label"));
const dialog = () => document.querySelector('[role="dialog"]');
const openPanel = () => click(document.querySelector('nav[aria-label="編集ツール"] button[title="部品"]'));
async function openPage(title) { await click(document.querySelector('nav[aria-label="編集ツール"] button[title="ページ"]')); await click(pageRow(title)); await openPanel(); }
const text = () => document.body.textContent;
const status = () => document.querySelector(".e-status").textContent;
const right = () => document.querySelector('[aria-label="インスペクタ"]');
const stateButton = (name) => right().querySelector(`[role="group"][aria-label="編集する状態"] button[title="${name}"]`);
const canvasExtra = () => [...canvas().contentDocument.querySelectorAll("style")].at(-1).textContent;

async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const calls = { order: [], reads: [], saves: [], prepares: [], releases: [], libraryReads: [], librarySaves: [], usage: [] };
  let stored = structuredClone(options.document ?? page()), version = "v1", storedLibrary = structuredClone(options.library ?? library()), libraryVersion = 1;
  const components = {
    readLibrary: async (siteId) => {
      calls.order.push("readLibrary"); calls.libraryReads.push(siteId);
      const custom = options.readLibrary && await options.readLibrary(siteId);
      if (custom) return custom;
      return { library: structuredClone(storedLibrary), version: `lib-${libraryVersion}` };
    },
    saveLibrary: async (request) => {
      calls.order.push("saveLibrary"); calls.librarySaves.push(structuredClone(request));
      const custom = options.saveLibrary && await options.saveLibrary(request);
      if (custom) return custom;
      storedLibrary = { ...structuredClone(request.library), revision: storedLibrary.revision + 1 }; libraryVersion++;
      return { status: "saved", version: `lib-${libraryVersion}`, revision: storedLibrary.revision };
    },
    listUsage: async (siteId) => { calls.usage.push(siteId); if (options.listUsage) return options.listUsage(); return defaultUsage(); }
  };
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => {
      calls.order.push("listPages");
      return [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" }, { siteId: "demo", pageId: "chrome", locale: "ja-JP", title: "サイトの共通枠", kind: "shared" }];
    },
    readDocument: async (request) => { calls.order.push("readDocument"); calls.reads.push(structuredClone(request)); return { document: { ...structuredClone(stored), pageId: request.pageId }, version, releases: [{ revision: 1, label: "最初の公開" }], ...(options.readOnly ? { readOnly: options.readOnly } : {}), ...(options.locks ? { locks: options.locks } : {}) }; },
    saveDraft: async (request) => {
      calls.order.push("saveDraft"); calls.saves.push(structuredClone(request));
      const custom = options.saveDraft && await options.saveDraft(request);
      if (custom) return custom;
      stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision };
    },
    prepareRelease: async (request) => { calls.prepares.push(structuredClone(request)); return { ...request, confirmationToken: "reviewed-token", domain: "https://example.test", changes: [] }; },
    release: async (request) => { calls.releases.push(structuredClone(request)); return { status: "released", snapshot: { document: stored, version: "released-v3" } }; },
    ...(options.components === false ? {} : { components }), ...options.adapter
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, ...(options.blocks ? { blocks: options.blocks } : {}), ...(options.insertableBlocks ? { insertableBlocks: options.insertableBlocks } : {}), ...options.props })));
  for (let attempt = 0; attempt < 5 && !canvas(); attempt++) await flush();
  if (canvas()) await loadCanvas();
  // ほかのスタッフが部品ライブラリを保存した状態を作る。
  const host = { saveRemotely: (update) => { storedLibrary = update(structuredClone(storedLibrary)); libraryVersion++; } };
  return { calls, adapter, host, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const memoryStorage = () => {
  const data = new Map();
  return { data, get length() { return data.size; }, key: (index) => [...data.keys()][index] ?? null, getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); } };
};
const libraryBanner = () => document.querySelector('[aria-label="端末に残っていた部品の変更"]');
const withComponent = (id, update) => (source) => ({ ...source, components: source.components.map((component) => component.id === id ? update(component) : component) });
async function renameCard(from, to) { await click(button("名前を変更", card(from))); await change(input("部品名", dialog()), to); await click(button("変更する", dialog())); }
const twoSites = {
  listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }, { id: "other", name: "別サイト", domains: ["https://other.example.test"] }],
  listPages: async (siteId) => siteId === "demo" ? [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }] : []
};
const otherSiteLibrary = (siteId) => siteId === "other" ? { library: { ...library(), siteId: "other" }, version: "other-1" } : undefined;

test("hosts without a component adapter keep today's panels, inspector and requests", async () => {
  const app = await setup({ components: false, document: fixture });
  try {
    assert.deepEqual(app.calls.order, ["listPages", "readDocument"]);
    await openPanel();
    const panel = document.querySelector('section[aria-label="部品"]');
    assert.deepEqual([...panel.querySelectorAll("h3")].map((node) => node.textContent), []);
    assert.equal(document.querySelector('input[aria-label="共通部品を検索"]'), null);
    assert.ok(panel.textContent.includes("このサイトの部品はまだ登録されていません。"));
    await click("section · hero");
    assert.equal(button("部品にする"), undefined); assert.ok(!text().includes("共通部品"));
    assert.equal(document.querySelector(".e-hold"), null); assert.equal(button("公開前の確認").getAttribute("title"), null);
    await click("公開前の確認"); assert.equal(Object.hasOwn(app.calls.prepares[0], "componentsVersion"), false);
  } finally { await app.cleanup(); }
});

test("the library loads before pages and the panel sorts, searches and summarizes usage", async () => {
  const app = await setup();
  try {
    assert.deepEqual(app.calls.order.slice(0, 3), ["readLibrary", "listPages", "readDocument"]); assert.deepEqual(app.calls.usage, ["demo"]);
    assert.ok(button("◇ サイトヘッダー"), "instance layers show the component name");
    assert.equal(rendered("top_nav--n2").textContent, "ホーム");
    await openPanel();
    assert.deepEqual(cardNames(), ["サイトヘッダー", "セクション見出し", "予備の帯"]);
    assert.ok(card("サイトヘッダー").textContent.includes("ナビゲーション · 3文書で使用・共通枠"));
    assert.ok(card("セクション見出し").textContent.includes("セクション · 1文書で使用"));
    assert.ok(card("予備の帯").textContent.includes("パーツ · 未使用"));
    const thumbnail = card("サイトヘッダー").querySelector("iframe");
    assert.equal(thumbnail.getAttribute("aria-hidden"), "true"); assert.equal(thumbnail.getAttribute("tabindex"), "-1"); assert.equal(thumbnail.getAttribute("sandbox"), "allow-same-origin");
    await act(async () => thumbnail.dispatchEvent(new dom.window.Event("load"))); await flush();
    assert.ok(thumbnail.contentDocument.body.textContent.includes("紹介"));
    const search = document.querySelector('input[type="search"][aria-label="共通部品を検索"]');
    assert.equal(search.placeholder, "部品名で検索");
    await change(search, "見出し"); assert.deepEqual(cardNames(), ["セクション見出し"]);
    await change(search, "ヘッダー"); assert.deepEqual(cardNames(), ["サイトヘッダー"]);
    await change(search, "存在しない"); assert.deepEqual(cardNames(), []); assert.ok(text().includes("「存在しない」に一致する部品はありません。"));
  } finally { await app.cleanup(); }
});

test("配置 adds an instance to the page draft without saving the library", async () => {
  const app = await setup();
  try {
    await openPanel(); await click(button("配置", card("予備の帯")));
    assert.ok(rendered("node_1--n2"), "the placed instance renders resolved");
    assert.ok(card("予備の帯").textContent.includes("1文書で使用"));
    assert.equal(button("削除", card("予備の帯")).disabled, true);
    await click("下書き保存");
    assert.equal(app.calls.librarySaves.length, 0);
    const saved = app.calls.saves[0].document;
    assert.deepEqual(saved.body.at(-1), { type: "instance", id: "node_1", component: "spare" });
    assert.doesNotThrow(() => parsePageDocument(saved, {}, { components: parseComponentLibrary(library()) }));
  } finally { await app.cleanup(); }
});

test("部品にする registers the selection and saves the library before the page", async () => {
  const app = await setup();
  try {
    await click("section · hero"); assert.ok(text().includes("選んだ要素を共通部品に登録し、ほかのページでも使えるようにします。"));
    await click("部品にする");
    assert.equal(dialog().getAttribute("aria-label"), "共通部品にする"); assert.equal(input("種類", dialog()).value, "section");
    await click(button("登録する", dialog())); assert.ok(dialog().textContent.includes("部品の名前を入力してください。"));
    await change(input("部品名", dialog()), "サイトヘッダー"); await click(button("登録する", dialog()));
    assert.ok(dialog().textContent.includes("同じ名前の部品があります。"));
    await change(input("部品名", dialog()), "紹介セクション"); await click(button("登録する", dialog()));
    assert.equal(dialog(), null);
    assert.ok(button("◇ 紹介セクション")); assert.ok(text().includes("この部品にはページごとに変えられる値がありません。「部品を編集」で設定できます。"));
    assert.equal(rendered("hero--n2").textContent, "海のそばで過ごす");
    assert.equal(button("公開前の確認").disabled, true);
    await click("下書き保存");
    assert.deepEqual(app.calls.order.filter((call) => call.startsWith("save")), ["saveLibrary", "saveDraft"]);
    assert.equal(app.calls.librarySaves[0].expectedVersion, "lib-1"); assert.equal(app.calls.librarySaves[0].siteId, "demo");
    const sent = parseComponentLibrary(app.calls.librarySaves[0].library), created = sent.components.find((component) => component.name === "紹介セクション");
    assert.deepEqual([created.kind, created.version, created.root.id, created.root.tag], ["section", 1, "n1", "section"]);
    const draft = parsePageDocument(app.calls.saves[0].document, {}, { components: sent });
    assert.deepEqual(draft.body[1], { type: "instance", id: "hero", component: created.id });
    assert.equal(button("下書き保存").disabled, true); assert.equal(button("公開前の確認").disabled, false);
    // 部品とページの履歴は別。ページが使う部品を消す取り消しは止め、ページ側を戻した後なら部品も戻せる。
    await openPanel(); await click(button("編集", card("紹介セクション"))); await loadCanvas();
    await click("元に戻す"); assert.ok(text().includes("共通部品とページの内容が合わなくなるため、この操作はできません。")); assert.ok(card("紹介セクション"));
    await click(button("ページに戻る", document.querySelector(".e-part-banner"))); await loadCanvas();
    await click("元に戻す"); assert.ok(button("section · hero"));
    await click(button("編集", card("紹介セクション"))); await loadCanvas();
    await click("元に戻す"); assert.equal(card("紹介セクション"), null); assert.equal(document.querySelector(".e-part-banner"), null, "the removed master leaves component mode");
  } finally { await app.cleanup(); }
});

test("master edits reach the page instance, history and banner, and bump the saved version", async () => {
  const app = await setup();
  try {
    await openPanel(); await click(button("編集", card("サイトヘッダー"))); await loadCanvas();
    assert.equal(document.querySelector(".e-part-banner [role=status]").textContent, "◇ 共通部品「サイトヘッダー」を編集中 · 保存すると使用中の3文書に反映されます");
    assert.ok(card("サイトヘッダー").textContent.includes("編集中")); assert.equal(button("公開前の確認").disabled, true);
    assert.ok(text().includes("部品の設定")); assert.ok(text().includes("サイトの共通枠共通枠")); assert.ok(text().includes("別ページテンプレート")); assert.ok(text().includes("ホームページ（編集中・未保存を含む）"));
    await click("a · n2"); await change(input("テキスト"), "トップ");
    assert.equal(rendered("n2").textContent, "トップ"); assert.equal(document.querySelector(".e-status").textContent, "未保存の変更あり");
    await click("元に戻す"); assert.equal(rendered("n2").textContent, "ホーム");
    await click("やり直す"); assert.equal(rendered("n2").textContent, "トップ");
    await click(button("ページに戻る", document.querySelector(".e-part-banner"))); await loadCanvas();
    assert.equal(document.querySelector(".e-part-banner"), null);
    assert.equal(rendered("top_nav--n2").textContent, "トップ");
    assert.equal(button("公開前の確認").disabled, true); assert.equal(document.querySelector(".e-hold").textContent, "部品の変更を保存してから公開を確認してください。");
    await click("下書き保存");
    assert.equal(app.calls.saves.length, 0, "an unchanged page is not saved");
    const sent = app.calls.librarySaves[0].library;
    assert.deepEqual(sent.components.map(({ id, version }) => [id, version]), [["spare", 1], ["section_heading", 1], ["site_header", 2]]);
    assert.equal(sent.components.at(-1).root.children[0].children[0].text, "トップ");
    assert.equal(button("下書き保存").disabled, true); assert.equal(button("公開前の確認").disabled, false); assert.deepEqual(app.calls.usage, ["demo", "demo"]);
    // ダブルクリックで、インスタンス内の対応するノードを選んだ状態で部品の編集を開く。
    await canvasEvent("top_nav--n3", "click"); assert.ok(document.querySelector(".e-inspector-content h2").textContent.includes("サイトヘッダー"));
    await canvasEvent("top_nav--n3", "dblclick"); await loadCanvas();
    assert.ok(document.querySelector(".e-part-banner")); assert.equal(document.querySelector(".e-inspector-content h2").textContent, "a · n3");
  } finally { await app.cleanup(); }
});

test("a read-only source document keeps the canonical shared-component editor writable", async () => {
  const app = await setup({ readOnly: { reason: "原文は業務編集画面が正本です。", editUrl: "/staff/business/public-text/home" } });
  try {
    assert.equal(input("ページタイトル").disabled, true);
    await openPanel();
    assert.equal(button("配置", card("予備の帯")).disabled, true, "page insertion remains blocked");
    await click(button("編集", card("サイトヘッダー"))); await loadCanvas();
    await click("a · n2");
    assert.equal(input("テキスト").disabled, false, "the separate component master keeps its own authority");
    await change(input("テキスト"), "共通トップ"); await click("下書き保存");
    assert.equal(app.calls.librarySaves.length, 1); assert.equal(app.calls.saves.length, 0);
    assert.equal(app.calls.librarySaves[0].library.components.find((component) => component.id === "site_header").root.children[0].children[0].text, "共通トップ");
  } finally { await app.cleanup(); }
});

test("master public props and settings are edited in component mode", async () => {
  const app = await setup();
  try {
    await openPanel(); await click(button("編集", card("セクション見出し"))); await loadCanvas();
    assert.ok(text().includes("別ページテンプレート")); assert.equal(input("種類").value, "section");
    await change(input("種類"), "part"); await change(input("部品名"), "小見出し");
    assert.ok(document.querySelector(".e-part-banner").textContent.includes("「小見出し」"));
    await click(document.querySelector('button[aria-label="「見出しの文字」の公開をやめる"]'));
    await click("h2 · n1");
    const checkbox = [...document.querySelectorAll("label.e-check")].find((label) => label.textContent === "ページごとに変えられるようにする（文字）").querySelector("input");
    assert.equal(checkbox.checked, false);
    await click(checkbox); assert.equal(input("値の名前（文字）").value, "文字");
    await change(input("値の名前（文字）"), "見出し");
    await click("下書き保存");
    const saved = app.calls.librarySaves[0].library.components.find((component) => component.id === "section_heading");
    assert.deepEqual([saved.name, saved.kind, saved.version], ["小見出し", "part", 2]);
    assert.deepEqual(saved.props, { n1_text: { label: "見出し", node: "n1", field: "text" } });
  } finally { await app.cleanup(); }
});

test("page values override public props, can return to the master value and stale values are cleaned", async () => {
  const app = await setup({ document: page({ props: { oldLabel: "旧" } }) });
  try {
    await click("◇ サイトヘッダー");
    assert.ok(text().includes("ナビゲーション · 3文書で使用・共通枠")); assert.ok(text().includes("外枠の見た目はこのページだけに適用されます。"));
    assert.equal(input("2つ目のリンク").value, "紹介"); assert.ok(text().includes("部品の値を使用中"));
    await change(input("2つ目のリンク"), "会社概要");
    assert.equal(rendered("top_nav--n3").textContent, "会社概要"); assert.ok(text().includes("このページだけの値"));
    await click("部品の値に戻す"); assert.equal(rendered("top_nav--n3").textContent, "紹介"); assert.ok(text().includes("部品の値を使用中"));
    await change(input("2つ目のリンク"), "会社概要"); await change(input("2つ目のリンク"), "紹介");
    assert.ok(text().includes("部品の値を使用中"), "a value equal to the master removes the override");
    assert.ok(text().includes("部品の更新で使われなくなった値が1件あります。"));
    await click("整理する"); assert.ok(!text().includes("使われなくなった値"));
    await change(input("2つ目のリンク"), "会社概要"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body[0], { type: "instance", id: "top_nav", component: "site_header", props: { secondLabel: "会社概要" } });
    await click("元に戻す"); await click("元に戻す"); await click("◇ サイトヘッダー");
    assert.ok(text().includes("部品の更新で使われなくなった値が1件あります。"), "cleaning stale values was one history step");
  } finally { await app.cleanup(); }
});

test("canvas drag and drop moves an instance as one block and never drops inside it", async () => {
  const app = await setup();
  try {
    await canvasEvent("top_nav--n2", "click");
    assert.equal(rendered("top_nav").getAttribute("draggable"), "true"); assert.equal(rendered("top_nav--n2").getAttribute("draggable"), null);
    const win = canvas().contentWindow;
    await drag(rendered("top_nav--n2"), "dragstart", win); await drag(rendered("lead"), "dragover", win); await drag(rendered("lead"), "drop", win);
    assert.ok(button("◇ サイトヘッダー").getAttribute("aria-pressed") === "true", "the moved instance stays selected");
    const palette = [...document.querySelectorAll('section[aria-label="要素を追加"] button')].find((node) => node.textContent.endsWith("テキスト"));
    await drag(palette, "dragstart"); await drag(rendered("top_nav--n3"), "dragover", win); await drag(rendered("top_nav--n3"), "drop", win);
    await click("下書き保存");
    const saved = app.calls.saves[0].document, hero = saved.body.find((node) => node.id === "hero");
    assert.deepEqual(hero.children.map((node) => node.id), ["heading", "node_1", "top_nav", "lead", "link"]);
    assert.equal(hero.children[1].tag, "p", "a drop on a node inside the instance lands before the instance");
  } finally { await app.cleanup(); }
});

test("部品を解除 asks for confirmation and saves an element with the instance id", async () => {
  const app = await setup();
  try {
    await click("◇ サイトヘッダー"); await click("部品を解除");
    assert.equal(dialog().getAttribute("aria-label"), "部品を解除");
    assert.ok(dialog().textContent.includes("この箇所は通常の要素になり、今後は部品の変更を受けません。ページごとの値と外枠の見た目はそのまま残ります。"));
    await click(button("キャンセル", dialog())); assert.equal(dialog(), null); assert.ok(button("◇ サイトヘッダー"));
    await click("部品を解除"); await click(button("解除する", dialog()));
    assert.ok(button("nav · top_nav")); assert.equal(rendered("top_nav").tagName, "NAV");
    await click("下書き保存");
    const saved = app.calls.saves[0].document.body[0];
    assert.deepEqual([saved.type, saved.id, saved.tag], ["element", "top_nav", "nav"]); assert.equal(app.calls.librarySaves.length, 0);
  } finally { await app.cleanup(); }
});

test("library save conflicts and failures keep both edits and skip the page save", async () => {
  let mode = "conflict";
  const app = await setup({ saveLibrary: async () => { if (mode === "throw409") throw { status: 409 }; if (mode === "throw") throw new Error("offline"); return { status: "conflict" }; } });
  try {
    await openPanel(); await click(button("名前を変更", card("予備の帯")));
    assert.equal(dialog().getAttribute("aria-label"), "名前を変更"); assert.equal(input("部品名", dialog()).value, "予備の帯");
    await change(input("部品名", dialog()), "予備の帯 改"); await click(button("変更する", dialog()));
    assert.ok(card("予備の帯 改")); assert.equal(document.querySelector(".e-status").textContent, "未保存の変更あり");
    await change(input("ページタイトル"), "保持するタイトル");
    await click("下書き保存");
    assert.ok(text().includes("共通部品の保存が競合しました（409）。ほかの保存で部品が更新されています。部品とページの変更は保持しています。「部品を読み直す」で最新の部品を読み込んでください。"));
    assert.equal(status(), "部品が競合しています");
    mode = "throw409"; await click("下書き保存"); assert.ok(text().includes("共通部品の保存が競合しました（409）")); assert.equal(status(), "部品が競合しています");
    mode = "throw"; await click("下書き保存"); assert.ok(text().includes("共通部品を保存できませんでした。部品とページの変更を保持しています。時間をおいて再試行してください。"));
    assert.equal(app.calls.saves.length, 0); assert.equal(app.calls.librarySaves.length, 3);
    assert.ok(app.calls.librarySaves.every((request) => request.expectedVersion === "lib-1"));
    assert.equal(input("ページタイトル").value, "保持するタイトル"); assert.ok(card("予備の帯 改")); assert.equal(button("下書き保存").disabled, false);
  } finally { await app.cleanup(); }
});

test("release requests bind componentsVersion and publishing waits for saved components", async () => {
  const app = await setup();
  try {
    await click("公開前の確認"); assert.equal(app.calls.prepares[0].componentsVersion, "lib-1");
    const affected = dialog().querySelector(".e-affected");
    assert.ok(affected.textContent.includes("影響する共通部品・ページ・サイト設定")); assert.ok(affected.textContent.includes("共通部品サイトヘッダーこのページで1か所に配置"));
    await click("編集に戻る");
    await openPanel(); await click(button("複製", card("予備の帯"))); assert.ok(card("予備の帯 のコピー"));
    assert.equal(button("公開前の確認").disabled, true); assert.equal(button("戻す内容を確認").disabled, true);
    assert.equal(document.querySelector(".e-hold").textContent, "部品の変更を保存してから公開を確認してください。");
    await click("下書き保存"); assert.equal(button("公開前の確認").disabled, false);
    await click("公開前の確認"); assert.equal(app.calls.prepares[1].componentsVersion, "lib-2");
    await act(async () => dialog().querySelector('input[type="checkbox"]').click()); await click("この内容を公開");
    assert.equal(app.calls.releases[0].componentsVersion, "lib-2");
    await click(button("複製", card("予備の帯")));
    await openPage("別ページ");
    assert.equal(dialog(), null, "page switches keep unsaved components without asking");
    assert.equal(app.calls.reads.at(-1).pageId, "other");
    assert.ok(card("予備の帯 のコピー 2")); assert.equal(app.calls.libraryReads.length, 1); assert.equal(document.querySelector(".e-status").textContent, "未保存の変更あり");
  } finally { await app.cleanup(); }
});

test("削除 stays disabled while a component is used and removes unused ones after confirmation", async () => {
  const app = await setup();
  try {
    await openPanel();
    for (const name of ["サイトヘッダー", "セクション見出し"]) { assert.equal(button("削除", card(name)).disabled, true); assert.ok(card(name).textContent.includes("使用中のため削除できません")); }
    await click(button("削除", card("予備の帯")));
    assert.equal(dialog().getAttribute("aria-label"), "共通部品を削除"); assert.ok(dialog().textContent.includes("「予備の帯」を削除します。この操作は保存すると確定します。"));
    assert.equal(button("削除する", dialog()).className, "e-danger");
    await click(button("削除する", dialog())); assert.equal(card("予備の帯"), null);
    await click("下書き保存");
    assert.deepEqual(app.calls.librarySaves[0].library.components.map((component) => component.id), ["section_heading", "site_header"]);
  } finally { await app.cleanup(); }
  const unknown = await setup({ listUsage: async () => { throw new Error("offline"); } });
  try {
    await openPanel();
    assert.ok(card("予備の帯").textContent.includes("使用状況を取得できません"));
    assert.equal(button("削除", card("予備の帯")).disabled, true); assert.ok(card("予備の帯").textContent.includes("使用状況を確認できないため削除できません"));
  } finally { await unknown.cleanup(); }
});

test("insertableBlocks restrictions disable 配置 for components containing other blocks", async () => {
  const blocks = { Notice: { label: "お知らせ", props: { heading: { type: "string", required: true } }, component: ({ heading }) => createElement("p", null, heading) } };
  const notice = { id: "notice_box", name: "お知らせ枠", kind: "section", version: 1, root: { type: "element", id: "n1", tag: "section", children: [{ type: "component", id: "n2", block: "Notice", props: { heading: "お知らせ" } }] } };
  const app = await setup({ blocks, insertableBlocks: [], library: { ...library(), components: [...library().components, notice] } });
  try {
    await openPanel();
    assert.equal(button("配置", card("お知らせ枠")).disabled, true);
    assert.ok(card("お知らせ枠").textContent.includes("追加が許可されていない業務ブロックを含むため配置できません"));
    assert.equal(button("配置", card("予備の帯")).disabled, false);
    const panel = document.querySelector('section[aria-label="部品"]');
    assert.deepEqual([...panel.querySelectorAll("h3")].map((node) => node.textContent), ["共通部品", "業務ブロック"]);
  } finally { await app.cleanup(); }
});

test("a failed library read shows a notice and still loads pages without components", async () => {
  const app = await setup({ document: fixture, readLibrary: async () => { throw new Error("offline"); } });
  try {
    assert.ok(text().includes("共通部品を読み込めませんでした。部品を含むページは表示できません。"));
    assert.deepEqual(app.calls.order, ["readLibrary", "listPages", "readDocument"]); assert.deepEqual(app.calls.usage, []);
    assert.equal(input("ページタイトル").value, fixture.title);
    await click("section · hero"); assert.equal(button("部品にする"), undefined);
    await click("公開前の確認"); assert.equal(Object.hasOwn(app.calls.prepares[0], "componentsVersion"), false);
  } finally { await app.cleanup(); }
});

test("autosave saves changed components before the page and pauses without saving the page after a library failure", async () => {
  let fail = false;
  const app = await setup({ props: { autosave: { delayMs: 100 } }, saveLibrary: async () => fail ? { status: "conflict" } : undefined });
  try {
    await openPanel(); await click(button("名前を変更", card("予備の帯"))); await change(input("部品名", dialog()), "予備の帯 改"); await click(button("変更する", dialog()));
    await change(input("ページタイトル"), "自動保存するタイトル");
    await wait(400);
    assert.deepEqual(app.calls.order.filter((call) => call.startsWith("save")), ["saveLibrary", "saveDraft"]);
    assert.equal(app.calls.librarySaves[0].trigger, "autosave"); assert.equal(app.calls.saves[0].trigger, "autosave");
    assert.ok(app.calls.librarySaves[0].library.components.some((component) => component.name === "予備の帯 改"));
    assert.ok(status().startsWith("保存済み"));
    await click(button("複製", card("予備の帯 改"))); await wait(400);
    assert.equal(app.calls.librarySaves.length, 2, "a component-only change is autosaved"); assert.equal(app.calls.saves.length, 1);
    fail = true;
    await click(button("複製", card("予備の帯 改"))); await change(input("ページタイトル"), "部品に失敗した後のタイトル"); await wait(400);
    assert.equal(app.calls.librarySaves.length, 3); assert.equal(app.calls.saves.length, 1, "the page is not saved after the component library failed");
    assert.equal(status(), "部品が競合しています"); assert.ok(text().includes("共通部品の保存が競合しました（409）"));
    await wait(400); assert.equal(app.calls.librarySaves.length, 3, "autosave pauses after a failure");
  } finally { await app.cleanup(); }
});

test("work recovery restores drafts with instances and keeps drafts the current library cannot resolve", async () => {
  const removed = [], store = (document) => {
    let entry = { target: target("home"), baseVersion: "v1", baseRevision: 1, document, updatedAt: "2026-10-21T01:02:00.000Z" };
    return { read: () => entry, write: (next) => { entry = structuredClone(next); }, remove: (place) => { removed.push(place.pageId); entry = null; } };
  };
  const restorable = await setup({ props: { recovery: store(page({ props: { secondLabel: "端末の値" } })) } });
  try {
    await flush();
    const banner = document.querySelector(".e-recovery"); assert.ok(banner, "the draft with an instance is offered");
    await click(button("復元する", banner));
    assert.equal(rendered("top_nav--n3").textContent, "端末の値"); assert.equal(status(), "未保存の変更あり");
  } finally { await restorable.cleanup(); }
  const missing = page(); missing.body[0].component = "removed_component";
  const unresolved = await setup({ props: { recovery: store(missing) } });
  try {
    await flush();
    assert.equal(document.querySelector(".e-recovery"), null);
    assert.ok(text().includes("端末に残っていた変更がありますが、共通部品の現在の内容と合わないため復元できません。"));
    assert.deepEqual(removed, [], "the unresolved draft is kept in the store");
  } finally { await unresolved.cleanup(); }
});

test("version history and the 409 comparison read page documents with instances through the library", async () => {
  let conflicted = true;
  const entry = { id: "rev-1", revision: 1, kind: "draft", createdAt: "2026-10-20T09:00:00.000Z", actor: "デモ編集者" };
  const app = await setup({
    adapter: { listRevisions: async () => ({ entries: [entry] }), readRevision: async () => ({ document: page({ props: { secondLabel: "過去の値" } }) }) },
    saveDraft: async () => conflicted ? { status: "conflict" } : undefined
  });
  try {
    await click("履歴"); await click([...document.querySelectorAll("button.e-version")].find((node) => !node.classList.contains("is-current")));
    await loadCanvas(); assert.equal(rendered("top_nav--n3").textContent, "過去の値");
    await click("閉じる"); await click("履歴"); await loadCanvas();
    await change(input("ページタイトル"), "競合するタイトル"); await click("下書き保存");
    assert.ok(dialog().textContent.includes("保存内容が競合しています")); assert.ok(!dialog().textContent.includes("最新の内容を取得できませんでした"));
    assert.ok(dialog().querySelector("table.e-diff").textContent.includes("競合するタイトル"));
    conflicted = false;
  } finally { await app.cleanup(); }
});

test("hover styles edit an instance's outer box on the page and nodes inside a component master", async () => {
  const app = await setup();
  try {
    await click("◇ サイトヘッダー"); await click(stateButton("ホバー")); await change(input("背景色", right()), "#eef3ef");
    assert.ok(canvasExtra().includes('[data-nw-node="top_nav"]') && canvasExtra().includes("background-color:#eef3ef"), "the hover look is forced on the instance root");
    await click(stateButton("通常"));
    await openPanel(); await click(button("編集", card("サイトヘッダー"))); await loadCanvas();
    await click("a · n2"); await click(stateButton("ホバー")); await change(input("文字色", right()), "#ff0000");
    assert.ok(canvasExtra().includes('[data-nw-node="n2"]') && canvasExtra().includes("color:#ff0000"));
    await click(stateButton("通常")); await click(button("ページに戻る", document.querySelector(".e-part-banner"))); await loadCanvas();
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body[0].style.states.hover, { backgroundColor: "#eef3ef" });
    assert.deepEqual(app.calls.librarySaves[0].library.components.find((component) => component.id === "site_header").root.children[0].style.states.hover, { color: "#ff0000" });
  } finally { await app.cleanup(); }
});

test("component-only changes are autosaved on a site without pages", async () => {
  const app = await setup({ props: { autosave: { delayMs: 100 } }, adapter: { listPages: async () => [] } });
  try {
    await openPanel(); await click(button("名前を変更", card("予備の帯"))); await change(input("部品名", dialog()), "ページのない帯"); await click(button("変更する", dialog()));
    await wait(400);
    assert.equal(app.calls.librarySaves.length, 1); assert.equal(app.calls.librarySaves[0].trigger, "autosave");
    assert.ok(app.calls.librarySaves[0].library.components.some((component) => component.name === "ページのない帯"));
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
});

test("部品を読み直す reads the latest components after a 409 and asks before discarding unsaved component changes", async () => {
  let conflicted = true;
  const app = await setup({ saveLibrary: async () => conflicted ? { status: "conflict" } : undefined });
  try {
    await openPanel(); await renameCard("予備の帯", "予備の帯 改");
    await change(input("ページタイトル"), "保持するタイトル");
    // ほかの人が先に部品を保存した。
    app.host.saveRemotely((source) => ({ ...withComponent("section_heading", (component) => ({ ...component, name: "見出し（更新済み）", version: 2 }))(source), revision: source.revision + 1 }));
    await click("下書き保存");
    assert.equal(status(), "部品が競合しています"); assert.ok(text().includes("「部品を読み直す」で最新の部品を読み込んでください。"));
    assert.equal(button("再試行"), undefined); assert.equal(button("比較する"), undefined); assert.equal(app.calls.saves.length, 0);
    await click("部品を読み直す");
    assert.deepEqual(app.calls.libraryReads, ["demo", "demo"]);
    assert.equal(dialog().getAttribute("aria-label"), "共通部品を読み直す");
    assert.ok(dialog().textContent.includes("この画面で保存していない次の部品の変更は破棄されます。"));
    assert.deepEqual([...dialog().querySelectorAll("li")].map((item) => item.textContent), ["予備の帯 改変更"]);
    await click(button("閉じて編集を続ける", dialog()));
    assert.equal(dialog(), null); assert.ok(card("予備の帯 改"), "closing keeps the unsaved change"); assert.equal(status(), "部品が競合しています");
    await click("部品を読み直す");
    const discard = button("最新の部品を読み込む（部品の変更を破棄）", dialog());
    assert.equal(discard.className, "e-danger"); await click(discard);
    assert.equal(dialog(), null);
    assert.ok(card("見出し（更新済み）")); assert.ok(card("予備の帯")); assert.equal(card("予備の帯 改"), null);
    assert.ok(text().includes("最新の共通部品を読み込みました。保存していなかった部品の変更は破棄しました。"));
    assert.equal(input("ページタイトル").value, "保持するタイトル", "the page draft is kept"); assert.equal(status(), "未保存の変更あり");
    assert.equal(button("部品を読み直す"), undefined); assert.equal(button("元に戻す").disabled, false, "page edits stay undoable");
    conflicted = false; await click("下書き保存");
    assert.equal(app.calls.librarySaves.length, 1, "the discarded component change is not saved");
    assert.deepEqual(app.calls.saves.map((request) => request.document.title), ["保持するタイトル"]);
  } finally { await app.cleanup(); }
});

test("部品を読み直す applies the latest components at once when no component change is unsaved", async () => {
  let conflicted = true;
  const app = await setup({ saveLibrary: async () => conflicted ? { status: "conflict" } : undefined });
  try {
    await openPanel(); await renameCard("予備の帯", "予備の帯 改"); await click("下書き保存");
    assert.equal(status(), "部品が競合しています");
    await renameCard("予備の帯 改", "予備の帯");
    assert.equal(button("下書き保存").disabled, true); assert.equal(status(), "部品が競合しています", "the outdated base stays reported");
    app.host.saveRemotely((source) => ({ ...withComponent("section_heading", (component) => ({ ...component, name: "見出し（更新済み）", version: 2 }))(source), revision: source.revision + 1 }));
    const usage = app.calls.usage.length;
    await click("部品を読み直す");
    assert.equal(dialog(), null, "nothing is discarded, so nothing is confirmed");
    assert.ok(card("見出し（更新済み）")); assert.ok(text().includes("最新の共通部品を読み込みました。"));
    assert.equal(status(), "保存済み"); assert.equal(app.calls.usage.length, usage + 1, "usage is read again");
    conflicted = false; await renameCard("予備の帯", "予備の帯 改"); await click("下書き保存");
    assert.equal(app.calls.librarySaves.at(-1).expectedVersion, "lib-2", "the next save is based on the version read again");
    assert.ok(status().startsWith("保存済み"));
  } finally { await app.cleanup(); }
});

test("部品を読み直す keeps the page content when the page uses a discarded or replaced component", async () => {
  let conflicted = true;
  const app = await setup({ saveLibrary: async () => conflicted ? { status: "conflict" } : undefined });
  try {
    await click("section · hero"); await click("部品にする"); await change(input("部品名", dialog()), "紹介セクション"); await click(button("登録する", dialog()));
    assert.equal(rendered("hero--n2").textContent, "海のそばで過ごす");
    // ほかの人も同じ ID で別の部品を登録して保存した。
    const others = { id: "component_1", name: "お知らせの帯", kind: "part", version: 1, root: { type: "element", id: "n1", tag: "div", children: [{ type: "element", id: "n2", tag: "p", children: [{ type: "text", text: "別の人の部品" }] }] } };
    app.host.saveRemotely((source) => ({ ...source, revision: source.revision + 1, components: [...source.components, others] }));
    await click("下書き保存"); assert.equal(status(), "部品が競合しています");
    await click("部品を読み直す");
    assert.ok(dialog().textContent.includes("編集中のページにある次の部品は、最新の共通部品と合わないため、部品を解除して通常の要素にします。文字と見た目はそのまま残ります。"));
    assert.deepEqual([...dialog().querySelectorAll("li")].map((item) => item.textContent), ["紹介セクション追加", "ink変更", "bodyFont変更", "space変更", "紹介セクション解除"]);
    await click(button("最新の部品を読み込む（部品とスタイルの変更を破棄）", dialog()));
    assert.ok(text().includes("このページの「紹介セクション」は、部品を解除して通常の要素にしました。"));
    assert.ok(button("section · hero")); assert.equal(rendered("n2").textContent, "海のそばで過ごす");
    assert.ok(!canvas().contentDocument.body.textContent.includes("別の人の部品"), "the page does not silently show someone else's component");
    assert.equal(button("元に戻す").disabled, true, "undo cannot bring back the instance that would now show someone else's component");
    await openPanel(); assert.ok(card("お知らせの帯")); assert.equal(card("紹介セクション"), null);
    conflicted = false; await click("下書き保存");
    assert.equal(app.calls.librarySaves.length, 1, "only the conflicting save reached the library");
    const saved = app.calls.saves[0].document;
    assert.deepEqual([saved.body[1].type, saved.body[1].id, saved.body[1].tag], ["element", "hero", "section"]);
  } finally { await app.cleanup(); }
});

test("部品を読み直す names the component the open page cannot use and succeeds once that instance is detached", async () => {
  const badge = { id: "badge", name: "強調ラベル", kind: "part", version: 1, root: { type: "element", id: "n1", tag: "span", children: [{ type: "text", text: "新着" }] } };
  const doc = structuredClone(fixture); doc.body[0].children[1].children.push({ type: "instance", id: "lead_badge", component: "badge" });
  let conflicted = true;
  const app = await setup({ document: doc, library: { ...library(), components: [...library().components, badge] }, saveLibrary: async () => conflicted ? { status: "conflict" } : undefined });
  try {
    await openPanel(); await renameCard("予備の帯", "予備の帯 改");
    // ほかの人が強調ラベルの外枠を div に変え、段落の中には置けなくなった。
    app.host.saveRemotely((source) => ({ ...withComponent("badge", (component) => ({ ...component, version: 2, root: { ...component.root, tag: "div" } }))(source), revision: source.revision + 1 }));
    await click("下書き保存"); await click("部品を読み直す");
    assert.equal(dialog().querySelector('[role="alert"]').textContent, "最新の共通部品では、編集中のページを表示できないため読み直せません。ページの「強調ラベル」を「部品を解除」で通常の要素にするか削除してから、もう一度読み直してください。");
    assert.equal(button("最新の部品を読み込む（部品の変更を破棄）", dialog()), undefined);
    await click(button("閉じて編集を続ける", dialog()));
    assert.ok(card("予備の帯 改"), "nothing changes"); assert.equal(status(), "部品が競合しています");
    await click("◇ 強調ラベル"); await click("部品を解除"); await click(button("解除する", dialog()));
    await click("部品を読み直す"); await click(button("最新の部品を読み込む（部品の変更を破棄）", dialog()));
    assert.ok(card("予備の帯")); assert.ok(button("span · lead_badge")); assert.equal(rendered("lead_badge").textContent, "新着");
  } finally { await app.cleanup(); }
});

test("部品を読み直す detaches a removed component on a page that uses site-wide styles", async () => {
  const doc = structuredClone(fixture); doc.body[0].children[1].style = { base: { color: { token: "brand" } } };
  let conflicted = true;
  const app = await setup({ document: doc, saveLibrary: async () => conflicted ? { status: "conflict" } : undefined,
    adapter: { readSiteSettings: async () => ({ settings: { title: "デモ", locale: "ja", tokens: { brand: { type: "color", value: "#336655" } } }, version: "s1" }) } });
  try {
    await openPanel(); await click(button("配置", card("予備の帯"))); await renameCard("セクション見出し", "見出し 改");
    // ほかの人が、保存済みの文書では使われていない予備の帯を削除して保存した。
    app.host.saveRemotely((source) => ({ ...source, revision: source.revision + 1, components: source.components.filter((component) => component.id !== "spare") }));
    await click("下書き保存"); await click("部品を読み直す");
    assert.equal(dialog().querySelector('[role="alert"]'), null, "the site-wide color does not block the reload");
    assert.deepEqual([...dialog().querySelectorAll("li")].map((item) => item.textContent), ["見出し 改変更", "予備の帯解除"]);
    await click(button("最新の部品を読み込む（部品の変更を破棄）", dialog()));
    assert.ok(text().includes("このページの「予備の帯」は、部品を解除して通常の要素にしました。")); assert.equal(rendered("node_1").textContent, "予備");
    conflicted = false; await click("下書き保存");
    const saved = app.calls.saves[0].document;
    assert.deepEqual([saved.body.at(-1).type, saved.body.at(-1).id], ["element", "node_1"]);
    assert.deepEqual(saved.body[0].children[1].style.base.color, { token: "brand" }, "the page keeps referring to the site-wide color");
  } finally { await app.cleanup(); }
});

test("unsaved component changes are kept on the device per site and offered again after reopening", async () => {
  const { createBrowserRecoveryStore } = await import("@niho/web/history");
  const storage = memoryStorage(), key = "niho-web:recovery:v1:staff-a:library/demo", store = () => createBrowserRecoveryStore({ scope: "staff-a", storage });
  const first = await setup({ props: { recovery: store() } });
  try {
    await openPanel(); await renameCard("予備の帯", "端末の帯");
    await wait(900);
    const stored = JSON.parse(storage.data.get(key));
    assert.deepEqual(Object.keys(stored), ["v", "siteId", "baseVersion", "changed", "baseTokens", "library", "updatedAt"]);
    assert.deepEqual([stored.siteId, stored.baseVersion, stored.changed], ["demo", "lib-1", { spare: 1 }]);
    assert.ok(stored.library.components.some((component) => component.name === "端末の帯"));
  } finally { await first.cleanup(); }
  // 保存しないまま開き直した（ホストのライブラリは元のまま）。
  const second = await setup({ props: { recovery: store() } });
  try {
    await flush();
    const banner = libraryBanner();
    assert.ok(banner.textContent.includes("保存されていない部品の変更があります")); assert.ok(banner.textContent.includes("復元する部品: 端末の帯（変更）"));
    await openPanel(); assert.ok(card("予備の帯"), "nothing is applied before restoring");
    await click(button("復元する", libraryBanner()));
    assert.equal(libraryBanner(), null); assert.ok(card("端末の帯")); assert.equal(status(), "未保存の変更あり");
    assert.ok(text().includes("端末に残っていた部品の変更を復元しました。保存すると使用中の文書に反映されます。"));
    await click("下書き保存"); await flush();
    assert.equal(second.calls.librarySaves[0].library.components.find((component) => component.id === "spare").name, "端末の帯");
    assert.equal(storage.data.has(key), false, "a successful save removes the device copy");
  } finally { await second.cleanup(); }
});

test("recovered component changes skip components saved again later, and 破棄 removes them", async () => {
  const removed = [], recovered = withComponent("site_header", (component) => ({ ...component, name: "端末のヘッダー" }))(withComponent("spare", (component) => ({ ...component, name: "端末の帯" }))(library()));
  const original = { siteId: "demo", baseVersion: "lib-1", changed: { spare: 1, site_header: 1 }, library: recovered, updatedAt: "2026-10-21T01:02:00.000Z" };
  let entry = structuredClone(original);
  const store = { read: () => null, write: () => {}, remove: () => {}, readLibrary: () => entry && structuredClone(entry), writeLibrary: (next) => { entry = structuredClone(next); }, removeLibrary: (siteId) => { removed.push(siteId); entry = null; } };
  // 退避した後、ほかの人がヘッダーを変更して保存した。
  const newer = () => ({ ...withComponent("site_header", (component) => ({ ...component, version: 2, root: { ...component.root, attrs: { "aria-label": "グローバル" } } }))(library()), revision: 2 });
  const app = await setup({ library: newer(), props: { recovery: store } });
  try {
    await flush();
    const banner = libraryBanner();
    assert.ok(banner.textContent.includes("復元する部品: 端末の帯（変更）"));
    assert.ok(banner.textContent.includes("ほかの保存で変更されたため復元しない部品: 端末のヘッダー"));
    await click(button("復元する", libraryBanner()));
    await openPanel(); assert.ok(card("端末の帯")); assert.ok(card("サイトヘッダー"), "the newer header is kept"); assert.equal(card("端末のヘッダー"), null);
    await click("下書き保存");
    const sent = app.calls.librarySaves[0].library.components;
    assert.equal(sent.find((component) => component.id === "site_header").root.attrs["aria-label"], "グローバル");
    assert.equal(sent.find((component) => component.id === "spare").name, "端末の帯");
  } finally { await app.cleanup(); }
  entry = structuredClone(original);
  const again = await setup({ library: newer(), props: { recovery: store } });
  try {
    await flush();
    await click(button("破棄", libraryBanner()));
    assert.equal(libraryBanner(), null); assert.equal(entry, null); assert.equal(removed.at(-1), "demo");
    await openPanel(); assert.ok(card("予備の帯"), "破棄 does not change the library");
  } finally { await again.cleanup(); }
});

test("device copies of component changes are never offered on another site", async () => {
  const { createBrowserRecoveryStore } = await import("@niho/web/history");
  const storage = memoryStorage(), store = createBrowserRecoveryStore({ scope: "staff-a", storage });
  const entry = { siteId: "demo", baseVersion: "lib-1", changed: { spare: 1 }, library: withComponent("spare", (component) => ({ ...component, name: "デモの帯" }))(library()), updatedAt: new Date().toISOString() };
  store.writeLibrary(entry);
  const otherFirst = { ...twoSites, listSites: async () => (await twoSites.listSites()).reverse() };
  const app = await setup({ adapter: otherFirst, readLibrary: otherSiteLibrary, props: { recovery: store } });
  try {
    await flush();
    assert.deepEqual(app.calls.libraryReads, ["other"]); assert.equal(libraryBanner(), null, "the demo copy is not offered on the other site");
    await openPanel(); assert.ok(card("予備の帯")); assert.equal(card("デモの帯"), null);
    await change(input("編集するサイト"), "demo"); await flush(); await flush();
    assert.ok(libraryBanner().textContent.includes("デモの帯"), "the copy is offered on its own site");
  } finally { await app.cleanup(); }
  // 退避先が別サイトの内容を返しても使わず、その鍵を消す。
  const removed = [], foreign = { read: () => null, write: () => {}, remove: () => {}, readLibrary: () => structuredClone(entry), writeLibrary: () => {}, removeLibrary: (siteId) => { removed.push(siteId); } };
  const other = await setup({ adapter: otherFirst, readLibrary: otherSiteLibrary, props: { recovery: foreign } });
  try {
    await flush();
    assert.equal(libraryBanner(), null); assert.deepEqual(removed, ["other"]);
    await openPanel(); assert.ok(card("予備の帯")); assert.equal(card("デモの帯"), null);
  } finally { await other.cleanup(); }
});

test("discarding unsaved component changes also removes their device copy", async () => {
  const { createBrowserRecoveryStore } = await import("@niho/web/history");
  const storage = memoryStorage(), key = "niho-web:recovery:v1:staff-a:library/demo";
  const app = await setup({ adapter: twoSites, readLibrary: otherSiteLibrary, saveLibrary: async () => ({ status: "conflict" }), props: { recovery: createBrowserRecoveryStore({ scope: "staff-a", storage }) } });
  try {
    await openPanel(); await renameCard("予備の帯", "予備の帯 改"); await wait(900);
    assert.ok(storage.data.has(key));
    await click("下書き保存"); await click("部品を読み直す"); await click(button("最新の部品を読み込む（部品の変更を破棄）", dialog())); await flush();
    assert.equal(storage.data.has(key), false, "部品を読み直す removes the discarded copy");
    await renameCard("予備の帯", "予備の帯 再"); await wait(900);
    assert.ok(storage.data.has(key));
    await change(input("編集するサイト"), "other");
    assert.equal(dialog().getAttribute("aria-label"), "未保存の変更");
    await click(button("変更を破棄して移動", dialog())); await flush();
    assert.equal(storage.data.has(key), false, "leaving the site with 変更を破棄して移動 removes the copy");
    assert.equal(app.calls.libraryReads.at(-1), "other"); assert.equal(libraryBanner(), null);
  } finally { await app.cleanup(); }
});

test("component device copies need a component adapter and a store with the library methods", async () => {
  const calls = [];
  const spy = { read: () => null, write: () => {}, remove: () => {}, readLibrary: (siteId) => { calls.push(`read ${siteId}`); return null; }, writeLibrary: () => { calls.push("write"); }, removeLibrary: () => { calls.push("remove"); } };
  const plain = await setup({ components: false, document: fixture, props: { recovery: spy } });
  try {
    await flush(); await change(input("ページタイトル"), "部品のないサイト"); await wait(900); await click("下書き保存");
    assert.deepEqual(calls, [], "hosts without components never touch the component copy");
  } finally { await plain.cleanup(); }
  // ページだけの退避ストアでは、部品の変更を退避せず、従来どおり編集・保存できる。
  const app = await setup({ props: { recovery: { read: () => null, write: () => {}, remove: () => {} } } });
  try {
    await openPanel(); await renameCard("予備の帯", "ページだけの退避"); await wait(900);
    assert.equal(libraryBanner(), null); await click("下書き保存");
    assert.equal(app.calls.librarySaves.length, 1); assert.ok(status().startsWith("保存済み"));
  } finally { await app.cleanup(); }
});

test("the project adapter forwards the autosave trigger of component library saves", async () => {
  const { createProjectEditorAdapter } = await import("@niho/web/project-editor");
  const project = { id: "project_demo", name: "デモ計画", site: { id: "demo", name: "デモサイト", domains: ["https://example.test"] }, members: [] }, sent = [];
  const base = { listSites: async () => [project.site], listPages: async () => [], readDocument: async () => ({ document: fixture, version: "v1" }), saveDraft: async () => ({ status: "conflict" }),
    prepareRelease: async () => { throw new Error("not used"); }, release: async () => ({ status: "conflict" }),
    components: { readLibrary: async () => ({ library: library(), version: "lib-1" }), saveLibrary: async (request) => { sent.push(request); return { status: "saved", version: "lib-2", revision: 2 }; }, listUsage: async () => [] } };
  const wrapped = createProjectEditorAdapter(base, project).components, signal = new AbortController().signal, parsed = parseComponentLibrary(library());
  await wrapped.saveLibrary({ siteId: "demo", library: parsed, expectedVersion: "lib-1", trigger: "autosave" }, signal);
  await wrapped.saveLibrary({ siteId: "demo", library: parsed, expectedVersion: "lib-1" }, signal);
  assert.equal(sent[0].trigger, "autosave"); assert.deepEqual(Object.keys(sent[1]).sort(), ["expectedVersion", "library", "siteId"]);
});

test("部品にする is disabled before opening a dialog when a descendant has a page-owned lock", async () => {
  const app = await setup({ locks: [{ nodeId: "lead", fields: ["children"], reason: "外部データ" }] });
  try {
    await click("section · hero");
    assert.equal(button("部品にする")?.disabled, true);
    assert.ok(text().includes("ロック: 外部データ"));
    await click("部品にする");
    assert.equal(dialog(), null);
    assert.equal(app.calls.librarySaves.length, 0); assert.equal(app.calls.saves.length, 0);
    assert.equal(rendered("heading").textContent, "海のそばで過ごす");
  } finally { await app.cleanup(); }
});

for (const variant of ["outside-only", "shared-text-style", "page-override"]) test(`部品にする preserves site-wide styles used outside the selection across save and reload (${variant})`, async () => {
  const doc = structuredClone(fixture);
  doc.body.push({ type: "element", id: "outside", tag: "p", style: { base: { color: { token: "brand" } } }, children: [{ type: "text", text: "選択範囲外" }] });
  const siteStyles = { tokens: { brand: { type: "color", value: "#336655" }, ink: { type: "color", value: "#112233" }, displaySize: { type: "length", value: 32 } }, textStyles: { headline: { base: { fontSize: { token: "displaySize" }, fontWeight: 700 } } } };
  if (variant !== "outside-only") doc.body[0].children[0].style = { textStyle: "headline", base: { color: { token: variant === "shared-text-style" ? "brand" : "ink" } } };
  if (variant === "page-override") { doc.tokens.displaySize = { type: "length", value: 20 }; doc.textStyles = { headline: { base: { fontSize: { token: "displaySize" }, fontWeight: 600 } } }; }
  const app = await setup({ document: doc, locks: [{ nodeId: "outside", fields: ["children"], reason: "外部データ" }], adapter: { readSiteSettings: async () => ({ settings: { title: "デモ", locale: "ja", ...siteStyles }, version: "s1" }) } });
  try {
    await click("section · hero"); await click("部品にする");
    await change(input("部品名", dialog()), "サイトヘッダー"); await click(button("登録する", dialog()));
    assert.ok(dialog().textContent.includes("同じ名前の部品があります。"));
    assert.equal(app.calls.librarySaves.length, 0); assert.equal(app.calls.saves.length, 0);
    assert.equal(rendered("heading").textContent, "海のそばで過ごす");
    await change(input("部品名", dialog()), "共有スタイルの部品"); await click(button("登録する", dialog()));
    assert.equal(dialog(), null, "unselected site token references must not block component creation");
    await click("下書き保存");
    assert.equal(app.calls.librarySaves.length, 1); assert.equal(app.calls.saves.length, 1);
    const savedLibrary = parseComponentLibrary(app.calls.librarySaves[0].library);
    assert.equal(savedLibrary.components.length, library().components.length + 1, "failed creation does not change the working library");
    const saved = parsePageDocument(app.calls.saves[0].document, {}, { components: savedLibrary, siteStyles });
    assert.equal(Object.hasOwn(saved.tokens, "brand"), false);
    assert.equal(Object.hasOwn(savedLibrary.tokens, "brand"), variant === "shared-text-style");
    assert.equal(Object.hasOwn(saved.textStyles ?? {}, "headline"), variant === "page-override");
    assert.deepEqual(saved.tokens.ink, fixture.tokens.ink);
    if (variant !== "outside-only") {
      const heading = savedLibrary.components.find((component) => component.name === "共有スタイルの部品").root.children[0];
      assert.equal(heading.style.textStyle, undefined);
      assert.deepEqual(heading.style.base.fontSize, { token: "displaySize" });
      assert.equal(savedLibrary.tokens.displaySize.value, variant === "page-override" ? 20 : 32);
      assert.equal(heading.style.base.fontWeight, variant === "page-override" ? 600 : 700);
    }
    assert.deepEqual(saved.body.at(-1), doc.body.at(-1));
    await openPage("別ページ"); await openPage("ホーム"); await loadCanvas();
    assert.equal(rendered("outside").textContent, "選択範囲外");
    assert.equal(rendered("hero--n2").textContent, "海のそばで過ごす");
    await click("p · outside"); assert.equal(button("部品にする")?.disabled, true, "outside locks survive the reload");
  } finally { await app.cleanup(); }
});
