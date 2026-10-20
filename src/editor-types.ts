import type { BlockDefinition } from "./react.js";
import type { PageKind, PageVisibility, SiteSettings } from "./pages.js";
import type { PageDocument, PublicPropValue } from "./types.js";
export type { PageKind, PageVisibility, SiteSettings } from "./pages.js";

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
};
export type EditorReleasePlan = EditorReleaseRequest & {
  confirmationToken: string;
  domain: string;
  changes: readonly { path: string; before: string; after: string }[];
};
export type EditorReleaseResult = { status: "released"; snapshot: EditorSnapshot } | { status: "conflict" };
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
  saveDraft(request: { target: EditorTarget; document: PageDocument; expectedVersion: string }, signal: AbortSignal): Promise<EditorSaveResult>;
  prepareRelease(request: EditorReleaseRequest, signal: AbortSignal): Promise<EditorReleasePlan>;
  release(request: EditorReleasePlan, signal: AbortSignal): Promise<EditorReleaseResult>;
  /** ページ操作の影響と確認 token。両方を実装した場合だけページ操作を表示する。 */
  preparePageChange?(change: EditorPageChange, signal: AbortSignal): Promise<EditorPageChangePlan>;
  applyPageChange?(plan: EditorPageChangePlan, signal: AbortSignal): Promise<EditorPageChangeResult>;
  /** サイト共通の設定。version は楽観ロック用の opaque な値。 */
  readSiteSettings?(siteId: string, signal: AbortSignal): Promise<EditorSiteSettingsSnapshot>;
  saveSiteSettings?(request: { siteId: string; settings: SiteSettings; expectedVersion: string }, signal: AbortSignal): Promise<EditorSiteSettingsSaveResult>;
}
export type EditorBlockRegistry = Readonly<Record<string, BlockDefinition & {
  label?: string;
  defaultProps?: Record<string, PublicPropValue>;
  /** データ連動値。すべての同種ブロックへ適用し、理由を表示する。 */
  lockedProps?: Readonly<Record<string, string>>;
}>>;
export type PageEditorProps = {
  adapter: EditorAdapter;
  blocks?: EditorBlockRegistry;
  /** 新規配置できる登録ブロック。省略時は全件、空配列なら既存ブロックの編集だけを許可。 */
  insertableBlocks?: readonly string[];
};
