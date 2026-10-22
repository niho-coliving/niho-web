import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function loadKamakuraAssetLibrary() {
  const result = await build({
    entryPoints: [new URL("../studio/kamakura-assets.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import("data:text/javascript;base64," + source);
}

test("Kamakura upload previews require the upstream resolver to confirm each reference", async (t) => {
  const { kamakuraAssetLibrary } = await loadKamakuraAssetLibrary();
  const existingId = "123e4567-e89b-12d3-a456-426614174000";
  const missingId = "123e4567-e89b-12d3-a456-426614174001";
  const existingKey = "kamakura-upload:" + existingId;
  const references = [
    { provider: "kamakura-upload", id: existingId },
    { provider: "kamakura-upload", id: missingId },
    { provider: "kamakura-cms", id: "published-image" },
    { provider: "kamakura-approved-remote", id: "r-" + "a".repeat(40) },
    { provider: "unknown-provider", id: "ignored" }
  ];
  let requestedReferences;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "/api/projects/project-kamakura/sites/kamakura/editor/assets/resolve");
    requestedReferences = JSON.parse(init.body).references;
    return new Response(JSON.stringify({
      [existingKey]: { src: "https://cdn.example.com/draft.webp" },
      "kamakura-cms:published-image": { src: "https://cdn.example.com/published.webp" },
      ["kamakura-approved-remote:r-" + "a".repeat(40)]: { src: "https://images.unsplash.com/photo-approved" }
    }), { headers: { "Content-Type": "application/json" } });
  });

  const resolved = await kamakuraAssetLibrary.resolveAssets({ siteId: "kamakura", references }, new AbortController().signal);
  assert.deepEqual(requestedReferences, references.slice(0, -1));
  assert.deepEqual(resolved, {
    [existingKey]: { src: "/api/projects/project-kamakura/sites/kamakura/editor/assets/" + existingId + "/preview" },
    "kamakura-cms:published-image": { src: "https://cdn.example.com/published.webp" },
    ["kamakura-approved-remote:r-" + "a".repeat(40)]: { src: "https://images.unsplash.com/photo-approved" }
  });
});
