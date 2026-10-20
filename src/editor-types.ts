import type { AssetLibraryAdapter } from "./assets.js";
import type { BlockDefinition } from "./react.js";
import type { ComponentLibrary, PageDocument, PublicPropValue } from "./types.js";

export type EditorTarget = { siteId: string; pageId: string; locale: string };
export type EditorSite = { id: string; name: string; /** 許可済み HTTPS origin（末尾 / なし）。 */ domains: readonly string[] };
export type EditorPage = EditorTarget & { title: string };
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
export type EditorReleasePlan = EditorReleaseRequest & {
  confirmationToken: string;
  domain: string;
  changes: readonly { path: string; before: string; after: string }[];
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
  role?: "page" | "template" | "frame";
  /** template / frame の場合、その文書と一緒に表示される公開ページ数。 */
  reach?: number;
  /** 部品 ID ごとのインスタンス数（入れ子の部品経由を含む）。 */
  components: Readonly<Record<string, number>>;
};
/** 保存はページの下書きと同じく、expectedVersion の比較・revision の採番・競合の変換をホストが原子的に行う。 */
export interface EditorComponentAdapter {
  readLibrary(siteId: string, signal: AbortSignal): Promise<ComponentLibrarySnapshot>;
  saveLibrary(request: { siteId: string; library: ComponentLibrary; expectedVersion: string }, signal: AbortSignal): Promise<EditorSaveResult>;
  /** 保存済みの下書きを対象にした使用状況。 */
  listUsage(siteId: string, signal: AbortSignal): Promise<readonly ComponentUsageEntry[]>;
}
/** 認証・認可・通信・公開処理は、認証済みホストの責務。 */
export interface EditorAdapter {
  listSites(signal: AbortSignal): Promise<readonly EditorSite[]>;
  listPages(siteId: string, signal: AbortSignal): Promise<readonly EditorPage[]>;
  readDocument(target: EditorTarget, signal: AbortSignal): Promise<EditorSnapshot>;
  saveDraft(request: { target: EditorTarget; document: PageDocument; expectedVersion: string }, signal: AbortSignal): Promise<EditorSaveResult>;
  prepareRelease(request: EditorReleaseRequest, signal: AbortSignal): Promise<EditorReleasePlan>;
  release(request: EditorReleasePlan, signal: AbortSignal): Promise<EditorReleaseResult>;
  /** 省略したホストでは部品機能を使わない。 */
  components?: EditorComponentAdapter;
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
  /** サイト別の素材ライブラリ。参照は安定させる。省略時は素材の UI を表示しない。 */
  assets?: AssetLibraryAdapter;
};
