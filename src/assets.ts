import type { AssetReference, PageDocument, PageNode } from "./types.js";
import { DocumentValidationError, assetId, fail, identifier, isSafePublicUrl, keys, record, string } from "./validation-utils.js";

export type { AssetReference } from "./types.js";
export const ASSET_LIMITS = Object.freeze({
  resolvedAssets: 5000,
  listAssets: 200,
  folders: 200,
  usages: 1000,
  uploadAccept: 50,
  pageSize: 60,
  nameLength: 200,
  folderNameLength: 120,
  altLength: 1000,
  mimeTypeLength: 100,
  versionLength: 200,
  cursorLength: 500,
  updatedAtLength: 40,
  titleLength: 300,
  dimension: 100000
});
export const INSERTABLE_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] as const);

/** ホストが発行した配信 URL。文書には保存しない。 */
export type ResolvedAsset = { src: string; width?: number; height?: number };
/** キーは assetKey()。 */
export type ResolvedAssetMap = Readonly<Record<string, ResolvedAsset>>;
export type AssetPlacement = { reference: AssetReference; nodeId: string; target: "image" | "background"; breakpoint: number | "base" };

export type AssetKind = "image" | "video" | "pdf" | "other";
/** processing = ホストの検査・変換中。配置不可。 */
export type AssetStatus = "ready" | "processing";
export type LibraryAsset = {
  provider: string; id: string; siteId: string; kind: AssetKind; status: AssetStatus; name: string; mimeType: string; bytes: number;
  width?: number; height?: number; alt: string; folderId?: string; thumbnailUrl?: string; usageCount?: number; version: string; updatedAt: string;
};
export type AssetFolder = { id: string; name: string };
export type AssetQuota = { usedBytes: number; limitBytes: number };
/** 無ければアップロード不可。 */
export type AssetUploadPolicy = { accept: readonly string[]; maxBytes: number };
export type AssetListQuery = { siteId: string; search: string; kind: AssetKind | "all"; folderId: string | null; cursor?: string; limit: number };
export type AssetListResult = { assets: readonly LibraryAsset[]; folders: readonly AssetFolder[]; quota?: AssetQuota; upload?: AssetUploadPolicy; nextCursor?: string };
export type AssetRejectReason = "permission" | "quota" | "type" | "size" | "scan" | "invalid";
export type AssetUploadRequest = { siteId: string; folderId: string | null; file: Blob; name: string; mimeType: string; bytes: number };
export type AssetUploadResult = { status: "uploaded"; asset: LibraryAsset } | { status: "rejected"; reason: AssetRejectReason };
export type AssetUpdateRequest = { siteId: string; reference: AssetReference; expectedVersion: string; changes: { name?: string; alt?: string; folderId?: string | null } };
export type AssetUpdateResult = { status: "saved"; asset: LibraryAsset } | { status: "conflict" } | { status: "rejected"; reason: "permission" | "invalid" };
export type AssetUsage = { pageId: string; locale: string; title: string; state: "draft" | "published" };
export type AssetDeleteResult = { status: "deleted" } | { status: "in-use"; usages: readonly AssetUsage[] } | { status: "conflict" } | { status: "rejected"; reason: "permission" };
/** 認証・保存先・ウイルス検査・配信 URL 発行・使用状況の集計は認証済みホストの責務。 */
export interface AssetLibraryAdapter {
  listAssets(query: AssetListQuery, signal: AbortSignal): Promise<AssetListResult>;
  uploadAsset(request: AssetUploadRequest, signal: AbortSignal): Promise<AssetUploadResult>;
  updateAsset(request: AssetUpdateRequest, signal: AbortSignal): Promise<AssetUpdateResult>;
  listAssetUsages(request: { siteId: string; reference: AssetReference }, signal: AbortSignal): Promise<readonly AssetUsage[]>;
  deleteAsset(request: { siteId: string; reference: AssetReference; expectedVersion: string }, signal: AbortSignal): Promise<AssetDeleteResult>;
  resolveAssets(request: { siteId: string; references: readonly AssetReference[] }, signal: AbortSignal): Promise<ResolvedAssetMap>;
  createFolder?(request: { siteId: string; name: string }, signal: AbortSignal): Promise<AssetFolder>;
}

/** provider は identifier なので : を含まず、キーは一意になる。 */
export const assetKey = (reference: AssetReference): string => `${reference.provider}:${reference.id}`;
function integer(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(path, "invalid integer");
  return value;
}
function text(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid string");
  return value;
}
function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, "invalid array");
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) fail(path, "unsupported value");
  return value as T;
}
function mimeType(value: unknown, path: string): string {
  const result = string(value, path, ASSET_LIMITS.mimeTypeLength);
  if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(result)) fail(path, "invalid MIME type");
  return result;
}
/** 引用符・空白・<> を含まない HTTPS / root relative URL。CSS の url("...") にもそのまま入る。 */
function mediaUrl(value: unknown, path: string): string {
  if (!isSafePublicUrl(value) || value.startsWith("#")) fail(path, "unsafe media URL");
  return value;
}
const dimension = (value: unknown, path: string) => integer(value, path, 1, ASSET_LIMITS.dimension);
function parseAssetKey(key: string, path: string): AssetReference {
  const index = key.indexOf(":");
  if (index < 1) fail(path, "invalid asset key");
  return { provider: identifier(key.slice(0, index), path), id: assetId(key.slice(index + 1), path) };
}

export function parseResolvedAssets(input: unknown): ResolvedAssetMap {
  const source = record(input, "assets"), names = Object.keys(source), result: Record<string, ResolvedAsset> = {};
  if (names.length > ASSET_LIMITS.resolvedAssets) fail("assets", "too many assets");
  names.forEach((key, index) => {
    const at = `assets[${index}]`;
    parseAssetKey(key, at);
    const value = record(source[key], at);
    keys(value, ["src", "width", "height"], at);
    result[key] = {
      src: mediaUrl(value.src, `${at}.src`),
      ...(value.width === undefined ? {} : { width: dimension(value.width, `${at}.width`) }),
      ...(value.height === undefined ? {} : { height: dimension(value.height, `${at}.height`) })
    };
  });
  return result;
}
export function resolvedAsset(assets: ResolvedAssetMap, reference: AssetReference): ResolvedAsset | undefined {
  const key = assetKey(reference);
  return Object.hasOwn(assets, key) ? assets[key] : undefined;
}

export function collectAssetReferences(document: PageDocument): AssetPlacement[] {
  const result: AssetPlacement[] = [];
  const copy = (reference: AssetReference): AssetReference => ({ provider: reference.provider, id: reference.id });
  function visit(nodes: readonly PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.type === "element" && node.asset) result.push({ reference: copy(node.asset), nodeId: node.id, target: "image", breakpoint: "base" });
      const base = node.style?.base?.backgroundImage;
      if (base) result.push({ reference: copy(base.asset), nodeId: node.id, target: "background", breakpoint: "base" });
      for (const entry of node.style?.responsive ?? []) {
        if (entry.declarations.backgroundImage) result.push({ reference: copy(entry.declarations.backgroundImage.asset), nodeId: node.id, target: "background", breakpoint: entry.minWidth });
      }
      if (node.type === "element") visit(node.children);
    }
  }
  visit(document.body);
  return result;
}
export function uniqueAssetReferences(document: PageDocument): AssetReference[] {
  const unique = new Map(collectAssetReferences(document).map(({ reference }) => [assetKey(reference), reference] as const));
  return [...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, reference]) => reference);
}
/** 公開前に、ホストが解決できない参照を確かめる。 */
export function missingAssetReferences(document: PageDocument, assets: ResolvedAssetMap): AssetReference[] {
  return uniqueAssetReferences(document).filter((reference) => !resolvedAsset(assets, reference));
}

export function isInsertableImage(asset: Pick<LibraryAsset, "kind" | "status" | "mimeType">): boolean {
  return asset.kind === "image" && asset.status === "ready" && (INSERTABLE_IMAGE_TYPES as readonly string[]).includes(asset.mimeType);
}
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (Math.round(value * 10) / 10 >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}
export function assetErrorReason(error: unknown): "permission" | "size" | "type" | "quota" | "conflict" | "unknown" {
  const status = !!error && typeof error === "object" && "status" in error ? error.status : undefined;
  return status === 403 ? "permission" : status === 413 ? "size" : status === 415 ? "type" : status === 507 ? "quota" : status === 409 ? "conflict" : "unknown";
}

const assetFields = ["provider", "id", "siteId", "kind", "status", "name", "mimeType", "bytes", "width", "height", "alt", "folderId", "thumbnailUrl", "usageCount", "version", "updatedAt"];
/** 要求した siteId 以外の素材は拒否する。 */
export function parseLibraryAsset(input: unknown, siteId: string, path = "asset"): LibraryAsset {
  const value = record(input, path);
  keys(value, assetFields, path);
  if (value.siteId !== siteId) throw new DocumentValidationError(`${path}.siteId`, "別サイトの素材は利用できません。");
  const updatedAt = string(value.updatedAt, `${path}.updatedAt`, ASSET_LIMITS.updatedAtLength);
  if (Number.isNaN(Date.parse(updatedAt))) fail(`${path}.updatedAt`, "invalid date");
  return {
    provider: identifier(value.provider, `${path}.provider`), id: assetId(value.id, `${path}.id`), siteId,
    kind: choice(value.kind, ["image", "video", "pdf", "other"] as const, `${path}.kind`),
    status: choice(value.status, ["ready", "processing"] as const, `${path}.status`),
    name: text(value.name, `${path}.name`, ASSET_LIMITS.nameLength), mimeType: mimeType(value.mimeType, `${path}.mimeType`),
    bytes: integer(value.bytes, `${path}.bytes`, 0),
    ...(value.width === undefined ? {} : { width: dimension(value.width, `${path}.width`) }),
    ...(value.height === undefined ? {} : { height: dimension(value.height, `${path}.height`) }),
    alt: text(value.alt, `${path}.alt`, ASSET_LIMITS.altLength, true),
    ...(value.folderId === undefined ? {} : { folderId: assetId(value.folderId, `${path}.folderId`) }),
    ...(value.thumbnailUrl === undefined ? {} : { thumbnailUrl: mediaUrl(value.thumbnailUrl, `${path}.thumbnailUrl`) }),
    ...(value.usageCount === undefined ? {} : { usageCount: integer(value.usageCount, `${path}.usageCount`, 0) }),
    version: text(value.version, `${path}.version`, ASSET_LIMITS.versionLength), updatedAt
  };
}
export function parseAssetFolder(input: unknown, path = "folder"): AssetFolder {
  const value = record(input, path);
  keys(value, ["id", "name"], path);
  return { id: assetId(value.id, `${path}.id`), name: text(value.name, `${path}.name`, ASSET_LIMITS.folderNameLength) };
}
export function parseAssetListResult(input: unknown, siteId: string): AssetListResult {
  const value = record(input, "list"), seen = new Set<string>(), folderIds = new Set<string>();
  keys(value, ["assets", "folders", "quota", "upload", "nextCursor"], "list");
  const assets = array(value.assets, "list.assets", ASSET_LIMITS.listAssets).map((raw, index) => {
    const asset = parseLibraryAsset(raw, siteId, `list.assets[${index}]`), key = assetKey(asset);
    if (seen.has(key)) fail(`list.assets[${index}]`, "duplicate asset");
    seen.add(key);
    return asset;
  });
  const folders = array(value.folders, "list.folders", ASSET_LIMITS.folders).map((raw, index) => {
    const folder = parseAssetFolder(raw, `list.folders[${index}]`);
    if (folderIds.has(folder.id)) fail(`list.folders[${index}]`, "duplicate folder");
    folderIds.add(folder.id);
    return folder;
  });
  let quota: AssetQuota | undefined, upload: AssetUploadPolicy | undefined;
  if (value.quota !== undefined) {
    const source = record(value.quota, "list.quota");
    keys(source, ["usedBytes", "limitBytes"], "list.quota");
    // 超過状態も表示できるよう used <= limit は要求しない。
    quota = { usedBytes: integer(source.usedBytes, "list.quota.usedBytes", 0), limitBytes: integer(source.limitBytes, "list.quota.limitBytes", 0) };
  }
  if (value.upload !== undefined) {
    const source = record(value.upload, "list.upload");
    keys(source, ["accept", "maxBytes"], "list.upload");
    upload = { accept: array(source.accept, "list.upload.accept", ASSET_LIMITS.uploadAccept).map((type, index) => mimeType(type, `list.upload.accept[${index}]`)), maxBytes: integer(source.maxBytes, "list.upload.maxBytes", 1) };
  }
  return {
    assets, folders, ...(quota ? { quota } : {}), ...(upload ? { upload } : {}),
    ...(value.nextCursor === undefined ? {} : { nextCursor: text(value.nextCursor, "list.nextCursor", ASSET_LIMITS.cursorLength) })
  };
}
export function parseAssetUsages(input: unknown, path = "usages"): AssetUsage[] {
  return array(input, path, ASSET_LIMITS.usages).map((raw, index) => {
    const at = `${path}[${index}]`, value = record(raw, at);
    keys(value, ["pageId", "locale", "title", "state"], at);
    const locale = string(value.locale, `${at}.locale`, 40);
    if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(locale)) fail(`${at}.locale`, "invalid locale");
    return { pageId: identifier(value.pageId, `${at}.pageId`), locale, title: text(value.title, `${at}.title`, ASSET_LIMITS.titleLength), state: choice(value.state, ["draft", "published"] as const, `${at}.state`) };
  });
}
function status(input: unknown, path: string, statuses: Readonly<Record<string, readonly string[]>>): Record<string, unknown> & { status: string } {
  const value = record(input, path);
  if (typeof value.status !== "string" || !Object.hasOwn(statuses, value.status)) fail(`${path}.status`, "unknown status");
  keys(value, ["status", ...statuses[value.status]!], path);
  return value as Record<string, unknown> & { status: string };
}
export function parseAssetUploadResult(input: unknown, siteId: string): AssetUploadResult {
  const value = status(input, "upload", { uploaded: ["asset"], rejected: ["reason"] });
  return value.status === "uploaded" ? { status: "uploaded", asset: parseLibraryAsset(value.asset, siteId, "upload.asset") }
    : { status: "rejected", reason: choice(value.reason, ["permission", "quota", "type", "size", "scan", "invalid"] as const, "upload.reason") };
}
export function parseAssetUpdateResult(input: unknown, siteId: string): AssetUpdateResult {
  const value = status(input, "update", { saved: ["asset"], conflict: [], rejected: ["reason"] });
  if (value.status === "saved") return { status: "saved", asset: parseLibraryAsset(value.asset, siteId, "update.asset") };
  return value.status === "conflict" ? { status: "conflict" } : { status: "rejected", reason: choice(value.reason, ["permission", "invalid"] as const, "update.reason") };
}
export function parseAssetDeleteResult(input: unknown): AssetDeleteResult {
  const value = status(input, "delete", { deleted: [], "in-use": ["usages"], conflict: [], rejected: ["reason"] });
  if (value.status === "deleted" || value.status === "conflict") return { status: value.status };
  return value.status === "in-use" ? { status: "in-use", usages: parseAssetUsages(value.usages, "delete.usages") } : { status: "rejected", reason: choice(value.reason, ["permission"] as const, "delete.reason") };
}
