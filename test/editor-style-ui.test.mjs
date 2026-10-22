import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const { renderPageToHtml } = await import("@niho/web/server");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const left = () => document.querySelector('[aria-label="サイト・ページ・レイヤー"]');
const right = () => document.querySelector('[aria-label="インスペクタ"]');
const button = (text, root = document) => [...root.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text || node.title === text) ?? (text.includes(" · ") ? root.querySelector(`[data-node-id="${text.split(" · ").at(-1)}"] button.e-layer`) : undefined);
const field = (text, root = document) => [...root.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text);
const input = (text, root = document) => field(text, root)?.querySelector("input,textarea,select");
const frame = () => document.querySelector("iframe");
const canvasCss = () => frame().contentDocument.querySelector("style[data-nw-style]").textContent;
async function click(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
async function editorTab(name) { const target = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name); assert.ok(target, name); if (target.getAttribute("aria-selected") !== "true") await click(target); }
async function canvasClick(selector) { const view = frame().contentWindow, target = view.document.querySelector(selector); assert.ok(target, selector); await act(async () => target.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }))); await flush(); }
async function type(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function change(target, value) {
  await type(target, value);
  if (target.tagName !== "SELECT") await act(async () => target.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
  await flush();
}
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const calls = { saves: [] }; let stored = structuredClone(options.document ?? fixture), version = "v1";
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: stored.siteId, pageId: stored.pageId, locale: stored.locale, title: stored.title }],
    readDocument: async () => ({ document: structuredClone(stored), version, ...(options.presentation ? { presentation: structuredClone(options.presentation) } : {}) }),
    saveDraft: async (request) => { calls.saves.push(structuredClone(request)); stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision }; },
    prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); },
    ...options.adapter
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, ...options.props }))); await flush();
  await act(async () => frame().dispatchEvent(new dom.window.Event("load")));
  return { calls, stored: () => stored, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("a shared color is created, applied to two elements, recolored live and saved as token references", async () => {
  const app = await setup();
  try {
    await click(button("スタイル", left()));
    await click(button("カラーを追加", left()));
    assert.ok(left().textContent.includes("カラー 1"));
    await canvasClick("h1"); await click(button("選択中の要素の文字色に適用", left()));
    await canvasClick("p"); await click(button("選択中の要素の文字色に適用", left()));
    assert.ok(left().textContent.includes("2 か所に反映されます"));
    assert.deepEqual([...left().querySelectorAll(".e-usage button")].map((node) => node.textContent), ["海のそばで過ごす", "同じ文書を複数の公開サイトで描画できます。"]);
    await type(input("色", left()), "#00aa00");
    assert.ok(canvasCss().includes("--nw-color-1:#00aa00;"), "typing previews the new value before it is committed");
    assert.equal(button("下書き保存").disabled, true);
    await act(async () => input("色", left()).dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }))); await flush();
    const css = canvasCss();
    assert.ok(css.includes("--nw-color-1:#00aa00;"));
    for (const id of ["heading", "lead"]) assert.ok(css.includes(`[data-nw-node="${id}"]{color:var(--nw-color-1);}`), id);
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document;
    assert.deepEqual(saved.tokens["color-1"], { type: "color", value: "#00aa00", label: "カラー 1" });
    assert.deepEqual(saved.body[0].children[0].style.base.color, { token: "color-1" });
    assert.deepEqual(saved.body[0].children[1].style.base.color, { token: "color-1" });
    // 使用中のカラーの削除は、今の見た目の値へ切り離してから消す。
    await click(button("このカラーを削除", left()));
    assert.ok(left().textContent.includes("使用中の 2 か所は今の見た目のまま個別の指定に変わります。"));
    await click(button("削除する", left())); await click(button("下書き保存"));
    const detached = app.calls.saves[1].document;
    assert.equal(detached.tokens["color-1"], undefined); assert.equal(detached.body[0].children[0].style.base.color, "#00aa00");
  } finally { await app.cleanup(); }
});

test("native shared context renders outside the editable scope, preserves a 5px empty box and is excluded from page save", async () => {
  const shared = (pageId, id, text) => ({ schemaVersion: 1, siteId: "demo", pageId, locale: "ja-JP", revision: 1, title: pageId, tokens: {}, body: [{ type: "element", id, tag: pageId === "header" ? "header" : "footer", children: [{ type: "text", text }] }] });
  const header = shared("header", "shared_head", "SHARED_HEADER_MUST_NOT_SAVE");
  header.body.push({ type: "element", id: "shared_menu_trigger_node", tag: "a", attrs: { id: "shared-menu-trigger", href: "#shared-menu" }, children: [{ type: "text", text: "MENU" }] });
  const menu = shared("shared-menu", "shared_menu", "SHARED_MENU_DRAFT_MUST_NOT_SAVE");
  menu.body[0].tag = "nav";
  menu.body[0].children.push({ type: "element", id: "shared_menu_link", tag: "a", attrs: { href: "/other" }, children: [{ type: "text", text: "OTHER" }] });
  menu.body[0].children.push({ type: "element", id: "shared_menu_close_node", tag: "a", attrs: { id: "shared-menu-close", href: "#shared-menu" }, children: [{ type: "text", text: "CLOSE" }] });
  const presentation = { schemaVersion: 1, siteId: "demo", locale: "ja-JP", version: "presentation-v1", reset: "neutral-v1", tokens: {}, fonts: [], shared: { header, footer: shared("footer", "shared_foot", "SHARED_FOOTER_MUST_NOT_SAVE") }, overlays: [{ id: "shared-menu", label: "共有メニュー", document: menu, triggerIds: ["shared-menu-trigger"], closeIds: ["shared-menu-close"] }] };
  const source = structuredClone(fixture);
  source.body[0].children[0].style = { base: { borderTopStyle: "solid", borderTopColor: "#334455", overflowWrap: "anywhere", wordBreak: "break-word" } };
  source.body[0].style.base.alignContent = "space-between";
  source.body[0].children.push({ type: "element", id: "bullet", tag: "div", style: { base: { width: "5px", height: "5px", backgroundColor: "#123456" } }, children: [] });
  const app = await setup({ document: source, presentation });
  try {
    const frameDocument = frame().contentDocument;
    assert.ok(frameDocument.body.textContent.includes("SHARED_HEADER_MUST_NOT_SAVE"));
    assert.ok(frameDocument.body.textContent.includes("SHARED_FOOTER_MUST_NOT_SAVE"));
    assert.ok(frameDocument.body.textContent.includes("SHARED_MENU_DRAFT_MUST_NOT_SAVE"));
    assert.equal(frameDocument.querySelector("[data-nw-overlay]").hidden, true);
    const css = [...frameDocument.querySelectorAll("style")].map((node) => node.textContent).join("\n");
    assert.match(css, /\[data-nw-node="bullet"\]\{background-color:#123456;height:5px;width:5px;\}/);
    assert.equal(css.includes("min-height:48px"), false);
    await click(button("プレビュー"));
    await canvasClick("[data-nw-overlay-open]");
    assert.equal(frameDocument.querySelector("[data-nw-overlay]").hidden, false);
    const ordinaryLink = frameDocument.querySelector('[data-nw-node="shared_menu_link"]');
    const blocked = new (frame().contentWindow.MouseEvent)("click", { bubbles: true, cancelable: true });
    ordinaryLink.dispatchEvent(blocked); assert.equal(blocked.defaultPrevented, true, "preview keeps ordinary navigation blocked");
    await canvasClick("[data-nw-overlay-close=shared-menu]:not([data-nw-overlay-backdrop])");
    assert.equal(frameDocument.querySelector("[data-nw-overlay]").hidden, true);
    await click(button("編集に戻る"));
    await canvasClick("h1"); await editorTab("ボックス");
    assert.ok(right().textContent.includes("辺ごとの種類・色"));
    assert.ok(right().textContent.includes("長い文字の折り返し"));
    await change(input("幅", right()), "99%");
    await click(button("下書き保存"));
    assert.equal(app.calls.saves[0].presentationVersion, "presentation-v1");
    assert.equal(JSON.stringify(app.calls.saves[0].document).includes("SHARED_HEADER_MUST_NOT_SAVE"), false);
    assert.equal(JSON.stringify(app.calls.saves[0].document).includes("SHARED_FOOTER_MUST_NOT_SAVE"), false);
    assert.equal(JSON.stringify(app.calls.saves[0].document).includes("SHARED_MENU_DRAFT_MUST_NOT_SAVE"), false);
    assert.deepEqual(app.calls.saves[0].document.body[0].children[0].style.base, { borderTopStyle: "solid", borderTopColor: "#334455", overflowWrap: "anywhere", wordBreak: "break-word", width: "99%" });
    assert.deepEqual(app.calls.saves[0].document.body[0].children.at(-1).style.base, { width: "5px", height: "5px", backgroundColor: "#123456" });
  } finally { await app.cleanup(); }
});

test("editing the canonical overlay shows and saves only its own selectable nodes", async () => {
  const shared = (pageId, id, tag, text) => ({ schemaVersion: 1, siteId: "demo", pageId, locale: "ja-JP", revision: 1, title: pageId, tokens: {}, body: [{ type: "element", id, tag, children: [{ type: "text", text }] }] });
  const document = shared("shared-menu", "menu_editable", "nav", "EDITABLE_MENU_ONLY");
  const presentation = { schemaVersion: 1, siteId: "demo", locale: "ja-JP", version: "presentation-menu-v1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: { header: shared("header", "shared_head", "header", "HEADER_NOT_SAVED"), footer: shared("footer", "shared_foot", "footer", "FOOTER_NOT_SAVED") },
    overlays: [{ id: "site-menu", label: "メニュー", document: shared("shared-menu", "published_menu", "nav", "PUBLISHED_MENU_NOT_SHOWN"), triggerIds: ["open-menu"], closeIds: ["close-menu"] }] };
  const app = await setup({ document, presentation });
  try {
    const frameDocument = frame().contentDocument;
    assert.equal(frameDocument.querySelector("[data-nw-overlay]").hidden, false);
    assert.ok(frameDocument.body.textContent.includes("EDITABLE_MENU_ONLY"));
    assert.equal(frameDocument.body.textContent.includes("PUBLISHED_MENU_NOT_SHOWN"), false);
    await canvasClick('[data-nw-node="menu_editable"]'); await editorTab("ボックス"); await change(input("幅", right()), "88%");
    await click(button("下書き保存"));
    assert.equal(app.calls.saves[0].document.pageId, "shared-menu");
    assert.equal(app.calls.saves[0].document.body[0].style.base.width, "88%");
    assert.equal(JSON.stringify(app.calls.saves[0].document).includes("HEADER_NOT_SAVED"), false);
  } finally { await app.cleanup(); }
});

test("a menu span with a line break edits only its own document, preserves its link and reloads", async () => {
  const shared = (pageId, body) => ({ schemaVersion: 1, siteId: "demo", pageId, locale: "ja-JP", revision: 1, title: pageId, tokens: {}, body });
  const label = { type: "element", id: "menu_label", tag: "span", style: { base: { color: "#123456" } }, children: [{ type: "text", text: "Menu label" }, { type: "element", id: "menu_break", tag: "br", children: [] }] };
  const document = shared("shared-menu", [{ type: "element", id: "menu_link", tag: "a", attrs: { href: "/#about" }, children: [label] }]);
  const header = shared("header", [{ ...structuredClone(label), children: [{ type: "text", text: "HEADER_STAYS_UNCHANGED" }] }]);
  const presentation = { schemaVersion: 1, siteId: "demo", locale: "ja-JP", version: "menu-span-v1", reset: "neutral-v1", tokens: {}, fonts: [], shared: { header, footer: shared("footer", []) },
    overlays: [{ id: "site-menu", label: "メニュー", document, triggerIds: ["open-menu"], closeIds: ["close-menu"] }] };
  const app = await setup({ document, presentation });
  try {
    const frameDocument = frame().contentDocument, view = frame().contentWindow;
    const outside = frameDocument.querySelector('[data-nw-presentation-header] [data-nw-node="menu_label"]');
    await act(async () => outside.dispatchEvent(new view.MouseEvent("dblclick", { bubbles: true, cancelable: true }))); await flush();
    assert.notEqual(outside.contentEditable, "true", "shared text with the same node ID must not become editable");
    const own = frameDocument.querySelector('[data-nw-overlay-editing] [data-nw-node="menu_label"]');
    await act(async () => own.dispatchEvent(new view.MouseEvent("dblclick", { bubbles: true, cancelable: true }))); await flush();
    assert.equal(own.contentEditable, "true");
    own.firstChild.textContent = "Edited menu label";
    await act(async () => own.dispatchEvent(new view.FocusEvent("focusout", { bubbles: true }))); await flush();
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document, link = saved.body[0], savedLabel = link.children[0];
    assert.equal(saved.pageId, "shared-menu"); assert.equal(link.attrs.href, "/#about");
    assert.equal(savedLabel.children[0].text, "Edited menu label"); assert.equal(savedLabel.children[1].id, "menu_break");
    assert.deepEqual(savedLabel.style, label.style);
    assert.equal(JSON.stringify(saved).includes("HEADER_STAYS_UNCHANGED"), false);
    await click(button("最新の文書を再読込"));
    assert.ok(frame().contentDocument.querySelector('[data-nw-overlay-editing]').textContent.includes("Edited menu label"));
  } finally { await app.cleanup(); }
});

test("a tablet override is shown in the tier color, can be reset, and matches the published CSS after reload", async () => {
  const app = await setup();
  try {
    await click(button("section · hero")); await editorTab("ボックス"); await change(input("幅", right()), "80%");
    const pressedTier = () => document.querySelector('[aria-label="編集する幅"] [aria-pressed="true"]').textContent;
    await change(document.querySelector('[aria-label="表示幅"]'), "375");
    assert.equal(pressedTier(), "基本", "表示幅を変えても編集する段は変わらない");
    await click(button("タブレット 768px〜", right()));
    await change(document.querySelector('[aria-label="表示幅"]'), "1440"); assert.equal(pressedTier(), "タブレット 768px〜");
    assert.ok(document.querySelector(".e-tier-note").textContent.includes("表示中: 1440px（PC の段）"));
    assert.ok(button("表示中の幅（PC 1280px〜）の段を編集", right()));
    await change(document.querySelector('[aria-label="表示幅"]'), "375"); assert.equal(pressedTier(), "タブレット 768px〜");
    assert.ok(right().textContent.includes("表示中の 375px にはこの指定は反映されません"));
    assert.ok(right().textContent.includes("768px 以上に適用。PC 1280px〜 で上書きした項目を除きます。"));
    await click(button("768px で表示", right()));
    assert.equal(frame().style.width, "768px"); assert.ok(!right().textContent.includes("反映されません"));
    assert.ok(document.querySelector(".e-tier-note").textContent.includes("表示中: 768px（タブレット の段）"));
    assert.equal(button("表示中の幅（タブレット 768px〜）の段を編集", right()), undefined);
    assert.equal(input("幅", right()).placeholder, "80%");
    const hint = field("幅", right()).querySelector(".e-hint");
    assert.equal(hint.querySelector('[aria-hidden="true"]').textContent, "継承: 基本"); assert.equal(hint.title, "基本から継承");
    assert.equal(input("幅", right()).getAttribute("aria-describedby"), hint.id);
    const direction = () => right().querySelector('[role="group"][aria-label="並ぶ向き"]');
    await click(direction().querySelector('[aria-label="横"]'));
    const row = direction().closest(".e-row");
    assert.ok(row.classList.contains("e-own")); assert.ok(row.textContent.includes("保存前"));
    assert.ok(canvasCss().includes("flex-direction:row;"));
    await click(button("並ぶ向きのこの幅の指定を解除", right()));
    assert.ok(!canvasCss().includes("flex-direction:row;")); assert.ok(!direction().closest(".e-row").classList.contains("e-own"));
    await click(direction().querySelector('[aria-label="横"]'));
    // 選択を変えても段は維持する。
    await click(button("h1 · heading")); assert.equal(document.querySelector('[aria-label="編集する幅"] [aria-pressed="true"]').textContent, "タブレット 768px〜");
    await click(button("下書き保存"));
    assert.deepEqual(app.calls.saves[0].document.body[0].style.responsive, [{ minWidth: 768, declarations: { maxWidth: "64rem", margin: "0 auto", flexDirection: "row" } }]);
    assert.equal(app.calls.saves[0].document.body[0].style.base.width, "80%");
    await click(button("最新の文書を再読込"));
    const html = renderPageToHtml(app.stored()), published = html.match(/<style data-nw-style="[^"]+">([^]*?)<\/style>/)[1];
    assert.ok(published.includes("@media (min-width:768px)") && published.includes("flex-direction:row;"));
    assert.equal(canvasCss(), published);
  } finally { await app.cleanup(); }
});

test("invalid width and color values are rejected and the previous values are saved", async () => {
  const app = await setup();
  try {
    await click(button("section · hero")); await editorTab("ボックス"); await change(input("幅", right()), "50%");
    await change(input("幅", right()), "abc");
    assert.equal(input("幅", right()).value, "abc"); assert.ok(field("幅", right()).querySelector('[role="alert"]'));
    assert.equal(button("下書き保存").disabled, true);
    await change(input("背景色", right()), "red;display:none");
    assert.ok(field("背景色", right()).querySelector('[role="alert"]'));
    assert.ok(!canvasCss().includes("display:none"));
    await click(button("入力を取り消す", field("幅", right()))); await click(button("入力を取り消す", field("背景色", right())));
    assert.equal(input("幅", right()).value, "50");
    await click(button("下書き保存"));
    const base = app.calls.saves[0].document.body[0].style.base;
    assert.equal(base.width, "50%"); assert.equal(base.backgroundColor, undefined);
  } finally { await app.cleanup(); }
});

test("switching margins between one value and four sides is undone in one step", async () => {
  const app = await setup();
  try {
    await click(button("section · hero")); await editorTab("ボックス"); await click(button("タブレット 768px〜", right()));
    assert.equal(input("外側の余白", right()).value, "0 auto");
    await click(button("外側の余白を上下左右で個別に指定", right()));
    assert.equal(input("外側の余白", right()), undefined);
    assert.equal(input("上の外余白", right()).value, "0");
    assert.equal(input("右の外余白", right()).value, ""); assert.equal(field("右の外余白", right()).querySelector("select").value, "k:auto");
    await click(button("元に戻す"));
    assert.equal(button("下書き保存").disabled, true);
    await click(button("section · hero")); await editorTab("ボックス");
    assert.equal(input("外側の余白", right()).value, "0 auto");
    await click(button("外側の余白を上下左右で個別に指定", right()));
    await change(input("左の外余白", right()), "24");
    await click(button("外側の余白を上下左右で個別に指定", right()));
    assert.equal(input("外側の余白", right()).value, "0");
    await click(button("元に戻す")); await click(button("section · hero")); await editorTab("ボックス");
    assert.equal(input("左の外余白", right()).value, "24");
    await click(button("下書き保存"));
    assert.deepEqual(app.calls.saves[0].document.body[0].style.responsive[0].declarations, { maxWidth: "64rem", marginTop: "0", marginRight: "auto", marginBottom: "0", marginLeft: 24 });
  } finally { await app.cleanup(); }
});

test("business blocks show only the appearance fields they allow", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "表示名" } }, { type: "component", id: "free", block: "Free", props: {} });
  const blocks = {
    Notice: { label: "お知らせ", props: { heading: { type: "string", required: true } }, styleProperties: ["marginTop", "backgroundColor"], component: ({ heading }) => createElement("p", null, heading) },
    Free: { label: "自由", props: {}, component: () => createElement("p", null, "自由") }
  };
  const app = await setup({ document: doc, props: { blocks } });
  try {
    await click(button("お知らせ · notice")); await editorTab("ボックス");
    assert.ok(right().textContent.includes("このブロックで変更できる見た目だけを表示しています。"));
    for (const caption of ["文字色", "幅", "外側の余白", "右の外余白", "内側の余白", "配置の基準", "角丸", "テキストスタイル", "不透明度"]) assert.equal(field(caption, right()), undefined, caption);
    assert.ok(input("背景色", right())); assert.ok(input("上の外余白", right()));
    await change(input("背景色", right()), "#fff8e6"); await change(input("上の外余白", right()), "32");
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document.body.at(-2);
    assert.deepEqual(saved.style.base, { backgroundColor: "#fff8e6", marginTop: 32 }); assert.deepEqual(saved.props, { heading: "表示名" });
    await click(button("自由 · free")); await editorTab("テキスト"); assert.ok(input("文字色", right()));
    await editorTab("ボックス"); assert.ok(input("幅", right()));
  } finally { await app.cleanup(); }
});

test("text styles are applied from the style panel, shown as inherited values and detached without changing the appearance", async () => {
  const app = await setup({ props: { breakpoints: [{ minWidth: 768, label: "タブレット" }, { minWidth: 1280, label: "PC" }] } });
  try {
    await click(button("スタイル", left())); await click(button("テキスト", left()));
    await click(button("テキストスタイルを追加", left()));
    await change(input("タブレット 768px〜 のサイズ", left()), "20");
    await canvasClick("h1"); await click(button("選択中の要素に適用", left()));
    assert.ok(canvasCss().includes('[data-nw-node="heading"]{font-size:16px;font-weight:400;line-height:1.6;}'));
    assert.ok(canvasCss().includes('@media (min-width:768px){') && canvasCss().includes('[data-nw-node="heading"]{font-size:20px;}'));
    assert.equal(input("テキストスタイル", right()).value, "text-1");
    assert.ok(field("文字サイズ", right()).textContent.includes("継承: テキスト 1"));
    assert.equal(field("文字サイズ", right()).querySelector(".e-hint").title, "テキストスタイル『テキスト 1』から継承");
    assert.ok(field("文字の太さ", right()).textContent.includes("継承: テキスト 1 · 標準"));
    assert.equal(input("文字サイズ", right()).placeholder, "16");
    const before = canvasCss().replace(/\n/g, "");
    await click(button("切り離す", field("テキストスタイル", right())));
    assert.equal(input("テキストスタイル", right()).value, "");
    const after = canvasCss();
    assert.ok(after.includes('[data-nw-node="heading"]{font-size:16px;font-weight:400;line-height:1.6;}') && after.includes('[data-nw-node="heading"]{font-size:20px;}'));
    assert.notEqual(before, after.replace(/\n/g, ""));
    await click(button("下書き保存"));
    const heading = app.calls.saves[0].document.body[0].children[0];
    assert.deepEqual(heading.style, { base: { fontSize: 16, fontWeight: 400, lineHeight: 1.6 }, responsive: [{ minWidth: 768, declarations: { fontSize: 20 } }] });
    assert.deepEqual(app.calls.saves[0].document.textStyles["text-1"].responsive, [{ minWidth: 768, declarations: { fontSize: 20 } }]);
  } finally { await app.cleanup(); }
});

test("editing only below the next tier keeps wider widths, is undone in one step and reaches the published CSS", async () => {
  const app = await setup();
  try {
    await click(button("section · hero")); await editorTab("ボックス");
    const direction = () => right().querySelector('[role="group"][aria-label="並ぶ向き"]');
    await click(direction().querySelector('[aria-label="横"]'));
    await click(button("〜767px だけ", right()));
    assert.ok(right().textContent.includes("〜767pxだけに適用。768px 以上の見た目は変えません。"));
    assert.ok(right().textContent.includes("表示中の 1280px にはこの指定は反映されません"));
    assert.ok(button("375px で表示", right()));
    await click(direction().querySelector('[aria-label="縦"]'));
    assert.match(canvasCss(), /@media \(min-width:768px\)\{[^}]*hero"\]\{[^}]*flex-direction:row;/);
    await click(button("元に戻す")); await click(button("section · hero"));
    assert.equal(right().querySelector('[aria-label="反映する範囲"] [aria-pressed="true"]').textContent, "〜767px だけ", "範囲は選択を変えても保つ");
    assert.doesNotMatch(canvasCss(), /@media \(min-width:768px\)\{[^}]*hero"\]\{[^}]*flex-direction/);
    await click(right().querySelector('[role="group"][aria-label="並ぶ向き"] [aria-label="縦"]'));
    await click(button("p · lead")); await editorTab("テキスト"); await change(input("文字色", right()), "#ff0000");
    assert.ok(field("文字色", right()).querySelector('[role="alert"]').textContent.includes("先に「768px 以上」で値を入れてください。"));
    await click(button("入力を取り消す", field("文字色", right())));
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document.body[0].style;
    assert.equal(saved.base.flexDirection, "column");
    assert.deepEqual(saved.responsive, [{ minWidth: 768, declarations: { maxWidth: "64rem", margin: "0 auto", flexDirection: "row" } }]);
    const html = renderPageToHtml(app.stored()), published = html.match(/<style data-nw-style="[^"]+">([^]*?)<\/style>/)[1];
    assert.match(published, /@media \(min-width:768px\)\{[^}]*hero"\]\{flex-direction:row;margin:0 auto;max-width:64rem;\}/);
  } finally { await app.cleanup(); }
});

/** サイト共通スタイルを読み書きできるホスト。ページの h1 はサイト共通のカラーを参照する。 */
function siteStyleHost() {
  const saves = []; let settings = { title: "デモサイト", locale: "ja", tokens: { brand: { type: "color", value: "#336655", label: "ブランド" } } }, version = 1;
  const page = structuredClone(fixture); page.body[0].children[0].style = { base: { color: { token: "brand" } } };
  return { saves, page, adapter: {
    readSiteSettings: async () => ({ settings: structuredClone(settings), version: `s${version}` }),
    saveSiteSettings: async (request) => { saves.push(structuredClone(request)); settings = structuredClone(request.settings); version++; return { status: "saved", version: `s${version}` }; }
  } };
}
const libraryRow = (name) => [...left().querySelectorAll(".e-lib-row")].find((node) => node.querySelector(".e-lib-name")?.textContent === name);
const sitePageHold = "ページの変更を保存してからサイト共通スタイルを編集してください。";
async function openSiteColor(name) { await click(button("スタイル", left())); await click(button("サイト共通", left())); await click(libraryRow(name)); }

test("site-wide color and name inputs are committed while typing in the site scope", async () => {
  const host = siteStyleHost(), app = await setup({ document: host.page, adapter: host.adapter });
  try {
    await openSiteColor("ブランド");
    // サイト共通の欄の入力途中は「ページの未確定の入力」に数えず、欄を止めない。
    await type(input("色", left()), "#zz");
    assert.equal(input("色", left()).disabled, false); assert.equal(input("色", left()).closest(".e-frame").dataset.pending, "true");
    assert.ok(!left().textContent.includes(sitePageHold));
    await act(async () => input("色", left()).dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }))); await flush();
    assert.ok(field("色", left()).querySelector('[role="alert"]'), "無効な値は理由を出して入力を残す");
    await change(input("色", left()), "#00aa00");
    assert.equal(field("色", left()).querySelector('[role="alert"]'), null); assert.equal(input("色", left()).closest(".e-frame").dataset.pending, undefined);
    const review = document.querySelector('[aria-label="サイト共通スタイルの変更確認"]');
    assert.ok(review?.textContent.includes("サイト共通スタイルの変更"), "確定するとサイト共通スタイルの変更確認を出す");
    assert.ok(review.textContent.includes("1 ページの参照または見た目に反映されます。"));
    await change(input("名前", left()), "ブランド色");
    assert.equal(input("名前", left()).disabled, false); assert.ok(libraryRow("ブランド色"));
    await click(button("サイト共通スタイルを保存"));
    assert.deepEqual(host.saves[0].settings.tokens.brand, { type: "color", value: "#00aa00", label: "ブランド色" });
    assert.equal(app.calls.saves.length, 0, "ページの下書きは保存しない");
  } finally { await app.cleanup(); }
});

test("unsaved page changes and page inputs keep site-wide styles locked and say why", async () => {
  const host = siteStyleHost(), app = await setup({ document: host.page, adapter: host.adapter });
  try {
    // ページの欄に入力途中の値が残る間は止める。
    await click(button("section · hero")); await change(input("幅", right()), "abc");
    await openSiteColor("ブランド");
    assert.equal(input("色", left()).disabled, true); assert.equal(input("名前", left()).disabled, true);
    assert.ok(left().textContent.includes(sitePageHold));
    await click(button("入力を取り消す", field("幅", right())));
    assert.equal(input("色", left()).disabled, false); assert.ok(!left().textContent.includes(sitePageHold));
    // ページの未保存の変更がある間も止め、下書きを保存すると編集できる。
    await change(input("幅", right()), "50%");
    assert.equal(input("色", left()).disabled, true); assert.ok(left().textContent.includes(sitePageHold));
    await click(button("下書き保存"));
    assert.equal(input("色", left()).disabled, false); assert.ok(!left().textContent.includes(sitePageHold));
    await change(input("色", left()), "#00aa00");
    assert.ok(document.querySelector('[aria-label="サイト共通スタイルの変更確認"]'));
  } finally { await app.cleanup(); }
});
