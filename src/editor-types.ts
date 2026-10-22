import type { SiteStyles } from "./site-styles.js";
import type { BuilderDefinition } from "./builder.js";
import type { ComponentType, ReactNode } from "react";
import type { AssetLibraryAdapter } from "./assets.js";
import type { BlockDefinition, ExternalFramePolicy } from "./react.js";
import type { PageKind, PageVisibility, SiteSettings } from "./pages.js";
import type { ComponentLibrary, PageDocument, PublicPropValue, StyleProperty } from "./types.js";
import type { EditorRecoveryStore, EditorRevisionEntry, EditorRevisionPage } from "./history.js";
import type { BlockLocalizationSchema, LocalizationLocale, LocalizationValue } from "./localization.js";
export type { PageKind, PageVisibility, SiteSettings } from "./pages.js";
export type { DocumentChange, EditorLibraryRecoveryEntry, EditorRecoveryEntry, EditorRecoveryStore, EditorRevisionEntry, EditorRevisionKind, EditorRevisionPage, StoredLibraryRecoveryEntry, StoredRecoveryEntry } from "./history.js";

export type EditorTarget = { siteId: string; pageId: string; locale: string };
/** ホストが許可する構造化データの種類。JSON-LD の中身はホストが生成する。 */
export type EditorStructuredDataPreset = { id: string; label: string; description?: string };
export type EditorSite = {
  id: string; name: string; /** 許可済み HTTPS origin（末尾 / なし）。 */ domains: readonly string[];
  structuredData?: readonly EditorStructuredDataPreset[];
};
/** title はページ一覧の名前。任意項目を省いたホストは従来どおり動作する。 */
export type EditorPage = EditorTarget & { title: string; path?: string; kind?: PageKind; visibility?: PageVisibility; published?: boolean };
export type EditorLocalizationPageState = "source" | "missing" | "translating" | "review-needed" | "reviewed" | "failed";
export type EditorLocalizationLanguageStatus = { state: EditorLocalizationPageState; changed?: number; published?: boolean };
export type EditorLocalizedPage = Omit<EditorPage, "locale"> & {
  /** A logical page appears once. Document locale spellings always come from config.documentLocales. */
  locales: Partial<Record<LocalizationLocale, EditorLocalizationLanguageStatus>>;
};
export type EditorTranslationJob = { state: "idle" | "queued" | "running" | "failed"; message?: string };
export type EditorLocalizationSiteSnapshot = {
  config: unknown;
  pages: readonly EditorLocalizedPage[];
  version: string;
  job?: EditorTranslationJob;
};
export type EditorLocalizationPageSnapshot = {
  /** Current authoritative source; never inferred from the selected target document. */
  sourceDocument: unknown;
  sourceVersion: string;
  overlay: unknown;
  /** Opaque host CAS version for commands and overlay persistence. */
  version: string;
  components?: unknown;
  blockLocalization?: BlockLocalizationSchema;
  previousSourceValues?: Readonly<Record<string, LocalizationValue>>;
  job?: EditorTranslationJob;
};
export type EditorLocalizationCommand =
  | { action: "request-translation"; target: EditorTarget; expectedSourceVersion: string; expectedVersion: string; expectedOverlayVersion: number }
  | { action: "adopt-candidate"; target: EditorTarget; unitId: string; candidateVersion: number; expectedSourceVersion: string; expectedVersion: string; expectedOverlayVersion: number }
  | { action: "review-current"; target: EditorTarget; unitId: string; expectedSourceVersion: string; expectedVersion: string; expectedOverlayVersion: number }
  | { action: "set-value"; target: EditorTarget; unitId: string; value: LocalizationValue; sourceFingerprint: string; expectedEntryVersion: number;
    expectedSourceVersion: string; expectedVersion: string; expectedOverlayVersion: number };
export type EditorLocalizationCommandResult = { status: "applied"; version: string } | { status: "conflict" };
export type EditorLocaleReleaseSummary = {
  releaseId: string;
  version: string;
  label: string;
  publishedAt: string;
  pages: number;
  sharedResources: number;
};
export type EditorLocaleReleaseState = {
  siteId: string;
  locale: LocalizationLocale;
  /** CAS identity of the current locale release; null before first activation. */
  current: EditorLocaleReleaseSummary | null;
  /** Immutable prior whole-locale releases, newest first. */
  history: readonly EditorLocaleReleaseSummary[];
};
export type EditorLocaleReleasePrepareRequest = {
  siteId: string;
  locale: LocalizationLocale;
  action: "publish" | "rollback";
  expectedSiteVersion: string;
  expectedCurrentVersion: string | null;
  rollbackReleaseId?: string;
};
export type EditorLocaleReleasePlan = EditorLocaleReleasePrepareRequest & {
  confirmationToken: string;
  domain: string;
  expiresAt: string;
  optimisticVersion: string;
  previous: EditorLocaleReleaseSummary | null;
  prepared: EditorLocaleReleaseSummary;
  pages: readonly { pageId: string; title: string; path: string; complete: boolean; reasons: readonly string[] }[];
  sharedResources: readonly { id: string; label: string; kind: "component" | "navigation" | "style" | "resource"; complete: boolean; reasons: readonly string[] }[];
  incompleteReasons: readonly string[];
  complete: boolean;
};
export type EditorLocaleReleaseApplyRequest = {
  confirmationToken: string;
  siteId: string;
  locale: LocalizationLocale;
  expectedCurrentVersion: string | null;
  optimisticVersion: string;
  preparedReleaseId: string;
  preparedVersion: string;
};
export type EditorLocaleReleaseApplyResult =
  | { status: "applied"; siteId: string; locale: LocalizationLocale; current: EditorLocaleReleaseSummary }
  | { status: "conflict" | "expired" };
export interface EditorLocalizationAdapter {
  readSite(siteId: string, signal: AbortSignal): Promise<EditorLocalizationSiteSnapshot>;
  readPage(target: EditorTarget, signal: AbortSignal): Promise<EditorLocalizationPageSnapshot>;
  command(request: EditorLocalizationCommand, signal: AbortSignal): Promise<EditorLocalizationCommandResult>;
  /** Optional host-owned site-wide async translation queue. The library never calls a provider. */
  requestSiteTranslation?(request: { siteId: string; targetLocale: LocalizationLocale; expectedVersion: string }, signal: AbortSignal): Promise<EditorLocalizationCommandResult>;
  /** Optional host-owned whole-locale publication. All four methods are required to enable translated publication. */
  readRelease?(request: { siteId: string; locale: LocalizationLocale }, signal: AbortSignal): Promise<EditorLocaleReleaseState>;
  prepareRelease?(request: EditorLocaleReleasePrepareRequest, signal: AbortSignal): Promise<EditorLocaleReleasePlan>;
  applyRelease?(request: EditorLocaleReleaseApplyRequest, signal: AbortSignal): Promise<EditorLocaleReleaseApplyResult>;
  /** Applies a prepared whole-locale rollback; never a per-page numeric revision. */
  rollbackRelease?(request: EditorLocaleReleaseApplyRequest, signal: AbortSignal): Promise<EditorLocaleReleaseApplyResult>;
}
/** フィールドは props.name / attrs.href / children / style 等。* はノード全体。 */
export type EditorLock = { nodeId: string; fields: readonly string[]; reason: string };
/** 文書単位の表示ポリシー。認可の代わりではなく、ホストは書込 API 側でも同じ正本ポリシーを検証する。 */
export type EditorReadOnly = { reason: string; editUrl?: string; editLabel?: string };
export type EditorSnapshot = {
  document: unknown;
  /** ホストが発行する opaque な楽観ロック値。 */
  version: string;
  /** false の場合、初回など保存済み下書きがなく公開確認を開始できない。省略時は従来の動作。 */
  hasSavedDraft?: boolean;
  locks?: readonly EditorLock[];
  releases?: readonly { revision: number; label: string }[];
  /** 省略時は従来どおり編集可能。ブラウザ退避や履歴からは復元せず、毎回ホストの現在値を使う。 */
  readOnly?: EditorReadOnly;
  /** 本文と独立した、同じ snapshot/version に対応する native site presentation。旧ホストは省略可。 */
  presentation?: unknown;
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
  /** presentation がある snapshot では必須。ホストは共有文書等の依存版も CAS する。 */
  presentationVersion?: string;
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
  saveDraft(request: { target: EditorTarget; document: PageDocument; expectedVersion: string; presentationVersion?: string; trigger?: "autosave";
    /** Present for translated drafts; the host must CAS these values and persist only validated localized overlays. */
    localization?: { expectedSourceVersion: string; expectedVersion: string; expectedOverlayVersion: number };
  }, signal: AbortSignal): Promise<EditorSaveResult>;
  prepareRelease(request: EditorReleaseRequest, signal: AbortSignal): Promise<EditorReleasePlan>;
  release(request: EditorReleasePlan, signal: AbortSignal): Promise<EditorReleaseResult>;
  /** 省略したホストでは部品機能を使わない。 */
  components?: EditorComponentAdapter;
  /** 省略したホストは従来どおり単言語で動作する。認証・永続化・翻訳providerはホストの責務。 */
  localization?: EditorLocalizationAdapter;
  /** ページ操作の影響と確認 token。両方を実装した場合だけページ操作を表示する。 */
  preparePageChange?(change: EditorPageChange, signal: AbortSignal): Promise<EditorPageChangePlan>;
  applyPageChange?(plan: EditorPageChangePlan, signal: AbortSignal): Promise<EditorPageChangeResult>;
  /** 全ページの draft / 公開参照を同一トランザクションで切り離せるホストだけ true。 */
  siteStyleCapabilities?: { atomicReferenceDetachment: true };
  /** サイト共通の設定。version は楽観ロック用の opaque な値。 */
  readSiteSettings?(siteId: string, signal: AbortSignal): Promise<EditorSiteSettingsSnapshot>;
  saveSiteSettings?(request: { siteId: string; settings: SiteSettings; expectedVersion: string;
    /** スタイル変更時の保存済み基準。削除参照を全ページで切り離し、設定と原子的に保存する。 */
    previousStyles?: SiteStyles;
  }, signal: AbortSignal): Promise<EditorSiteSettingsSaveResult>;
  /** 版履歴。新しい順で、続きは next を cursor に渡す。実装した場合だけ「履歴」を表示する。 */
  listRevisions?(request: { target: EditorTarget; cursor?: string }, signal: AbortSignal): Promise<EditorRevisionPage>;
  /** 共通スタイルを参照する版は、その版に対応する不変のスタイル snapshot も返す。 */
  readRevision?(request: { target: EditorTarget; id: string }, signal: AbortSignal): Promise<{ document: unknown; siteStyles?: SiteStyles; presentation?: unknown }>;
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
/** 同じiframeへ表示する、ホスト所有の同期Reactプレビュー。文書を直接変更しない。 */
export type EditorCanvasPreviewProps = {
  document: PageDocument;
  /** 未保存編集の基準版。共有部品の編集中は部品ライブラリの版、それ以外はページ下書きの版。 */
  baseVersion: string;
  /** 履歴表示で選択した版。ホストが同じ版の関連表示資源を選ぶために使う。 */
  historyRevision?: EditorRevisionEntry;
  width: number;
  breakpoint: number | "base";
  mode: "edit" | "preview" | "history";
  readOnly: boolean;
  /** 従来の文書描画。編集文書を置き換えない場合はそのまま返せる。 */
  children: ReactNode;
};
export type PageEditorProps = {
  adapter: EditorAdapter;
  /** ホストが用意する戻るなどの操作をツールバーの先頭へ表示する。 */
  toolbarStart?: ReactNode;
  blocks?: EditorBlockRegistry;
  /** 信頼する外部サービスにだけorigin保持を許す、ホスト所有の実行時policy。 */
  externalFramePolicy?: ExternalFramePolicy;
  /** 標準の挿入・モーションカタログを同じ ID で置換、または新しい項目で拡張する。 */
  builder?: BuilderDefinition;
  /** Canvasと同じiframe内で描画する。予約・送信などの副作用を起こさず、未指定時は従来どおり。 */
  previewComponent?: ComponentType<EditorCanvasPreviewProps>;
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
