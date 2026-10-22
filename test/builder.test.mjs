import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createInsertionNode, defineBuilder, layoutInsertionPresets, matchesMotionPreset, resolveBuilderDefinition, standardBuilderDefinition
} from "@niho/web/builder";
import { generatePageCss, parseComponentLibrary, parsePageDocument } from "@niho/web/core";
import { commitHistory, editDocument, travelHistory } from "../dist/editor-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);

test("layout compositions are opt-in and every catalog entry creates a valid document subtree", () => {
  assert.equal(resolveBuilderDefinition().insertions.some((entry) => entry.id === "grid"), false);
  const catalog = resolveBuilderDefinition({ insertions: layoutInsertionPresets });
  let page = doc();
  for (const preset of catalog.insertions) {
    const node = createInsertionNode(preset, { document: page });
    page = parsePageDocument({ ...page, body: [...page.body, node] });
  }
  assert.ok(page.body.some((node) => node.type === "element" && node.style?.base?.display === "grid"));
  assert.equal(resolveBuilderDefinition().motions.length, 0);
});

test("the standard catalog and a custom composed subtree use only unique factory IDs", () => {
  const custom = defineBuilder({ insertions: [{
    id: "feature-card", label: "特徴カード", group: "カスタム", glyph: "◇",
    create: ({ id, target }) => ({ type: "element", id: id(), tag: "article", attrs: { lang: target.locale }, children: [
      { type: "element", id: id(), tag: "h2", children: [{ type: "text", text: "特徴" }] },
      { type: "element", id: id(), tag: "p", children: [{ type: "text", text: "説明" }] }
    ] })
  }] });
  const resolved = resolveBuilderDefinition(custom);
  assert.ok(resolved.insertions.length > standardBuilderDefinition.insertions.length);
  const preset = resolved.insertions.find((entry) => entry.id === "feature-card");
  const node = createInsertionNode(preset, { document: doc() });
  assert.equal(node.tag, "article");
  assert.equal(node.attrs.lang, "ja-JP");
  assert.equal(new Set([node.id, ...node.children.map((child) => child.id)]).size, 3);
  assert.doesNotThrow(() => parsePageDocument({ ...doc(), body: [...doc().body, node] }));
});

test("preset validation rejects repeated IDs, unissued IDs and invalid HTML nesting", () => {
  const repeated = { id: "repeated", label: "重複", group: "検査", create: ({ id }) => {
    const same = id(); return { type: "element", id: same, tag: "div", children: [{ type: "element", id: same, tag: "p", children: [] }] };
  } };
  assert.throws(() => createInsertionNode(repeated, { document: doc() }), /duplicate node ID/);
  const hardcoded = { id: "hardcoded", label: "固定", group: "検査", create: () => ({ type: "element", id: "unsafe", tag: "div", children: [] }) };
  assert.throws(() => createInsertionNode(hardcoded, { document: doc() }), /id factory/);
  const nested = { id: "nested", label: "不正な入れ子", group: "検査", create: ({ id }) => ({
    type: "element", id: id(), tag: "p", children: [{ type: "element", id: id(), tag: "div", children: [] }]
  }) };
  assert.throws(() => createInsertionNode(nested, { document: doc() }), /nesting/);
});

test("custom presets cannot bypass insertable blocks or component placement policy", () => {
  const blocks = { Notice: { props: { heading: { type: "string", required: true } } } };
  const block = { id: "notice", label: "お知らせ", group: "業務", create: ({ id }) => ({ type: "component", id: id(), block: "Notice", props: { heading: "案内" } }) };
  assert.throws(() => createInsertionNode(block, { document: doc(), blocks, insertableBlocks: [] }), /新しく配置できません/);

  const library = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{
    id: "card", name: "カード", kind: "part", version: 1, root: { type: "element", id: "root", tag: "div", children: [] }
  }] });
  const instance = { id: "instance", label: "コンポーネント", group: "コンポーネント", create: ({ id }) => ({ type: "instance", id: id(), component: "card" }) };
  assert.throws(() => createInsertionNode(instance, { document: doc(), components: library, canInsertInstance: () => false }), /配置できません/);

  const libraryWithBlock = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{
    id: "notice-card", name: "お知らせカード", kind: "part", version: 1, root: { type: "element", id: "root", tag: "div", children: [
      { type: "component", id: "notice", block: "Notice", props: { heading: "案内" } }
    ] }
  }] }, blocks);
  const wrappedBlock = { id: "wrapped-block", label: "コンポーネント内ブロック", group: "コンポーネント", create: ({ id }) => ({ type: "instance", id: id(), component: "notice-card" }) };
  assert.throws(
    () => createInsertionNode(wrappedBlock, { document: doc(), blocks, components: libraryWithBlock, insertableBlocks: [] }),
    /追加が許可されていない/
  );

  const unlocked = createInsertionNode({ id: "child", label: "子", group: "検査", create: ({ id }) => ({ type: "element", id: id(), tag: "div", children: [] }) }, { document: doc() });
  assert.throws(() => editDocument(doc(), { type: "add", parentId: "hero", node: unlocked }, {}, [{ nodeId: "hero", fields: ["children"], reason: "運営管理" }]), /運営管理/);
});

test("a custom motion preset merges and removes only its declared paths in one undoable edit", () => {
  const source = doc();
  source.body[0].style.hidden = [{ minWidth: 1440 }];
  source.body[0].style.base.rotate = 12;
  source.body[0].style.states = { hover: { color: "#334455" } };
  const style = {
    base: { transitionTimingFunction: "ease-out", transitionDuration: 240 },
    states: { hover: { translate: "0 -6px" }, focus: { color: { token: "brand" } }, active: { scale: 0.98 } },
    appear: { effect: "fade-up", trigger: "load", duration: 500, delay: 0 }
  };
  const siteStyles = { tokens: { brand: { type: "color", value: "#195640" } } };
  const edited = editDocument(source, { type: "motionPreset", path: [0], style }, {}, [], undefined, siteStyles);
  assert.deepEqual(edited.body[0].style.responsive, source.body[0].style.responsive);
  assert.deepEqual(edited.body[0].style.hidden, source.body[0].style.hidden);
  assert.equal(edited.body[0].style.base.padding.token, "space");
  assert.equal(edited.body[0].style.base.rotate, 12);
  assert.deepEqual(edited.body[0].style.states.hover, { color: "#334455", translate: "0 -6px" });
  assert.equal(matchesMotionPreset(edited.body[0].style, { id: "ordered-differently", label: "順序違い", style: {
    states: { hover: { translate: "0 -6px" }, active: { scale: 0.98 }, focus: { color: { token: "brand" } } },
    base: { transitionDuration: 240, transitionTimingFunction: "ease-out" },
    appear: { delay: 0, duration: 500, trigger: "load", effect: "fade-up" }
  } }), true, "subset comparison ignores object key order and unrelated manual style");

  const history = commitHistory({ past: [], present: source, future: [] }, edited);
  assert.deepEqual(travelHistory(history, "undo", {}, [], undefined, siteStyles).present, source);
  const next = { base: { transitionDuration: 160 }, states: { focus: { scale: 1.03 } } };
  const switched = editDocument(edited, { type: "motionPreset", path: [0], previous: style, style: next }, {}, [], undefined, siteStyles);
  assert.equal(switched.body[0].style.base.rotate, 12);
  assert.equal(switched.body[0].style.base.transitionDuration, 160);
  assert.equal(switched.body[0].style.base.transitionTimingFunction, undefined);
  assert.deepEqual(switched.body[0].style.states, { hover: { color: "#334455" }, focus: { scale: 1.03 } });
  assert.equal(switched.body[0].style.appear, undefined);
  const cleared = editDocument(switched, { type: "motionPreset", path: [0], previous: next, style: undefined }, {}, [], undefined, siteStyles);
  assert.equal(cleared.body[0].style.base.rotate, 12);
  assert.deepEqual(cleared.body[0].style.states, { hover: { color: "#334455" } });
  assert.deepEqual(cleared.body[0].style.responsive, source.body[0].style.responsive);
  assert.throws(() => editDocument(source, { type: "motionPreset", path: [0], style }, {}, [{ nodeId: "hero", fields: ["style.states"], reason: "管理値" }], undefined, siteStyles), /管理値/);
  assert.throws(() => editDocument(source, { type: "motionPreset", path: [0], style }, {}, [], undefined), /unknown token/);
  assert.throws(() => editDocument(source, { type: "motionPreset", path: [0], style: { base: { animation: "unsafe 1s" } } }, {}, [], undefined, siteStyles), /未対応/);
  assert.throws(() => defineBuilder({ motions: [{ id: "unsafe", label: "unsafe", style: { base: { color: "red" } } }] }), /未対応/);
  assert.throws(() => defineBuilder({ motions: [{ id: "unknown", label: "unknown", style: { states: { hover: { filter: "blur(1px)" } } } }] }), /未対応/);

  const css = generatePageCss(edited, {}, undefined, siteStyles);
  assert.match(css, /prefers-reduced-motion:no-preference/);
  assert.match(css, /translate:0 -6px/);
  for (const rule of css.split("\n").filter((line) => /animation|transition/.test(line))) assert.ok(rule.startsWith("@media (prefers-reduced-motion:no-preference)"));
});

test("motion presets also apply to component instances without changing the wire contract", () => {
  const library = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{
    id: "card", name: "カード", kind: "part", version: 1, root: { type: "element", id: "root", tag: "article", children: [] }
  }] });
  const source = doc(); source.body.push({ type: "instance", id: "card-use", component: "card", style: { responsive: [{ minWidth: 768, declarations: { width: "50%" } }] } });
  const parsed = parsePageDocument(source, {}, { components: library });
  const edited = editDocument(parsed, { type: "motionPreset", path: [1], style: { states: { focus: { scale: 1.04 } }, base: { transitionDuration: 180 } } }, {}, [], library);
  assert.equal(edited.body[1].type, "instance");
  assert.deepEqual(edited.body[1].style.responsive, source.body[1].style.responsive);
  assert.deepEqual(Object.keys(edited.body[1]).sort(), ["component", "id", "style", "type"]);
  assert.equal(JSON.stringify(parsePageDocument(fixture)), JSON.stringify(fixture), "existing documents remain byte-equivalent after parsing");
});
