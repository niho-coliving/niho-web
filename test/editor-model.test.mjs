import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError } from "@niho/web/core";
import { acceptSavedRevision, commitHistory, editDocument, effectiveLocks, fingerprint, lockReason, newElement, nodeAt, travelHistory, validateReleasePlan, walkNodes } from "../dist/editor-model.js";

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
