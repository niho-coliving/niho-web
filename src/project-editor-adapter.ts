import { validateReleasePlan } from "./editor-model.js";
import type { EditorAdapter, EditorComponentAdapter, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorTarget } from "./editor-types.js";
import { parseProject, type Project } from "./projects.js";
import { record } from "./validation-utils.js";

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

function assertLibrarySite(library: unknown, site: EditorSite): void {
  if (record(library, "library").siteId !== site.id) throw new Error("部品ライブラリの対象サイトが一致しません。");
}

function releaseRequest(request: EditorReleaseRequest, target: EditorTarget): EditorReleaseRequest {
  return {
    target,
    expectedVersion: request.expectedVersion,
    action: request.action,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    ...(request.componentsVersion === undefined ? {} : { componentsVersion: request.componentsVersion })
  };
}

function checkedPlan(plan: EditorReleasePlan, request: EditorReleaseRequest, site: EditorSite): EditorReleasePlan {
  const copy: EditorReleasePlan = {
    ...releaseRequest(plan, targetForProject(plan.target, site)),
    confirmationToken: plan.confirmationToken,
    domain: plan.domain,
    changes: plan.changes.map((change) => ({ path: change.path, before: change.before, after: change.after }))
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
      return components.saveLibrary({ siteId: site.id, library, expectedVersion: request.expectedVersion }, signal);
    },
    async listUsage(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const usage = structuredClone(await components.listUsage(site.id, signal));
      if (usage.some((entry) => entry.target.siteId !== site.id)) throw new Error("使用状況に別サイトの項目が含まれています。");
      return usage;
    }
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
      return [{ id: site.id, name: site.name, domains: [...site.domains] }];
    },
    async listPages(siteId, signal) {
      if (siteId !== site.id) throw new Error("プロジェクト外のサイトは参照できません。");
      const pages = await adapter.listPages(site.id, signal);
      if (pages.some((page) => page.siteId !== site.id)) throw new Error("ページ一覧に別サイトの項目が含まれています。");
      return pages.map((page) => ({ siteId: page.siteId, pageId: page.pageId, locale: page.locale, title: page.title }));
    },
    async readDocument(target, signal) {
      const checkedTarget = targetForProject(target, site);
      const snapshot = structuredClone(await adapter.readDocument(checkedTarget, signal));
      assertDocumentTarget(snapshot.document, checkedTarget);
      return snapshot;
    },
    async saveDraft(request, signal) {
      const target = targetForProject(request.target, site);
      const document = structuredClone(request.document);
      assertDocumentTarget(document, target);
      return adapter.saveDraft({ target, document, expectedVersion: request.expectedVersion }, signal);
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
        return { status: "released", snapshot };
      }
      return result;
    },
    ...(adapter.components ? { components: componentsForProject(adapter.components, site) } : {})
  };
}
