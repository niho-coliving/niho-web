import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, parsePageDocument, parsePageMeta } from "@niho/web/core";
import { parsePageMeta as parseFromRoot } from "@niho/web";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);

test("page meta is copied in a stable key order without retaining input references", () => {
  const input = { ...doc(), meta: { structuredData: ["organization"], noindex: true, favicon: "/favicon.ico", ogImage: { alt: "", src: "https://cdn.example.test/cover.jpg" }, description: "海のそばの暮らし" } };
  const result = parsePageDocument(input);
  assert.deepEqual(Object.keys(result), ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "body"]);
  assert.deepEqual(Object.keys(result.meta), ["description", "ogImage", "favicon", "noindex", "structuredData"]);
  assert.deepEqual(Object.keys(result.meta.ogImage), ["src", "alt"]);
  input.meta.structuredData.push("changed"); input.meta.ogImage.src = "/changed.jpg";
  assert.deepEqual(result.meta.structuredData, ["organization"]); assert.equal(result.meta.ogImage.src, "https://cdn.example.test/cover.jpg");
  assert.deepEqual(parsePageMeta({ ogImage: { src: "/cover.webp", alt: "表紙" } }), { ogImage: { src: "/cover.webp", alt: "表紙" } });
  assert.equal(parseFromRoot, parsePageMeta);
});

test("the social cover can reference a library asset instead of a URL", () => {
  const input = { ...doc(), meta: { ogImage: { alt: "海辺のリビング", asset: { id: "ast_01", provider: "uploads" } } } };
  const result = parsePageDocument(input);
  assert.deepEqual(result.meta.ogImage, { asset: { provider: "uploads", id: "ast_01" }, alt: "海辺のリビング" });
  assert.deepEqual(Object.keys(result.meta.ogImage), ["asset", "alt"]);
  input.meta.ogImage.asset.id = "changed";
  assert.equal(result.meta.ogImage.asset.id, "ast_01");
  assert.deepEqual(parsePageMeta({ ogImage: { asset: { provider: "cms", id: "photo-1" }, alt: "" } }), { ogImage: { asset: { provider: "cms", id: "photo-1" }, alt: "" } });
});

test("empty meta and empty values are omitted from the document", () => {
  assert.equal("meta" in parsePageDocument({ ...doc(), meta: {} }), false);
  assert.equal("meta" in parsePageDocument({ ...doc(), meta: { noindex: false, structuredData: [] } }), false);
  assert.deepEqual(parsePageDocument({ ...doc(), meta: { noindex: false, description: "説明" } }).meta, { description: "説明" });
  assert.deepEqual(parsePageDocument(doc()), fixture);
});

test("page meta rejects unsafe URLs, anchors, multi-line text, duplicates and unknown keys", () => {
  for (const [meta, path] of [
    [{ ogImage: { src: "javascript:alert(1)", alt: "" } }, "$.meta.ogImage.src"],
    [{ ogImage: { src: "http://example.test/a.jpg", alt: "" } }, "$.meta.ogImage.src"],
    [{ ogImage: { src: "//evil.example/a.jpg", alt: "" } }, "$.meta.ogImage.src"],
    [{ favicon: "#top" }, "$.meta.favicon"],
    [{ favicon: "data:image/png;base64,AAAA" }, "$.meta.favicon"],
    [{ description: "   " }, "$.meta.description"],
    [{ description: "一行目\n二行目" }, "$.meta.description"],
    [{ description: "あ".repeat(501) }, "$.meta.description"],
    [{ ogImage: { src: "/a.jpg" } }, "$.meta.ogImage.alt"],
    [{ ogImage: { src: "/a.jpg", alt: "a".repeat(301) } }, "$.meta.ogImage.alt"],
    [{ ogImage: { src: "/a.jpg", alt: "", width: 1200 } }, "$.meta.ogImage"],
    [{ ogImage: { alt: "" } }, "$.meta.ogImage"],
    [{ ogImage: { src: "/a.jpg", asset: { provider: "uploads", id: "cover" }, alt: "" } }, "$.meta.ogImage"],
    [{ ogImage: { asset: { provider: "uploads", id: "../cover" }, alt: "" } }, "$.meta.ogImage.asset.id"],
    [{ ogImage: { asset: { provider: "uploads", id: "cover", src: "/a.jpg" }, alt: "" } }, "$.meta.ogImage.asset"],
    [{ ogImage: { asset: { provider: "uploads", id: "cover" } } }, "$.meta.ogImage.alt"],
    [{ structuredData: ["organization", "organization"] }, "$.meta.structuredData"],
    [{ structuredData: ["1bad"] }, "$.meta.structuredData[0]"],
    [{ structuredData: Array.from({ length: 17 }, (_, index) => `type${index}`) }, "$.meta.structuredData"],
    [{ structuredData: "organization" }, "$.meta.structuredData"],
    [{ noindex: "yes" }, "$.meta.noindex"],
    [{ script: "alert(1)" }, "$.meta"],
    [[], "$.meta"]
  ]) assert.throws(() => parsePageDocument({ ...doc(), meta }), (error) => error instanceof DocumentValidationError && error.path === path, JSON.stringify(meta).slice(0, 80));
  assert.doesNotThrow(() => parsePageDocument({ ...doc(), meta: { description: "あ".repeat(500), ogImage: { src: "/a.jpg", alt: "" } } }));
});
