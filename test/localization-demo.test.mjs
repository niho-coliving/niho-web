import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

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
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(errors.length, 0, errors.map(String).join("\n"));
  assert.match(dom.window.document.getElementById("root")?.textContent ?? "", /合成データの多言語編集デモ/);
  assert.match(dom.window.document.body.textContent ?? "", /NIHO Web/);
  dom.window.close();
});
