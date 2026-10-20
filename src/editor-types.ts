import type { ComponentType } from "react";
import type { AssetLibraryAdapter } from "./assets.js";
import type { BlockDefinition } from "./react.js";
import type { PageKind, PageVisibility, SiteSettings } from "./pages.js";
import type { ComponentLibrary, PageDocument, PublicPropValue, StyleProperty } from "./types.js";
import type { EditorRecoveryStore, EditorRevisionEntry, EditorRevisionPage } from "./history.js";
export type { PageKind, PageVisibility, SiteSettings } from "./pages.js";
export type { DocumentChange, EditorRecoveryEntry, EditorRecoveryStore, EditorRevisionEntry, EditorRevisionKind, EditorRevisionPage, StoredRecoveryEntry } from "./history.js";

export type EditorTarget = { siteId: string; pageId: string; locale: string };
/** ホストが許可する構造化データの種類。JSON-LD の中身はホストが生成する。 */
export type EditorStructuredDataPreset = { id: string; label: string; description?: string };
export type EditorSite = {
  id: string; name: string; /** 許可済み HTTPS origin（末尾 / なし）。 */ domains: readonly string[];
  structuredData?: readonly EditorStructuredDataPreset[];
};
/** title はページ一覧の名前。任意項目を省いたホストは従来どおり動作する。 */
export type EditorPage = EditorTarget & { title: string; path?: string; kind?: PageKind; visibility?: PageVisibility; published?: boolean };
/** フィールドは props.name / attrs.href / children / style 等。* はノード全体。 */
export type EditorLock = { nodeId: string; fields: readonly string[]; reason: string };
export type EditorSnapshot = {
  document: unknown;
  /** ホストが発行する opaque な楽観ロック値。 */
  version: string;
  locks?: readonly EditorLock[];
  releases?: readonly { revision: number; label: string }[];
};
export type EditorSaveResult = {
  status: "saved";
  version: string;
  /** サーバーが保存時に採番した、送信文書より大きい revision。 */
  revision: number;
} | { status: "conflict" };
export type EditorReleaseRequest = {
  target: EditorTarget;
  expectedVersion: string;
  action: "publish" | "rollback";
  revision?: number;
  /** 公開確認時にエディターが表示している部品ライブラリの version。ホストは確認 token に結び付ける。 */
  componentsVersion?: string;
};
/** 公開確認に添える影響範囲。kind は共通部品・ページ・サイト設定。 */
export type EditorReleaseAffected = { kind: "shared" | "page" | "site"; name: string; detail?: string };
export type EditorReleasePlan = EditorReleaseRequest & {
  confirmationToken: string;
  domain: string;
  changes: readonly { path: string; before: string; after: string }[];
  /** このページの公開URL。domain から始まる完全な URL。 */
  url?: string;
  affected?: readonly EditorReleaseAffected[];
};
export type EditorReleaseResult = { status: "released"; snapshot: EditorSnapshot } | { status: "conflict" };
export type ComponentLibrarySnapshot = {
  /** 検証前のライブラリ。まだないサイトでは revision: 1、components: [] の空ライブラリ。 */
  library: unknown;
  /** ホストが発行する opaque な楽観ロック値。 */
  version: string;
};
export type ComponentUsageEntry = {
  target: EditorTarget;
  title: string;
  /** 文書の種類（EditorPage.kind と同じ）。省略時はページ一覧の同じ文書の kind、無ければ page として扱う。 */
  role?: PageKind;
  /** template / shared の場合、その文書と一緒に表示される公開ページ数。 */
  reach?: number;
  /** 部品 ID ごとのインスタンス数（入れ子の部品経由を含む）。 */
  components: Readonly<Record<string, number>>;
};
/** 保存はページの下書きと同じく、expectedVersion の比較・revision の採番・競合の変換をホストが原子的に行う。 */
export interface EditorComponentAdapter {
  readLibrary(siteId: string, signal: AbortSignal): Promise<ComponentLibrarySnapshot>;
  /** trigger は自動保存のときだけ "autosave"（saveDraft と同じ）。 */
  saveLibrary(request: { siteId: string; library: ComponentLibrary; expectedVersion: string; trigger?: "autosave" }, signal: AbortSignal): Promise<EditorSaveResult>;
  /** 保存済みの下書きを対象にした使用状況。 */
  listUsage(siteId: string, signal: AbortSignal): Promise<readonly ComponentUsageEntry[]>;
}
export type EditorPageChange =
  | { action: "create"; siteId: string; locale: string; title: string; path: string }
  | { action: "duplicate"; source: EditorTarget; title: string; path: string }
  | { action: "update"; target: EditorTarget; title: string; path: string }
  | { action: "visibility"; target: EditorTarget; visibility: PageVisibility };
export type EditorPageImpact = {
  /** 変更前・変更後の公開URL（完全なURL）。 */
  before?: string;
  after?: string;
  redirect?: { from: string; to: string };
  linkedFrom: readonly { pageId: string; locale: string; title: string; count: number }[];
  navigation: readonly string[];
  notes: readonly string[];
};
export type EditorPageChangePlan = { change: EditorPageChange; confirmationToken: string; domain: string; impact: EditorPageImpact };
export type EditorPageChangeResult = { status: "applied"; page: EditorPage } | { status: "conflict" };
export type EditorSiteSettingsSnapshot = { settings: unknown; version: string };
export type EditorSiteSettingsSaveResult = { status: "saved"; version: string } | { status: "conflict" };
/** 認証・認可・通信・公開処理は、認証済みホストの責務。 */
export interface EditorAdapter {
  listSites(signal: AbortSignal): Promise<readonly EditorSite[]>;
  listPages(siteId: string, signal: AbortSignal): Promise<readonly EditorPage[]>;
  readDocument(target: EditorTarget, signal: AbortSignal): Promise<EditorSnapshot>;
  /** trigger は自動保存のときだけ "autosave"。ホストは履歴の種類の区別に使える。 */
  saveDraft(request: { target: EditorTarget; document: PageDocument; expectedVersion: string; trigger?: "autosave" }, signal: AbortSignal): Promise<EditorSaveResult>;
  prepareRelease(request: EditorReleaseRequest, signal: AbortSignal): Promise<EditorReleasePlan>;
  release(request: EditorReleasePlan, signal: AbortSignal): Promise<EditorReleaseResult>;
  /** 省略したホストでは部品機能を使わない。 */
  components?: EditorComponentAdapter;
  /** ページ操作の影響と確認 token。両方を実装した場合だけページ操作を表示する。 */
  preparePageChange?(change: EditorPageChange, signal: AbortSignal): Promise<EditorPageChangePlan>;
  applyPageChange?(plan: EditorPageChangePlan, signal: AbortSignal): Promise<EditorPageChangeResult>;
  /** サイト共通の設定。version は楽観ロック用の opaque な値。 */
  readSiteSettings?(siteId: string, signal: AbortSignal): Promise<EditorSiteSettingsSnapshot>;
  saveSiteSettings?(request: { siteId: string; settings: SiteSettings; expectedVersion: string }, signal: AbortSignal): Promise<EditorSiteSettingsSaveResult>;
  /** 版履歴。新しい順で、続きは next を cursor に渡す。実装した場合だけ「履歴」を表示する。 */
  listRevisions?(request: { target: EditorTarget; cursor?: string }, signal: AbortSignal): Promise<EditorRevisionPage>;
  readRevision?(request: { target: EditorTarget; id: string }, signal: AbortSignal): Promise<{ document: unknown }>;
  /** 保存済みの状態に名前を付ける。ホストは expectedVersion を検証する。 */
  createSnapshot?(request: { target: EditorTarget; expectedVersion: string; label: string }, signal: AbortSignal): Promise<EditorSnapshotResult>;
}
export type EditorSnapshotResult = { status: "saved"; entry: EditorRevisionEntry } | { status: "conflict" };
export type EditorBlockRegistry = Readonly<Record<string, BlockDefinition & {
  label?: string;
  defaultProps?: Record<string, PublicPropValue>;
  /** データ連動値。すべての同種ブロックへ適用し、理由を表示する。 */
  lockedProps?: Readonly<Record<string, string>>;
  /** 変更を許す見た目。"textStyle" は文字スタイルの適用、"states" は状態スタイル、"appear" は登場、"hidden" は幅別の非表示。省略時はすべて。props はスタイル操作から変えない。 */
  styleProperties?: readonly (StyleProperty | "textStyle" | "states" | "appear" | "hidden")[];
  /**
   * エディターのキャンバスと部品の縮小表示だけで使う描画。省略時は component。公開の描画（PageRenderer・SSR）は常に component を使う。
   * データの取得・課金・予約・保存などの副作用を起こさず、表示領域（data-nw-slot）の付け方は component と同じにし、現実的な見本を複数件（一覧なら 3 件ほど）表示する。
   */
  preview?: ComponentType<Record<string, PublicPropValue>>;
}>>;
/** 編集する幅の段。minWidth は 320〜3840 の整数・昇順。 */
export type EditorBreakpoint = { minWidth: number; label: string };
export type PageEditorProps = {
  adapter: EditorAdapter;
  blocks?: EditorBlockRegistry;
  /** 新規配置できる登録ブロック。省略時は全件、空配列なら既存ブロックの編集だけを許可。 */
  insertableBlocks?: readonly string[];
  /** サイト別の素材ライブラリ。参照は安定させる。省略時は素材の UI を表示しない。 */
  assets?: AssetLibraryAdapter;
  /** 編集する幅の段。省略・不正時は タブレット 768px / PC 1280px。 */
  breakpoints?: readonly EditorBreakpoint[];
  /** 省略時は手動保存だけ。true は 2,000ms、delayMs は 100〜60,000ms。 */
  autosave?: boolean | { delayMs?: number };
  /** 端末内の緊急復元。省略時は端末へ何も保存しない。 */
  recovery?: EditorRecoveryStore;
};
