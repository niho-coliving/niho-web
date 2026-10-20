import type { Project, ProjectCatalogSnapshot, ProjectMember } from "./projects.js";

export type CreateProjectInput = {
  readonly name: string;
  readonly siteName: string;
  readonly domains: readonly string[];
};

export type ProjectAdapterWriteResult =
  | { readonly status: "saved"; readonly snapshot: unknown }
  | { readonly status: "conflict" }
  | { readonly status: "unchanged"; readonly reason: "already-member" | "not-member" };

/** 認証済みホストが実装する。すべての更新は expectedVersion を使う atomic CAS とする。 */
export interface ProjectAdapter {
  loadCatalog(signal: AbortSignal): Promise<unknown>;
  /** ID採番と、Project + 唯一のSiteの一括保存はホストが行う。 */
  createProject(request: { input: CreateProjectInput; expectedVersion: string }, signal: AbortSignal): Promise<ProjectAdapterWriteResult>;
  /** メール等の入力識別子を既存アカウントへ照合し、保存可能な最小情報だけを返す。 */
  resolveMember(inputIdentifier: string, signal: AbortSignal): Promise<unknown | null>;
  addMember(request: { projectId: string; member: ProjectMember; expectedVersion: string }, signal: AbortSignal): Promise<ProjectAdapterWriteResult>;
  removeMember(request: { projectId: string; userId: string; expectedVersion: string }, signal: AbortSignal): Promise<ProjectAdapterWriteResult>;
}

export type ProjectManagerProps = {
  adapter: ProjectAdapter;
  onOpenProject: (project: Project) => void;
  /** adapter またはこのオブジェクトの差替えで一覧・選択・入力をリセットする。通常の再描画では参照を維持する。 */
  initialSnapshot?: ProjectCatalogSnapshot;
};
