import assert from "node:assert/strict";
import { test } from "node:test";
import { commitHistory, editDocument, travelHistory, validateReleasePlan } from "../dist/editor-model.js";
import { walkNodes } from "../dist/node-tree.js";
import {
  ATELIER_TARGET, atelierBlocks, atelierBuilderDefinition, createAtelierHost, initialAtelierLibrary
} from "../examples/atelier-builder-host.mjs";

test("third-site builder performs insert, hierarchy move, style, motion, history, CAS reload and SSR", () => {
  const host = createAtelierHost();
  const original = host.readDocument(ATELIER_TARGET);
  const inserted = host.createInsertion("atelier-card");
  let history = { past: [], present: original.document, future: [] };
  const apply = (operation) => { history = commitHistory(history, editDocument(history.present, operation, atelierBlocks, [], initialAtelierLibrary)); };

  apply({ type: "add", parentId: "atelier_main", node: inserted });
  let insertedPath = walkNodes(history.present).find(({ node }) => node.type !== "text" && node.id === inserted.id)?.path;
  assert.deepEqual(insertedPath, [0, 5]);
  apply({ type: "move", path: [0, 3], parentId: inserted.id, index: 2 });
  insertedPath = walkNodes(history.present).find(({ node }) => node.type !== "text" && node.id === inserted.id)?.path;
  assert.deepEqual(walkNodes(history.present).find(({ node }) => node.type !== "text" && node.id === "atelier_note")?.path, [...insertedPath, 2]);
  apply({ type: "styles", path: insertedPath, breakpoint: "base", values: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } });
  const motion = atelierBuilderDefinition.motions.find((entry) => entry.id === "atelier-soft-rise");
  assert.ok(motion);
  apply({ type: "motionPreset", path: insertedPath, style: motion.style });
  const changed = history.present;
  history = travelHistory(history, "undo", atelierBlocks, [], initialAtelierLibrary);
  assert.equal(walkNodes(history.present).find(({ node }) => node.type !== "text" && node.id === inserted.id)?.node.style?.states, undefined);
  history = travelHistory(history, "redo", atelierBlocks, [], initialAtelierLibrary);
  assert.deepEqual(history.present, changed);

  const saved = host.saveDraft({ target: ATELIER_TARGET, document: history.present, expectedVersion: original.version });
  assert.equal(saved.status, "saved");
  assert.equal(host.saveDraft({ target: ATELIER_TARGET, document: history.present, expectedVersion: original.version }).status, "conflict");
  const reloaded = host.readDocument(ATELIER_TARGET);
  assert.equal(reloaded.version, saved.version);
  assert.ok(walkNodes(reloaded.document).some(({ node }) => node.type !== "text" && node.id === inserted.id));

  const componentSnapshot = host.readLibrary("atelier");
  const releaseRequest = { target: ATELIER_TARGET, expectedVersion: reloaded.version, action: "publish", componentsVersion: componentSnapshot.version };
  const plan = host.prepareRelease(releaseRequest);
  assert.equal(plan.domain, "https://atelier.example.test");
  assert.doesNotThrow(() => validateReleasePlan(plan, releaseRequest, host.listSites()[0]));
  assert.equal(host.release({ ...plan, confirmationToken: "wrong" }).status, "conflict");
  assert.equal(host.release(plan).status, "released");
  const html = host.renderDraft();
  assert.match(html, /Atelier Moku/);
  assert.match(html, /今週の制作/);
  assert.match(html, /手で考える場所/);
  assert.match(html, /atelier-image\.svg/);
  assert.match(html, /grid-template-columns/);
  assert.match(html, /translate/);
});

test("atelier host rejects target, document, block and release mismatches", () => {
  const host = createAtelierHost();
  const snapshot = host.readDocument(ATELIER_TARGET);
  assert.throws(() => host.readDocument({ ...ATELIER_TARGET, siteId: "kamakura" }), /invalid target/);
  assert.throws(() => host.saveDraft({ target: ATELIER_TARGET, expectedVersion: snapshot.version, document: { ...snapshot.document, siteId: "experience" } }), /invalid target|another site/);
  assert.throws(() => host.saveDraft({ target: ATELIER_TARGET, expectedVersion: snapshot.version, document: { ...snapshot.document, body: [{ type: "component", id: "bad", block: "Unknown", props: {} }] } }), /unknown|registered|block/i);
  assert.throws(() => host.prepareRelease({ target: ATELIER_TARGET, expectedVersion: snapshot.version, action: "publish", componentsVersion: "atelier-components-999" }), /release target mismatch/);
});
