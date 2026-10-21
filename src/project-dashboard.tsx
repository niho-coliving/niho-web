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
  /** editor bridge未接続時は、ホストの説明surfaceを開ける正直なラベルにする。 */
  editorAction?: "enabled" | "pending";
  /** ホストに設定画面がない場合は、設定操作を無効として表示する。 */
  settingsAction?: "enabled" | "disabled";
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
function Analytics({ result, connect, retry, settingsAction }: { result: ReadyDashboard["analytics"]; connect: () => void; retry: () => void; settingsAction: "enabled" | "disabled" }) {
  const settingsButton = <button type="button" onClick={connect} disabled={settingsAction === "disabled"}>{settingsAction === "disabled" ? "解析接続（準備中）" : "解析接続設定"}</button>;
  if (result.status === "disconnected") return <><p>アクセス解析はまだ接続されていません。</p><p className="pv-muted">解析サービスを接続すると、このサイトの訪問状況を確認できます。</p><div className="pv-actions">{settingsButton}</div></>;
  if (result.status === "unavailable") return <><p role="alert">アクセス解析を取得できませんでした。</p><div className="pv-actions"><button type="button" onClick={retry}>再試行</button>{settingsButton}</div></>;
  return <><p className="pv-period">対象期間 <time dateTime={result.data.period.start}>{dateLabel(result.data.period.start)}</time> 〜 <time dateTime={result.data.period.end}>{dateLabel(result.data.period.end)}</time></p>
    <dl className="pv-stats"><div><dt>訪問者数</dt><dd>{numberLabel(result.data.uniqueVisitors)}</dd></div><div><dt>ページ表示数</dt><dd>{numberLabel(result.data.pageViews)}</dd></div></dl>
    <p className="pv-fetched">解析取得日時 <Timestamp value={result.data.fetchedAt} /></p><div className="pv-actions">{settingsButton}</div></>;
}
function AnalyticsSummary({ result, open }: { result: ReadyDashboard["analytics"]; open: () => void }) {
  return <section className="pv-panel pv-analytics-summary"><h2>アクセス解析</h2>
    {result.status === "ready" ? <><dl className="pv-stats"><div><dt>訪問者数</dt><dd>{numberLabel(result.data.uniqueVisitors)}</dd></div><div><dt>ページ表示数</dt><dd>{numberLabel(result.data.pageViews)}</dd></div></dl>
      <p className="pv-period">対象期間 <time dateTime={result.data.period.start}>{dateLabel(result.data.period.start)}</time> 〜 <time dateTime={result.data.period.end}>{dateLabel(result.data.period.end)}</time></p>
      <p className="pv-fetched">解析取得日時 <Timestamp value={result.data.fetchedAt} /></p></>
      : <p role={result.status === "unavailable" ? "alert" : undefined}>{result.status === "disconnected" ? "アクセス解析はまだ接続されていません。" : "アクセス解析を取得できませんでした。"}</p>}
    <div className="pv-actions"><button type="button" onClick={open}>アクセス解析を見る</button></div>
  </section>;
}

export function ProjectDashboard(props: ProjectDashboardProps) {
  const [source, setSource] = useState({ adapter: props.adapter, project: props.project, generation: 0 });
  if (source.adapter !== props.adapter || source.project !== props.project) {
    setSource({ adapter: props.adapter, project: props.project, generation: source.generation + 1 }); return null;
  }
  return <DashboardSession key={source.generation} {...props} />;
}
function DashboardSession({ project: inputProject, adapter, onBackToProjects, onOpenEditor, onOpenSettings, editorAction = "enabled", settingsAction = "enabled" }: ProjectDashboardProps) {
  const project = useMemo(() => { try { return parseProject(inputProject); } catch { return null; } }, [inputProject]);
  const reader = useCallback(async (signal: AbortSignal) => {
    if (!project) throw new Error("invalid selected project");
    const response = await adapter.loadDashboard({ projectId: project.id, siteId: project.site.id }, signal);
    return parseProjectDashboardResult(response, project);
  }, [adapter, project]);
  const { state, reload } = useProjectRead(reader);
  const [view, setView] = useState<"overview" | "analytics" | "members">("overview");
  const result = state.status === "complete" && state.value.status === "ready" ? state.value : null;
  return <section className="nw-project-view nw-project-dashboard" aria-label="プロジェクトダッシュボード"><style dangerouslySetInnerHTML={{ __html: projectViewCss }} />
    {state.status !== "complete" ? <ReadNotice status={state.status} noun="ダッシュボード" retry={reload} />
      : state.value.status === "forbidden" ? <ReadNotice status="forbidden" noun="ダッシュボード" retry={reload} />
      : result && project && <>
        <header className="pv-project-bar">
          <button type="button" className="pv-project-back" onClick={onBackToProjects} aria-label="プロジェクト一覧へ戻る">‹</button>
          <div className="pv-project-identity" data-publication={result.overview.status === "ready" ? result.overview.data.publicationStatus : "unknown"}><strong>{project.name}</strong><span><i aria-hidden="true" />{project.site.domains[0] ?? project.site.name}</span></div>
          <nav className="pv-global-nav" aria-label="サイト機能">
            <button type="button" aria-current={view !== "analytics" ? "page" : undefined} onClick={() => setView("overview")}>ホーム</button>
            <button type="button" aria-current={view === "analytics" ? "page" : undefined} onClick={() => setView("analytics")}>アナリティクス</button>
            <button type="button" onClick={() => onOpenSettings(project, "site")} disabled={settingsAction === "disabled"}>{settingsAction === "disabled" ? "設定（準備中）" : "設定"}</button>
          </nav>
          <button type="button" className="pv-editor-link" onClick={() => onOpenEditor(project)}>{editorAction === "pending" ? "エディター接続待ち" : "デザインエディタ"}</button>
        </header>
        <div className="pv-dashboard-layout">
          <nav className="pv-home-nav" aria-label="ホームメニュー">
            <button type="button" aria-current={view === "overview" ? "page" : undefined} onClick={() => setView("overview")}>ダッシュボード</button>
            <button type="button" onClick={() => onOpenSettings(project, "site")} disabled={settingsAction === "disabled"}>{settingsAction === "disabled" ? "プロジェクト設定（準備中）" : "プロジェクト設定"}</button>
            <button type="button" aria-current={view === "members" ? "page" : undefined} onClick={() => setView("members")}>メンバー</button>
          </nav>
          <main className="pv-dashboard-content">
            <h2 className="pv-page-title">{view === "overview" ? "ダッシュボード" : view === "analytics" ? "アナリティクス" : "メンバー"}</h2>
            {view === "analytics" ? <section className="pv-panel"><h2>アクセス解析</h2><Analytics result={result.analytics} connect={() => onOpenSettings(project, "analytics")} retry={reload} settingsAction={settingsAction} /></section>
              : view === "members" ? <section className="pv-panel"><h2>メンバー（{project.members.length}名）</h2>{project.members.length === 0 ? <p className="pv-muted">メンバーはいません。</p> : <ul className="pv-member-list">{project.members.map((member) => <li key={member.userId}>{member.displayName}</li>)}</ul>}</section>
              : <div className="pv-sections"><section className="pv-panel"><h2>公開情報</h2>{result.overview.status === "ready" ? <Overview overview={result.overview.data} /> : <><p role="alert">公開情報を取得できませんでした。</p><button type="button" onClick={reload}>再試行</button></>}</section>
                <section className="pv-panel"><h2>直近の変更</h2>{result.overview.status === "unavailable" ? <p role="alert">変更履歴を取得できませんでした。</p> : result.overview.data.recentChanges.length === 0 ? <p className="pv-muted">直近の変更はありません。</p> : <ul className="pv-changes">{result.overview.data.recentChanges.map((change) => <li key={change.id}>{change.label}<Timestamp value={change.changedAt} /></li>)}</ul>}</section>
                <AnalyticsSummary result={result.analytics} open={() => setView("analytics")} />
              </div>}
            <div className="pv-footer"><p className="pv-fetched">ダッシュボード取得日時 <Timestamp value={result.fetchedAt} /></p><button type="button" onClick={reload}>再読込</button></div>
          </main>
        </div>
      </>}
  </section>;
}
