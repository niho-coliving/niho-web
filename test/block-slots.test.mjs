import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DocumentValidationError, generatePageCss, parseComponentLibrary, parsePageDocument, resolvePageDocument } from "@niho/web/core";
import { PageRenderer } from "@niho/web/react";
import { renderPageToHtml } from "@niho/web/server";
import { editDocument } from "../dist/editor-model.js";

// 架空の体験データ。ブロックは props 以外の値（料金・予約先）をホストのデータから描画する。
const experiences = [
  { slug: "pottery", title: "陶芸体験", price: 4800, image: "/images/pottery.webp" },
  { slug: "surf", title: "朝のサーフィン", price: 6200, image: "/images/surf.webp" },
  { slug: "tea", title: "茶室で一服", price: 3500, image: "/images/tea.webp" }
];
const calls = [];
const blocks = {
  ExperienceCards: {
    props: { heading: { type: "string", maxLength: 120 }, ctaLabel: { type: "string", maxLength: 40 }, columns: { type: "number", min: 1, max: 4 } },
    slots: {
      list: { label: "カードの並び", style: ["display", "gridTemplateColumns", "gap"] },
      image: { label: "カード画像", style: ["objectFit", "borderRadius", "height"] },
      title: { label: "カードの見出し", style: ["color", "fontSize", "fontWeight"] },
      price: { label: "料金表示", style: ["color", "fontSize"], data: { reason: "体験ごとの料金を表示します。", source: "NIHO の体験データ" } },
      cta: { label: "予約ボタン", style: ["color", "backgroundColor", "borderRadius", "padding"], text: "ctaLabel" },
      checkout: { label: "決済", data: { reason: "決済はホストの予約画面で処理します。", source: "NIHO の予約・決済" } }
    },
    component: ({ heading, ctaLabel }) => {
      calls.push("render");
      return createElement("section", null, createElement("h2", null, heading ?? "体験"),
        createElement("ul", { "data-nw-slot": "list" }, ...experiences.map((experience) => createElement("li", { key: experience.slug },
          createElement("img", { "data-nw-slot": "image", src: experience.image, alt: "" }),
          createElement("h3", { "data-nw-slot": "title" }, experience.title),
          createElement("span", { "data-nw-slot": "price" }, `¥${experience.price.toLocaleString("ja-JP")}`),
          createElement("a", { "data-nw-slot": "cta", href: `/experiences/${experience.slug}/book` }, ctaLabel ?? "予約する")))));
    }
  },
  PlainNotice: { props: { heading: { type: "string" } }, component: ({ heading }) => createElement("aside", null, heading) }
};
const cards = (extra = {}) => structuredClone({ type: "component", id: "cards", block: "ExperienceCards", props: { heading: "人気の体験", ctaLabel: "予約する" }, ...extra });
const page = (body, tokens = { accent: { type: "color", value: "#195640" }, gap: { type: "length", value: 16 } }) => ({
  schemaVersion: 1, siteId: "experience", pageId: "experiences", locale: "ja", revision: 3, title: "体験一覧", tokens, body
});
const design = {
  list: { base: { display: "grid", gap: { token: "gap" } }, responsive: [{ minWidth: 768, declarations: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" } }] },
  image: { base: { objectFit: "cover", borderRadius: 12, height: 180 } },
  title: { base: { color: { token: "accent" }, fontSize: 18, fontWeight: 700 } },
  price: { base: { fontSize: 15 } },
  cta: { base: { backgroundColor: "#195640", color: "#ffffff", borderRadius: 999, padding: "8px 16px" } }
};
const rejects = (action, pattern) => assert.throws(action, (error) => error instanceof DocumentValidationError && pattern.test(error.message));

test("slot styles round trip and generate one scoped rule per declared region for every repeated card", () => {
  const input = page([cards({ slots: design })]), parsed = parsePageDocument(input, blocks);
  assert.deepEqual(parsed, input);
  input.body[0].slots.title.base.fontSize = 99;
  assert.equal(parsed.body[0].slots.title.base.fontSize, 18);
  const css = generatePageCss(page([cards({ slots: design })]), blocks);
  const node = '[data-nw-node="cards"]';
  assert.ok(css.includes(`${node} [data-nw-slot="title"]{color:var(--nw-accent);font-size:18px;font-weight:700;}`));
  assert.ok(css.includes(`@media (min-width:768px){[data-nw-scope="nw-10-experience-11-experiences-2-ja-1-3"] [data-nw-owner="nw-10-experience-11-experiences-2-ja-1-3"]${node} [data-nw-slot="list"]{grid-template-columns:repeat(3, minmax(0, 1fr));}}`));
  assert.ok(css.indexOf('[data-nw-slot="cta"]') < css.indexOf('[data-nw-slot="image"]'), "slot rules are sorted by name");
  const html = renderPageToHtml(page([cards({ slots: design })]), blocks);
  assert.equal(html.match(/ data-nw-slot="title"/g)?.length, experiences.length);
  assert.equal(html.match(/\[data-nw-slot=&quot;title&quot;\]|\[data-nw-slot="title"\]\{/g)?.length, 1, "the repeated cards share a single design rule");
  assert.equal(renderToString(createElement(PageRenderer, { document: page([cards({ slots: design })]), blocks })).includes('[data-nw-slot="title"]{'), true);
});

test("changing the display label does not change price, destinations or the data the block renders", () => {
  const before = renderPageToHtml(page([cards({ slots: design })]), blocks);
  const after = renderPageToHtml(page([cards({ props: { heading: "人気の体験", ctaLabel: "空き状況を見る" }, slots: { ...design, cta: { base: { backgroundColor: "#c0392b" } } } })]), blocks);
  const prices = (html) => [...html.matchAll(/ data-nw-slot="price">([^<]*)</g)].map((match) => match[1]);
  const links = (html) => [...html.matchAll(/ data-nw-slot="cta" href="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(prices(after), prices(before));
  assert.deepEqual(prices(after), ["¥4,800", "¥6,200", "¥3,500"]);
  assert.deepEqual(links(after), links(before));
  assert.deepEqual(links(after), experiences.map((experience) => `/experiences/${experience.slug}/book`));
  assert.equal(after.match(/>空き状況を見る</g)?.length, experiences.length);
  assert.ok(!after.includes(">予約する<"));
});

test("undeclared regions, disallowed properties and styles on locked regions fail closed in every entry point", () => {
  const invalid = [
    [{ headline: { base: { color: "#000000" } } }, /\.slots\.headline: unknown block slot$/],
    [{ title: { base: { display: "none" } } }, /\.slots\.title: style not allowed in this slot$/],
    [{ title: { responsive: [{ minWidth: 768, declarations: { position: "fixed" } }] } }, /\.slots\.title: style not allowed in this slot$/],
    [{ price: { base: { backgroundColor: "#ff0000" } } }, /\.slots\.price: style not allowed in this slot$/],
    [{ checkout: { base: { color: "#ff0000" } } }, /\.slots\.checkout: style not allowed in this slot$/],
    [{ title: { base: { color: "red;display:none" } } }, /unsupported style value$/],
    [{ title: { base: { backgroundImage: { asset: { provider: "library", id: "photo-1" } } } } }, /\.slots\.title: style not allowed in this slot$/],
    [{ title: { base: { color: { token: "gap" } } } }, /incompatible token type$/],
    [{ title: { base: { color: "#000000" }, hover: {} } }, /\.slots\.title: unknown field$/],
    [{ ["__proto__"]: { base: { color: "#000000" } } }, /unknown block slot|expected a JSON object/],
    [[], /\.slots: expected a JSON object$/]
  ];
  calls.length = 0;
  for (const [slots, pattern] of invalid) {
    const input = page([cards({ slots: slots })]);
    rejects(() => parsePageDocument(input, blocks), pattern);
    rejects(() => generatePageCss(input, blocks), pattern);
    rejects(() => renderPageToHtml(input, blocks), pattern);
  }
  rejects(() => parsePageDocument(page([{ type: "component", id: "notice", block: "PlainNotice", props: {}, slots: { title: { base: { color: "#000000" } } } }]), blocks), /\.slots\.title: unknown block slot$/);
  assert.equal(calls.length, 0, "blocks never render before validation finishes");
});

test("registry slot declarations are checked for names, labels, text props, properties and data notes", () => {
  const contract = (slots) => ({ Cards: { props: { label: { type: "string" }, count: { type: "number" } }, slots, component: () => null } });
  const node = { type: "component", id: "cards", block: "Cards", props: {} };
  for (const slots of [
    { "bad name": { label: "見出し" } }, { constructor: { label: "見出し" } }, { title: { label: " " } }, { title: { label: "見出し\n" } },
    { title: { label: "見出し", text: "count" } }, { title: { label: "見出し", text: "missing" } }, { title: { label: "見出し", style: ["color", "content"] } },
    { title: { label: "見出し", style: "color" } }, { price: { label: "料金", data: { reason: "", source: "NIHO" } } }, { price: { label: "料金", data: { reason: "料金", source: " " } } }
  ]) rejects(() => parsePageDocument(page([node]), contract(slots)), /^\$\.body\[0\]\.block: invalid block slot contract$/);
  assert.deepEqual(parsePageDocument(page([node]), contract({ title: { label: "見出し", style: ["color"], text: "label" }, price: { label: "料金", data: { reason: "料金を表示", source: "NIHO" } } })).body[0], node);
});

test("editor slot operations set and clear allowed appearance and reject everything else", () => {
  let next = editDocument(page([cards()]), { type: "slotStyle", path: [0], slot: "title", breakpoint: "base", property: "color", value: "#123456" }, blocks);
  next = editDocument(next, { type: "slotStyle", path: [0], slot: "list", breakpoint: 768, property: "gridTemplateColumns", value: "1fr 1fr" }, blocks);
  next = editDocument(next, { type: "slotStyle", path: [0], slot: "list", breakpoint: 375, property: "gap", value: 8 }, blocks);
  assert.deepEqual(next.body[0].slots, {
    title: { base: { color: "#123456" } },
    list: { responsive: [{ minWidth: 375, declarations: { gap: 8 } }, { minWidth: 768, declarations: { gridTemplateColumns: "1fr 1fr" } }] }
  });
  next = editDocument(next, { type: "slotStyle", path: [0], slot: "title", breakpoint: "base", property: "color", value: undefined }, blocks);
  next = editDocument(next, { type: "slotStyle", path: [0], slot: "list", breakpoint: 375, property: "gap", value: undefined }, blocks);
  assert.deepEqual(next.body[0].slots, { list: { responsive: [{ minWidth: 768, declarations: { gridTemplateColumns: "1fr 1fr" } }] } });
  next = editDocument(next, { type: "slotStyle", path: [0], slot: "list", breakpoint: 768, property: "gridTemplateColumns", value: undefined }, blocks);
  assert.equal("slots" in next.body[0], false);
  for (const operation of [
    { type: "slotStyle", path: [0], slot: "title", breakpoint: "base", property: "display", value: "none" },
    { type: "slotStyle", path: [0], slot: "checkout", breakpoint: "base", property: "color", value: "#000000" },
    { type: "slotStyle", path: [0], slot: "unknown", breakpoint: "base", property: "color", value: "#000000" }
  ]) assert.throws(() => editDocument(next, operation, blocks), DocumentValidationError);
  assert.throws(() => editDocument(next, { type: "slotStyle", path: [0], slot: "__proto__", breakpoint: "base", property: "color", value: "#000000" }, blocks), /表示領域が見つかりません/);
  assert.throws(() => editDocument(page([{ type: "element", id: "box", tag: "div", children: [] }]), { type: "slotStyle", path: [0], slot: "title", breakpoint: "base", property: "color", value: "#000000" }, blocks), /ブロックを選択してください/);
  assert.throws(() => editDocument(page([cards()]), { type: "slotStyle", path: [0], slot: "title", breakpoint: "base", property: "color", value: "#000000" }, blocks, [{ nodeId: "cards", fields: ["slots"], reason: "ホストが固定しています。" }]), /ホストが固定しています/);
});

test("slot designs inside shared components resolve with the instance IDs and the same contract", () => {
  const library = parseComponentLibrary({ schemaVersion: 1, siteId: "experience", revision: 1, tokens: { accent: { type: "color", value: "#195640" } }, components: [{
    id: "featured", name: "おすすめ体験", kind: "section", version: 1,
    root: { type: "element", id: "n1", tag: "section", children: [{ type: "component", id: "n2", block: "ExperienceCards", props: { heading: "おすすめ" }, slots: { title: { base: { color: { token: "accent" } } } } }] }
  }] }, blocks);
  const { document } = resolvePageDocument(page([{ type: "instance", id: "featured1", component: "featured" }]), library, blocks);
  assert.deepEqual(document.body[0].children[0].slots, { title: { base: { color: { token: "accent" } } } });
  assert.ok(generatePageCss(document, blocks).includes('[data-nw-node="featured1--n2"] [data-nw-slot="title"]{color:var(--nw-accent);}'));
  assert.throws(() => parseComponentLibrary({ ...structuredClone(library), components: [{ ...structuredClone(library.components[0]), root: { type: "element", id: "n1", tag: "section", children: [{ type: "component", id: "n2", block: "ExperienceCards", props: {}, slots: { price: { base: { backgroundColor: "#000000" } } } }] } }] }, blocks), /style not allowed in this slot/);
});
