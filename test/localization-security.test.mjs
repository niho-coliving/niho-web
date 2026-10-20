import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptTranslationResult, adoptTranslationCandidate, collectLocalizationUnits, createLocalizationOverlay, editLocalizedValue,
  localizationStatus, parseLocalizationOverlay, parseSiteLocalizationConfig, reviewLocalizedValue
} from "@niho/web/localization";

const config = () => ({ schemaVersion: 1, siteId: "demo", sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"],
  documentLocales: { ja: "ja-JP", en: "en" }, glossaryVersion: "g1", contextVersion: "c1" });
const page = () => ({ schemaVersion: 1, siteId: "demo", pageId: "home", locale: "ja-JP", revision: 1, title: "ホーム", tokens: {}, body: [
  { type: "element", id: "lead", tag: "p", children: [
    { type: "text", text: "詳しくは" },
    { type: "element", id: "link", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "こちら" }] }
  ] },
  { type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "main" }, attrs: { alt: "写真" }, children: [] }
] });
const unit = (collection, id) => collection.units.find((item) => item.unitId === id);
const result = (overlay, collection, values, extra = {}) => ({ schemaVersion: 1, resultId: "jobOne", siteId: collection.siteId, pageId: collection.pageId,
  sourceLocale: collection.sourceLocale, targetLocale: collection.targetLocale, baseVersion: overlay.version,
  values: values.map(([unitId, value, fingerprint]) => ({ unitId, sourceFingerprint: fingerprint ?? unit(collection, unitId)?.sourceFingerprint ?? "sha256:" + "0".repeat(64), value })), ...extra });

test("generated candidates never overwrite manual drafts and keeping the draft can review a changed source", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en");
  let overlay = createLocalizationOverlay(collection);
  overlay = editLocalizedValue(overlay, collection, { unitId: "page.title", value: "My hand edit", expectedVersion: overlay.version });
  const before = structuredClone(overlay);
  overlay = acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.title", "Generated title"]]));
  const entry = overlay.entries.find((item) => item.unitId === "page.title");
  assert.equal(entry.draftValue, "My hand edit");
  assert.equal(entry.editOrigin, "MANUAL");
  assert.equal(entry.candidate.value, "Generated title");
  assert.equal(before.entries[0].candidate, undefined);
  overlay = reviewLocalizedValue(overlay, collection, { unitId: "page.title", expectedVersion: overlay.version });
  const changedPage = page(); changedPage.title = "新しいホーム";
  const changed = await collectLocalizationUnits(config(), changedPage, "en");
  assert.equal(localizationStatus(overlay, changed).details.find((item) => item.unitId === "page.title").state, "review-needed");
  overlay = reviewLocalizedValue(overlay, changed, { unitId: "page.title", expectedVersion: overlay.version });
  assert.equal(overlay.entries.find((item) => item.unitId === "page.title").draftValue, "My hand edit");
  assert.equal(localizationStatus(overlay, changed).details.find((item) => item.unitId === "page.title").state, "reviewed");
  overlay = acceptTranslationResult(overlay, changed, result(overlay, changed, [["page.title", "A newer candidate"]]));
  const candidateVersion = overlay.entries.find((item) => item.unitId === "page.title").candidate.version;
  overlay = adoptTranslationCandidate(overlay, changed, { unitId: "page.title", expectedVersion: overlay.version, candidateVersion });
  assert.equal(overlay.entries.find((item) => item.unitId === "page.title").reviewedSourceFingerprint, undefined);
  assert.equal(localizationStatus(overlay, changed).details.find((item) => item.unitId === "page.title").state, "draft");
});

test("stale source, draft and candidate versions cannot win races", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en");
  let overlay = createLocalizationOverlay(collection);
  const pending = result(overlay, collection, [["page.title", "Home"]]);
  overlay = editLocalizedValue(overlay, collection, { unitId: "page.title", value: "Manual", expectedVersion: overlay.version });
  assert.throws(() => acceptTranslationResult(overlay, collection, pending), /stale optimistic version/);
  assert.throws(() => editLocalizedValue(overlay, collection, { unitId: "page.title", value: "Old", expectedVersion: 1 }), /stale optimistic version/);
  const staleSource = result(overlay, collection, [["page.title", "Home", "sha256:" + "0".repeat(64)]]);
  assert.throws(() => acceptTranslationResult(overlay, collection, staleSource), /source fingerprint is stale/);
  overlay = acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.title", "Home"]]));
  const candidateVersion = overlay.entries[0].candidate.version;
  assert.throws(() => adoptTranslationCandidate(overlay, collection, { unitId: "page.title", expectedVersion: overlay.version, candidateVersion: candidateVersion - 1 }), /stale candidate version/);
});

test("foreign scope, duplicate and unknown candidate units are rejected", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en"), overlay = createLocalizationOverlay(collection);
  for (const patch of [{ siteId: "other" }, { pageId: "other" }, { sourceLocale: "en" }, { targetLocale: "ja" }]) {
    assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.title", "Home"]], patch)), /foreign scope/);
  }
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.title", "A"], ["page.title", "B"]])), /duplicate unit ID/);
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.unknown", "A"]])), /unknown localization unit/);
  const foreignOverlay = { ...overlay, siteId: "other" };
  assert.throws(() => editLocalizedValue(foreignOverlay, collection, { unitId: "page.title", value: "A", expectedVersion: 1 }), /scope does not match/);
});

test("rich results preserve protected identities and cannot inject attributes, URLs, HTML or missing marks", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en"), overlay = createLocalizationOverlay(collection);
  const richId = "page.node.lead.richText";
  const valid = { kind: "rich-text", children: [{ type: "element", id: "link", tag: "a", children: [{ type: "text", text: "Read more" }] }] };
  assert.doesNotThrow(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[richId, valid]])));
  for (const invalid of [
    { kind: "rich-text", children: [{ type: "text", text: "Link removed" }] },
    { kind: "rich-text", children: [{ type: "element", id: "link", tag: "strong", children: [{ type: "text", text: "Changed mark" }] }] },
    { kind: "rich-text", children: [{ type: "element", id: "link", tag: "a", children: [{ type: "text", text: "   " }] }] },
    { kind: "rich-text", children: [{ type: "element", id: "link", tag: "a", attrs: { href: "javascript:alert(1)" }, children: [] }] },
    { kind: "rich-text", children: [{ type: "element", id: "link", tag: "a", children: [{ type: "text", text: "x", html: "<b>x</b>" }] }] }
  ]) assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[richId, invalid]])), /protected rich text|unknown field|cannot be blank/);
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.node.photo.asset", "/evil.webp"]])), /manual-only/);
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.node.link.attr.href", "javascript:alert(1)"]])), /unknown localization unit/);
});

test("generated plain and rich candidates preserve URLs, email addresses and numeric values while allowing numeric formatting", async () => {
  const source = page();
  source.title = "12,000円: https://niho.life/stays support@niho.life";
  source.body[0].children[0].text = "料金12,000円 https://niho.life/stays support@niho.life ";
  const collection = await collectLocalizationUnits(config(), source, "en"), overlay = createLocalizationOverlay(collection);
  const plainId = "page.title", richId = "page.node.lead.richText";
  assert.doesNotThrow(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[plainId,
    "Price 12 000 JPY: https://niho.life/stays support@niho.life"]])));
  for (const changed of [
    "Price 12,001 JPY: https://niho.life/stays support@niho.life",
    "Price 12,000 JPY: https://niho.life/other support@niho.life",
    "Price 12,000 JPY: https://niho.life/stays other@niho.life"
  ]) assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[plainId, changed]])), /protected URL, email, or numeric reference/);

  const safeRich = { kind: "rich-text", children: [
    { type: "element", id: "link", tag: "a", children: [{ type: "text", text: "Read more" }] },
    { type: "text", text: " for 12 000 JPY at https://niho.life/stays or support@niho.life" }
  ] };
  assert.doesNotThrow(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[richId, safeRich]])));
  const changedRich = structuredClone(safeRich);
  changedRich.children[1].text = "for 13,000 JPY at https://niho.life/stays or support@niho.life";
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[richId, changedRich]])), /protected URL, email, or numeric reference/);

  assert.doesNotThrow(() => editLocalizedValue(overlay, collection, {
    unitId: plainId, value: "Authorized manual change without references", expectedVersion: overlay.version
  }));
});

test("generated numbers preserve Japanese full-width values and numeric IDs", async () => {
  const source = page();
  source.title = "料金１２，０００円、注文１２３－４５";
  const collection = await collectLocalizationUnits(config(), source, "en"), overlay = createLocalizationOverlay(collection);
  assert.doesNotThrow(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.title", "Price 12,000 JPY, order 123-45"]])));
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.title", "Price 12,001 JPY, order 123-45"]])), /protected URL, email, or numeric reference/);
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [["page.title", "Price 12,000 JPY, order 123-46"]])), /protected URL, email, or numeric reference/);
});

test("manual rich text cannot replace visible copy with only protected empty marks", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en"), overlay = createLocalizationOverlay(collection);
  const value = { kind: "rich-text", children: [{ type: "element", id: "link", tag: "a", children: [{ type: "text", text: "  " }] }] };
  assert.throws(() => editLocalizedValue(overlay, collection, {
    unitId: "page.node.lead.richText", value, expectedVersion: overlay.version
  }), /localized text cannot be blank/);
});

test("translated rich text rejects excessive depth and anchors nested through marks", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en"), overlay = createLocalizationOverlay(collection);
  const richId = "page.node.lead.richText";
  let deep = { type: "text", text: "Deep" };
  for (let index = 0; index < 60; index++) deep = { type: "element", id: `mark${index}`, tag: "span", children: [deep] };
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[richId,
    { kind: "rich-text", children: [deep] }]])), /depth limit/);

  const nestedAnchor = { kind: "rich-text", children: [{ type: "element", id: "link", tag: "a", children: [
    { type: "element", id: "mark", tag: "strong", children: [
      { type: "element", id: "nested", tag: "a", children: [{ type: "text", text: "Nested" }] }
    ] }
  ] }] };
  assert.throws(() => acceptTranslationResult(overlay, collection, result(overlay, collection, [[richId, nestedAnchor]])), /cannot nest anchors/);
});

test("unknown fields, non-plain input, prototype pollution and invalid field values fail closed", async () => {
  const collection = await collectLocalizationUnits(config(), page(), "en"), overlay = createLocalizationOverlay(collection);
  assert.throws(() => parseSiteLocalizationConfig({ ...config(), extra: true }), /unknown field/);
  assert.throws(() => parseSiteLocalizationConfig(Object.assign(Object.create({ inherited: true }), config())), /expected a JSON object/);
  assert.throws(() => parseLocalizationOverlay({ ...overlay, extra: true }), /unknown field/);
  const polluted = JSON.parse(JSON.stringify(overlay));
  polluted.entries = [JSON.parse('{"unitId":"page.title","kind":"text","version":1,"draftValue":"Home","editOrigin":"MANUAL","__proto__":{"polluted":true}}')];
  assert.throws(() => parseLocalizationOverlay(polluted), /unknown field/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => editLocalizedValue(overlay, collection, { unitId: "page.title", value: " ", expectedVersion: overlay.version }), /cannot be blank/);
  assert.throws(() => editLocalizedValue(overlay, collection, { unitId: "page.title", value: "Home", expectedVersion: overlay.version, extra: true }), /unknown field/);
  assert.throws(() => editLocalizedValue(overlay, collection, { unitId: "page.title", value: "x".repeat(301), expectedVersion: overlay.version }), /field limit/);
  assert.throws(() => editLocalizedValue(overlay, collection, { unitId: "page.node.photo.asset", value: { kind: "asset", asset: { provider: "uploads", id: "../escape" } }, expectedVersion: overlay.version }), /invalid asset ID/);
});

test("all operations return detached copies and leave source, overlay, result and translated values immutable", async () => {
  const source = page(), collection = await collectLocalizationUnits(config(), source, "en");
  let overlay = createLocalizationOverlay(collection);
  const rich = { kind: "rich-text", children: [{ type: "element", id: "link", tag: "a", children: [{ type: "text", text: "Read" }] }] };
  const incoming = result(overlay, collection, [["page.node.lead.richText", rich]]), snapshot = structuredClone(incoming);
  const accepted = acceptTranslationResult(overlay, collection, incoming);
  assert.deepEqual(incoming, snapshot);
  rich.children[0].children[0].text = "mutated";
  assert.equal(accepted.entries[0].candidate.value.children[0].children[0].text, "Read");
  assert.deepEqual(overlay.entries, []);
  const adopted = adoptTranslationCandidate(accepted, collection, { unitId: "page.node.lead.richText", expectedVersion: accepted.version, candidateVersion: accepted.entries[0].candidate.version });
  adopted.entries[0].draftValue.children[0].children[0].text = "local mutation";
  assert.equal(accepted.entries[0].candidate.value.children[0].children[0].text, "Read");
  assert.equal(source.body[0].children[0].text, "詳しくは");
});
