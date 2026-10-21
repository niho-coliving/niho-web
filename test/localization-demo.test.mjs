import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { collectLocalizationUnits } from "@niho/web/localization";

test("the actual bundled localization demo initializes in a DOM runtime", async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL("../examples/localization-demo.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://127.0.0.1:4176/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "DOMException", "AbortController"]) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const errors = [];
  dom.window.addEventListener("error", (event) => errors.push(event.error ?? event.message));
  const source = output.outputFiles[0].text;
  const { localizationDemoAdapter: adapter } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(errors.length, 0, errors.map(String).join("\n"));
  assert.match(dom.window.document.getElementById("root")?.textContent ?? "", /合成データの多言語編集デモ/);
  assert.match(dom.window.document.body.textContent ?? "", /NIHO Web/);
  const target = { siteId: "kamakura", pageId: "home", locale: "en-US" }, other = { ...target, pageId: "about" };
  const unitId = "component.siteHeader.node.sharedHome.text";
  const snapshot = await adapter.localization.readPage(target, new AbortController().signal);
  const entry = snapshot.overlay.entries.find((item) => item.unitId === unitId);
  assert.ok(entry);
  const site = await adapter.localization.readSite(target.siteId, new AbortController().signal);
  const library = await adapter.components.readLibrary(target.siteId, new AbortController().signal);
  const collection = await collectLocalizationUnits(site.config, snapshot.sourceDocument, "en", { components: library.library });
  const unit = collection.units.find((item) => item.unitId === unitId);
  const command = { target, unitId, expectedSourceVersion: snapshot.sourceVersion, expectedVersion: snapshot.version, expectedOverlayVersion: snapshot.overlay.version };
  assert.equal((await adapter.localization.command({ ...command, action: "set-value", value: "Shared navigation", sourceFingerprint: unit.sourceFingerprint, expectedEntryVersion: entry.version }, new AbortController().signal)).status, "applied");
  const changedOther = await adapter.localization.readPage(other, new AbortController().signal);
  assert.equal(changedOther.overlay.entries.find((item) => item.unitId === unitId).reviewedSourceFingerprint, undefined);
  const current = await adapter.localization.readPage(target, new AbortController().signal);
  assert.equal((await adapter.localization.command({ ...command, action: "review-current", expectedVersion: current.version, expectedOverlayVersion: current.overlay.version }, new AbortController().signal)).status, "applied");
  const reviewedOther = await adapter.localization.readPage(other, new AbortController().signal);
  const reviewedEntry = reviewedOther.overlay.entries.find((item) => item.unitId === unitId);
  assert.equal(reviewedEntry.draftValue, "Shared navigation");
  assert.equal(reviewedEntry.reviewedSourceFingerprint, unit.sourceFingerprint);
  assert.notEqual(reviewedOther.version, changedOther.version);
  const otherDocument = await adapter.readDocument(other, new AbortController().signal);
  assert.equal(otherDocument.document.pageId, "about");
  dom.window.close();
});
