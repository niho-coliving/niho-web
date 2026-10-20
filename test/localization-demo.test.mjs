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
  assert.match(dom.window.document.getElementById("root")?.textContent ?? "", /合成データの多言語編集・言語全体公開デモ/);
  assert.match(dom.window.document.body.textContent ?? "", /偽ホスト/);
  assert.match(dom.window.document.body.textContent ?? "", /次の言語公開を409にする/);
  assert.match(dom.window.document.body.textContent ?? "", /NIHO Web/);
  const document = dom.window.document;
  const button = (label, within = document) => [...within.querySelectorAll("button")].find((entry) => entry.textContent.trim() === label);
  const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 150; attempt++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.ok(condition(), "demo UI did not reach its expected state");
  };
  await waitFor(() => button("English（訳文）"));
  button("English（訳文）").click();
  await waitFor(() => button("言語全体の公開確認") && !button("言語全体の公開確認").disabled);
  button("言語全体の公開確認").click();
  await waitFor(() => document.querySelector('[role="dialog"]'));
  let dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /差し替えた画像の確認が必要/);
  assert.equal(button("この言語全体を公開", dialog).disabled, true, "an optional but manually replaced image still needs review");
  button("編集に戻る", dialog).click();
  await waitFor(() => !document.querySelector('[role="dialog"]'));
  const history = document.querySelector('select[aria-label="戻す言語全体版"]');
  history.closest("details").open = true;
  history.value = "kamakura-en-published-0";
  history.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await waitFor(() => !button("言語全体の復元内容を確認").disabled);
  button("言語全体の復元内容を確認").click();
  await waitFor(() => document.querySelector('[role="dialog"]'));
  dialog = document.querySelector('[role="dialog"]');
  assert.doesNotMatch(dialog.textContent, /まだ公開できません|未確認の項目/);
  const confirmation = dialog.querySelector('input[type="checkbox"]');
  assert.equal(confirmation.disabled, false, "unreviewed current drafts do not block restoring a prior approved release");
  confirmation.click();
  await waitFor(() => !button("この言語全体版を復元", dialog).disabled);
  button("この言語全体版を復元", dialog).click();
  await waitFor(() => [...document.querySelectorAll('[role="alert"]')].some((entry) => /復元しました/.test(entry.textContent)));
  dom.window.close();
});
