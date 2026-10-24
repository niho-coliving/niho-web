"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ASSET_LIMITS, INSERTABLE_IMAGE_TYPES, assetErrorReason, assetKey, collectAssetReferences, formatBytes, isInsertableImage, parseAssetAcquireResult, parseAssetDeleteResult, parseAssetFolder,
  parseAssetListResult, parseAssetProviders, parseAssetUpdateResult, parseAssetUploadResult, parseAssetUsages, parseResolvedAssets, resolvedAsset, uniqueAssetReferences,
  type AssetFolder, type AssetKind, type AssetLibraryAdapter, type AssetListQuery, type AssetProvider, type AssetProviderKind, type AssetQuota, type AssetRejectReason, type AssetUpdateRequest,
  type AssetUploadPolicy, type AssetUsage, type LibraryAsset, type ResolvedAsset, type ResolvedAssetMap
} from "./assets.js";
import { metaLimits } from "./document.js";
import { nodeAt, walkNodes, type EditorOperation, type NodePath } from "./editor-model.js";
import type { AssetReference, ElementNode, PageDocument, StyleDeclarations, StyleProperty, StyleValue } from "./types.js";

/** ogImage = ページのソーシャルカバー。siteOgImage = サイト設定のソーシャルカバー（文書ではなくサイト設定の入力へ入れる）。 */
export type AssetPicker = { purpose: "image"; path: NodePath } | { purpose: "background"; path: NodePath; breakpoint: number | "base" } | { purpose: "replace"; from: AssetReference }
  | { purpose: "ogImage" } | { purpose: "siteOgImage" };
/** SNS のリンクプレビューが表示できる形式。AVIF は多くのサービスで表示されない。 */
export const SOCIAL_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif"] as const);
export function socialImageProblem(asset: Pick<LibraryAsset, "mimeType">): string | undefined {
  return (SOCIAL_IMAGE_TYPES as readonly string[]).includes(asset.mimeType) ? undefined : "ソーシャルカバーに使えるのは JPEG・PNG・WebP・GIF の画像です。";
}
/** 素材の代替テキストの初期値。公開情報の上限を超える場合は今の説明を残す。 */
export const coverAlt = (asset: Pick<LibraryAsset, "alt">, current: string): string => asset.alt && asset.alt.length <= metaLimits.altLength ? asset.alt : current;
export type AssetAction = "replace" | "background" | "insert" | "pick";
export type AssetLibraryPanelProps = {
  adapter: AssetLibraryAdapter; siteId: string; mode: "library" | "pick"; pickTitle?: string | undefined;
  /** Library rail can scope results to a declared provider class. Image pickers keep the full list. */
  providerKind?: AssetProviderKind | undefined; panelLabel?: string | undefined;
  /** 文書の再読込・公開のたびに増える値。変わったら出所と一覧を取り直す。 */
  epoch?: number;
  /** assetKey → 現在の文書内の使用数。 */
  localUsage: ReadonlyMap<string, number>;
  actions: { replace: boolean; background: boolean; insert: boolean };
  disabledReason?: string | undefined;
  /** 失敗時はエラー文言を返す。 */
  onApply: (asset: LibraryAsset, action: AssetAction) => string | undefined;
  onClose: () => void;
  onReplaceUsages: (asset: LibraryAsset) => void;
};

/** 配置先と素材から文書操作を作る。ページに追加は選択要素の中（子を持てない場合は直後）、選択なしは末尾。 */
export function assetPlacement(document: PageDocument, asset: LibraryAsset, target: Exclude<AssetPicker, { purpose: "siteOgImage" }> | { purpose: "insert"; selection: NodePath | null }): { operation: EditorOperation; select?: NodePath; notice?: string } {
  const reference: AssetReference = { provider: asset.provider, id: asset.id };
  if (target.purpose === "replace") {
    const cover = document.meta?.ogImage, problem = cover && "asset" in cover && assetKey(cover.asset) === assetKey(target.from) ? socialImageProblem(asset) : undefined;
    if (problem) throw new Error(`この画像はソーシャルカバーにも使われています。${problem}`);
    return { operation: { type: "replaceAsset", from: target.from, to: reference }, notice: "このページの使用箇所を置き換えました。" };
  }
  if (target.purpose === "ogImage") {
    const problem = socialImageProblem(asset);
    if (problem) throw new Error(problem);
    return { operation: { type: "meta", field: "ogImage", value: { asset: reference, alt: coverAlt(asset, document.meta?.ogImage?.alt ?? "") } }, notice: "ソーシャルカバーを設定しました。画像の説明を確認してください。" };
  }
  if (target.purpose === "background") return { operation: { type: "background", path: target.path, breakpoint: target.breakpoint, asset: reference } };
  if (target.purpose === "image") {
    const node = nodeAt(document, target.path), current = node.type === "element" && typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
    return { operation: { type: "image", path: target.path, source: { asset: reference }, alt: asset.alt || current }, notice: "画像を置き換えました。代替テキストを確認してください。" };
  }
  const { selection } = target, used = new Set(walkNodes(document).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
  let counter = 1;
  while (used.has(`node_${counter}`)) counter++;
  const selected = selection ? nodeAt(document, selection) : undefined;
  const container = selected?.type === "element" && !["img", "source", "br", "hr", "ul", "ol", "dl", "picture"].includes(selected.tag) ? selected : undefined;
  const node: ElementNode = { type: "element", id: `node_${counter}`, tag: "img", asset: reference, attrs: { alt: asset.alt }, style: { base: { maxWidth: "100%", height: "auto" } }, children: [] };
  if (container && selection) return { operation: { type: "add", parentId: container.id, node }, select: [...selection, container.children.length] };
  if (!selection) return { operation: { type: "add", parentId: null, node }, select: [document.body.length] };
  const parent = selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : undefined, index = selection.at(-1)! + 1;
  return { operation: { type: "add", parentId: parent?.type === "element" ? parent.id : null, node, index }, select: [...selection.slice(0, -1), index] };
}

const kindLabels: Record<AssetKind, string> = { image: "画像", video: "動画", pdf: "PDF", other: "ファイル" };
const typeLabels: Readonly<Record<string, string>> = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP", "image/avif": "AVIF", "image/gif": "GIF", "application/pdf": "PDF", "video/mp4": "MP4" };
const typeLabel = (type: string) => Object.hasOwn(typeLabels, type) ? typeLabels[type]! : type;
const notPlaceable = `この種類はページに配置できません。配置できるのは ${INSERTABLE_IMAGE_TYPES.map(typeLabel).join("・")} の画像です。`;
const waitText = "このアセットは確認中です。確認が終わると配置できます。";
const conflictText = "他の人が先に更新しました。一覧を再読み込みして確認してください。";
const control = /[\u0000-\u001f\u007f]/u;
const pad = (value: number) => String(value).padStart(2, "0");
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}
function uploadMessage(reason: AssetRejectReason | ReturnType<typeof assetErrorReason>, policy: AssetUploadPolicy): string {
  switch (reason) {
    case "permission": return "アセットを追加する権限がありません。";
    case "quota": return "容量の上限を超えるためアップロードできません。";
    case "size": return `ファイルが大きすぎます（上限 ${formatBytes(policy.maxBytes)}）。`;
    case "type": return `この形式はアップロードできません。アップロードできる形式: ${policy.accept.map(typeLabel).join("・")}`;
    case "scan": return "安全性の確認で受け付けられませんでした。";
    case "invalid": return "ファイルを読み取れませんでした。";
    default: return "アップロードできませんでした。時間をおいて再試行してください。";
  }
}
const Thumbnail = ({ asset }: { asset: LibraryAsset }) => asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : <span className="e-asset-kind">{kindLabels[asset.kind]}</span>;
/** アンマウント時にまとめて中断する。 */
function useControllers() {
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => { const current = controllers.current; return () => { for (const controller of current) controller.abort(); }; }, []);
  return {
    start() { const controller = new AbortController(); controllers.current.add(controller); return controller; },
    finish(controller: AbortController) { controllers.current.delete(controller); }
  };
}

export function useLocalAssetUsage(document: PageDocument | undefined): ReadonlyMap<string, number> {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const { reference } of document ? collectAssetReferences(document) : []) counts.set(assetKey(reference), (counts.get(assetKey(reference)) ?? 0) + 1);
    return counts;
  }, [document]);
}

type ResolvedState = { adapter: AssetLibraryAdapter | undefined; siteId: string; epoch: number; map: ResolvedAssetMap; settled: readonly string[]; failed: boolean };
const emptyResolved: ResolvedState = { adapter: undefined, siteId: "", epoch: 0, map: {}, settled: [], failed: false };
const fromKey = (key: string): AssetReference => ({ provider: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1) });
/**
 * 文書が参照する素材のうち未取得のものだけを解決し、接続先とサイトごとに保持する。返らなかった参照は再要求しない。
 * epoch（文書の再読込・公開のたびに増える値）が変わったら全件を取り直し、非公開化・削除された素材をプレビューから外す。
 * extra は文書の外の参照（サイト設定のソーシャルカバー等）。
 */
export function useResolvedAssets(adapter: AssetLibraryAdapter | undefined, siteId: string | undefined, document: PageDocument | undefined, epoch = 0, extra: readonly AssetReference[] = []): { map: ResolvedAssetMap; failed: boolean; retry: () => void } {
  const [state, setState] = useState(emptyResolved);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const current = adapter && siteId && state.adapter === adapter && state.siteId === siteId ? state : emptyResolved, revalidate = current.epoch !== epoch;
  const request = adapter && siteId
    ? [...new Set([...(document ? uniqueAssetReferences(document) : []), ...extra].map(assetKey))].sort()
      .filter((key) => revalidate || !Object.hasOwn(current.map, key) && !current.settled.includes(key)).join(" ") : "";
  useEffect(() => {
    if (!adapter || !siteId || !request) return;
    const controller = new AbortController(), wanted = request.split(" ");
    void (async () => {
      try {
        const resolved = parseResolvedAssets(await adapter.resolveAssets({ siteId, references: wanted.map(fromKey) }, controller.signal));
        if (controller.signal.aborted) return;
        if (Object.keys(resolved).some((key) => !wanted.includes(key))) throw new Error("unexpected resolved asset");
        setState((previous) => {
          // 取り直しでは前の結果を引き継がない。応答が届くまでは前の表示を残し、ちらつきを防ぐ。
          const base = previous.adapter === adapter && previous.siteId === siteId && previous.epoch === epoch ? previous : { ...emptyResolved, adapter, siteId, epoch };
          const map: Record<string, ResolvedAsset> = { ...base.map }, settled = new Set(base.settled);
          for (const key of wanted) if (Object.hasOwn(resolved, key)) { map[key] = resolved[key]!; settled.delete(key); } else { delete map[key]; settled.add(key); }
          return { adapter, siteId, epoch, map, settled: [...settled], failed: false };
        });
      } catch { if (!controller.signal.aborted) setState((previous) => ({ ...(previous.adapter === adapter && previous.siteId === siteId ? previous : { ...emptyResolved, adapter, siteId, epoch }), failed: true })); }
    })();
    return () => controller.abort();
  }, [adapter, siteId, request, epoch, retryGeneration]);
  return { map: current.map, failed: current.failed && !!request, retry: () => setRetryGeneration((generation) => generation + 1) };
}

type ListState = {
  status: "loading" | "ready" | "error"; assets: readonly LibraryAsset[]; folders: readonly AssetFolder[];
  quota?: AssetQuota | undefined; upload?: AssetUploadPolicy | undefined; nextCursor?: string | undefined; more: "idle" | "loading" | "error"; problem?: string | undefined; scopeKey?: string | undefined;
};
type UploadRow = { id: number; name: string; state: "sending" | "done" | "failed"; message: string };
type Message = { text: string; error: boolean };
/** null = 中断（アンマウント・送信中）。 */
type ApplyResult = { error: string | undefined; acquired: boolean } | null;
const unknownSource = "出所が確認できないアセットは利用できません。";
const unavailableText = "この出所は現在利用できません。";
const acquiredText = "ライセンス情報を記録して配置しました。";
const acquireMessages = { permission: "このアセットを使う権限がありません。", license: "ライセンスを確認できないため使えません。", unavailable: "現在このアセットは利用できません。" } as const;
class SourceMismatch extends Error {}

/** サイト別の素材ライブラリ。library は管理と配置、pick は画像の選択だけを行う。listProviders があれば出所ごとに分ける。 */
export function AssetLibraryPanel(props: AssetLibraryPanelProps) {
  const { adapter, siteId, mode, pickTitle, providerKind, panelLabel = "アセット", localUsage, actions, disabledReason, onClose, onReplaceUsages, epoch = 0 } = props;
  const sourceScopeKey = `${mode}:${providerKind ?? "all"}`;
  const [folderId, setFolderId] = useState<string | null>(null), [kind, setKind] = useState<AssetKind | "all">("all");
  const [searchInput, setSearchInput] = useState(""), [search, setSearch] = useState(""), [reload, setReload] = useState(0);
  const [list, setList] = useState<ListState>({ status: "loading", assets: [], folders: [], more: "idle" });
  const [detail, setDetail] = useState<{ asset: LibraryAsset; focus: "back" | "alt" | "place"; notice?: Message | undefined } | null>(null), [lastKey, setLastKey] = useState("");
  const [uploads, setUploads] = useState<readonly UploadRow[]>([]), [pickError, setPickError] = useState("");
  const [folderDraft, setFolderDraft] = useState<string | null>(null), [folderError, setFolderError] = useState("");
  const [sources, setSources] = useState<{ status: "loading" | "ready" | "error"; items: readonly AssetProvider[] }>({ status: "loading", items: [] }), [sourceReload, setSourceReload] = useState(0);
  /** null = すべての出所。 */
  const [sourceSelection, setSourceSelection] = useState<{ scope: string; value: string | null }>({ scope: sourceScopeKey, value: null });
  const source = sourceSelection.scope === sourceScopeKey ? sourceSelection.value : null;
  const setSource = (next: string | null | ((previous: string | null) => string | null)) => setSourceSelection((current) => {
    const previous = current.scope === sourceScopeKey ? current.value : null;
    return { scope: sourceScopeKey, value: typeof next === "function" ? next(previous) : next };
  });
  const [recent, setRecent] = useState(false), [acquiring, setAcquiring] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null), cards = useRef(new Map<string, HTMLButtonElement>());
  const more = useRef<AbortController | null>(null), uploadId = useRef(0), latest = useRef(props), busy = useRef(false), work = useControllers();
  latest.current = props;
  const listKind = mode === "pick" ? "image" : kind;
  const legacy = !adapter.listProviders, providers = !legacy && sources.status === "ready" ? sources.items : undefined;
  const scopedProviders = useMemo(() => providers?.filter((item) => !providerKind || item.kind === providerKind), [providers, providerKind]);
  const providerOf = (asset: LibraryAsset) => providers?.find((item) => item.id === asset.provider);
  const current = scopedProviders && source !== null ? scopedProviders.find((item) => item.id === source) : undefined, offline = current?.status === "unavailable";
  const listScopeKey = `${mode}:${providerKind ?? "all"}:${source ?? "all"}`;
  const visibleList: ListState = list.scopeKey === listScopeKey ? list : { status: "loading", assets: [], folders: [], more: "idle" };
  const uploadTarget = !providers ? undefined : current ? (current.status === "available" && current.capabilities.upload ? current : undefined)
    : scopedProviders?.find((item) => item.status === "available" && item.capabilities.upload);
  const showFolders = mode !== "pick" && (legacy || (current?.status === "available" && current.capabilities.folders));
  const query = (cursor?: string): AssetListQuery => ({ siteId, search, kind: listKind, folderId: showFolders ? folderId : null, ...(cursor === undefined ? {} : { cursor }), limit: ASSET_LIMITS.pageSize, ...(source === null ? {} : { provider: source }), ...(recent ? { recent: true } : {}) });
  /** 宣言されていない出所や、選択中の出所と異なる素材を含む応答は採用しない。 */
  const verify = (assets: readonly LibraryAsset[]) => { if (providers && assets.some((asset) => !providerOf(asset) || (source !== null && asset.provider !== source))) throw new SourceMismatch(); };
  useEffect(() => { const timer = setTimeout(() => setSearch(searchInput.trim()), 250); return () => clearTimeout(timer); }, [searchInput]);
  useEffect(() => {
    if (!adapter.listProviders) return;
    // 再読込では取得済みの出所を表示したまま取り直す。
    const controller = new AbortController(); setSources((previous) => previous.status === "ready" ? previous : { status: "loading", items: [] });
    void (async () => {
      try {
        const items = parseAssetProviders(await adapter.listProviders!({ siteId }, controller.signal));
        if (controller.signal.aborted) return;
        setSources({ status: "ready", items }); setSource((previous) => {
          if (previous !== null && items.some((item) => item.id === previous && (!providerKind || item.kind === providerKind))) return previous;
          if (providerKind) return items.find((item) => item.kind === providerKind)?.id ?? null;
          return previous !== null && !items.some((item) => item.id === previous) ? null : previous;
        });
      } catch { if (!controller.signal.aborted) setSources({ status: "error", items: [] }); }
    })();
    return () => controller.abort();
  }, [adapter, siteId, sourceReload, epoch]);
  useEffect(() => {
    setFolderId(null); setFolderDraft(null); setFolderError("");
  }, [mode, providerKind]);
  useEffect(() => {
    if (mode === "pick") { setSource(null); return; }
    if (!providerKind) { setSource(null); return; }
    if (!providers) return;
    setSource((previous) => previous !== null && providers.some((item) => item.id === previous && item.kind === providerKind)
      ? previous : providers.find((item) => item.kind === providerKind)?.id ?? null);
  }, [mode, providerKind, providers]);
  useEffect(() => { setDetail(null); }, [mode, providerKind]);
  useEffect(() => {
    if (!legacy && !providers) return;
    more.current?.abort(); more.current = null;
    if (providerKind && providers && scopedProviders?.length === 0) { setList({ status: "ready", assets: [], folders: [], more: "idle", scopeKey: listScopeKey }); return; }
    if (providerKind && providers && (source === null || !scopedProviders?.some((item) => item.id === source))) { setList({ status: "loading", assets: [], folders: [], more: "idle", scopeKey: listScopeKey }); return; }
    // 未接続の出所には一覧を要求しない。
    if (offline) { setList({ status: "ready", assets: [], folders: [], more: "idle", scopeKey: listScopeKey }); return; }
    const controller = new AbortController();
    setList((previous) => ({ ...previous, status: "loading", assets: previous.scopeKey === listScopeKey ? previous.assets : [], folders: previous.scopeKey === listScopeKey ? previous.folders : [], quota: previous.scopeKey === listScopeKey ? previous.quota : undefined, upload: previous.scopeKey === listScopeKey ? previous.upload : undefined, nextCursor: undefined, problem: undefined, more: "idle", scopeKey: listScopeKey }));
    void (async () => {
      try {
        const result = parseAssetListResult(await adapter.listAssets(query(), controller.signal), siteId);
        verify(result.assets);
        if (!controller.signal.aborted) setList({ status: "ready", assets: result.assets, folders: result.folders, quota: result.quota, upload: result.upload, nextCursor: result.nextCursor, more: "idle", scopeKey: listScopeKey });
      } catch (error) { if (!controller.signal.aborted) setList((previous) => ({ ...previous, status: "error", assets: [], nextCursor: undefined, problem: error instanceof SourceMismatch ? unknownSource : undefined, scopeKey: listScopeKey })); }
    })();
    return () => controller.abort();
  }, [adapter, siteId, search, listKind, folderId, reload, legacy, sources, source, offline, recent, providerKind, mode, scopedProviders, listScopeKey, legacy ? epoch : 0]);
  useEffect(() => () => more.current?.abort(), []);
  useEffect(() => {
    if (mode !== "pick") return;
    const previous = window.document.activeElement; setPickError(""); heading.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [mode]);
  useEffect(() => { if (!detail && lastKey) cards.current.get(lastKey)?.focus(); }, [detail]);

  async function loadMore() {
    const cursor = visibleList.nextCursor;
    if (!cursor || more.current) return;
    const controller = new AbortController(); more.current = controller;
    setList((previous) => ({ ...previous, more: "loading" }));
    try {
      const result = parseAssetListResult(await adapter.listAssets(query(cursor), controller.signal), siteId);
      verify(result.assets);
      if (controller.signal.aborted) return;
      setList((previous) => {
        const seen = new Set(previous.assets.map(assetKey));
        return { ...previous, assets: [...previous.assets, ...result.assets.filter((asset) => !seen.has(assetKey(asset)))], folders: result.folders, quota: result.quota, upload: result.upload, nextCursor: result.nextCursor, more: "idle" };
      });
    } catch { if (!controller.signal.aborted) setList((previous) => ({ ...previous, more: "error" })); }
    finally { if (more.current === controller) more.current = null; }
  }
  /** acquire の出所は、ホストで利用可能にした素材を一覧と詳細に反映してから配置する。 */
  async function apply(asset: LibraryAsset, action: AssetAction): Promise<ApplyResult> {
    const provider = providerOf(asset);
    if (!legacy && !provider) return { error: unknownSource, acquired: false };
    if (provider?.status === "unavailable") return { error: provider.unavailableReason ?? unavailableText, acquired: false };
    if (!isInsertableImage(asset)) return { error: asset.kind === "image" && asset.status === "processing" ? waitText : notPlaceable, acquired: false };
    if (!provider?.capabilities.acquire) return { error: latest.current.onApply(asset, action), acquired: false };
    if (!adapter.acquireAsset) return { error: "この出所のアセットは利用の準備ができません。", acquired: false };
    if (busy.current) return null;
    const controller = work.start(); busy.current = true; setAcquiring(true);
    let ready: LibraryAsset;
    try {
      const result = parseAssetAcquireResult(await adapter.acquireAsset({ siteId, reference: { provider: asset.provider, id: asset.id }, expectedVersion: asset.version }, controller.signal), siteId);
      if (controller.signal.aborted) return null;
      if (result.status === "rejected") return { error: acquireMessages[result.reason], acquired: false };
      const acquiredProvider = providerOf(result.asset);
      if (!acquiredProvider) return { error: unknownSource, acquired: false };
      if (acquiredProvider.status !== "available") return { error: acquiredProvider.unavailableReason ?? unavailableText, acquired: false };
      ready = result.asset;
    } catch (error) {
      if (controller.signal.aborted) return null;
      const reason = assetErrorReason(error);
      return { error: reason === "permission" ? acquireMessages.permission : reason === "conflict" ? conflictText : "利用の準備ができませんでした。時間をおいて再試行してください。", acquired: false };
    } finally { work.finish(controller); busy.current = false; if (!controller.signal.aborted) setAcquiring(false); }
    const key = assetKey(ready), from = assetKey(asset);
    setList((previous) => ({ ...previous, assets: previous.assets.some((item) => assetKey(item) === key) ? previous.assets.map((item) => assetKey(item) === key ? ready : item)
      : source === null || source === ready.provider ? [ready, ...previous.assets] : previous.assets }));
    const error = isInsertableImage(ready) ? latest.current.onApply(ready, action) : notPlaceable;
    setDetail((previous) => previous && assetKey(previous.asset) === from ? { asset: ready, focus: key === from ? previous.focus : "place", notice: { text: error ?? acquiredText, error: !!error } } : previous);
    return { error, acquired: true };
  }
  async function choose(asset: LibraryAsset) {
    setPickError("");
    if (mode === "pick") { const result = await apply(asset, "pick"); if (result) setPickError(result.error ?? ""); return; }
    setLastKey(assetKey(asset)); setDetail({ asset, focus: "back" });
  }
  async function uploadFiles(files: readonly File[]) {
    const policy = list.upload, quota = list.quota, target = uploadTarget;
    if (!policy || !files.length || (providers && !target)) return;
    setPickError(""); setUploads((rows) => rows.filter((row) => row.state !== "done"));
    const update = (id: number, state: UploadRow["state"], message: string) => setUploads((rows) => rows.map((row) => row.id === id ? { ...row, state, message } : row));
    const uploaded: LibraryAsset[] = [];
    let reserved = 0;
    for (const file of files) {
      const id = ++uploadId.current, name = file.name || "名前のないファイル";
      const problem = !policy.accept.includes(file.type) ? uploadMessage("type", policy) : file.size > policy.maxBytes ? uploadMessage("size", policy)
        : quota && quota.usedBytes + reserved + file.size > quota.limitBytes ? uploadMessage("quota", policy) : "";
      setUploads((rows) => [...rows, { id, name, state: problem ? "failed" : "sending", message: problem || "アップロード中…" }]);
      if (problem) continue;
      const controller = work.start();
      try {
        const result = parseAssetUploadResult(await adapter.uploadAsset({ siteId, folderId, file, name: file.name, mimeType: file.type, bytes: file.size, ...(target ? { provider: target.id } : {}) }, controller.signal), siteId);
        if (controller.signal.aborted) return;
        if (result.status === "rejected") { update(id, "failed", uploadMessage(result.reason, policy)); continue; }
        if (target && result.asset.provider !== target.id) { update(id, "failed", unknownSource); continue; }
        const asset = result.asset, key = assetKey(asset);
        reserved += asset.bytes; uploaded.push(asset); update(id, "done", "追加しました。");
        setList((previous) => ({ ...previous, assets: [asset, ...previous.assets.filter((item) => assetKey(item) !== key)], quota: previous.quota && { ...previous.quota, usedBytes: previous.quota.usedBytes + asset.bytes } }));
      } catch (error) { if (controller.signal.aborted) return; update(id, "failed", uploadMessage(assetErrorReason(error), policy)); }
      finally { work.finish(controller); }
    }
    const [single] = uploaded;
    if (uploaded.length !== 1 || !single) return;
    if (latest.current.mode === "library") { setLastKey(assetKey(single)); setDetail({ asset: single, focus: "alt" }); }
    else if (isInsertableImage(single)) { const result = await apply(single, "pick"); if (result) setPickError(result.error ?? ""); }
  }
  async function createFolder() {
    const name = (folderDraft ?? "").trim();
    if (!adapter.createFolder) return;
    if (!name || name.length > ASSET_LIMITS.folderNameLength || control.test(name)) { setFolderError("フォルダ名を 120 文字以内で入力してください。"); return; }
    const controller = work.start();
    try {
      const folder = parseAssetFolder(await adapter.createFolder({ siteId, name, ...(current ? { provider: current.id } : {}) }, controller.signal));
      if (controller.signal.aborted) return;
      setList((previous) => ({ ...previous, folders: [...previous.folders.filter((item) => item.id !== folder.id), folder] }));
      setFolderDraft(null); setFolderError(""); setFolderId(folder.id);
    } catch (error) { if (!controller.signal.aborted) setFolderError(assetErrorReason(error) === "permission" ? "フォルダを作成する権限がありません。" : "フォルダを作成できませんでした。"); }
    finally { work.finish(controller); }
  }
  function selectSource(id: string | null) { setSource(id); setFolderId(null); setFolderDraft(null); setFolderError(""); }

  const filtered = !!search || folderId !== null || recent || (mode === "library" && kind !== "all");
  const activeDetail = mode === "library" && list.scopeKey === listScopeKey ? detail : null;
  const quota = visibleList.quota, showDetail = !!activeDetail, all = !!providers && source === null;
  const chips = mode === "library" ? <div className="e-asset-chips" role="group" aria-label="種類">{(["all", "image", "video", "pdf"] as const).map((value) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{value === "all" ? "全種類" : kindLabels[value]}</button>)}</div> : null;
  const description = providerKind === "stock" ? "利用条件を確認してからページに配置"
    : providerKind === "cms" ? "接続済みCMSのアセットを参照・配置"
      : providerKind === "upload" ? "サイトへアップロードしたアセットを管理・配置" : "アセットをページに配置";
  return <section className="e-asset" aria-label="アセットライブラリ" onKeyDown={(event) => { if (mode === "pick" && event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    {mode === "pick" ? <div className="e-asset-head"><h2 ref={heading} tabIndex={-1}>{pickTitle ?? "画像を選ぶ"}</h2><button type="button" className="e-small" aria-label="画像の選択を閉じる" onClick={onClose}>閉じる</button></div> : <div className="e-panel-head"><h2>{panelLabel}</h2><p>{description}</p></div>}
    {!legacy && !providers ? sources.status === "error"
      ? <div role="alert"><p className="e-help e-problem">アセットの出所を読み込めませんでした。</p><button type="button" onClick={() => setSourceReload((value) => value + 1)}>再読み込み</button></div>
      : <p className="e-help" role="status">読み込み中…</p> : <>
    {!showDetail && <>
    {providers && (scopedProviders?.length ?? 0) > 0 && <div className="e-asset-sources" role="group" aria-label="アセットの出所">{!providerKind && <button type="button" aria-pressed={source === null} onClick={() => selectSource(null)}>すべて</button>}
      {scopedProviders?.map((item) => <button key={item.id} type="button" aria-pressed={source === item.id} aria-label={item.status === "unavailable" ? `${item.label}（未接続）` : undefined} onClick={() => selectSource(item.id)}>
        {item.label}{item.status === "unavailable" && <span className="e-asset-offline">未接続</span>}</button>)}</div>}
    {providerKind && providers && scopedProviders?.length === 0 && <p className="e-help" role="status">{providerKind === "stock" ? "ストックアセットはまだ接続されていません。" : providerKind === "cms" ? "接続済みのCMSアセットはありません。" : "アップロード先が利用できません。"}</p>}
    {current && !offline && <small className="e-help e-asset-origin">{current.origin}</small>}
    {(showFolders || !!uploadTarget) && <div className="e-asset-tools">
      {showFolders && <select aria-label="フォルダ" value={folderId ?? ""} onChange={(event) => setFolderId(event.target.value || null)}><option value="">すべて</option>{visibleList.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}
      {visibleList.upload && (legacy || uploadTarget) && <><button type="button" className="e-primary" title={all && uploadTarget ? `${uploadTarget.label}へ追加` : undefined} onClick={() => fileInput.current?.click()}>アップロード</button>
        <input ref={fileInput} className="e-asset-file" type="file" multiple hidden accept={visibleList.upload.accept.join(",")} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void uploadFiles(files); }} /></>}
    </div>}
    {visibleList.status === "ready" && !visibleList.upload && (legacy || !!uploadTarget) && <small className="e-help">このサイトにアセットを追加する権限がありません。</small>}
    {adapter.createFolder && showFolders && (folderDraft === null ? <button type="button" className="e-small" onClick={() => setFolderDraft("")}>フォルダを追加</button>
      : <div className="e-asset-folder"><input aria-label="新しいフォルダの名前" maxLength={ASSET_LIMITS.folderNameLength} value={folderDraft} autoFocus onChange={(event) => { setFolderDraft(event.target.value); setFolderError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createFolder(); } }} />
        <button type="button" className="e-small" onClick={() => void createFolder()}>作成</button><button type="button" className="e-small" onClick={() => { setFolderDraft(null); setFolderError(""); }}>キャンセル</button></div>)}
    {folderError && <small className="e-help e-problem" role="alert">{folderError}</small>}
    <input type="search" aria-label="アセットを検索" placeholder="名前で検索" maxLength={200} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} className="e-asset-search" />
    {providers ? <div className="e-asset-filters">{chips}<button type="button" className="e-asset-recent" aria-pressed={recent} onClick={() => setRecent((value) => !value)}>最近使った</button></div> : chips}
    </>}
    {uploads.length > 0 && <ul className="e-asset-uploads">{uploads.map((row) => <li key={row.id} role="status" className={row.state === "failed" ? "e-problem" : undefined}><span>{row.name}: {row.message}</span>
      {row.state !== "sending" && <button type="button" className="e-small" aria-label={`${row.name} の通知を閉じる`} onClick={() => setUploads((rows) => rows.filter((item) => item.id !== row.id))}>×</button>}</li>)}</ul>}
    {pickError && <p className="e-help e-problem" role="alert">{pickError}</p>}
    {acquiring && !showDetail && <p className="e-help" role="status">利用の準備中…</p>}
    {activeDetail ? <AssetDetail key={assetKey(activeDetail.asset)} adapter={adapter} siteId={siteId} asset={activeDetail.asset} provider={providerOf(activeDetail.asset)} managed={!legacy} focus={activeDetail.focus} notice={activeDetail.notice} folders={visibleList.folders}
      localCount={localUsage.get(assetKey(activeDetail.asset)) ?? 0} actions={actions} disabledReason={disabledReason} acquiring={acquiring} apply={apply} onBack={() => setDetail(null)} onReplaceUsages={onReplaceUsages}
      onSaved={(asset) => { setDetail((previous) => previous && { ...previous, asset }); setList((previous) => ({ ...previous, assets: previous.assets.map((item) => assetKey(item) === assetKey(asset) ? asset : item) })); }}
      onDeleted={(asset) => { setDetail(null); setList((previous) => ({ ...previous, assets: previous.assets.filter((item) => assetKey(item) !== assetKey(asset)), quota: previous.quota && { ...previous.quota, usedBytes: Math.max(0, previous.quota.usedBytes - asset.bytes) } })); }} />
      : offline && current ? <div className="e-asset-empty"><p>{current.unavailableReason ?? unavailableText}</p><p>{current.origin}</p></div>
      : <>
        {visibleList.status === "loading" && <p className="e-help" role="status">読み込み中…</p>}
        {visibleList.status === "error" && <div role="alert"><p className="e-help e-problem">アセットを読み込めませんでした。</p>{visibleList.problem && <p className="e-help e-problem">{visibleList.problem}</p>}<button type="button" onClick={() => setReload((value) => value + 1)}>再読み込み</button></div>}
        {visibleList.status === "ready" && !visibleList.assets.length && <p className="e-asset-empty">{filtered ? "条件に合うアセットはありません。" : "まだアセットがありません。画像をアップロードすると、ここからページに配置できます。"}</p>}
        {visibleList.assets.length > 0 && <ul className="e-asset-grid">{visibleList.assets.map((asset) => {
          const key = assetKey(asset), inUse = (localUsage.get(key) ?? 0) > 0 || (asset.usageCount ?? 0) > 0, processing = asset.status === "processing", licensed = !!asset.license, origin = all ? providerOf(asset) : undefined;
          const label = `${asset.name}（${kindLabels[asset.kind]}${asset.width && asset.height ? `・${asset.width}×${asset.height}` : ""}・${formatBytes(asset.bytes)}${processing ? "・処理中" : ""}${inUse ? "・使用中" : ""}${licensed ? "・ライセンスあり" : ""}${origin ? `・出所: ${origin.label}` : ""}）`;
          return <li key={key}><button type="button" className="e-asset-card" aria-pressed={mode === "library" && lastKey === key} aria-label={label} disabled={acquiring} onClick={() => void choose(asset)}
            ref={(element) => { if (element) cards.current.set(key, element); else cards.current.delete(key); }}>
            <span className="e-asset-thumb"><Thumbnail asset={asset} />{(inUse || processing || licensed) && <span className="e-asset-badges">{inUse && <span className="e-asset-badge">使用中</span>}{processing && <span className="e-asset-badge e-asset-wait">処理中</span>}{licensed && <span className="e-asset-badge">ライセンス</span>}</span>}</span>
            <span className="e-asset-name">{asset.name}</span>{origin && <span className="e-asset-source">{origin.label}</span>}</button></li>;
        })}</ul>}
        {visibleList.nextCursor && visibleList.status === "ready" && <button type="button" className="e-asset-more" disabled={visibleList.more === "loading"} onClick={() => void loadMore()}>さらに読み込む</button>}
        {visibleList.more === "error" && <small className="e-help e-problem" role="alert">続きを読み込めませんでした。</small>}
      </>}
    {quota && <div className={`e-asset-quota${quota.usedBytes > quota.limitBytes ? " e-asset-over" : ""}`}><span>ストレージ使用量 {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)}</span>
      <span className="e-asset-meter" aria-hidden="true"><span style={{ width: `${quota.limitBytes ? Math.min(100, quota.usedBytes / quota.limitBytes * 100) : 100}%` }} /></span></div>}
    </>}
  </section>;
}

function AssetDetail({ adapter, siteId, asset, provider, managed, focus, notice, folders, localCount, actions, disabledReason, acquiring, apply, onBack, onSaved, onDeleted, onReplaceUsages }: {
  adapter: AssetLibraryAdapter; siteId: string; asset: LibraryAsset; provider: AssetProvider | undefined; managed: boolean; focus: "back" | "alt" | "place"; notice: Message | undefined;
  folders: readonly AssetFolder[]; localCount: number; actions: AssetLibraryPanelProps["actions"]; disabledReason: string | undefined; acquiring: boolean;
  apply: (asset: LibraryAsset, action: AssetAction) => Promise<ApplyResult>;
  onBack: () => void; onSaved: (asset: LibraryAsset) => void; onDeleted: (asset: LibraryAsset) => void; onReplaceUsages: (asset: LibraryAsset) => void;
}) {
  const [name, setName] = useState(asset.name), [alt, setAlt] = useState(asset.alt), [folder, setFolder] = useState(asset.folderId ?? "");
  const [saving, setSaving] = useState(false), [saveMessage, setSaveMessage] = useState<Message | null>(null);
  const [usages, setUsages] = useState<{ status: "loading" | "ready" | "error"; items: readonly AssetUsage[] }>({ status: "loading", items: [] }), [usageReload, setUsageReload] = useState(0);
  const [confirming, setConfirming] = useState(false), [deleting, setDeleting] = useState(false), [deleteMessage, setDeleteMessage] = useState("");
  const [placeMessage, setPlaceMessage] = useState<Message | null>(notice ?? null);
  const back = useRef<HTMLButtonElement>(null), altInput = useRef<HTMLTextAreaElement>(null), placeActions = useRef<HTMLDivElement>(null), work = useControllers();
  const reference: AssetReference = { provider: asset.provider, id: asset.id };
  // 出所が管理する素材（CMS の写真等）は、ここで名前・説明の変更や削除をしない。
  const editable = !managed ? true : provider?.status === "available" && provider.capabilities.editMetadata;
  const deletable = !managed ? true : provider?.status === "available" && provider.capabilities.delete;
  const unavailable = managed && !provider ? unknownSource : provider?.status === "unavailable" ? provider.unavailableReason ?? unavailableText : "";
  useEffect(() => { (focus === "alt" ? altInput.current : focus === "place" ? placeActions.current?.querySelector<HTMLButtonElement>("button:enabled") ?? back.current : back.current)?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setUsages({ status: "loading", items: [] });
    void (async () => {
      try {
        const items = parseAssetUsages(await adapter.listAssetUsages({ siteId, reference: { provider: asset.provider, id: asset.id } }, controller.signal));
        if (!controller.signal.aborted) setUsages({ status: "ready", items });
      } catch { if (!controller.signal.aborted) setUsages({ status: "error", items: [] }); }
    })();
    return () => controller.abort();
  }, [adapter, siteId, asset.provider, asset.id, usageReload]);
  const trimmed = name.trim();
  const changes: AssetUpdateRequest["changes"] = { ...(name !== asset.name ? { name: trimmed } : {}), ...(alt !== asset.alt ? { alt } : {}), ...(folder !== (asset.folderId ?? "") ? { folderId: folder || null } : {}) };
  const changed = Object.keys(changes).length > 0;
  async function save() {
    if (!changed || saving || !editable) return;
    if (!trimmed || trimmed.length > 200 || control.test(trimmed)) { setSaveMessage({ text: "名前を 200 文字以内で入力してください。", error: true }); return; }
    if (alt.length > 1000 || control.test(alt)) { setSaveMessage({ text: "代替テキストは改行を含めず 1000 文字以内で入力してください。", error: true }); return; }
    const controller = work.start(); setSaving(true); setSaveMessage(null);
    try {
      const result = parseAssetUpdateResult(await adapter.updateAsset({ siteId, reference, expectedVersion: asset.version, changes }, controller.signal), siteId);
      if (controller.signal.aborted) return;
      if (result.status === "saved") {
        if (assetKey(result.asset) !== assetKey(asset)) throw new Error("asset mismatch");
        onSaved(result.asset); setName(result.asset.name); setAlt(result.asset.alt); setFolder(result.asset.folderId ?? ""); setSaveMessage({ text: "保存しました。", error: false });
      } else setSaveMessage({ text: result.status === "conflict" ? conflictText : result.reason === "permission" ? "アセットを変更する権限がありません。" : "内容を保存できませんでした。名前と代替テキストを確認してください。", error: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = assetErrorReason(error);
      setSaveMessage({ text: reason === "conflict" ? conflictText : reason === "permission" ? "アセットを変更する権限がありません。" : "変更を保存できませんでした。時間をおいて再試行してください。", error: true });
    } finally { work.finish(controller); if (!controller.signal.aborted) setSaving(false); }
  }
  async function remove() {
    const controller = work.start(); setDeleting(true); setDeleteMessage("");
    try {
      const result = parseAssetDeleteResult(await adapter.deleteAsset({ siteId, reference, expectedVersion: asset.version }, controller.signal));
      if (controller.signal.aborted) return;
      setConfirming(false);
      if (result.status === "deleted") onDeleted(asset);
      else if (result.status === "in-use") setUsages({ status: "ready", items: result.usages });
      else setDeleteMessage(result.status === "conflict" ? conflictText : "削除する権限がありません。");
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = assetErrorReason(error);
      setDeleteMessage(reason === "permission" ? "削除する権限がありません。" : reason === "conflict" ? conflictText : "削除できませんでした。時間をおいて再試行してください。");
    } finally { work.finish(controller); if (!controller.signal.aborted) setDeleting(false); }
  }
  async function place(action: "replace" | "background" | "insert") {
    setPlaceMessage(null);
    const result = await apply(asset, action);
    if (result) setPlaceMessage(result.error ? { text: result.error, error: true } : { text: result.acquired ? acquiredText : action === "insert" ? "ページに追加しました。" : action === "background" ? "背景に設定しました。" : "画像を置き換えました。", error: false });
  }
  const deleteBlocked = localCount > 0 ? "このページで使用中です。先に別の画像へ置き換えてください。" : usages.items.length ? "公開中または下書きのページで使用中のため削除できません。" : usages.status === "loading" ? "使用状況を確認しています…" : "";
  const placeBlocked = !!disabledReason || acquiring || !!unavailable, license = asset.license;
  return <div className="e-asset-detail">
    <div className="e-actions"><button ref={back} type="button" className="e-small" onClick={onBack}>一覧に戻る</button></div>
    <div className="e-asset-preview"><Thumbnail asset={asset} /></div>
    {(provider || license) && <dl className="e-asset-terms">
      {provider && <><dt>出所</dt><dd><span>{provider.label}</span><span>{provider.origin}</span>{asset.sourceLabel && <span>{asset.sourceLabel}</span>}</dd></>}
      {provider?.terms && <><dt>利用条件</dt><dd>{provider.terms}</dd></>}
      {license && <><dt>ライセンス</dt><dd><span>{license.name}</span>{license.url && <a href={license.url} target="_blank" rel="noopener noreferrer">ライセンスを確認</a>}
        {license.attribution && <span>クレジット: {license.attribution}</span>}{license.terms && <span>{license.terms}</span>}</dd></>}
    </dl>}
    <label className="e-field"><span>名前</span><input value={name} maxLength={200} readOnly={!editable} onChange={(event) => { setName(event.target.value); setSaveMessage(null); }} /></label>
    <label className="e-field"><span>代替テキスト</span><textarea ref={altInput} value={alt} maxLength={1000} readOnly={!editable} onChange={(event) => { setAlt(event.target.value); setSaveMessage(null); }} />
      <small className="e-help">ページに配置したときの画像の説明の初期値です。配置後は要素ごとに変更できます。</small></label>
    {(!managed || provider?.status === "available" && provider.capabilities.folders) && <label className="e-field"><span>保存先フォルダ</span><select value={folder} disabled={!editable} onChange={(event) => { setFolder(event.target.value); setSaveMessage(null); }}><option value="">フォルダなし</option>
      {folder && !folders.some((item) => item.id === folder) && <option value={folder}>{folder}</option>}{folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    <dl><dt>種類</dt><dd>{kindLabels[asset.kind]}・{asset.mimeType}</dd><dt>寸法</dt><dd>{asset.width && asset.height ? `${asset.width} × ${asset.height} px` : "—"}</dd><dt>容量</dt><dd>{formatBytes(asset.bytes)}</dd><dt>更新日</dt><dd>{formatDate(asset.updatedAt)}</dd></dl>
    {editable ? <><button type="button" className="e-primary" disabled={!changed || saving} onClick={() => void save()}>変更を保存</button>
      {saveMessage && <small className={`e-help${saveMessage.error ? " e-problem" : ""}`} role={saveMessage.error ? "alert" : "status"}>{saveMessage.text}</small>}</>
      : <small className="e-help">このアセットは「{provider?.label}」で管理しています。名前・説明・写真の差し替えは出所で行ってください。</small>}
    <h3>配置</h3>
    {isInsertableImage(asset) ? <>
      <div ref={placeActions} className="e-actions">{actions.replace && <button type="button" className="e-primary" disabled={placeBlocked} onClick={() => void place("replace")}>選択中の画像を置き換え</button>}
        {actions.background && <button type="button" disabled={placeBlocked} onClick={() => void place("background")}>選択中の要素の背景にする</button>}
        {actions.insert && <button type="button" disabled={placeBlocked} onClick={() => void place("insert")}>ページに追加</button>}</div>
      {disabledReason && <small className="e-help">{disabledReason}</small>}
      {unavailable && <small className="e-help e-problem">{unavailable}</small>}
      {acquiring && <small className="e-help" role="status">利用の準備中…</small>}
      {!actions.replace && !actions.background && <small className="e-help">キャンバスで画像や要素を選ぶと、置き換えや背景にも使えます。</small>}
    </> : <p className="e-help">{asset.kind === "image" && asset.status === "processing" ? waitText : notPlaceable}</p>}
    {placeMessage && <small className={`e-help${placeMessage.error ? " e-problem" : ""}`} role={placeMessage.error ? "alert" : "status"}>{placeMessage.text}</small>}
    <h3>使用状況</h3>
    <p className="e-help">このページ: {localCount} か所</p>
    {usages.status === "loading" ? <small className="e-help" role="status">保存済みのページを確認しています…</small>
      : usages.status === "error" ? <small className="e-help e-problem">使用状況を取得できませんでした。</small>
      : usages.items.length ? <ul className="e-asset-usages">{usages.items.map((usage, index) => <li key={index}>{usage.title}（{usage.locale}）・{usage.state === "published" ? "公開中" : "下書き"}</li>)}</ul>
      : <small className="e-help">保存済みのページでは使われていません。</small>}
    <div className="e-actions"><button type="button" className="e-small" onClick={() => setUsageReload((value) => value + 1)}>使用状況を再確認</button></div>
    {deletable ? <><h3>削除</h3>
      <div className="e-actions"><button type="button" className="e-danger" disabled={!!deleteBlocked || deleting || confirming} onClick={() => setConfirming(true)}>削除…</button>
        {localCount > 0 && <button type="button" onClick={() => onReplaceUsages(asset)}>このページの使用箇所を置き換え</button>}</div>
      {deleteBlocked && <small className="e-help">{deleteBlocked}</small>}
      {confirming && <div className="e-asset-confirm" role="group" aria-label="削除の確認"><p>「{asset.name}」を削除します。元に戻せません。</p>
        <div className="e-actions"><button type="button" disabled={deleting} onClick={() => setConfirming(false)}>キャンセル</button><button type="button" className="e-danger" disabled={deleting} onClick={() => void remove()}>削除する</button></div></div>}
      {deleteMessage && <small className="e-help e-problem" role="alert">{deleteMessage}</small>}</>
      : <>{localCount > 0 && <div className="e-actions"><button type="button" onClick={() => onReplaceUsages(asset)}>このページの使用箇所を置き換え</button></div>}
        <small className="e-help">「{provider?.label}」のアセットはここでは削除できません。</small></>}
  </div>;
}

/** img のインスペクタ。URL 入力欄は呼び出し側から children で渡す。 */
export function ImageSourceField({ node, assets, failed, lock, disabled, onPick, children }: {
  node: ElementNode; assets: ResolvedAssetMap; failed: boolean; lock: string | undefined; disabled: boolean; onPick: () => void; children: ReactNode;
}) {
  const src = node.asset ? resolvedAsset(assets, node.asset)?.src : typeof node.attrs?.src === "string" ? node.attrs.src : undefined;
  return <div className="e-asset-source">
    <div className="e-asset-preview">{src ? <img src={src} alt="" /> : <span className="e-asset-missing">画像を表示できません</span>}</div>
    <small className="e-help">{node.asset ? "アセットの画像" : "URL で指定した画像"}</small>
    {node.asset && !src && failed && <small className="e-help e-problem">アセットの情報を取得できませんでした。</small>}
    <div className="e-actions"><button type="button" disabled={disabled || !!lock} onClick={onPick}>{src ? "画像を置き換え" : "画像を選ぶ"}</button></div>
    {lock && <small className="e-help">ロック: {lock}</small>}
    <details><summary>URL で指定</summary>{children}</details>
  </div>;
}

type BackgroundProperty = "backgroundSize" | "backgroundPosition" | "backgroundRepeat";
const backgroundChoices: readonly (readonly [BackgroundProperty, string, readonly (readonly [string, string])[]])[] = [
  ["backgroundSize", "背景のサイズ", [["cover", "全体を覆う"], ["contain", "全体を収める"], ["auto", "元のサイズ"]]],
  ["backgroundPosition", "背景の位置", [["center", "中央"], ["top", "上"], ["bottom", "下"], ["left", "左"], ["right", "右"], ["top left", "左上"], ["top right", "右上"], ["bottom left", "左下"], ["bottom right", "右下"]]],
  ["backgroundRepeat", "背景の繰り返し", [["no-repeat", "繰り返さない"], ["repeat", "縦横に繰り返す"], ["repeat-x", "横に繰り返す"], ["repeat-y", "縦に繰り返す"]]]
];
/** 現在の編集幅の背景画像。値の変更は style / background 操作で行う。 */
export function BackgroundImageField({ declarations, assets, lock, disabled, onPick, onClear, onStyle }: {
  declarations: StyleDeclarations | undefined; assets: ResolvedAssetMap; lock: (property: BackgroundProperty | "backgroundImage") => string | undefined; disabled: boolean;
  onPick: () => void; onClear: () => void; onStyle: (property: StyleProperty, value: StyleValue | undefined) => void;
}) {
  const background = declarations?.backgroundImage, image = background && background !== "none" ? background : undefined;
  const src = image ? resolvedAsset(assets, image.asset)?.src : undefined, imageLock = lock("backgroundImage");
  return <details open className="e-asset-background"><summary>背景画像</summary>
    <div className="e-asset-preview e-asset-mini">{src ? <img src={src} alt="" /> : <span className="e-asset-missing">{image ? "画像を表示できません" : "背景画像はありません"}</span>}</div>
    <div className="e-actions"><button type="button" disabled={disabled || !!imageLock} onClick={onPick}>背景画像を選ぶ</button>{image && <button type="button" disabled={disabled || !!imageLock} onClick={onClear}>背景画像を外す</button>}</div>
    {imageLock && <small className="e-help">ロック: {imageLock}</small>}
    {backgroundChoices.map(([property, caption, choices]) => {
      const locked = lock(property), value = declarations?.[property];
      return <label key={property} className="e-field"><span>{caption}</span><select aria-label={caption} value={typeof value === "string" ? value : ""} disabled={disabled || !!locked} onChange={(event) => onStyle(property, event.target.value || undefined)}>
        <option value="">指定なし</option>{choices.map(([choice, text]) => <option key={choice} value={choice}>{text}</option>)}</select>{locked && <small className="e-help">ロック: {locked}</small>}</label>;
    })}
  </details>;
}
