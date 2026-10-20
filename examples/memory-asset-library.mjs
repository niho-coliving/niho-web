import { assetKey, collectAssetReferences } from "@niho/web/assets";

// 公開可能なインメモリ動作例。認証・保存・検査・使用状況の集計という、ホスト境界の振る舞いだけを再現する。
const failure = (status, message) => Object.assign(new Error(message), { status });
const kindOf = (type) => type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type === "application/pdf" ? "pdf" : "other";
const validText = (value, max, allowEmpty = false) => typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
const sameReference = (left, right) => left?.provider === right?.provider && left?.id === right?.id;

/**
 * @param {{ siteId: string, provider?: string, seed?: object[], folders?: { id: string, name: string }[], quota?: { limitBytes: number, usedBytes?: number },
 *   upload?: { accept: string[], maxBytes: number }, documents?: () => { pageId: string, locale: string, title: string, state: "draft" | "published", document: object }[],
 *   store?: (file: Blob, meta: { id: string, name: string, mimeType: string, bytes: number }) => Promise<{ src: string, thumbnailUrl?: string, width?: number, height?: number }> }} options
 * seed の各要素は LibraryAsset の項目と配信用の src。siteId を省略するとこのサイトの素材になる。quota.usedBytes は素材以外の使用量。
 */
export function createMemoryAssetLibrary({ siteId, provider = "uploads", seed = [], folders = [], quota, upload, documents = () => [], store = async (_file, meta) => ({ src: `/media/${meta.id}` }) }) {
  let counter = 0, revision = 1, folderCounter = 0;
  const entries = seed.map(({ src, ...asset }) => ({ src, asset: { provider, siteId, kind: kindOf(asset.mimeType), status: "ready", alt: "", version: "1", updatedAt: "2026-10-01T09:00:00.000Z", ...asset } }));
  const folderList = folders.map((folder) => ({ id: folder.id, name: folder.name }));
  const own = (entry) => entry.asset.siteId === siteId;
  const find = (reference) => entries.find((entry) => own(entry) && sameReference(entry.asset, reference));
  const usages = (reference) => documents().flatMap(({ pageId, locale, title, state, document }) =>
    collectAssetReferences(document).some((placement) => sameReference(placement.reference, reference)) ? [{ pageId, locale, title, state }] : []);
  const usedBytes = () => (quota?.usedBytes ?? 0) + entries.filter(own).reduce((sum, entry) => sum + entry.asset.bytes, 0);
  const copy = (entry) => ({ ...entry.asset, usageCount: usages(entry.asset).length });
  // 認証済みホストはリクエストのサイト権限を毎回確かめる。
  const check = (request, signal) => { signal?.throwIfAborted(); if (request?.siteId !== siteId) throw failure(403, "forbidden"); };
  return {
    async listAssets(query, signal) {
      check(query, signal);
      const offset = query.cursor === undefined ? 0 : Number(query.cursor), limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 60, 1), 200);
      if (!Number.isSafeInteger(offset) || offset < 0) throw failure(400, "invalid cursor");
      const search = String(query.search ?? "").toLowerCase();
      const matched = entries.filter((entry) => own(entry) && (query.kind === "all" || entry.asset.kind === query.kind) &&
        (query.folderId == null || entry.asset.folderId === query.folderId) && entry.asset.name.toLowerCase().includes(search));
      return {
        assets: matched.slice(offset, offset + limit).map(copy), folders: folderList.map((folder) => ({ ...folder })),
        ...(quota ? { quota: { usedBytes: usedBytes(), limitBytes: quota.limitBytes } } : {}),
        ...(upload ? { upload: { accept: [...upload.accept], maxBytes: upload.maxBytes } } : {}),
        ...(offset + limit < matched.length ? { nextCursor: String(offset + limit) } : {})
      };
    },
    async uploadAsset(request, signal) {
      check(request, signal);
      if (!upload) return { status: "rejected", reason: "permission" };
      // クライアントの事前確認とは別に、受け取った内容で再検査する。
      const bytes = request.file.size;
      if (!upload.accept.includes(request.mimeType) || request.file.type !== request.mimeType) return { status: "rejected", reason: "type" };
      if (bytes > upload.maxBytes) return { status: "rejected", reason: "size" };
      if (quota && usedBytes() + bytes > quota.limitBytes) return { status: "rejected", reason: "quota" };
      if (request.bytes !== bytes || !validText(request.name, 200) || (request.folderId !== null && !folderList.some((folder) => folder.id === request.folderId))) return { status: "rejected", reason: "invalid" };
      let id;
      do id = `asset-${++counter}`; while (entries.some((entry) => entry.asset.id === id));
      const stored = await store(request.file, { id, name: request.name, mimeType: request.mimeType, bytes });
      const asset = {
        provider, id, siteId, kind: kindOf(request.mimeType), status: "ready", name: request.name, mimeType: request.mimeType, bytes,
        ...(stored.width ? { width: stored.width } : {}), ...(stored.height ? { height: stored.height } : {}), alt: "",
        ...(request.folderId ? { folderId: request.folderId } : {}), ...(stored.thumbnailUrl ? { thumbnailUrl: stored.thumbnailUrl } : {}),
        version: String(++revision), updatedAt: new Date().toISOString()
      };
      entries.unshift({ src: stored.src, asset });
      return { status: "uploaded", asset: { ...asset, usageCount: 0 } };
    },
    async updateAsset(request, signal) {
      check(request, signal);
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
        const entry = reference?.provider === provider ? find(reference) : undefined;
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
}
