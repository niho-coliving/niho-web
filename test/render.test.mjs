import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DocumentValidationError, pageScope, PageRenderer as RootPageRenderer } from "@niho/web";
import { PageRenderer } from "@niho/web/react";
import { renderPageToHtml } from "@niho/web/server";
import { generatePageCss } from "@niho/web/core";

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

const imageDocument = () => {
  const doc = structuredClone(fixture);
  doc.body[0].children.push(
    { type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "sea" }, attrs: { alt: "海" }, children: [] },
    { type: "element", id: "sized", tag: "img", asset: { provider: "uploads", id: "sea" }, attrs: { alt: "", width: 300 }, children: [] },
    { type: "element", id: "lost", tag: "img", asset: { provider: "uploads", id: "lost" }, attrs: { alt: "" }, children: [] });
  return doc;
};
const seaAssets = { "uploads:sea": { src: "/media/sea.webp", width: 1200, height: 800 } };

test("asset images render resolved URLs with intrinsic size and omit or mark unresolved assets", () => {
  const doc = imageDocument(), html = renderPageToHtml(doc, {}, { assets: seaAssets });
  assert.equal(html, renderToString(createElement(PageRenderer, { document: doc, assets: seaAssets })));
  const photo = html.match(/<img[^>]*data-nw-node="photo"[^>]*>/)?.[0], sized = html.match(/<img[^>]*data-nw-node="sized"[^>]*>/)?.[0];
  assert.ok(photo.includes('src="/media/sea.webp"')); assert.ok(photo.includes('width="1200"')); assert.ok(photo.includes('height="800"')); assert.ok(photo.includes('alt="海"'));
  assert.ok(sized.includes('width="300"')); assert.ok(!sized.includes("height="));
  assert.ok(!html.includes('data-nw-node="lost"'));
  const placeholder = renderToString(createElement(PageRenderer, { document: doc, assets: seaAssets, missingAssets: "placeholder" }));
  assert.match(placeholder, /<span data-nw-node="lost" data-nw-owner="[^"]+" data-nw-missing-asset="" role="img" aria-label="画像を表示できません"><\/span>/);
  assert.ok(!renderPageToHtml(doc).includes("<img"));
});

test("unsafe resolved asset maps throw before any block executes", () => {
  const doc = imageDocument(); let called = 0;
  doc.body.unshift({ type: "component", id: "notice", block: "Notice", props: {} });
  const blocks = { Notice: { props: {}, component: () => { called++; return null; } } };
  for (const src of ["javascript:alert(1)", "data:image/png;base64,AAAA", "http://example.com/a.png", "#x", '/a.png" onerror="x', "/a b.png", "/a<b.png"]) {
    assert.throws(() => renderPageToHtml(doc, blocks, { assets: { "uploads:sea": { src } } }), DocumentValidationError, src);
  }
  assert.throws(() => renderPageToHtml(doc, blocks, { assets: { "uploads:sea": { src: "/a.png", url: "/b.png" } } }), DocumentValidationError);
  assert.equal(called, 0);
});

test("background images compile from resolved assets and only the unresolved declaration is omitted", () => {
  const doc = structuredClone(fixture);
  doc.body[0].style.base.backgroundImage = { asset: { provider: "uploads", id: "a" } }; doc.body[0].style.base.backgroundSize = "cover";
  doc.body[0].style.responsive[0].declarations.backgroundImage = { asset: { provider: "uploads", id: "wide" } };
  const css = generatePageCss(doc, {}, { "uploads:a": { src: "/media/a.webp" } });
  assert.ok(css.includes('background-image:url("/media/a.webp");background-size:cover;'));
  assert.ok(css.includes("@media (min-width:768px)") && css.includes("max-width:64rem;"));
  assert.equal(css.match(/background-image/g).length, 1);
  assert.ok(!generatePageCss(doc).includes("background-image")); assert.ok(generatePageCss(doc).includes("background-size:cover;"));
  assert.throws(() => generatePageCss(doc, {}, { "uploads:a": { src: "javascript:alert(1)" } }), DocumentValidationError);
  assert.ok(renderPageToHtml(doc, {}, { assets: { "uploads:a": { src: "/media/a.webp" } } }).includes('background-image:url("/media/a.webp");'));
});
