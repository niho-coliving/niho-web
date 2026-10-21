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
const right = () => document.querySelector('[aria-label="インスペクタ"]');
const group = (name, root = right()) => root.querySelector(`[role="group"][aria-label="${name}"]`);
const button = (text, root = document) => [...root.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text || node.title === text);
const field = (text, root = document) => [...root.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text);
const input = (text, root = document) => field(text, root)?.querySelector("input,textarea,select");
const check = (text, root = right()) => [...root.querySelectorAll("label.e-check")].find((node) => node.textContent === text)?.querySelector("input");
const frame = () => document.querySelector("iframe");
const pageCss = () => frame().contentDocument.querySelector("style[data-nw-style]").textContent;
const canvasExtra = () => [...frame().contentDocument.querySelectorAll("style")].at(-1).textContent;
const publishedCss = (document) => renderPageToHtml(document).match(/<style data-nw-style="[^"]+">([^]*?)<\/style>/)[1];
async function click(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
async function toggle(target) { assert.ok(target); await act(async () => target.click()); await flush(); }
async function editorTab(name) { const target = [...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].find((node) => node.textContent === name); assert.ok(target, name); if (target.getAttribute("aria-selected") !== "true") await click(target); }
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
async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const calls = { saves: [] }; let stored = structuredClone(options.document ?? fixture), version = "v1";
  const adapter = {
    listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://example.test"] }],
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }],
    readDocument: async () => ({ document: structuredClone(stored), version }),
    saveDraft: async (request) => { calls.saves.push(structuredClone(request)); stored = { ...structuredClone(request.document), revision: stored.revision + 1 }; version = `v${Number(version.slice(1)) + 1}`; return { status: "saved", version, revision: stored.revision }; },
    prepareRelease: async () => { throw new Error("not used"); }, release: async () => { throw new Error("not used"); }
  };
  await act(async () => root.render(createElement(PageEditor, { adapter, ...options.props }))); await flush();
  await act(async () => frame().dispatchEvent(new dom.window.Event("load")));
  return { calls, stored: () => stored, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const stateButton = (name) => right().querySelector(`[role="group"][aria-label="編集する状態"] button[title="${name}"]`);

test("a link's hover and focus look is created with the keyboard, forced on the canvas, saved and reproduced in published CSS", async () => {
  const app = await setup({ props: { builder: { motions: [{ id: "quiet-pulse", label: "静かな強調", description: "説明的プリセット", style: { states: { focus: { scale: 1.04 } } } }] } } });
  try {
    await click(button("a · link")); await editorTab("変形");
    const transformText = right().textContent;
    assert.equal(input("動きのプリセット", right()), undefined);
    assert.ok(!transformText.includes("説明的プリセット"));
    assert.ok(transformText.indexOf("イージング") < transformText.indexOf("時間") && transformText.indexOf("時間") < transformText.indexOf("遅延"));
    assert.ok(group("移動") && group("拡大・縮小") && group("傾き"));
    const hover = stateButton("ホバー");
    assert.equal(hover.tagName, "BUTTON"); assert.equal(hover.type, "button"); assert.equal(hover.getAttribute("aria-pressed"), "false"); assert.ok(hover.tabIndex >= 0);
    hover.focus(); assert.equal(document.activeElement, hover);
    await click(hover);
    assert.ok(right().textContent.includes("ホバー中に変える見た目だけを表示しています。"));
    assert.equal(field("幅", right()), undefined); assert.equal(right().querySelector('[aria-label="編集する幅"]'), null);
    assert.equal(check("キーボードのフォーカス時も同じ見た目にする").checked, true);
    input("文字色", right()).focus();
    await change(input("文字色", right()), "#c0392b");
    await change(input("Y", group("移動")), "-2");
    assert.ok(canvasExtra().includes('[data-nw-node="link"]{color:#c0392b;translate:0 -2px;}'), "the canvas shows the hover look without a pointer");
    assert.ok(canvasExtra().includes("*{animation:none!important;transition:none!important}"));
    await click(stateButton("通常"));
    await editorTab("ボックス"); assert.ok(input("幅", right()));
    await editorTab("変形");
    await change(input("時間", right()), "0.2");
    await click(button("下書き保存"));
    const saved = app.calls.saves[0].document.body[0].children[2].style;
    assert.deepEqual(saved.states, { hover: { color: "#c0392b", translate: "0 -2px" }, focus: { color: "#c0392b", translate: "0 -2px" } });
    assert.equal(saved.base.transitionDuration, 200);
    await click(button("最新の文書を再読込"));
    const css = publishedCss(app.stored());
    assert.equal(pageCss(), css);
    assert.match(css, /@media \(hover:hover\)\{[^}]*link"\]:hover\{color:#c0392b;translate:0 -2px;\}\}/);
    assert.match(css, /link"\]:focus-visible\{color:#c0392b;translate:0 -2px;\}/);
    assert.match(css, /@media \(prefers-reduced-motion:no-preference\)\{[^}]*link"\]\{transition-property:color,translate;transition-duration:200ms;\}\}/);
  } finally { await app.cleanup(); }
});

test("transform inspector edits both scale and skew axes and renders safe skew CSS", async () => {
  const app = await setup();
  try {
    await click(button("section · hero")); await editorTab("変形");
    await change(input("X", group("拡大・縮小")), "125");
    await change(input("Y", group("拡大・縮小")), "150");
    await change(input("X", group("傾き")), "12");
    await change(input("Y", group("傾き")), "5");
    await click(button("下書き保存"));
    assert.equal(app.calls.saves[0].document.body[0].style.base.scale, "1.25 1.5");
    assert.equal(app.calls.saves[0].document.body[0].style.base.skew, "12deg 5deg");
    assert.ok(pageCss().includes("scale:1.25 1.5;transform:skew(12deg,5deg);"));
  } finally { await app.cleanup(); }
});

test("a section hidden only on tablets is marked in layers, cannot hide everywhere and reaches the published CSS", async () => {
  const app = await setup();
  try {
    await click(button("section · hero")); await editorTab("設定");
    await toggle(check("タブレット 768px〜"));
    await change(document.querySelector('[aria-label="表示幅"]'), "768");
    const layer = [...document.querySelectorAll(".e-layer")].find((node) => node.textContent.startsWith("section · hero"));
    assert.ok(layer.classList.contains("is-hidden-here")); assert.ok(layer.textContent.includes("この幅で非表示"));
    await toggle(check("基本")); await toggle(check("PC 1280px〜"));
    assert.ok(document.body.textContent.includes("どこかの幅では表示してください。"));
    assert.equal(check("PC 1280px〜").checked, true);
    await click(button("下書き保存"));
    assert.deepEqual(app.calls.saves[0].document.body[0].style.hidden, [{ minWidth: 0, maxWidth: 1279 }]);
    const css = publishedCss(app.stored()), scope = css.match(/data-nw-scope="([^"]+)"/)[1];
    assert.ok(css.endsWith(`@media (max-width:1279.98px){[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="hero"]{display:none}}`));
  } finally { await app.cleanup(); }
});

test("appear settings explain reduced motion and scroll timing and are saved", async () => {
  const app = await setup();
  try {
    await click(button("section · hero")); await editorTab("変形");
    assert.ok(right().textContent.includes("動きを減らす設定の利用者には動きなしで表示します。"));
    await change(input("登場の効果", right()), "fade-up");
    await change(input("登場の時間", right()), "0.8");
    await click(right().querySelector('[aria-label="登場のきっかけ"] button[title="画面に入ったとき"]'));
    assert.ok(right().textContent.includes("画面に入ったときはスクロール量に合わせて動きます。"));
    assert.equal(input("登場の時間", right()).disabled, true);
    await click(button("下書き保存"));
    assert.deepEqual(app.calls.saves[0].document.body[0].style.appear, { effect: "fade-up", trigger: "view", duration: 800, delay: 0 });
    assert.ok(publishedCss(app.stored()).includes("@supports (animation-timeline: view())"));
  } finally { await app.cleanup(); }
});

test("motion is stopped while editing, replays on demand and in preview, where states are not forced", async () => {
  const doc = structuredClone(fixture); doc.body[0].children[2].style = { states: { hover: { color: "#c0392b" } } }; doc.body[0].style.appear = { effect: "fade", trigger: "load", duration: 500, delay: 0 };
  const app = await setup({ document: doc });
  try {
    const play = button("アニメーションを再生");
    assert.equal(play.getAttribute("aria-pressed"), "false");
    assert.ok(canvasExtra().includes("*{animation:none!important;transition:none!important}"));
    const before = frame().contentDocument.querySelector("[data-nw-scope]");
    await click(play);
    assert.equal(button("アニメーションを再生").getAttribute("aria-pressed"), "true");
    assert.ok(!canvasExtra().includes("animation:none"));
    assert.notEqual(frame().contentDocument.querySelector("[data-nw-scope]"), before, "the page is drawn again so the appear effect plays");
    await click(button("アニメーションを再生"));
    await click(button("a · link")); await editorTab("変形"); await click(stateButton("ホバー"));
    assert.ok(canvasExtra().includes('[data-nw-node="link"]{color:#c0392b;}'));
    await click(button("プレビュー"));
    assert.equal(button("アニメーションを再生").getAttribute("aria-pressed"), "true"); assert.equal(button("アニメーションを再生").disabled, true);
    assert.ok(!canvasExtra().includes("link") && !canvasExtra().includes("animation:none"));
  } finally { await app.cleanup(); }
});

test("toggle and carousel presets are inserted from the palette and the canvas never opens details on click", async () => {
  const app = await setup();
  try {
    const palette = (name) => [...document.querySelectorAll('[aria-label="要素を追加"] button')].find((node) => node.textContent.endsWith(name));
    await click(palette("トグル（開閉）")); await click(palette("カルーセル"));
    const details = frame().contentDocument.querySelector("details"), summary = details.querySelector("summary");
    assert.equal(details.open, false);
    const view = frame().contentWindow, event = new view.MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => summary.dispatchEvent(event)); await flush();
    assert.equal(event.defaultPrevented, true); assert.equal(frame().contentDocument.querySelector("details").open, false);
    const carousel = frame().contentDocument.querySelector('[aria-label="カルーセル"]');
    assert.equal(carousel.getAttribute("tabindex"), "0"); assert.equal(carousel.getAttribute("role"), "region");
    assert.ok(pageCss().includes("overflow-x:auto;") && pageCss().includes("scroll-snap-type:x mandatory;"));
    await click(button("下書き保存"));
    const body = app.calls.saves[0].document.body;
    assert.deepEqual(body.slice(-2).map((node) => node.tag), ["details", "div"]);
    assert.equal(body.at(-2).children[0].tag, "summary");
  } finally { await app.cleanup(); }
});

test("a host insertion catalog reaches the real palette and uses unique IDs for the whole subtree", async () => {
  const builder = { insertions: [{ id: "feature-card", label: "特徴カード", group: "カスタム", glyph: "◇", create: ({ id }) => ({
    type: "element", id: id(), tag: "article", children: [
      { type: "element", id: id(), tag: "h2", children: [{ type: "text", text: "特徴" }] },
      { type: "element", id: id(), tag: "p", children: [{ type: "text", text: "説明" }] }
    ]
  }) }] };
  const app = await setup({ props: { builder } });
  try {
    const labels = [...document.querySelectorAll('[aria-label="要素を追加"] button')].map((node) => node.textContent);
    assert.ok(!labels.some((label) => /横並び|グリッド|リスト/.test(label)), "追加構造はhostが明示した場合だけ表示する");
    const preset = [...document.querySelectorAll('[aria-label="要素を追加"] button')].find((node) => node.textContent.endsWith("特徴カード"));
    await click(preset); await click(button("下書き保存"));
    const card = app.calls.saves[0].document.body.at(-1), ids = [card.id, ...card.children.map((child) => child.id)];
    assert.equal(card.tag, "article"); assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every((id) => /^node_\d+$/.test(id)));
  } finally { await app.cleanup(); }
});

test("business blocks show motion controls only for permitted keys", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: {} });
  const blocks = { Notice: { label: "お知らせ", props: {}, styleProperties: ["backgroundColor", "states"], component: () => createElement("p", null, "お知らせ") } };
  const app = await setup({ document: doc, props: { blocks } });
  try {
    await click(button("お知らせ · notice")); await editorTab("変形");
    assert.ok(stateButton("ホバー"));
    assert.equal(input("登場の効果", right()), undefined); assert.equal(check("基本"), undefined); assert.equal(input("回転", right()), undefined);
    await click(stateButton("ホバー")); await change(input("背景色", right()), "#eef3ef");
    await click(button("下書き保存"));
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).style, { states: { hover: { backgroundColor: "#eef3ef" }, focus: { backgroundColor: "#eef3ef" } } });
  } finally { await app.cleanup(); }
});
