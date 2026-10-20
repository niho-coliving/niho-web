import type {
  EditorLocaleReleaseApplyResult, EditorLocaleReleasePlan, EditorLocaleReleasePrepareRequest, EditorLocaleReleaseState, EditorLocaleReleaseSummary
} from "./editor-types.js";
import type { LocalizationLocale } from "./localization-types.js";
import { isSafeHttpsOrigin } from "./validation-utils.js";

function bounded(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${name}`);
  return value;
}
function releaseSummary(input: unknown, name: string): EditorLocaleReleaseSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`invalid ${name}`);
  const source = input as Record<string, unknown>, allowed = ["releaseId", "version", "label", "publishedAt", "pages", "sharedResources"];
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw new Error(`invalid ${name}`);
  const publishedAt = bounded(source.publishedAt, `${name} publishedAt`, 40), parsed = Date.parse(publishedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== publishedAt) throw new Error(`invalid ${name}`);
  if (typeof source.pages !== "number" || !Number.isSafeInteger(source.pages) || source.pages < 0 || source.pages > 10_000 ||
    typeof source.sharedResources !== "number" || !Number.isSafeInteger(source.sharedResources) || source.sharedResources < 0 || source.sharedResources > 10_000) throw new Error(`invalid ${name}`);
  return { releaseId: bounded(source.releaseId, `${name} releaseId`), version: bounded(source.version, `${name} version`), label: bounded(source.label, `${name} label`, 300),
    publishedAt, pages: source.pages, sharedResources: source.sharedResources };
}
function reasons(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(`invalid ${name}`);
  return value.map((entry) => bounded(entry, name, 500));
}
function releaseId(value: unknown, name: string): string {
  const result = bounded(value, name, 128);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(result)) throw new Error(`invalid ${name}`);
  return result;
}
function routePath(value: unknown): string {
  const path = bounded(value, "locale release path", 2048);
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\]/u.test(path)) throw new Error("invalid locale release path");
  let decoded: string; try { decoded = decodeURIComponent(path); } catch { throw new Error("invalid locale release path"); }
  if (decoded.slice(1).includes("//") || decoded.split("/").some((part) => part === "." || part === "..") || decoded.includes("\\") || /%2f|%5c/iu.test(path)) throw new Error("invalid locale release path");
  return path;
}

export function parseEditorLocaleReleaseState(input: unknown, siteId: string, locale: LocalizationLocale): EditorLocaleReleaseState {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid locale release state");
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["siteId", "locale", "current", "history"].includes(key)) || source.siteId !== siteId || source.locale !== locale || !Array.isArray(source.history) || source.history.length > 1_000) throw new Error("invalid locale release state");
  const current = source.current === null ? null : releaseSummary(source.current, "current release"), history = source.history.map((entry, index) => releaseSummary(entry, `release history ${index}`));
  if (new Set(history.map((entry) => entry.releaseId)).size !== history.length || new Set(history.map((entry) => entry.version)).size !== history.length ||
    current && history.some((entry) => entry.releaseId === current.releaseId || entry.version === current.version)) throw new Error("invalid locale release history");
  return { siteId, locale, current, history };
}

export function parseEditorLocaleReleasePlan(input: unknown, request: EditorLocaleReleasePrepareRequest, allowedDomains?: readonly string[]): EditorLocaleReleasePlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid locale release plan");
  const source = input as Record<string, unknown>, allowed = ["siteId", "locale", "action", "expectedSiteVersion", "expectedCurrentVersion", "rollbackReleaseId", "confirmationToken", "domain", "expiresAt", "optimisticVersion", "previous", "prepared", "pages", "sharedResources", "incompleteReasons", "complete"];
  if (Object.keys(source).some((key) => !allowed.includes(key)) || source.siteId !== request.siteId || source.locale !== request.locale || source.action !== request.action || source.expectedSiteVersion !== request.expectedSiteVersion ||
    source.expectedCurrentVersion !== request.expectedCurrentVersion || source.rollbackReleaseId !== request.rollbackReleaseId || !isSafeHttpsOrigin(source.domain) || allowedDomains && !allowedDomains.includes(source.domain)) throw new Error("locale release plan mismatch");
  const expiresAt = bounded(source.expiresAt, "release expiry", 40), expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= Date.now()) throw new Error("locale release plan expired");
  if (!Array.isArray(source.pages) || source.pages.length === 0 || source.pages.length > 10_000 || !Array.isArray(source.sharedResources) || source.sharedResources.length > 10_000 || typeof source.complete !== "boolean") throw new Error("invalid locale release plan details");
  const pages = source.pages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid locale release page"); const value = entry as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["pageId", "title", "path", "complete", "reasons"].includes(key)) || typeof value.complete !== "boolean") throw new Error("invalid locale release page");
    const itemReasons = reasons(value.reasons, `page reasons ${index}`);
    if (value.complete !== (itemReasons.length === 0)) throw new Error("locale release page completeness mismatch");
    return { pageId: releaseId(value.pageId, "pageId"), title: bounded(value.title, "page title", 300), path: routePath(value.path), complete: value.complete, reasons: itemReasons };
  });
  if (new Set(pages.map((entry) => entry.pageId)).size !== pages.length || new Set(pages.map((entry) => entry.path)).size !== pages.length) throw new Error("duplicate locale release page");
  const sharedResources = source.sharedResources.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid shared release resource"); const value = entry as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["id", "label", "kind", "complete", "reasons"].includes(key)) || !["component", "navigation", "style", "resource"].includes(String(value.kind)) || typeof value.complete !== "boolean") throw new Error("invalid shared release resource");
    const itemReasons = reasons(value.reasons, `shared reasons ${index}`);
    if (value.complete !== (itemReasons.length === 0)) throw new Error("shared release resource completeness mismatch");
    return { id: releaseId(value.id, "resource ID"), label: bounded(value.label, "resource label", 300), kind: value.kind as "component" | "navigation" | "style" | "resource", complete: value.complete, reasons: itemReasons };
  });
  if (new Set(sharedResources.map((entry) => entry.id)).size !== sharedResources.length) throw new Error("duplicate shared release resource");
  const incompleteReasons = reasons(source.incompleteReasons, "release reasons");
  if (source.complete !== (incompleteReasons.length === 0 && pages.every((entry) => entry.complete) && sharedResources.every((entry) => entry.complete))) throw new Error("release completeness mismatch");
  const previous = source.previous === null ? null : releaseSummary(source.previous, "previous release");
  if ((previous?.version ?? null) !== request.expectedCurrentVersion) throw new Error("previous locale release mismatch");
  const prepared = releaseSummary(source.prepared, "prepared release");
  if (prepared.pages !== pages.length || prepared.sharedResources !== sharedResources.length || previous && (prepared.releaseId === previous.releaseId || prepared.version === previous.version)) throw new Error("prepared locale release summary mismatch");
  return { ...request, confirmationToken: bounded(source.confirmationToken, "confirmation token", 512), domain: source.domain, expiresAt,
    optimisticVersion: bounded(source.optimisticVersion, "optimistic version"), previous, prepared, pages, sharedResources, incompleteReasons, complete: source.complete };
}

export function parseEditorLocaleReleaseApplyResult(input: unknown, expected: { siteId: string; locale: LocalizationLocale; prepared: Pick<EditorLocaleReleaseSummary, "releaseId" | "version"> & Partial<Omit<EditorLocaleReleaseSummary, "releaseId" | "version">> }): EditorLocaleReleaseApplyResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid locale release result");
  const source = input as Record<string, unknown>;
  if (source.status === "conflict" || source.status === "expired") {
    if (Object.keys(source).some((key) => key !== "status")) throw new Error("invalid locale release result");
    return { status: source.status };
  }
  if (source.status !== "applied" || Object.keys(source).some((key) => !["status", "siteId", "locale", "current"].includes(key)) || source.siteId !== expected.siteId || source.locale !== expected.locale) throw new Error("invalid locale release result");
  const current = releaseSummary(source.current, "applied release");
  if (current.releaseId !== expected.prepared.releaseId || current.version !== expected.prepared.version ||
    expected.prepared.label !== undefined && current.label !== expected.prepared.label || expected.prepared.publishedAt !== undefined && current.publishedAt !== expected.prepared.publishedAt ||
    expected.prepared.pages !== undefined && current.pages !== expected.prepared.pages || expected.prepared.sharedResources !== undefined && current.sharedResources !== expected.prepared.sharedResources) throw new Error("applied locale release mismatch");
  return { status: "applied", siteId: expected.siteId, locale: expected.locale, current };
}
