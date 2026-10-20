import { identifier, isSafeHttpsOrigin, record, string } from "./validation-utils.js";

export type SiteAnalyticsPeriod = "7d" | "28d" | "3m" | "12m";
export type SiteAnalyticsTarget = {
  readonly projectId: string;
  readonly siteId: string;
  /** Exact public origin without a path, query, fragment, or trailing slash. */
  readonly siteOrigin: string;
};

export type GoogleAnalyticsState =
  | "not-connected" | "checking" | "connected" | "permission-required"
  | "property-mismatch" | "permission-revoked" | "syncing" | "sync-delayed"
  | "quota-limited" | "partial" | "failed";
export type TrackingTagState = "not-configured" | "pending" | "published" | "failed";
export type SearchConsoleState = GoogleAnalyticsState;
export type SearchConsoleOwnershipState = "not-verified" | "pending" | "verified" | "failed";
export type SearchConsoleVerificationMethod = "meta-tag" | "dns";

/** Provider identity is preserved exactly; www, path, and trailing slash are meaningful. */
export type SearchConsoleProperty =
  | { readonly kind: "url-prefix"; readonly value: string }
  | { readonly kind: "domain"; readonly value: string };

export type SiteAnalyticsConnection = {
  readonly target: SiteAnalyticsTarget;
  readonly ga4: {
    /** Public tracking ID. Its state is independent from reporting access. */
    readonly measurementId: string | null;
    readonly trackingTagState: TrackingTagState;
    /** Numeric reporting property ID; never infer it from measurementId. */
    readonly propertyId: string | null;
    readonly reportingState: GoogleAnalyticsState;
    readonly propertyTimeZone: string | null;
    readonly lastSyncedAt: string | null;
  };
  readonly searchConsole: {
    readonly property: SearchConsoleProperty | null;
    /** Ownership proof is independent from API permission. */
    readonly ownershipState: SearchConsoleOwnershipState;
    readonly verificationMethod: SearchConsoleVerificationMethod | null;
    readonly reportingState: SearchConsoleState;
    readonly lastSyncedAt: string | null;
  };
};

export type SiteAnalyticsDataState =
  | "available" | "empty" | "not-connected" | "pending" | "permission-required"
  | "property-mismatch" | "sync-delayed" | "partial" | "quota-limited" | "failed";
export type Ga4DailyMetrics = { readonly date: string; readonly sessions: number | null; readonly activeUsers: number | null; readonly pageViews: number | null };
export type Ga4PageMetrics = { readonly path: string; readonly sessions: number | null; readonly activeUsers: number | null; readonly pageViews: number | null };
export type SearchConsoleDailyMetrics = { readonly date: string; readonly clicks: number | null; readonly impressions: number | null; readonly ctr: number | null; readonly averagePosition: number | null };
export type SearchConsolePageMetrics = { readonly path: string; readonly clicks: number | null; readonly impressions: number | null; readonly ctr: number | null; readonly averagePosition: number | null };

export type SiteAnalyticsReport = {
  readonly target: SiteAnalyticsTarget;
  readonly period: SiteAnalyticsPeriod;
  readonly from: string;
  readonly through: string;
  readonly ga4: {
    readonly state: SiteAnalyticsDataState;
    readonly dataEndDate: string | null;
    /** GA4 calendar dates use the property's timezone. */
    readonly timeZone: string | null;
    readonly daily: readonly Ga4DailyMetrics[];
    readonly pages: readonly Ga4PageMetrics[];
  };
  readonly searchConsole: {
    readonly state: SiteAnalyticsDataState;
    readonly dataEndDate: string | null;
    /** Search Console calendar dates use Pacific Time. */
    readonly timeZone: "America/Los_Angeles";
    readonly daily: readonly SearchConsoleDailyMetrics[];
    readonly pages: readonly SearchConsolePageMetrics[];
  };
};

export type SearchConsoleVerificationInstructions =
  | { readonly method: "meta-tag"; readonly name: "google-site-verification"; readonly content: string }
  | { readonly method: "dns"; readonly recordType: "TXT"; readonly name: string; readonly value: string };
export type SearchConsoleVerificationPlan = {
  readonly target: SiteAnalyticsTarget;
  readonly property: SearchConsoleProperty;
  readonly publishedOrigin: string;
  readonly instructions: SearchConsoleVerificationInstructions;
  /** One-time, short-lived host token bound to target + origin + property + method. */
  readonly confirmationToken: string;
  readonly expiresAt: string;
};

export type SiteAnalyticsChangeAction =
  | "publish-ga4-tag" | "remove-ga4-tag" | "connect-ga4" | "disconnect-ga4"
  | "connect-search-console" | "disconnect-search-console";
export type SiteAnalyticsChangePlan = {
  readonly target: SiteAnalyticsTarget;
  readonly action: SiteAnalyticsChangeAction;
  readonly publicOrigin: string;
  readonly summary: string;
  readonly changes: readonly {
    readonly label: string;
    readonly currentValue: string | null;
    readonly nextValue: string | null;
  }[];
  readonly confirmationToken: string;
  readonly expiresAt: string;
};

/** Host methods always authorize the current user and exact project/site/origin. */
export type SiteAnalyticsAdapter = {
  readConnection(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  readReport(request: { readonly target: SiteAnalyticsTarget; readonly period: SiteAnalyticsPeriod }, signal: AbortSignal): Promise<unknown>;
  prepareGa4TrackingTag(request: { readonly target: SiteAnalyticsTarget; readonly measurementId: string }, signal: AbortSignal): Promise<unknown>;
  applyGa4TrackingTag(request: { readonly target: SiteAnalyticsTarget; readonly confirmationToken: string }, signal: AbortSignal): Promise<unknown>;
  prepareGa4TrackingTagRemoval(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  removeGa4TrackingTag(request: { readonly target: SiteAnalyticsTarget; readonly confirmationToken: string }, signal: AbortSignal): Promise<unknown>;
  prepareGa4ReportingConnection(request: { readonly target: SiteAnalyticsTarget; readonly propertyId: string }, signal: AbortSignal): Promise<unknown>;
  applyGa4ReportingConnection(request: { readonly target: SiteAnalyticsTarget; readonly confirmationToken: string }, signal: AbortSignal): Promise<unknown>;
  verifyGa4Reporting(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  retryGa4Sync(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  prepareGa4ReportingDisconnection(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  disconnectGa4Reporting(request: { readonly target: SiteAnalyticsTarget; readonly confirmationToken: string }, signal: AbortSignal): Promise<unknown>;
  prepareSearchConsoleVerification(request: { readonly target: SiteAnalyticsTarget; readonly property: SearchConsoleProperty; readonly method: SearchConsoleVerificationMethod }, signal: AbortSignal): Promise<unknown>;
  applySearchConsoleVerification(request: { readonly target: SiteAnalyticsTarget; readonly confirmationToken: string }, signal: AbortSignal): Promise<unknown>;
  verifySearchConsoleOwnership(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  prepareSearchConsoleReportingConnection(request: { readonly target: SiteAnalyticsTarget; readonly property: SearchConsoleProperty }, signal: AbortSignal): Promise<unknown>;
  applySearchConsoleReportingConnection(request: { readonly target: SiteAnalyticsTarget; readonly confirmationToken: string }, signal: AbortSignal): Promise<unknown>;
  verifySearchConsoleReporting(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  retrySearchConsoleSync(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  prepareSearchConsoleReportingDisconnection(target: SiteAnalyticsTarget, signal: AbortSignal): Promise<unknown>;
  disconnectSearchConsoleReporting(request: { readonly target: SiteAnalyticsTarget; readonly confirmationToken: string }, signal: AbortSignal): Promise<unknown>;
};

export class SiteAnalyticsContractError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = "SiteAnalyticsContractError";
  }
}

function invalid(path: string, reason: string): never {
  throw new SiteAnalyticsContractError(path, reason);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(path, "unknown field");
}
function object(value: unknown, path: string): Record<string, unknown> {
  try { return record(value, path); } catch { return invalid(path, "expected an object"); }
}
function enumValue<const T extends readonly string[]>(value: unknown, options: T, path: string): T[number] {
  if (typeof value !== "string" || !options.includes(value)) invalid(path, "invalid value");
  return value as T[number];
}
function nullableString(value: unknown, path: string, max = 256): string | null {
  if (value === null) return null;
  try { return string(value, path, max); } catch { return invalid(path, "invalid string"); }
}
function timestamp(value: unknown, path: string, nullable = true): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    return invalid(path, "expected a UTC timestamp");
  }
  return value;
}
function confirmationToken(value: unknown, path: string): string {
  const result = string(value, path, 512);
  if (!/^[A-Za-z0-9._~-]{8,512}$/u.test(result)) invalid(path, "invalid one-time token");
  return result;
}
function expiry(value: unknown, path: string): string {
  const result = timestamp(value, path, false);
  if (result === null || Date.parse(result) <= Date.now()) invalid(path, "plan must not be expired");
  return result;
}
function date(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) invalid(path, "expected a calendar date");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) invalid(path, "invalid calendar date");
  return value;
}
function timeZone(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 128) invalid(path, "invalid time zone");
  try { new Intl.DateTimeFormat("en", { timeZone: value }); } catch { invalid(path, "invalid time zone"); }
  return value;
}

export function parseSiteAnalyticsTarget(input: unknown, path = "target"): SiteAnalyticsTarget {
  const value = object(input, path);
  exactKeys(value, ["projectId", "siteId", "siteOrigin"], path);
  const projectId = identifier(value.projectId, `${path}.projectId`);
  const siteId = identifier(value.siteId, `${path}.siteId`);
  if (!isSafeHttpsOrigin(value.siteOrigin)) invalid(`${path}.siteOrigin`, "expected an HTTPS origin");
  return { projectId, siteId, siteOrigin: value.siteOrigin };
}

/** Reject late or mis-scoped responses after project/site/origin changes. */
export function assertSiteAnalyticsTarget(input: unknown, expected: SiteAnalyticsTarget, path = "target"): SiteAnalyticsTarget {
  const target = parseSiteAnalyticsTarget(input, path);
  const scope = parseSiteAnalyticsTarget(expected, "expectedTarget");
  if (target.projectId !== scope.projectId || target.siteId !== scope.siteId || target.siteOrigin !== scope.siteOrigin) {
    throw new SiteAnalyticsContractError(path, "response scope does not match the selected project site");
  }
  return target;
}

function property(input: unknown, path: string): SearchConsoleProperty {
  const value = object(input, path);
  exactKeys(value, ["kind", "value"], path);
  const kind = enumValue(value.kind, ["url-prefix", "domain"] as const, `${path}.kind`);
  const propertyValue = string(value.value, `${path}.value`, 2048);
  if (kind === "url-prefix") {
    let parsed: URL;
    try { parsed = new URL(propertyValue); } catch { return invalid(`${path}.value`, "invalid URL-prefix property"); }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !propertyValue.endsWith("/") || parsed.href !== propertyValue) {
      invalid(`${path}.value`, "URL-prefix property must be an exact HTTPS URL ending in slash");
    }
  } else if (!/^sc-domain:[A-Za-z0-9.-]{1,253}$/u.test(propertyValue) || propertyValue.endsWith(".") || propertyValue.includes("..")) {
    invalid(`${path}.value`, "invalid domain property");
  }
  return { kind, value: propertyValue };
}

function parseGa4(input: unknown): SiteAnalyticsConnection["ga4"] {
  const path = "connection.ga4", value = object(input, path);
  exactKeys(value, ["measurementId", "trackingTagState", "propertyId", "reportingState", "propertyTimeZone", "lastSyncedAt"], path);
  const measurementId = nullableString(value.measurementId, `${path}.measurementId`, 32);
  if (measurementId !== null && !/^G-[A-Za-z0-9]{4,24}$/u.test(measurementId)) invalid(`${path}.measurementId`, "invalid GA4 measurement ID");
  const propertyId = nullableString(value.propertyId, `${path}.propertyId`, 20);
  if (propertyId !== null && !/^\d{4,20}$/u.test(propertyId)) invalid(`${path}.propertyId`, "invalid GA4 property ID");
  const trackingTagState = enumValue(value.trackingTagState, ["not-configured", "pending", "published", "failed"] as const, `${path}.trackingTagState`);
  const reportingState = enumValue(value.reportingState, ["not-connected", "checking", "connected", "permission-required", "property-mismatch", "permission-revoked", "syncing", "sync-delayed", "quota-limited", "partial", "failed"] as const, `${path}.reportingState`);
  const propertyTimeZone = timeZone(value.propertyTimeZone, `${path}.propertyTimeZone`);
  const lastSyncedAt = timestamp(value.lastSyncedAt, `${path}.lastSyncedAt`);
  if (trackingTagState === "not-configured" && measurementId !== null) invalid(path, "measurement ID requires a configured tag state");
  if (reportingState === "connected" && (propertyId === null || propertyTimeZone === null)) invalid(path, "connected reporting requires a property ID and time zone");
  return { measurementId, trackingTagState, propertyId, reportingState, propertyTimeZone, lastSyncedAt };
}

function parseSearchConsole(input: unknown): SiteAnalyticsConnection["searchConsole"] {
  const path = "connection.searchConsole", value = object(input, path);
  exactKeys(value, ["property", "ownershipState", "verificationMethod", "reportingState", "lastSyncedAt"], path);
  const selectedProperty = value.property === null ? null : property(value.property, `${path}.property`);
  const ownershipState = enumValue(value.ownershipState, ["not-verified", "pending", "verified", "failed"] as const, `${path}.ownershipState`);
  const verificationMethod = value.verificationMethod === null ? null : enumValue(value.verificationMethod, ["meta-tag", "dns"] as const, `${path}.verificationMethod`);
  const reportingState = enumValue(value.reportingState, ["not-connected", "checking", "connected", "permission-required", "property-mismatch", "permission-revoked", "syncing", "sync-delayed", "quota-limited", "partial", "failed"] as const, `${path}.reportingState`);
  const lastSyncedAt = timestamp(value.lastSyncedAt, `${path}.lastSyncedAt`);
  if (ownershipState === "verified" && (selectedProperty === null || verificationMethod === null)) invalid(path, "verified ownership requires a property and method");
  if (reportingState === "connected" && selectedProperty === null) invalid(path, "connected reporting requires a property");
  return { property: selectedProperty, ownershipState, verificationMethod, reportingState, lastSyncedAt };
}

export function parseSiteAnalyticsConnection(input: unknown, expectedTarget?: SiteAnalyticsTarget): SiteAnalyticsConnection {
  const value = object(input, "connection");
  exactKeys(value, ["target", "ga4", "searchConsole"], "connection");
  const target = expectedTarget ? assertSiteAnalyticsTarget(value.target, expectedTarget, "connection.target") : parseSiteAnalyticsTarget(value.target, "connection.target");
  return { target, ga4: parseGa4(value.ga4), searchConsole: parseSearchConsole(value.searchConsole) };
}

function count(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(path, "expected a non-negative integer or null");
  return value;
}
function metric(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) invalid(path, "invalid metric");
  return value;
}
function pathValue(value: unknown, path: string): string {
  const result = string(value, path, 2048);
  if (!result.startsWith("/") || result.startsWith("//") || /[?#\\\s\u0000-\u001f\u007f]/u.test(result) || /%2f|%5c/iu.test(result)) invalid(path, "expected a same-origin path without query or fragment");
  return result;
}
function rows<T>(input: unknown, path: string, max: number, parse: (item: unknown, path: string) => T): readonly T[] {
  if (!Array.isArray(input) || input.length > max) invalid(path, "invalid row list");
  return input.map((item, index) => parse(item, `${path}[${index}]`));
}
function ga4Daily(input: unknown, path: string): Ga4DailyMetrics {
  const value = object(input, path);
  exactKeys(value, ["date", "sessions", "activeUsers", "pageViews"], path);
  return { date: date(value.date, `${path}.date`), sessions: count(value.sessions, `${path}.sessions`), activeUsers: count(value.activeUsers, `${path}.activeUsers`), pageViews: count(value.pageViews, `${path}.pageViews`) };
}
function ga4Page(input: unknown, path: string): Ga4PageMetrics {
  const value = object(input, path);
  exactKeys(value, ["path", "sessions", "activeUsers", "pageViews"], path);
  return { path: pathValue(value.path, `${path}.path`), sessions: count(value.sessions, `${path}.sessions`), activeUsers: count(value.activeUsers, `${path}.activeUsers`), pageViews: count(value.pageViews, `${path}.pageViews`) };
}
function searchDaily(input: unknown, path: string): SearchConsoleDailyMetrics {
  const value = object(input, path);
  exactKeys(value, ["date", "clicks", "impressions", "ctr", "averagePosition"], path);
  return { date: date(value.date, `${path}.date`), clicks: count(value.clicks, `${path}.clicks`), impressions: count(value.impressions, `${path}.impressions`), ctr: metric(value.ctr, `${path}.ctr`, 1), averagePosition: metric(value.averagePosition, `${path}.averagePosition`) };
}
function searchPage(input: unknown, path: string): SearchConsolePageMetrics {
  const value = object(input, path);
  exactKeys(value, ["path", "clicks", "impressions", "ctr", "averagePosition"], path);
  return { path: pathValue(value.path, `${path}.path`), clicks: count(value.clicks, `${path}.clicks`), impressions: count(value.impressions, `${path}.impressions`), ctr: metric(value.ctr, `${path}.ctr`, 1), averagePosition: metric(value.averagePosition, `${path}.averagePosition`) };
}
function sourceReport<T extends { readonly date: string }, P extends object>(input: unknown, path: string, parseDaily: (input: unknown, path: string) => T, parsePage: (input: unknown, path: string) => P, from: string, through: string) {
  const value = object(input, path);
  exactKeys(value, ["state", "dataEndDate", "timeZone", "daily", "pages"], path);
  const state = enumValue(value.state, ["available", "empty", "not-connected", "pending", "permission-required", "property-mismatch", "sync-delayed", "partial", "quota-limited", "failed"] as const, `${path}.state`);
  const dataEndDate = value.dataEndDate === null ? null : date(value.dataEndDate, `${path}.dataEndDate`);
  if (dataEndDate !== null && dataEndDate > through) invalid(`${path}.dataEndDate`, "date is after the requested range");
  const tz = timeZone(value.timeZone, `${path}.timeZone`);
  const daily = rows(value.daily, `${path}.daily`, 400, parseDaily);
  const pages = rows(value.pages, `${path}.pages`, 50, parsePage);
  const dates = daily.map((item) => item.date);
  if (new Set(dates).size !== dates.length || dates.some((item) => item < from || item > through)) invalid(`${path}.daily`, "duplicate or out-of-range date");
  if (state === "empty" && (daily.length || pages.length)) invalid(path, "empty report cannot contain rows");
  if (state !== "available" && state !== "empty" && state !== "partial" && (daily.length || pages.length)) invalid(path, "unavailable report cannot contain cached rows");
  if (state === "available" && (dataEndDate === null || (daily.length === 0 && pages.length === 0))) invalid(path, "available report requires fresh rows and a data end date");
  const hasRequiredMissingMetric = [...daily, ...pages].some((item) => Object.entries(item).some(([key, metric]) => key !== "averagePosition" && metric === null));
  const hasMissingPositionForImpressions = [...daily, ...pages].some((item) =>
    "impressions" in item && "averagePosition" in item && typeof item.impressions === "number" && item.impressions > 0 && item.averagePosition === null);
  if (state === "available" && (hasRequiredMissingMetric || hasMissingPositionForImpressions)) invalid(path, "available report cannot contain missing metrics");
  if (state === "available" && tz === null) invalid(`${path}.timeZone`, "available report requires a time zone");
  return { state, dataEndDate, timeZone: tz, daily, pages };
}

export function parseSiteAnalyticsReport(input: unknown, expectedTarget?: SiteAnalyticsTarget): SiteAnalyticsReport {
  const value = object(input, "report");
  exactKeys(value, ["target", "period", "from", "through", "ga4", "searchConsole"], "report");
  const target = expectedTarget ? assertSiteAnalyticsTarget(value.target, expectedTarget, "report.target") : parseSiteAnalyticsTarget(value.target, "report.target");
  const period = enumValue(value.period, ["7d", "28d", "3m", "12m"] as const, "report.period");
  const from = date(value.from, "report.from"), through = date(value.through, "report.through");
  if (from > through) invalid("report", "from date must not be after through date");
  const ga4 = sourceReport(value.ga4, "report.ga4", ga4Daily, ga4Page, from, through);
  const search = sourceReport(value.searchConsole, "report.searchConsole", searchDaily, searchPage, from, through);
  if (search.timeZone !== "America/Los_Angeles") invalid("report.searchConsole.timeZone", "Search Console uses Pacific Time");
  return { target, period, from, through, ga4: { ...ga4, timeZone: ga4.timeZone }, searchConsole: { ...search, timeZone: "America/Los_Angeles" } };
}

export function parseSearchConsoleVerificationPlan(input: unknown, expectedTarget: SiteAnalyticsTarget): SearchConsoleVerificationPlan {
  const value = object(input, "verificationPlan");
  exactKeys(value, ["target", "property", "publishedOrigin", "instructions", "confirmationToken", "expiresAt"], "verificationPlan");
  const target = assertSiteAnalyticsTarget(value.target, expectedTarget, "verificationPlan.target");
  const selectedProperty = property(value.property, "verificationPlan.property");
  if (selectedProperty.kind !== "url-prefix" || selectedProperty.value !== `${target.siteOrigin}/`) {
    invalid("verificationPlan.property", "verification requires the exact URL-prefix property for the selected origin");
  }
  if (value.publishedOrigin !== target.siteOrigin) invalid("verificationPlan.publishedOrigin", "must exactly match the selected public origin");
  const instructions = object(value.instructions, "verificationPlan.instructions");
  const method = enumValue(instructions.method, ["meta-tag", "dns"] as const, "verificationPlan.instructions.method");
  let parsedInstructions: SearchConsoleVerificationInstructions;
  if (method === "meta-tag") {
    exactKeys(instructions, ["method", "name", "content"], "verificationPlan.instructions");
    if (instructions.name !== "google-site-verification") invalid("verificationPlan.instructions.name", "unexpected meta name");
    const content = string(instructions.content, "verificationPlan.instructions.content", 512);
    if (!/^[A-Za-z0-9_=-]{1,512}$/u.test(content)) invalid("verificationPlan.instructions.content", "invalid public verification value");
    parsedInstructions = { method, name: "google-site-verification", content };
  } else {
    exactKeys(instructions, ["method", "recordType", "name", "value"], "verificationPlan.instructions");
    if (instructions.recordType !== "TXT") invalid("verificationPlan.instructions.recordType", "expected TXT record");
    const name = string(instructions.name, "verificationPlan.instructions.name", 512);
    const recordValue = string(instructions.value, "verificationPlan.instructions.value", 512);
    if (!/^[A-Za-z0-9_.-]{1,512}$/u.test(name) || !/^[A-Za-z0-9_=-]{1,512}$/u.test(recordValue)) invalid("verificationPlan.instructions", "invalid public DNS value");
    parsedInstructions = { method, recordType: "TXT", name, value: recordValue };
  }
  const confirmation = confirmationToken(value.confirmationToken, "verificationPlan.confirmationToken");
  const expiresAt = expiry(value.expiresAt, "verificationPlan.expiresAt");
  return { target, property: selectedProperty, publishedOrigin: target.siteOrigin, instructions: parsedInstructions, confirmationToken: confirmation, expiresAt };
}

export function parseSiteAnalyticsChangePlan(input: unknown, expectedTarget: SiteAnalyticsTarget): SiteAnalyticsChangePlan {
  const value = object(input, "changePlan");
  exactKeys(value, ["target", "action", "publicOrigin", "summary", "changes", "confirmationToken", "expiresAt"], "changePlan");
  const target = assertSiteAnalyticsTarget(value.target, expectedTarget, "changePlan.target");
  if (value.publicOrigin !== target.siteOrigin) invalid("changePlan.publicOrigin", "must exactly match the selected public origin");
  const action = enumValue(value.action, ["publish-ga4-tag", "remove-ga4-tag", "connect-ga4", "disconnect-ga4", "connect-search-console", "disconnect-search-console"] as const, "changePlan.action");
  const summary = string(value.summary, "changePlan.summary", 500);
  if (!summary.trim()) invalid("changePlan.summary", "required");
  const changes = rows(value.changes, "changePlan.changes", 8, (item, path) => {
    const change = object(item, path);
    exactKeys(change, ["label", "currentValue", "nextValue"], path);
    const label = string(change.label, `${path}.label`, 100);
    if (!label.trim()) invalid(`${path}.label`, "required");
    return {
      label,
      currentValue: nullableString(change.currentValue, `${path}.currentValue`, 500),
      nextValue: nullableString(change.nextValue, `${path}.nextValue`, 500)
    };
  });
  if (changes.length === 0) invalid("changePlan.changes", "at least one impact is required");
  return {
    target, action, publicOrigin: target.siteOrigin, summary, changes,
    confirmationToken: confirmationToken(value.confirmationToken, "changePlan.confirmationToken"),
    expiresAt: expiry(value.expiresAt, "changePlan.expiresAt")
  };
}
