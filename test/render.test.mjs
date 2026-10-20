import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DocumentValidationError, pageScope, PageRenderer as RootPageRenderer } from "@niho/web";
import { PageRenderer } from "@niho/web/react";
import { renderPageToHtml } from "@niho/web/server";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

test("React server rendering and Astro HTML helper produce the same initial content", () => {
  const html = renderPageToHtml(fixture);
  assert.equal(RootPageRenderer, PageRenderer);
  assert.equal(html, renderToString(createElement(PageRenderer, { document: fixture })));
  assert.match(html, /<h1 data-nw-node="heading"[^>]*>海のそばで過ごす<\/h1>/);
  assert.ok(html.includes(`data-nw-scope="${pageScope(fixture)}" lang="ja-JP"`));
  assert.ok(html.includes("<style data-nw-style="));
  assert.ok(html.includes(`data-nw-scope="${pageScope(fixture)}"] [data-nw-owner="${pageScope(fixture)}"][data-nw-node="hero"]`));
  assert.ok(html.includes("padding:var(--nw-space)"));
});

test("text and attribute values are escaped and blank targets gain safe rel", () => {
  const doc = structuredClone(fixture);
  doc.body[0].children[0].children[0].text = "<script>alert('x')</script>&";
  doc.body[0].children[2].attrs = { href: "https://example.com/?x=1&y=2", title: '\" onclick=\"evil', target: "_blank", rel: "nofollow" };
  const html = renderPageToHtml(doc);
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("title=\"&quot; onclick=&quot;evil\""));
  assert.ok(html.includes("href=\"https://example.com/?x=1&amp;y=2\""));
  assert.ok(html.includes("rel=\"nofollow noopener noreferrer\""));
});

test("registered dynamic blocks render in initial HTML with allowlisted props only", () => {
  const doc = structuredClone(fixture); let received;
  doc.body.push({ type: "component", id: "notice", block: "PublicNotice", props: { heading: "Today's notice", href: "/about" }, style: { base: { marginTop: 24 } } });
  const blocks = { PublicNotice: { props: { heading: { type: "string", required: true }, href: { type: "url", required: true } },
    component: (props) => { received = props; return createElement("aside", null, createElement("a", { href: props.href }, props.heading)); }
  } };
  const html = renderPageToHtml(doc, blocks);
  assert.deepEqual(received, { heading: "Today's notice", href: "/about" });
  assert.match(html, /<div data-nw-node="notice"[^>]*data-nw-block="PublicNotice"><aside><a href="\/about">/);
  assert.ok(html.includes("margin-top:24px"));
  assert.ok(html.includes("Today&#x27;s notice"));
  assert.equal(html, renderToString(createElement(PageRenderer, { document: doc, blocks })));
});

test("all validation finishes before any registered block executes", () => {
  const doc = structuredClone(fixture); let called = 0;
  doc.body.unshift({ type: "component", id: "notice", block: "Notice", props: {} });
  doc.body.push({ type: "element", id: "bad", tag: "script", children: [] });
  const blocks = { Notice: { props: {}, component: () => { called++; return null; } } };
  assert.throws(() => renderPageToHtml(doc, blocks), DocumentValidationError);
  assert.equal(called, 0);
  assert.throws(() => renderPageToHtml({ ...fixture, body: [{ type: "component", id: "x", block: "Unknown", props: {} }] }), DocumentValidationError);
});

test("void media elements have accessible image attributes and no children", () => {
  const doc = structuredClone(fixture);
  doc.body = [{ type: "element", id: "picture", tag: "picture", children: [
    { type: "element", id: "avif", tag: "source", attrs: { srcSet: "/image.avif", type: "image/avif", media: "(min-width: 768px)" }, children: [] },
    { type: "element", id: "photo", tag: "img", attrs: { src: "/image.jpg", alt: "風景", width: 600, height: 400, loading: "lazy" }, children: [] }
  ] }];
  const html = renderPageToHtml(doc);
  assert.ok(html.includes('srcSet="/image.avif"')); assert.ok(html.includes('alt="風景"'));
  assert.ok(!html.includes("</img>"));
});

test("nested document nodes carry their own CSS owner rather than the ancestor scope", () => {
  const inner = { ...structuredClone(fixture), pageId: "inner" };
  const outer = structuredClone(fixture);
  outer.body.push({ type: "component", id: "nested", block: "NestedPage", props: {} });
  const html = renderPageToHtml(outer, { NestedPage: { props: {}, component: () => createElement(PageRenderer, { document: inner }) } });
  const outerScope = pageScope(outer), innerScope = pageScope(inner);
  assert.notEqual(outerScope, innerScope);
  assert.ok(html.includes(`data-nw-node="heading" data-nw-owner="${innerScope}"`));
  assert.ok(html.includes(`[data-nw-scope="${outerScope}"] [data-nw-owner="${outerScope}"][data-nw-node="hero"]`));
});
