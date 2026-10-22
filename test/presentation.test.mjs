import assert from "node:assert/strict";
import { test } from "node:test";
import { cssForSitePresentation, parsePageDocument, parseSitePresentation, presentationAssetDocument } from "@niho/web/core";
import { renderSitePageToHtml } from "@niho/web/server";
import { JSDOM } from "jsdom";

const element = (id, tag, text, style) => ({ type: "element", id, tag, ...(style ? { style } : {}), children: text === undefined ? [] : [{ type: "text", text }] });
const page = (siteId, locale, pageId, body) => ({ schemaVersion: 1, siteId, pageId, locale, revision: 1, title: pageId, tokens: {}, body });
const site = (siteId = "synthetic", locale = "en") => ({
  schemaVersion: 1, siteId, locale, version: "site-v7:deps-a1", reset: "neutral-v1", tokens: {},
  layout: { base: { display: "flex", flexDirection: "column", alignItems: "center", width: "100%" } },
  fonts: [{ family: "Synthetic Sans", sources: [{ url: "https://media.example.test/fonts/synthetic.woff2", format: "woff2" }], weight: "100 900", display: "swap", unicodeRange: "U+0000-00FF" }],
  shared: {
    header: page(siteId, locale, "shared-header", [element("header-nav", "header", "Shared header")]),
    footer: page(siteId, locale, "shared-footer", [element("footer-note", "footer", "Shared footer")]),
  },
});

test("native presentation is generic and canvas/SSR share one reset, font and scoped composition", () => {
  const document = page("synthetic-two", "fr", "business", [element("body-copy", "p", "Body copy")]);
  const presentation = site("synthetic-two", "fr");
  const parsed = parseSitePresentation(presentation, document);
  const output = cssForSitePresentation(parsed, document);
  const html = renderSitePageToHtml(document, parsed);
  assert.match(output.css, /@font-face\{font-family:"Synthetic Sans"/);
  assert.match(output.css, /:where\(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,dd,figure,blockquote\)\{margin:0;padding:0\}/);
  assert.ok(html.includes(output.css));
  for (const text of ["Shared header", "Body copy", "Shared footer"]) assert.ok(html.includes(text), text);
  const owners = [...html.matchAll(/data-nw-owner="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(new Set(owners).size >= 3, "layout/header/body/footer scopes must not collide");
  assert.equal(parsed.siteId, "synthetic-two");
  const dom = new JSDOM(html);
  const root = dom.window.document.querySelector('[data-nw-node="layout"]');
  assert.equal(dom.window.getComputedStyle(root).display, "flex", "native layout must actually match its generated CSS selector");
  const slot = dom.window.document.querySelector('[data-nw-presentation-body]');
  assert.equal(dom.window.getComputedStyle(slot).display, "contents", "composition wrappers must not add authored layout boxes");
  dom.window.close();
});

test("canonical shared page is substituted only in its native slot", () => {
  const presentation = site(), edited = page("synthetic", "en", "shared-header", [element("edited-nav", "header", "Edited header")]);
  const html = renderSitePageToHtml(edited, presentation);
  assert.equal((html.match(/Edited header/g) ?? []).length, 1);
  assert.equal(html.includes("Body copy"), false);
  assert.ok(html.includes("Shared footer"));
});

test("presentation schema rejects hostile resources, mismatched targets, extras and unbounded input", () => {
  const document = page("synthetic", "en", "body", []);
  const reject = (mutate) => { const input = structuredClone(site()); mutate(input); assert.throws(() => parseSitePresentation(input, document)); };
  reject((input) => { input.fonts[0].sources[0].url = "javascript:alert(1)"; });
  reject((input) => { input.fonts[0].sources[0].url = "http://media.example.test/font.woff2"; });
  reject((input) => { input.fonts[0].sources[0].format = "truetype"; });
  reject((input) => { input.fonts[0].unicodeRange = "U+0000-00FF;src:url(x)"; });
  reject((input) => { input.fonts[0].script = "alert(1)"; });
  reject((input) => { input.fonts[0].weight = "900 100"; });
  reject((input) => { input.shared.header.siteId = "other"; });
  reject((input) => { input.shared.footer.pageId = "shared-header"; });
  reject((input) => { input.siteId = "other"; });
  reject((input) => { input.fonts = Array.from({ length: 513 }, () => input.fonts[0]); });
});

test("background asset references remain native through parse, asset collection and render", () => {
  const backgroundImage = { asset: { provider: "synthetic-assets", id: "hero" } };
  const document = page("synthetic", "en", "business", [element("hero", "section", undefined, { base: { width: "100%", height: "5px", backgroundImage } })]);
  const parsed = parsePageDocument(document), presentation = parseSitePresentation(site(), parsed);
  const merged = presentationAssetDocument(parsed, presentation);
  assert.deepEqual(parsed.body[0].style.base.backgroundImage, backgroundImage);
  assert.deepEqual(merged.body.find((node) => node.id === "hero").style.base.backgroundImage, backgroundImage);
  const html = renderSitePageToHtml(parsed, presentation, {}, { assets: { "synthetic-assets:hero": { src: "https://media.example.test/hero.webp" } } });
  for (const declaration of ["background-image:url(\"https://media.example.test/hero.webp\");", "height:5px;", "width:100%;"]) assert.ok(html.includes(declaration), declaration);
  assert.equal(html.includes("min-height:48px"), false);
});
