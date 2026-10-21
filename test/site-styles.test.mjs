import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  detachSiteStyles, DocumentValidationError, generatePageCss, materializeSiteStyles, parsePageDocument,
  parseSiteStyleLibrary, planSiteStyleImport
} from "@niho/web/core";
import { PageRenderer } from "@niho/web/react";
import { renderPageToHtml } from "@niho/web/server";
import { parseSiteStyleLibrary as parseFromDedicatedExport } from "@niho/web/site-styles";

const page = (pageId = "home") => ({
  schemaVersion: 1, siteId: "demo", pageId, locale: "ja-JP", revision: 1, title: pageId,
  tokens: {},
  body: [{ type: "element", id: "heading", tag: "h1", style: { textStyle: "heading", base: { color: { token: "ink" } } },
    children: [{ type: "text", text: pageId }] }]
});
const library = () => ({
  schemaVersion: 1, siteId: "demo", revision: 1,
  tokens: {
    ink: { type: "color", value: "#123456" },
    size: { type: "length", value: 32 },
    unused: { type: "color", value: "#abcdef" }
  },
  textStyles: { heading: { base: { fontSize: { token: "size" } } } }
});
const reject = (action) => assert.throws(action, DocumentValidationError);

test("one explicit snapshot updates two pages while a same-name page override wins", () => {
  const first = page("first"), second = page("second"), shared = library();
  assert.equal(materializeSiteStyles(first, shared).tokens.ink.value, "#123456");
  assert.equal(materializeSiteStyles(second, shared).tokens.ink.value, "#123456");
  const updated = structuredClone(shared); updated.revision = 2; updated.tokens.ink.value = "#654321";
  assert.equal(materializeSiteStyles(first, updated).tokens.ink.value, "#654321");
  assert.equal(materializeSiteStyles(second, updated).tokens.ink.value, "#654321");
  first.tokens.ink = { type: "color", value: "#111111" };
  first.textStyles = { heading: { base: { fontSize: 20 } } };
  const overridden = materializeSiteStyles(first, updated);
  assert.equal(overridden.tokens.ink.value, "#111111");
  assert.equal(overridden.textStyles.heading.base.fontSize, 20);
  assert.equal(materializeSiteStyles(second, updated).tokens.ink.value, "#654321");
  assert.deepEqual(second.tokens, {});
  assert.equal(Object.hasOwn(second, "textStyles"), false);
});

test("React, server SSR and direct CSS use the same effective document", () => {
  const raw = page(), shared = library();
  const html = renderPageToHtml(raw, {}, { siteStyles: shared });
  assert.equal(html, renderToString(createElement(PageRenderer, { document: raw, siteStyles: shared })));
  const embedded = html.match(/<style data-nw-style="[^"]+">([^]*?)<\/style>/)?.[1];
  assert.equal(embedded, generatePageCss(raw, {}, undefined, { siteStyles: shared }));
  assert.match(html, /font-size:var\(--nw-size\)/);
  assert.match(html, /color:var\(--nw-ink\)/);
});

test("site scope, unknown fields, closed CSS schema, references and effective limits fail closed", () => {
  const shared = library(), raw = page();
  reject(() => materializeSiteStyles({ ...raw, siteId: "other" }, shared));
  reject(() => parseSiteStyleLibrary({ ...shared, secret: "no" }));
  reject(() => parseSiteStyleLibrary({ ...shared, tokens: { bad: { type: "color", value: "var(--x)" } } }));
  reject(() => parseSiteStyleLibrary({ ...shared, textStyles: { bad: { base: { color: "red" } } } }));
  reject(() => parseSiteStyleLibrary({ ...shared, textStyles: { bad: { base: { fontSize: { token: "missing" } } } } }));
  reject(() => materializeSiteStyles({ ...raw, extra: true }, shared));
  const badStyle = page(); badStyle.body[0].style.base.position = "fixed;inset:0";
  reject(() => materializeSiteStyles(badStyle, shared));
  const missing = page(); missing.body[0].style.base.color = { token: "missing" };
  reject(() => materializeSiteStyles(missing, shared));
  const many = library(); many.tokens = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`t${index}`, { type: "number", value: index }])); many.textStyles = {};
  const over = page(); over.tokens.local = { type: "number", value: 1 };
  reject(() => materializeSiteStyles(over, many));
});

test("shared text styles can reference shared tokens and parsing never mutates frozen input", () => {
  const raw = page(), shared = library();
  const freeze = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
  freeze(raw); freeze(shared);
  const parsed = parseSiteStyleLibrary(shared), effective = materializeSiteStyles(raw, shared);
  assert.deepEqual(parseFromDedicatedExport(shared), parsed);
  assert.deepEqual(parsed.textStyles.heading.base.fontSize, { token: "size" });
  assert.deepEqual(effective.textStyles.heading.base.fontSize, { token: "size" });
  assert.notEqual(parsed.tokens, shared.tokens);
  assert.notEqual(effective.body, raw.body);
  effective.tokens.ink.value = "#000000";
  assert.equal(shared.tokens.ink.value, "#123456");
});

test("detaching copies only referenced shared definitions across responsive, state and block slots", () => {
  const raw = page();
  raw.body[0].style.responsive = [{ minWidth: 768, declarations: { backgroundColor: { token: "surface" } } }];
  raw.body[0].style.states = { hover: { borderColor: { token: "ink" } } };
  raw.body.push({ type: "component", id: "card", block: "Card", props: {}, slots: {
    title: { base: { color: { token: "slot" } }, responsive: [{ minWidth: 900, declarations: { backgroundColor: { token: "surface" } } }] }
  } });
  const shared = library();
  Object.assign(shared.tokens, {
    surface: { type: "color", value: "#eeeeee" }, slot: { type: "color", value: "#225588" }, orphan: { type: "length", value: 12 }
  });
  shared.textStyles.unusedStyle = { base: { fontSize: { token: "orphan" } } };
  const blocks = { Card: { props: {}, slots: { title: { label: "見出し", style: ["color", "backgroundColor"] } } } };
  const detached = detachSiteStyles(raw, shared, blocks);
  assert.deepEqual(Object.keys(detached.tokens).sort(), ["ink", "size", "slot", "surface"]);
  assert.deepEqual(Object.keys(detached.textStyles), ["heading"]);
  assert.equal(detached.body[0].style.states.hover.borderColor.token, "ink");
  assert.equal(detached.body[1].slots.title.responsive[0].declarations.backgroundColor.token, "surface");
  const before = generatePageCss(raw, blocks, undefined, { siteStyles: shared }).replace(/--nw-(?:unused|orphan):[^;]+;/g, "");
  assert.equal(generatePageCss(detached, blocks), before);
});

test("import planning reports collisions and never overwrites the shared snapshot", () => {
  const raw = page();
  raw.tokens = {
    ink: { type: "color", value: "#000000" },
    size: { type: "length", value: 32 },
    gap: { type: "length", value: 16 }
  };
  raw.textStyles = {
    heading: { base: { fontSize: 48 } },
    card: { base: { fontSize: { token: "gap" } } }
  };
  const shared = library(), original = structuredClone(shared), plan = planSiteStyleImport(raw, shared);
  assert.deepEqual(plan.tokens, { gap: { type: "length", value: 16 } });
  assert.deepEqual(plan.textStyles, { card: { base: { fontSize: { token: "gap" } } } });
  assert.deepEqual(plan.conflicts, [{ kind: "token", name: "ink" }, { kind: "textStyle", name: "heading" }]);
  assert.deepEqual(shared, original);
});

test("legacy page parsing, CSS and SSR calls keep their previous behavior", () => {
  const raw = page();
  delete raw.body[0].style.textStyle;
  raw.tokens.ink = { type: "color", value: "#123456" };
  assert.deepEqual(parsePageDocument(raw), raw);
  assert.equal(generatePageCss(raw), generatePageCss(raw, {}, undefined));
  assert.equal(renderPageToHtml(raw), renderToString(createElement(PageRenderer, { document: raw })));
});
