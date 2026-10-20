import { parseProject, parseProjectCatalog, type Project } from "./projects.js";
import { fail, identifier, isSafePublicUrl, keys, record } from "./validation-utils.js";

export type ProjectTarget = { readonly projectId: string; readonly siteId: string };
export type PublicationStatus = "published" | "unpublished" | "unknown";
export type ProjectSummary = ProjectTarget & {
  readonly publicationStatus: PublicationStatus;
  readonly publishedUrl: string | null;
  readonly thumbnail: { readonly url: string; readonly alt: string } | null;
  readonly updatedAt: string | null;
  readonly lastAccessedAt: string | null;
};
export type ProjectDirectoryEntry = { readonly project: Project; readonly summary: ProjectSummary };
export type ProjectDirectoryResult =
  | { readonly status: "ready"; readonly entries: readonly ProjectDirectoryEntry[] }
  | { readonly status: "forbidden" };

/** ホストは各読取で認証・参加資格を確認し、許可されたProjectだけを返す。 */
export interface ProjectDirectoryAdapter {
  loadDirectory(signal: AbortSignal): Promise<unknown>;
  /** 公開画像・利用可能な素材だけを許可する。URLは画像描画前にこの関数で照合される。 */
  isThumbnailUrlAllowed(url: string): boolean;
}
export type ProjectOverview = {
  readonly publicationStatus: PublicationStatus;
  readonly publishedUrl: string | null;
  readonly lastPublishedAt: string | null;
  readonly publishedPageCount: number | null;
  readonly assetBytes: number | null;
  readonly recentChanges: readonly { readonly id: string; readonly label: string; readonly changedAt: string }[];
};
export type ProjectAnalytics = {
  readonly period: { readonly start: string; readonly end: string };
  readonly fetchedAt: string;
  readonly uniqueVisitors: number | null;
  readonly pageViews: number | null;
};
export type ReadSection<T> = { readonly status: "ready"; readonly data: T } | { readonly status: "unavailable" };
export type ProjectDashboardResult =
  | (ProjectTarget & {
    readonly status: "ready";
    readonly fetchedAt: string;
    readonly overview: ReadSection<ProjectOverview>;
    readonly analytics: ReadSection<ProjectAnalytics> | { readonly status: "disconnected" };
  })
  | (ProjectTarget & { readonly status: "forbidden" });

/** 認可・集計・永続化はホストの責務。部分失敗はunavailable、権限喪失はforbiddenを返す。 */
export interface ProjectDashboardAdapter {
  loadDashboard(target: ProjectTarget, signal: AbortSignal): Promise<unknown>;
}

function text(input: unknown, path: string, max = 240): string {
  if (typeof input !== "string" || !input.trim() || input.length > max || /\p{Cc}/u.test(input)) fail(path, "invalid text");
  return input;
}
function date(input: unknown, path: string): string {
  const value = text(input, path, 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match) fail(path, "expected an ISO timestamp with timezone");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const validCalendar = month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
  const validClock = Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59;
  const validOffset = offsetHourText === undefined || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59);
  if (!validCalendar || !validClock || !validOffset || !Number.isFinite(Date.parse(value))) fail(path, "expected a valid ISO timestamp with timezone");
  return value;
}
function nullableDate(input: unknown, path: string): string | null { return input === null ? null : date(input, path); }
function count(input: unknown, path: string): number | null {
  if (input === null) return null;
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) fail(path, "expected a nonnegative safe integer or null");
  return input;
}
function publication(value: Record<string, unknown>, project: Project, path: string): Pick<ProjectSummary, "publicationStatus" | "publishedUrl"> {
  const status = value.publicationStatus;
  if (status !== "published" && status !== "unpublished" && status !== "unknown") fail(path, "invalid publication status");
  const url = value.publishedUrl;
  if (url !== null) {
    if (status !== "published" || !isSafePublicUrl(url) || !url.startsWith("https://") || !project.site.domains.includes(new URL(url).origin)) fail(path, "published URL is outside the selected site");
  }
  return { publicationStatus: status, publishedUrl: url as string | null };
}
function target(value: Record<string, unknown>, expected: ProjectTarget, path: string): ProjectTarget {
  const projectId = identifier(value.projectId, `${path}.projectId`), siteId = identifier(value.siteId, `${path}.siteId`);
  if (projectId !== expected.projectId || siteId !== expected.siteId) fail(path, "project/site identity mismatch");
  return { projectId, siteId };
}

/** Projectは既存parserで検証し、summaryは正本に混ぜず別に検証する。許可外画像は空のプレビューにする。 */
export function parseProjectDirectoryResult(input: unknown, isThumbnailUrlAllowed: (url: string) => boolean): ProjectDirectoryResult {
  const value = record(input, "directory");
  if (value.status === "forbidden") { keys(value, ["status"], "directory"); return { status: "forbidden" }; }
  keys(value, ["status", "entries"], "directory");
  if (value.status !== "ready" || !Array.isArray(value.entries) || value.entries.length > 100) fail("directory", "invalid directory response");
  const entries = value.entries.map((inputEntry, index): ProjectDirectoryEntry => {
    const path = `directory.entries[${index}]`, entry = record(inputEntry, path);
    keys(entry, ["project", "summary"], path);
    const project = parseProject(entry.project, `${path}.project`), summary = record(entry.summary, `${path}.summary`);
    keys(summary, ["projectId", "siteId", "publicationStatus", "publishedUrl", "thumbnail", "updatedAt", "lastAccessedAt"], `${path}.summary`);
    const identity = target(summary, { projectId: project.id, siteId: project.site.id }, `${path}.summary`);
    let thumbnail: ProjectSummary["thumbnail"] = null;
    if (summary.thumbnail !== null) {
      const image = record(summary.thumbnail, `${path}.thumbnail`);
      keys(image, ["url", "alt"], `${path}.thumbnail`);
      const url = text(image.url, `${path}.thumbnail.url`, 2048), alt = text(image.alt, `${path}.thumbnail.alt`);
      if (isSafePublicUrl(url) && !url.startsWith("#") && isThumbnailUrlAllowed(url)) thumbnail = { url, alt };
    }
    return { project, summary: { ...identity, ...publication(summary, project, path), thumbnail, updatedAt: nullableDate(summary.updatedAt, `${path}.updatedAt`), lastAccessedAt: nullableDate(summary.lastAccessedAt, `${path}.lastAccessedAt`) } };
  });
  parseProjectCatalog({ projects: entries.map((entry) => entry.project) });
  return { status: "ready", entries };
}

function section<T>(input: unknown, path: string, parse: (value: Record<string, unknown>) => T): ReadSection<T> {
  const value = record(input, path);
  if (value.status === "unavailable") { keys(value, ["status"], path); return { status: "unavailable" }; }
  keys(value, ["status", "data"], path);
  if (value.status !== "ready") fail(path, "invalid section status");
  return { status: "ready", data: parse(record(value.data, `${path}.data`)) };
}
export function parseProjectDashboardResult(input: unknown, inputProject: Project): ProjectDashboardResult {
  const project = parseProject(inputProject), value = record(input, "dashboard");
  const identity = target(value, { projectId: project.id, siteId: project.site.id }, "dashboard");
  if (value.status === "forbidden") { keys(value, ["status", "projectId", "siteId"], "dashboard"); return { ...identity, status: "forbidden" }; }
  keys(value, ["status", "projectId", "siteId", "fetchedAt", "overview", "analytics"], "dashboard");
  if (value.status !== "ready") fail("dashboard.status", "invalid status");
  const overview = section(value.overview, "overview", (data): ProjectOverview => {
    keys(data, ["publicationStatus", "publishedUrl", "lastPublishedAt", "publishedPageCount", "assetBytes", "recentChanges"], "overview.data");
    if (!Array.isArray(data.recentChanges) || data.recentChanges.length > 20) fail("overview.recentChanges", "invalid changes");
    const recentChanges = data.recentChanges.map((inputChange) => {
      const change = record(inputChange, "change"); keys(change, ["id", "label", "changedAt"], "change");
      return { id: identifier(change.id, "change.id"), label: text(change.label, "change.label"), changedAt: date(change.changedAt, "change.changedAt") };
    });
    if (new Set(recentChanges.map((change) => change.id)).size !== recentChanges.length) fail("overview.recentChanges", "duplicate change");
    return { ...publication(data, project, "overview"), lastPublishedAt: nullableDate(data.lastPublishedAt, "overview.lastPublishedAt"), publishedPageCount: count(data.publishedPageCount, "overview.publishedPageCount"), assetBytes: count(data.assetBytes, "overview.assetBytes"), recentChanges };
  });
  const rawAnalytics = record(value.analytics, "analytics");
  // 未接続と取得失敗を区別し、未取得の数値を0へ変換しない。
  const parsedAnalytics = rawAnalytics.status === "disconnected"
    ? (keys(rawAnalytics, ["status"], "analytics"), { status: "disconnected" as const })
    : section(rawAnalytics, "analytics", (data): ProjectAnalytics => {
      keys(data, ["period", "fetchedAt", "uniqueVisitors", "pageViews"], "analytics.data");
      const period = record(data.period, "analytics.period"); keys(period, ["start", "end"], "analytics.period");
      const start = date(period.start, "analytics.period.start"), end = date(period.end, "analytics.period.end");
      if (Date.parse(end) < Date.parse(start)) fail("analytics.period", "invalid period");
      return { period: { start, end }, fetchedAt: date(data.fetchedAt, "analytics.fetchedAt"), uniqueVisitors: count(data.uniqueVisitors, "analytics.uniqueVisitors"), pageViews: count(data.pageViews, "analytics.pageViews") };
    });
  return { status: "ready", ...identity, fetchedAt: date(value.fetchedAt, "dashboard.fetchedAt"), overview, analytics: parsedAnalytics };
}
