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
  dimension: 100000,
  providers: 20,
  providerLabelLength: 40,
  originLength: 300,
  termsLength: 1000,
  unavailableReasonLength: 300,
  sourceLabelLength: 200,
  licenseNameLength: 200,
  attributionLength: 300
});
export const INSERTABLE_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] as const);

/** ホストが発行した配信 URL。文書には保存しない。 */
export type ResolvedAsset = { src: string; width?: number; height?: number };
/** キーは assetKey()。 */
export type ResolvedAssetMap = Readonly<Record<string, ResolvedAsset>>;
/** ogImage = 文書の meta.ogImage（ソーシャルカバー）。ノードを持たない。 */
export type AssetPlacement =
  | { reference: AssetReference; nodeId: string; target: "image" | "background"; breakpoint: number | "base" }
  | { reference: AssetReference; target: "ogImage" };

export type AssetKind = "image" | "video" | "pdf" | "other";
/** processing = ホストの検査・変換中。配置不可。 */
export type AssetStatus = "ready" | "processing";
export type AssetLicense = { name: string; url?: string; attribution?: string; terms?: string };
export type LibraryAsset = {
  provider: string; id: string; siteId: string; kind: AssetKind; status: AssetStatus; name: string; mimeType: string; bytes: number;
  width?: number; height?: number; alt: string; folderId?: string; thumbnailUrl?: string; usageCount?: number; version: string; updatedAt: string;
  /** 出所での説明（例: 体験「鎌倉の朝ヨガ」の写真）。 */
  sourceLabel?: string; license?: AssetLicense;
};
export type AssetProviderKind = "upload" | "cms" | "stock";
/** acquire = 配置の前に acquireAsset でホストが利用可能にする（ライセンスの記録・取り込み等）。 */
export type AssetProviderCapabilities = { upload: boolean; editMetadata: boolean; delete: boolean; folders: boolean; acquire: boolean };
/** 素材の出所。id は AssetReference.provider と同じ値。 */
export type AssetProvider = {
  id: string; kind: AssetProviderKind; label: string; origin: string; terms?: string;
  status: "available" | "unavailable"; unavailableReason?: string; capabilities: AssetProviderCapabilities;
};
export type AssetFolder = { id: string; name: string };
export type AssetQuota = { usedBytes: number; limitBytes: number };
/** 無ければアップロード不可。 */
export type AssetUploadPolicy = { accept: readonly string[]; maxBytes: number };
/** provider 省略 = 利用可能なすべての出所。recent = 最近使った素材。 */
export type AssetListQuery = { siteId: string; search: string; kind: AssetKind | "all"; folderId: string | null; cursor?: string; limit: number; provider?: string; recent?: boolean };
export type AssetListResult = { assets: readonly LibraryAsset[]; folders: readonly AssetFolder[]; quota?: AssetQuota; upload?: AssetUploadPolicy; nextCursor?: string };
export type AssetRejectReason = "permission" | "quota" | "type" | "size" | "scan" | "invalid";
/** provider は listProviders がある場合に必ず送る。 */
export type AssetUploadRequest = { siteId: string; folderId: string | null; file: Blob; name: string; mimeType: string; bytes: number; provider?: string };
export type AssetUploadResult = { status: "uploaded"; asset: LibraryAsset } | { status: "rejected"; reason: AssetRejectReason };
export type AssetUpdateRequest = { siteId: string; reference: AssetReference; expectedVersion: string; changes: { name?: string; alt?: string; folderId?: string | null } };
export type AssetUpdateResult = { status: "saved"; asset: LibraryAsset } | { status: "conflict" } | { status: "rejected"; reason: "permission" | "invalid" };
export type AssetUsage = { pageId: string; locale: string; title: string; state: "draft" | "published" };
export type AssetDeleteResult = { status: "deleted" } | { status: "in-use"; usages: readonly AssetUsage[] } | { status: "conflict" } | { status: "rejected"; reason: "permission" };
/** ready の素材は元と別の出所・ID でもよい（ストックをサイトの素材へ取り込む等）。 */
export type AssetAcquireResult = { status: "ready"; asset: LibraryAsset } | { status: "rejected"; reason: "permission" | "license" | "unavailable" };
/** 認証・保存先・ウイルス検査・配信 URL 発行・使用状況の集計は認証済みホストの責務。 */
export interface AssetLibraryAdapter {
  listAssets(query: AssetListQuery, signal: AbortSignal): Promise<AssetListResult>;
  uploadAsset(request: AssetUploadRequest, signal: AbortSignal): Promise<AssetUploadResult>;
  updateAsset(request: AssetUpdateRequest, signal: AbortSignal): Promise<AssetUpdateResult>;
  listAssetUsages(request: { siteId: string; reference: AssetReference }, signal: AbortSignal): Promise<readonly AssetUsage[]>;
  deleteAsset(request: { siteId: string; reference: AssetReference; expectedVersion: string }, signal: AbortSignal): Promise<AssetDeleteResult>;
  resolveAssets(request: { siteId: string; references: readonly AssetReference[] }, signal: AbortSignal): Promise<ResolvedAssetMap>;
  /** listProviders がある場合は選択中の出所を必ず送る。 */
  createFolder?(request: { siteId: string; name: string; provider?: string }, signal: AbortSignal): Promise<AssetFolder>;
  /** 実装すると、素材パネルを出所ごとに分け、応答の素材を宣言済みの出所だけに限る。 */
  listProviders?(request: { siteId: string }, signal: AbortSignal): Promise<readonly AssetProvider[]>;
  acquireAsset?(request: { siteId: string; reference: AssetReference; expectedVersion: string }, signal: AbortSignal): Promise<AssetAcquireResult>;
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

/** 本文の画像・背景と、meta.ogImage の素材参照。使用状況・削除可否・保存時の所属確認に使う。 */
export function collectAssetReferences(document: PageDocument): AssetPlacement[] {
  const result: AssetPlacement[] = [];
  const copy = (reference: AssetReference): AssetReference => ({ provider: reference.provider, id: reference.id });
  const cover = document.meta?.ogImage;
  if (cover && "asset" in cover) result.push({ reference: copy(cover.asset), target: "ogImage" });
  function visit(nodes: readonly PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.type === "element" && node.asset) result.push({ reference: copy(node.asset), nodeId: node.id, target: "image", breakpoint: "base" });
      const base = node.style?.base?.backgroundImage;
      if (base && base !== "none") result.push({ reference: copy(base.asset), nodeId: node.id, target: "background", breakpoint: "base" });
      for (const entry of node.style?.responsive ?? []) {
        if (entry.declarations.backgroundImage && entry.declarations.backgroundImage !== "none") result.push({ reference: copy(entry.declarations.backgroundImage.asset), nodeId: node.id, target: "background", breakpoint: entry.minWidth });
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

const assetFields = ["provider", "id", "siteId", "kind", "status", "name", "mimeType", "bytes", "width", "height", "alt", "folderId", "thumbnailUrl", "usageCount", "version", "updatedAt", "sourceLabel", "license"];
const optionalText = (value: unknown, path: string, maximum: number) => value === undefined ? undefined : text(value, path, maximum);
function parseLicense(input: unknown, path: string): AssetLicense {
  const value = record(input, path);
  keys(value, ["name", "url", "attribution", "terms"], path);
  // 利用条件のページは外部の HTTPS だけ。root relative と fragment は許可しない。
  if (value.url !== undefined && (!isSafePublicUrl(value.url) || !/^https:\/\//i.test(value.url))) fail(`${path}.url`, "unsafe license URL");
  const attribution = optionalText(value.attribution, `${path}.attribution`, ASSET_LIMITS.attributionLength), terms = optionalText(value.terms, `${path}.terms`, ASSET_LIMITS.termsLength);
  return { name: text(value.name, `${path}.name`, ASSET_LIMITS.licenseNameLength), ...(value.url === undefined ? {} : { url: value.url as string }), ...(attribution === undefined ? {} : { attribution }), ...(terms === undefined ? {} : { terms }) };
}
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
    version: text(value.version, `${path}.version`, ASSET_LIMITS.versionLength), updatedAt,
    ...(value.sourceLabel === undefined ? {} : { sourceLabel: text(value.sourceLabel, `${path}.sourceLabel`, ASSET_LIMITS.sourceLabelLength) }),
    ...(value.license === undefined ? {} : { license: parseLicense(value.license, `${path}.license`) })
  };
}
const capabilityNames = ["upload", "editMetadata", "delete", "folders", "acquire"] as const;
export function parseAssetProviders(input: unknown): AssetProvider[] {
  const seen = new Set<string>();
  return array(input, "providers", ASSET_LIMITS.providers).map((raw, index) => {
    const at = `providers[${index}]`, value = record(raw, at);
    keys(value, ["id", "kind", "label", "origin", "terms", "status", "unavailableReason", "capabilities"], at);
    const id = identifier(value.id, `${at}.id`);
    if (seen.has(id)) fail(`${at}.id`, "duplicate provider");
    seen.add(id);
    const source = record(value.capabilities, `${at}.capabilities`), capabilities = {} as AssetProviderCapabilities;
    keys(source, capabilityNames, `${at}.capabilities`);
    for (const name of capabilityNames) {
      if (typeof source[name] !== "boolean") fail(`${at}.capabilities.${name}`, "expected a boolean");
      capabilities[name] = source[name] as boolean;
    }
    const terms = optionalText(value.terms, `${at}.terms`, ASSET_LIMITS.termsLength), reason = optionalText(value.unavailableReason, `${at}.unavailableReason`, ASSET_LIMITS.unavailableReasonLength);
    return {
      id, kind: choice(value.kind, ["upload", "cms", "stock"] as const, `${at}.kind`), label: text(value.label, `${at}.label`, ASSET_LIMITS.providerLabelLength),
      origin: text(value.origin, `${at}.origin`, ASSET_LIMITS.originLength), ...(terms === undefined ? {} : { terms }),
      status: choice(value.status, ["available", "unavailable"] as const, `${at}.status`), ...(reason === undefined ? {} : { unavailableReason: reason }), capabilities
    };
  });
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
export function parseAssetAcquireResult(input: unknown, siteId: string): AssetAcquireResult {
  const value = status(input, "acquire", { ready: ["asset"], rejected: ["reason"] });
  return value.status === "ready" ? { status: "ready", asset: parseLibraryAsset(value.asset, siteId, "acquire.asset") }
    : { status: "rejected", reason: choice(value.reason, ["permission", "license", "unavailable"] as const, "acquire.reason") };
}
