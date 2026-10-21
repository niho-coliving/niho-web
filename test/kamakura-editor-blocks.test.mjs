import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { test } from "node:test";
import { parsePageDocument } from "../dist/document.js";

async function loadEditorBlocks() {
  const directory = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.tmp-kamakura-editor-blocks-"));
  const outfile = path.join(directory, "blocks.mjs");
  try {
    await build({
      entryPoints: [new URL("../studio/kamakura-editor-blocks.tsx", import.meta.url).pathname],
      bundle: true,
      external: ["react", "react/jsx-runtime"],
      format: "esm",
      platform: "node",
      target: "node22",
      outfile
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const { createKamakuraEditorBlocks } = await loadEditorBlocks();
const contracts = {
  KamakuraLegacyForm: {
    props: { formId: { type: "enum", values: ["community-dinner", "parenting", "remotework"] } },
    slots: {
      form: { label: "体験予約フォーム", style: ["backgroundColor", "color", "padding", "borderRadius"] },
      field: { label: "フォーム入力欄", style: ["backgroundColor", "color", "borderColor", "borderRadius", "padding"] },
      submit: { label: "送信ボタン", style: ["color", "backgroundColor", "borderRadius", "padding"] }
    }
  },
  FutureServiceBlock: { props: {}, slots: { frame: { label: "外部枠", style: ["width", "height"] } } }
};
const blocks = createKamakuraEditorBlocks(contracts);

test("catalog-provided block contracts let existing Kamakura documents parse and remain editable", () => {
  const title = "Kamakura: Community Dinner with Locals  | NIHO kamakura -- Shared living-room in Kamakura, where tourists and locals can get together";
  const document = parsePageDocument({
    schemaVersion: 1,
    siteId: "kamakura",
    pageId: "kamakura-community-dinner",
    locale: "ja",
    revision: 1,
    title,
    tokens: {},
    body: [{ type: "component", id: "dinner-form", block: "KamakuraLegacyForm", props: { formId: "community-dinner" }, slots: { form: { base: { padding: "12px" } } } }]
  }, blocks);
  assert.equal(document.title, title);
  assert.equal(document.body[0].block, "KamakuraLegacyForm");
  assert.equal("KamakuraLegacyForm" in blocks, true);
  assert.equal("FutureServiceBlock" in blocks, true);
});

test("known and future block previews expose style slots without running site behavior", () => {
  for (const [name, definition] of Object.entries(blocks)) {
    const preview = definition.preview ?? definition.component;
    const html = renderToStaticMarkup(createElement(preview, { formId: "community-dinner" }));
    assert.match(html, /安全な表示サンプル/u, name);
    assert.doesNotMatch(html, /<(?:form|iframe|input|button)\b/iu, name);
    for (const slotName of Object.keys(contracts[name].slots ?? {})) assert.match(html, new RegExp(`data-nw-slot="${slotName}"`, "u"), `${name}:${slotName}`);
  }
});
