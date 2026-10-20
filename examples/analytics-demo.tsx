import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SiteAnalytics, type AnalyticsScope, type SiteAnalyticsAdapter } from "@niho/web/analytics";

type State = "available" | "delayed" | "empty" | "not-connected" | "permission-expired" | "failed";
const states: State[] = ["available", "delayed", "empty", "not-connected", "permission-expired", "failed"];
const days = { "7d": 7, "28d": 28, "3m": 90, "12m": 365 } as const;
const shift = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const count = (current: number | null, previous: number | null) => ({ current, previous });
function metadata(period: AnalyticsScope["period"], timezone: string, dataThrough: string) {
  const end = "2026-10-20", start = shift(end, 1 - days[period]);
  return { range: { start, end, timezone }, previousRange: { start: shift(start, -days[period]), end: shift(start, -1), timezone }, lastUpdatedAt: "2026-10-21T08:00:00+09:00", dataThrough };
}
function makeSnapshot(scope: AnalyticsScope, ga4State: State, gscState: State) {
  const ga4Meta = metadata(scope.period, "Asia/Tokyo", "2026-10-20");
  const gscMeta = metadata(scope.period, "America/Los_Angeles", "2026-10-19");
  const ga4Daily = Array.from({ length: days[scope.period] }, (_, index) => ({ date: shift(ga4Meta.range.start, index), sessions: index % 11 === 0 ? 0 : 16 + index % 13 }));
  const gscDaily = Array.from({ length: days[scope.period] - 1 }, (_, index) => ({ date: shift(gscMeta.range.start, index), clicks: index % 9 === 0 ? null : index % 7, impressions: 25 + index % 31 }));
  const ga4Report = { range: ga4Meta.range, previousRange: ga4Meta.previousRange, sessions: count(540, 482), activeUsers: count(392, 361), pageViews: count(880, 742), daily: ga4Daily,
    sources: [{ name: "自然検索", sessions: count(250, 220) }, { name: "直接訪問", sessions: count(190, 174) }, { name: "紹介", sessions: count(100, 88) }],
    topPages: [{ page: { path: "/", title: "ホーム" }, pageViews: count(400, 362) }, { page: { path: "/about" }, pageViews: count(120, 105) }] };
  const gscReport = { range: gscMeta.range, previousRange: gscMeta.previousRange, clicks: count(68, 61), impressions: count(1210, 1150), ctr: count(0.056, 0.053), averagePosition: count(8.4, 9.1), daily: gscDaily,
    topPages: [{ page: { path: "/", title: "ホーム" }, clicks: count(38, 35), impressions: count(630, 590) }, { page: { path: "/about" }, clicks: count(12, 10), impressions: count(240, 225) }] };
  const source = (state: State, info: ReturnType<typeof metadata>, report: object) => state === "available" || state === "delayed" ? { state, report, lastUpdatedAt: info.lastUpdatedAt, dataThrough: info.dataThrough } : state === "empty" ? { state, metadata: info } : { state };
  return { ...scope, ga4: source(ga4State, ga4Meta, ga4Report), searchConsole: source(gscState, gscMeta, gscReport) };
}
function Demo() {
  const [ga4State, setGa4State] = useState<State>("available"), [gscState, setGscState] = useState<State>("delayed");
  const adapter = useMemo<SiteAnalyticsAdapter>(() => ({ loadAnalytics: async (scope) => makeSnapshot(scope, ga4State, gscState) }), [ga4State, gscState]);
  return <><div style={{ display: "flex", gap: 12, flexWrap: "wrap", font: "13px sans-serif", marginBottom: 16 }}>
    <label>GA4 の状態 <select value={ga4State} onChange={(event) => setGa4State(event.target.value as State)}>{states.map((state) => <option key={state}>{state}</option>)}</select></label>
    <label>Search Console の状態 <select value={gscState} onChange={(event) => setGscState(event.target.value as State)}>{states.map((state) => <option key={state}>{state}</option>)}</select></label>
  </div><SiteAnalytics projectId="demo_project" siteId="demo_site" adapter={adapter} /></>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
