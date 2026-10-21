import { parseComponentLibrary } from "./components.js";
import { parsePageDocument } from "./document.js";
import { documentLocaleFor, parseSiteLocalizationConfig } from "./localization.js";
import type { BlockContracts, ComponentLibrary, PageDocument, PageNode } from "./types.js";
import { fail, identifier, isSafeHttpsOrigin, isSafePublicUrl, keys, line, record, string } from "./validation-utils.js";
import type { LocalizationLocale, SiteLocalizationConfig } from "./localization-types.js";

const LIMITS = Object.freeze({ pages: 10_000, navigation: 10_000, navigationDepth: 12, resources: 2_000, issues: 10_000 });
const DIGEST = /^sha256-[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export type ReleaseIdentity = { version: string; digest: string };
export type ReleaseResourceBinding = { id: string; kind: "css" | "cms" | "asset" | "other"; version: string; digest: string };
export type SiteLocaleReleaseManifest = {
  source: ReleaseIdentity;
  config: ReleaseIdentity;
  overlay?: ReleaseIdentity;
  resources: ReleaseResourceBinding[];
};
export type PublishedLocalePage = { pageId: string; sourcePath: string; path: string; indexable: boolean; document: PageDocument };
export type PublishedNavigationItem = { id: string; label: string; pageId?: string; href?: string; children?: PublishedNavigationItem[] };
export type PublishedRoute = { pageId: string; sourcePath: string; path: string; indexable: boolean };
export type PublishedSeoRecord = { pageId: string; title: string; description?: string; indexable: boolean };
export type PublishedSiteLocaleSnapshot = {
  schemaVersion: 1;
  siteId: string;
  locale: LocalizationLocale;
  documentLocale: string;
  sourceLocale: LocalizationLocale;
  defaultLocale: LocalizationLocale;
  releaseId: string;
  version: string;
  pages: PublishedLocalePage[];
  components: ComponentLibrary;
  supportedBlocks: string[];
  navigation: PublishedNavigationItem[];
  routes: PublishedRoute[];
  seo: PublishedSeoRecord[];
  manifest: SiteLocaleReleaseManifest;
  contentDigest: string;
};
export type ReleaseCompleteness = {
  reviewedPageIds: readonly string[];
  sharedReviewed: boolean;
  unresolvedIssues: readonly { code: string; ownerId: string }[];
};
export type CreatePublishedSiteLocaleSnapshotInput = {
  config: unknown;
  locale: LocalizationLocale;
  releaseId: string;
  version: string;
  pages: readonly { path: string; document: unknown; indexable?: boolean }[];
  /** Authoritative host membership. Browser flags inside documents are never used as the catalogue. */
  publicPageIds: readonly string[];
  components: unknown;
  navigation: readonly unknown[];
  manifest: unknown;
  completeness: ReleaseCompleteness;
  requiredResourceIds?: readonly string[];
  supportedBlocks?: readonly string[];
};
export type ReleaseParseOptions = { blocks?: BlockContracts };

function clone<T>(value: T): T { return structuredClone(value); }
function boundedVersion(value: unknown, path: string): string {
  const result = string(value, path, 200);
  if (!VERSION.test(result)) fail(path, "invalid version");
  return result;
}
function digest(value: unknown, path: string): string {
  const result = string(value, path, 71);
  if (!DIGEST.test(result)) fail(path, "invalid SHA-256 digest");
  return result;
}
function locale(value: unknown, path: string): LocalizationLocale {
  if (value !== "ja" && value !== "en") fail(path, "unsupported locale");
  return value;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected boolean");
  return value;
}
function uniqueIds(value: unknown, path: string, max: number = LIMITS.pages): string[] {
  if (!Array.isArray(value) || value.length > max) fail(path, "expected bounded ID array");
  const result = value.map((entry, index) => identifier(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, "duplicate ID");
  return result;
}
function identity(value: unknown, path: string): ReleaseIdentity {
  const source = record(value, path); keys(source, ["version", "digest"], path);
  return { version: boundedVersion(source.version, `${path}.version`), digest: digest(source.digest, `${path}.digest`) };
}
function resource(value: unknown, path: string): ReleaseResourceBinding {
  const source = record(value, path); keys(source, ["id", "kind", "version", "digest"], path);
  if (!['css', 'cms', 'asset', 'other'].includes(String(source.kind))) fail(`${path}.kind`, "unsupported resource kind");
  return { id: identifier(source.id, `${path}.id`), kind: source.kind as ReleaseResourceBinding["kind"], version: boundedVersion(source.version, `${path}.version`), digest: digest(source.digest, `${path}.digest`) };
}
export function parseSiteLocaleReleaseManifest(value: unknown): SiteLocaleReleaseManifest {
  const source = record(value, "$.manifest"); keys(source, ["source", "config", "overlay", "resources"], "$.manifest");
  if (!Array.isArray(source.resources) || source.resources.length > LIMITS.resources) fail("$.manifest.resources", "expected bounded resource array");
  const resources = source.resources.map((entry, index) => resource(entry, `$.manifest.resources[${index}]`));
  if (new Set(resources.map((entry) => entry.id)).size !== resources.length) fail("$.manifest.resources", "duplicate resource ID");
  return { source: identity(source.source, "$.manifest.source"), config: identity(source.config, "$.manifest.config"),
    ...(source.overlay === undefined ? {} : { overlay: identity(source.overlay, "$.manifest.overlay") }), resources };
}

type CanonicalState = { seen: Set<object>; nodes: number; characters: number };
function canonical(value: unknown, state: CanonicalState = { seen: new Set(), nodes: 0, characters: 0 }, depth = 0): string {
  if (++state.nodes > 100_000 || depth > 64) throw new TypeError("canonical JSON exceeds structural limits");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && (state.characters += value.length) > 64 * 1024 * 1024) throw new TypeError("canonical JSON exceeds text limit");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, state, depth + 1)).join(",")}]`;
  if (typeof value !== "object" || !value) throw new TypeError("canonical JSON value is not serializable");
  if (state.seen.has(value)) throw new TypeError("canonical JSON cannot contain cycles");
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("canonical JSON requires plain objects");
  state.seen.add(value);
  const result = `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], state, depth + 1)}`).join(",")}}`;
  state.seen.delete(value);
  return result;
}

/** Stable SHA-256 over canonical JSON. This is content identity, not an authorization signature. */
export async function contentDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  if (bytes.byteLength > 64 * 1024 * 1024) throw new TypeError("content exceeds digest limit");
  const output = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256-${[...new Uint8Array(output)].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function validateSourcePath(value: unknown, path: string): string {
  const result = string(value, path, 2048);
  if (!result.startsWith("/") || result.startsWith("//") || /[?#\\\u0000-\u001f\u007f]/u.test(result)) fail(path, "invalid route path");
  if (/%(?![0-9a-f]{2})/iu.test(result)) fail(path, "invalid percent encoding");
  let decoded: string;
  try { decoded = decodeURIComponent(result); } catch { return fail(path, "invalid percent encoding"); }
  if (decoded.startsWith("//") || decoded.slice(1).includes("//") || decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === "..") || /[?#\u0000-\u001f\u007f]/u.test(decoded)) fail(path, "unsafe route path");
  if (/%2f|%5c/iu.test(result)) fail(path, "encoded path separators are not allowed");
  return result;
}
function firstSegment(path: string): string { return path.split("/").filter(Boolean)[0] ?? ""; }
export function validateLocaleRouteCatalogue(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length > LIMITS.pages) fail("$.paths", "expected bounded path array");
  const parsed = paths.map((path, index) => validateSourcePath(path, `$.paths[${index}]`));
  if (parsed.some((path) => ["ja", "en"].includes(firstSegment(path)))) fail("$.paths", "source route collides with a locale prefix");
  const normalized = parsed.map((path) => path.length > 1 ? path.replace(/\/+$/, "") : path);
  if (new Set(normalized).size !== normalized.length) fail("$.paths", "duplicate route path");
  return [...parsed];
}

/** Preserves spelling and trailing slash; only a non-default locale receives one explicit prefix. */
export function localePath(configInput: unknown, targetLocale: LocalizationLocale, sourcePath: string): string {
  const config = parseSiteLocalizationConfig(configInput), chosen = locale(targetLocale, "$.locale"), path = validateSourcePath(sourcePath, "$.path");
  if (!config.enabledLocales.includes(chosen)) fail("$.locale", "locale is not enabled");
  if (["ja", "en"].includes(firstSegment(path))) fail("$.path", "source route collides with a locale prefix");
  if (chosen === config.defaultLocale) return path;
  return path === "/" ? `/${chosen}/` : `/${chosen}${path}`;
}

function navigationItem(value: unknown, path: string, depth: number, count: { value: number }): PublishedNavigationItem {
  if (depth > LIMITS.navigationDepth || ++count.value > LIMITS.navigation) fail(path, "navigation exceeds limits");
  const source = record(value, path); keys(source, ["id", "label", "pageId", "href", "children"], path);
  const pageId = source.pageId === undefined ? undefined : identifier(source.pageId, `${path}.pageId`);
  const href = source.href === undefined ? undefined : string(source.href, `${path}.href`, 2048);
  if ((pageId === undefined) === (href === undefined)) fail(path, "navigation item requires exactly one destination");
  if (href !== undefined && !isSafePublicUrl(href)) fail(`${path}.href`, "navigation href must be an internal path or external HTTPS URL");
  const children = source.children === undefined ? undefined : source.children;
  if (children !== undefined && !Array.isArray(children)) fail(`${path}.children`, "expected child array");
  const parsed = children?.map((entry, index) => navigationItem(entry, `${path}.children[${index}]`, depth + 1, count));
  return { id: identifier(source.id, `${path}.id`), label: line(source.label, `${path}.label`, 300), ...(pageId ? { pageId } : { href: href! }), ...(parsed?.length ? { children: parsed } : {}) };
}
function parseNavigation(value: unknown): PublishedNavigationItem[] {
  if (!Array.isArray(value)) fail("$.navigation", "expected navigation array");
  const count = { value: 0 }, ids = new Set<string>();
  const result = value.map((entry, index) => navigationItem(entry, `$.navigation[${index}]`, 1, count));
  const walk = (items: readonly PublishedNavigationItem[]) => items.forEach((item) => { if (ids.has(item.id)) fail("$.navigation", "duplicate navigation ID"); ids.add(item.id); if (item.children) walk(item.children); });
  walk(result); return result;
}
function walkBlocks(nodes: readonly PageNode[], visit: (block: string) => void): void {
  for (const node of nodes) {
    if (node.type === "component") visit(node.block);
    else if (node.type === "element") walkBlocks(node.children, visit);
  }
}
function assertSupportedBlocks(pages: readonly PublishedLocalePage[], components: ComponentLibrary, supported: readonly string[]): string[] {
  const parsed = uniqueIds(supported, "$.supportedBlocks", 1_000), allow = new Set(parsed);
  const check = (block: string) => { if (!allow.has(block)) fail("$.supportedBlocks", `unsupported block ${block}`); };
  pages.forEach((page) => walkBlocks(page.document.body, check));
  components.components.forEach((component) => walkBlocks([component.root], check));
  return parsed;
}
function navigationPageIds(items: readonly PublishedNavigationItem[]): string[] { return items.flatMap((item) => [...(item.pageId ? [item.pageId] : []), ...navigationPageIds(item.children ?? [])]); }

function snapshotPayload(snapshot: Omit<PublishedSiteLocaleSnapshot, "contentDigest">): Omit<PublishedSiteLocaleSnapshot, "contentDigest"> { return clone(snapshot); }
export async function createPublishedSiteLocaleSnapshot(input: CreatePublishedSiteLocaleSnapshotInput, options: ReleaseParseOptions = {}): Promise<PublishedSiteLocaleSnapshot> {
  const inputObject = record(input, "$");
  keys(inputObject, ["config", "locale", "releaseId", "version", "pages", "publicPageIds", "components", "navigation", "manifest", "completeness", "requiredResourceIds", "supportedBlocks"], "$");
  const config = parseSiteLocalizationConfig(input.config), chosen = locale(input.locale, "$.locale");
  if (!config.enabledLocales.includes(chosen)) fail("$.locale", "locale is not enabled");
  if (!Array.isArray(input.pages) || input.pages.length > LIMITS.pages) fail("$.pages", "expected bounded page array");
  const components = parseComponentLibrary(input.components, options.blocks ?? {});
  if (components.siteId !== config.siteId) fail("$.components.siteId", "site mismatch");
  const publicPageIds = uniqueIds(input.publicPageIds, "$.publicPageIds"), publicSet = new Set(publicPageIds);
  if (!publicPageIds.length) fail("$.publicPageIds", "a published site locale requires at least one public page");
  const sourcePaths = validateLocaleRouteCatalogue(input.pages.map((entry) => entry.path));
  const pages = input.pages.map((entry, index): PublishedLocalePage => {
    const pageInput = record(entry, `$.pages[${index}]`); keys(pageInput, ["path", "document", "indexable"], `$.pages[${index}]`);
    const document = parsePageDocument(entry.document, options.blocks ?? {}, { components });
    if (document.siteId !== config.siteId || document.locale !== documentLocaleFor(config, chosen)) fail(`$.pages[${index}].document`, "site or locale mismatch");
    const requestedIndexable = entry.indexable === undefined ? true : bool(entry.indexable, `$.pages[${index}].indexable`);
    const indexable = requestedIndexable && document.meta?.noindex !== true;
    return { pageId: document.pageId, sourcePath: sourcePaths[index]!, path: localePath(config, chosen, sourcePaths[index]!), indexable, document };
  });
  const ids = pages.map((page) => page.pageId);
  if (new Set(ids).size !== ids.length) fail("$.pages", "duplicate pageId");
  if (ids.length !== publicSet.size || ids.some((id) => !publicSet.has(id))) fail("$.pages", "pages must exactly match the authoritative public catalogue");
  const completeness = record(input.completeness, "$.completeness"); keys(completeness, ["reviewedPageIds", "sharedReviewed", "unresolvedIssues"], "$.completeness");
  const reviewed = uniqueIds(completeness.reviewedPageIds, "$.completeness.reviewedPageIds");
  if (typeof completeness.sharedReviewed !== "boolean") fail("$.completeness.sharedReviewed", "expected boolean");
  if (!Array.isArray(completeness.unresolvedIssues) || completeness.unresolvedIssues.length > LIMITS.issues) fail("$.completeness.unresolvedIssues", "expected bounded issue array");
  completeness.unresolvedIssues.forEach((entry, index) => { const issue = record(entry, `$.completeness.unresolvedIssues[${index}]`); keys(issue, ["code", "ownerId"], `$.completeness.unresolvedIssues[${index}]`); line(issue.code, `$.completeness.unresolvedIssues[${index}].code`, 100); identifier(issue.ownerId, `$.completeness.unresolvedIssues[${index}].ownerId`); });
  if (completeness.unresolvedIssues.length) fail("$.completeness.unresolvedIssues", "unresolved extraction issues prevent release");
  if (chosen !== config.sourceLocale && (!completeness.sharedReviewed || reviewed.length !== publicSet.size || reviewed.some((id) => !publicSet.has(id)))) fail("$.completeness", "target release is not completely reviewed");
  const manifest = parseSiteLocaleReleaseManifest(input.manifest);
  if (chosen !== config.sourceLocale && !manifest.overlay) fail("$.manifest.overlay", "target release requires an overlay identity");
  const requiredResources = uniqueIds(input.requiredResourceIds ?? [], "$.requiredResourceIds", LIMITS.resources), bound = new Set(manifest.resources.map((entry) => entry.id));
  if (requiredResources.some((id) => !bound.has(id))) fail("$.manifest.resources", "required external resource binding is missing");
  const supportedBlocks = assertSupportedBlocks(pages, components, input.supportedBlocks ?? []);
  const navigation = parseNavigation(input.navigation);
  if (navigationPageIds(navigation).some((id) => !publicSet.has(id))) fail("$.navigation", "navigation references an unpublished page");
  const routes = pages.map(({ pageId, sourcePath, path, indexable }) => ({ pageId, sourcePath, path, indexable }));
  if (new Set(routes.map((route) => route.path)).size !== routes.length) fail("$.pages", "duplicate localized route");
  const seo = pages.map((page) => ({ pageId: page.pageId, title: page.document.title, ...(page.document.meta?.description ? { description: page.document.meta.description } : {}), indexable: page.indexable }));
  const payload = snapshotPayload({ schemaVersion: 1, siteId: config.siteId, locale: chosen, documentLocale: documentLocaleFor(config, chosen), sourceLocale: config.sourceLocale,
    defaultLocale: config.defaultLocale, releaseId: boundedVersion(input.releaseId, "$.releaseId"), version: boundedVersion(input.version, "$.version"), pages, components, supportedBlocks, navigation, routes, seo, manifest });
  return { ...payload, contentDigest: await contentDigest(payload) };
}

export function parsePublishedSiteLocaleSnapshot(input: unknown, options: ReleaseParseOptions = {}): PublishedSiteLocaleSnapshot {
  const source = record(input, "$"); keys(source, ["schemaVersion", "siteId", "locale", "documentLocale", "sourceLocale", "defaultLocale", "releaseId", "version", "pages", "components", "supportedBlocks", "navigation", "routes", "seo", "manifest", "contentDigest"], "$");
  if (source.schemaVersion !== 1) fail("$.schemaVersion", "unsupported schema version");
  const config: SiteLocalizationConfig = { schemaVersion: 1, siteId: identifier(source.siteId, "$.siteId"), sourceLocale: locale(source.sourceLocale, "$.sourceLocale"), defaultLocale: locale(source.defaultLocale, "$.defaultLocale"), enabledLocales: ["ja", "en"],
    documentLocales: { ja: source.locale === "ja" ? string(source.documentLocale, "$.documentLocale", 40) : "ja", en: source.locale === "en" ? string(source.documentLocale, "$.documentLocale", 40) : "en" }, glossaryVersion: "release", contextVersion: "release" };
  const chosen = locale(source.locale, "$.locale"), components = parseComponentLibrary(source.components, options.blocks ?? {});
  const documentLocale = string(source.documentLocale, "$.documentLocale", 40);
  if (!(chosen === "ja" ? /^ja(?:-|$)/ : /^en(?:-|$)/).test(documentLocale)) fail("$.documentLocale", "document locale does not match URL locale");
  if (components.siteId !== config.siteId) fail("$.components.siteId", "site mismatch");
  if (!Array.isArray(source.pages) || source.pages.length > LIMITS.pages) fail("$.pages", "expected bounded page array");
  if (!source.pages.length) fail("$.pages", "a published site locale requires at least one public page");
  const pages = source.pages.map((entry, index): PublishedLocalePage => {
    const value = record(entry, `$.pages[${index}]`); keys(value, ["pageId", "sourcePath", "path", "indexable", "document"], `$.pages[${index}]`);
    const document = parsePageDocument(value.document, options.blocks ?? {}, { components }), pageId = identifier(value.pageId, `$.pages[${index}].pageId`);
    if (document.siteId !== config.siteId || document.pageId !== pageId || document.locale !== documentLocale) fail(`$.pages[${index}].document`, "document identity mismatch");
    const sourcePath = validateSourcePath(value.sourcePath, `$.pages[${index}].sourcePath`), path = validateSourcePath(value.path, `$.pages[${index}].path`);
    if (path !== localePath(config, chosen, sourcePath)) fail(`$.pages[${index}].path`, "localized path mismatch");
    const indexable = bool(value.indexable, `$.pages[${index}].indexable`);
    if (indexable && document.meta?.noindex === true) fail(`$.pages[${index}].indexable`, "document noindex cannot be overridden");
    return { pageId, sourcePath, path, indexable, document };
  });
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length || new Set(pages.map((page) => page.path)).size !== pages.length) fail("$.pages", "duplicate page identity");
  validateLocaleRouteCatalogue(pages.map((page) => page.sourcePath));
  const supportedBlocks = assertSupportedBlocks(pages, components, uniqueIds(source.supportedBlocks, "$.supportedBlocks", 1_000));
  const navigation = parseNavigation(source.navigation), allowed = new Set(pages.map((page) => page.pageId));
  if (navigationPageIds(navigation).some((id) => !allowed.has(id))) fail("$.navigation", "navigation references an unpublished page");
  const expectedRoutes = pages.map(({ pageId, sourcePath, path, indexable }) => ({ pageId, sourcePath, path, indexable }));
  const expectedSeo = pages.map((page) => ({ pageId: page.pageId, title: page.document.title, ...(page.document.meta?.description ? { description: page.document.meta.description } : {}), indexable: page.indexable }));
  if (canonical(source.routes) !== canonical(expectedRoutes) || canonical(source.seo) !== canonical(expectedSeo)) fail("$", "route or SEO manifest does not match documents");
  const result: PublishedSiteLocaleSnapshot = { schemaVersion: 1, siteId: config.siteId, locale: chosen, documentLocale, sourceLocale: config.sourceLocale, defaultLocale: config.defaultLocale,
    releaseId: boundedVersion(source.releaseId, "$.releaseId"), version: boundedVersion(source.version, "$.version"), pages, components, supportedBlocks, navigation, routes: expectedRoutes, seo: expectedSeo,
    manifest: parseSiteLocaleReleaseManifest(source.manifest), contentDigest: digest(source.contentDigest, "$.contentDigest") };
  if (chosen !== config.sourceLocale && !result.manifest.overlay) fail("$.manifest.overlay", "target release requires an overlay identity");
  return clone(result);
}

export async function verifyPublishedSiteLocaleSnapshot(input: unknown, options: ReleaseParseOptions = {}): Promise<PublishedSiteLocaleSnapshot> {
  const parsed = parsePublishedSiteLocaleSnapshot(input, options), { contentDigest: claimed, ...payload } = parsed;
  if (await contentDigest(payload) !== claimed) fail("$.contentDigest", "snapshot content digest mismatch");
  return parsed;
}

export type SiteLocaleReleasePreparation = {
  schemaVersion: 1; action: "publish" | "rollback"; siteId: string; locale: LocalizationLocale; expectedCurrentVersion: string | null;
  sourceLocale: LocalizationLocale; defaultLocale: LocalizationLocale; documentLocale: string;
  candidateReleaseId: string; candidateVersion: string; candidateDigest: string; candidateManifest: SiteLocaleReleaseManifest;
  /** Host aggregate of the live source/config/catalogue/resource state, independent of an old rollback candidate. */
  liveDependency: ReleaseIdentity; expiresAt: string;
};
function instant(value: unknown, path: string): string {
  const result = string(value, path, 40), time = Date.parse(result);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== result) fail(path, "invalid ISO instant");
  return result;
}
export function parseSiteLocaleReleasePreparation(input: unknown): SiteLocaleReleasePreparation {
  const source = record(input, "$.preparation"); keys(source, ["schemaVersion", "action", "siteId", "locale", "sourceLocale", "defaultLocale", "documentLocale", "expectedCurrentVersion", "candidateReleaseId", "candidateVersion", "candidateDigest", "candidateManifest", "liveDependency", "expiresAt"], "$.preparation");
  if (source.schemaVersion !== 1 || source.action !== "publish" && source.action !== "rollback") fail("$.preparation", "invalid preparation");
  return { schemaVersion: 1, action: source.action, siteId: identifier(source.siteId, "$.preparation.siteId"), locale: locale(source.locale, "$.preparation.locale"),
    sourceLocale: locale(source.sourceLocale, "$.preparation.sourceLocale"), defaultLocale: locale(source.defaultLocale, "$.preparation.defaultLocale"), documentLocale: string(source.documentLocale, "$.preparation.documentLocale", 40),
    expectedCurrentVersion: source.expectedCurrentVersion === null ? null : boundedVersion(source.expectedCurrentVersion, "$.preparation.expectedCurrentVersion"), candidateReleaseId: boundedVersion(source.candidateReleaseId, "$.preparation.candidateReleaseId"),
    candidateVersion: boundedVersion(source.candidateVersion, "$.preparation.candidateVersion"), candidateDigest: digest(source.candidateDigest, "$.preparation.candidateDigest"), candidateManifest: parseSiteLocaleReleaseManifest(source.candidateManifest),
    liveDependency: identity(source.liveDependency, "$.preparation.liveDependency"), expiresAt: instant(source.expiresAt, "$.preparation.expiresAt") };
}
export function createSiteLocaleReleasePreparation(input: { action: "publish" | "rollback"; expectedCurrentVersion: string | null; candidate: PublishedSiteLocaleSnapshot; liveDependency: ReleaseIdentity; expiresAt: string }, options: ReleaseParseOptions = {}): SiteLocaleReleasePreparation {
  keys(record(input, "$"), ["action", "expectedCurrentVersion", "candidate", "liveDependency", "expiresAt"], "$");
  const candidate = parsePublishedSiteLocaleSnapshot(input.candidate, options);
  return parseSiteLocaleReleasePreparation({ schemaVersion: 1, action: input.action, siteId: candidate.siteId, locale: candidate.locale, expectedCurrentVersion: input.expectedCurrentVersion,
    sourceLocale: candidate.sourceLocale, defaultLocale: candidate.defaultLocale, documentLocale: candidate.documentLocale,
    candidateReleaseId: candidate.releaseId, candidateVersion: candidate.version, candidateDigest: candidate.contentDigest, candidateManifest: candidate.manifest,
    liveDependency: input.liveDependency, expiresAt: input.expiresAt });
}
/** Host commit-boundary check. Pass only a snapshot recomputed from authoritative saved data. Token consumption and CAS remain host-only. */
export async function verifyPreparedSiteLocaleRelease(input: { current: PublishedSiteLocaleSnapshot | null; recomputedCandidate: unknown; preparation: unknown; liveDependency: ReleaseIdentity; now: string }, options: ReleaseParseOptions = {}): Promise<PublishedSiteLocaleSnapshot> {
  keys(record(input, "$"), ["current", "recomputedCandidate", "preparation", "liveDependency", "now"], "$");
  const preparation = parseSiteLocaleReleasePreparation(input.preparation), candidate = await verifyPublishedSiteLocaleSnapshot(input.recomputedCandidate, options), now = Date.parse(instant(input.now, "$.now"));
  if (now >= Date.parse(preparation.expiresAt)) fail("$.preparation.expiresAt", "preparation expired");
  const current = input.current === null ? null : await verifyPublishedSiteLocaleSnapshot(input.current, options);
  if ((current?.version ?? null) !== preparation.expectedCurrentVersion) fail("$.preparation.expectedCurrentVersion", "current release version changed");
  const identityFields = ["siteId", "locale", "sourceLocale", "defaultLocale", "documentLocale"] as const;
  if (identityFields.some((field) => candidate[field] !== preparation[field]) || current && identityFields.some((field) => current[field] !== preparation[field])) fail("$.preparation", "release identity mismatch");
  if (current && (candidate.releaseId === current.releaseId || candidate.version === current.version)) fail("$.recomputedCandidate", "candidate must have a new immutable identity");
  if (canonical(identity(input.liveDependency, "$.liveDependency")) !== canonical(preparation.liveDependency)) fail("$.liveDependency", "live release dependencies changed");
  if (candidate.releaseId !== preparation.candidateReleaseId || candidate.version !== preparation.candidateVersion || candidate.contentDigest !== preparation.candidateDigest || canonical(candidate.manifest) !== canonical(preparation.candidateManifest)) fail("$.preparation", "recomputed release no longer matches preparation");
  return clone(candidate);
}

function splitInternalHref(href: string, origins: readonly string[]): { path: string; rest: string; absoluteOrigin?: string } | undefined {
  if (typeof href !== "string" || href.length > 2048 || /[\u0000-\u001f\u007f\\<>"']/u.test(href)) return undefined;
  if (href.startsWith("//") || href.startsWith("#")) return undefined;
  if (href.startsWith("/")) { const at = href.search(/[?#]/); return { path: at < 0 ? href : href.slice(0, at), rest: at < 0 ? "" : href.slice(at) }; }
  let url: URL; try { url = new URL(href); } catch { return undefined; }
  if (url.protocol !== "https:" || !origins.includes(url.origin) || url.username || url.password) return undefined;
  return { path: url.pathname, rest: url.search + url.hash, absoluteOrigin: url.origin };
}
export type LocalizedLinkResolution = { status: "localized"; href: string; pageId: string } | { status: "unresolved-known"; pageId: string } | { status: "unaffected" };
/** Rewrites only an exact route from a published release. Known pages missing in the target are explicit, so nav callers can omit them. */
export function resolveLocalizedInternalLink(input: { href: string; current: PublishedSiteLocaleSnapshot; target: PublishedSiteLocaleSnapshot; known?: readonly PublishedSiteLocaleSnapshot[]; origins?: readonly string[] }, options: ReleaseParseOptions = {}): LocalizedLinkResolution {
  keys(record(input, "$"), ["href", "current", "target", "known", "origins"], "$");
  const current = parsePublishedSiteLocaleSnapshot(input.current, options), target = parsePublishedSiteLocaleSnapshot(input.target, options);
  if (current.siteId !== target.siteId) fail("$.target.siteId", "site mismatch");
  if (input.known !== undefined && (!Array.isArray(input.known) || input.known.length > 10)) fail("$.known", "expected bounded release array");
  const parsed = splitInternalHref(input.href, approvedOrigins(input.origins ?? [])); if (!parsed || ["/api", "/assets", "/embed", "/_next"].some((prefix) => parsed.path === prefix || parsed.path.startsWith(`${prefix}/`))) return { status: "unaffected" };
  const known = (input.known ?? []).map((snapshot) => parsePublishedSiteLocaleSnapshot(snapshot, options));
  if (known.some((snapshot) => snapshot.siteId !== current.siteId)) fail("$.known", "known release belongs to another site");
  const all = [current, ...known];
  const route = all.flatMap((snapshot) => snapshot.routes).find((entry) => entry.path === parsed.path || entry.sourcePath === parsed.path);
  if (!route) return { status: "unaffected" };
  const destination = target.routes.find((entry) => entry.pageId === route.pageId);
  if (!destination) return { status: "unresolved-known", pageId: route.pageId };
  return { status: "localized", pageId: route.pageId, href: `${parsed.absoluteOrigin ?? ""}${destination.path}${parsed.rest}` };
}

export function resolveLanguageSwitch(snapshot: PublishedSiteLocaleSnapshot, pageId: string, counterparts: readonly PublishedSiteLocaleSnapshot[], origins: Readonly<Record<string, string>>, options: ReleaseParseOptions = {}): { locale: LocalizationLocale; href: string }[] {
  const current = parsePublishedSiteLocaleSnapshot(snapshot, options), id = identifier(pageId, "$.pageId");
  if (!current.routes.some((route) => route.pageId === id)) return [];
  if (!Array.isArray(counterparts) || counterparts.length > 10) fail("$.counterparts", "expected bounded release array");
  const releases = counterparts.map((entry) => parsePublishedSiteLocaleSnapshot(entry, options)).filter((entry) => entry.siteId === current.siteId);
  if (new Set(releases.map((entry) => entry.locale)).size !== releases.length) fail("$.counterparts", "duplicate locale release");
  return releases.flatMap((entry) => {
    const route = entry.routes.find((candidate) => candidate.pageId === id), origin = origins[entry.locale];
    if (!route || !origin) return [];
    if (!isSafeHttpsOrigin(origin)) fail(`$.origins.${entry.locale}`, "invalid origin");
    return [{ locale: entry.locale, href: `${origin}${route.path}` }];
  });
}

export type LocalizedPageSeo = { releaseId: string; pageId: string; htmlLang: string; robots: "index, follow" | "noindex, nofollow"; canonical?: string; hreflang: { locale: string; href: string }[]; xDefault?: string };
export function deriveLocalizedPageSeo(input: { snapshot: PublishedSiteLocaleSnapshot; pageId: string; origin: string; counterparts?: readonly { snapshot: PublishedSiteLocaleSnapshot; origin: string }[]; preview?: boolean }, options: ReleaseParseOptions = {}): LocalizedPageSeo {
  keys(record(input, "$"), ["snapshot", "pageId", "origin", "counterparts", "preview"], "$");
  const snapshot = parsePublishedSiteLocaleSnapshot(input.snapshot, options), pageId = identifier(input.pageId, "$.pageId");
  if (!isSafeHttpsOrigin(input.origin)) fail("$.origin", "invalid origin");
  const page = snapshot.pages.find((entry) => entry.pageId === pageId); if (!page) fail("$.pageId", "page is not published in this release");
  const preview = input.preview === true, indexable = page.indexable && !preview;
  const counterparts = input.counterparts ?? [];
  if (!Array.isArray(counterparts) || counterparts.length > 10) fail("$.counterparts", "expected bounded release array");
  counterparts.forEach((entry, index) => { keys(record(entry, `$.counterparts[${index}]`), ["snapshot", "origin"], `$.counterparts[${index}]`); if (!isSafeHttpsOrigin(entry.origin)) fail(`$.counterparts[${index}].origin`, "invalid origin"); });
  const releases = [{ snapshot, origin: input.origin }, ...counterparts.map((entry) => ({ snapshot: parsePublishedSiteLocaleSnapshot(entry.snapshot, options), origin: entry.origin }))]
    .filter((entry) => entry.snapshot.siteId === snapshot.siteId);
  const hreflang = indexable ? releases.flatMap((entry) => {
    const route = entry.snapshot.routes.find((candidate) => candidate.pageId === pageId && candidate.indexable);
    return route ? [{ locale: entry.snapshot.documentLocale, href: `${entry.origin}${route.path}` }] : [];
  }) : [];
  const base = releases.find((entry) => entry.snapshot.locale === snapshot.defaultLocale), baseRoute = base?.snapshot.routes.find((entry) => entry.pageId === pageId && entry.indexable);
  return { releaseId: snapshot.releaseId, pageId, htmlLang: snapshot.documentLocale, robots: indexable ? "index, follow" : "noindex, nofollow",
    ...(indexable ? { canonical: `${input.origin}${page.path}` } : {}), hreflang, ...(indexable && base && baseRoute ? { xDefault: `${base.origin}${baseRoute.path}` } : {}) };
}
export function createLocalizedSitemap(entries: readonly { snapshot: PublishedSiteLocaleSnapshot; origin: string }[], options: ReleaseParseOptions = {}): { releaseId: string; locale: LocalizationLocale; pageId: string; url: string }[] {
  if (!Array.isArray(entries) || entries.length > 10) fail("$.entries", "expected bounded locale releases");
  return entries.flatMap((entry, index) => {
    keys(record(entry, `$.entries[${index}]`), ["snapshot", "origin"], `$.entries[${index}]`);
    const snapshot = parsePublishedSiteLocaleSnapshot(entry.snapshot, options); if (!isSafeHttpsOrigin(entry.origin)) fail(`$.entries[${index}].origin`, "invalid origin");
    return snapshot.routes.filter((route) => route.indexable).map((route) => ({ releaseId: snapshot.releaseId, locale: snapshot.locale, pageId: route.pageId, url: `${entry.origin}${route.path}` }));
  });
}
export function siteLocaleReleaseCacheIdentity(snapshot: PublishedSiteLocaleSnapshot, pageId: string, options: ReleaseParseOptions = {}): string {
  const parsed = parsePublishedSiteLocaleSnapshot(snapshot, options), id = identifier(pageId, "$.pageId");
  if (!parsed.pages.some((page) => page.pageId === id)) fail("$.pageId", "page is not published");
  const resources = parsed.manifest.resources.map((entry) => entry.digest).sort().join(".");
  return `${parsed.siteId}:${parsed.locale}:${parsed.releaseId}:${id}:${parsed.contentDigest}:${resources}`;
}

function routeKey(path: string): string { return path.length > 1 ? path.replace(/\/+$/, "") : path; }
function approvedOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) fail("$.origins", "expected bounded origin array");
  const origins = value.map((entry, index) => {
    const origin = string(entry, `$.origins[${index}]`, 2048);
    if (!isSafeHttpsOrigin(origin)) fail(`$.origins[${index}]`, "invalid origin");
    return origin;
  });
  if (new Set(origins).size !== origins.length) fail("$.origins", "duplicate origin");
  return origins;
}
function pointsToRemovedRoute(href: unknown, removedRoutes: ReadonlySet<string>, origins: readonly string[]): boolean {
  if (typeof href !== "string") return false;
  const part = splitInternalHref(href, origins);
  return !!part && removedRoutes.has(routeKey(part.path));
}
function withoutLinkAttributes(attrs: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> | undefined {
  if (!attrs) return undefined;
  const result = Object.fromEntries(Object.entries(attrs).filter(([name]) => !["href", "target", "rel", "hreflang"].includes(name.toLowerCase())));
  return Object.keys(result).length ? result : undefined;
}
function projectNodes(nodes: readonly PageNode[], removedRoutes: ReadonlySet<string>, origins: readonly string[], blocks: BlockContracts,
  components: ComponentLibrary, exposedHrefNodes: ReadonlySet<string> = new Set()): PageNode[] {
  return nodes.map((node): PageNode => {
    if (node.type === "text") return clone(node);
    if (node.type === "element") {
      const removed = node.tag === "a" && pointsToRemovedRoute(node.attrs?.href, removedRoutes, origins);
      const children = projectNodes(node.children, removedRoutes, origins, blocks, components, exposedHrefNodes);
      if (!removed) return { ...clone(node), children };
      const { attrs: _attrs, ...base } = clone(node), attrs = withoutLinkAttributes(node.attrs);
      // href の公開propはa要素に束縛される。hrefなしのaを保ち、安全なインスタンス別URLは引き続き適用できる。
      return { ...base, tag: exposedHrefNodes.has(node.id) ? "a" : "span", ...(attrs ? { attrs } : {}), children };
    }
    if (node.type === "component") {
      const rules = blocks[node.block]?.props ?? {};
      const removed = Object.keys(node.props).filter((name) => rules[name]?.type === "url" && pointsToRemovedRoute(node.props[name], removedRoutes, origins));
      const props = Object.fromEntries(Object.entries(node.props).filter(([name]) => !removed.includes(name)));
      return { ...clone(node), props };
    }
    const definition = components.components.find((component) => component.id === node.component);
    const { props: _props, ...base } = clone(node);
    const props = node.props && Object.fromEntries(Object.entries(node.props).filter(([name, value]) =>
      definition?.props?.[name]?.field !== "href" || !pointsToRemovedRoute(value, removedRoutes, origins)));
    return { ...base, ...(props && Object.keys(props).length ? { props } : {}) };
  });
}
function projectNavigation(items: readonly PublishedNavigationItem[], allowed: ReadonlySet<string>, removedRoutes: ReadonlySet<string>, origins: readonly string[]): PublishedNavigationItem[] {
  return items.flatMap((item) => item.pageId && !allowed.has(item.pageId) || item.href && pointsToRemovedRoute(item.href, removedRoutes, origins) ? [] : [{
    ...clone(item), ...(item.children ? { children: projectNavigation(item.children, allowed, removedRoutes, origins) } : {})
  }]);
}

export type CurrentLocalePublicVisibility = {
  /** Authoritative host catalogue. IDs absent from an older snapshot are not joined into it. */
  eligiblePageIds: readonly string[];
  revokedPageIds: readonly string[];
  /** Approved same-site origins used only to recognize absolute internal links. */
  origins: readonly string[];
};

/**
 * Derives the current public read view from one immutable historical locale release.
 * It can only remove pages and links: it never joins current source layout, text or newly-created pages.
 */
export async function projectCurrentPublishedSiteLocaleSnapshot(input: { snapshot: PublishedSiteLocaleSnapshot; visibility: CurrentLocalePublicVisibility }, options: ReleaseParseOptions = {}): Promise<PublishedSiteLocaleSnapshot> {
  keys(record(input, "$"), ["snapshot", "visibility"], "$");
  const previous = await verifyPublishedSiteLocaleSnapshot(input.snapshot, options), visibility = record(input.visibility, "$.visibility");
  keys(visibility, ["eligiblePageIds", "revokedPageIds", "origins"], "$.visibility");
  const eligible = new Set(uniqueIds(visibility.eligiblePageIds, "$.visibility.eligiblePageIds"));
  const revoked = new Set(uniqueIds(visibility.revokedPageIds, "$.visibility.revokedPageIds"));
  if ([...eligible].some((id) => revoked.has(id))) fail("$.visibility", "eligible and revoked page sets overlap");
  const origins = approvedOrigins(visibility.origins);
  const allowedIds = new Set(previous.pages.filter((page) => eligible.has(page.pageId) && !revoked.has(page.pageId)).map((page) => page.pageId));
  if (!allowedIds.size) fail("$.visibility", "no public pages remain available");
  const removedRoutes = new Set(previous.routes.filter((route) => !allowedIds.has(route.pageId)).flatMap((route) => [route.path, route.sourcePath]).map(routeKey));
  const components: ComponentLibrary = { ...clone(previous.components), components: previous.components.components.map((component) => ({
    ...clone(component), root: projectNodes([component.root], removedRoutes, origins, options.blocks ?? {}, previous.components,
      new Set(Object.values(component.props ?? {}).filter((prop) => prop.field === "href").map((prop) => prop.node)))[0] as typeof component.root
  })) };
  const pages = previous.pages.filter((page) => allowedIds.has(page.pageId)).map((page) => ({
    ...clone(page), document: { ...clone(page.document), body: projectNodes(page.document.body, removedRoutes, origins, options.blocks ?? {}, previous.components) }
  }));
  const routes = previous.routes.filter((route) => allowedIds.has(route.pageId));
  const seo = previous.seo.filter((entry) => allowedIds.has(entry.pageId));
  const { contentDigest: _digest, ...base } = clone(previous);
  const payload = snapshotPayload({ ...base, pages, components, routes, seo, navigation: projectNavigation(previous.navigation, allowedIds, removedRoutes, origins) });
  const projected = { ...payload, contentDigest: await contentDigest(payload) };
  return verifyPublishedSiteLocaleSnapshot(projected, options);
}

/** Creates a new immutable rollback release after applying current host visibility. It never reactivates an old release ID/version. */
export async function createRevocationSafeRollback(input: { previous: PublishedSiteLocaleSnapshot; releaseId: string; version: string; eligiblePageIds: readonly string[]; revokedPageIds: readonly string[]; origins: readonly string[] }, options: ReleaseParseOptions = {}): Promise<PublishedSiteLocaleSnapshot> {
  keys(record(input, "$"), ["previous", "releaseId", "version", "eligiblePageIds", "revokedPageIds", "origins"], "$");
  const projected = await projectCurrentPublishedSiteLocaleSnapshot({ snapshot: input.previous, visibility: { eligiblePageIds: input.eligiblePageIds, revokedPageIds: input.revokedPageIds, origins: input.origins } }, options);
  const releaseId = boundedVersion(input.releaseId, "$.releaseId"), version = boundedVersion(input.version, "$.version");
  if (releaseId === projected.releaseId || version === projected.version) fail("$", "rollback requires a new immutable identity");
  const { contentDigest: _digest, ...base } = clone(projected);
  const payload = snapshotPayload({ ...base, releaseId, version });
  return verifyPublishedSiteLocaleSnapshot({ ...payload, contentDigest: await contentDigest(payload) }, options);
}

/** Dynamic stock, price, permission and business-record visibility are not frozen here; the authoritative host read model remains the final public gate. */
export const DYNAMIC_PUBLIC_READ_RESPONSIBILITY = "authoritative-host-final-gate" as const;
