import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { editDocument } from "../dist/editor-model.js";
import { canvasViewportHeight, fitCanvasScale, pathForNodeId, projectLayers, visibleLayers } from "../dist/layers.js";
import { EditorSessionLoadError, readEditorSession } from "../dist/editor-session.js";

const source = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const target = { siteId: source.siteId, pageId: source.pageId, locale: source.locale };
const snapshot = (document = source) => ({ document: structuredClone(document), version: "v1" });

test("layer projection uses stable IDs, omits raw text rows and resolves current paths after structure edits", () => {
  const initial = projectLayers(source);
  assert.deepEqual(initial.map(({ id }) => id), ["hero", "heading", "lead", "link"]);
  assert.equal(initial.find(({ id }) => id === "heading").label, "海のそばで過ごす");
  assert.equal(initial.some(({ node }) => node.type === "text"), false);

  const added = editDocument(source, { type: "add", parentId: "hero", index: 0, node: { type: "element", id: "photo", tag: "img", attrs: { src: "/photo.webp", alt: "" }, children: [] } });
  assert.deepEqual(pathForNodeId(added, "heading"), [0, 1]);
  const moved = editDocument(added, { type: "move", path: [0, 1], parentId: "hero", index: 3 });
  assert.deepEqual(pathForNodeId(moved, "heading"), [0, 3]);
  const removedSibling = editDocument(moved, { type: "remove", path: [0, 0] });
  assert.deepEqual(pathForNodeId(removedSibling, "heading"), [0, 2]);
  const withoutHeading = editDocument(removedSibling, { type: "remove", path: [0, 2] });
  assert.equal(pathForNodeId(withoutHeading, "heading"), null);
});

test("collapsed layer projection hides descendants without changing document paths", () => {
  const entries = projectLayers(source), collapsed = visibleLayers(entries, new Set());
  assert.deepEqual(collapsed.map(({ id }) => id), ["hero"]);
  assert.deepEqual(pathForNodeId(source, "link"), [0, 2]);
  assert.deepEqual(visibleLayers(entries, new Set(["hero"])).map(({ id }) => id), ["hero", "heading", "lead", "link"]);
});

test("layer moves still pass through core cycle and lock validation", () => {
  assert.throws(() => editDocument(source, { type: "move", path: [0], parentId: "heading", index: 0 }), /移動|子孫|nesting|parent/);
  assert.throws(() => editDocument(source, { type: "move", path: [0, 0], parentId: null, index: 1 }, {}, [{ nodeId: "hero", fields: ["children"], reason: "固定構造" }]), /固定構造|データ連動値/);
});

test("editor session opens a self-contained document when optional site settings fail", async () => {
  const result = await readEditorSession({ readDocument: async () => snapshot(), readSiteSettings: async () => { throw new Error("offline"); } }, target, new AbortController().signal);
  assert.equal(result.session.history.present.title, source.title);
  assert.equal(result.session.selfContained, true);
  assert.match(result.warning, /文書単体/);
});

test("editor session requires unavailable site settings when the document references their tokens", async () => {
  const dependent = structuredClone(source);
  dependent.body[0].style = { base: { color: { token: "siteInk" } } };
  await assert.rejects(() => readEditorSession({ readDocument: async () => snapshot(dependent), readSiteSettings: async () => { throw new Error("offline"); } }, target, new AbortController().signal),
    (error) => error instanceof EditorSessionLoadError && error.reason === "site-settings-required" && /サイト共通スタイル/.test(error.message));
  const loaded = await readEditorSession({ readDocument: async () => snapshot(dependent), readSiteSettings: async () => ({ settings: { title: "Demo", locale: "ja", tokens: { siteInk: { type: "color", value: "#123456" } } }, version: "s1" }) }, target, new AbortController().signal);
  assert.equal(loaded.session.selfContained, false);
  assert.equal(loaded.session.siteStyles.tokens.siteInk.value, "#123456");
});

test("editor session rejects aborted reads even when an adapter resolves late", async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; }), controller = new AbortController();
  const reading = readEditorSession({ readDocument: () => pending }, target, controller.signal);
  controller.abort(); resolve(snapshot());
  await assert.rejects(reading, (error) => error?.name === "AbortError");
});

test("a newer target can finish before an aborted older target without installing the old result", async () => {
  let resolveOld;
  const oldTarget = target, newTarget = { ...target, pageId: "other" };
  const oldController = new AbortController(), newController = new AbortController();
  const oldRead = readEditorSession({ readDocument: () => new Promise((resolve) => { resolveOld = resolve; }) }, oldTarget, oldController.signal);
  const newRead = readEditorSession({ readDocument: async () => snapshot({ ...source, pageId: newTarget.pageId }) }, newTarget, newController.signal);
  const newer = await newRead;
  oldController.abort(); resolveOld(snapshot());
  await assert.rejects(oldRead, (error) => error?.name === "AbortError");
  assert.equal(newer.session.target.pageId, "other");
});

test("editor session wraps invalid documents consistently when site settings load", async () => {
  const invalid = snapshot({ ...source, siteId: "wrong-site" });
  await assert.rejects(() => readEditorSession({ readDocument: async () => invalid, readSiteSettings: async () => ({ settings: { title: "Demo", locale: "ja" }, version: "s1" }) }, target, new AbortController().signal),
    (error) => error instanceof EditorSessionLoadError && error.reason === "document" && /現在の編集内容は保持/.test(error.message) && error.cause instanceof Error);
});

test("canvas fit scale is pure and leaves the document viewport width unchanged", () => {
  assert.equal(fitCanvasScale(1280, 640), .5);
  assert.equal(fitCanvasScale(1280, 1600), 1);
  assert.equal(fitCanvasScale(375, 300), .8);
  assert.equal(fitCanvasScale(1280, 0), 1);
  assert.equal(canvasViewportHeight(.5, 600), 1200);
  assert.equal(canvasViewportHeight(.25, 600), 2400);
  assert.equal(canvasViewportHeight(1, 600), 800);
  assert.equal(canvasViewportHeight(.5, 0), 800);
});
