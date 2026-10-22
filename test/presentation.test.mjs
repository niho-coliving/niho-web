import assert from "node:assert/strict";
import { test } from "node:test";
import { cssForSitePresentation, initializeSitePresentation, parsePageDocument, parseSitePresentation, presentationAssetDocument } from "@niho/web/core";
import { renderSitePageToHtml } from "@niho/web/server";
import { createExternalFramePolicy } from "@niho/web";
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
  assert.match(output.css, /details:not\(\[open\]\)>:not\(summary\)\{display:none!important\}/);
  assert.match(output.css, /summary::-webkit-details-marker\{display:none\}/);
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

const hostBlocks = {
  Gallery: { props: { variant: { type: "enum", values: ["wide", "compact"], required: true } }, slots: { image: { label: "画像", style: ["height"] } }, component: () => "REAL HOST COMPONENT" },
};
function siteWithHostView() {
  const presentation = site();
  presentation.hostViews = [{
    id: "gallery-wide", block: "Gallery", props: { variant: "wide" },
    document: page("synthetic", "en", "host-gallery-wide", [{ type: "element", id: "gallery-root", tag: "section", children: [
      { type: "element", id: "previous", tag: "a", attrs: { href: "#gallery-root" }, children: [{ type: "text", text: "Previous" }] },
      { type: "element", id: "next", tag: "a", attrs: { href: "#gallery-root" }, children: [{ type: "text", text: "Next" }] },
      { type: "element", id: "pause", tag: "a", attrs: { href: "#gallery-root" }, children: [{ type: "text", text: "Pause" }] },
      { type: "element", id: "slide-one", tag: "div", style: { base: { backgroundImage: { asset: { provider: "gallery", id: "one" } } } }, children: [{ type: "text", text: "REAL SLIDE ONE" }] },
      { type: "element", id: "slide-two", tag: "div", children: [{ type: "text", text: "REAL SLIDE TWO" }] },
      { type: "element", id: "map", tag: "div", children: [] },
    ] }]),
    slotBindings: { image: ["slide-one", "slide-two"] },
    externalFrames: [{ nodeId: "map", src: "https://maps.example.test/embed/exact?place=NIHO%20Kamakura", title: "Read only map", allowFullScreen: true, frameKey: "gallery-map", autoHeightMax: 900 }],
    carousel: { rootId: "gallery-root", slideIds: ["slide-one", "slide-two"], previousIds: ["previous"], nextIds: ["next"], playPauseIds: ["pause"], autoplayMs: 4000, loop: true, swipe: true },
  }];
  return presentation;
}

test("host block views require exact normalized props, render in a distinct scope, and remain outside the page document", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" }, slots: { image: { base: { height: "240px" } } } }]);
  const presentation = parseSitePresentation(siteWithHostView(), document, hostBlocks);
  const html = renderSitePageToHtml(document, presentation, hostBlocks, { assets: { "gallery:one": { src: "https://media.example.test/one.webp" } } });
  assert.match(html, /data-nw-host-view="gallery-wide"/);
  assert.match(html, /REAL SLIDE ONE/); assert.match(html, /REAL SLIDE TWO/);
  assert.match(html, /data-nw-carousel-slide="1"[^>]*hidden=""/);
  assert.match(html, /iframe[^>]*src="https:\/\/maps\.example\.test\/embed\/exact\?place=NIHO%20Kamakura"[^>]*title="Read only map"/);
  assert.match(html, /iframe[^>]*sandbox="allow-scripts"/); assert.equal(/iframe[^>]* allow=/.test(html), false, "view descriptors cannot add feature permissions");
  assert.match(html, /style="width:100%;height:100%;border:0;display:block"/);
  assert.match(html, /data-nw-slot="image"/); assert.match(html, /height:240px/);
  const owners = [...html.matchAll(/data-nw-owner="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(new Set(owners).size >= 4, "host view uses its own owner scope");
  assert.equal(document.body[0].type, "component"); assert.equal(Object.hasOwn(document, "hostViews"), false);
  const assets = presentationAssetDocument(document, presentation);
  assert.ok(assets.body.some((node) => node.id === "gallery-root"), "view assets are collected through the transient presentation document");
  assert.throws(() => renderSitePageToHtml({ ...document, body: [{ ...document.body[0], props: { variant: "compact" } }] }, presentation, hostBlocks), /host view is missing/);
  assert.match(renderSitePageToHtml(document, presentation, hostBlocks, { hostViewMode: "fallback" }), /REAL HOST COMPONENT/);
  assert.doesNotMatch(renderSitePageToHtml(document, presentation, hostBlocks, { hostViewMode: "off" }), /data-nw-host-view="/);
});

test("host view validation rejects duplicates, hostile frames, cross-target documents, executable recursion and overlapping bindings", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const reject = (mutate) => { const input = siteWithHostView(); mutate(input); assert.throws(() => parseSitePresentation(input, document, hostBlocks)); };
  reject((input) => input.hostViews.push(structuredClone(input.hostViews[0])));
  reject((input) => { input.hostViews[0].document.siteId = "foreign"; });
  reject((input) => { input.hostViews[0].document.locale = "ja"; });
  reject((input) => { input.hostViews[0].document.pageId = "shared-header"; });
  reject((input) => { input.hostViews[0].externalFrames[0].src = "javascript:alert(1)"; });
  reject((input) => { input.hostViews[0].externalFrames[0].src = "https://maps.example.test/embed%0ajavascript:alert(1)"; });
  reject((input) => { input.hostViews[0].externalFrames[0].sandbox = "allow-scripts"; });
  reject((input) => { input.hostViews[0].externalFrames[0].autoHeightMax = 9000; });
  reject((input) => { input.hostViews[0].document.body.push({ type: "component", id: "recursive", block: "Gallery", props: { variant: "wide" } }); });
  reject((input) => { input.hostViews[0].carousel.nextIds = ["slide-one"]; });
  reject((input) => { input.hostViews[0].props = { variant: "unknown" }; });
});

test("frame auto-height accepts only its opaque matching window and restores styles on cleanup", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks);
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  const frame = dom.window.document.querySelector("iframe"), wrapper = frame.closest("[data-nw-host-view]");
  const cleanup = initializeSitePresentation(dom.window.document);
  const message = (source, origin, data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source, origin, data }));
  message(frame.contentWindow, "https://maps.example.test", { type: "niho-native-frame-size", frameKey: "gallery-map", height: 640 });
  assert.notEqual(wrapper.style.height, "640px");
  message(frame.contentWindow, "null", { type: "niho-native-frame-size", frameKey: "other", height: 640 });
  assert.notEqual(wrapper.style.height, "640px");
  message(frame.contentWindow, "null", { type: "niho-native-frame-size", frameKey: "gallery-map", height: 640 });
  assert.equal(frame.style.height, "640px"); assert.equal(wrapper.style.height, "640px");
  message(frame.contentWindow, "null", { type: "niho-native-frame-size", frameKey: "gallery-map", height: 901 });
  assert.equal(wrapper.style.height, "640px");
  cleanup(); assert.equal(wrapper.style.height, ""); assert.equal(frame.style.height, "100%"); dom.window.close();
});

test("two components using one host view keep independent carousel state", () => {
  const document = page("synthetic", "en", "body", ["one", "two"].map((id) => ({ type: "component", id, block: "Gallery", props: { variant: "wide" } })));
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks);
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const roots = [...dom.window.document.querySelectorAll("[data-nw-host-view]")], cleanup = initializeSitePresentation(dom.window.document);
  roots[0].querySelector("[data-nw-carousel-next]").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(roots[0].querySelectorAll("[data-nw-carousel-slide]")[1].hidden, false);
  assert.equal(roots[1].querySelectorAll("[data-nw-carousel-slide]")[0].hidden, false);
  cleanup(); dom.window.close();
});

test("native carousel starts deterministically, supports manual controls, pauses for reduced motion and cleans up", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks, { assets: { "gallery:one": { src: "https://media.example.test/one.webp" } } });
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  let intervalCalls = 0;
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  dom.window.setInterval = () => { intervalCalls++; return 7; };
  const root = dom.window.document, slides = [...root.querySelectorAll("[data-nw-carousel-slide]")], next = root.querySelector("[data-nw-carousel-next]");
  const cleanup = initializeSitePresentation(root);
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true); assert.equal(intervalCalls, 0, "reduced motion disables autoplay");
  next.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(slides[0].hidden, true); assert.equal(slides[1].hidden, false);
  cleanup();
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true);
  next.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(slides[0].hidden, false, "cleanup removes carousel listeners");
  dom.window.close();
});

test("native carousel pauses on hover and focus, and its play control supports Space", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks, { assets: { "gallery:one": { src: "https://media.example.test/one.webp" } } });
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  const callbacks = new Map(); let sequence = 0, clears = 0;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.setInterval = (callback) => { const id = ++sequence; callbacks.set(id, callback); return id; };
  dom.window.clearInterval = (id) => { callbacks.delete(id); clears++; };
  const root = dom.window.document, container = root.querySelector("[data-nw-host-view]"), play = root.querySelector("[data-nw-carousel-play-pause]");
  const cleanup = initializeSitePresentation(root);
  assert.equal(callbacks.size, 1);
  container.dispatchEvent(new dom.window.MouseEvent("mouseenter")); assert.equal(callbacks.size, 0);
  container.dispatchEvent(new dom.window.MouseEvent("mouseleave")); assert.equal(callbacks.size, 1);
  container.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true })); assert.equal(callbacks.size, 0);
  container.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: root.body })); assert.equal(callbacks.size, 1);
  play.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space" }));
  assert.equal(play.getAttribute("aria-pressed"), "true"); assert.equal(callbacks.size, 0);
  cleanup(); assert.ok(clears >= 3);
  play.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space" }));
  assert.equal(play.getAttribute("aria-pressed"), "false", "cleanup restores state and removes keyboard listeners");
  dom.window.close();
});

test("only trusted host code can retain a different frame origin, including shared slots", () => {
  const presentation = siteWithHostView(), document = page("synthetic", "en", "body", []);
  presentation.shared.header.body = [{ type: "component", id: "header-gallery", block: "Gallery", props: { variant: "wide" } }];
  const externalFramePolicy = createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["https://maps.example.test/embed/exact"] });
  const html = renderSitePageToHtml(document, presentation, hostBlocks, { externalFramePolicy });
  assert.match(html, /iframe[^>]*sandbox="allow-scripts allow-same-origin"/);
  assert.match(renderSitePageToHtml(document, presentation, hostBlocks), /iframe[^>]*sandbox="allow-scripts"/);
  assert.doesNotMatch(renderSitePageToHtml(document, presentation, hostBlocks, { hostViewMode: "off" }), /data-nw-host-view=/);
  assert.equal(externalFramePolicy({ src: "https://editor.example.test/api/editor" }), "opaque");
  assert.equal(externalFramePolicy({ src: "https://maps.example.test/other" }), "opaque");
  assert.equal(externalFramePolicy({ src: "https://maps.example.test/embed/exact#unexpected" }), "opaque");
  assert.throws(() => createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["https://editor.example.test/"] }));
  assert.throws(() => createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["http://maps.example.test/embed/exact"] }));
});

test("editing keeps frame sizing active without starting interactive controls", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const dom = new JSDOM(`<!doctype html><body>${renderSitePageToHtml(document, siteWithHostView(), hostBlocks)}</body>`, { url: "https://editor.example.test" });
  const frame = dom.window.document.querySelector("iframe"), messages = [];
  frame.contentWindow.postMessage = (data) => messages.push(data);
  const cleanup = initializeSitePresentation(dom.window.document, { interactive: false });
  assert.deepEqual(messages, [{ type: "niho-native-frame-request-size", frameKey: "gallery-map" }]);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: frame.contentWindow, origin: "null", data: { type: "niho-native-frame-size", frameKey: "gallery-map", height: 600 } }));
  assert.equal(frame.style.height, "600px");
  dom.window.document.querySelector("[data-nw-carousel-next]").click();
  assert.equal(dom.window.document.querySelectorAll("[data-nw-carousel-slide]")[1].hidden, true);
  cleanup(); frame.dispatchEvent(new dom.window.Event("load"));
  assert.equal(messages.length, 1); dom.window.close();
});

test("native disclosure content fills the authored flex box while keeping native closed state", () => {
  const document = page("synthetic", "en", "body", [{ type: "element", id: "disclosure", tag: "details", style: { base: { display: "flex", flexDirection: "column", alignItems: "flex-start" } }, children: [element("summary", "summary", "Read more"), element("content", "div", "Details")] }]);
  const html = renderSitePageToHtml(document, site(), {});
  assert.match(html, /data-nw-node="disclosure"\]::details-content\{width:100%;min-width:0;\}/);
  assert.equal(JSDOM.fragment(html).querySelector("details").open, false);
});

test("carousel fade cancels interrupted animations, completes once and restores on cleanup", async () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const presentation = siteWithHostView(); presentation.hostViews[0].carousel.fadeMs = 1200;
  const dom = new JSDOM(`<!doctype html><html><body>${renderSitePageToHtml(document, presentation, hostBlocks)}</body></html>`);
  const root = dom.window.document, slides = [...root.querySelectorAll("[data-nw-carousel-slide]")], next = root.querySelector("[data-nw-carousel-next]");
  const animations = [];
  for (const slide of slides) slide.animate = (_frames, options) => {
    let finish; const animation = { finished: new Promise(resolve => { finish = resolve; }), cancel() { this.cancelled = true; }, finish: () => finish(), options };
    animations.push(animation); return animation;
  };
  const cleanup = initializeSitePresentation(root);
  const click = () => next.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  click(); assert.equal(animations.length, 2); assert.equal(animations[0].options.duration, 1200); assert.ok(slides.every(slide => !slide.hidden));
  click(); assert.ok(animations.slice(0, 2).every(animation => animation.cancelled));
  animations.slice(2).forEach(animation => animation.finish()); await Promise.resolve(); await Promise.resolve();
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true);
  click(); cleanup(); assert.ok(animations.every(animation => animation.cancelled));
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true); dom.window.close();
  const invalid = siteWithHostView(); invalid.hostViews[0].carousel.fadeMs = 3001;
  assert.throws(() => parseSitePresentation(invalid, document, hostBlocks), /fade duration/);
});
