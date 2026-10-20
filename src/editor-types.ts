import type { BlockDefinition } from "./react.js";
import type { PageDocument, PublicPropValue } from "./types.js";

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
};
export type EditorReleasePlan = EditorReleaseRequest & {
  confirmationToken: string;
  domain: string;
  changes: readonly { path: string; before: string; after: string }[];
};
export type EditorReleaseResult = { status: "released"; snapshot: EditorSnapshot } | { status: "conflict" };
/** 認証・認可・通信・公開処理は、認証済みホストの責務。 */
export interface EditorAdapter {
  listSites(signal: AbortSignal): Promise<readonly EditorSite[]>;
  listPages(siteId: string, signal: AbortSignal): Promise<readonly EditorPage[]>;
  readDocument(target: EditorTarget, signal: AbortSignal): Promise<EditorSnapshot>;
  saveDraft(request: { target: EditorTarget; document: PageDocument; expectedVersion: string }, signal: AbortSignal): Promise<EditorSaveResult>;
  prepareRelease(request: EditorReleaseRequest, signal: AbortSignal): Promise<EditorReleasePlan>;
  release(request: EditorReleasePlan, signal: AbortSignal): Promise<EditorReleaseResult>;
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
