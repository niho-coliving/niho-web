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
const { createMemoryAssetLibrary } = await import("../examples/memory-asset-library.mjs");
const { slotOperations } = await import("../dist/block-slot-panel.js");
const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

// 架空の体験データ。ブロックは props 以外の値（料金・予約先）をホストのデータから描画する。
const experiences = [
  { slug: "pottery", title: "陶芸体験", price: 4800, image: "/images/pottery.webp" },
  { slug: "surf", title: "朝のサーフィン", price: 6200, image: "/images/surf.webp" },
  { slug: "tea", title: "茶室で一服", price: 3500, image: "/images/tea.webp" }
];
const cardList = (renderer) => ({ heading, ctaLabel }) => createElement("section", { "data-renderer": renderer }, createElement("h2", null, heading ?? "体験"),
  createElement("ul", { "data-nw-slot": "list" }, ...experiences.map((experience) => createElement("li", { key: experience.slug },
    createElement("img", { "data-nw-slot": "image", src: experience.image, alt: "" }),
    createElement("h3", { "data-nw-slot": "title" }, experience.title),
    createElement("span", { "data-nw-slot": "price" }, `¥${experience.price.toLocaleString("ja-JP")}`),
    createElement("a", { "data-nw-slot": "cta", href: `/experiences/${experience.slug}/book` }, ctaLabel ?? "予約する"),
    createElement("small", { "data-nw-slot": "checkout" }, "お支払いは予約画面で行います")))));
const slots = {
  list: { label: "カードの並び", style: ["display", "gridTemplateColumns", "gap"] },
  image: { label: "カード画像", style: ["objectFit", "borderRadius", "height"] },
  title: { label: "カードの見出し", style: ["color", "fontSize", "fontWeight"] },
  price: { label: "料金表示", style: ["color", "fontSize"], data: { reason: "体験ごとの料金を表示します。", source: "NIHO の体験データ" } },
  cta: { label: "予約ボタン", style: ["color", "backgroundColor", "borderRadius", "padding"], text: "ctaLabel" },
  checkout: { label: "決済", data: { reason: "決済はホストの予約画面で処理します。", source: "NIHO の予約・決済" } }
};
const blocks = {
  ExperienceCards: { label: "体験カード一覧", props: { heading: { type: "string", maxLength: 120 }, ctaLabel: { type: "string", maxLength: 40 } }, slots, component: cardList("component") },
  PlainNotice: { label: "お知らせ", props: { heading: { type: "string" } }, component: ({ heading }) => createElement("aside", null, heading) }
};
const cards = () => ({ type: "component", id: "cards", block: "ExperienceCards", props: { heading: "人気の体験", ctaLabel: "予約する" } });
const page = (...nodes) => ({ ...structuredClone(fixture), body: [...structuredClone(fixture.body), ...structuredClone(nodes.length ? nodes : [cards()])] });
const library = () => ({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{ id: "cards_section", name: "体験セクション", kind: "section", version: 1,
  root: { type: "element", id: "n1", tag: "section", children: [{ type: "component", id: "n2", block: "ExperienceCards", props: { heading: "部品の体験" } }] } }] });

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const left = () => document.querySelector('[aria-label="サイト・ページ・レイヤー"]');
const right = () => document.querySelector('[aria-label="インスペクタ"]');
const button = (text, root = document) => [...root.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text || node.title === text);
const field = (text, root = document) => [...root.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text);
const input = (text, root = document) => field(text, root)?.querySelector("input,textarea,select");
const captions = () => [...right().querySelectorAll(".e-field")].map((node) => node.querySelector("span")?.textContent);
const heading = () => right().querySelector(".e-inspector-content h2")?.textContent ?? right().querySelector(".e-inspector-context strong")?.textContent;
const tab = (name) => [...right().querySelectorAll('[role="tab"]')].find((node) => node.textContent === name);
const selectTab = async (name) => click(tab(name));
const slotRow = (name) => [...right().querySelectorAll("button.e-slot")].find((node) => node.querySelector(".e-slot-name")?.textContent === name);
const frame = () => document.querySelector('iframe[title="ページのライブキャンバス"]');
const canvas = () => frame().contentDocument;
const canvasCss = () => canvas().querySelector("style[data-nw-style]").textContent;
const editorCss = () => [...canvas().querySelectorAll("style")].map((node) => node.textContent).join("\n");
const card = (name) => document.querySelector(`article.e-part-card[aria-label="${name}"]`);
const openPanel = () => click(document.querySelector('nav[aria-label="編集ツール"] button[title="部品"]'));
async function click(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
async function canvasClick(selector) { const view = frame().contentWindow, target = view.document.querySelector(selector); assert.ok(target, selector); await act(async () => target.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }))); await flush(); }
async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  if (target.tagName !== "SELECT") await act(async () => target.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
  await flush();
}
async function loadCanvas() { await act(async () => frame().dispatchEvent(new dom.window.Event("load"))); await flush(); }
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const calls = { saves: [], librarySaves: [] }; let stored = structuredClone(options.document ?? page()), version = "v1", storedLibrary = options.library ? structuredClone(options.library) : undefined, libraryVersion = 1;
  const components = storedLibrary && {
    readLibrary: async () => ({ library: structuredClone(storedLibrary), version: `lib-${libraryVersion}` }),
    saveLibrary: async (request) => { calls.librarySaves.push(structuredClone(request)); storedLibrary = { ...structuredClone(request.library), revision: storedLibrary.revision + 1 }; libraryVersion++; return { status: "saved", version: `lib-${libraryVersion}`, revision: storedLibrary.revision }; },
    listUsage: async () => []
  };
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }],
    readDocument: async () => ({ document: structuredClone(stored), version }),
    saveDraft: async (request) => { calls.saves.push(structuredClone(request)); stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision }; },
    prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); },
    ...(components ? { components } : {})
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, blocks: options.blocks ?? blocks, ...options.props })));
  for (let attempt = 0; attempt < 5 && !frame(); attempt++) await flush();
  await loadCanvas();
  return { calls, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("clicking a region on the canvas selects the block and that region, shows only its fields and saves the region design", async () => {
  const app = await setup();
  try {
    await canvasClick('[data-nw-node="cards"] li:nth-child(2) [data-nw-slot="title"]');
    assert.equal(heading(), "体験カード一覧 · カードの見出し");
    assert.ok(button("ブロック全体に戻る", right()));
    assert.ok(right().textContent.includes("この領域で変更できる見た目だけを表示しています。"));
    assert.deepEqual(captions(), ["文字色", "文字サイズ", "文字の太さ"]);
    // 繰り返すカードの同じ領域をすべて破線で囲む。
    assert.ok(editorCss().includes('[data-nw-node="cards"] [data-nw-slot="title"]{outline:2px dashed #198558!important;outline-offset:2px;}'));
    await change(input("文字色", right()), "#ff0000");
    assert.ok(canvasCss().includes('[data-nw-node="cards"] [data-nw-slot="title"]{color:#ff0000;}'));
    assert.ok(field("文字色", right()).querySelector(".e-dot"), "the changed region field is marked as unsaved");
    assert.ok(!field("文字サイズ", right()).querySelector(".e-dot"));
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document.body.at(-1);
    assert.deepEqual(saved.slots, { title: { base: { color: "#ff0000" } } });
    assert.equal(saved.style, undefined); assert.deepEqual(saved.props, { heading: "人気の体験", ctaLabel: "予約する" });
    assert.ok(!right().querySelector(".e-dot"), "saved region values lose the unsaved mark");
    assert.equal(heading(), "体験カード一覧 · カードの見出し", "saving keeps the region selected");
  } finally { await app.cleanup(); }
});

test("data regions name their source and reason, and regions without appearance show no style fields", async () => {
  const app = await setup();
  try {
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="price"]');
    assert.equal(heading(), "体験カード一覧 · 料金表示");
    assert.equal(right().querySelector('[role="note"]').textContent, "値はNIHO の体験データが正本です。体験ごとの料金を表示します。");
    assert.deepEqual(captions(), ["文字色", "文字サイズ"], "the price value itself has no input");
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="checkout"]');
    assert.equal(heading(), "体験カード一覧 · 決済");
    assert.equal(right().querySelector('[role="note"]').textContent, "値はNIHO の予約・決済が正本です。決済はホストの予約画面で処理します。");
    assert.ok(right().textContent.includes("この領域の見た目は変更できません。"));
    assert.ok(!right().querySelector(".e-inspector"));
    assert.equal(right().querySelectorAll(".e-inspector-content input, .e-inspector-content select, .e-inspector-content textarea").length, 0);
    await click(button("ブロック全体に戻る", right()));
    assert.equal(heading(), "体験カード一覧 · cards");
    assert.deepEqual([...right().querySelectorAll("button.e-slot .e-slot-name")].map((node) => node.textContent), ["カードの並び", "カード画像", "カードの見出し", "料金表示", "予約ボタン", "決済"]);
    const described = (row) => row.getAttribute("aria-describedby").split(" ").map((id) => document.getElementById(id).textContent);
    assert.equal(document.getElementById(slotRow("決済").getAttribute("aria-labelledby")).textContent, "決済");
    assert.deepEqual(described(slotRow("決済")), ["見た目は変更できません", "値はNIHO の予約・決済が正本です"]);
    assert.deepEqual(described(slotRow("カードの見出し")), ["見た目を変更できます"]);
  } finally { await app.cleanup(); }
});

test("the region text field changes only its display prop and keeps prices, links and locks", async () => {
  const app = await setup();
  try {
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="cta"]');
    assert.equal(heading(), "体験カード一覧 · 予約ボタン");
    assert.equal(input("予約ボタンの文字", right()).value, "予約する");
    assert.ok(field("予約ボタンの文字", right()).textContent.includes("4 / 40文字"));
    await change(input("予約ボタンの文字", right()), "あ".repeat(41));
    assert.ok(right().textContent.includes("40文字以内で入力してください。"));
    assert.equal(canvas().querySelector('[data-nw-slot="cta"]').textContent, "予約する");
    await click(button("入力を取り消す", right()));
    await change(input("予約ボタンの文字", right()), "空き状況を見る");
    assert.deepEqual([...canvas().querySelectorAll('[data-nw-node="cards"] [data-nw-slot="cta"]')].map((link) => [link.textContent, link.getAttribute("href")]),
      experiences.map((experience) => ["空き状況を見る", `/experiences/${experience.slug}/book`]));
    assert.deepEqual([...canvas().querySelectorAll('[data-nw-node="cards"] [data-nw-slot="price"]')].map((node) => node.textContent), ["¥4,800", "¥6,200", "¥3,500"]);
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document.body.at(-1);
    assert.deepEqual(saved.props, { heading: "人気の体験", ctaLabel: "空き状況を見る" }); assert.equal(saved.slots, undefined);
  } finally { await app.cleanup(); }
  const locked = await setup({ blocks: { ...blocks, ExperienceCards: { ...blocks.ExperienceCards, lockedProps: { ctaLabel: "予約ボタンの文字は予約システムが決めます。" } } } });
  try {
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="cta"]');
    assert.equal(input("予約ボタンの文字", right()).disabled, true);
    assert.ok(field("予約ボタンの文字", right()).textContent.includes("ロック: 予約ボタンの文字は予約システムが決めます。"));
  } finally { await locked.cleanup(); }
});

test("regions never offer text styles, states, motion or background images", async () => {
  const feature = { label: "特集", props: {}, slots: { panel: { label: "特集の枠", style: ["color", "fontSize", "backgroundColor", "translate", "transitionDuration"] } },
    component: () => createElement("div", { "data-nw-slot": "panel" }, createElement("p", null, "特集")) };
  const doc = { ...page({ type: "component", id: "feature", block: "Feature", props: {} }), textStyles: { lead: { label: "リード", base: { fontSize: 18 } } } };
  const app = await setup({ document: doc, blocks: { Feature: feature }, props: { assets: createMemoryAssetLibrary({ siteId: "demo" }) } });
  try {
    await click(button("特集 · feature", left()));
    // ブロック全体では設定項目を Studio のタブごとに確認する。
    await selectTab("テキスト"); assert.ok(input("テキストスタイル", right()));
    await selectTab("ボックス"); assert.ok(button("背景画像を選ぶ", right()));
    await selectTab("変形"); assert.ok(input("X", right()));
    await selectTab("設定");
    await click(slotRow("特集の枠"));
    assert.equal(heading(), "特集 · 特集の枠");
    for (const caption of ["文字色", "文字サイズ"]) assert.ok(input(caption, right()), caption);
    assert.ok(!input("テキストスタイル", right()));
    await selectTab("ボックス"); assert.ok(input("背景色", right())); assert.ok(!button("背景画像を選ぶ", right()));
    await selectTab("変形"); assert.equal(input("X", right()), undefined);
    await selectTab("設定"); assert.ok(!right().querySelector('[aria-label="編集する状態"]'));
  } finally { await app.cleanup(); }
});

test("the region resets when another node or the block body is selected, and the list is the keyboard path", async () => {
  const app = await setup();
  try {
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="title"]'); assert.equal(heading(), "体験カード一覧 · カードの見出し");
    await click(button("h1 · heading", left())); assert.equal(heading(), "h1 · heading");
    await click(button("体験カード一覧 · cards", left()));
    assert.equal(heading(), "体験カード一覧 · cards", "reselecting the block does not restore the region");
    assert.ok(slotRow("カードの見出し")); assert.equal(editorCss().includes('[data-nw-slot="title"]{outline'), false);
    // 領域ではない部分（ブロックの見出し）を押すとブロックだけを選ぶ。
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="cta"]'); assert.equal(heading(), "体験カード一覧 · 予約ボタン");
    await canvasClick('[data-nw-node="cards"] h2'); assert.equal(heading(), "体験カード一覧 · cards");
    await click(slotRow("カード画像"));
    assert.equal(heading(), "体験カード一覧 · カード画像"); assert.equal(document.activeElement.tagName, "H2");
    assert.deepEqual(captions(), ["高さ", "角丸", "画像の収まり"]);
    await click(button("ブロック全体に戻る", right())); assert.ok(document.activeElement === slotRow("カード画像"), "focus returns to the row of the region");
    await click(slotRow("カード画像")); await click(button("ページ全体", left()));
    await click(button("体験カード一覧 · cards", left())); assert.equal(heading(), "体験カード一覧 · cards");
  } finally { await app.cleanup(); }
});

test("region edits follow the edited width and keep wider widths with the only range", async () => {
  const app = await setup();
  try {
    await canvasClick('[data-nw-node="cards"] ul[data-nw-slot="list"]'); assert.equal(heading(), "体験カード一覧 · カードの並び");
    await change(input("配置方式", right()), "grid"); await change(input("要素間の余白", right()), "16");
    await click(button("タブレット 768px〜", right())); await click(button("3 列", right()));
    assert.ok(field("要素間の余白", right()).textContent.includes("継承: 基本"));
    await click(button("768〜1279px だけ", right())); await change(input("要素間の余白", right()), "24");
    await click(button("下書き保存"));
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).slots.list, { base: { display: "grid", gap: 16 }, responsive: [
      { minWidth: 768, declarations: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 24 } }, { minWidth: 1280, declarations: { gap: 16 } }] });
  } finally { await app.cleanup(); }
});

test("the preview renderer draws the canvas and the component thumbnails while servers keep the host component", async () => {
  let renders = 0;
  const registry = { ExperienceCards: { ...blocks.ExperienceCards, component: () => { renders++; return createElement("p", null, "ホストのデータで描く公開用の一覧"); }, preview: cardList("preview") } };
  const app = await setup({ blocks: registry, library: library() });
  try {
    assert.ok(canvas().querySelector('[data-nw-node="cards"] [data-renderer="preview"]'));
    assert.equal(canvas().body.textContent.includes("公開用の一覧"), false); assert.equal(renders, 0);
    await openPanel();
    const thumbnail = card("体験セクション").querySelector("iframe");
    await act(async () => thumbnail.dispatchEvent(new dom.window.Event("load"))); await flush();
    assert.ok(thumbnail.contentDocument.querySelector('[data-renderer="preview"]')); assert.equal(renders, 0);
  } finally { await app.cleanup(); }
  const html = renderPageToHtml(page(), registry);
  assert.ok(html.includes("ホストのデータで描く公開用の一覧")); assert.equal(html.includes('data-renderer="preview"'), false);
});

test("blocks inside a component master support regions, while instances on the page keep selecting the instance", async () => {
  const app = await setup({ document: page({ type: "instance", id: "featured", component: "cards_section" }), library: library() });
  try {
    await canvasClick('[data-nw-node="featured--n2"] [data-nw-slot="title"]');
    assert.ok(heading().includes("体験セクション")); assert.ok(!button("ブロック全体に戻る", right()));
    await openPanel(); await click(button("編集", card("体験セクション"))); await loadCanvas();
    await canvasClick('[data-nw-node="n2"] [data-nw-slot="title"]');
    assert.equal(heading(), "体験カード一覧 · カードの見出し");
    await change(input("文字サイズ", right()), "20");
    assert.ok(canvasCss().includes('[data-nw-node="n2"] [data-nw-slot="title"]{font-size:20px;}'));
    await click(button("ページに戻る", document.querySelector(".e-part-banner"))); await loadCanvas();
    assert.ok(!button("ブロック全体に戻る", right()), "leaving the master clears the region");
    assert.ok(canvasCss().includes('[data-nw-node="featured--n2"] [data-nw-slot="title"]{font-size:20px;}'));
    await click(button("下書き保存"));
    assert.deepEqual(app.calls.librarySaves[0].library.components[0].root.children[0].slots, { title: { base: { fontSize: 20 } } });
  } finally { await app.cleanup(); }
});

test("shared colors used only by regions are counted and kept on delete, and region widths become tiers", async () => {
  const doc = page({ ...cards(), slots: { title: { base: { color: { token: "accent" } }, responsive: [{ minWidth: 1024, declarations: { fontSize: 22 } }] } } });
  doc.tokens = { ...doc.tokens, accent: { type: "color", value: "#195640", label: "アクセント" } };
  const app = await setup({ document: doc });
  try {
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="title"]');
    const wide = [...right().querySelectorAll('[aria-label="編集する幅"] button')].find((node) => node.textContent.includes("1024px〜"));
    assert.ok(wide, "a width used only by a region is offered as a tier");
    await click(wide); assert.equal(input("文字サイズ", right()).value, "22");
    await click(button("スタイル", left()));
    const row = [...left().querySelectorAll("button.e-lib-row")].find((node) => node.querySelector(".e-lib-name")?.textContent === "アクセント");
    assert.ok(row.textContent.includes("1 か所")); await click(row);
    assert.ok(left().textContent.includes("1 か所に反映されます")); assert.ok(button("体験カード一覧 · cards", left()));
    await click(button("このカラーを削除", left())); await click(button("削除する", left()));
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document;
    assert.equal(saved.tokens.accent, undefined); assert.deepEqual(saved.body.at(-1).slots.title.base, { color: "#195640" }, "the region keeps its look as a literal value");
  } finally { await app.cleanup(); }
});

test("registries without regions keep today's block inspector and canvas selection", async () => {
  const app = await setup({ document: page({ type: "component", id: "notice", block: "PlainNotice", props: { heading: "お知らせです" } }), blocks: { PlainNotice: blocks.PlainNotice } });
  try {
    await canvasClick('[data-nw-node="notice"] aside');
    assert.equal(heading(), "お知らせ · notice");
    assert.equal(right().textContent.includes("表示領域"), false); assert.ok(!right().querySelector(".e-slot-list"));
    assert.ok(input("heading", right())); await selectTab("テキスト"); assert.ok(input("文字色", right()));
  } finally { await app.cleanup(); }
});

test("canvas resizes become one width and height step only for regions that allow both", async () => {
  const doc = page(), path = [doc.body.length - 1];
  assert.equal(slotOperations(doc, path, "image", blocks, { type: "resize", path, breakpoint: "base", width: 320, height: 180 }), "この領域ではサイズを直接変更できません。");
  const sized = { ...blocks, ExperienceCards: { ...blocks.ExperienceCards, slots: { ...slots, image: { ...slots.image, style: ["width", "height"] } } } };
  assert.deepEqual(slotOperations(doc, path, "image", sized, { type: "resize", path, breakpoint: 768, width: 320.4, height: 180 }), [
    { type: "slotStyle", path, slot: "image", breakpoint: 768, property: "width", value: 320 }, { type: "slotStyle", path, slot: "image", breakpoint: 768, property: "height", value: 180 }]);
  for (const operation of [{ type: "nodeTextStyle", path, name: "lead" }, { type: "state", path, state: "hover", values: { color: "#000000" } }, { type: "styles", path, breakpoint: "base", values: { backgroundColor: "#ffffff" } }])
    assert.equal(slotOperations(doc, path, "title", blocks, operation), "この領域では変更できない見た目です。", operation.type);
  const app = await setup({ blocks: sized });
  try {
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="title"]'); assert.ok(!canvas().querySelector(".nw-resize-handle"));
    await canvasClick('[data-nw-node="cards"] [data-nw-slot="image"]'); assert.ok(canvas().querySelector(".nw-resize-handle"), "regions that allow width and height get the handle");
  } finally { await app.cleanup(); }
});
