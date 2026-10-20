import assert from "node:assert/strict";
import { test } from "node:test";
import { parseComponentLibrary, parsePageDocument } from "@niho/web/core";
import {
  acceptTranslationResult, adoptTranslationCandidate, collectLocalizationUnits, createLocalizationOverlay, documentLocaleFor,
  editLocalizedValue, localizationLocaleFor, localizationStatus, materializeLocalizedPage, parseSiteLocalizationConfig, reviewLocalizedValue
} from "@niho/web/localization";

const config = (sourceLocale = "ja") => ({
  schemaVersion: 1, siteId: "demo", sourceLocale, defaultLocale: sourceLocale, enabledLocales: ["ja", "en"],
  documentLocales: { ja: "ja-JP", en: "en" }, glossaryVersion: "glossary-1", contextVersion: "prompt-1"
});
const blocks = {
  Booking: { props: {
    heading: { type: "string", maxLength: 40 }, privateNote: { type: "string", maxLength: 80 }, href: { type: "url" }, price: { type: "number" }
  } }
};
const blockLocalization = { Booking: { props: ["heading"] } };
const library = () => ({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: { sharedGap: { type: "length", value: 12 } }, components: [{
  id: "navbar", name: "Navigation", kind: "navigation", version: 1,
  root: { type: "element", id: "navRoot", tag: "nav", style: { base: { gap: { token: "sharedGap" } } }, children: [
    { type: "element", id: "brand", tag: "span", children: [{ type: "text", text: "鎌倉" }] },
    { type: "element", id: "navLink", tag: "a", attrs: { href: "/about", title: "会社案内" }, children: [{ type: "text", text: "私たちについて" }] }
  ] },
  props: {
    label: { label: "Label", node: "navLink", field: "text" },
    href: { label: "Link", node: "navLink", field: "href" }
  }
}] });
const page = (locale = "ja-JP") => ({
  schemaVersion: 1, siteId: "demo", pageId: "home", locale, revision: 4, title: locale === "en" ? "Experience" : "体験",
  meta: { description: locale === "en" ? "Stay by the sea" : "海辺で暮らす", ogImage: { src: "/og.webp", alt: "海" } },
  tokens: { ink: { type: "color", value: "#123456" } },
  body: [{ type: "element", id: "hero", tag: "section", attrs: { "aria-label": "ページ紹介" }, style: { base: { color: { token: "ink" }, padding: 24 } }, children: [
    { type: "element", id: "heading", tag: "h1", children: [{ type: "text", text: locale === "en" ? "Welcome" : "ようこそ" }] },
    { type: "element", id: "lead", tag: "p", children: [
      { type: "text", text: "海の" },
      { type: "element", id: "emphasis", tag: "strong", children: [{ type: "text", text: "近く" }] },
      { type: "text", text: "で " },
      { type: "element", id: "detailsLink", tag: "a", attrs: { href: "/details", title: "詳細" }, children: [{ type: "text", text: "暮らす" }] }
    ] },
    { type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "sea-main" }, attrs: { alt: "由比ヶ浜" }, children: [] },
    { type: "instance", id: "navOne", component: "navbar", props: { label: "概要", href: "/overview" }, style: { base: { marginTop: 8 } } },
    { type: "instance", id: "navTwo", component: "navbar" },
    { type: "component", id: "booking", block: "Booking", props: { heading: "予約", privateNote: "inventory-key", href: "/book", price: 12000 } }
  ] }]
});
const options = () => ({ components: library(), blocks, blockLocalization });
const byId = (collection, id) => collection.units.find((unit) => unit.unitId === id);
const resultFor = (overlay, collection, resultId, values) => ({
  schemaVersion: 1, resultId, siteId: collection.siteId, pageId: collection.pageId, sourceLocale: collection.sourceLocale,
  targetLocale: collection.targetLocale, baseVersion: overlay.version,
  values: values.map(([unitId, value]) => ({ unitId, sourceFingerprint: byId(collection, unitId).sourceFingerprint, value }))
});

test("config requires an explicit source locale and explicit ja/en document mappings in both directions", async () => {
  const missing = config(); delete missing.sourceLocale;
  assert.throws(() => parseSiteLocalizationConfig(missing), /sourceLocale/);
  assert.equal(documentLocaleFor(config("ja"), "ja"), "ja-JP");
  assert.equal(localizationLocaleFor(config("ja"), "en"), "en");
  assert.throws(() => localizationLocaleFor(config("ja"), "en-US"), /no explicit mapping/);
  assert.equal((await collectLocalizationUnits(config("ja"), page("ja-JP"), "en", options())).sourceLocale, "ja");
  assert.equal((await collectLocalizationUnits(config("en"), page("en"), "ja", options())).sourceLocale, "en");
  await assert.rejects(() => collectLocalizationUnits(config("en"), page("ja-JP"), "ja", options()), /explicit source locale mapping/);
  assert.throws(() => parseSiteLocalizationConfig({ ...config(), documentLocales: { ja: "en", en: "ja" } }), /ja language family/);
  assert.throws(() => parseSiteLocalizationConfig({ ...config(), documentLocales: { ja: "fr", en: "de" } }), /ja language family/);
});

test("extraction uses stable element fields, grouped rich text, shared definitions, explicit instance overrides and block allowlists", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en", options());
  const ids = collection.units.map((unit) => unit.unitId);
  assert.ok(ids.includes("page.node.lead.richText"));
  assert.ok(!ids.some((id) => id.includes("children")));
  assert.equal(ids.filter((id) => id === "component.navbar.node.brand.text").length, 1);
  assert.ok(ids.includes("page.instance.navOne.prop.label"));
  assert.ok(!ids.includes("page.instance.navOne.prop.href"));
  assert.ok(!ids.some((id) => id.includes("navTwo.prop")));
  assert.ok(ids.includes("page.block.booking.prop.heading"));
  assert.ok(!ids.some((id) => id.includes("privateNote") || id.endsWith(".href") || id.endsWith(".price")));
  assert.ok(ids.includes("page.node.photo.asset"));
  assert.equal(byId(collection, "page.node.photo.asset").translatable, false);
  const rich = byId(collection, "page.node.lead.richText").sourceValue;
  assert.equal(rich.kind, "rich-text");
  assert.ok(!JSON.stringify(rich).includes("/details"));
  assert.ok(ids.includes("page.node.detailsLink.attr.title"));
  assert.deepEqual(collection.issues, []);
  assert.equal(localizationStatus(createLocalizationOverlay(collection), collection).details.find((item) => item.unitId === "page.node.photo.asset").state, "source");
});

test("ambiguous direct text and unsupported rich groups surface issues instead of leaf translation claims", async () => {
  const ambiguous = page();
  ambiguous.body.push({ type: "text", text: "unanchored" });
  ambiguous.body[0].children[1].children.push({ type: "element", id: "inlineImage", tag: "img", attrs: { src: "/inline.webp", alt: "inline" }, children: [] });
  const collection = await collectLocalizationUnits(config(), ambiguous, "en", options());
  assert.ok(collection.issues.some((issue) => issue.code === "UNANCHORED_TEXT"));
  assert.ok(collection.issues.some((issue) => issue.code === "UNSUPPORTED_RICH_TEXT" && issue.nodeId === "lead"));
  assert.ok(!collection.units.some((item) => item.unitId === "page.node.lead.richText"));
  assert.equal(localizationStatus(createLocalizationOverlay(collection), collection).complete, false);
});

test("fingerprints ignore movement and style but bind source text, protected links, direction and glossary context", async () => {
  const original = await collectLocalizationUnits(config(), page(), "en", options());
  const movedPage = page();
  movedPage.body[0].children.reverse();
  movedPage.body[0].style.base.padding = 48;
  const moved = await collectLocalizationUnits(config(), movedPage, "en", options());
  assert.equal(byId(original, "page.node.heading.text").sourceFingerprint, byId(moved, "page.node.heading.text").sourceFingerprint);
  const changedText = page(); changedText.body[0].children[0].children[0].text = "こんにちは";
  const textCollection = await collectLocalizationUnits(config(), changedText, "en", options());
  assert.notEqual(byId(original, "page.node.heading.text").sourceFingerprint, byId(textCollection, "page.node.heading.text").sourceFingerprint);
  const changedLink = page(); changedLink.body[0].children[1].children[3].attrs.href = "/new-details";
  const linkCollection = await collectLocalizationUnits(config(), changedLink, "en", options());
  assert.notEqual(byId(original, "page.node.lead.richText").sourceFingerprint, byId(linkCollection, "page.node.lead.richText").sourceFingerprint);
  const nextGlossary = config(); nextGlossary.glossaryVersion = "glossary-2";
  const glossaryCollection = await collectLocalizationUnits(nextGlossary, page(), "en", options());
  assert.notEqual(byId(original, "page.title").sourceFingerprint, byId(glossaryCollection, "page.title").sourceFingerprint);
  const reverse = await collectLocalizationUnits(config("en"), page("en"), "ja", options());
  assert.notEqual(byId(original, "page.title").sourceFingerprint, byId(reverse, "page.title").sourceFingerprint);
  const otherPage = page(); otherPage.pageId = "about";
  const otherCollection = await collectLocalizationUnits(config(), otherPage, "en", options());
  assert.notEqual(byId(original, "page.title").sourceFingerprint, byId(otherCollection, "page.title").sourceFingerprint);
  assert.equal(byId(original, "component.navbar.node.brand.text").sourceFingerprint, byId(otherCollection, "component.navbar.node.brand.text").sourceFingerprint);
});

test("rich text candidates can reorder safe marks while preserving link identity and materialize through existing parsers", async () => {
  const source = page(), components = library(), collection = await collectLocalizationUnits(config(), source, "en", options());
  let overlay = createLocalizationOverlay(collection);
  const translatedRich = { kind: "rich-text", children: [
    { type: "element", id: "detailsLink", tag: "a", children: [{ type: "text", text: "Live" }] },
    { type: "text", text: " " },
    { type: "element", id: "emphasis", tag: "strong", children: [{ type: "text", text: "near" }] },
    { type: "text", text: " the sea" }
  ] };
  overlay = acceptTranslationResult(overlay, collection, resultFor(overlay, collection, "jobRich", [
    ["page.title", "Experience"], ["page.node.lead.richText", translatedRich]
  ]));
  assert.equal(localizationStatus(overlay, collection).candidates, 2);
  for (const unitId of ["page.title", "page.node.lead.richText"]) {
    const candidateVersion = overlay.entries.find((entry) => entry.unitId === unitId).candidate.version;
    overlay = adoptTranslationCandidate(overlay, collection, { unitId, expectedVersion: overlay.version, candidateVersion });
    overlay = reviewLocalizedValue(overlay, collection, { unitId, expectedVersion: overlay.version });
  }
  for (const [unitId, value] of [
    ["component.navbar.node.brand.text", "Kamakura"],
    ["component.navbar.node.navLink.text", "About us"],
    ["page.instance.navOne.prop.label", "Overview"]
  ]) overlay = editLocalizedValue(overlay, collection, { unitId, value, expectedVersion: overlay.version });
  overlay = editLocalizedValue(overlay, collection, { unitId: "page.node.photo.asset", value: { kind: "asset", asset: { provider: "uploads", id: "sea-en" } }, expectedVersion: overlay.version });
  const output = await materializeLocalizedPage(config(), source, collection, overlay, options());
  const parsedLibrary = parseComponentLibrary(output.components, blocks);
  assert.doesNotThrow(() => parsePageDocument(output.document, blocks, { components: parsedLibrary }));
  assert.equal(output.document.locale, "en");
  assert.equal(output.document.pageId, source.pageId);
  assert.deepEqual(output.document.tokens, source.tokens);
  assert.deepEqual(output.document.body[0].style, source.body[0].style);
  const lead = output.document.body[0].children.find((node) => node.id === "lead");
  assert.equal(lead.children[0].id, "detailsLink");
  assert.equal(lead.children[0].attrs.href, "/details");
  assert.equal(output.document.body[0].children.find((node) => node.id === "photo").asset.id, "sea-en");
  assert.equal(output.document.body[0].children.find((node) => node.id === "navOne").props.label, "Overview");
  assert.equal(output.components.components[0].root.children[0].children[0].text, "Kamakura");
  assert.equal(output.components.components[0].root.children[1].children[0].text, "About us");
  assert.equal(source.body[0].children.find((node) => node.id === "photo").asset.id, "sea-main");
  assert.equal(components.components[0].root.children[0].children[0].text, "鎌倉");
});

test("materialization recollects current source, rejects stale or forged collections, and accepts stable moves and styles", async () => {
  const source = page(), extraction = options();
  const collection = await collectLocalizationUnits(config(), source, "en", extraction);
  const overlay = createLocalizationOverlay(collection);

  const changedText = page(); changedText.title = "新しい体験";
  await assert.rejects(materializeLocalizedPage(config(), changedText, collection, overlay, extraction), /collection is stale/);

  const changedHref = page(); changedHref.body[0].children[1].children[3].attrs.href = "/changed";
  await assert.rejects(materializeLocalizedPage(config(), changedHref, collection, overlay, extraction), /collection is stale/);

  const changedConfig = config(); changedConfig.contextVersion = "prompt-2";
  await assert.rejects(materializeLocalizedPage(changedConfig, source, collection, overlay, extraction), /collection is stale/);

  const changedComponents = options(); changedComponents.components.components[0].root.children[0].children[0].text = "鎌倉市";
  await assert.rejects(materializeLocalizedPage(config(), source, collection, overlay, changedComponents), /collection is stale/);

  const forged = structuredClone(collection);
  forged.units.find((item) => item.unitId === "page.title").field = "meta.description";
  await assert.rejects(materializeLocalizedPage(config(), source, forged, overlay, extraction), /collection is stale/);

  const moved = page();
  moved.body[0].children.reverse();
  moved.body[0].style.base.padding = 48;
  const styledOptions = options();
  styledOptions.components.components[0].root.style = { base: { padding: 16 } };
  const output = await materializeLocalizedPage(config(), moved, collection, overlay, styledOptions);
  assert.equal(output.document.body[0].style.base.padding, 48);
  assert.equal(output.components.components[0].root.style.base.padding, 16);
});

test("review applies only to the exact current draft and intentional empty alt values materialize", async () => {
  const source = page(), collection = await collectLocalizationUnits(config(), source, "en", options());
  let overlay = createLocalizationOverlay(collection);
  overlay = editLocalizedValue(overlay, collection, { unitId: "page.title", value: "First", expectedVersion: overlay.version });
  overlay = reviewLocalizedValue(overlay, collection, { unitId: "page.title", expectedVersion: overlay.version });
  overlay = editLocalizedValue(overlay, collection, { unitId: "page.title", value: "Second", expectedVersion: overlay.version });
  assert.equal(overlay.entries.find((entry) => entry.unitId === "page.title").reviewedSourceFingerprint, undefined);
  assert.equal(localizationStatus(overlay, collection).details.find((item) => item.unitId === "page.title").state, "draft");

  overlay = editLocalizedValue(overlay, collection, { unitId: "page.node.photo.attr.alt", value: "", expectedVersion: overlay.version });
  overlay = reviewLocalizedValue(overlay, collection, { unitId: "page.node.photo.attr.alt", expectedVersion: overlay.version });
  assert.equal(localizationStatus(overlay, collection).details.find((item) => item.unitId === "page.node.photo.attr.alt").state, "reviewed");
  const output = await materializeLocalizedPage(config(), source, collection, overlay, options());
  assert.equal(output.document.body[0].children.find((node) => node.id === "photo").attrs.alt, "");
});

test("changed and deleted source units become review-needed or obsolete without moving drafts to another node", async () => {
  const source = page(), first = await collectLocalizationUnits(config(), source, "en", options());
  let overlay = createLocalizationOverlay(first);
  overlay = editLocalizedValue(overlay, first, { unitId: "page.node.heading.text", value: "Welcome", expectedVersion: overlay.version });
  overlay = reviewLocalizedValue(overlay, first, { unitId: "page.node.heading.text", expectedVersion: overlay.version });
  const changed = page(); changed.body[0].children[0].children[0].text = "ようこそ鎌倉へ";
  const changedCollection = await collectLocalizationUnits(config(), changed, "en", options());
  assert.equal(localizationStatus(overlay, changedCollection).details.find((item) => item.unitId === "page.node.heading.text").state, "review-needed");
  const deleted = page(); deleted.body[0].children.splice(0, 1);
  const deletedCollection = await collectLocalizationUnits(config(), deleted, "en", options());
  assert.equal(localizationStatus(overlay, deletedCollection).obsolete, 1);
  const replacement = page(); replacement.body[0].children[0].id = "replacementHeading";
  const replacementCollection = await collectLocalizationUnits(config(), replacement, "en", options());
  const status = localizationStatus(overlay, replacementCollection);
  assert.equal(status.obsolete, 1);
  assert.equal(status.details.find((item) => item.unitId === "page.node.replacementHeading.text").state, "missing");
});
