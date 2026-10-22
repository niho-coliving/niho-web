import { parseSiteStyles } from "./site-styles.js";
import { normalizePageChange, parseEditorReadOnly, validatePageChangePlan, validateReleasePlan } from "./editor-model.js";
import { parseEditorLocaleReleaseApplyResult, parseEditorLocaleReleasePlan, parseEditorLocaleReleaseState } from "./editor-locale-release.js";
import type { EditorAdapter, EditorComponentAdapter, EditorLocaleReleaseApplyRequest, EditorLocaleReleasePrepareRequest, EditorLocalizationAdapter, EditorLocalizationCommand, EditorPage, EditorPageChange, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorStructuredDataPreset, EditorTarget } from "./editor-types.js";
import { parseRevisionEntry, parseRevisionPage } from "./history.js";
import { parseSiteSettings } from "./pages.js";
import { parseProject, type Project } from "./projects.js";
import { identifier, keys, line, record } from "./validation-utils.js";

function targetForProject(target: EditorTarget, site: EditorSite): EditorTarget {
  const normalized: EditorTarget = { siteId: target.siteId, pageId: target.pageId, locale: target.locale };
  if (normalized.siteId !== site.id) throw new Error("プロジェクトのサイトと編集対象が一致しません。");
  return normalized;
}

function sameSite(left: EditorSite, right: EditorSite): boolean {
  return left.id === right.id && left.domains.length === right.domains.length &&
    new Set(left.domains).size === left.domains.length && left.domains.every((domain) => right.domains.includes(domain));
}

function assertDocumentTarget(document: unknown, target: EditorTarget): void {
  const value = record(document, "document");
  if (value.siteId !== target.siteId || value.pageId !== target.pageId || value.locale !== target.locale) throw new Error("文書の対象が一致しません。");
}

function assertPresentationTarget(presentation: unknown, target: EditorTarget): void {
  if (presentation === undefined) return;
  const value = record(presentation, "presentation"), shared = record(value.shared, "presentation.shared");
  if (value.siteId !== target.siteId || value.locale !== target.locale) throw new Error("表示コンテキストの対象が一致しません。");
  for (const name of ["header", "footer"] as const) {
    const document = record(shared[name], `presentation.shared.${name}`);
    if (document.siteId !== target.siteId || document.locale !== target.locale) throw new Error("共有文書の対象が一致しません。");
  }
}

function assertLibrarySite(library: unknown, site: EditorSite): void {
  if (record(library, "library").siteId !== site.id) throw new Error("コンポーネントライブラリの対象サイトが一致しません。");
}

function releaseRequest(request: EditorReleaseRequest, target: EditorTarget): EditorReleaseRequest {
  return {
    target,
    expectedVersion: request.expectedVersion,
    action: request.action,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    ...(request.componentsVersion === undefined ? {} : { componentsVersion: request.componentsVersion }),
    ...(request.presentationVersion === undefined ? {} : { presentationVersion: request.presentationVersion })
  };
}

function releaseValue(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name}が正しくありません。`);
  return value;
}
function localeReleasePrepareRequest(request: EditorLocaleReleasePrepareRequest, site: EditorSite): EditorLocaleReleasePrepareRequest {
  if (request.siteId !== site.id || request.locale !== "ja" && request.locale !== "en" || request.action !== "publish" && request.action !== "rollback") throw new Error("プロジェクト外の言語版は操作できません。");
  if (request.action === "rollback" !== (request.rollbackReleaseId !== undefined)) throw new Error("言語版の復元対象が正しくありません。");
  return { siteId: site.id, locale: request.locale, action: request.action, expectedSiteVersion: releaseValue(request.expectedSiteVersion, "サイト版"),
    expectedCurrentVersion: request.expectedCurrentVersion === null ? null : releaseValue(request.expectedCurrentVersion, "現在の公開版"),
    ...(request.rollbackReleaseId === undefined ? {} : { rollbackReleaseId: releaseValue(request.rollbackReleaseId, "復元対象") }) };
}
function localeReleaseApplyRequest(request: EditorLocaleReleaseApplyRequest, site: EditorSite): EditorLocaleReleaseApplyRequest {
  if (request.siteId !== site.id || request.locale !== "ja" && request.locale !== "en") throw new Error("プロジェクト外の言語版は操作できません。");
  return { siteId: site.id, locale: request.locale, confirmationToken: releaseValue(request.confirmationToken, "確認情報", 512),
    expectedCurrentVersion: request.expectedCurrentVersion === null ? null : releaseValue(request.expectedCurrentVersion, "現在の公開版"),
    optimisticVersion: releaseValue(request.optimisticVersion, "確認用の版"), preparedReleaseId: releaseValue(request.preparedReleaseId, "準備した公開版"),
    preparedVersion: releaseValue(request.preparedVersion, "準備した版") };
}

/** 既知の任意項目だけを検証して渡す。 */
function pageEntry(page: EditorPage): EditorPage {
  const entry: EditorPage = { siteId: page.siteId, pageId: page.pageId, locale: page.locale, title: page.title };
  if (page.path !== undefined) {
    if (typeof page.path !== "string" || page.path.length > 160 || /[\u0000-\u001f\u007f]/u.test(page.path)) throw new Error("ページ一覧のパスが正しくありません。");
    entry.path = page.path;
  }
  if (page.kind !== undefined) {
    if (!["page", "template", "shared"].includes(page.kind)) throw new Error("ページ一覧の種類が正しくありません。");
    entry.kind = page.kind;
  }
  if (page.visibility !== undefined) {
    if (page.visibility !== "public" && page.visibility !== "private") throw new Error("ページ一覧の公開状態が正しくありません。");
    entry.visibility = page.visibility;
  }
  if (page.published !== undefined) {
    if (typeof page.published !== "boolean") throw new Error("ページ一覧の公開版の情報が正しくありません。");
    entry.published = page.published;
  }
  return entry;
}

function structuredDataPresets(value: unknown): EditorStructuredDataPreset[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("構造化データの種類を確認できません。");
  const presets = value.map((item: unknown, index): EditorStructuredDataPreset => {
    const source = record(item, `structuredData[${index}]`);
    return { id: identifier(source.id, `structuredData[${index}].id`), label: line(source.label, `structuredData[${index}].label`, 80),
      ...(source.description === undefined ? {} : { description: line(source.description, `structuredData[${index}].description`, 200, true) }) };
  });
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) throw new Error("構造化データの種類が重複しています。");
  return presets;
}

function changeForProject(change: EditorPageChange, site: EditorSite): EditorPageChange {
  const normalized = normalizePageChange(change);
  if (!normalized) throw new Error("ページ変更の要求が正しくありません。");
  const siteId = normalized.action === "create" ? normalized.siteId : normalized.action === "duplicate" ? normalized.source.siteId : normalized.target.siteId;
  if (siteId !== site.id) throw new Error("プロジェクトのサイトと編集対象が一致しません。");
  return normalized;
}

function checkedPlan(plan: EditorReleasePlan, request: EditorReleaseRequest, site: EditorSite): EditorReleasePlan {
  const copy: EditorReleasePlan = {
    ...releaseRequest(plan, targetForProject(plan.target, site)),
    confirmationToken: plan.confirmationToken,
    domain: plan.domain,
    changes: plan.changes.map((change) => ({ path: change.path, before: change.before, after: change.after })),
    ...(plan.url === undefined ? {} : { url: plan.url }),
    ...(plan.affected === undefined ? {} : { affected: Array.isArray(plan.affected) ? plan.affected.map((item) => item && typeof item === "object"
      ? { kind: item.kind, name: item.name, ...(item.detail === undefined ? {} : { detail: item.detail }) } : item) : plan.affected })
  };
  validateReleasePlan(copy, request, site);
  return copy;
}

/** 部品ライブラリと使用状況も Project の Site だけに限定する。 */
function componentsForProject(components: EditorComponentAdapter, site: EditorSite): EditorComponentAdapter {
  return {
    async readLibrary(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const snapshot = structuredClone(await components.readLibrary(site.id, signal));
      assertLibrarySite(snapshot.library, site);
      return snapshot;
    },
    async saveLibrary(request, signal) {
      if (request.siteId !== site.id) throw new Error("プロジェクト外のサイトには保存できません。");
      const library = structuredClone(request.library);
      assertLibrarySite(library, site);
      return components.saveLibrary({ siteId: site.id, library, expectedVersion: request.expectedVersion, ...(request.trigger === "autosave" ? { trigger: "autosave" as const } : {}) }, signal);
    },
    async listUsage(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const usage = structuredClone(await components.listUsage(site.id, signal));
      if (usage.some((entry) => entry.target.siteId !== site.id)) throw new Error("使用状況に別サイトの項目が含まれています。");
      return usage;
    }
  };
}

function localizationForProject(localization: EditorLocalizationAdapter, site: EditorSite): EditorLocalizationAdapter {
  const command = (request: EditorLocalizationCommand): EditorLocalizationCommand => {
    const target = targetForProject(request.target, site), common = { target, expectedSourceVersion: request.expectedSourceVersion, expectedVersion: request.expectedVersion, expectedOverlayVersion: request.expectedOverlayVersion };
    if (request.action === "request-translation") return { action: request.action, ...common };
    if (request.action === "adopt-candidate") return { action: request.action, ...common, unitId: request.unitId, candidateVersion: request.candidateVersion };
    if (request.action === "set-value") return { action: request.action, ...common, unitId: request.unitId, value: structuredClone(request.value), sourceFingerprint: request.sourceFingerprint, expectedEntryVersion: request.expectedEntryVersion };
    return { action: request.action, ...common, unitId: request.unitId };
  };
  return {
    async readSite(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const snapshot = structuredClone(await localization.readSite(site.id, signal));
      if (record(snapshot.config, "localization.config").siteId !== site.id || snapshot.pages.some((page) => page.siteId !== site.id)) throw new Error("多言語設定に別サイトの内容が含まれています。");
      return snapshot;
    },
    async readPage(target, signal) {
      const checked = targetForProject(target, site), snapshot = structuredClone(await localization.readPage(checked, signal));
      const source = record(snapshot.sourceDocument, "localization.sourceDocument");
      if (source.siteId !== site.id || source.pageId !== checked.pageId) throw new Error("多言語原文の対象が一致しません。");
      return snapshot;
    },
    async command(request, signal) { return localization.command(command(request), signal); },
    ...(localization.requestSiteTranslation ? { async requestSiteTranslation(request, signal) {
      if (request.siteId !== site.id) throw new Error("プロジェクト外のサイトは翻訳できません。");
      return localization.requestSiteTranslation!({ siteId: site.id, targetLocale: request.targetLocale, expectedVersion: request.expectedVersion }, signal);
    } } : {}),
    ...(localization.readRelease ? { async readRelease(request, signal) {
      if (request.siteId !== site.id || request.locale !== "ja" && request.locale !== "en") throw new Error("プロジェクト外の言語版は参照できません。");
      return parseEditorLocaleReleaseState(structuredClone(await localization.readRelease!({ siteId: site.id, locale: request.locale }, signal)), site.id, request.locale);
    } } : {}),
    ...(localization.prepareRelease ? { async prepareRelease(request, signal) {
      const checked = localeReleasePrepareRequest(request, site);
      return parseEditorLocaleReleasePlan(structuredClone(await localization.prepareRelease!(checked, signal)), checked, site.domains);
    } } : {}),
    ...(localization.applyRelease ? { async applyRelease(request, signal) {
      const checked = localeReleaseApplyRequest(request, site);
      return parseEditorLocaleReleaseApplyResult(structuredClone(await localization.applyRelease!(checked, signal)), { siteId: checked.siteId, locale: checked.locale, prepared: { releaseId: checked.preparedReleaseId, version: checked.preparedVersion } });
    } } : {}),
    ...(localization.rollbackRelease ? { async rollbackRelease(request, signal) {
      const checked = localeReleaseApplyRequest(request, site);
      return parseEditorLocaleReleaseApplyResult(structuredClone(await localization.rollbackRelease!(checked, signal)), { siteId: checked.siteId, locale: checked.locale, prepared: { releaseId: checked.preparedReleaseId, version: checked.preparedVersion } });
    } } : {})
  };
}

/**
 * EditorAdapter を Project の唯一の Site に限定する。これは認可機構ではないため、
 * 元 adapter は各呼出しで認証・サイト権限・永続化を検証しなければならない。
 */
export function createProjectEditorAdapter(adapter: EditorAdapter, projectInput: Project): EditorAdapter {
  const project = parseProject(projectInput);
  const site: EditorSite = { id: project.site.id, name: project.site.name, domains: [...project.site.domains] };
  return {
    async listSites(signal) {
      const sites = await adapter.listSites(signal);
      const matched = sites.find((candidate) => candidate.id === site.id);
      if (!matched || !sameSite(matched, site)) throw new Error("プロジェクトのサイト情報を確認できません。");
      return [{ id: site.id, name: site.name, domains: [...site.domains], ...(matched.structuredData === undefined ? {} : { structuredData: structuredDataPresets(matched.structuredData) }) }];
    },
    async listPages(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const pages = await adapter.listPages(site.id, signal);
      if (pages.some((page) => page.siteId !== site.id)) throw new Error("ページ一覧に別サイトの項目が含まれています。");
      return pages.map(pageEntry);
    },
    async readDocument(target, signal) {
      const checkedTarget = targetForProject(target, site);
      const snapshot = structuredClone(await adapter.readDocument(checkedTarget, signal));
      assertDocumentTarget(snapshot.document, checkedTarget);
      assertPresentationTarget(snapshot.presentation, checkedTarget);
      const { readOnly: rawReadOnly, ...rest } = snapshot, readOnly = parseEditorReadOnly(rawReadOnly);
      return { ...rest, ...(readOnly ? { readOnly } : {}) };
    },
    async saveDraft(request, signal) {
      const target = targetForProject(request.target, site);
      const document = structuredClone(request.document);
      assertDocumentTarget(document, target);
      return adapter.saveDraft({ target, document, expectedVersion: request.expectedVersion, ...(request.presentationVersion === undefined ? {} : { presentationVersion: request.presentationVersion }), ...(request.trigger === "autosave" ? { trigger: "autosave" as const } : {}),
        ...(request.localization ? { localization: { expectedSourceVersion: request.localization.expectedSourceVersion, expectedVersion: request.localization.expectedVersion,
          expectedOverlayVersion: request.localization.expectedOverlayVersion } } : {}) }, signal);
    },
    async prepareRelease(request, signal) {
      const checked = releaseRequest(request, targetForProject(request.target, site));
      const plan = await adapter.prepareRelease(checked, signal);
      return checkedPlan(plan, checked, site);
    },
    async release(request, signal) {
      const target = targetForProject(request.target, site);
      const checked = checkedPlan(request, releaseRequest(request, target), site);
      const result = await adapter.release(checked, signal);
      if (result.status === "released") {
        const snapshot = structuredClone(result.snapshot);
        assertDocumentTarget(snapshot.document, target);
        assertPresentationTarget(snapshot.presentation, target);
        const { readOnly: rawReadOnly, ...rest } = snapshot, readOnly = parseEditorReadOnly(rawReadOnly);
        return { status: "released", snapshot: { ...rest, ...(readOnly ? { readOnly } : {}) } };
      }
      return result;
    },
    ...(adapter.components ? { components: componentsForProject(adapter.components, site) } : {}),
    ...(adapter.localization ? { localization: localizationForProject(adapter.localization, site) } : {}),
    ...(adapter.preparePageChange ? {
      async preparePageChange(change, signal) {
        const checked = changeForProject(change, site);
        return validatePageChangePlan(structuredClone(await adapter.preparePageChange!(checked, signal)), checked, site);
      }
    } satisfies Pick<EditorAdapter, "preparePageChange"> : {}),
    ...(adapter.applyPageChange ? {
      async applyPageChange(plan, signal) {
        const checked = validatePageChangePlan(plan, changeForProject(plan.change, site), site);
        const result = await adapter.applyPageChange!(checked, signal);
        if (result.status === "conflict") return { status: "conflict" };
        if (result.status !== "applied" || !result.page || result.page.siteId !== site.id) throw new Error("ページ変更の結果が一致しません。");
        return { status: "applied", page: pageEntry(result.page) };
      }
    } satisfies Pick<EditorAdapter, "applyPageChange"> : {}),
    ...(adapter.siteStyleCapabilities ? { siteStyleCapabilities: adapter.siteStyleCapabilities } : {}),
    ...(adapter.readSiteSettings ? {
      async readSiteSettings(siteId, signal) {
        if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
        const snapshot = await adapter.readSiteSettings!(site.id, signal);
        return { settings: structuredClone(snapshot.settings), version: snapshot.version };
      }
    } satisfies Pick<EditorAdapter, "readSiteSettings"> : {}),
    ...(adapter.saveSiteSettings ? {
      async saveSiteSettings(request, signal) {
        if (request.siteId !== site.id) throw new Error("プロジェクト外のサイトは変更できません。");
        if (request.previousStyles !== undefined) keys(record(request.previousStyles, "$.previousStyles"), ["tokens", "textStyles"], "$.previousStyles");
        return adapter.saveSiteSettings!({ siteId: site.id, settings: parseSiteSettings(request.settings), expectedVersion: request.expectedVersion, ...(request.previousStyles === undefined ? {} : { previousStyles: parseSiteStyles(request.previousStyles) }) }, signal);
      }
    } satisfies Pick<EditorAdapter, "saveSiteSettings"> : {}),
    ...(adapter.listRevisions ? {
      async listRevisions(request, signal) {
        const target = targetForProject(request.target, site);
        if (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 500)) throw new Error("版履歴の続きを確認できません。");
        return parseRevisionPage(structuredClone(await adapter.listRevisions!({ target, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) }, signal)));
      }
    } satisfies Pick<EditorAdapter, "listRevisions"> : {}),
    ...(adapter.readRevision ? {
      async readRevision(request, signal) {
        const target = targetForProject(request.target, site);
        if (typeof request.id !== "string" || !request.id || request.id.length > 200) throw new Error("版を確認できません。");
        const result = structuredClone(await adapter.readRevision!({ target, id: request.id }, signal));
        assertDocumentTarget(result?.document, target);
        assertPresentationTarget(result?.presentation, target);
        return { document: result.document, ...(result.siteStyles === undefined ? {} : { siteStyles: result.siteStyles }), ...(result.presentation === undefined ? {} : { presentation: result.presentation }) };
      }
    } satisfies Pick<EditorAdapter, "readRevision"> : {}),
    ...(adapter.createSnapshot ? {
      async createSnapshot(request, signal) {
        const target = targetForProject(request.target, site);
        const result = await adapter.createSnapshot!({ target, expectedVersion: request.expectedVersion, label: request.label }, signal);
        if (result.status === "conflict") return { status: "conflict" };
        if (result.status !== "saved") throw new Error("スナップショットの結果が一致しません。");
        return { status: "saved", entry: parseRevisionEntry(structuredClone(result.entry)) };
      }
    } satisfies Pick<EditorAdapter, "createSnapshot"> : {})
  };
}
