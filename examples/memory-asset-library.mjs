import { assetKey, collectAssetReferences } from "@niho/web/assets";

// 公開可能なインメモリ動作例。認証・保存・検査・使用状況の集計という、ホスト境界の振る舞いだけを再現する。
const failure = (status, message) => Object.assign(new Error(message), { status });
const kindOf = (type) => type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type === "application/pdf" ? "pdf" : "other";
const validText = (value, max, allowEmpty = false) => typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
const sameReference = (left, right) => left?.provider === right?.provider && left?.id === right?.id;

/**
 * @param {{ siteId: string, provider?: string, seed?: object[], folders?: { id: string, name: string }[], quota?: { limitBytes: number, usedBytes?: number },
 *   upload?: { accept: string[], maxBytes: number }, documents?: () => { pageId: string, locale: string, title: string, state: "draft" | "published", document: object }[],
 *   store?: (file: Blob, meta: { id: string, name: string, mimeType: string, bytes: number }) => Promise<{ src: string, thumbnailUrl?: string, width?: number, height?: number }>,
 *   providers?: { id: string, kind: "upload" | "cms" | "stock", label: string, origin: string, terms?: string, status: "available" | "unavailable", unavailableReason?: string,
 *     capabilities: { upload: boolean, editMetadata: boolean, delete: boolean, folders: boolean, acquire: boolean }, seed?: object[] }[] }} options
 * seed の各要素は LibraryAsset の項目と配信用の src。siteId を省略するとこのサイトの素材になる。quota.usedBytes は素材以外の使用量。
 * providers を渡すと出所ごとの素材になり、listProviders・acquireAsset と、出所側の非公開化を再現する setPublished を持つ。
 * CMS の seed は published（既定 true）を持てる。非公開の素材は一覧・解決・取得に出さない。
 */
export function createMemoryAssetLibrary({ siteId, provider = "uploads", seed = [], folders = [], quota, upload, documents = () => [], store = async (_file, meta) => ({ src: `/media/${meta.id}` }), providers }) {
  let counter = 0, revision = 1, folderCounter = 0;
  const sources = providers ? providers.map(({ seed: _seed, ...item }) => ({ ...item, capabilities: { ...item.capabilities } })) : [];
  const entry = (owner) => ({ src, published = true, ...asset }) => ({ src, published, asset: { provider: owner, siteId, kind: kindOf(asset.mimeType), status: "ready", alt: "", version: "1", updatedAt: "2026-10-01T09:00:00.000Z", ...asset } });
  const entries = [...seed.map(entry(provider)), ...(providers ?? []).flatMap((item) => (item.seed ?? []).map(entry(item.id)))];
  const folderList = folders.map((folder) => ({ id: folder.id, name: folder.name }));
  const sourceOf = (id) => sources.find((item) => item.id === id);
  const own = (entry) => entry.asset.siteId === siteId;
  // 未接続の出所と、出所で非公開にした素材は存在しない扱いにする。
  const visible = (entry) => own(entry) && entry.published && (!providers || sourceOf(entry.asset.provider)?.status === "available");
  const find = (reference) => entries.find((entry) => visible(entry) && sameReference(entry.asset, reference));
  const usages = (reference) => documents().flatMap(({ pageId, locale, title, state, document }) =>
    collectAssetReferences(document).some((placement) => sameReference(placement.reference, reference)) ? [{ pageId, locale, title, state }] : []);
  // 容量に数えるのはサイトへ保存した素材だけ。
  const usedBytes = () => (quota?.usedBytes ?? 0) + entries.filter((entry) => own(entry) && (!providers || sourceOf(entry.asset.provider)?.kind === "upload")).reduce((sum, entry) => sum + entry.asset.bytes, 0);
  const copy = (entry) => ({ ...entry.asset, usageCount: usages(entry.asset).length, ...(entry.asset.license ? { license: { ...entry.asset.license } } : {}) });
  const nextId = () => { let id; do id = `asset-${++counter}`; while (entries.some((entry) => entry.asset.id === id)); return id; };
  // 出所の権限は、UI の表示とは別にホストが毎回確かめる。
  const denied = (reference, capability) => !!providers && !sourceOf(reference?.provider)?.capabilities[capability];
  // 認証済みホストはリクエストのサイト権限を毎回確かめる。
  const check = (request, signal) => { signal?.throwIfAborted(); if (request?.siteId !== siteId) throw failure(403, "forbidden"); };
  const library = {
    async listAssets(query, signal) {
      check(query, signal);
      const offset = query.cursor === undefined ? 0 : Number(query.cursor), limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 60, 1), 200);
      if (!Number.isSafeInteger(offset) || offset < 0) throw failure(400, "invalid cursor");
      const scope = !providers ? undefined : sources.filter((item) => item.status === "available" && (query.provider === undefined || item.id === query.provider));
      if (scope && !scope.length) return { assets: [], folders: [] };
      const search = String(query.search ?? "").toLowerCase();
      let matched = entries.filter((entry) => visible(entry) && (!scope || scope.some((item) => item.id === entry.asset.provider)) && (query.kind === "all" || entry.asset.kind === query.kind) &&
        (query.folderId == null || entry.asset.folderId === query.folderId) && entry.asset.name.toLowerCase().includes(search));
      if (query.recent === true) {
        // 文書で参照されている順に並べ、参照されていない素材は除く。
        const order = [...new Set(documents().flatMap(({ document }) => collectAssetReferences(document).map(({ reference }) => assetKey(reference))))];
        matched = matched.filter((entry) => order.includes(assetKey(entry.asset))).sort((a, b) => order.indexOf(assetKey(a.asset)) - order.indexOf(assetKey(b.asset)));
      }
      const uploadable = upload && (!scope || scope.some((item) => item.capabilities.upload));
      return {
        assets: matched.slice(offset, offset + limit).map(copy), folders: folderList.map((folder) => ({ ...folder })),
        ...(quota ? { quota: { usedBytes: usedBytes(), limitBytes: quota.limitBytes } } : {}),
        ...(uploadable ? { upload: { accept: [...upload.accept], maxBytes: upload.maxBytes } } : {}),
        ...(offset + limit < matched.length ? { nextCursor: String(offset + limit) } : {})
      };
    },
    async uploadAsset(request, signal) {
      check(request, signal);
      const target = providers ? sourceOf(request.provider) : undefined;
      if (!upload || (providers && (target?.status !== "available" || !target.capabilities.upload))) return { status: "rejected", reason: "permission" };
      // クライアントの事前確認とは別に、受け取った内容で再検査する。
      const bytes = request.file.size;
      if (!upload.accept.includes(request.mimeType) || request.file.type !== request.mimeType) return { status: "rejected", reason: "type" };
      if (bytes > upload.maxBytes) return { status: "rejected", reason: "size" };
      if (quota && usedBytes() + bytes > quota.limitBytes) return { status: "rejected", reason: "quota" };
      if (request.bytes !== bytes || !validText(request.name, 200) || (request.folderId !== null && !folderList.some((folder) => folder.id === request.folderId))) return { status: "rejected", reason: "invalid" };
      const id = nextId(), stored = await store(request.file, { id, name: request.name, mimeType: request.mimeType, bytes });
      const asset = {
        provider: target?.id ?? provider, id, siteId, kind: kindOf(request.mimeType), status: "ready", name: request.name, mimeType: request.mimeType, bytes,
        ...(stored.width ? { width: stored.width } : {}), ...(stored.height ? { height: stored.height } : {}), alt: "",
        ...(request.folderId ? { folderId: request.folderId } : {}), ...(stored.thumbnailUrl ? { thumbnailUrl: stored.thumbnailUrl } : {}),
        version: String(++revision), updatedAt: new Date().toISOString()
      };
      entries.unshift({ src: stored.src, published: true, asset });
      return { status: "uploaded", asset: { ...asset, usageCount: 0 } };
    },
    async updateAsset(request, signal) {
      check(request, signal);
      if (denied(request.reference, "editMetadata")) return { status: "rejected", reason: "permission" };
      const entry = find(request.reference);
      if (!entry) return { status: "rejected", reason: "invalid" };
      if (entry.asset.version !== request.expectedVersion) return { status: "conflict" };
      const { name, alt, folderId } = request.changes ?? {};
      if (name !== undefined && !validText(name, 200) || alt !== undefined && !validText(alt, 1000, true) ||
        folderId !== undefined && folderId !== null && !folderList.some((folder) => folder.id === folderId)) return { status: "rejected", reason: "invalid" };
      const next = { ...entry.asset, ...(name === undefined ? {} : { name }), ...(alt === undefined ? {} : { alt }), version: String(++revision), updatedAt: new Date().toISOString() };
      if (folderId === null) delete next.folderId; else if (folderId !== undefined) next.folderId = folderId;
      entry.asset = next;
      return { status: "saved", asset: copy(entry) };
    },
    async listAssetUsages(request, signal) {
      check(request, signal);
      return usages(request.reference);
    },
    async deleteAsset(request, signal) {
      check(request, signal);
      if (denied(request.reference, "delete")) return { status: "rejected", reason: "permission" };
      const entry = find(request.reference);
      if (!entry || entry.asset.version !== request.expectedVersion) return { status: "conflict" };
      // 下書き・公開版のどちらかで使われていれば削除しない。
      const used = usages(request.reference);
      if (used.length) return { status: "in-use", usages: used };
      entries.splice(entries.indexOf(entry), 1);
      return { status: "deleted" };
    },
    async resolveAssets(request, signal) {
      check(request, signal);
      const result = {};
      for (const reference of request.references ?? []) {
        const entry = providers || reference?.provider === provider ? find(reference) : undefined;
        if (!entry || entry.asset.status !== "ready" || !entry.src) continue;
        result[assetKey(entry.asset)] = { src: entry.src, ...(entry.asset.width ? { width: entry.asset.width } : {}), ...(entry.asset.height ? { height: entry.asset.height } : {}) };
      }
      return result;
    },
    async createFolder(request, signal) {
      check(request, signal);
      if (!validText(request.name, 120)) throw failure(400, "invalid folder name");
      let id;
      do id = `folder-${++folderCounter}`; while (folderList.some((folder) => folder.id === id));
      const folder = { id, name: request.name.trim() };
      folderList.push(folder);
      return { ...folder };
    }
  };
  if (!providers) return library;
  return {
    ...library,
    async listProviders(request, signal) {
      check(request, signal);
      return sources.map((item) => ({ ...item, capabilities: { ...item.capabilities } }));
    },
    async acquireAsset(request, signal) {
      check(request, signal);
      const entry = find(request.reference), from = entry && sourceOf(entry.asset.provider);
      if (!entry || !from) return { status: "rejected", reason: "unavailable" };
      if (entry.asset.version !== request.expectedVersion) throw failure(409, "conflict");
      if (from.kind !== "stock") return { status: "ready", asset: copy(entry) };
      // ストックはライセンスを記録したサイトの素材へ複製し、文書にはストック側の参照を残さない。
      if (!entry.asset.license) return { status: "rejected", reason: "license" };
      const target = sources.find((item) => item.kind === "upload" && item.status === "available");
      if (!target) return { status: "rejected", reason: "unavailable" };
      const key = assetKey(entry.asset), existing = entries.find((item) => visible(item) && item.acquiredFrom === key && item.asset.provider === target.id);
      if (existing) return { status: "ready", asset: copy(existing) };
      const { name, mimeType, bytes, width, height, alt, thumbnailUrl, license } = entry.asset;
      const asset = {
        provider: target.id, id: nextId(), siteId, kind: kindOf(mimeType), status: "ready", name, mimeType, bytes, ...(width ? { width } : {}), ...(height ? { height } : {}), alt,
        ...(thumbnailUrl ? { thumbnailUrl } : {}), version: String(++revision), updatedAt: new Date().toISOString(), sourceLabel: `「${from.label}」から取り込んだ素材`, license: { ...license }
      };
      entries.unshift({ src: entry.src, published: true, asset, acquiredFrom: key });
      return { status: "ready", asset: { ...asset, license: { ...license }, usageCount: 0 } };
    },
    /** テスト・デモ用。出所（CMS 等）側で公開・非公開を切り替えた状態を再現する。 */
    setPublished(reference, value) {
      const entry = entries.find((item) => own(item) && sameReference(item.asset, reference));
      if (entry) entry.published = !!value;
    }
  };
}
