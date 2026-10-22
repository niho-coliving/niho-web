import assert from "node:assert/strict";
import { test } from "node:test";
import { cssForSitePresentation, initializeSitePresentation, parsePageDocument, parseSitePresentation, presentationAssetDocument } from "@niho/web/core";
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
const siteWithMenu = (siteId = "synthetic", locale = "en") => {
  const presentation = site(siteId, locale);
  presentation.shared.header.body[0].children.push({ type: "element", id: "menu-trigger-node", tag: "a", attrs: { id: "menu-trigger", href: "#site-menu" }, children: [{ type: "text", text: "Menu" }] });
  presentation.overlays = [{ id: "site-menu", label: "Site menu", triggerIds: ["menu-trigger"], closeIds: ["menu-close"], document:
    page(siteId, locale, "shared-menu", [{ type: "element", id: "menu-panel", tag: "nav", children: [
      { type: "element", id: "menu-first", tag: "a", attrs: { href: "/one" }, children: [{ type: "text", text: "First menu item" }] },
      { type: "element", id: "menu-close-node", tag: "a", attrs: { id: "menu-close", href: "#site-menu" }, children: [{ type: "text", text: "Close" }] },
    ] }]) }];
  return presentation;
};

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

test("generic second-site overlay renders hidden, substitutes its canonical document and collects it once", () => {
  const document = page("second-site", "fr", "body", [element("body-copy", "p", "Second body")]);
  const presentation = parseSitePresentation(siteWithMenu("second-site", "fr"), document);
  const html = renderSitePageToHtml(document, presentation);
  assert.match(html, /id="site-menu"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*hidden=""/);
  assert.match(html, /id="menu-trigger"[^>]*aria-controls="site-menu"[^>]*aria-expanded="false"[^>]*data-nw-overlay-open="site-menu"/);
  assert.match(html, /id="menu-close"[^>]*data-nw-overlay-close="site-menu"/);
  assert.equal((html.match(/First menu item/g) ?? []).length, 1);
  const edited = page("second-site", "fr", "shared-menu", [element("edited-menu", "nav", "Edited menu")]);
  const editedHtml = renderSitePageToHtml(edited, presentation);
  assert.equal((editedHtml.match(/Edited menu/g) ?? []).length, 1);
  assert.equal(editedHtml.includes("First menu item"), false);
  assert.match(editedHtml, /data-nw-overlay-editing=""/);
  const assets = presentationAssetDocument(edited, presentation);
  assert.equal(assets.body.filter((node) => node.id === "edited-menu").length, 1);
  assert.equal(assets.body.some((node) => node.id === "menu-panel"), false);
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
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].id = "bad target"; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].document.siteId = "foreign"; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].document.pageId = "shared-header"; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].closeIds = ["menu-trigger"]; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays.push({ ...structuredClone(input.overlays[0]), id: "menu-trigger", document: { ...input.overlays[0].document, pageId: "second-menu" }, triggerIds: ["second-trigger"], closeIds: ["second-close"] }); });
  reject((input) => { input.overlays = Array.from({ length: 9 }, (_, index) => ({ ...siteWithMenu().overlays[0], id: `menu-${index}`, document: { ...siteWithMenu().overlays[0].document, pageId: `menu-page-${index}` }, triggerIds: [`trigger-${index}`], closeIds: [`close-${index}`] })); });
});

test("trusted overlay runtime opens, traps focus, closes and fully cleans up", () => {
  const document = page("synthetic", "en", "body", []), html = renderSitePageToHtml(document, siteWithMenu());
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  const root = dom.window.document, toggle = root.getElementById("menu-trigger"), overlay = root.getElementById("site-menu"), closeControl = root.getElementById("menu-close");
  const cleanup = initializeSitePresentation(root);
  root.documentElement.style.overflow = "clip";
  root.documentElement.style.scrollbarGutter = "auto";
  overlay.querySelector("nav").insertAdjacentHTML("afterbegin", '<a href="/hidden" style="display:none">Invisible item</a>');
  toggle.focus(); toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  toggle.click();
  assert.equal(overlay.hidden, false); assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(root.documentElement.style.overflow, "hidden");
  assert.equal(root.activeElement.textContent, "First menu item", "focus starts at a visible content control");
  toggle.focus(); root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
  assert.equal(root.activeElement.textContent, "First menu item", "focus cannot escape the dialog");
  closeControl.focus(); closeControl.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
  assert.equal(root.activeElement.textContent, "First menu item", "Tab wraps to the first content control");
  root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  assert.equal(overlay.hidden, true); assert.equal(toggle.getAttribute("aria-expanded"), "false"); assert.equal(root.activeElement, toggle); assert.equal(root.documentElement.style.overflow, "clip");
  toggle.click(); assert.equal(overlay.hidden, false);
  const navigation = root.querySelector('[data-nw-node="menu-panel"]').querySelector('a[href="/one"]');
  const event = new dom.window.Event("click", { bubbles: true, cancelable: true });
  navigation.dispatchEvent(event); assert.equal(overlay.hidden, true); assert.equal(event.defaultPrevented, false);
  toggle.click();
  const previewClick = new dom.window.Event("click", { bubbles: true, cancelable: true });
  previewClick.preventDefault(); navigation.dispatchEvent(previewClick);
  assert.equal(overlay.hidden, true); assert.equal(root.activeElement, toggle, "blocked preview navigation returns focus to the opener");
  toggle.click(); assert.equal(overlay.hidden, false); cleanup();
  assert.equal(overlay.hidden, true); assert.equal(root.documentElement.style.overflow, "clip");
  assert.equal(root.documentElement.style.scrollbarGutter, "auto");
  toggle.click(); assert.equal(overlay.hidden, true, "cleanup removes control listeners");
  dom.window.close();
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
