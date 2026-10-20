"use client";

import { useEffect, useState, type ReactNode } from "react";
import { parseSiteAnalyticsSnapshot } from "./analytics-parse.js";
import { siteAnalyticsCss } from "./analytics-style.js";
import type { AnalyticsPeriod, Ga4Report, Metric, ReportWindow, SearchConsoleReport, SiteAnalyticsAdapter, SiteAnalyticsSnapshot, SourceMetadata, SourceResult } from "./analytics-types.js";

export type * from "./analytics-types.js";
export { AnalyticsValidationError, parseAnalyticsPagePath, parseSiteAnalyticsSnapshot } from "./analytics-parse.js";
export { siteAnalyticsCss } from "./analytics-style.js";

export type SiteAnalyticsProps = Readonly<{ projectId: string; siteId: string; adapter: SiteAnalyticsAdapter; initialPeriod?: AnalyticsPeriod }>;
const periods: readonly AnalyticsPeriod[] = ["7d", "28d", "3m", "12m"];
const periodLabel: Record<AnalyticsPeriod, string> = { "7d": "7日", "28d": "28日", "3m": "3か月", "12m": "12か月" };
const format = (value: number | null, kind: "count" | "rate" | "position" = "count") => value === null ? "—" : kind === "rate" ? `${(value * 100).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}%` : value.toLocaleString("ja-JP", { maximumFractionDigits: kind === "position" ? 1 : 0 });
function MetricCard({ label, value, kind = "count" }: { label: string; value: Metric; kind?: "count" | "rate" | "position" }) {
  return <div className="an-metric"><dt>{label}</dt><dd>{format(value.current, kind)}</dd><small>直前の同期間: {format(value.previous, kind)}</small></div>;
}
function Meta({ value }: { value: SourceMetadata }) {
  return <p className="an-meta">当期 {value.range.start}〜{value.range.end} · 直前の同期間 {value.previousRange.start}〜{value.previousRange.end}<br />時間帯 {value.range.timezone} · 取得済み {value.dataThrough} · 最終更新 {value.lastUpdatedAt}</p>;
}
function Daily({ rows, label, color = "green" }: { rows: readonly { date: string; value: number | null }[]; label: string; color?: "green" | "blue" }) {
  const maximum = Math.max(1, ...rows.map((row) => row.value ?? 0));
  const points = rows.map((row, index) => row.value === null ? null : `${10 + index * 300 / Math.max(1, rows.length - 1)},${90 - row.value / maximum * 78}`);
  const segments: string[] = []; let current: string[] = [];
  for (const point of [...points, null]) { if (point) current.push(point); else if (current.length) { segments.push(current.join(" ")); current = []; } }
  return <div className="an-panel"><h3>{label}の日別推移</h3>{rows.length ? <><svg className="an-chart" viewBox="0 0 320 100" role="img" aria-label={`${label}の日別折れ線。詳細な数値は下の一覧に表示`}><path d="M10 90H310" stroke="#dce2dd" fill="none" />{segments.map((segment, index) => <polyline key={index} points={segment} fill="none" stroke={color === "blue" ? "#38677c" : "#195640"} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}</svg><ol className="an-daily" aria-label={`${label}の日別数値`}>{rows.map((row) => <li key={row.date}><time dateTime={row.date}>{row.date.slice(5)}</time><strong>{format(row.value)}</strong></li>)}</ol></> : <p className="an-empty">日別データはありません。</p>}</div>;
}
function Pages({ title, rows }: { title: string; rows: readonly { page: { path: string; title?: string }; values: string }[] }) {
  return <div className="an-panel"><h3>{title}</h3>{rows.length ? <ol className="an-list">{rows.map(({ page, values }) => <li key={page.path}><span>{page.title ?? page.path}{page.title && <small>{page.path}</small>}</span><strong>{values}</strong></li>)}</ol> : <p className="an-empty">対象ページはありません。</p>}</div>;
}
function Ga4Content({ report }: { report: Ga4Report }) {
  return <><dl className="an-metrics"><MetricCard label="セッション" value={report.sessions} /><MetricCard label="アクティブユーザー" value={report.activeUsers} /><MetricCard label="ページ表示" value={report.pageViews} /></dl>
    <div className="an-grid"><Daily rows={report.daily.map((row) => ({ date: row.date, value: row.sessions }))} label="セッション" /><div className="an-panel"><h3>流入元別セッション</h3>{report.sources.length ? <ol className="an-list">{report.sources.map((source) => <li key={source.name}><span>{source.name}</span><strong>{format(source.sessions.current)}<small>直前 {format(source.sessions.previous)}</small></strong></li>)}</ol> : <p className="an-empty">流入元データはありません。</p>}</div></div>
    <Pages title="GA4 上位ページ · ページ表示" rows={report.topPages.map((row) => ({ page: row.page, values: `${format(row.pageViews.current)}（直前 ${format(row.pageViews.previous)}）` }))} /></>;
}
function GscContent({ report }: { report: SearchConsoleReport }) {
  return <><dl className="an-metrics"><MetricCard label="クリック" value={report.clicks} /><MetricCard label="表示回数" value={report.impressions} /><MetricCard label="CTR" value={report.ctr} kind="rate" /><MetricCard label="平均掲載順位" value={report.averagePosition} kind="position" /></dl>
    <div className="an-grid"><Daily rows={report.daily.map((row) => ({ date: row.date, value: row.clicks }))} label="クリック" color="blue" /><Daily rows={report.daily.map((row) => ({ date: row.date, value: row.impressions }))} label="表示回数" color="blue" /></div>
    <Pages title="Search Console 上位ページ · クリック / 表示回数" rows={report.topPages.map((row) => ({ page: row.page, values: `${format(row.clicks.current)} / ${format(row.impressions.current)}（直前 ${format(row.clicks.previous)} / ${format(row.impressions.previous)}）` }))} /></>;
}
const stateLabel = { available: "利用可能", delayed: "更新に遅れがあります", empty: "データなし", "not-connected": "未接続", "permission-expired": "権限の再接続が必要", failed: "取得失敗" } as const;
function SourcePanel<T extends ReportWindow>({ name, result, children }: { name: string; result: SourceResult<T>; children: (report: T) => ReactNode }) {
  return <section className="an-source" aria-label={name}><div className="an-source-head"><h2>{name}</h2><span className={`an-badge${result.state !== "available" ? " an-warning" : ""}`}>{stateLabel[result.state]}</span></div>
    {"metadata" in result ? <Meta value={result.metadata} /> : "report" in result && <Meta value={{ range: result.report.range, previousRange: result.report.previousRange, lastUpdatedAt: result.lastUpdatedAt, dataThrough: result.dataThrough }} />}
    {"report" in result ? children(result.report) : <p className="an-empty" role={result.state === "failed" ? "alert" : "status"}>{result.state === "empty" ? "この期間の集計はありません。" : result.state === "not-connected" ? "このデータソースは接続されていません。" : result.state === "permission-expired" ? "接続の権限が期限切れです。ホスト側で再接続してください。" : "このデータソースを取得できませんでした。再試行してください。"}</p>}
  </section>;
}
type LoadState = { key: string; adapter: SiteAnalyticsAdapter; status: "loading" | "error" | "ready"; snapshot?: SiteAnalyticsSnapshot };
/** プロジェクトとサイトを固定した読取専用画面。ホストが両IDの認可を行う。 */
export function SiteAnalytics({ projectId, siteId, adapter, initialPeriod = "28d" }: SiteAnalyticsProps) {
  const [period, setPeriod] = useState<AnalyticsPeriod>(initialPeriod), [retry, setRetry] = useState(0);
  const key = `${projectId}\u0000${siteId}\u0000${period}\u0000${retry}`;
  const [load, setLoad] = useState<LoadState>({ key, adapter, status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ key, adapter, status: "loading" });
    Promise.resolve().then(() => adapter.loadAnalytics({ projectId, siteId, period }, controller.signal)).then((input) => {
      if (!controller.signal.aborted) setLoad({ key, adapter, status: "ready", snapshot: parseSiteAnalyticsSnapshot(input, { projectId, siteId, period }) });
    }).catch(() => { if (!controller.signal.aborted) setLoad({ key, adapter, status: "error" }); });
    return () => controller.abort();
  }, [adapter, key, period, projectId, siteId]);
  const current = load.key === key && load.adapter === adapter ? load : { key, adapter, status: "loading" as const };
  return <div className="nw-analytics"><style dangerouslySetInnerHTML={{ __html: siteAnalyticsCss }} />
    <header className="an-header"><div><h1>サイト分析</h1><p className="an-muted">GA4 と Search Console の集計</p></div><button type="button" onClick={() => setRetry((value) => value + 1)} disabled={current.status === "loading"}>再読み込み</button></header>
    <fieldset className="an-periods"><legend>表示期間</legend><div>{periods.map((option) => <button type="button" key={option} aria-pressed={period === option} onClick={() => setPeriod(option)}>{periodLabel[option]}</button>)}</div></fieldset>
    {current.status === "loading" ? <p role="status">分析データを読み込んでいます。</p> : current.status === "error" ? <p role="alert" className="an-error">分析データを読み込めませんでした。再読み込みしてください。</p> : current.snapshot && <><SourcePanel name="GA4" result={current.snapshot.ga4}>{(report) => <Ga4Content report={report} />}</SourcePanel><SourcePanel name="Search Console" result={current.snapshot.searchConsole}>{(report) => <GscContent report={report} />}</SourcePanel></>}
  </div>;
}
