import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError } from "@niho/web/core";
import { commitHistory, editDocument, fingerprint, nodeAt, travelHistory } from "../dist/editor-model.js";
import { editorTiers, hiddenAt, hiddenTiers, rangesForTiers, tokenUsage } from "../dist/style-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);

test("state edits write hover and focus together in one history entry and prune empty states", () => {
  const original = doc(); let history = { past: [], present: original, future: [] };
  const next = editDocument(original, { type: "state", path: [0, 2], state: "hover", values: { color: { token: "ink" }, translate: "0 -2px" }, also: ["focus"] });
  assert.deepEqual(nodeAt(next, [0, 2]).style, { states: { hover: { color: { token: "ink" }, translate: "0 -2px" }, focus: { color: { token: "ink" }, translate: "0 -2px" } } });
  history = commitHistory(history, next); assert.equal(history.past.length, 1);
  assert.equal(fingerprint(travelHistory(history, "undo", {}, []).present), fingerprint(original));
  const pressed = editDocument(next, { type: "state", path: [0, 2], state: "active", values: { scale: 0.98 } });
  const cleared = editDocument(pressed, { type: "state", path: [0, 2], state: "hover", values: { color: undefined, translate: undefined } });
  assert.deepEqual(nodeAt(cleared, [0, 2]).style.states, { focus: { color: { token: "ink" }, translate: "0 -2px" }, active: { scale: 0.98 } });
  const empty = editDocument(editDocument(cleared, { type: "state", path: [0, 2], state: "focus", values: { color: undefined, translate: undefined } }), { type: "state", path: [0, 2], state: "active", values: { scale: undefined } });
  assert.deepEqual(nodeAt(empty, [0, 2]).style, {});
  for (const values of [{ width: 10 }, { color: "red;}" }, { scale: 10 }]) assert.throws(() => editDocument(original, { type: "state", path: [0, 2], state: "hover", values }), DocumentValidationError);
  assert.throws(() => editDocument(original, { type: "state", path: [0, 2], state: "visited", values: { color: "#000" } }), /状態が不正/);
  assert.throws(() => editDocument(original, { type: "state", path: [0, 2, 0], state: "hover", values: { color: "#000" } }), /親要素/);
});

test("appear and hidden edits validate, follow locks and business block permissions", () => {
  const original = doc();
  const appear = { effect: "fade-up", trigger: "view", duration: 800, delay: 0, easing: "ease-out" };
  const next = editDocument(original, { type: "appear", path: [0], value: appear });
  assert.deepEqual(nodeAt(next, [0]).style.appear, appear);
  assert.equal(nodeAt(editDocument(next, { type: "appear", path: [0], value: undefined }), [0]).style.appear, undefined);
  assert.throws(() => editDocument(original, { type: "appear", path: [0], value: { ...appear, duration: 5000 } }), DocumentValidationError);
  const hidden = editDocument(original, { type: "hidden", path: [0, 1], ranges: [{ minWidth: 768, maxWidth: 1279 }] });
  assert.deepEqual(nodeAt(hidden, [0, 1]).style, { hidden: [{ minWidth: 768, maxWidth: 1279 }] });
  assert.equal(nodeAt(editDocument(hidden, { type: "hidden", path: [0, 1], ranges: [] }), [0, 1]).style.hidden, undefined);
  assert.throws(() => editDocument(original, { type: "hidden", path: [0, 1], ranges: [{ minWidth: 1280 }, { minWidth: 768 }] }), DocumentValidationError);
  const locks = [{ nodeId: "hero", fields: ["style"], reason: "ブランドで管理" }];
  for (const operation of [{ type: "appear", path: [0], value: appear }, { type: "hidden", path: [0], ranges: [{ minWidth: 0, maxWidth: 767 }] }, { type: "state", path: [0], state: "hover", values: { opacity: 0.8 } }]) {
    assert.throws(() => editDocument(original, operation, {}, locks), /ブランドで管理/);
  }
  const blocks = { Notice: { props: {}, component: () => null, styleProperties: ["backgroundColor", "states"] } };
  const block = doc(); block.body.push({ type: "component", id: "notice", block: "Notice", props: {} });
  assert.deepEqual(nodeAt(editDocument(block, { type: "state", path: [1], state: "hover", values: { backgroundColor: "#eef3ef" } }, blocks), [1]).style.states, { hover: { backgroundColor: "#eef3ef" } });
  for (const operation of [{ type: "appear", path: [1], value: appear }, { type: "hidden", path: [1], ranges: [{ minWidth: 1280 }] }]) {
    assert.throws(() => editDocument(block, operation, blocks), /このブロックでは変更できない見た目です。/);
  }
  const open = { Notice: { ...blocks.Notice, styleProperties: ["appear", "hidden"] } };
  assert.ok(nodeAt(editDocument(block, { type: "appear", path: [1], value: appear }, open), [1]).style.appear);
  assert.throws(() => editDocument(block, { type: "state", path: [1], state: "hover", values: { color: "#000" } }, open), /このブロックでは変更できない見た目です。/);
});

test("deleting a token detaches state references and usage lists them", () => {
  const original = editDocument(doc(), { type: "state", path: [0, 2], state: "hover", values: { color: { token: "ink" } } });
  assert.deepEqual(tokenUsage(original, "ink").nodes.map(({ nodeId, state }) => [nodeId, state]), [["hero", undefined], ["link", "hover"]]);
  const detached = editDocument(original, { type: "token", name: "ink", token: undefined });
  assert.equal(nodeAt(detached, [0, 2]).style.states.hover.color, "#172d25");
});

test("hidden tiers convert to merged width ranges and back", () => {
  const tiers = editorTiers(doc());
  assert.deepEqual(rangesForTiers(tiers, [768]), [{ minWidth: 768, maxWidth: 1279 }]);
  assert.deepEqual(rangesForTiers(tiers, ["base", 768]), [{ minWidth: 0, maxWidth: 1279 }]);
  assert.deepEqual(rangesForTiers(tiers, ["base", 1280]), [{ minWidth: 0, maxWidth: 767 }, { minWidth: 1280 }]);
  assert.deepEqual(rangesForTiers(tiers, [768, 1280]), [{ minWidth: 768 }]);
  assert.deepEqual(rangesForTiers(tiers, []), []);
  for (const keys of [[768], ["base", 1280], [768, 1280], ["base", 768, 1280]]) {
    assert.deepEqual(hiddenTiers({ style: { hidden: rangesForTiers(tiers, keys) } }, tiers), keys);
  }
  assert.deepEqual(hiddenTiers({ style: { hidden: [{ minWidth: 800, maxWidth: 1000 }] } }, tiers), []);
  const node = { style: { hidden: [{ minWidth: 768, maxWidth: 1279 }] } };
  assert.deepEqual([375, 768, 1279, 1280].map((width) => hiddenAt(node, width)), [false, true, true, false]);
});
