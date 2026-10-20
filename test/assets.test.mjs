import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, parsePageDocument } from "@niho/web/core";
import {
  ASSET_LIMITS, INSERTABLE_IMAGE_TYPES, assetErrorReason, assetKey, collectAssetReferences, formatBytes, isInsertableImage, missingAssetReferences,
  parseAssetDeleteResult, parseAssetListResult, parseAssetUpdateResult, parseAssetUploadResult, parseAssetUsages, parseLibraryAsset, parseResolvedAssets, uniqueAssetReferences
} from "@niho/web/assets";
import { createMemoryAssetLibrary } from "../examples/memory-asset-library.mjs";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const asset = (extra = {}) => ({ provider: "uploads", id: "sea", siteId: "demo", kind: "image", status: "ready", name: "海.webp", mimeType: "image/webp", bytes: 250880, width: 1200, height: 800, alt: "朝の海", version: "v1", updatedAt: "2026-10-01T09:00:00Z", ...extra });
const listing = (extra = {}) => ({ assets: [asset()], folders: [{ id: "photos", name: "写真" }], ...extra });
const signal = new AbortController().signal;
const png = (name, size) => new File([new Uint8Array(size)], name, { type: "image/png" });

test("resolved asset maps accept only provider:id keys and safe public media URLs", () => {
  const input = { "uploads:sea.webp": { src: "/media/sea.webp", width: 1200, height: 800 }, "cms:hero-1": { src: "https://cdn.example.com/a.webp" } };
  const result = parseResolvedAssets(input);
  assert.deepEqual(result, input);
  input["uploads:sea.webp"].src = "/changed.webp";
  assert.equal(result["uploads:sea.webp"].src, "/media/sea.webp");
  for (const map of [null, [], "x", { sea: { src: "/a.webp" } }, { "1x:a": { src: "/a.webp" } }, { "uploads:": { src: "/a.webp" } }, { "uploads:a:b": { src: "/a.webp" } },
    { "uploads:../a": { src: "/a.webp" } }, { "uploads:a": { src: "javascript:alert(1)" } }, { "uploads:a": { src: "data:image/png;base64,AAAA" } },
    { "uploads:a": { src: "http://example.com/a.png" } }, { "uploads:a": { src: "#a" } }, { "uploads:a": { src: '/a.png") ;x' } }, { "uploads:a": { src: "//evil.example/a.png" } },
    { "uploads:a": { src: "/a.png", width: 0 } }, { "uploads:a": { src: "/a.png", height: 1.5 } }, { "uploads:a": { src: "/a.png", srcset: "/b.png" } }, { "uploads:a": "/a.png" },
    JSON.parse('{"__proto__":{"src":"/a.png"}}')]) assert.throws(() => parseResolvedAssets(map), DocumentValidationError, JSON.stringify(map));
  const many = Object.fromEntries(Array.from({ length: ASSET_LIMITS.resolvedAssets + 1 }, (_, index) => [`uploads:a${index}`, { src: "/a.png" }]));
  assert.throws(() => parseResolvedAssets(many), DocumentValidationError);
});

test("asset references are collected from images and every background breakpoint", () => {
  const doc = structuredClone(fixture);
  doc.body[0].style.base.backgroundImage = { asset: { provider: "uploads", id: "wave" } };
  doc.body[0].style.responsive[0].declarations.backgroundImage = { asset: { provider: "cms", id: "hero" } };
  doc.body[0].children.push({ type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "sea" }, attrs: { alt: "" }, children: [] },
    { type: "element", id: "again", tag: "img", asset: { provider: "uploads", id: "wave" }, attrs: { alt: "" }, children: [] });
  const document = parsePageDocument(doc);
  assert.deepEqual(collectAssetReferences(document), [
    { reference: { provider: "uploads", id: "wave" }, nodeId: "hero", target: "background", breakpoint: "base" },
    { reference: { provider: "cms", id: "hero" }, nodeId: "hero", target: "background", breakpoint: 768 },
    { reference: { provider: "uploads", id: "sea" }, nodeId: "photo", target: "image", breakpoint: "base" },
    { reference: { provider: "uploads", id: "wave" }, nodeId: "again", target: "image", breakpoint: "base" }
  ]);
  assert.deepEqual(uniqueAssetReferences(document).map(assetKey), ["cms:hero", "uploads:sea", "uploads:wave"]);
  assert.deepEqual(missingAssetReferences(document, parseResolvedAssets({ "uploads:sea": { src: "/sea.webp" } })).map(assetKey), ["cms:hero", "uploads:wave"]);
  assert.deepEqual(missingAssetReferences(parsePageDocument(fixture), {}), []);
});

test("library responses reject other sites, unsafe thumbnails, duplicates and unknown fields", () => {
  const result = parseAssetListResult(listing({ quota: { usedBytes: 12, limitBytes: 10 }, upload: { accept: ["image/png"], maxBytes: 1 }, nextCursor: "60" }), "demo");
  assert.deepEqual(result.assets[0], asset());
  assert.deepEqual(result.quota, { usedBytes: 12, limitBytes: 10 });
  assert.throws(() => parseAssetListResult(listing({ assets: [asset({ siteId: "other" })] }), "demo"), /別サイトの素材は利用できません/);
  for (const invalid of [
    listing({ assets: [asset({ thumbnailUrl: "javascript:alert(1)" })] }), listing({ assets: [asset({ thumbnailUrl: "#x" })] }), listing({ assets: [asset({ thumbnailUrl: "http://example.com/a.png" })] }),
    listing({ assets: [asset(), asset()] }), listing({ assets: [asset({ src: "/a.png" })] }), listing({ extra: true }), listing({ folders: [{ id: "a", name: "A", parent: "b" }] }),
    listing({ folders: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }), listing({ assets: [asset({ kind: "font" })] }), listing({ assets: [asset({ status: "deleted" })] }),
    listing({ assets: [asset({ name: "  " })] }), listing({ assets: [asset({ name: "a\nb" })] }), listing({ assets: [asset({ mimeType: "image/svg xml" })] }), listing({ assets: [asset({ bytes: -1 })] }),
    listing({ assets: [asset({ width: 0 })] }), listing({ assets: [asset({ alt: "a".repeat(1001) })] }), listing({ assets: [asset({ updatedAt: "yesterday" })] }), listing({ assets: [asset({ version: "" })] }),
    listing({ assets: [asset({ id: "../sea" })] }), listing({ assets: [asset({ provider: "up:loads" })] }), listing({ quota: { usedBytes: -1, limitBytes: 1 } }),
    listing({ upload: { accept: ["image/*"], maxBytes: 1 } }), listing({ upload: { accept: ["image/png"], maxBytes: 0 } }), listing({ nextCursor: "" }), { assets: [] }
  ]) assert.throws(() => parseAssetListResult(invalid, "demo"), DocumentValidationError, JSON.stringify(invalid).slice(0, 120));
  assert.throws(() => parseLibraryAsset(asset({ siteId: "other" }), "demo"), /別サイト/);
  assert.deepEqual(parseAssetUsages([{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "published" }]), [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "published" }]);
  assert.throws(() => parseAssetUsages([{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "archived" }]), DocumentValidationError);
  assert.equal(parseAssetUploadResult({ status: "uploaded", asset: asset() }, "demo").asset.id, "sea");
  assert.deepEqual(parseAssetUploadResult({ status: "rejected", reason: "scan" }, "demo"), { status: "rejected", reason: "scan" });
  assert.deepEqual(parseAssetUpdateResult({ status: "conflict" }, "demo"), { status: "conflict" });
  assert.deepEqual(parseAssetDeleteResult({ status: "in-use", usages: [] }), { status: "in-use", usages: [] });
  for (const [parse, value] of [[parseAssetUploadResult, { status: "uploaded", asset: asset({ siteId: "other" }) }], [parseAssetUploadResult, { status: "rejected", reason: "virus" }],
    [parseAssetUpdateResult, { status: "conflict", asset: asset() }], [parseAssetUpdateResult, { status: "rejected", reason: "quota" }], [parseAssetDeleteResult, { status: "gone" }],
    [parseAssetDeleteResult, { status: "rejected", reason: "invalid" }], [parseAssetDeleteResult, { status: "deleted", usages: [] }]]) assert.throws(() => parse(value, "demo"), DocumentValidationError);
});

test("only ready allowlisted images are insertable and sizes and errors are classified", () => {
  assert.deepEqual([...INSERTABLE_IMAGE_TYPES], ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
  assert.equal(isInsertableImage(asset()), true);
  for (const extra of [{ status: "processing" }, { kind: "pdf", mimeType: "application/pdf" }, { kind: "video", mimeType: "video/mp4" }, { mimeType: "image/svg+xml" }, { mimeType: "image/tiff" }]) assert.equal(isInsertableImage(asset(extra)), false);
  assert.deepEqual([0, 512, 1024, 250880, 3.4 * 1024 ** 2, 1.6 * 1024 ** 3, 10 * 1024 ** 3, 1048575].map(formatBytes), ["0 B", "512 B", "1 KB", "245 KB", "3.4 MB", "1.6 GB", "10 GB", "1 MB"]);
  assert.deepEqual([403, 413, 415, 507, 409, 500].map((status) => assetErrorReason({ status })), ["permission", "size", "type", "quota", "conflict", "unknown"]);
  assert.equal(assetErrorReason(new Error("offline")), "unknown"); assert.equal(assetErrorReason(null), "unknown");
});

test("the in-memory library enforces the host boundary for sites, uploads, versions, usage and resolution", async () => {
  let pages = [];
  const library = createMemoryAssetLibrary({
    siteId: "demo", seed: [{ id: "sea", name: "海.png", mimeType: "image/png", bytes: 600, width: 600, height: 400, src: "/media/sea.png" },
      { id: "wip", name: "処理中.png", mimeType: "image/png", bytes: 10, status: "processing", src: "/media/wip.png" },
      { id: "foreign", siteId: "other", name: "他サイト.png", mimeType: "image/png", bytes: 10, src: "/media/foreign.png" }],
    quota: { limitBytes: 1000 }, upload: { accept: ["image/png"], maxBytes: 500 }, documents: () => pages,
    store: async (_file, meta) => ({ src: `/media/${meta.id}.png`, width: 10, height: 10 })
  });
  const listed = parseAssetListResult(await library.listAssets({ siteId: "demo", search: "", kind: "all", folderId: null, limit: 60 }, signal), "demo");
  assert.deepEqual(listed.assets.map((item) => item.id), ["sea", "wip"]); assert.deepEqual(listed.quota, { usedBytes: 610, limitBytes: 1000 });
  assert.deepEqual((await library.listAssets({ siteId: "demo", search: "海", kind: "image", folderId: null, limit: 1 }, signal)).assets.map((item) => item.id), ["sea"]);
  const paged = await library.listAssets({ siteId: "demo", search: "", kind: "all", folderId: null, limit: 1 }, signal);
  assert.equal(paged.nextCursor, "1"); assert.deepEqual((await library.listAssets({ siteId: "demo", search: "", kind: "all", folderId: null, cursor: "1", limit: 1 }, signal)).assets.map((item) => item.id), ["wip"]);
  for (const call of [() => library.listAssets({ siteId: "other", search: "", kind: "all", folderId: null, limit: 60 }, signal), () => library.resolveAssets({ siteId: "other", references: [] }, signal),
    () => library.uploadAsset({ siteId: "other", folderId: null, file: png("a.png", 1), name: "a.png", mimeType: "image/png", bytes: 1 }, signal),
    () => library.deleteAsset({ siteId: "other", reference: { provider: "uploads", id: "sea" }, expectedVersion: "1" }, signal)]) await assert.rejects(call, (error) => error.status === 403);
  const upload = (file, extra = {}) => library.uploadAsset({ siteId: "demo", folderId: null, file, name: file.name, mimeType: file.type, bytes: file.size, ...extra }, signal);
  assert.deepEqual(await upload(new File(["%PDF"], "a.pdf", { type: "application/pdf" })), { status: "rejected", reason: "type" });
  assert.deepEqual(await upload(png("a.png", 10), { mimeType: "image/jpeg" }), { status: "rejected", reason: "type" });
  assert.deepEqual(await upload(png("big.png", 501)), { status: "rejected", reason: "size" });
  assert.deepEqual(await upload(png("ok.png", 400)), { status: "rejected", reason: "quota" });
  assert.deepEqual(await upload(png("ok.png", 10), { bytes: 1 }), { status: "rejected", reason: "invalid" });
  const added = parseAssetUploadResult(await upload(png("新しい.png", 100)), "demo");
  assert.equal(added.status, "uploaded"); assert.equal(added.asset.name, "新しい.png"); assert.equal(added.asset.width, 10);
  const reference = { provider: "uploads", id: added.asset.id };
  assert.deepEqual(await library.updateAsset({ siteId: "demo", reference, expectedVersion: "stale", changes: { alt: "x" } }, signal), { status: "conflict" });
  const saved = parseAssetUpdateResult(await library.updateAsset({ siteId: "demo", reference, expectedVersion: added.asset.version, changes: { alt: "説明" } }, signal), "demo");
  assert.equal(saved.asset.alt, "説明"); assert.notEqual(saved.asset.version, added.asset.version);
  const resolved = parseResolvedAssets(await library.resolveAssets({ siteId: "demo", references: [reference, { provider: "uploads", id: "foreign" }, { provider: "uploads", id: "wip" }, { provider: "cms", id: "sea" }, { provider: "uploads", id: "missing" }] }, signal));
  assert.deepEqual(resolved, { [`uploads:${added.asset.id}`]: { src: `/media/${added.asset.id}.png`, width: 10, height: 10 } });
  const used = structuredClone(fixture); used.body[0].children.push({ type: "element", id: "photo", tag: "img", asset: reference, attrs: { alt: "" }, children: [] });
  pages = [{ pageId: "about", locale: "ja-JP", title: "紹介", state: "published", document: parsePageDocument(used) }];
  assert.deepEqual(await library.listAssetUsages({ siteId: "demo", reference }, signal), [{ pageId: "about", locale: "ja-JP", title: "紹介", state: "published" }]);
  const inUse = parseAssetDeleteResult(await library.deleteAsset({ siteId: "demo", reference, expectedVersion: saved.asset.version }, signal));
  assert.equal(inUse.status, "in-use"); assert.equal(inUse.usages[0].state, "published");
  pages = [];
  assert.deepEqual(await library.deleteAsset({ siteId: "demo", reference, expectedVersion: added.asset.version }, signal), { status: "conflict" });
  assert.deepEqual(await library.deleteAsset({ siteId: "demo", reference, expectedVersion: saved.asset.version }, signal), { status: "deleted" });
  assert.deepEqual(await library.resolveAssets({ siteId: "demo", references: [reference] }, signal), {});
});
