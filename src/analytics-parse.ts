import type { AnalyticsPeriod, AnalyticsScope, Ga4Report, LocalRange, Metric, PublicPage, ReportWindow, SearchConsoleReport, SiteAnalyticsSnapshot, SourceMetadata, SourceResult, SourceUpdate } from "./analytics-types.js";

export class AnalyticsValidationError extends Error {
  constructor(readonly path: string, reason: string) { super(`${path}: ${reason}`); this.name = "AnalyticsValidationError"; }
}
const fail = (path: string, reason: string): never => { throw new AnalyticsValidationError(path, reason); };
function object(input: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail(path, "expected object");
  const value = input as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) return fail(path, "invalid fields");
  return value;
}
function string(input: unknown, path: string, max = 160): string {
  if (typeof input !== "string" || !input.trim() || input.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(input)) return fail(path, "invalid string");
  return input;
}
function id(input: unknown, path: string): string {
  const value = string(input, path, 80);
  return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value) ? value : fail(path, "invalid id");
}
function date(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(input) || Number.isNaN(Date.parse(`${input}T00:00:00Z`)) || new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) !== input) return fail(path, "invalid date");
  return input;
}
function timestamp(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(input) || Number.isNaN(Date.parse(input))) return fail(path, "invalid timestamp");
  return input;
}
function timezone(input: unknown, path: string): string {
  const value = string(input, path, 80);
  try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { return fail(path, "invalid IANA timezone"); }
  if (!value.includes("/")) return fail(path, "expected IANA area timezone");
  return value;
}
function range(input: unknown, path: string): LocalRange {
  const value = object(input, path, ["start", "end", "timezone"]);
  const start = date(value.start, `${path}.start`), end = date(value.end, `${path}.end`);
  if (end < start || (Date.parse(end) - Date.parse(start)) / 86400000 > 370) return fail(path, "invalid range");
  return { start, end, timezone: timezone(value.timezone, `${path}.timezone`) };
}
function reportWindow(value: Record<string, unknown>, path: string, source: "ga4" | "searchConsole"): ReportWindow {
  const current = range(value.range, `${path}.range`), previous = range(value.previousRange, `${path}.previousRange`);
  if (current.timezone !== previous.timezone || previous.end >= current.start || Date.parse(current.end) - Date.parse(current.start) !== Date.parse(previous.end) - Date.parse(previous.start) || Date.parse(current.start) - Date.parse(previous.end) !== 86400000) return fail(path, "ranges must be consecutive and equally long");
  if (source === "searchConsole" && current.timezone !== "America/Los_Angeles") return fail(path, "Search Console uses Pacific time");
  return { range: current, previousRange: previous };
}
function sourceUpdate(input: Record<string, unknown>, path: string, rangeEnd: string): SourceUpdate {
  const dataThrough = date(input.dataThrough, `${path}.dataThrough`);
  if (dataThrough > rangeEnd) return fail(path, "dataThrough after range");
  return { lastUpdatedAt: timestamp(input.lastUpdatedAt, `${path}.lastUpdatedAt`), dataThrough };
}
function metadata(input: unknown, path: string, source: "ga4" | "searchConsole"): SourceMetadata {
  const value = object(input, path, ["range", "previousRange", "lastUpdatedAt", "dataThrough"]);
  const window = reportWindow(value, path, source);
  return { ...window, ...sourceUpdate(value, path, window.range.end) };
}
function number(input: unknown, path: string, kind: "count" | "rate" | "position", nullable = true): number | null {
  if (input === null && nullable) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || (kind === "count" && !Number.isSafeInteger(input)) || (kind === "rate" && input > 1)) return fail(path, "invalid metric");
  return input;
}
function metric(input: unknown, path: string, kind: "count" | "rate" | "position" = "count"): Metric {
  const value = object(input, path, ["current", "previous"]);
  return { current: number(value.current, `${path}.current`, kind), previous: number(value.previous, `${path}.previous`, kind) };
}
function list<T>(input: unknown, path: string, max: number, parse: (value: unknown, path: string) => T): readonly T[] {
  if (!Array.isArray(input) || input.length > max) return fail(path, "invalid array");
  return input.map((item, index) => parse(item, `${path}[${index}]`));
}
/** リンク可能な公開ページのルートパスのみ受け付ける。表示では URL を生成しない。 */
export function parseAnalyticsPagePath(input: unknown, path = "path"): string {
  const value = string(input, path, 2048);
  if (!value.startsWith("/") || value.startsWith("//") || /[%?#\\\u0000-\u001f\u007f-\u009f]/u.test(value) || value.split("/").some((part) => part === "." || part === "..")) return fail(path, "unsafe public path");
  return value;
}
function page(input: unknown, path: string): PublicPage {
  const value = object(input, path, ["path"], ["title"]);
  const parsed: PublicPage = { path: parseAnalyticsPagePath(value.path, `${path}.path`), ...(value.title === undefined ? {} : { title: string(value.title, `${path}.title`, 200) }) };
  return parsed;
}
function daily<T>(input: unknown, path: string, dates: LocalRange, parse: (value: unknown, path: string) => T & { date: string }): readonly (T & { date: string })[] {
  const values = list(input, path, 371, parse);
  let previous = "";
  for (const value of values) { if (value.date < dates.start || value.date > dates.end || value.date <= previous) fail(path, "daily dates outside range or unordered"); previous = value.date; }
  return values;
}
function ga4(input: unknown, path: string): Ga4Report {
  const value = object(input, path, ["range", "previousRange", "sessions", "activeUsers", "pageViews", "daily", "sources", "topPages"]);
  const window = reportWindow(value, path, "ga4");
  return {
    ...window,
    sessions: metric(value.sessions, `${path}.sessions`), activeUsers: metric(value.activeUsers, `${path}.activeUsers`), pageViews: metric(value.pageViews, `${path}.pageViews`),
    daily: daily(value.daily, `${path}.daily`, window.range, (item, itemPath) => { const row = object(item, itemPath, ["date", "sessions"]); return { date: date(row.date, `${itemPath}.date`), sessions: number(row.sessions, `${itemPath}.sessions`, "count") }; }),
    sources: list(value.sources, `${path}.sources`, 30, (item, itemPath) => { const row = object(item, itemPath, ["name", "sessions"]); return { name: string(row.name, `${itemPath}.name`, 120), sessions: metric(row.sessions, `${itemPath}.sessions`) }; }),
    topPages: list(value.topPages, `${path}.topPages`, 30, (item, itemPath) => { const row = object(item, itemPath, ["page", "pageViews"]); return { page: page(row.page, `${itemPath}.page`), pageViews: metric(row.pageViews, `${itemPath}.pageViews`) }; })
  };
}
function gsc(input: unknown, path: string): SearchConsoleReport {
  const value = object(input, path, ["range", "previousRange", "clicks", "impressions", "ctr", "averagePosition", "daily", "topPages"]);
  const window = reportWindow(value, path, "searchConsole");
  return {
    ...window,
    clicks: metric(value.clicks, `${path}.clicks`), impressions: metric(value.impressions, `${path}.impressions`), ctr: metric(value.ctr, `${path}.ctr`, "rate"), averagePosition: metric(value.averagePosition, `${path}.averagePosition`, "position"),
    daily: daily(value.daily, `${path}.daily`, window.range, (item, itemPath) => { const row = object(item, itemPath, ["date", "clicks", "impressions"]); return { date: date(row.date, `${itemPath}.date`), clicks: number(row.clicks, `${itemPath}.clicks`, "count"), impressions: number(row.impressions, `${itemPath}.impressions`, "count") }; }),
    topPages: list(value.topPages, `${path}.topPages`, 30, (item, itemPath) => { const row = object(item, itemPath, ["page", "clicks", "impressions"]); return { page: page(row.page, `${itemPath}.page`), clicks: metric(row.clicks, `${itemPath}.clicks`), impressions: metric(row.impressions, `${itemPath}.impressions`) }; })
  };
}
function source<T extends ReportWindow>(input: unknown, path: string, name: "ga4" | "searchConsole", parse: (input: unknown, path: string) => T): SourceResult<T> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return fail(path, "expected object");
  const base = input as Record<string, unknown>;
  switch (base.state) {
    case "available": case "delayed": {
      const value = object(input, path, ["state", "report", "lastUpdatedAt", "dataThrough"]);
      const report = parse(value.report, `${path}.report`);
      if (name === "searchConsole" && report.range.timezone !== "America/Los_Angeles") fail(`${path}.report.range.timezone`, "Search Console uses Pacific time");
      return { state: base.state, report, ...sourceUpdate(value, path, report.range.end) };
    }
    case "empty": { const value = object(input, path, ["state", "metadata"]); return { state: "empty", metadata: metadata(value.metadata, `${path}.metadata`, name) }; }
    case "not-connected": case "permission-expired": case "failed": object(input, path, ["state"]); return { state: base.state };
    default: return fail(`${path}.state`, "unknown state");
  }
}
export function parseSiteAnalyticsSnapshot(input: unknown, scope: AnalyticsScope): SiteAnalyticsSnapshot {
  const value = object(input, "snapshot", ["projectId", "siteId", "period", "ga4", "searchConsole"]);
  const projectId = id(value.projectId, "snapshot.projectId"), siteId = id(value.siteId, "snapshot.siteId");
  const period = value.period;
  if (!["7d", "28d", "3m", "12m"].includes(period as string)) fail("snapshot.period", "invalid period");
  if (projectId !== scope.projectId || siteId !== scope.siteId || period !== scope.period) fail("snapshot", "scope mismatch");
  return { projectId, siteId, period: period as AnalyticsPeriod,
    ga4: source(value.ga4, "snapshot.ga4", "ga4", ga4),
    searchConsole: source(value.searchConsole, "snapshot.searchConsole", "searchConsole", gsc) };
}
