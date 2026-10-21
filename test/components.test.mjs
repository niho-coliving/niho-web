import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  COMPONENT_LIMITS, DocumentValidationError, componentIssues, componentUsage, generatePageCss, parseComponentLibrary, parsePageDocument, resolvePageDocument
} from "@niho/web/core";
import { PageRenderer } from "@niho/web/react";
import { renderPageToHtml } from "@niho/web/server";
import { createProjectEditorAdapter } from "@niho/web/project-editor";
import { editDocument, validateReleasePlan } from "../dist/editor-model.js";
import {
  bumpChangedComponentVersions, componentDocument, createComponentFromNode, detachInstance, duplicateComponent, removeComponent, renameComponent,
  setComponentKind, setComponentProp, withComponentDocument
} from "../dist/component-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const navbar = () => ({
  id: "navbar", name: "ナビゲーション", kind: "navigation", version: 1,
  root: { type: "element", id: "n1", tag: "nav", attrs: { "aria-label": "メイン" }, style: { base: { display: "flex", gap: { token: "gap" } }, responsive: [{ minWidth: 768, declarations: { gap: 24 } }] }, children: [
    { type: "element", id: "n2", tag: "a", attrs: { href: "/" }, children: [{ type: "text", text: "ホーム" }] },
    { type: "element", id: "n3", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "紹介" }] },
    { type: "instance", id: "n4", component: "badge", props: { label: "新着" } }
  ] },
  props: { aboutLabel: { label: "紹介リンクの文字", node: "n3", field: "text" }, aboutHref: { label: "紹介リンク先", node: "n3", field: "href" } }
});
const badge = () => ({
  id: "badge", name: "バッジ", kind: "part", version: 1,
  root: { type: "element", id: "n1", tag: "span", style: { base: { color: { token: "accent" } } }, children: [
    { type: "element", id: "n2", tag: "strong", children: [{ type: "text", text: "NEW" }] }
  ] },
  props: { label: { label: "表示", node: "n2", field: "text" } }
});
const card = () => ({
  id: "card", name: "カード", kind: "section", version: 1,
  root: { type: "element", id: "n1", tag: "article", children: [
    { type: "element", id: "n2", tag: "img", attrs: { src: "/card.webp", alt: "" }, children: [] },
    { type: "element", id: "n3", tag: "h2", children: [] }
  ] },
  props: { image: { label: "画像", node: "n2", field: "src" }, alt: { label: "画像の説明", node: "n2", field: "alt" }, title: { label: "見出し", node: "n3", field: "text" } }
});
const library = () => ({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: { gap: { type: "length", value: 12 }, accent: { type: "color", value: "#c0392b" } }, components: [navbar(), badge(), card()] });
const box = (id, children) => ({ id, name: `部品 ${id}`, kind: "part", version: 1, root: { type: "element", id: "n1", tag: "div", children } });
const instance = (id, component, extra = {}) => ({ type: "instance", id, component, ...extra });
const page = (body, pageId = "home") => ({ ...structuredClone(fixture), pageId, body: [...structuredClone(body), ...structuredClone(fixture.body)] });
const rejects = (action, pattern) => assert.throws(action, (error) => error instanceof DocumentValidationError && pattern.test(error.message));
const resolved = (document, components = library()) => resolvePageDocument(document, components).document;
const find = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children && find(node.children, id);
    if (found) return found;
  }
};

test("component instances preserve asset images, backgrounds and page metadata", () => {
  const asset = { provider: "uploads", id: "sea" };
  const component = box("asset_box", [{ type: "element", id: "n2", tag: "img", asset, attrs: { alt: "海" }, children: [] }]);
  component.root.style = { base: { backgroundImage: { asset } } };
  const components = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [component] });
  const document = { ...page([instance("photo", "asset_box")]), meta: { description: "海の紹介" } };
  const parsed = parsePageDocument(document, {}, { components });
  assert.deepEqual(parsed.meta, { description: "海の紹介" });
  const expanded = resolvePageDocument(parsed, components).document;
  assert.deepEqual(expanded.body[0].children[0].asset, asset);
  assert.deepEqual(expanded.body[0].style.base.backgroundImage, { asset });
  assert.deepEqual(expanded.meta, { description: "海の紹介" });
});

test("component library round trips without retaining mutable input references", () => {
  const input = library(), parsed = parseComponentLibrary(input);
  assert.deepEqual(parsed, input);
  input.tokens.gap.value = 99;
  input.components[0].root.children[0].children[0].text = "changed";
  input.components[0].root.style.base.gap.token = "accent";
  input.components[0].root.children[2].props.label = "changed";
  input.components[0].props.aboutLabel.label = "changed";
  assert.equal(parsed.tokens.gap.value, 12);
  assert.equal(parsed.components[0].root.children[0].children[0].text, "ホーム");
  assert.deepEqual(parsed.components[0].root.style.base.gap, { token: "gap" });
  assert.equal(parsed.components[0].root.children[2].props.label, "新着");
  assert.equal(parsed.components[0].props.aboutLabel.label, "紹介リンクの文字");
  const { props: _unused, ...withoutProps } = badge();
  assert.equal(Object.hasOwn(parseComponentLibrary({ ...library(), components: [withoutProps] }).components[0], "props"), false);
  assert.deepEqual(parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [] }).components, []);
  assert.deepEqual(COMPONENT_LIMITS, { components: 200, nodes: 5000, props: 32, instanceProps: 64, nesting: 4, nameLength: 80, labelLength: 40 });
  assert.ok(Object.isFrozen(COMPONENT_LIMITS));
});

test("library identity, unknown fields, duplicates, kinds, versions, roots and prop names fail closed", () => {
  const prop = { label: "値", node: "n3", field: "text" };
  for (const [mutate, pattern] of [
    [(input) => { input.script = "alert(1)"; }, /^\$: unknown field/],
    [(input) => { input.schemaVersion = 2; }, /^\$\.schemaVersion:/],
    [(input) => { input.siteId = "demo\"]{"; }, /^\$\.siteId:/],
    [(input) => { input.revision = 0; }, /^\$\.revision:/],
    [(input) => { input.revision = 1.5; }, /^\$\.revision:/],
    [(input) => { input.tokens.link = { type: "url", value: "https://example.com" }; }, /^\$\.tokens:/],
    [(input) => { input.components = {}; }, /^\$\.components:/],
    [(input) => { input.components = Array.from({ length: COMPONENT_LIMITS.components + 1 }, (_, index) => box(`c${index}`, [])); }, /^\$\.components:/],
    [(input) => { input.components[0].html = "<b>raw</b>"; }, /^\$\.components\[0\]: unknown field/],
    [(input) => { input.components[1].id = "navbar"; }, /^\$\.components\[1\]\.id: duplicate component ID/],
    [(input) => { input.components[1].id = "1badge"; }, /^\$\.components\[1\]\.id: invalid identifier/],
    [(input) => { input.components[1].name = " ナビゲーション "; }, /^\$\.components\[1\]\.name: duplicate component name/],
    [(input) => { input.components[0].name = "   "; }, /^\$\.components\[0\]\.name: invalid string/],
    [(input) => { input.components[0].name = "改\n行"; }, /^\$\.components\[0\]\.name: invalid string/],
    [(input) => { input.components[0].name = "x".repeat(COMPONENT_LIMITS.nameLength + 1); }, /^\$\.components\[0\]\.name: invalid string/],
    [(input) => { input.components[0].kind = "page"; }, /^\$\.components\[0\]\.kind: unknown component kind/],
    [(input) => { input.components[0].version = 0; }, /^\$\.components\[0\]\.version:/],
    [(input) => { input.components[0].version = Number.MAX_SAFE_INTEGER + 1; }, /^\$\.components\[0\]\.version:/],
    [(input) => { input.components[0].root = { type: "text", text: "文字" }; }, /^\$\.components\[0\]\.root: component root must be an element/],
    [(input) => { input.components[0].root = instance("again", "badge"); }, /^\$\.components\[0\]\.root: component root must be an element/],
    [(input) => { input.components[0].root.tag = "script"; }, /^\$\.components\[0\]\.root\.tag: unsupported element/],
    [(input) => { input.components[0].root.children[0].attrs.onclick = "alert(1)"; }, /^\$\.components\[0\]\.root\.children\[0\]\.attrs: unknown field/],
    [(input) => { input.components[0].props = JSON.parse(`{"__proto__":${JSON.stringify(prop)}}`); }, /^\$\.components\[0\]\.props: invalid identifier/],
    [(input) => { input.components[0].props = { constructor: prop }; }, /^\$\.components\[0\]\.props: reserved prop name/],
    [(input) => { input.components[0].props = { prototype: prop }; }, /^\$\.components\[0\]\.props: reserved prop name/]
  ]) {
    const input = library(); mutate(input);
    rejects(() => parseComponentLibrary(input), pattern);
  }
  assert.equal({}.label, undefined);
  rejects(() => parseComponentLibrary(null), /^\$: expected a JSON object/);
});

test("public props target own elements with fitting fields only", () => {
  const prop = (node, field, label = "値") => ({ label, node, field });
  const withProps = (props) => { const input = library(); input.components[0].props = props; return input; };
  for (const [props, pattern] of [
    [{ a: prop("missing", "text") }, /^\$\.components\[0\]\.props\.a\.node: prop target not found/],
    [{ a: prop("n4", "text") }, /^\$\.components\[0\]\.props\.a\.node: prop target not found/],
    [{ a: prop("n2", "src") }, /^\$\.components\[0\]\.props\.a\.field: prop field does not fit the target/],
    [{ a: prop("n2", "alt") }, /props\.a\.field: prop field does not fit/],
    [{ a: prop("n1", "href") }, /props\.a\.field: prop field does not fit/],
    [{ a: prop("n1", "text") }, /props\.a\.field: prop field does not fit/],
    [{ a: prop("n3", "text"), b: prop("n3", "text") }, /^\$\.components\[0\]\.props\.b: duplicate prop target/],
    [{ a: prop("n3", "text", " ") }, /props\.a\.label: invalid string/],
    [{ a: prop("n3", "text", "x".repeat(COMPONENT_LIMITS.labelLength + 1)) }, /props\.a\.label: invalid string/],
    [{ a: prop("n3", "html") }, /props\.a\.field: unknown prop field/],
    [{ a: { ...prop("n3", "text"), extra: true } }, /props\.a: unknown field/],
    [{ "1a": prop("n3", "text") }, /props: invalid identifier/],
    [Object.fromEntries(Array.from({ length: COMPONENT_LIMITS.props + 1 }, (_, index) => [`p${index}`, prop("n3", "text")])), /props: too many component props/]
  ]) rejects(() => parseComponentLibrary(withProps(props)), pattern);
  assert.doesNotThrow(() => parseComponentLibrary(withProps({ label: prop("n3", "text"), link: prop("n3", "href"), root: prop("n2", "text") })));
  const nested = library();
  nested.components[1].root.children[0].id = "inner"; nested.components[1].props.label.node = "inner";
  nested.components[0].props = { a: prop("inner", "text") };
  rejects(() => parseComponentLibrary(nested), /^\$\.components\[0\]\.props\.a\.node: prop target not found/);
  const list = library();
  list.components.push({ ...box("list", [{ type: "element", id: "n2", tag: "ul", children: [] }]), props: { a: prop("n2", "text") } });
  rejects(() => parseComponentLibrary(list), /^\$\.components\[3\]\.props\.a\.field: prop field does not fit/);
});

test("an asset image can expose its description but not a URL", () => {
  const asset = { provider: "library", id: "photo-1" };
  const withAsset = (props) => ({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{ id: "photo", name: "写真", kind: "part", version: 1,
    root: { type: "element", id: "n1", tag: "figure", children: [{ type: "element", id: "n2", tag: "img", asset, attrs: { alt: "" }, children: [] }] }, props }] });
  assert.equal(parseComponentLibrary(withAsset({ alt: { label: "画像の説明", node: "n2", field: "alt" } })).components[0].props.alt.field, "alt");
  rejects(() => parseComponentLibrary(withAsset({ image: { label: "画像", node: "n2", field: "src" } })), /\.props\.image\.field: prop field does not fit the target$/);
});

test("nested instances must resolve inside the same library without cycles or deep nesting", () => {
  const dangling = library(); dangling.components[0].root.children[2].component = "missing";
  rejects(() => parseComponentLibrary(dangling), /^\$\.components\[0\]\.root\.children\[2\]\.component: unknown component/);
  rejects(() => parseComponentLibrary({ ...library(), components: [box("loop", [instance("n2", "loop")])] }), /^\$\.components\[0\]: circular component reference/);
  const pair = { ...library(), components: [box("first", [instance("n2", "second")]), box("second", [instance("n2", "first")])] };
  rejects(() => parseComponentLibrary(pair), /^\$\.components\[0\]: circular component reference/);
  const chain = (length) => ({ ...library(), components: Array.from({ length }, (_, index) =>
    box(`level${index + 1}`, index + 1 < length ? [instance("n2", `level${index + 2}`)] : [{ type: "text", text: "葉" }])) });
  assert.doesNotThrow(() => parseComponentLibrary(chain(COMPONENT_LIMITS.nesting)));
  const reversed = chain(COMPONENT_LIMITS.nesting); reversed.components.reverse();
  assert.doesNotThrow(() => parseComponentLibrary(reversed));
  rejects(() => parseComponentLibrary(chain(COMPONENT_LIMITS.nesting + 1)), /^\$\.components\[0\]: component nesting too deep/);
  const deepReversed = chain(COMPONENT_LIMITS.nesting + 1); deepReversed.components.reverse();
  rejects(() => parseComponentLibrary(deepReversed), /^\$\.components\[4\]: component nesting too deep/);
});

test("masters are validated after expansion with the document HTML rules, block registry and limits", () => {
  const paragraph = { ...library(), components: [box("block", []), { ...box("text", []), root: { type: "element", id: "n1", tag: "p", children: [instance("n2", "block")] } }] };
  rejects(() => parseComponentLibrary(paragraph), /^\$\.components\[1\]\.root\.children\[0\]: invalid HTML content nesting/);
  const link = { ...library(), components: [
    { ...box("inner", []), root: { type: "element", id: "n1", tag: "span", children: [{ type: "element", id: "n2", tag: "a", attrs: { href: "/" }, children: [{ type: "text", text: "内側" }] }] } },
    { ...box("outer", []), root: { type: "element", id: "n1", tag: "a", attrs: { href: "/outer" }, children: [instance("n2", "inner")] } }
  ] };
  rejects(() => parseComponentLibrary(link), /^\$\.components\[1\]\.resolved\.body\[0\]\.children\[0\]\.children\[0\]: invalid HTML content nesting$/);
  const htmlId = { ...library(), components: [
    { ...box("anchor", []), root: { type: "element", id: "n1", tag: "div", attrs: { id: "contact" }, children: [] } },
    box("twice", [instance("n2", "anchor"), instance("n3", "anchor")])
  ] };
  rejects(() => parseComponentLibrary(htmlId), /^\$\.components\[1\]\.resolved\.body\[0\]\.children\[1\]\.attrs\.id: duplicate HTML ID$/);
  const broken = { ...library(), components: [box("outer", [instance("n2", "deep")]), { ...box("deep", []), root: { type: "element", id: "n1", tag: "div", children: [{ type: "element", id: "x".repeat(75), tag: "span", children: [] }] } }] };
  rejects(() => parseComponentLibrary(broken), /^\$\.components\[1\]\.resolved\.body\[0\]\.children\[0\]\.id: invalid string$/);
  const collision = { ...library(), components: [box("leaf", [{ type: "element", id: "n2", tag: "span", children: [] }]), box("host", [instance("a", "leaf"), { type: "element", id: "a--n2", tag: "span", children: [] }])] };
  rejects(() => parseComponentLibrary(collision), /^\$\.components\[1\]\.resolved\.body\[0\]\.children\[1\]\.id: duplicate node ID$/);
  const notice = { ...library(), components: [box("notice", [{ type: "component", id: "n2", block: "Notice", props: { heading: "お知らせ" } }])] };
  const blocks = { Notice: { props: { heading: { type: "string", required: true, maxLength: 10 } } } };
  assert.doesNotThrow(() => parseComponentLibrary(notice, blocks));
  rejects(() => parseComponentLibrary(notice), /^\$\.components\[0\]\.root\.children\[0\]\.block: unregistered block/);
  for (const props of [{}, { heading: "x".repeat(11) }, { heading: "表示", onClick: "evil" }]) {
    const copy = structuredClone(notice); copy.components[0].root.children[0].props = props;
    rejects(() => parseComponentLibrary(copy, blocks), /^\$\.components\[0\]\.root\.children\[0\]\.props/);
  }
  const fanout = (id, next) => box(id, Array.from({ length: 70 }, (_, index) => instance(`i${index}`, next)));
  const explosive = { ...library(), components: [fanout("a", "b"), fanout("b", "c"), fanout("c", "d"), box("d", [{ type: "text", text: "葉" }])] };
  const started = Date.now();
  // b（70 × c）の展開がすでに文書の上限を超えるため、a より先に b の位置で返す。
  rejects(() => parseComponentLibrary(explosive), /^\$\.components\[1\]\.resolved\.body\[0\]\..*: too many nodes$/);
  assert.ok(Date.now() - started < 5000);
  const crowded = { ...library(), components: [box("wide", Array.from({ length: COMPONENT_LIMITS.nodes }, () => ({ type: "text", text: "a" })))] };
  rejects(() => parseComponentLibrary(crowded), /^\$\.components\[0\]\.root\.children\[4999\]: too many nodes/);
});

test("documents with instances require a same-site library and validate references and per-field values", () => {
  const components = parseComponentLibrary(library());
  const home = page([instance("nav1", "navbar")]);
  rejects(() => parsePageDocument(home), /^\$\.body\[0\]: component instance requires a component library$/);
  rejects(() => parsePageDocument(home, {}, { components: { ...components, siteId: "other" } }), /^\$\.siteId: component library belongs to another site$/);
  rejects(() => parsePageDocument(fixture, {}, { components: { ...components, siteId: "other" } }), /^\$\.siteId: component library belongs to another site$/);
  rejects(() => parsePageDocument(page([instance("nav1", "missing")]), {}, { components }), /^\$\.body\[0\]\.component: unknown component$/);
  rejects(() => parsePageDocument(page([instance("nav1", "constructor")]), {}, { components }), /^\$\.body\[0\]\.component: unknown component$/);
  rejects(() => parsePageDocument(page([{ type: "widget", id: "x" }]), {}, { components }), /^\$\.body\[0\]\.type: unknown node type$/);
  rejects(() => parsePageDocument(page([instance("nav1", "navbar", { html: "<b>raw</b>" })]), {}, { components }), /^\$\.body\[0\]: unknown field$/);
  rejects(() => parsePageDocument(page([instance("hero", "navbar")]), {}, { components }), /^\$\.body\[1\]\.id: duplicate node ID$/);
  const parse = (props, component = "navbar") => parsePageDocument(page([instance("nav1", component, { props })]), {}, { components });
  for (const [props, pattern, component] of [
    [{ aboutHref: "javascript:alert(1)" }, /^\$\.body\[0\]\.props\.aboutHref: unsafe URL$/],
    [{ aboutHref: "http://example.com" }, /props\.aboutHref: unsafe URL/],
    [{ aboutLabel: "x".repeat(4097) }, /props\.aboutLabel: invalid string/],
    [{ aboutLabel: 1 }, /props\.aboutLabel: invalid string/],
    [{ image: "data:image/png;base64,AAAA" }, /props\.image: unsafe URL/, "card"],
    [{ alt: "x".repeat(2049) }, /props\.alt: invalid string/, "card"],
    [{ removed: "x".repeat(4097) }, /props\.removed: invalid string/],
    [{ removed: { text: "x" } }, /props\.removed: invalid string/],
    [{ constructor: "x" }, /^\$\.body\[0\]\.props: reserved prop name$/],
    [{ "1st": "x" }, /^\$\.body\[0\]\.props: invalid identifier$/],
    [Object.fromEntries(Array.from({ length: COMPONENT_LIMITS.instanceProps + 1 }, (_, index) => [`p${index}`, "x"])), /^\$\.body\[0\]\.props: too many instance props$/]
  ]) rejects(() => parse(props, component), pattern);
  const values = { alt: "x".repeat(2048), image: "https://example.com/a.webp", title: "" };
  assert.deepEqual(parse(values, "card").body[0].props, values);
  const input = page([instance("nav1", "navbar", { props: { aboutLabel: "会社", removed: "以前の値" } })]), parsed = parsePageDocument(input, {}, { components });
  assert.deepEqual(parsed.body[0], { type: "instance", id: "nav1", component: "navbar", props: { aboutLabel: "会社", removed: "以前の値" } });
  input.body[0].props.aboutLabel = "changed";
  assert.equal(parsed.body[0].props.aboutLabel, "会社");
  assert.deepEqual(parsePageDocument(home, {}, { components }).body[0], { type: "instance", id: "nav1", component: "navbar" });
  const crowded = { ...fixture, body: [...Array.from({ length: 4999 }, () => ({ type: "text", text: "a" })), instance("b1", "badge")] };
  rejects(() => parsePageDocument(crowded, {}, { components }), /^\$\.resolved\.body\[4999\]\.children\[0\]: too many nodes$/);
});

test("instance styles may use library tokens while page elements use page tokens", () => {
  const components = parseComponentLibrary(library());
  const styled = page([instance("nav1", "navbar", { style: { base: { backgroundColor: { token: "accent" } } } })]);
  assert.deepEqual(parsePageDocument(styled, {}, { components }).body[0].style, { base: { backgroundColor: { token: "accent" } } });
  const element = page([]); element.body[0].style.base.backgroundColor = { token: "accent" };
  rejects(() => parsePageDocument(element, {}, { components }), /^\$\.body\[0\]\.style\.base: unknown token$/);
  const overridden = structuredClone(styled); overridden.tokens.accent = { type: "length", value: "1rem" };
  rejects(() => parsePageDocument(overridden, {}, { components }), /^\$\.body\[0\]\.style\.base: incompatible token type$/);
  const tooMany = structuredClone(styled);
  for (let index = Object.keys(tooMany.tokens).length; index < 127; index++) tooMany.tokens[`extra${index}`] = { type: "number", value: index };
  assert.doesNotThrow(() => parsePageDocument({ ...tooMany, body: fixture.body }, {}, { components }));
  rejects(() => parsePageDocument(tooMany, {}, { components }), /^\$\.resolved\.tokens: too many tokens$/);
});

test("instance placement follows the nesting rule of the component root", () => {
  const input = library();
  input.components.push({ ...box("item", []), root: { type: "element", id: "n1", tag: "li", children: [{ type: "text", text: "項目" }] } });
  input.components.push({ ...box("photo", []), root: { type: "element", id: "n1", tag: "img", attrs: { src: "/photo.jpg", alt: "風景" }, children: [] } });
  const components = parseComponentLibrary(input);
  const parse = (body) => parsePageDocument(page(body), {}, { components });
  const list = (child) => [{ type: "element", id: "list", tag: "ul", children: [child] }];
  assert.doesNotThrow(() => parse(list(instance("item1", "item"))));
  rejects(() => parse(list(instance("card1", "card"))), /^\$\.body\[0\]\.children\[0\]: invalid HTML content nesting$/);
  rejects(() => parse([{ type: "element", id: "para", tag: "p", children: [instance("item1", "item")] }]), /^\$\.body\[0\]\.children\[0\]: invalid HTML content nesting$/);
  assert.doesNotThrow(() => parse([{ type: "element", id: "para", tag: "p", children: [instance("badge1", "badge")] }]));
  rejects(() => parse([{ type: "element", id: "more", tag: "a", attrs: { href: "/" }, children: [instance("nav1", "navbar")] }]), /^\$\.body\[0\]\.children\[0\]: invalid HTML content nesting$/);
  const source = { type: "element", id: "avif", tag: "source", attrs: { srcSet: "/photo.avif", type: "image/avif" }, children: [] };
  assert.doesNotThrow(() => parse([{ type: "element", id: "picture", tag: "picture", children: [source, instance("photo1", "photo")] }]));
  rejects(() => parse([{ type: "element", id: "picture", tag: "picture", children: [instance("photo1", "photo"), source] }]), /^\$\.body\[0\]\.children: picture requires/);
  const nestedLink = { ...library(), components: [{ ...box("inner", []), root: { type: "element", id: "n1", tag: "span", children: [{ type: "element", id: "n2", tag: "a", attrs: { href: "/" }, children: [] }] } }] };
  const linkComponents = parseComponentLibrary(nestedLink);
  rejects(() => parsePageDocument(page([{ type: "element", id: "more", tag: "a", attrs: { href: "/" }, children: [instance("i1", "inner")] }]), {}, { components: linkComponents }),
    /^\$\.resolved\.body\[0\]\.children\[0\]\.children\[0\]: invalid HTML content nesting$/);
});

test("resolution renames IDs, applies overrides and styles, merges tokens and reports origins", () => {
  const document = page([instance("nav1", "navbar", {
    props: { aboutLabel: "会社紹介", aboutHref: "/company", removed: "保持" },
    style: { base: { gap: 8, padding: 4 }, responsive: [{ minWidth: 768, declarations: { padding: 8 } }, { minWidth: 1024, declarations: { gap: 32 } }] }
  })]);
  document.tokens.accent = { type: "color", value: "#000000" };
  const { document: result, origins } = resolvePageDocument(document, library());
  const nav = result.body[0];
  assert.equal(nav.id, "nav1");
  assert.deepEqual(nav.children.map((child) => child.id), ["nav1--n2", "nav1--n3", "nav1--n4"]);
  assert.equal(nav.children[2].children[0].id, "nav1--n4--n2");
  assert.deepEqual(nav.children[1], { type: "element", id: "nav1--n3", tag: "a", attrs: { href: "/company" }, children: [{ type: "text", text: "会社紹介" }] });
  assert.deepEqual(nav.children[2].children[0].children, [{ type: "text", text: "新着" }]);
  assert.deepEqual(nav.style, { base: { display: "flex", gap: 8, padding: 4 }, responsive: [{ minWidth: 768, declarations: { gap: 24, padding: 8 } }, { minWidth: 1024, declarations: { gap: 32 } }] });
  assert.deepEqual(result.tokens, { ...library().tokens, ...fixture.tokens, accent: { type: "color", value: "#000000" } });
  assert.ok(!JSON.stringify(result).includes('"instance"'));
  assert.deepEqual(result.body.slice(1), parsePageDocument(fixture).body);
  const css = generatePageCss(result);
  assert.ok(css.includes("--nw-accent:#000000;")); assert.ok(css.includes("--nw-gap:12px;"));
  assert.ok(css.includes('[data-nw-node="nav1--n4"]{color:var(--nw-accent);}'));
  assert.ok(css.includes('@media (min-width:1024px){') && css.includes('[data-nw-node="nav1"]{gap:32px;}'));
  assert.deepEqual(origins.get("nav1"), { instance: "nav1", component: "navbar", node: "n1", chain: ["nav1"] });
  assert.deepEqual(origins.get("nav1--n3"), { instance: "nav1", component: "navbar", node: "n3", chain: ["nav1"] });
  assert.deepEqual(origins.get("nav1--n4"), { instance: "nav1", component: "badge", node: "n1", chain: ["nav1", "n4"] });
  assert.deepEqual(origins.get("nav1--n4--n2"), { instance: "nav1", component: "badge", node: "n2", chain: ["nav1", "n4"] });
  assert.deepEqual([...origins.keys()], ["nav1", "nav1--n2", "nav1--n3", "nav1--n4", "nav1--n4--n2"]);
  const empty = resolved(page([instance("nav1", "navbar", { props: { aboutLabel: "" } })]));
  assert.deepEqual(empty.body[0].children[1].children, []);
  const image = resolved(page([instance("card1", "card", { props: { image: "https://example.com/card.avif", alt: "カードの写真" } })]));
  assert.deepEqual(image.body[0].children[0].attrs, { src: "https://example.com/card.avif", alt: "カードの写真" });
});

test("resolution rejects duplicated HTML IDs and long or colliding resolved IDs and is deterministic", () => {
  const withHtmlId = library(); withHtmlId.components[0].root.attrs.id = "site-nav";
  const components = parseComponentLibrary(withHtmlId);
  assert.doesNotThrow(() => parsePageDocument(page([instance("nav1", "navbar")]), {}, { components }));
  const twice = page([instance("nav1", "navbar"), instance("nav2", "navbar")]);
  rejects(() => parsePageDocument(twice, {}, { components }), /^\$\.resolved\.body\[1\]\.attrs\.id: duplicate HTML ID$/);
  rejects(() => resolvePageDocument(twice, withHtmlId), /^\$\.resolved\.body\[1\]\.attrs\.id: duplicate HTML ID$/);
  const plain = parseComponentLibrary(library());
  rejects(() => parsePageDocument(page([instance(`n${"x".repeat(78)}`, "navbar")]), {}, { components: plain }), /^\$\.resolved\.body\[0\]\.children\[0\]\.id: invalid string$/);
  rejects(() => parsePageDocument(page([instance("nav1", "navbar"), { type: "element", id: "nav1--n2", tag: "div", children: [] }]), {}, { components: plain }),
    /^\$\.resolved\.body\[1\]\.id: duplicate node ID$/);
  const input = page([instance("nav1", "navbar", { props: { aboutLabel: "会社" } })]);
  const first = resolvePageDocument(input, library()), second = resolvePageDocument(structuredClone(input), library());
  assert.deepEqual(first.document, second.document);
  assert.deepEqual([...first.origins], [...second.origins]);
  assert.equal(renderPageToHtml(first.document), renderPageToHtml(second.document));
  assert.equal(generatePageCss(first.document), generatePageCss(second.document));
});

test("componentUsage counts nested instances and componentIssues lists stale page values", () => {
  const input = library();
  input.components.push(box("footer", [instance("n2", "badge"), instance("n3", "badge", { props: { gone: "以前の値" } })]));
  const components = parseComponentLibrary(input);
  const document = parsePageDocument(page([
    instance("nav1", "navbar", { props: { aboutLabel: "会社", removed: "y", old: "z" } }), instance("nav2", "navbar"), instance("foot", "footer"), instance("b1", "badge")
  ]), {}, { components });
  assert.deepEqual(componentUsage(document, components), { navbar: 2, badge: 5, footer: 1 });
  assert.deepEqual(componentIssues(document, components), [{ nodeId: "nav1", component: "navbar", staleProps: ["removed", "old"] }]);
  assert.deepEqual(componentUsage(parsePageDocument(fixture), components), {});
  assert.deepEqual(componentIssues(parsePageDocument(fixture), components), []);
});

test("acceptance: one master update reaches every using page, overrides persist and detached copies stop following", () => {
  const components = parseComponentLibrary(library());
  const home = parsePageDocument(page([instance("nav1", "navbar", { props: { aboutLabel: "私たちについて" } })], "home"), {}, { components });
  const news = parsePageDocument(page([instance("nav1", "navbar")], "news"), {}, { components });
  const output = (document, library) => { const result = resolved(document, library); return { html: renderPageToHtml(result), css: generatePageCss(result) }; };
  const editMaster = (library, value) => {
    let master = componentDocument(library, "navbar", "ja");
    master = editDocument(master, { type: "text", path: [0, 0, 0], value }, {}, [], library);
    master = editDocument(master, { type: "style", path: [0], breakpoint: "base", property: "backgroundColor", value: "#f5f5f5" }, {}, [], library);
    return withComponentDocument(library, "navbar", master);
  };
  const updated = editMaster(components, "トップ");
  for (const document of [home, news]) {
    const before = output(document, components), after = output(document, updated);
    assert.ok(before.html.includes(">ホーム</a>") && !before.html.includes("トップ"));
    assert.ok(after.html.includes(">トップ</a>") && !after.html.includes(">ホーム</a>"));
    assert.ok(!before.css.includes("background-color:#f5f5f5;") && after.css.includes("background-color:#f5f5f5;"));
  }
  assert.ok(output(home, updated).html.includes(">私たちについて</a>"));
  assert.ok(output(news, updated).html.includes(">紹介</a>"));
  const detached = editDocument(news, { type: "detach", path: [0] }, {}, [], updated);
  assert.equal(detached.body[0].type, "element"); assert.equal(detached.body[0].id, "nav1");
  assert.deepEqual(detached.body[0].style.base, { display: "flex", gap: 12, backgroundColor: "#f5f5f5" });
  assert.deepEqual(componentUsage(detached, updated), { badge: 1 });
  assert.ok(!JSON.stringify(detached).includes('"navbar"'));
  const detachedOutput = output(detached, updated);
  assert.ok(detachedOutput.html.includes(">トップ</a>") && detachedOutput.css.includes("background-color:#f5f5f5;"));
  const again = editMaster(updated, "ホームへ");
  assert.ok(output(home, again).html.includes(">ホームへ</a>"));
  assert.deepEqual(output(detached, again), detachedOutput);
  assert.deepEqual(bumpChangedComponentVersions(again, components).components.map(({ id, version }) => [id, version]), [["navbar", 2], ["badge", 1], ["card", 1]]);
});

test("renderers reject unresolved drafts and documents without instances are unchanged by a library", () => {
  const draft = page([instance("nav1", "navbar")]);
  for (const action of [() => renderPageToHtml(draft), () => renderToString(createElement(PageRenderer, { document: draft })), () => generatePageCss(draft)]) {
    rejects(action, /^\$\.body\[0\]: component instance requires a component library$/);
  }
  const empty = { schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [] };
  const plain = parsePageDocument(fixture), withEmpty = parsePageDocument(fixture, {}, { components: parseComponentLibrary(empty) });
  assert.deepEqual(withEmpty, plain);
  assert.equal(renderPageToHtml(withEmpty), renderPageToHtml(fixture));
  assert.equal(generatePageCss(withEmpty), generatePageCss(fixture));
  for (const components of [empty, library(), undefined]) {
    const result = resolvePageDocument(fixture, components);
    assert.deepEqual(result.document, plain); assert.equal(result.origins.size, 0);
    assert.equal(renderPageToHtml(result.document), renderPageToHtml(fixture));
  }
  rejects(() => resolvePageDocument(draft, undefined), /^\$\.body\[0\]: component instance requires a component library$/);
  rejects(() => resolvePageDocument(draft, { ...library(), siteId: "other" }), /^\$\.siteId: component library belongs to another site$/);
  rejects(() => resolvePageDocument(draft, { ...library(), extra: true }), /^\$: unknown field$/);
});

test("editor operations set instance values, style instances, duplicate, move and detach through the library", () => {
  const components = parseComponentLibrary(library());
  const original = parsePageDocument(page([{ type: "element", id: "wrap", tag: "section", children: [instance("nav1", "navbar")] }]), {}, { components });
  let next = editDocument(original, { type: "instanceProp", path: [0, 0], name: "aboutLabel", value: "会社" }, {}, [], components);
  assert.deepEqual(next.body[0].children[0].props, { aboutLabel: "会社" });
  next = editDocument(next, { type: "instanceProp", path: [0, 0], name: "aboutLabel", value: undefined }, {}, [], components);
  assert.equal(Object.hasOwn(next.body[0].children[0], "props"), false);
  assert.throws(() => editDocument(next, { type: "instanceProp", path: [0], name: "aboutLabel", value: "x" }, {}, [], components), /部品のインスタンスを選択してください/);
  rejects(() => editDocument(next, { type: "instanceProp", path: [0, 0], name: "aboutHref", value: "javascript:alert(1)" }, {}, [], components), /props\.aboutHref: unsafe URL/);
  rejects(() => editDocument(original, { type: "title", value: "ライブラリなし" }), /component instance requires a component library/);
  next = editDocument(next, { type: "style", path: [0, 0], breakpoint: "base", property: "padding", value: 8 }, {}, [], components);
  next = editDocument(next, { type: "style", path: [0, 0], breakpoint: 1024, property: "color", value: { token: "accent" } }, {}, [], components);
  assert.deepEqual(next.body[0].children[0].style, { base: { padding: 8 }, responsive: [{ minWidth: 1024, declarations: { color: { token: "accent" } } }] });
  assert.deepEqual(resolved(next).body[0].children[0].style.base, { display: "flex", gap: { token: "gap" }, padding: 8 });
  const duplicated = editDocument(next, { type: "duplicate", path: [0] }, {}, [], components);
  assert.equal(duplicated.body[1].id, "wrap_copy1"); assert.equal(duplicated.body[1].children[0].id, "nav1_copy1");
  assert.equal(find(resolved(duplicated).body, "nav1_copy1--n3").children[0].text, "紹介");
  const moved = editDocument(next, { type: "move", path: [0, 0], parentId: null, index: 0 }, {}, [], components);
  assert.equal(moved.body[0].type, "instance"); assert.deepEqual(moved.body[1].children, []);
  assert.equal(editDocument(moved, { type: "remove", path: [0] }, {}, [], components).body[0].id, "wrap");
  const placed = editDocument(parsePageDocument(fixture), { type: "add", parentId: "hero", node: instance("badge1", "badge", { props: { label: "注目" } }) }, {}, [], components);
  assert.equal(find(resolved(placed).body, "badge1--n2").children[0].text, "注目");
  assert.throws(() => editDocument(next, { type: "detach", path: [0, 0] }), /部品ライブラリを読み込めていません/);
  assert.throws(() => editDocument(next, { type: "detach", path: [0] }, {}, [], components), /部品のインスタンスを選択してください/);
  const colliding = parsePageDocument(page([instance("nav1", "navbar", { props: { aboutLabel: "会社" }, style: { base: { padding: 4 } } }), { type: "element", id: "n3", tag: "div", children: [] }]), {}, { components });
  const detached = detachInstance(colliding, [0], components);
  assert.deepEqual(detached.body[0].children.map((child) => child.id), ["n2", "n3_copy1", "n4"]);
  assert.deepEqual(detached.body[0].children[1].children, [{ type: "text", text: "会社" }]);
  assert.deepEqual(detached.body[0].children[2], { type: "instance", id: "n4", component: "badge", props: { label: "新着" } });
  assert.deepEqual(detached.body[0].style, { base: { display: "flex", gap: 12, padding: 4 }, responsive: [{ minWidth: 768, declarations: { gap: 24 } }] });
  assert.deepEqual(detached.tokens, colliding.tokens);
  assert.equal(colliding.body[0].type, "instance");
  const pageToken = structuredClone(colliding); pageToken.tokens.gap = { type: "length", value: "2rem" };
  assert.deepEqual(detachInstance(parsePageDocument(pageToken, {}, { components }), [0], components).body[0].style.base.gap, { token: "gap" });
});

test("createComponentFromNode replaces an element with an instance, renumbers master IDs and copies tokens", () => {
  const input = structuredClone(fixture); input.body[0].attrs.id = "intro"; input.body[0].children[2].attrs.href = "#intro";
  const source = library(); source.tokens.ink = { type: "color", value: "#000000" };
  const components = parseComponentLibrary(source);
  const document = parsePageDocument(input, {}, { components });
  const created = createComponentFromNode(document, [0], components, { name: "  紹介セクション ", kind: "section" });
  assert.equal(created.componentId, "component_1");
  assert.deepEqual(created.document.body, [{ type: "instance", id: "hero", component: "component_1" }]);
  const definition = created.library.components.at(-1);
  assert.deepEqual([definition.id, definition.name, definition.kind, definition.version, Object.hasOwn(definition, "props")], ["component_1", "紹介セクション", "section", 1, false]);
  assert.deepEqual([definition.root, ...definition.root.children].map((node) => node.id), ["n1", "n2", "n3", "n4"]);
  assert.equal(definition.root.attrs.id, "intro"); assert.equal(definition.root.children[2].attrs.href, "#intro");
  assert.deepEqual(definition.root.style, fixture.body[0].style);
  assert.deepEqual(created.library.tokens, { ...source.tokens, space: fixture.tokens.space, bodyFont: fixture.tokens.bodyFont });
  const result = resolved(created.document, created.library);
  assert.equal(result.body[0].id, "hero");
  assert.ok(generatePageCss(result).includes(`[data-nw-node="hero"]{color:var(--nw-ink);`));
  assert.equal(result.tokens.ink.value, "#172d25");
  assert.ok(renderPageToHtml(result).includes(">海のそばで過ごす</h1>"));
  assert.equal(createComponentFromNode(document, [0, 1], created.library, { name: "リード", kind: "part" }).componentId, "component_2");
  assert.throws(() => createComponentFromNode(document, [0, 0, 0], components, { name: "文字", kind: "part" }), /要素を選択してください/);
  assert.throws(() => createComponentFromNode(document, [0], components, { name: " ナビゲーション", kind: "part" }), /同じ名前の部品があります/);
  assert.throws(() => createComponentFromNode(document, [0], components, { name: " ", kind: "part" }), /部品の名前/);
  assert.throws(() => createComponentFromNode(document, [0], components, { name: "ロック", kind: "part" }, {}, [{ nodeId: "lead", fields: ["children"], reason: "外部データ" }]), /データ連動値を含む要素は部品にできません/);
  rejects(() => createComponentFromNode(document, [0], components, { name: "種類", kind: "page" }), /kind: unknown component kind/);
  const nested = parsePageDocument(page([{ type: "element", id: "wrap", tag: "div", children: [instance("nav1", "navbar", { style: { base: { color: { token: "ink" } } } })] }]), {}, { components: parseComponentLibrary(library()) });
  const wrapped = createComponentFromNode(nested, [0], parseComponentLibrary(library()), { name: "外枠", kind: "section" });
  assert.deepEqual(wrapped.library.components.at(-1).root.children, [{ type: "instance", id: "n2", component: "navbar", style: { base: { color: { token: "ink" } } } }]);
  assert.deepEqual(wrapped.library.tokens.ink, fixture.tokens.ink);
  assert.deepEqual(componentUsage(wrapped.document, wrapped.library), { component_1: 1, navbar: 1, badge: 1 });
});

test("createComponentFromNode validates with site-wide styles, copies the effective tokens of the selection and keeps the page JSON page-owned", () => {
  // brand と文字スタイルは選択範囲の外だけ、accent は中で使う。ink は同名のページの定義がサイトの定義より優先される。
  const siteStyles = {
    tokens: { brand: { type: "color", value: "#336655" }, accent: { type: "color", value: "#aa5500" }, ink: { type: "color", value: "#112233" }, display: { type: "length", value: 32 } },
    textStyles: { headline: { base: { fontSize: { token: "display" } } } }
  };
  const input = structuredClone(fixture);
  input.body[0].children[0].style = { textStyle: "headline" };
  input.body[0].children[1].style = { base: { color: { token: "brand" } } };
  input.body[0].children[2].style = { base: { color: { token: "accent" }, borderColor: { token: "ink" } } };
  const document = parsePageDocument(input, {}, { siteStyles }), empty = parseComponentLibrary({ ...library(), tokens: {}, components: [] });
  rejects(() => createComponentFromNode(document, [0, 2], empty, { name: "リンク", kind: "part" }), /unknown token/);
  const created = createComponentFromNode(document, [0, 2], empty, { name: "リンク", kind: "part" }, {}, [], siteStyles);
  assert.deepEqual(created.document.body[0].children[2], { type: "instance", id: "link", component: "component_1" });
  assert.deepEqual(created.document.body[0].children.slice(0, 2), document.body[0].children.slice(0, 2));
  assert.deepEqual([created.document.tokens, Object.hasOwn(created.document, "textStyles")], [fixture.tokens, false], "site-wide definitions are not written back to the page");
  assert.deepEqual(created.library.tokens, { accent: siteStyles.tokens.accent, ink: fixture.tokens.ink });
  rejects(() => parsePageDocument(created.document, {}, { components: created.library }), /children\[0\]\.style\.textStyle: unknown text style/);
  // ページではページ・サイトの定義がライブラリの写しより優先されるため、インスタンスはサイトの後の変更に追従する。
  const changed = { ...siteStyles, tokens: { ...siteStyles.tokens, accent: { type: "color", value: "#0055aa" } } };
  const result = resolvePageDocument(created.document, created.library, {}, changed).document;
  assert.deepEqual([result.tokens.accent.value, result.tokens.ink.value], ["#0055aa", fixture.tokens.ink.value]);
  assert.ok(generatePageCss(result).includes('[data-nw-node="link"]{border-color:var(--nw-ink);color:var(--nw-accent);}'));
  // ライブラリにある同名の定義は上書きしない。
  assert.deepEqual(createComponentFromNode(document, [0, 2], parseComponentLibrary(library()), { name: "リンク", kind: "part" }, {}, [], siteStyles).library.tokens.accent, library().tokens.accent);
});

test("master documents write back roots and tokens but keep public prop targets and reject cycles", () => {
  const components = parseComponentLibrary(library());
  const master = componentDocument(components, "navbar", "ja");
  assert.deepEqual(master, { schemaVersion: 1, siteId: "demo", pageId: "component", locale: "ja", revision: 1, title: "ナビゲーション", tokens: components.tokens, body: [components.components[0].root] });
  master.body[0].children[0].children[0].text = "変更"; master.tokens.gap.value = 1;
  assert.equal(components.components[0].root.children[0].children[0].text, "ホーム"); assert.equal(components.tokens.gap.value, 12);
  const edit = (operation, id = "navbar") => editDocument(componentDocument(components, id, "ja"), operation, {}, [], components);
  assert.throws(() => withComponentDocument(components, "navbar", edit({ type: "remove", path: [0, 1] })), /ページごとの値に使っている要素は削除・変更できません。先にページごとの値を解除してください。/);
  assert.throws(() => withComponentDocument(components, "navbar", edit({ type: "add", parentId: "n3", node: { type: "element", id: "extra", tag: "span", children: [] } })), /ページごとの値に使っている要素/);
  assert.doesNotThrow(() => withComponentDocument(components, "navbar", edit({ type: "remove", path: [0, 0] })));
  const twoRoots = componentDocument(components, "navbar", "ja"); twoRoots.body.push({ type: "element", id: "x", tag: "div", children: [] });
  assert.throws(() => withComponentDocument(components, "navbar", twoRoots), /部品には外枠の要素が1つだけ必要です/);
  assert.throws(() => withComponentDocument(components, "navbar", { ...twoRoots, body: [{ type: "text", text: "文字" }] }), /外枠の要素が1つだけ/);
  rejects(() => withComponentDocument(components, "badge", edit({ type: "add", parentId: "n1", node: instance("again", "badge") }, "badge")), /^\$\.components\[1\]: circular component reference$/);
  const recolored = componentDocument(components, "badge", "ja"); recolored.tokens.accent = { type: "color", value: "#123456" };
  assert.equal(withComponentDocument(components, "badge", recolored).tokens.accent.value, "#123456");
  assert.throws(() => componentDocument(components, "missing", "ja"), /部品が見つかりません/);
});

test("library operations keep names unique, protect referenced components and manage public props", () => {
  const components = parseComponentLibrary(library());
  assert.equal(renameComponent(components, "navbar", "  メインナビ ").components[0].name, "メインナビ");
  assert.throws(() => renameComponent(components, "navbar", "バッジ "), /同じ名前の部品があります/);
  assert.doesNotThrow(() => renameComponent(components, "navbar", "ナビゲーション"));
  assert.throws(() => renameComponent(components, "missing", "名前"), /部品が見つかりません/);
  assert.equal(setComponentKind(components, "navbar", "header").components[0].kind, "header");
  rejects(() => setComponentKind(components, "navbar", "page"), /kind: unknown component kind/);
  const first = duplicateComponent(components, "navbar"), copy = first.library.components.at(-1);
  assert.equal(first.componentId, "component_1");
  assert.deepEqual({ ...copy, id: "navbar", name: "ナビゲーション" }, components.components[0]);
  assert.equal(copy.name, "ナビゲーション のコピー"); assert.equal(copy.version, 1);
  const second = duplicateComponent(first.library, "navbar");
  assert.equal(second.componentId, "component_2"); assert.equal(second.library.components.at(-1).name, "ナビゲーション のコピー 2");
  const longName = duplicateComponent(renameComponent(components, "card", "長".repeat(COMPONENT_LIMITS.nameLength)), "card").library.components.at(-1).name;
  assert.equal(longName.length, COMPONENT_LIMITS.nameLength); assert.ok(longName.endsWith(" のコピー"));
  assert.throws(() => removeComponent(components, "badge"), /他の部品から使われているため削除できません/);
  const withoutNavbar = removeComponent(components, "navbar");
  assert.deepEqual(withoutNavbar.components.map((component) => component.id), ["badge", "card"]);
  assert.deepEqual(removeComponent(withoutNavbar, "badge").components.map((component) => component.id), ["card"]);
  const definition = { label: "ホームの文字", node: "n2", field: "text" }, exposed = setComponentProp(components, "navbar", "homeLabel", definition);
  assert.deepEqual(exposed.components[0].props.homeLabel, definition);
  definition.label = "changed"; assert.equal(exposed.components[0].props.homeLabel.label, "ホームの文字");
  rejects(() => setComponentProp(components, "navbar", "homeLabel", { ...definition, extra: true }), /props\.homeLabel: unknown field/);
  assert.deepEqual(Object.keys(setComponentProp(components, "navbar", "aboutLabel", { label: "紹介", node: "n3", field: "text" }).components[0].props), ["aboutLabel", "aboutHref"]);
  rejects(() => setComponentProp(components, "navbar", "bad", { label: "値", node: "n1", field: "href" }), /props\.bad\.field: prop field does not fit/);
  rejects(() => setComponentProp(components, "navbar", "__proto__", { label: "値", node: "n2", field: "text" }), /props: invalid identifier/);
  assert.equal({}.label, undefined);
  const hidden = setComponentProp(setComponentProp(components, "badge", "label", undefined), "badge", "label", undefined);
  assert.equal(Object.hasOwn(hidden.components[1], "props"), false);
  const document = parsePageDocument(page([instance("b1", "badge", { props: { label: "注目" } })]), {}, { components: hidden });
  assert.deepEqual(componentIssues(document, hidden), [{ nodeId: "b1", component: "badge", staleProps: ["label"] }]);
  assert.equal(find(resolved(document, hidden).body, "b1--n2").children[0].text, "NEW");
  assert.equal(find(resolved(document, components).body, "b1--n2").children[0].text, "注目");
});

test("bumpChangedComponentVersions increments only definitions that differ from the saved library", () => {
  const saved = parseComponentLibrary(library()); saved.components[1].version = 5;
  const master = editDocument(componentDocument(saved, "navbar", "ja"), { type: "text", path: [0, 0, 0], value: "トップ" }, {}, [], saved);
  const edited = duplicateComponent(withComponentDocument(saved, "navbar", master), "card").library;
  edited.components[2].version = 9;
  const bumped = bumpChangedComponentVersions(edited, saved);
  assert.deepEqual(bumped.components.map(({ id, version }) => [id, version]), [["navbar", 2], ["badge", 5], ["card", 1], ["component_1", 1]]);
  assert.equal(edited.components[0].version, 1);
  assert.deepEqual(bumpChangedComponentVersions(edited, undefined).components.map(({ version }) => version), [1, 5, 9, 1]);
});

test("release plans bind the component library version", () => {
  const request = { target: { siteId: "demo", pageId: "home", locale: "ja-JP" }, expectedVersion: "v2", action: "publish", componentsVersion: "lib-3" };
  const plan = { ...request, domain: "https://example.com", confirmationToken: "one-use-token", changes: [] };
  const site = { id: "demo", name: "Demo", domains: ["https://example.com"] };
  const { componentsVersion: _planVersion, ...planWithout } = plan, { componentsVersion: _requestVersion, ...requestWithout } = request;
  assert.doesNotThrow(() => validateReleasePlan(plan, request, site));
  assert.doesNotThrow(() => validateReleasePlan(planWithout, requestWithout, site));
  for (const [invalid, basis] of [[{ ...plan, componentsVersion: "lib-2" }, request], [planWithout, request], [plan, requestWithout]]) {
    assert.throws(() => validateReleasePlan(invalid, basis, site), /一致しません/);
  }
});

test("project editor forwards the component adapter for its own site only and passes componentsVersion", async () => {
  const project = { id: "project_demo", name: "デモ計画", site: { id: "demo", name: "デモサイト", domains: ["https://example.test"] }, members: [] };
  const signal = new AbortController().signal, target = { siteId: "demo", pageId: "home", locale: "ja-JP" };
  const calls = { reads: [], saves: [], usage: [], prepares: [], releases: [] };
  let stored = library(), usage = [{ target, title: "ホーム", role: "page", components: { navbar: 1, badge: 1 } }];
  const base = {
    listSites: async () => [project.site], listPages: async () => [], readDocument: async () => ({ document: fixture, version: "v1" }),
    saveDraft: async () => ({ status: "saved", version: "v2", revision: 2 }),
    prepareRelease: async (request) => { calls.prepares.push(structuredClone(request)); return { ...request, confirmationToken: "token", domain: "https://example.test", changes: [] }; },
    release: async (request) => { calls.releases.push(structuredClone(request)); return { status: "conflict" }; }
  };
  const components = {
    readLibrary: async (siteId) => { calls.reads.push(siteId); return { library: stored, version: "lib-1" }; },
    saveLibrary: async (request) => { calls.saves.push(structuredClone(request)); return { status: "saved", version: "lib-2", revision: 2 }; },
    listUsage: async (siteId) => { calls.usage.push(siteId); return usage; }
  };
  assert.equal("components" in createProjectEditorAdapter(base, project), false);
  const editor = createProjectEditorAdapter({ ...base, components }, project), wrapped = editor.components;
  assert.deepEqual(await wrapped.readLibrary("demo", signal), { library: library(), version: "lib-1" });
  await assert.rejects(() => wrapped.readLibrary("other", signal), /プロジェクト外/);
  await assert.rejects(() => wrapped.listUsage("other", signal), /プロジェクト外/);
  assert.deepEqual(calls.reads, ["demo"]); assert.deepEqual(calls.usage, []);
  stored = { ...library(), siteId: "other" };
  await assert.rejects(() => wrapped.readLibrary("demo", signal), /部品ライブラリの対象サイトが一致しません/);
  stored = "library";
  await assert.rejects(() => wrapped.readLibrary("demo", signal), DocumentValidationError);
  const parsed = parseComponentLibrary(library());
  await assert.rejects(() => wrapped.saveLibrary({ siteId: "other", library: parsed, expectedVersion: "lib-1" }, signal), /プロジェクト外/);
  await assert.rejects(() => wrapped.saveLibrary({ siteId: "demo", library: { ...parsed, siteId: "other" }, expectedVersion: "lib-1" }, signal), /部品ライブラリの対象サイトが一致しません/);
  assert.equal(calls.saves.length, 0);
  assert.deepEqual(await wrapped.saveLibrary({ siteId: "demo", library: parsed, expectedVersion: "lib-1", ignored: true }, signal), { status: "saved", version: "lib-2", revision: 2 });
  assert.deepEqual(Object.keys(calls.saves[0]).sort(), ["expectedVersion", "library", "siteId"]);
  assert.deepEqual(calls.saves[0].library, parsed);
  assert.deepEqual(await wrapped.listUsage("demo", signal), usage);
  usage = [...usage, { target: { siteId: "other", pageId: "home", locale: "ja-JP" }, title: "別サイト", components: {} }];
  await assert.rejects(() => wrapped.listUsage("demo", signal), /使用状況に別サイトの項目が含まれています/);
  const plan = await editor.prepareRelease({ target, expectedVersion: "v1", action: "publish", componentsVersion: "lib-1" }, signal);
  assert.equal(calls.prepares[0].componentsVersion, "lib-1"); assert.equal(plan.componentsVersion, "lib-1");
  assert.deepEqual(await editor.release(plan, signal), { status: "conflict" });
  assert.equal(calls.releases[0].componentsVersion, "lib-1");
  await editor.prepareRelease({ target, expectedVersion: "v1", action: "publish" }, signal);
  assert.equal(Object.hasOwn(calls.prepares[1], "componentsVersion"), false);
  const tampered = createProjectEditorAdapter({ ...base, prepareRelease: async (request) => ({ ...request, componentsVersion: "lib-0", confirmationToken: "token", domain: "https://example.test", changes: [] }) }, project);
  await assert.rejects(() => tampered.prepareRelease({ target, expectedVersion: "v1", action: "publish", componentsVersion: "lib-1" }, signal), /一致/);
});
