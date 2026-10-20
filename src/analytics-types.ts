export type AnalyticsPeriod = "7d" | "28d" | "3m" | "12m";
export type AnalyticsScope = Readonly<{ projectId: string; siteId: string; period: AnalyticsPeriod }>;
export type Metric = Readonly<{ current: number | null; previous: number | null }>;
export type LocalRange = Readonly<{ start: string; end: string; timezone: string }>;
export type ReportWindow = Readonly<{ range: LocalRange; previousRange: LocalRange }>;
export type SourceUpdate = Readonly<{ lastUpdatedAt: string; dataThrough: string }>;
export type SourceMetadata = ReportWindow & SourceUpdate;
export type PublicPage = Readonly<{ path: string; title?: string }>;
export type Ga4Report = ReportWindow & Readonly<{
  sessions: Metric; activeUsers: Metric; pageViews: Metric;
  daily: readonly Readonly<{ date: string; sessions: number | null }>[];
  sources: readonly Readonly<{ name: string; sessions: Metric }>[];
  topPages: readonly Readonly<{ page: PublicPage; pageViews: Metric }>[];
}>;
export type SearchConsoleReport = ReportWindow & Readonly<{
  clicks: Metric; impressions: Metric; ctr: Metric; averagePosition: Metric;
  daily: readonly Readonly<{ date: string; clicks: number | null; impressions: number | null }>[];
  topPages: readonly Readonly<{ page: PublicPage; clicks: Metric; impressions: Metric }>[];
}>;
export type SourceResult<T extends ReportWindow> =
  | Readonly<{ state: "available" | "delayed"; report: T; lastUpdatedAt: string; dataThrough: string }>
  | Readonly<{ state: "empty"; metadata: SourceMetadata }>
  | Readonly<{ state: "not-connected" | "permission-expired" | "failed" }>;
export type SiteAnalyticsSnapshot = AnalyticsScope & Readonly<{
  ga4: SourceResult<Ga4Report>;
  searchConsole: SourceResult<SearchConsoleReport>;
}>;

/** 認証済みホストが実装する読取専用の契約。projectId と siteId の組を現在の利用者に対して認可すること。 */
export interface SiteAnalyticsAdapter {
  loadAnalytics(scope: AnalyticsScope, signal: AbortSignal): Promise<unknown>;
}
