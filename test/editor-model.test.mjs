import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError } from "@niho/web/core";
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
