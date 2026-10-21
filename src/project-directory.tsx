"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "./projects.js";
import { parseProjectDirectoryResult, type ProjectDirectoryAdapter, type ProjectSummary } from "./project-read-model.js";
import { PublicationBadge, ReadNotice, Timestamp, useProjectRead } from "./project-view-shared.js";
import { projectViewCss } from "./project-view-style.js";

export { parseProjectDirectoryResult } from "./project-read-model.js";
export type { ProjectDirectoryAdapter, ProjectDirectoryEntry, ProjectDirectoryResult, ProjectSummary } from "./project-read-model.js";
export type ProjectDirectoryProps = {
  adapter: ProjectDirectoryAdapter;
  onCreateProject: () => void;
  onOpenDashboard: (project: Project) => void;
  onOpenEditor: (project: Project) => void;
  /** ホストに作成機能がない場合は、実行不能であることを明示する。既定値は従来どおりenabled。 */
  createAction?: "enabled" | "disabled";
  /** editor bridge未接続時も、ホストの説明surfaceを開ける正直なラベルにする。Projectごとの判定にも対応する。 */
  editorAction?: "enabled" | "pending" | ((project: Project) => "enabled" | "pending");
  /** membership詳細を返さないホストでは、人数・表示名を推測表示しない。 */
  memberDetails?: "visible" | "hidden";
  /** 一覧へ戻ったとき、読込後にこのProjectの行へ一度だけfocusを戻す。 */
  initialFocusProjectId?: string;
};

function Thumbnail({ thumbnail }: { thumbnail: ProjectSummary["thumbnail"] }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <span className="pv-preview">{thumbnail && thumbnail.url !== failedUrl
    ? <img src={thumbnail.url} alt={thumbnail.alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(thumbnail.url)} />
    : <span>プレビューなし</span>}</span>;
}

/** 日常の入口。作成・参加者管理はホストの既存ProjectManagerへ接続する。 */
export function ProjectDirectory(props: ProjectDirectoryProps) {
  const [source, setSource] = useState({ adapter: props.adapter, generation: 0 });
  if (source.adapter !== props.adapter) { setSource({ adapter: props.adapter, generation: source.generation + 1 }); return null; }
  return <DirectorySession key={source.generation} {...props} />;
}
function DirectorySession({ adapter, onCreateProject, onOpenDashboard, onOpenEditor, createAction = "enabled", editorAction = "enabled", memberDetails = "visible", initialFocusProjectId }: ProjectDirectoryProps) {
  const reader = useCallback(async (signal: AbortSignal) => parseProjectDirectoryResult(await adapter.loadDirectory(signal), (url) => adapter.isThumbnailUrlAllowed(url)), [adapter]);
  const { state, reload } = useProjectRead(reader);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("updated");
  const entries = state.status === "complete" && state.value.status === "ready" ? state.value.entries : null;
  const list = useRef<HTMLDivElement>(null), focusRestored = useRef(false);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ja-JP");
    return (entries ?? []).filter(({ project }) => [project.name, project.site.name, ...project.site.domains].some((value) => value.toLocaleLowerCase("ja-JP").includes(needle))).slice().sort((a, b) => {
      if (sort === "name") return a.project.name.localeCompare(b.project.name, "ja");
      const aDate = a.summary.updatedAt, bDate = b.summary.updatedAt;
      return (bDate === null ? -Infinity : Date.parse(bDate)) - (aDate === null ? -Infinity : Date.parse(aDate)) || a.project.name.localeCompare(b.project.name, "ja");
    });
  }, [entries, query, sort]);
  useEffect(() => {
    if (!entries || !initialFocusProjectId || focusRestored.current) return;
    focusRestored.current = true;
    const row = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button.pv-list-open") ?? []).find((node) => node.dataset.projectId === initialFocusProjectId);
    row?.focus(); row?.scrollIntoView?.({ block: "nearest" });
  }, [entries, initialFocusProjectId]);
  return <section className="nw-project-view" aria-label="プロジェクト一覧"><style dangerouslySetInnerHTML={{ __html: projectViewCss }} />
    <header className="pv-header"><h1 className="pv-heading">プロジェクト一覧</h1><button type="button" className="pv-primary" onClick={onCreateProject} disabled={createAction === "disabled"} title={createAction === "disabled" ? "プロジェクト作成は管理者対応です" : undefined}>{createAction === "disabled" ? "作成（管理者対応）" : "作成"}</button></header>
    {state.status !== "complete" ? <ReadNotice status={state.status} noun="プロジェクト一覧" retry={reload} />
      : state.value.status === "forbidden" ? <ReadNotice status="forbidden" noun="プロジェクト一覧" retry={reload} />
      : <><div className="pv-toolbar">
        <label className="pv-search"><span>名前・ドメイン検索</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="プロジェクト名、サイト名、ドメイン" /></label>
        <label><span>並び順</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="updated">更新が新しい順</option><option value="name">名前順</option></select></label>
        <button type="button" onClick={reload}>再読込</button>
      </div><p className="pv-muted" role="status">{visible.length}件</p>
      {entries?.length === 0 ? <div className="pv-notice"><p>{createAction === "disabled" ? "参加中のプロジェクトはまだありません。管理者に参加を依頼してください。" : "参加中のプロジェクトはまだありません。作成するか、管理者に参加を依頼してください。"}</p></div>
        : visible.length === 0 ? <div className="pv-notice"><p>条件に一致するプロジェクトがありません。</p><button type="button" onClick={() => setQuery("")}>検索解除</button></div>
        : <><ul className="pv-grid" aria-label="プロジェクトのプレビュー">{visible.map(({ project, summary }) => <li className="pv-card" key={project.id}>
          <button type="button" className="pv-open" data-project-id={project.id} onClick={() => onOpenDashboard(project)} aria-label={`${project.name}（${project.site.name}）のダッシュボード`}><Thumbnail thumbnail={summary.thumbnail} /><span className="pv-card-title"><strong>{project.name}</strong><span>{project.site.name}</span></span></button>
          <div className="pv-card-body"><PublicationBadge status={summary.publicationStatus} />
            <div>{project.site.domains.length === 0 ? <span className="pv-muted">公開ドメイン未設定</span> : project.site.domains.map((domain) => <span className="pv-domain" key={domain}>{domain}</span>)}</div>
            {memberDetails === "visible" && <p className="pv-muted">メンバー {project.members.length}名{project.members.length > 0 && ` · ${project.members.map((member) => member.displayName).join("、")}`}</p>}
            <dl className="pv-meta"><div><dt>最終更新</dt><dd><Timestamp value={summary.updatedAt} /></dd></div><div><dt>最終アクセス</dt><dd><Timestamp value={summary.lastAccessedAt} /></dd></div></dl>
            <div className="pv-actions"><button type="button" onClick={() => onOpenDashboard(project)}>ダッシュボード</button><button type="button" onClick={() => onOpenEditor(project)}>{(typeof editorAction === "function" ? editorAction(project) : editorAction) === "pending" ? "エディター接続待ち" : "エディター"}</button></div>
          </div>
        </li>)}</ul>
        <div className="pv-directory-list" ref={list}><h2>一覧表示</h2><table><thead><tr><th scope="col">プロジェクト / サイト</th><th scope="col">公開状態・ドメイン</th><th scope="col">メンバー</th><th scope="col">最終更新 / 最終アクセス</th><th scope="col">開く</th></tr></thead><tbody>{visible.map(({ project, summary }) => <tr key={project.id}>
          <th scope="row" data-label="プロジェクト / サイト"><button type="button" className="pv-list-open" data-project-id={project.id} onClick={() => onOpenDashboard(project)} aria-label={`${project.name}（${project.site.name}）の一覧行を開く`}>{project.name}</button><span className="pv-muted">{project.site.name}</span></th>
          <td data-label="公開状態・ドメイン"><PublicationBadge status={summary.publicationStatus} /><span className="pv-list-domains">{project.site.domains.length === 0 ? <span className="pv-muted">公開ドメイン未設定</span> : project.site.domains.map((domain) => <span className="pv-domain" key={domain}>{domain}</span>)}</span></td>
          <td data-label="メンバー">{memberDetails === "visible" ? <><span>{project.members.length}名</span>{project.members.length > 0 && <span className="pv-muted pv-list-members">{project.members.map((member) => member.displayName).join("、")}</span>}</> : <span className="pv-muted">未取得</span>}</td>
          <td data-label="日時"><span>最終更新 <Timestamp value={summary.updatedAt} /></span><span>最終アクセス <Timestamp value={summary.lastAccessedAt} /></span></td>
          <td data-label="開く"><div className="pv-actions"><button type="button" onClick={() => onOpenDashboard(project)}>ダッシュボード</button><button type="button" onClick={() => onOpenEditor(project)}>{editorAction === "pending" ? "エディター接続待ち" : "エディター"}</button></div></td>
        </tr>)}</tbody></table></div></>}
      </>}
  </section>;
}
