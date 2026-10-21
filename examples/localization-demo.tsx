import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PageEditor, type EditorAdapter, type EditorLocaleReleasePlan, type EditorLocaleReleasePrepareRequest, type EditorLocaleReleaseSummary, type EditorLocalizationCommand, type EditorPage, type EditorTarget } from "@niho/web/editor";
import type { AssetLibraryAdapter } from "@niho/web/assets";
import type { ComponentLibrary, PageDocument, PageNode } from "@niho/web/core";
import {
  acceptTranslationResult, adoptTranslationCandidate, collectLocalizationUnits, createLocalizationOverlay, editLocalizedValue,
  localizedValuesForDocument, localizationStatus, materializeLocalizedPage, reviewLocalizedValue, validateLocalizedDocumentSave,
  type LocalizationCollection, type LocalizationLocale, type LocalizationOverlay, type LocalizationValue, type SiteLocalizationConfig
} from "@niho/web/localization";

type PageState = { page: Omit<EditorPage, "locale">; source: PageDocument; target: PageDocument; collection: LocalizationCollection; overlay: LocalizationOverlay; documentVersion: number; localizationVersion: number; job: { state: "idle" | "queued" | "running" | "failed"; message?: string } };
type DemoSnapshot = { pages: Map<string, PageDocument>; paths: Map<string, string>; components: ComponentLibrary };
type DemoLocaleRelease = { current: EditorLocaleReleaseSummary | null; history: EditorLocaleReleaseSummary[]; snapshots: Map<string, DemoSnapshot> };
type DemoPreparedRelease = { plan: EditorLocaleReleasePlan; siteVersion: number; used: boolean; rollbackReleaseId?: string };
type SiteState = { name: string; config: SiteLocalizationConfig; components: ComponentLibrary; componentVersion: number; pages: Map<string, PageState>; siteVersion: number; job: PageState["job"]; releases: Record<LocalizationLocale, DemoLocaleRelease>; prepared: Map<string, DemoPreparedRelease>; releaseSequence: number };
const controls = { delayMs: 700, failNext: false, conflictNext: false, releaseConflictNext: false, releaseFailNext: false };
const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); });
const text = (value: string): PageNode => ({ type: "text", text: value });
const element = (id: string, tag: "header" | "nav" | "main" | "section" | "h1" | "p" | "a" | "img" | "footer", children: PageNode[] = [], attrs?: Record<string, string>): PageNode => ({ type: "element", id, tag, ...(attrs ? { attrs } : {}), children });
function makeDocument(siteId: string, pageId: string, locale: string, title: string, heading: string, body: string): PageDocument {
  return { schemaVersion: 1, siteId, pageId, locale, revision: 1, title, meta: { description: body }, tokens: { ink: { type: "color", value: "#17382d" }, paper: { type: "color", value: "#f7f3ea" } }, body: [
    { type: "instance", id: `${pageId}_sharedHeader`, component: "siteHeader" },
    { ...element(`${pageId}_main`, "main", [element(`${pageId}_hero`, "section", [element(`${pageId}_heading`, "h1", [text(heading)]), element(`${pageId}_lead`, "p", [text(body)]), { ...element(`${pageId}_photo`, "img", [], { alt: locale.startsWith("ja") ? "鎌倉の海" : "Kamakura sea" }), asset: { provider: "demo", id: "main" } }])]), style: { base: { padding: 32, color: { token: "ink" }, display: "flex", flexDirection: "column", gap: 18 } } },
    { type: "instance", id: `${pageId}_sharedFooter`, component: "siteFooter" }
  ] };
}
function componentLibrary(siteId: string, sourceLocale: LocalizationLocale): ComponentLibrary {
  const japanese = sourceLocale === "ja";
  return { schemaVersion: 1, siteId, revision: 1, tokens: { paper: { type: "color", value: "#f7f3ea" } }, components: [
    { id: "siteHeader", name: "共通ヘッダー", kind: "header", version: 1, root: { ...element("headerRoot", "header", [element("sharedNav", "nav", [
      element("sharedHome", "a", [text(japanese ? "ホーム" : "Home")], { href: "/" }), element("sharedAbout", "a", [text(japanese ? "私たちについて" : "About")], { href: "/about" })])]), style: { base: { display: "flex", padding: 20, backgroundColor: { token: "paper" } } } } },
    { id: "siteFooter", name: "共通フッター", kind: "footer", version: 1, root: { ...element("footerRoot", "footer", [element("sharedFooterText", "p", [text(japanese ? "海と暮らす、小さな場所。" : "A small place to live with the sea.")])]), style: { base: { padding: 24, backgroundColor: { token: "paper" } } } } }
  ] };
}
const configs: Record<string, SiteLocalizationConfig> = {
  kamakura: { schemaVersion: 1, siteId: "kamakura", sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"], documentLocales: { ja: "ja-JP", en: "en-US" }, glossaryVersion: "kamakura-demo-g1", contextVersion: "demo-v1" },
  experience: { schemaVersion: 1, siteId: "experience", sourceLocale: "en", defaultLocale: "en", enabledLocales: ["en", "ja"], documentLocales: { ja: "ja-JP", en: "en-US" }, glossaryVersion: "experience-demo-g1", contextVersion: "demo-v1" }
};
const dictionary = new Map<string, string>([
  ["ホーム", "Home"], ["私たちについて", "About us"], ["鎌倉で暮らす", "Live in Kamakura"], ["海と街を日常にする住まいです。", "A home where the sea and town become part of everyday life."], ["海と暮らす、小さな場所。", "A small place to live with the sea."], ["滞在について", "About your stay"], ["地域の人と過ごす時間をご案内します。", "Discover time shared with the local community."],
  ["Home", "ホーム"], ["About", "私たちについて"], ["Find your Kamakura experience", "鎌倉の日常を体験する"], ["Meet local people and discover the coast beyond sightseeing.", "地域の人と出会い、観光だけではない海辺を知る体験です。"], ["A small place to live with the sea.", "海と暮らす、小さな場所。"], ["Plan your visit", "旅の準備"], ["Choose a slow morning or an evening with the community.", "静かな朝、または地域と過ごす夕方を選べます。"]
]);
const translated = (value: string) => dictionary.get(value) ?? `［デモ訳］${value}`;
const translateValue = (value: LocalizationValue): LocalizationValue => typeof value === "string" ? translated(value) : value.kind === "asset" ? { kind: "asset", asset: { provider: "demo", id: "localized" } }
  : { kind: "rich-text", children: value.children.map(function map(node): typeof node { return node.type === "text" ? { ...node, text: translated(node.text) } : { ...node, children: node.children.map(map) }; }) };
async function makePage(config: SiteLocalizationConfig, components: ComponentLibrary, pageId: string, path: string, title: string, heading: string, body: string, initialIncomplete = false): Promise<PageState> {
  const source = makeDocument(config.siteId, pageId, config.documentLocales[config.sourceLocale], title, heading, body), targetLocale = config.sourceLocale === "ja" ? "en" : "ja", options = { components };
  const collection = await collectLocalizationUnits(config, source, targetLocale, options); let overlay = createLocalizationOverlay(collection);
  for (const unit of collection.units) overlay = editLocalizedValue(overlay, collection, { unitId: unit.unitId, value: translateValue(unit.sourceValue), expectedVersion: overlay.version });
  const required = collection.units.filter((entry) => entry.required), skipped = initialIncomplete ? required.find((entry) => entry.scope === "page")?.unitId : undefined;
  for (const unit of required.filter((entry) => entry.unitId !== skipped)) overlay = reviewLocalizedValue(overlay, collection, { unitId: unit.unitId, expectedVersion: overlay.version });
  // A distinct candidate demonstrates that generation never overwrites the current accepted/manual draft.
  const titleUnit = collection.units.find((unit) => unit.unitId === "page.title")!;
  overlay = acceptTranslationResult(overlay, collection, { schemaVersion: 1, resultId: `${config.siteId}_${pageId}_candidate`, siteId: config.siteId, pageId, sourceLocale: config.sourceLocale,
    targetLocale, baseVersion: overlay.version, values: [{ unitId: titleUnit.unitId, sourceFingerprint: titleUnit.sourceFingerprint, value: `${translated(title)}（新しい翻訳案）` }] });
  const target = (await materializeLocalizedPage(config, source, collection, overlay, options)).document;
  return { page: { siteId: config.siteId, pageId, title, path }, source, target, collection, overlay, documentVersion: 1, localizationVersion: 1, job: { state: "idle" } };
}
const sites = new Map<string, SiteState>();
async function demoSnapshot(siteId: string, locale: LocalizationLocale, pages: Map<string, PageState>, components: ComponentLibrary): Promise<DemoSnapshot> {
  const config = configs[siteId]!, documents = new Map<string, PageDocument>(), paths = new Map<string, string>();
  let localizedComponents = structuredClone(components);
  for (const [id, page] of pages) {
    const materialized = await materializeLocalizedPage(config, page.source, page.collection, page.overlay, { components });
    documents.set(id, materialized.document);
    if (materialized.components) localizedComponents = materialized.components;
    const path = page.page.path ?? "/";
    paths.set(id, locale === config.defaultLocale ? path : path === "/" ? `/${locale}/` : `/${locale}${path}`);
  }
  return { pages: documents, paths, components: localizedComponents };
}
const demoRelease = async (siteId: string, locale: LocalizationLocale, pages: Map<string, PageState>, components: ComponentLibrary): Promise<DemoLocaleRelease> => {
  const snapshot = await demoSnapshot(siteId, locale, pages, components);
  const current: EditorLocaleReleaseSummary = { releaseId: `${siteId}-${locale}-published-1`, version: "release-1", label: `${locale === "ja" ? "日本語" : "English"} 公開版 1`, publishedAt: "2026-10-20T00:00:00.000Z", pages: pages.size, sharedResources: 4 };
  const prior: EditorLocaleReleaseSummary = { ...current, releaseId: `${siteId}-${locale}-published-0`, version: "release-0", label: `${locale === "ja" ? "日本語" : "English"} 公開版 0`, publishedAt: "2026-10-19T00:00:00.000Z" };
  return { current, history: [prior], snapshots: new Map([[current.releaseId, snapshot], [prior.releaseId, structuredClone(snapshot)]]) };
};
async function seed() {
  const kamakura = configs.kamakura!, experience = configs.experience!, kamakuraComponents = componentLibrary("kamakura", "ja"), experienceComponents = componentLibrary("experience", "en");
  const kamakuraPages = new Map<string, PageState>([
    ["home", await makePage(kamakura, kamakuraComponents, "home", "/", "ホーム", "鎌倉で暮らす", "海と街を日常にする住まいです。")],
    ["about", await makePage(kamakura, kamakuraComponents, "about", "/about", "滞在について", "滞在について", "地域の人と過ごす時間をご案内します。", true)] ]);
  const experiencePages = new Map<string, PageState>([
    ["home", await makePage(experience, experienceComponents, "home", "/", "Home", "Find your Kamakura experience", "Meet local people and discover the coast beyond sightseeing.")],
    ["about", await makePage(experience, experienceComponents, "about", "/about", "Plan your visit", "Plan your visit", "Choose a slow morning or an evening with the community.", true)] ]);
  const kamakuraTarget = "en", experienceTarget = "ja";
  sites.set("kamakura", { name: "NIHOkamakura", config: kamakura, components: kamakuraComponents, componentVersion: 1, siteVersion: 1, job: { state: "idle" }, pages: kamakuraPages,
    releases: { ja: { current: null, history: [], snapshots: new Map() }, en: await demoRelease("kamakura", kamakuraTarget, kamakuraPages, kamakuraComponents) }, prepared: new Map(), releaseSequence: 1 });
  sites.set("experience", { name: "NIHO experience", config: experience, components: experienceComponents, componentVersion: 1, siteVersion: 1, job: { state: "idle" }, pages: experiencePages,
    releases: { ja: await demoRelease("experience", experienceTarget, experiencePages, experienceComponents), en: { current: null, history: [], snapshots: new Map() } }, prepared: new Map(), releaseSequence: 1 });
}
await seed();
const siteFor = (siteId: string) => { const site = sites.get(siteId); if (!site) throw new Error("site not found"); return site; };
const pageFor = (target: EditorTarget) => { const page = siteFor(target.siteId).pages.get(target.pageId); if (!page) throw new Error("page not found"); return page; };
const isSource = (site: SiteState, target: EditorTarget) => target.locale === site.config.documentLocales[site.config.sourceLocale];
const statusFor = (site: SiteState, page: PageState, locale: LocalizationLocale) => locale === site.config.sourceLocale ? { state: "source" as const, published: true } : (() => {
  const status = localizationStatus(page.overlay, page.collection), release = site.releases[locale], current = release.current && release.snapshots.get(release.current.releaseId);
  return { state: page.job.state === "failed" ? "failed" as const : page.job.state === "queued" || page.job.state === "running" ? "translating" as const : status.reviewNeeded ? "review-needed" as const : status.complete ? "reviewed" as const : "review-needed" as const,
    changed: status.reviewNeeded, published: current?.pages.has(page.page.pageId) ?? false };
})();
const localizedDemoPath = (site: SiteState, locale: LocalizationLocale, path: string) => locale === site.config.defaultLocale ? path : path === "/" ? `/${locale}/` : `/${locale}${path}`;
const releaseName = (locale: LocalizationLocale) => locale === "ja" ? "日本語" : "English";
function releasePlan(site: SiteState, request: EditorLocaleReleasePrepareRequest): EditorLocaleReleasePlan {
  const release = site.releases[request.locale], previous = release.current;
  const restored = request.action === "rollback" ? release.snapshots.get(request.rollbackReleaseId ?? "") : undefined;
  if (request.action === "rollback" && !restored) throw new Error("synthetic prior release missing");
  const pending = (state: string | undefined) => state !== "source" && state !== "reviewed";
  const pageEntries = restored ? [...restored.pages].filter(([id]) => site.pages.has(id)).map(([id, document]) => ({
    pageId: id, title: document.title, path: restored.paths.get(id)!, complete: true, reasons: [] as string[]
  })) : [...site.pages.values()].map((page) => {
    const details = localizationStatus(page.overlay, page.collection).details, pageUnitIds = new Set(page.collection.units.filter((unit) => unit.scope === "page").map((unit) => unit.unitId));
    const incomplete = details.filter((detail) => pageUnitIds.has(detail.unitId) && pending(detail.state));
    return { pageId: page.page.pageId, title: request.locale === site.config.sourceLocale ? page.source.title : page.target.title, path: localizedDemoPath(site, request.locale, page.page.path ?? "/"), complete: incomplete.length === 0,
      reasons: incomplete.length ? [`未確認の項目が${incomplete.length}件あります`] : [] };
  });
  const sharedIncomplete = !restored && [...site.pages.values()].some((page) => {
    const states = new Map(localizationStatus(page.overlay, page.collection).details.map((detail) => [detail.unitId, detail.state]));
    return page.collection.units.some((unit) => unit.scope === "shared-component" && pending(states.get(unit.unitId)));
  });
  const imageIncomplete = !restored && [...site.pages.values()].some((page) => {
    const states = new Map(localizationStatus(page.overlay, page.collection).details.map((detail) => [detail.unitId, detail.state]));
    return page.collection.units.some((unit) => unit.kind === "asset" && pending(states.get(unit.unitId)));
  });
  const sharedResources = [
    { id: "components", label: "共通ヘッダー・フッター", kind: "component" as const, complete: !sharedIncomplete, reasons: sharedIncomplete ? ["共通部品に未確認の翻訳があります"] : [] },
    { id: "navigation", label: "サイトナビゲーション", kind: "navigation" as const, complete: !sharedIncomplete, reasons: sharedIncomplete ? ["ナビ表示に未確認の翻訳があります"] : [] },
    { id: "styles", label: "サイトスタイル", kind: "style" as const, complete: true, reasons: [] },
    { id: "assets", label: "画像・参照ファイル", kind: "resource" as const, complete: !imageIncomplete, reasons: imageIncomplete ? ["差し替えた画像の確認が必要です"] : [] }
  ];
  const incompleteReasons = [...pageEntries.filter((page) => !page.complete).map((page) => `${page.title}: ${page.reasons[0]}`), ...sharedResources.filter((resource) => !resource.complete).map((resource) => `${resource.label}: ${resource.reasons[0]}`)];
  const sequence = ++site.releaseSequence, prepared: EditorLocaleReleaseSummary = { releaseId: `${site.config.siteId}-${request.locale}-${request.action}-${sequence}`, version: `release-${sequence}`,
    label: `${releaseName(request.locale)} ${request.action === "rollback" ? "復元" : "公開"}版 ${sequence}`, publishedAt: new Date().toISOString(), pages: pageEntries.length, sharedResources: sharedResources.length };
  const confirmationToken = `demo-one-use-${site.config.siteId}-${request.locale}-${sequence}`;
  const plan: EditorLocaleReleasePlan = { ...request, confirmationToken, domain: `https://${site.config.siteId}.demo.invalid`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), optimisticVersion: `site-${site.siteVersion}`,
    previous, prepared, pages: pageEntries, sharedResources, incompleteReasons, complete: incompleteReasons.length === 0 };
  site.prepared.set(confirmationToken, { plan: structuredClone(plan), siteVersion: site.siteVersion, used: false, ...(request.rollbackReleaseId ? { rollbackReleaseId: request.rollbackReleaseId } : {}) });
  return plan;
}
async function applyDemoRelease(request: Parameters<NonNullable<NonNullable<EditorAdapter["localization"]>["applyRelease"]>>[0], rollback: boolean) {
  const site = siteFor(request.siteId), pending = site.prepared.get(request.confirmationToken), release = site.releases[request.locale];
  if (!pending || pending.used) return { status: "conflict" as const };
  pending.used = true;
  if (controls.releaseConflictNext) { controls.releaseConflictNext = false; return { status: "conflict" as const }; }
  if (Date.parse(pending.plan.expiresAt) <= Date.now()) return { status: "expired" as const };
  if (pending.siteVersion !== site.siteVersion || pending.plan.optimisticVersion !== request.optimisticVersion || pending.plan.expectedCurrentVersion !== request.expectedCurrentVersion ||
    pending.plan.prepared.releaseId !== request.preparedReleaseId || pending.plan.prepared.version !== request.preparedVersion || rollback !== (pending.plan.action === "rollback")) return { status: "conflict" as const };
  const loseResponse = controls.releaseFailNext; controls.releaseFailNext = false;
  const snapshot = rollback && pending.rollbackReleaseId ? release.snapshots.get(pending.rollbackReleaseId) : await demoSnapshot(request.siteId, request.locale, site.pages, site.components);
  if (!snapshot) return { status: "conflict" as const };
  if (!pending.plan.complete || pending.siteVersion !== site.siteVersion || (release.current?.version ?? null) !== request.expectedCurrentVersion) return { status: "conflict" as const };
  const visibleSnapshot = { ...structuredClone(snapshot), pages: new Map([...snapshot.pages].filter(([id]) => site.pages.has(id))), paths: new Map([...snapshot.paths].filter(([id]) => site.pages.has(id))) };
  if (release.current) release.history.unshift(release.current);
  release.current = structuredClone(pending.plan.prepared); release.snapshots.set(release.current.releaseId, visibleSnapshot); site.siteVersion++;
  if (loseResponse) throw new Error("synthetic response loss after locale release commit");
  return { status: "applied" as const, siteId: request.siteId, locale: request.locale, current: structuredClone(release.current) };
}
async function generate(page: PageState, site: SiteState, signal: AbortSignal) {
  page.job = { state: "running" }; await wait(controls.delayMs, signal);
  if (controls.failNext) { controls.failNext = false; page.job = { state: "failed", message: "デモで指定した失敗です。再試行できます。" }; throw new Error("synthetic translation failure"); }
  const values = page.collection.units.filter((unit) => unit.translatable).map((unit) => ({ unitId: unit.unitId, sourceFingerprint: unit.sourceFingerprint, value: translateValue(unit.sourceValue) as string }));
  page.overlay = acceptTranslationResult(page.overlay, page.collection, { schemaVersion: 1, resultId: `demo_${Date.now()}`, siteId: site.config.siteId, pageId: page.source.pageId, sourceLocale: site.config.sourceLocale,
    targetLocale: page.collection.targetLocale, baseVersion: page.overlay.version, values });
  page.localizationVersion++; page.job = { state: "idle" };
}
export const localizationDemoAdapter: EditorAdapter = {
  listSites: async () => [...sites.entries()].map(([id, site]) => ({ id, name: site.name, domains: [`https://${id}.demo.invalid`] })),
  listPages: async (siteId) => { const site = siteFor(siteId); return [...site.pages.values()].map((page) => ({ ...page.page, locale: site.config.documentLocales[site.config.sourceLocale] })); },
  readDocument: async (target) => { const site = siteFor(target.siteId), page = pageFor(target); return { document: structuredClone(isSource(site, target) ? page.source : page.target), version: `doc-${page.documentVersion}` }; },
  saveDraft: async (request) => {
    const site = siteFor(request.target.siteId), page = pageFor(request.target);
    if (request.expectedVersion !== `doc-${page.documentVersion}`) return { status: "conflict" };
    if (isSource(site, request.target)) {
      page.source = { ...structuredClone(request.document), revision: page.source.revision + 1 };
      page.collection = await collectLocalizationUnits(site.config, page.source, page.collection.targetLocale, { components: site.components });
      page.target = (await materializeLocalizedPage(site.config, page.source, page.collection, page.overlay, { components: site.components })).document;
    } else {
      if (!request.localization || request.localization.expectedSourceVersion !== `source-${page.source.revision}-lib-${site.componentVersion}` || request.localization.expectedVersion !== `loc-${page.localizationVersion}` || request.localization.expectedOverlayVersion !== page.overlay.version) return { status: "conflict" };
      const validation = await validateLocalizedDocumentSave(site.config, page.source, request.document, { components: site.components }), values = localizedValuesForDocument(validation.document, page.collection, { components: site.components });
      for (const unit of page.collection.units.filter((entry) => entry.scope === "page")) {
        const stored = page.overlay.entries.find((entry) => entry.unitId === unit.unitId)?.draftValue;
        if (JSON.stringify(stored) !== JSON.stringify(values[unit.unitId])) page.overlay = editLocalizedValue(page.overlay, page.collection, { unitId: unit.unitId, value: values[unit.unitId], expectedVersion: page.overlay.version });
      }
      page.localizationVersion++; page.target = { ...validation.document, revision: page.target.revision + 1 };
    }
    page.documentVersion++; site.siteVersion++; return { status: "saved", version: `doc-${page.documentVersion}`, revision: (isSource(site, request.target) ? page.source : page.target).revision };
  },
  prepareRelease: async (request) => ({ ...request, confirmationToken: "demo-source-only", domain: `https://${request.target.siteId}.demo.invalid`, changes: [{ path: "デモ", before: "公開は行いません", after: "原文側の確認UIだけを表示" }] }),
  release: async () => ({ status: "conflict" }),
  components: {
    readLibrary: async (siteId) => { const site = siteFor(siteId); return { library: structuredClone(site.components), version: `lib-${site.componentVersion}` }; },
    saveLibrary: async (request) => {
      const site = siteFor(request.siteId);
      if (request.expectedVersion !== `lib-${site.componentVersion}`) return { status: "conflict" };
      const revision = request.library.revision + 1;
      site.components = structuredClone({ ...request.library, revision }); site.componentVersion++; site.siteVersion++;
      for (const page of site.pages.values()) {
        page.collection = await collectLocalizationUnits(site.config, page.source, page.collection.targetLocale, { components: site.components });
        page.target = (await materializeLocalizedPage(site.config, page.source, page.collection, page.overlay, { components: site.components })).document;
        page.localizationVersion++;
      }
      return { status: "saved", version: `lib-${site.componentVersion}`, revision };
    },
    listUsage: async (siteId) => { const site = siteFor(siteId); return [...site.pages.values()].map((page) => ({ target: { siteId, pageId: page.page.pageId, locale: site.config.documentLocales[site.config.sourceLocale] }, title: page.page.title, components: { siteHeader: 1, siteFooter: 1 } })); }
  },
  localization: {
    readSite: async (siteId) => { const site = siteFor(siteId); return { config: structuredClone(site.config), version: `site-${site.siteVersion}`, job: structuredClone(site.job), pages: [...site.pages.values()].map((page) => ({ ...page.page,
      locales: { ja: statusFor(site, page, "ja"), en: statusFor(site, page, "en") } })) }; },
    readPage: async (target) => { const site = siteFor(target.siteId), page = pageFor(target); return { sourceDocument: structuredClone(page.source), sourceVersion: `source-${page.source.revision}-lib-${site.componentVersion}`, overlay: structuredClone(page.overlay), version: `loc-${page.localizationVersion}`, job: structuredClone(page.job) }; },
    command: async (request: EditorLocalizationCommand, signal) => {
      const site = siteFor(request.target.siteId), page = pageFor(request.target);
      if (controls.conflictNext) { controls.conflictNext = false; return { status: "conflict" }; }
      if (request.expectedSourceVersion !== `source-${page.source.revision}-lib-${site.componentVersion}` || request.expectedVersion !== `loc-${page.localizationVersion}` || request.expectedOverlayVersion !== page.overlay.version) return { status: "conflict" };
      if (request.action === "request-translation") await generate(page, site, signal);
      else {
        const unit = page.collection.units.find((item) => item.unitId === request.unitId); if (!unit) throw new Error("unknown unit");
        if (request.action === "set-value") {
          const entry = page.overlay.entries.find((item) => item.unitId === unit.unitId);
          if (request.sourceFingerprint !== unit.sourceFingerprint || request.expectedEntryVersion !== (entry?.version ?? 0)) return { status: "conflict" };
          page.overlay = editLocalizedValue(page.overlay, page.collection, { unitId: unit.unitId, value: request.value, expectedVersion: page.overlay.version });
        } else if (request.action === "adopt-candidate") page.overlay = adoptTranslationCandidate(page.overlay, page.collection, { unitId: request.unitId, expectedVersion: page.overlay.version, candidateVersion: request.candidateVersion });
        else page.overlay = reviewLocalizedValue(page.overlay, page.collection, { unitId: request.unitId, expectedVersion: page.overlay.version });
        if (unit.scope === "shared-component") {
          const value = page.overlay.entries.find((item) => item.unitId === unit.unitId)?.draftValue;
          if (value !== undefined) for (const other of site.pages.values()) if (other !== page && other.collection.units.some((item) => item.unitId === unit.unitId && item.sourceFingerprint === unit.sourceFingerprint)) {
            other.overlay = editLocalizedValue(other.overlay, other.collection, { unitId: unit.unitId, value, expectedVersion: other.overlay.version });
            if (request.action === "review-current") other.overlay = reviewLocalizedValue(other.overlay, other.collection, { unitId: unit.unitId, expectedVersion: other.overlay.version });
            other.target = (await materializeLocalizedPage(site.config, other.source, other.collection, other.overlay, { components: site.components })).document;
            other.localizationVersion++;
          }
        }
        page.target = (await materializeLocalizedPage(site.config, page.source, page.collection, page.overlay, { components: site.components })).document; page.localizationVersion++;
      }
      site.siteVersion++; return { status: "applied", version: `loc-${page.localizationVersion}` };
    },
    requestSiteTranslation: async ({ siteId, expectedVersion }, signal) => { const site = siteFor(siteId); if (expectedVersion !== `site-${site.siteVersion}` || controls.conflictNext) { controls.conflictNext = false; return { status: "conflict" }; }
      site.job = { state: "running" }; try { for (const page of site.pages.values()) await generate(page, site, signal); site.job = { state: "idle" }; site.siteVersion++; return { status: "applied", version: `site-${site.siteVersion}` }; } catch (error) { site.job = { state: "failed", message: "デモで指定した失敗です。" }; throw error; } },
    readRelease: async ({ siteId, locale }) => { const release = siteFor(siteId).releases[locale]; return { siteId, locale, current: structuredClone(release.current), history: structuredClone(release.history) }; },
    prepareRelease: async (request) => {
      const site = siteFor(request.siteId), release = site.releases[request.locale];
      if (request.expectedSiteVersion !== `site-${site.siteVersion}` || request.expectedCurrentVersion !== (release.current?.version ?? null) || request.action === "rollback" && !release.snapshots.has(request.rollbackReleaseId!)) throw new Error("synthetic release CAS mismatch");
      return releasePlan(site, request);
    },
    applyRelease: async (request) => applyDemoRelease(request, false),
    rollbackRelease: async (request) => applyDemoRelease(request, true)
  }
};
const asset = (siteId: string, id: string) => ({ provider: "demo", id, siteId, kind: "image" as const, status: "ready" as const, name: id === "main" ? "原文の海" : "言語別の海", mimeType: "image/svg+xml", bytes: 1200, width: 1200, height: 700, alt: "", version: "1", updatedAt: "2026-10-21T00:00:00.000Z" });
const assets: AssetLibraryAdapter = {
  listAssets: async ({ siteId }) => ({ assets: [asset(siteId, "main"), asset(siteId, "localized")], folders: [] }),
  uploadAsset: async () => ({ status: "rejected", reason: "permission" }), updateAsset: async () => ({ status: "rejected", reason: "permission" }),
  listAssetUsages: async () => [], deleteAsset: async () => ({ status: "rejected", reason: "permission" }),
  resolveAssets: async ({ references }) => Object.fromEntries(references.map((reference) => [`${reference.provider}:${reference.id}`, { src: reference.id === "localized" ? "/media/localized.svg" : "/media/main.svg", width: 1200, height: 700 }]))
};
function Demo() {
  const [, render] = useState(0), refresh = () => render((value) => value + 1);
  return <><div style={{ padding: 12, font: "13px sans-serif", background: "#fff8dc", borderBottom: "1px solid #d8c998" }}>
    <strong>合成データの多言語編集・言語全体公開デモ</strong> — 明示的な偽ホストです。本番AI・認証・保存基盤・公開APIには接続せず、本番の認可や安全性を表しません。変更は再読込で消えます。
    <label style={{ marginLeft: 16 }}>翻訳遅延 <select value={controls.delayMs} onChange={(event) => { controls.delayMs = Number(event.target.value); refresh(); }}><option value={200}>0.2秒</option><option value={700}>0.7秒</option><option value={2000}>2秒</option></select></label>
    <button style={{ marginLeft: 8 }} onClick={() => { controls.failNext = true; refresh(); }}>次の翻訳を失敗させる{controls.failNext ? " ✓" : ""}</button>
    <button style={{ marginLeft: 8 }} onClick={() => { controls.conflictNext = true; refresh(); }}>次の翻訳操作を409にする{controls.conflictNext ? " ✓" : ""}</button>
    <button style={{ marginLeft: 8 }} onClick={() => { controls.releaseConflictNext = true; refresh(); }}>次の言語公開を409にする{controls.releaseConflictNext ? " ✓" : ""}</button>
    <button style={{ marginLeft: 8 }} onClick={() => { controls.releaseFailNext = true; refresh(); }}>次の言語公開結果を不明にする{controls.releaseFailNext ? " ✓" : ""}</button>
    <button style={{ marginLeft: 8 }} disabled={siteFor("kamakura").pages.has("sourceOnly")} onClick={() => void (async () => {
      const site = siteFor("kamakura"); site.pages.set("sourceOnly", await makePage(site.config, site.components, "sourceOnly", "/new-source", "原文だけの新規ページ", "原文だけの新規ページ", "旧English公開版には入りません。", true)); site.siteVersion++; refresh();
    })()}>鎌倉の原文だけに新規ページ追加</button>
  </div><PageEditor adapter={localizationDemoAdapter} assets={assets} /></>;

}
createRoot(document.getElementById("root")!).render(<Demo />);
