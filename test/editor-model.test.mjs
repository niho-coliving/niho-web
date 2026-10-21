import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, generatePageCss } from "@niho/web/core";
import { acceptSavedRevision, checkPageChange, commitHistory, editDocument, effectiveLocks, fingerprint, lockReason, newElement, nodeAt, travelHistory, validatePageChangePlan, validateReleasePlan, walkNodes } from "../dist/editor-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);
test("editor changes text, link, image and responsive styles through the core validator", () => {
  const original = doc();
  let next = editDocument(original, { type: "text", path: [0, 0, 0], value: "編集した見出し" });
  next = editDocument(next, { type: "attribute", path: [0, 2], name: "href", value: "/news" });
  next = editDocument(next, { type: "add", parentId: "hero", node: newElement("img", "photo") });
  next = editDocument(next, { type: "attribute", path: [0, 3], name: "src", value: "https://example.com/photo.webp" });
  for (const [property, value] of [["color", "#ff0000"], ["fontSize", 24], ["fontFamily", "sans-serif"], ["padding", "2rem"], ["display", "grid"], ["gridTemplateColumns", "1fr 1fr"], ["position", "absolute"], ["top", 12]]) next = editDocument(next, { type: "style", path: [0], breakpoint: 1024, property, value });
  assert.equal(nodeAt(next, [0, 0, 0]).text, "編集した見出し");
  assert.equal(nodeAt(next, [0, 3]).attrs.src, "https://example.com/photo.webp");
  assert.deepEqual(nodeAt(next, [0]).style.responsive.map((entry) => entry.minWidth), [768, 1024]);
  assert.equal(nodeAt(next, [0]).style.responsive[1].declarations.top, 12);
  assert.equal(nodeAt(original, [0, 0, 0]).text, "海のそばで過ごす");
  for (const operation of [
    { type: "attribute", path: [0, 2], name: "href", value: "javascript:alert(1)" },
    { type: "attribute", path: [0], name: "onclick", value: "alert(1)" },
    { type: "style", path: [0], breakpoint: "base", property: "color", value: "red;display:none" },
    { type: "add", parentId: "heading", node: newElement("section", "invalid") }
  ]) assert.throws(() => editDocument(next, operation), DocumentValidationError);
});
test("structure editing duplicates unique IDs and remaps internal links and ARIA references", () => {
  const original = doc(); original.body[0].attrs.id = "intro";
  original.body[0].children[0].attrs = { id: "title" };
  original.body[0].children[2].attrs = { href: "#intro", "aria-labelledby": "title" };
  const next = editDocument(original, { type: "duplicate", path: [0] });
  const nodes = walkNodes(next).flatMap(({ node }) => node.type === "text" ? [] : [node.id]);
  assert.equal(new Set(nodes).size, nodes.length);
  assert.equal(next.body[1].attrs.id, "intro_copy1");
  assert.equal(next.body[1].children[2].attrs.href, "#intro_copy1");
  assert.equal(next.body[1].children[2].attrs["aria-labelledby"], "title_copy1");
  const moved = editDocument(next, { type: "move", path: [0, 1], parentId: null, index: 1 });
  assert.equal(moved.body[1].id, "lead");
  assert.equal(editDocument(moved, { type: "remove", path: [1] }).body.length, 2);
  assert.throws(() => editDocument(original, { type: "move", path: [0], parentId: "heading", index: 0 }), /自分の内側/);
});
test("data-linked values are locked across field, ancestor removal, duplication and history operations", () => {
  const blocks = { Notice: { props: { heading: { type: "string" }, count: { type: "number" } }, component: () => null, lockedProps: { count: "外部データから取得します" } } };
  const original = doc(); original.body[0].children.push({ type: "component", id: "notice", block: "Notice", props: { heading: "表示", count: 5 } });
  const locks = [{ nodeId: "hero", fields: ["style.base.color"], reason: "ブランドで管理" }];
  const effective = effectiveLocks(original, locks, blocks);
  assert.equal(lockReason(original, [0, 3], "props.count", effective), "外部データから取得します");
  assert.equal(lockReason(original, [0], "style.base.color", effective), "ブランドで管理");
  assert.throws(() => editDocument(original, { type: "prop", path: [0, 3], name: "count", value: 6 }, blocks, locks), /データ連動値/);
  assert.throws(() => editDocument(original, { type: "style", path: [0], breakpoint: "base", property: "color", value: "red" }, blocks, locks), /ブランドで管理/);
  assert.throws(() => editDocument(original, { type: "remove", path: [0] }, blocks, locks), /データ連動値/);
  assert.throws(() => editDocument(original, { type: "duplicate", path: [0] }, blocks, locks), /複製できません/);
  const next = editDocument(original, { type: "prop", path: [0, 3], name: "heading", value: "編集可能" }, blocks, locks);
  assert.equal(next.body[0].children[3].props.heading, "編集可能");
  assert.throws(() => travelHistory({ past: [doc()], present: original, future: [] }, "undo", blocks, locks), /データ連動値/);
});
test("undo/redo tracks dirty content, clears redo on new edits, and bounds history", () => {
  const original = doc(); let history = { past: [], present: original, future: [] };
  const next = editDocument(original, { type: "title", value: "更新" }); history = commitHistory(history, next);
  assert.notEqual(fingerprint(history.present), fingerprint(original));
  history = travelHistory(history, "undo", {}, []); assert.equal(fingerprint(history.present), fingerprint(original));
  history = travelHistory(history, "redo", {}, []); assert.equal(history.present.title, "更新");
  history = travelHistory(history, "undo", {}, []);
  history = commitHistory(history, editDocument(history.present, { type: "title", value: "別の更新" })); assert.equal(history.future.length, 0);
  for (let index = 0; index < 60; index++) history = commitHistory(history, { ...history.present, title: `更新${index}` });
  assert.equal(history.past.length, 50);
});
test("saved revision rebases all history and the captured checkpoint while preserving later edits", () => {
  const original = doc(), submitted = editDocument(original, { type: "title", value: "保存開始時" });
  const later = editDocument(submitted, { type: "title", value: "保存中の追加編集" });
  const future = editDocument(later, { type: "title", value: "やり直し先" });
  const before = { past: [original, submitted], present: later, future: [future] };
  const accepted = acceptSavedRevision(before, submitted, 7);
  assert.ok([...accepted.history.past, accepted.history.present, ...accepted.history.future].every((document) => document.revision === 7));
  assert.equal(accepted.history.present.title, "保存中の追加編集");
  assert.equal(accepted.saved, fingerprint({ ...submitted, revision: 7 }));
  assert.notEqual(fingerprint(accepted.history.present), accepted.saved);
  const undo = travelHistory(accepted.history, "undo", {}, []);
  assert.equal(undo.present.revision, 7); assert.equal(fingerprint(undo.present), accepted.saved);
  const redo = travelHistory(undo, "redo", {}, []);
  assert.equal(redo.present.revision, 7); assert.equal(redo.present.title, "保存中の追加編集");
  const second = acceptSavedRevision(redo, redo.present, 8);
  assert.equal(second.history.present.revision, 8); assert.equal(fingerprint(second.history.present), second.saved);
  assert.equal(before.present.revision, 1); assert.equal(before.past[0].revision, 1); assert.equal(before.future[0].revision, 1);
  for (const revision of [0, 1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, undefined]) assert.throws(() => acceptSavedRevision(before, submitted, revision), /revision/);
});
test("release confirmation binds domain, target, version, action and rollback revision", () => {
  const request = { target: { siteId: "demo", pageId: "home", locale: "ja-JP" }, expectedVersion: "v2", action: "publish" };
  const plan = { ...request, domain: "https://example.com", confirmationToken: "one-use-token", changes: [{ path: "heading", before: "旧", after: "新" }] };
  const site = { id: "demo", name: "Demo", domains: ["https://example.com"] };
  assert.doesNotThrow(() => validateReleasePlan(plan, request, site));
  for (const invalid of [{ ...plan, domain: "https://evil.example" }, { ...plan, domain: "https://example.com/path" }, { ...plan, expectedVersion: "v1" },
    { ...plan, target: { ...plan.target, pageId: "other" } }, { ...plan, action: "rollback", revision: 1 }, { ...plan, confirmationToken: "" }]) assert.throws(() => validateReleasePlan(invalid, request, site));
});
test("meta operations add, replace and remove public information through the core validator", () => {
  let next = editDocument(doc(), { type: "meta", field: "structuredData", value: ["organization"] });
  next = editDocument(next, { type: "meta", field: "noindex", value: true });
  next = editDocument(next, { type: "meta", field: "ogImage", value: { src: "/cover.jpg", alt: "" } });
  next = editDocument(next, { type: "meta", field: "description", value: "海のそばの暮らし" });
  assert.deepEqual(Object.keys(next.meta), ["description", "ogImage", "noindex", "structuredData"]);
  assert.deepEqual(Object.keys(next), ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "body"]);
  for (const [field, value] of [["description", ""], ["ogImage", undefined], ["noindex", false], ["structuredData", []]]) next = editDocument(next, { type: "meta", field, value });
  assert.equal("meta" in next, false);
  for (const operation of [{ type: "meta", field: "favicon", value: "javascript:alert(1)" }, { type: "meta", field: "description", value: "改行\nあり" }, { type: "meta", field: "structuredData", value: ["a", "a"] }])
    assert.throws(() => editDocument(doc(), operation), DocumentValidationError);
  const history = commitHistory({ past: [], present: doc(), future: [] }, editDocument(doc(), { type: "meta", field: "favicon", value: "/icon.png" }));
  assert.equal(travelHistory(history, "undo", {}, []).present.meta, undefined);
});
const pages = [
  { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" },
  { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about" },
  { siteId: "demo", pageId: "detail", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template" },
  { siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared" },
  { siteId: "demo", pageId: "secret", locale: "ja-JP", title: "準備中", path: "/secret", visibility: "private" }
];
const site = { id: "demo", name: "Demo", domains: ["https://example.com"] };
const target = (pageId) => ({ siteId: "demo", pageId, locale: "ja-JP" });
test("page changes are checked for title, path, conflicts, host-owned kinds and site", () => {
  assert.equal(checkPageChange({ action: "create", siteId: "demo", locale: "ja-JP", title: "新しいページ", path: "/new" }, pages, site), undefined);
  assert.equal(checkPageChange({ action: "update", target: target("about"), title: "会社概要", path: "/about" }, pages, site), undefined);
  assert.match(checkPageChange({ action: "update", target: target("about"), title: "私たちについて", path: "/about" }, pages, site), /変更してください/);
  assert.match(checkPageChange({ action: "create", siteId: "demo", locale: "ja-JP", title: "重複", path: "/about" }, pages, site), /「私たちについて」と同じ URL/);
  assert.match(checkPageChange({ action: "duplicate", source: target("about"), title: "体験", path: "/experiences/kayak" }, pages, site), /テンプレート「体験詳細」/);
  assert.match(checkPageChange({ action: "create", siteId: "demo", locale: "ja-JP", title: "大文字", path: "/About" }, pages, site), /半角英小文字/);
  assert.match(checkPageChange({ action: "create", siteId: "demo", locale: "ja-JP", title: " ", path: "/x" }, pages, site), /ページ名/);
  assert.match(checkPageChange({ action: "create", siteId: "demo", locale: "ja-JP", title: "a".repeat(121), path: "/x" }, pages, site), /120文字/);
  for (const change of [{ action: "duplicate", source: target("detail"), title: "複製", path: "/copy" }, { action: "update", target: target("header"), title: "ヘッダー", path: "/header" },
    { action: "visibility", target: target("detail"), visibility: "private" }]) assert.equal(checkPageChange(change, pages, site), "テンプレートと共通枠はホストが管理します。");
  assert.match(checkPageChange({ action: "create", siteId: "other", locale: "ja-JP", title: "別", path: "/x" }, pages, site), /別のサイト/);
  assert.match(checkPageChange({ action: "update", target: { ...target("about"), siteId: "other" }, title: "別", path: "/x" }, pages, site), /別のサイト/);
  assert.match(checkPageChange({ action: "update", target: target("missing"), title: "無い", path: "/x" }, pages, site), /見つかりません/);
  assert.match(checkPageChange({ action: "visibility", target: target("secret"), visibility: "private" }, pages, site), /すでに非公開/);
  assert.match(checkPageChange({ action: "visibility", target: target("about"), visibility: "public" }, pages, site), /すでに公開/);
  assert.equal(checkPageChange({ action: "visibility", target: target("secret"), visibility: "public" }, pages, site), undefined);
});
test("page change plans bind the request, approved domain and impact shape", () => {
  const change = { action: "update", target: target("about"), title: "会社概要", path: "/company" };
  const plan = { change: { ...change, target: { ...change.target } }, confirmationToken: "one-use", domain: "https://example.com", impact: {
    before: "https://example.com/about", after: "https://example.com/company", redirect: { from: "/about", to: "/company" },
    linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 2 }], navigation: ["ヘッダー"], notes: ["sitemap の URL が変わります。"] } };
  const reviewed = validatePageChangePlan({ ...plan, extra: "dropped", impact: { ...plan.impact, extra: true } }, change, site);
  assert.deepEqual(reviewed, plan);
  for (const invalid of [{ ...plan, domain: "https://evil.example" }, { ...plan, domain: "https://example.com/" }, { ...plan, change: { ...change, path: "/other" } },
    { ...plan, change: { ...change, target: target("home") } }, { ...plan, change: { action: "visibility", target: target("about"), visibility: "private" } }, { ...plan, confirmationToken: "" },
    { ...plan, impact: { ...plan.impact, before: "https://evil.example/about" } }, { ...plan, impact: { ...plan.impact, after: "https://example.com.evil.test/x" } },
    { ...plan, impact: { ...plan.impact, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: -1 }] } }, { ...plan, impact: { ...plan.impact, navigation: "ヘッダー" } },
    { ...plan, impact: { ...plan.impact, notes: ["a".repeat(301)] } }, { ...plan, impact: { ...plan.impact, redirect: { from: "/about" } } }, { ...plan, impact: undefined }, null])
    assert.throws(() => validatePageChangePlan(invalid, change, site), /ページ変更の対象/);
  assert.throws(() => validatePageChangePlan({ ...plan, change: { action: "create", siteId: "other", locale: "ja-JP", title: "x", path: "/x" } }, { action: "create", siteId: "other", locale: "ja-JP", title: "x", path: "/x" }, site), /ページ変更の対象/);
});

const withPhoto = (node = { attrs: { src: "/photo.webp", alt: "旧い写真" } }) => { const original = doc(); original.body[0].children.push({ type: "element", id: "photo", tag: "img", children: [], ...node }); return original; };
test("image operations switch between library assets and URLs and keep or set alt text", () => {
  const original = withPhoto(), sea = { provider: "uploads", id: "sea" };
  let next = editDocument(original, { type: "image", path: [0, 3], source: { asset: sea }, alt: "朝の海" });
  assert.deepEqual(nodeAt(next, [0, 3]).asset, sea); assert.deepEqual(nodeAt(next, [0, 3]).attrs, { alt: "朝の海" });
  assert.equal(nodeAt(original, [0, 3]).attrs.src, "/photo.webp");
  next = editDocument(next, { type: "image", path: [0, 3], source: { src: "https://example.com/a.webp" } });
  assert.equal(nodeAt(next, [0, 3]).asset, undefined); assert.deepEqual(nodeAt(next, [0, 3]).attrs, { alt: "朝の海", src: "https://example.com/a.webp" });
  assert.throws(() => editDocument(original, { type: "image", path: [0], source: { asset: sea } }), /画像を選択/);
  for (const source of [{ src: "javascript:alert(1)" }, { asset: { provider: "uploads", id: "../sea" } }, { asset: { ...sea, src: "/x.webp" } }]) assert.throws(() => editDocument(original, { type: "image", path: [0, 3], source }), DocumentValidationError);
  assert.throws(() => editDocument(original, { type: "image", path: [0, 3], source: { asset: sea } }, {}, [{ nodeId: "photo", fields: ["attrs.src"], reason: "外部の画像です" }]), /外部の画像です/);
  const locked = withPhoto({ asset: sea, attrs: { alt: "" } });
  assert.throws(() => editDocument(locked, { type: "image", path: [0, 3], source: { src: "/other.webp" } }, {}, [{ nodeId: "photo", fields: ["asset"], reason: "連動画像" }]), /連動画像/);
  assert.throws(() => editDocument(locked, { type: "image", path: [0, 3], source: { asset: { provider: "uploads", id: "b" } } }, {}, [{ nodeId: "photo", fields: ["*"], reason: "連動画像" }]), /連動画像/);
});
test("image source locks cover src, srcSet, assets, restoration and history together", () => {
  const original = withPhoto({ attrs: { src: "/photo.webp", srcSet: "/photo-large.webp", alt: "Sea" } });
  const changed = structuredClone(original); nodeAt(changed, [0, 3]).attrs.srcSet = "/bypass.webp";
  for (const field of ["attrs.src", "attrs.srcSet", "asset"]) {
    const locks = [{ nodeId: "photo", fields: [field], reason: "業務画像" }];
    for (const requested of ["attrs.src", "attrs.srcSet", "asset"]) assert.equal(lockReason(original, [0, 3], requested, locks), "業務画像");
    for (const operation of [
      { type: "attribute", path: [0, 3], name: "srcSet", value: "/bypass.webp" },
      { type: "attribute", path: [0, 3], name: "src", value: "/bypass.webp" },
      { type: "image", path: [0, 3], source: { src: "/photo.webp", srcset: "/bypass.webp" } },
      { type: "image", path: [0, 3], source: { asset: { provider: "uploads", id: "bypass" } } },
      { type: "restore", document: changed }
    ]) assert.throws(() => editDocument(original, operation, {}, locks), /業務画像/);
    assert.throws(() => travelHistory({ past: [changed], present: original, future: [] }, "undo", {}, locks), /業務画像/);
    assert.throws(() => travelHistory({ past: [], present: original, future: [changed] }, "redo", {}, locks), /業務画像/);
    assert.equal(nodeAt(editDocument(original, { type: "attribute", path: [0, 3], name: "alt", value: "Updated sea" }, {}, locks), [0, 3]).attrs.alt, "Updated sea");
  }
});

test("background operations set and clear images per breakpoint like style operations", () => {
  const wave = { provider: "uploads", id: "wave" };
  let next = editDocument(doc(), { type: "background", path: [0], breakpoint: "base", asset: wave });
  next = editDocument(next, { type: "background", path: [0], breakpoint: 768, asset: wave });
  next = editDocument(next, { type: "background", path: [0], breakpoint: 1280, asset: { provider: "cms", id: "hero" } });
  assert.deepEqual(nodeAt(next, [0]).style.base.backgroundImage, { asset: wave });
  assert.deepEqual(nodeAt(next, [0]).style.responsive.map((entry) => [entry.minWidth, Object.keys(entry.declarations)]), [[768, ["maxWidth", "margin", "backgroundImage"]], [1280, ["backgroundImage"]]]);
  next = editDocument(next, { type: "background", path: [0], breakpoint: 1280, asset: undefined });
  next = editDocument(next, { type: "background", path: [0], breakpoint: 768, asset: undefined });
  assert.deepEqual(nodeAt(next, [0]).style.responsive, doc().body[0].style.responsive);
  next = editDocument(next, { type: "background", path: [0], breakpoint: "base", asset: undefined });
  assert.deepEqual(nodeAt(next, [0]).style, doc().body[0].style);
  assert.throws(() => editDocument(doc(), { type: "background", path: [0, 0, 0], breakpoint: "base", asset: wave }), /親要素/);
  assert.throws(() => editDocument(doc(), { type: "background", path: [0], breakpoint: "base", asset: { provider: "uploads", id: "a b" } }), DocumentValidationError);
  assert.throws(() => editDocument(doc(), { type: "background", path: [0], breakpoint: "base", asset: wave }, {}, [{ nodeId: "hero", fields: ["style.base.backgroundImage"], reason: "ブランド画像" }]), /ブランド画像/);
});
test("replaceAsset swaps every image and background reference to the same asset", () => {
  const sea = { provider: "uploads", id: "sea" }, wave = { provider: "uploads", id: "wave" }, original = withPhoto({ asset: sea, attrs: { alt: "" } });
  original.body[0].style.base.backgroundImage = { asset: sea }; original.body[0].style.responsive[0].declarations.backgroundImage = { asset: wave };
  const next = editDocument(original, { type: "replaceAsset", from: sea, to: { provider: "cms", id: "new" } });
  assert.deepEqual(nodeAt(next, [0, 3]).asset, { provider: "cms", id: "new" }); assert.deepEqual(nodeAt(next, [0]).style.base.backgroundImage, { asset: { provider: "cms", id: "new" } });
  assert.deepEqual(nodeAt(next, [0]).style.responsive[0].declarations.backgroundImage, { asset: wave });
  assert.throws(() => editDocument(next, { type: "replaceAsset", from: sea, to: wave }), /置き換える素材/);
  assert.throws(() => editDocument(original, { type: "replaceAsset", from: sea, to: wave }, {}, [{ nodeId: "photo", fields: ["asset"], reason: "連動画像" }]), /連動画像/);
});
test("add can insert at a position within the destination", () => {
  const next = editDocument(doc(), { type: "add", parentId: "hero", index: 1, node: newElement("img", "photo") });
  assert.deepEqual(nodeAt(next, [0]).children.map((node) => node.id), ["heading", "photo", "lead", "link"]);
  assert.equal(editDocument(doc(), { type: "add", parentId: null, index: 0, node: newElement("p", "first") }).body[0].id, "first");
  assert.equal(editDocument(doc(), { type: "add", parentId: "hero", index: 3, node: newElement("p", "last") }).body[0].children[3].id, "last");
  for (const index of [-1, 4, 1.5, Number.NaN]) assert.throws(() => editDocument(doc(), { type: "add", parentId: "hero", index, node: newElement("p", "x") }), /追加先の位置が不正です/);
});
const styledDoc = () => {
  const doc = structuredClone(fixture);
  doc.tokens.brand = { type: "color", value: "#195640", label: "メイン" };
  doc.tokens.gap = { type: "length", value: 24 };
  doc.textStyles = {
    heading: { label: "見出し", base: { fontSize: 24, fontWeight: 700, lineHeight: 1.3 }, responsive: [{ minWidth: 768, declarations: { fontSize: 32, letterSpacing: { token: "gap" } } }, { minWidth: 1280, declarations: { lineHeight: 1.1 } }] }
  };
  doc.body[0].children[0].style = { textStyle: "heading", base: { color: { token: "brand" }, lineHeight: 1.5 }, responsive: [{ minWidth: 1024, declarations: { fontSize: 28 } }] };
  doc.body[0].children[1].style = { textStyle: "heading" };
  doc.body[0].style.base.gap = { token: "gap" };
  return doc;
};
test("styles changes several properties as one history entry and keeps the style operation behaviour", () => {
  const original = doc(); let history = { past: [], present: original, future: [] };
  const next = editDocument(original, { type: "styles", path: [0], breakpoint: 768, values: { justifyContent: "center", alignItems: "flex-end", maxWidth: undefined } });
  history = commitHistory(history, next);
  assert.deepEqual(nodeAt(next, [0]).style.responsive[0].declarations, { margin: "0 auto", justifyContent: "center", alignItems: "flex-end" });
  assert.equal(history.past.length, 1);
  assert.equal(fingerprint(travelHistory(history, "undo", {}, []).present), fingerprint(original));
  const single = editDocument(original, { type: "style", path: [0], breakpoint: 768, property: "maxWidth", value: undefined });
  assert.deepEqual(single, editDocument(original, { type: "styles", path: [0], breakpoint: 768, values: { maxWidth: undefined } }));
  const removed = editDocument(single, { type: "styles", path: [0], breakpoint: 768, values: { margin: undefined } });
  assert.deepEqual(nodeAt(removed, [0]).style.responsive, []);
  assert.throws(() => editDocument(original, { type: "styles", path: [0], breakpoint: "base", values: { gap: 12, color: "red;}" } }), DocumentValidationError);
  assert.throws(() => editDocument(original, { type: "styles", path: [0, 0, 0], breakpoint: "base", values: { color: "red" } }), /親要素/);
});
test("deleting a token detaches node and text style references into literal values", () => {
  const original = styledDoc();
  const created = editDocument(original, { type: "token", name: "accent", token: { type: "color", value: "#ff000080", label: "強調" } });
  assert.deepEqual(created.tokens.accent, { type: "color", value: "#ff000080", label: "強調" });
  assert.throws(() => editDocument(original, { type: "token", name: "Bad Name", token: { type: "color", value: "#fff" } }), /名前/);
  assert.throws(() => editDocument(original, { type: "token", name: "brand", token: { type: "length", value: 4 } }), DocumentValidationError);
  const before = generatePageCss(original);
  const next = editDocument(original, { type: "token", name: "gap", token: undefined });
  assert.equal(next.tokens.gap, undefined);
  assert.equal(nodeAt(next, [0]).style.base.gap, 24);
  assert.equal(next.textStyles.heading.responsive[0].declarations.letterSpacing, 24);
  const brand = editDocument(next, { type: "token", name: "brand", token: undefined });
  assert.equal(nodeAt(brand, [0, 0]).style.base.color, "#195640");
  assert.equal(generatePageCss(brand).replace(/--nw-(?:brand|gap):[^;]+;/g, ""), before.replace(/--nw-(?:brand|gap):[^;]+;/g, "").replaceAll("var(--nw-gap)", "24px").replaceAll("var(--nw-brand)", "#195640"));
  assert.throws(() => editDocument(original, { type: "token", name: "missing", token: undefined }), /見つかりません/);
  const locked = [{ nodeId: "hero", fields: ["style.base.gap"], reason: "ブランドで管理" }];
  assert.throws(() => editDocument(original, { type: "token", name: "gap", token: undefined }, {}, locked), /ブランドで管理/);
  assert.throws(() => editDocument(original, { type: "token", name: "gap", token: { type: "length", value: 32 } }, {}, locked), /ブランドで管理/);
  assert.equal(editDocument(original, { type: "token", name: "brand", token: { type: "color", value: "#123456" } }, {}, locked).tokens.brand.value, "#123456");
  const inheritedLock = [{ nodeId: "lead", fields: ["style.base.fontSize"], reason: "文字サイズは固定" }];
  assert.throws(() => editDocument(original, { type: "textStyle", name: "heading", style: { ...original.textStyles.heading, base: { ...original.textStyles.heading.base, fontSize: 30 } } }, {}, inheritedLock), /文字サイズは固定/);
});
test("deleting or detaching a text style copies declarations without changing the computed appearance", () => {
  const original = styledDoc();
  const removed = editDocument(original, { type: "textStyle", name: "heading", style: undefined });
  assert.equal(removed.textStyles, undefined);
  const heading = nodeAt(removed, [0, 0]).style, lead = nodeAt(removed, [0, 1]).style;
  assert.equal(heading.textStyle, undefined);
  // ノード側の lineHeight 1.5（base）は全幅で勝つため、1280px の 1.1 はコピーしない。1024px の 28 は 768px の 32 より後で効くので残る。
  assert.deepEqual(heading, { base: { color: { token: "brand" }, lineHeight: 1.5, fontSize: 24, fontWeight: 700 }, responsive: [{ minWidth: 768, declarations: { fontSize: 32, letterSpacing: { token: "gap" } } }, { minWidth: 1024, declarations: { fontSize: 28 } }] });
  assert.deepEqual(lead, { base: { fontSize: 24, fontWeight: 700, lineHeight: 1.3 }, responsive: [{ minWidth: 768, declarations: { fontSize: 32, letterSpacing: { token: "gap" } } }, { minWidth: 1280, declarations: { lineHeight: 1.1 } }] });
  const detached = editDocument(original, { type: "nodeTextStyle", path: [0, 1], name: undefined, detach: true });
  assert.deepEqual(nodeAt(detached, [0, 1]).style, lead);
  assert.ok(detached.textStyles.heading);
  const cleared = editDocument(original, { type: "nodeTextStyle", path: [0, 1], name: undefined });
  assert.deepEqual(nodeAt(cleared, [0, 1]).style, {});
  const applied = editDocument(cleared, { type: "nodeTextStyle", path: [0, 2], name: "heading" });
  assert.equal(nodeAt(applied, [0, 2]).style.textStyle, "heading");
  assert.throws(() => editDocument(original, { type: "nodeTextStyle", path: [0, 2], name: "missing" }), DocumentValidationError);
  assert.throws(() => editDocument(original, { type: "textStyle", name: "body", style: { base: { color: "#fff" } } }), DocumentValidationError);
  const updated = editDocument(original, { type: "textStyle", name: "body", style: { label: "本文", base: { fontSize: 16 } } });
  assert.deepEqual(updated.textStyles.body, { label: "本文", base: { fontSize: 16 } });
  const locked = [{ nodeId: "lead", fields: ["style"], reason: "固定の見た目" }];
  assert.throws(() => editDocument(original, { type: "textStyle", name: "heading", style: undefined }, {}, locked), /固定の見た目/);
  assert.throws(() => editDocument(original, { type: "nodeTextStyle", path: [0, 1], name: undefined, detach: true }, {}, locked), /固定の見た目/);
});
test("business blocks limit style changes to their declared appearance properties", () => {
  const blocks = { Notice: { props: { heading: { type: "string" } }, component: () => null, styleProperties: ["marginTop", "backgroundColor"] }, Free: { props: {}, component: () => null } };
  const original = styledDoc();
  original.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "表示" } }, { type: "component", id: "free", block: "Free", props: {} });
  const next = editDocument(original, { type: "styles", path: [1], breakpoint: "base", values: { marginTop: 24, backgroundColor: { token: "brand" } } }, blocks);
  assert.deepEqual(nodeAt(next, [1]).style.base, { marginTop: 24, backgroundColor: { token: "brand" } });
  assert.deepEqual(nodeAt(next, [1]).props, { heading: "表示" });
  for (const operation of [{ type: "style", path: [1], breakpoint: "base", property: "width", value: 10 }, { type: "styles", path: [1], breakpoint: 768, values: { marginTop: 1, color: "red" } },
    { type: "nodeTextStyle", path: [1], name: "heading" }]) assert.throws(() => editDocument(original, operation, blocks), /このブロックでは変更できない見た目です。/);
  assert.equal(nodeAt(editDocument(original, { type: "nodeTextStyle", path: [2], name: "heading" }, blocks), [2]).style.textStyle, "heading");
  assert.equal(nodeAt(editDocument(original, { type: "style", path: [0], breakpoint: "base", property: "width", value: 10 }, blocks), [0]).style.base.width, 10);
  const textBlocks = { ...blocks, Notice: { ...blocks.Notice, styleProperties: ["textStyle"] } };
  assert.equal(nodeAt(editDocument(original, { type: "nodeTextStyle", path: [1], name: "heading" }, textBlocks), [1]).style.textStyle, "heading");
});
test("styleRange edits one tier and keeps wider widths by first copying the value they used", () => {
  const original = styledDoc(); let history = { past: [], present: original, future: [] };
  const only = (path, breakpoint, until, values, ...rest) => editDocument(original, { type: "styleRange", path, breakpoint, until, values }, ...rest);
  const next = only([0], "base", 768, { flexDirection: "row" });
  assert.equal(nodeAt(next, [0]).style.base.flexDirection, "row");
  assert.deepEqual(nodeAt(next, [0]).style.responsive, [{ minWidth: 768, declarations: { maxWidth: "64rem", margin: "0 auto", flexDirection: "column" } }]);
  history = commitHistory(history, next); assert.equal(history.past.length, 1);
  assert.equal(fingerprint(travelHistory(history, "undo", {}, []).present), fingerprint(original));
  // 文字スタイル由来の値もそのままコピーする（token 参照は参照のまま）。
  const heading = only([0, 0], "base", 768, { fontSize: 18 });
  assert.deepEqual(nodeAt(heading, [0, 0]).style.responsive, [{ minWidth: 768, declarations: { fontSize: 32 } }, { minWidth: 1024, declarations: { fontSize: 28 } }]);
  assert.equal(nodeAt(heading, [0, 0]).style.base.fontSize, 18);
  const spacing = only([0, 0], 768, 1024, { letterSpacing: 2 });
  assert.deepEqual(nodeAt(spacing, [0, 0]).style.responsive, [{ minWidth: 768, declarations: { letterSpacing: 2 } }, { minWidth: 1024, declarations: { fontSize: 28, letterSpacing: { token: "gap" } } }]);
  // 次の段が同じプロパティを持っていればコピーしない。値が無ければ中立値を書く。削除でも広い幅の値を保つ。
  assert.deepEqual(nodeAt(only([0], "base", 768, { maxWidth: "40rem" }), [0]).style.responsive[0].declarations, { maxWidth: "64rem", margin: "0 auto" });
  assert.equal(nodeAt(only([0], "base", 768, { width: "50%" }), [0]).style.responsive[0].declarations.width, "auto");
  const removed = only([0], "base", 768, { gap: undefined });
  assert.equal(nodeAt(removed, [0]).style.base.gap, undefined); assert.deepEqual(nodeAt(removed, [0]).style.responsive[0].declarations.gap, { token: "gap" });
  // 余白は shorthand と上下左右を組で扱う。
  assert.equal(nodeAt(only([0], "base", 768, { marginTop: 8 }), [0]).style.base.marginTop, 8);
  const split = only([0], "base", 768, { padding: undefined, paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4 });
  assert.deepEqual(nodeAt(split, [0]).style.responsive[0].declarations.padding, { token: "space" });
  for (const [path, values] of [[[0, 1], { color: "#ff0000" }], [[0, 1], { marginTop: 8 }], [[0, 1], { display: "grid" }], [[0, 1], { textAlign: "center" }]]) {
    assert.throws(() => only(path, "base", 768, values), /広い幅（768px〜）の値が決まっていないため、この幅だけの指定にできません。先に「768px 以上」で値を入れてください。/);
  }
  assert.equal(nodeAt(original, [0, 1]).style.base, undefined);
  const partial = doc();
  partial.body[0].children[1].style = { responsive: [{ minWidth: 768, declarations: { marginTop: 12 } }] };
  assert.throws(() => editDocument(partial, { type: "styleRange", path: [0, 1], breakpoint: "base", until: 768, values: { margin: "8px" } }), /広い幅/);
  partial.body[0].children[1].style.responsive[0].declarations.margin = "4px";
  assert.equal(nodeAt(editDocument(partial, { type: "styleRange", path: [0, 1], breakpoint: "base", until: 768, values: { margin: "8px" } }), [0, 1]).style.base.margin, "8px");
  assert.throws(() => only([0], 768, 768, { width: 1 }), /範囲/);
  assert.throws(() => only([0], "base", 768, { width: "1px;}" }), DocumentValidationError);
  assert.throws(() => only([0], "base", 768, { width: 10 }, {}, [{ nodeId: "hero", fields: ["style.responsive"], reason: "幅別は固定" }]), /幅別は固定/);
  const blocks = { Notice: { props: {}, component: () => null, styleProperties: ["width"] } };
  const block = structuredClone(original); block.body.push({ type: "component", id: "notice", block: "Notice", props: {} });
  assert.equal(nodeAt(editDocument(block, { type: "styleRange", path: [1], breakpoint: "base", until: 768, values: { width: 100 } }, blocks), [1]).style.responsive[0].declarations.width, "auto");
  assert.throws(() => editDocument(block, { type: "styleRange", path: [1], breakpoint: "base", until: 768, values: { height: 100 } }, blocks), /このブロックでは変更できない見た目です。/);
});
test("resize handles keep wider widths when the edit is limited to one tier", () => {
  const original = doc();
  const cascade = nodeAt(editDocument(original, { type: "resize", path: [0], breakpoint: "base", width: 320.4, height: 200 }), [0]).style;
  assert.equal(cascade.base.width, 320); assert.equal(cascade.base.height, 200);
  const sized = editDocument(original, { type: "style", path: [0], breakpoint: "base", property: "width", value: "64rem" });
  const only = nodeAt(editDocument(sized, { type: "resize", path: [0], breakpoint: "base", width: 300, height: 120, until: 768 }), [0]).style;
  assert.equal(only.base.width, 300); assert.equal(only.base.height, 120);
  const wide = only.responsive.find((entry) => entry.minWidth === 768).declarations;
  assert.equal(wide.width, "64rem"); assert.equal(wide.height, "auto");
  assert.throws(() => editDocument(original, { type: "resize", path: [0], breakpoint: "base", width: 0, height: 10 }), /1〜10000px/);
});
test("restore replaces content as an ordinary validated edit while keeping identity and revision", () => {
  const present = { ...doc(), revision: 7, meta: { description: "現在の説明" } };
  const old = { ...doc(), siteId: "other", pageId: "old", locale: "en", revision: 2, title: "以前のタイトル", tokens: { ink: { type: "color", value: "#000000" } } };
  old.body[0].style.base.color = "#000000"; old.body[0].style.base.fontFamily = "serif"; old.body[0].style.base.padding = 8; old.body[0].children[0].children[0].text = "以前の見出し";
  const restored = editDocument(present, { type: "restore", document: old });
  assert.deepEqual([restored.siteId, restored.pageId, restored.locale, restored.revision, restored.schemaVersion], ["demo", "home", "ja-JP", 7, 1]);
  assert.equal(restored.title, "以前のタイトル"); assert.equal(restored.meta, undefined); assert.deepEqual(restored.tokens, old.tokens);
  assert.equal(nodeAt(restored, [0, 0, 0]).text, "以前の見出し");
  const styled = editDocument(present, { type: "restore", document: { ...old, textStyles: { lead: { label: "リード", base: { fontSize: 18 } } } } });
  assert.deepEqual(styled.textStyles, { lead: { label: "リード", base: { fontSize: 18 } } });
  assert.equal(editDocument(styled, { type: "restore", document: old }).textStyles, undefined, "text styles follow the restored version");
  old.body[0].children[0].children[0].text = "後から変えた"; assert.equal(nodeAt(restored, [0, 0, 0]).text, "以前の見出し", "restored content is copied");
  const history = commitHistory({ past: [], present, future: [] }, restored);
  assert.equal(history.past.length, 1); assert.equal(travelHistory(history, "undo", {}, []).present, present);
  const broken = structuredClone(old); broken.body[0].attrs = { onclick: "alert(1)" };
  assert.throws(() => editDocument(present, { type: "restore", document: broken }), DocumentValidationError);
  const blocks = { Notice: { props: { count: { type: "number" } }, component: () => null, lockedProps: { count: "外部データから取得します" } } };
  const withBlock = { ...present, body: [...present.body, { type: "component", id: "notice", block: "Notice", props: { count: 3 } }] };
  const oldBlock = { ...old, body: [...old.body, { type: "component", id: "notice", block: "Notice", props: { count: 9 } }] };
  assert.throws(() => editDocument(withBlock, { type: "restore", document: oldBlock }, blocks), /データ連動値/);
  assert.throws(() => editDocument(withBlock, { type: "restore", document: old }, blocks), /データ連動値/);
  assert.doesNotThrow(() => editDocument(withBlock, { type: "restore", document: { ...oldBlock, body: [...old.body, { ...oldBlock.body.at(-1), props: { count: 3 } }] } }, blocks));
});
test("release plans may carry a public URL under the domain and a bounded affected list", () => {
  const request = { target: { siteId: "demo", pageId: "home", locale: "ja-JP" }, expectedVersion: "v2", action: "publish" };
  const plan = { ...request, domain: "https://example.com", confirmationToken: "token", changes: [], url: "https://example.com/about",
    affected: [{ kind: "shared", name: "ヘッダー", detail: "全ページのナビゲーション" }, { kind: "page", name: "ホーム" }, { kind: "site", name: "サイト共通の設定" }] };
  const site = { id: "demo", name: "Demo", domains: ["https://example.com"] };
  assert.doesNotThrow(() => validateReleasePlan(plan, request, site));
  for (const invalid of [{ ...plan, url: "https://example.com.evil.test/about" }, { ...plan, url: "https://example.com" }, { ...plan, url: "https://evil.test/about" }, { ...plan, url: 1 },
    { ...plan, url: `https://example.com/${"a".repeat(2048)}` }, { ...plan, url: "https://example.com/a\nb" }, { ...plan, affected: "ヘッダー" },
    { ...plan, affected: [{ kind: "layout", name: "x" }] }, { ...plan, affected: [{ kind: "page", name: "" }] }, { ...plan, affected: [{ kind: "page", name: "a".repeat(121) }] },
    { ...plan, affected: [{ kind: "page", name: "x", detail: "a".repeat(301) }] }, { ...plan, affected: [null] }, { ...plan, affected: Array.from({ length: 101 }, () => ({ kind: "page", name: "x" })) }])
    assert.throws(() => validateReleasePlan(invalid, request, site), /一致しません/);
});
