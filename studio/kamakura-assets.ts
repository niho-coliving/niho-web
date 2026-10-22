import {
  parseAssetListResult, parseAssetProviders, parseAssetUpdateResult, parseAssetUploadResult, parseAssetUsages,
  parseResolvedAssets, assetKey,
  type AssetLibraryAdapter, type AssetListQuery, type AssetProvider, type AssetReference, type AssetUploadRequest
} from "../src/assets.js";

const SITE_ID = "kamakura";
const UPLOAD_PROVIDER = "kamakura-upload";
const PROVIDER_IDS = new Set([UPLOAD_PROVIDER, "kamakura-studio", "kamakura-cms", "kamakura-approved-remote"]);
const BASE = "/api/projects/project-kamakura/sites/kamakura/editor/assets";
const UPLOAD_ORIGIN = "https://next-kamakura.niho.life";
const UPLOAD_PATH = /^\/internal\/studio\/asset-upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

class KamakuraAssetApiError extends Error {
  constructor(readonly status: number) {
    super("Kamakura asset request failed");
  }
}

function assertSite(siteId: string): void {
  if (siteId !== SITE_ID) throw new Error("編集対象のサイトが一致しません。");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("素材 API の応答が正しくありません。");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(), keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error("素材 API の応答が正しくありません。");
}

function previewUrl(assetId: string): string {
  return `${BASE}/${encodeURIComponent(assetId)}/preview`;
}

function withAuthenticatedPreview<T extends { readonly provider: string; readonly id: string; readonly thumbnailUrl?: string }>(asset: T): T {
  return asset.provider === UPLOAD_PROVIDER ? { ...asset, thumbnailUrl: previewUrl(asset.id) } : asset;
}

async function post(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let response: Response;
  try {
    response = await fetch(`${BASE}/${path}`, {
      method: "POST", signal, cache: "no-store", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new KamakuraAssetApiError(503);
  const value = await response.json() as unknown;
  if (!response.ok) throw new KamakuraAssetApiError(response.status);
  return value;
}

function provider(reference: AssetReference): boolean {
  return PROVIDER_IDS.has(reference.provider);
}

function parseUploadIntent(input: unknown, expectedProvider: string): { readonly uploadUrl: string; readonly uploadToken: string; readonly assetId: string } {
  const value = record(input);
  exactKeys(value, ["uploadUrl", "uploadToken", "assetId"]);
  if (typeof value.uploadUrl !== "string" || value.uploadUrl.length > 2048 || typeof value.uploadToken !== "string" || value.uploadToken.length < 1 || value.uploadToken.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.uploadToken)) throw new Error("アップロード開始情報が正しくありません。");
  if (typeof value.assetId !== "string") throw new Error("アップロード開始情報が正しくありません。");
  const parsed = new URL(value.uploadUrl);
  const match = UPLOAD_PATH.exec(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.origin !== UPLOAD_ORIGIN || parsed.username || parsed.password || parsed.search || parsed.hash || !match || match[1]!.toLowerCase() !== value.assetId.toLowerCase()) throw new Error("アップロード先が正しくありません。");
  if (expectedProvider !== UPLOAD_PROVIDER) throw new Error("アップロード元が正しくありません。");
  return { uploadUrl: value.uploadUrl, uploadToken: value.uploadToken, assetId: value.assetId };
}

const PROVIDERS: AssetProvider[] = parseAssetProviders([
  { id: UPLOAD_PROVIDER, kind: "upload", label: "NIHO Studio", origin: "Kamakura Studio", status: "available", capabilities: { upload: true, editMetadata: true, delete: false, folders: false, acquire: false } },
  { id: "kamakura-studio", kind: "cms", label: "Kamakura Studio", origin: "Kamakura Studio", status: "available", capabilities: { upload: false, editMetadata: false, delete: false, folders: false, acquire: false } },
  { id: "kamakura-cms", kind: "cms", label: "Kamakura CMS", origin: "Kamakura CMS", status: "available", capabilities: { upload: false, editMetadata: false, delete: false, folders: false, acquire: false } },
  { id: "kamakura-approved-remote", kind: "cms", label: "承認済み外部素材", origin: "Kamakura", status: "available", capabilities: { upload: false, editMetadata: false, delete: false, folders: false, acquire: false } }
]);

export const kamakuraAssetLibrary: AssetLibraryAdapter = {
  async listAssets(query: AssetListQuery, signal: AbortSignal) {
    assertSite(query.siteId);
    const result = parseAssetListResult(await post("list", {
      siteId: SITE_ID, search: query.search, kind: query.kind, folderId: query.folderId, limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.provider === undefined ? {} : { provider: query.provider }),
      ...(query.recent === undefined ? {} : { recent: query.recent })
    }, signal), SITE_ID);
    if (result.assets.some((asset) => !PROVIDER_IDS.has(asset.provider) || query.provider !== undefined && asset.provider !== query.provider)) throw new Error("素材一覧に対象外の出所が含まれています。");
    return { ...result, assets: result.assets.map(withAuthenticatedPreview), folders: [] };
  },

  async uploadAsset(request: AssetUploadRequest, signal: AbortSignal) {
    assertSite(request.siteId);
    const providerId = request.provider ?? UPLOAD_PROVIDER;
    if (providerId !== UPLOAD_PROVIDER || request.folderId !== null || request.file.size !== request.bytes || request.file.type !== request.mimeType || !IMAGE_TYPES.has(request.mimeType)) return { status: "rejected", reason: "invalid" };

    const intent = parseUploadIntent(await post("upload-intent", {
      siteId: SITE_ID, folderId: null, name: request.name, mimeType: request.mimeType, bytes: request.bytes, provider: providerId
    }, signal), providerId);
    const response = await fetch(intent.uploadUrl, {
      method: "PUT", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", signal,
      headers: { Authorization: `Bearer ${intent.uploadToken}`, "Content-Type": request.mimeType },
      body: request.file
    });
    if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new KamakuraAssetApiError(503);
    const value = record(await response.json() as unknown);
    if (!response.ok) throw new KamakuraAssetApiError(response.status);
    exactKeys(value, ["asset"]);
    const result = parseAssetUploadResult({ status: "uploaded", asset: value.asset }, SITE_ID);
    if (result.status !== "uploaded" || result.asset.provider !== UPLOAD_PROVIDER || result.asset.id.toLowerCase() !== intent.assetId.toLowerCase() || result.asset.bytes !== request.bytes || result.asset.mimeType !== request.mimeType) throw new Error("アップロード結果が正しくありません。");
    return { status: "uploaded", asset: withAuthenticatedPreview(result.asset) };
  },

  async updateAsset(request, signal) {
    assertSite(request.siteId);
    if (request.reference.provider !== UPLOAD_PROVIDER || Object.hasOwn(request.changes, "folderId")) return { status: "rejected", reason: "permission" };
    const result = parseAssetUpdateResult(await post("update", {
      siteId: SITE_ID, reference: request.reference, expectedVersion: request.expectedVersion, changes: request.changes
    }, signal), SITE_ID);
    if (result.status !== "saved") return result;
    if (result.asset.provider !== UPLOAD_PROVIDER || result.asset.id !== request.reference.id) throw new Error("更新結果が対象素材と一致しません。");
    return { ...result, asset: withAuthenticatedPreview(result.asset) };
  },

  async listAssetUsages(request, signal) {
    assertSite(request.siteId);
    if (!provider(request.reference)) throw new Error("素材の出所が一致しません。");
    return parseAssetUsages(await post("usages", { siteId: SITE_ID, reference: request.reference }, signal));
  },

  async deleteAsset() {
    return { status: "rejected", reason: "permission" };
  },

  async resolveAssets(request, signal) {
    assertSite(request.siteId);
    const supported = request.references.filter(provider);
    const resolved = supported.length
      ? parseResolvedAssets(await post("resolve", { siteId: SITE_ID, references: supported }, signal))
      : {};
    const requested = new Set(supported.map(assetKey));
    if (Object.keys(resolved).some((key) => !requested.has(key) || !PROVIDER_IDS.has(key.slice(0, key.indexOf(":"))))) throw new Error("素材解決結果に対象外の参照が含まれています。");
    const result: Record<string, { src: string; width?: number; height?: number }> = {};
    for (const reference of supported) {
      const key = assetKey(reference);
      if (!Object.hasOwn(resolved, key)) continue;
      result[key] = reference.provider === UPLOAD_PROVIDER ? { src: previewUrl(reference.id) } : resolved[key]!;
    }
    return result;
  },

  async listProviders(request, signal) {
    assertSite(request.siteId);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return PROVIDERS;
  }
};
