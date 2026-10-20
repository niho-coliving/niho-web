"use client";

import { useCallback, useMemo, useState } from "react";
import { parseProject, type Project } from "./projects.js";
import { parseProjectDashboardResult, type ProjectDashboardAdapter, type ProjectDashboardResult, type ProjectOverview } from "./project-read-model.js";
import { dateLabel, PublicationBadge, ReadNotice, Timestamp, useProjectRead } from "./project-view-shared.js";
import { projectViewCss } from "./project-view-style.js";

export { parseProjectDashboardResult } from "./project-read-model.js";
export type { ProjectAnalytics, ProjectDashboardAdapter, ProjectDashboardResult, ProjectOverview, ProjectTarget, ReadSection } from "./project-read-model.js";
export type ProjectDashboardProps = {
  project: Project;
  adapter: ProjectDashboardAdapter;
  onBackToProjects: () => void;
  onOpenEditor: (project: Project) => void;
  /** 設定の実装はホストが持つ。analyticsは実際の接続設定を開く。 */
  onOpenSettings: (project: Project, section: "site" | "analytics") => void;
};

type ReadyDashboard = Extract<ProjectDashboardResult, { status: "ready" }>;
const numberLabel = (value: number | null) => value === null ? "未取得" : value.toLocaleString("ja-JP");

function Overview({ overview }: { overview: ProjectOverview }) {
  return <><PublicationBadge status={overview.publicationStatus} />
    <p>{overview.publishedUrl ? <a className="pv-domain" href={overview.publishedUrl} target="_blank" rel="noopener noreferrer">{overview.publishedUrl}</a> : overview.publicationStatus === "unpublished" ? "サイトはまだ公開されていません。" : "公開URLは未取得です。"}</p>
    <dl className="pv-stats"><div><dt>公開ページ数</dt><dd>{numberLabel(overview.publishedPageCount)}</dd></div><div><dt>素材使用量</dt><dd>{overview.assetBytes === null ? "未取得" : `${numberLabel(overview.assetBytes)} B`}</dd></div></dl>
    <p className="pv-muted">最終公開 {overview.lastPublishedAt === null && overview.publicationStatus === "unpublished" ? "未公開" : <Timestamp value={overview.lastPublishedAt} />}</p>
    {overview.publishedUrl && <div className="pv-actions"><a className="pv-link" href={overview.publishedUrl} target="_blank" rel="noopener noreferrer">公開サイト確認 <span aria-label="新しいタブ">↗</span></a></div>}
  </>;
}
function Analytics({ result, connect, retry }: { result: ReadyDashboard["analytics"]; connect: () => void; retry: () => void }) {
  if (result.status === "disconnected") return <><p>アクセス解析はまだ接続されていません。</p><p className="pv-muted">解析サービスを接続すると、このサイトの訪問状況を確認できます。</p><div className="pv-actions"><button type="button" onClick={connect}>解析接続設定</button></div></>;
  if (result.status === "unavailable") return <><p role="alert">アクセス解析を取得できませんでした。</p><div className="pv-actions"><button type="button" onClick={retry}>再試行</button><button type="button" onClick={connect}>解析接続設定</button></div></>;
  return <><p className="pv-period">対象期間 <time dateTime={result.data.period.start}>{dateLabel(result.data.period.start)}</time> 〜 <time dateTime={result.data.period.end}>{dateLabel(result.data.period.end)}</time></p>
    <dl className="pv-stats"><div><dt>訪問者数</dt><dd>{numberLabel(result.data.uniqueVisitors)}</dd></div><div><dt>ページ表示数</dt><dd>{numberLabel(result.data.pageViews)}</dd></div></dl>
    <p className="pv-fetched">解析取得日時 <Timestamp value={result.data.fetchedAt} /></p><div className="pv-actions"><button type="button" onClick={connect}>解析接続設定</button></div></>;
}

export function ProjectDashboard(props: ProjectDashboardProps) {
  const [source, setSource] = useState({ adapter: props.adapter, project: props.project, generation: 0 });
  if (source.adapter !== props.adapter || source.project !== props.project) {
    setSource({ adapter: props.adapter, project: props.project, generation: source.generation + 1 }); return null;
  }
  return <DashboardSession key={source.generation} {...props} />;
}
function DashboardSession({ project: inputProject, adapter, onBackToProjects, onOpenEditor, onOpenSettings }: ProjectDashboardProps) {
  const project = useMemo(() => { try { return parseProject(inputProject); } catch { return null; } }, [inputProject]);
  const reader = useCallback(async (signal: AbortSignal) => {
    if (!project) throw new Error("invalid selected project");
    const response = await adapter.loadDashboard({ projectId: project.id, siteId: project.site.id }, signal);
    return parseProjectDashboardResult(response, project);
  }, [adapter, project]);
  const { state, reload } = useProjectRead(reader);
  const [view, setView] = useState<"overview" | "analytics">("overview");
  const result = state.status === "complete" && state.value.status === "ready" ? state.value : null;
  return <section className="nw-project-view" aria-label="プロジェクトダッシュボード"><style dangerouslySetInnerHTML={{ __html: projectViewCss }} />
    <button type="button" className="pv-back" onClick={onBackToProjects}>‹ プロジェクト一覧</button>
    <header className="pv-header"><div className="pv-heading"><h1>{result && project ? project.name : "ダッシュボード"}</h1>{result && project && <p className="pv-muted">{project.site.name}</p>}</div>{result && project && <button type="button" className="pv-primary" onClick={() => onOpenEditor(project)}>エディター</button>}</header>
    {state.status !== "complete" ? <ReadNotice status={state.status} noun="ダッシュボード" retry={reload} />
      : state.value.status === "forbidden" ? <ReadNotice status="forbidden" noun="ダッシュボード" retry={reload} />
      : result && project && <>
        <nav className="pv-nav" aria-label="プロジェクト操作"><button type="button" aria-current={view === "overview" ? "page" : undefined} onClick={() => setView("overview")}>概要</button><button type="button" aria-current={view === "analytics" ? "page" : undefined} onClick={() => setView("analytics")}>アクセス解析</button><button type="button" onClick={() => onOpenSettings(project, "site")}>サイト設定</button></nav>
        {view === "analytics" ? <section className="pv-panel"><h2>アクセス解析</h2><Analytics result={result.analytics} connect={() => onOpenSettings(project, "analytics")} retry={reload} /></section>
          : <div className="pv-sections"><section className="pv-panel"><h2>公開情報</h2>{result.overview.status === "ready" ? <Overview overview={result.overview.data} /> : <><p role="alert">公開情報を取得できませんでした。</p><button type="button" onClick={reload}>再試行</button></>}</section>
            <section className="pv-panel"><h2>直近の変更</h2>{result.overview.status === "unavailable" ? <p role="alert">変更履歴を取得できませんでした。</p> : result.overview.data.recentChanges.length === 0 ? <p className="pv-muted">直近の変更はありません。</p> : <ul className="pv-changes">{result.overview.data.recentChanges.map((change) => <li key={change.id}>{change.label}<Timestamp value={change.changedAt} /></li>)}</ul>}</section>
          </div>}
        <div className="pv-footer"><p className="pv-fetched">ダッシュボード取得日時 <Timestamp value={result.fetchedAt} /></p><button type="button" onClick={reload}>再読込</button></div>
      </>}
  </section>;
}
