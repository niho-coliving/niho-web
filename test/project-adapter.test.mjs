import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createProjectEditorAdapter } from "@niho/web/project-editor";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const project = { id: "project_demo", name: "デモ計画", site: { id: "demo", name: "デモサイト", domains: ["https://example.test", "https://www.example.test"] }, members: [] };
const signal = () => new AbortController().signal;
function setup(overrides = {}) {
  const calls = { sites: 0, pages: [], reads: [], saves: [], prepares: [], releases: [] };
  const adapter = {
    listSites: async () => { calls.sites++; return [{ id: "other", name: "別サイト", domains: ["https://other.example.test"] }, project.site]; },
    listPages: async (siteId) => { calls.pages.push(siteId); return [{ siteId, pageId: "home", locale: "ja-JP", title: "ホーム" }]; },
    readDocument: async (target) => { calls.reads.push(structuredClone(target)); return { document: { ...fixture, ...target }, version: "v1" }; },
    saveDraft: async (request) => { calls.saves.push(structuredClone(request)); return { status: "saved", version: "v2", revision: 2 }; },
    prepareRelease: async (request) => { calls.prepares.push(structuredClone(request)); return { ...request, confirmationToken: "token", domain: "https://example.test", changes: [] }; },
    release: async (request) => { calls.releases.push(structuredClone(request)); return { status: "released", snapshot: { document: { ...fixture, ...request.target }, version: "v2" } }; },
    ...overrides
  };
  return { calls, wrapped: createProjectEditorAdapter(adapter, project) };
}

test("project editor lists only its one approved site and rejects inconsistent site metadata", async () => {
  const { wrapped } = setup();
  assert.deepEqual(await wrapped.listSites(signal()), [project.site]);
  const missing = setup({ listSites: async () => [{ id: "other", name: "別", domains: [] }] }).wrapped;
  await assert.rejects(() => missing.listSites(signal()), /サイト情報/);
  const changedDomain = setup({ listSites: async () => [{ ...project.site, domains: ["https://evil.example.test"] }] }).wrapped;
  await assert.rejects(() => changedDomain.listSites(signal()), /サイト情報/);
});

test("project editor accepts display-name differences and approved domain order differences", async () => {
  const { wrapped } = setup({ listSites: async () => [{ ...project.site, name: "ホスト側の表示名", domains: [...project.site.domains].reverse() }] });
  assert.deepEqual(await wrapped.listSites(signal()), [project.site]);
});

test("cross-site list requests, page responses, read targets and documents are rejected", async () => {
  const { wrapped } = setup();
  await assert.rejects(() => wrapped.listPages("other", signal()), /プロジェクト外/);
  await assert.rejects(() => setup({ listPages: async () => [{ siteId: "other", pageId: "home", locale: "ja-JP", title: "別" }] }).wrapped.listPages("demo", signal()), /別サイト/);
  await assert.rejects(() => wrapped.readDocument({ siteId: "other", pageId: "home", locale: "ja-JP" }, signal()), /一致/);
  await assert.rejects(() => setup({ readDocument: async () => ({ document: { ...fixture, siteId: "other" }, version: "v1" }) }).wrapped.readDocument({ siteId: "demo", pageId: "home", locale: "ja-JP" }, signal()), /文書の対象/);
});

test("legal read and save preserve compatibility while forwarding identity fields only", async () => {
  const { calls, wrapped } = setup();
  const target = { siteId: "demo", pageId: "home", locale: "ja-JP", ignored: "do-not-forward" };
  const snapshot = await wrapped.readDocument(target, signal());
  assert.equal(snapshot.version, "v1");
  assert.deepEqual(calls.reads[0], { siteId: "demo", pageId: "home", locale: "ja-JP" });
  const document = { ...fixture, siteId: "demo", pageId: "home", locale: "ja-JP" };
  await wrapped.saveDraft({ target, document, expectedVersion: "v1", ignored: true }, signal());
  assert.deepEqual(calls.saves[0].target, { siteId: "demo", pageId: "home", locale: "ja-JP" });
  assert.deepEqual(Object.keys(calls.saves[0]).sort(), ["document", "expectedVersion", "target"]);
  await wrapped.saveDraft({ target, document, expectedVersion: "v2", trigger: "autosave" }, signal());
  assert.equal(calls.saves[1].trigger, "autosave");
  const localization = { expectedSourceVersion: "source-1", expectedVersion: "loc-1", expectedOverlayVersion: 3 };
  await wrapped.saveDraft({ target, document, expectedVersion: "v3", localization }, signal());
  assert.deepEqual(calls.saves[2].localization, localization);
  await assert.rejects(() => wrapped.saveDraft({ target, document: { ...document, siteId: "other" }, expectedVersion: "v1" }, signal()), /文書の対象/);
});

test("prepare and release reject cross-site plans and unapproved domains, but legal release remains compatible", async () => {
  const target = { siteId: "demo", pageId: "home", locale: "ja-JP" };
  const request = { target, expectedVersion: "v1", action: "publish" };
  await assert.rejects(() => setup({ prepareRelease: async (input) => ({ ...input, confirmationToken: "token", domain: "https://evil.example.test", changes: [] }) }).wrapped.prepareRelease(request, signal()), /一致/);
  await assert.rejects(() => setup({ prepareRelease: async (input) => ({ ...input, target: { ...target, siteId: "other" }, confirmationToken: "token", domain: "https://example.test", changes: [] }) }).wrapped.prepareRelease(request, signal()), /一致/);
  const { calls, wrapped } = setup();
  const plan = await wrapped.prepareRelease({ ...request, ignored: true }, signal());
  assert.deepEqual(Object.keys(calls.prepares[0]).sort(), ["action", "expectedVersion", "target"]);
  const released = await wrapped.release(plan, signal());
  assert.equal(released.status, "released");
  assert.deepEqual(calls.releases[0].target, target);
  await assert.rejects(() => wrapped.release({ ...plan, domain: "https://example.test/" }, signal()), /一致/);
});

test("registered block documents pass through the site wrapper without requiring its React registry", async () => {
  const document = structuredClone(fixture);
  document.body.push({ type: "component", id: "host_block", block: "HostOwned", props: { label: "公開情報" } });
  const { wrapped } = setup({ readDocument: async (target) => ({ document: { ...document, ...target }, version: "v1" }) });
  const result = await wrapped.readDocument({ siteId: "demo", pageId: "home", locale: "ja-JP" }, signal());
  assert.equal(result.document.body.at(-1).block, "HostOwned");
});

const pageHostMethods = (calls, overrides = {}) => ({
  preparePageChange: async (change) => { calls.pageChanges.push(structuredClone(change)); return { change, confirmationToken: "page-token", domain: "https://example.test", impact: { after: "https://example.test/new", linkedFrom: [], navigation: [], notes: [] } }; },
  applyPageChange: async (plan) => { calls.applies.push(structuredClone(plan)); return { status: "applied", page: { siteId: "demo", pageId: "new", locale: "ja-JP", title: "新規", path: "/new", hidden: "x" } }; },
  readSiteSettings: async (siteId) => { calls.settings.push(siteId); return { settings: { title: "デモ", locale: "ja" }, version: "s1" }; },
  saveSiteSettings: async (request) => { calls.settingsSaves.push(structuredClone(request)); return { status: "saved", version: "s2" }; },
  ...overrides
});
test("page list optional fields and structured data presets pass through validated, unknown fields are dropped", async () => {
  const { wrapped } = setup({
    listSites: async () => [{ ...project.site, structuredData: [{ id: "organization", label: "組織", description: "運営者", extra: true }, { id: "localBusiness", label: "店舗" }] }],
    listPages: async () => [{ siteId: "demo", pageId: "detail", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template", visibility: "public", published: false, secret: "drop" }]
  });
  assert.deepEqual(await wrapped.listSites(signal()), [{ ...project.site, structuredData: [{ id: "organization", label: "組織", description: "運営者" }, { id: "localBusiness", label: "店舗" }] }]);
  assert.deepEqual(await wrapped.listPages("demo", signal()), [{ siteId: "demo", pageId: "detail", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template", visibility: "public", published: false }]);
  for (const extra of [{ kind: "layout" }, { visibility: "hidden" }, { published: "yes" }, { path: "/a\nb" }, { path: 1 }])
    await assert.rejects(() => setup({ listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", ...extra }] }).wrapped.listPages("demo", signal()));
  await assert.rejects(() => setup({ listSites: async () => [{ ...project.site, structuredData: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }] }).wrapped.listSites(signal()), /重複/);
  await assert.rejects(() => setup({ listSites: async () => [{ ...project.site, structuredData: [{ id: "1bad", label: "A" }] }] }).wrapped.listSites(signal()));
});
test("optional page and site methods are absent unless the host implements them", () => {
  const { wrapped } = setup();
  for (const name of ["preparePageChange", "applyPageChange", "readSiteSettings", "saveSiteSettings", "localization"]) assert.equal(name in wrapped, false, name);
  const calls = { pageChanges: [], applies: [], settings: [], settingsSaves: [] };
  const partial = setup({ readSiteSettings: pageHostMethods(calls).readSiteSettings }).wrapped;
  assert.equal(typeof partial.readSiteSettings, "function"); assert.equal("saveSiteSettings" in partial, false); assert.equal("preparePageChange" in partial, false);
});
test("localization methods remain project-scoped and preserve optimistic command fields", async () => {
  const calls = [];
  const localization = {
    readSite: async (siteId) => ({ config: { siteId }, pages: [{ siteId, pageId: "home", title: "ホーム", locales: {} }], version: "site-1" }),
    readPage: async (target) => ({ sourceDocument: { ...fixture, siteId: target.siteId, pageId: target.pageId }, sourceVersion: "source-1", overlay: {}, version: "loc-1" }),
    command: async (request) => { calls.push(structuredClone(request)); return { status: "applied", version: "loc-2" }; },
    requestSiteTranslation: async (request) => { calls.push(structuredClone(request)); return { status: "applied", version: "site-2" }; }
  };
  const { wrapped } = setup({ localization });
  assert.equal((await wrapped.localization.readSite("demo", signal())).version, "site-1");
  await assert.rejects(() => wrapped.localization.readSite("other", signal()), /プロジェクト外/);
  const target = { siteId: "demo", pageId: "home", locale: "en" };
  assert.equal((await wrapped.localization.readPage(target, signal())).sourceVersion, "source-1");
  await assert.rejects(() => wrapped.localization.readPage({ ...target, siteId: "other" }, signal()), /一致/);
  const command = { action: "request-translation", target, expectedSourceVersion: "source-1", expectedVersion: "loc-1", expectedOverlayVersion: 2 };
  assert.equal((await wrapped.localization.command(command, signal())).status, "applied");
  assert.deepEqual(calls[0], command);
  const manual = { action: "set-value", target, unitId: "component.header.node.title.text", value: "Manual", sourceFingerprint: `sha256:${"a".repeat(64)}`,
    expectedEntryVersion: 4, expectedSourceVersion: "source-1", expectedVersion: "loc-1", expectedOverlayVersion: 2 };
  assert.equal((await wrapped.localization.command(manual, signal())).status, "applied");
  assert.deepEqual(calls[1], manual);
  await assert.rejects(() => wrapped.localization.command({ ...command, target: { ...target, siteId: "other" } }, signal()), /一致/);
  await wrapped.localization.requestSiteTranslation({ siteId: "demo", targetLocale: "en", expectedVersion: "site-1" }, signal());
  await assert.rejects(() => wrapped.localization.requestSiteTranslation({ siteId: "other", targetLocale: "en", expectedVersion: "site-1" }, signal()), /プロジェクト外/);
});
test("whole-locale publication stays project/domain scoped and rejects malformed or mismatched host replies", async () => {
  const now = "2026-10-21T00:00:00.000Z", current = { releaseId: "en-1", version: "release-v1", label: "English 1", publishedAt: now, pages: 1, sharedResources: 1 };
  const calls = { apply: [] };
  const base = {
    readSite: async (siteId) => ({ config: { siteId }, pages: [], version: "site-2" }), readPage: async () => ({}), command: async () => ({ status: "conflict" }),
    readRelease: async ({ siteId, locale }) => ({ siteId, locale, current, history: [] }),
    prepareRelease: async (request) => ({ ...request, confirmationToken: "one-use", domain: "https://example.test", expiresAt: "2030-01-01T00:00:00.000Z", optimisticVersion: "live-deps-2", previous: current,
      prepared: { ...current, releaseId: "en-2", version: "release-v2", label: "English 2" }, pages: [{ pageId: "home", title: "Home", path: "/en/", complete: true, reasons: [] }],
      sharedResources: [{ id: "navigation", label: "Main navigation", kind: "navigation", complete: true, reasons: [] }], incompleteReasons: [], complete: true }),
    applyRelease: async (request) => { calls.apply.push(structuredClone(request)); return { status: "applied", siteId: request.siteId, locale: request.locale, current: { ...current, releaseId: request.preparedReleaseId, version: request.preparedVersion, label: "English 2" } }; },
    rollbackRelease: async () => ({ status: "conflict" })
  };
  const { wrapped } = setup({ localization: base });
  assert.equal((await wrapped.localization.readRelease({ siteId: "demo", locale: "en" }, signal())).current.version, "release-v1");
  await assert.rejects(() => wrapped.localization.readRelease({ siteId: "other", locale: "en" }, signal()), /プロジェクト外/);
  const request = { siteId: "demo", locale: "en", action: "publish", expectedSiteVersion: "site-2", expectedCurrentVersion: "release-v1" };
  const plan = await wrapped.localization.prepareRelease(request, signal());
  const apply = { confirmationToken: plan.confirmationToken, siteId: "demo", locale: "en", expectedCurrentVersion: "release-v1", optimisticVersion: plan.optimisticVersion,
    preparedReleaseId: plan.prepared.releaseId, preparedVersion: plan.prepared.version };
  assert.equal((await wrapped.localization.applyRelease(apply, signal())).status, "applied"); assert.deepEqual(calls.apply[0], apply);
  await assert.rejects(() => wrapped.localization.applyRelease({ ...apply, siteId: "other" }, signal()), /プロジェクト外/);
  const evil = setup({ localization: { ...base, prepareRelease: async (value) => ({ ...(await base.prepareRelease(value)), domain: "https://evil.example.test" }) } }).wrapped;
  await assert.rejects(() => evil.localization.prepareRelease(request, signal()), /mismatch/);
  const malformed = setup({ localization: { ...base, prepareRelease: async (value) => { const plan = await base.prepareRelease(value); return { ...plan, pages: [...plan.pages, { ...plan.pages[0], pageId: "other" }] }; } } }).wrapped;
  await assert.rejects(() => malformed.localization.prepareRelease(request, signal()), /duplicate locale release page/);
  const duplicateResource = setup({ localization: { ...base, prepareRelease: async (value) => { const plan = await base.prepareRelease(value); return { ...plan, prepared: { ...plan.prepared, sharedResources: 2 }, sharedResources: [...plan.sharedResources, { ...plan.sharedResources[0] }] }; } } }).wrapped;
  await assert.rejects(() => duplicateResource.localization.prepareRelease(request, signal()), /duplicate shared release resource/);
  const inconsistent = setup({ localization: { ...base, prepareRelease: async (value) => { const plan = await base.prepareRelease(value); return { ...plan, pages: [{ ...plan.pages[0], complete: true, reasons: ["unfinished"] }] }; } } }).wrapped;
  await assert.rejects(() => inconsistent.localization.prepareRelease(request, signal()), /completeness mismatch/);
  const wrongApply = setup({ localization: { ...base, applyRelease: async () => ({ status: "applied", siteId: "demo", locale: "en", current: { ...current, releaseId: "wrong", version: "wrong" } }) } }).wrapped;
  await assert.rejects(() => wrongApply.localization.applyRelease(apply, signal()), /mismatch/);
  const foreignApply = setup({ localization: { ...base, applyRelease: async () => ({ status: "applied", siteId: "other", locale: "en", current: { ...current, releaseId: "en-2", version: "release-v2" } }) } }).wrapped;
  await assert.rejects(() => foreignApply.localization.applyRelease(apply, signal()), /invalid/);
  const unknownApply = setup({ localization: { ...base, applyRelease: async () => ({ status: "maybe" }) } }).wrapped;
  await assert.rejects(() => unknownApply.localization.applyRelease(apply, signal()), /invalid/);
});
test("page changes and site settings are limited to the project site and re-validated", async () => {
  const calls = { pageChanges: [], applies: [], settings: [], settingsSaves: [] };
  const { wrapped } = setup(pageHostMethods(calls));
  const change = { action: "create", siteId: "demo", locale: "ja-JP", title: "新規", path: "/new", ignored: true };
  const plan = await wrapped.preparePageChange(change, signal());
  assert.deepEqual(calls.pageChanges[0], { action: "create", siteId: "demo", locale: "ja-JP", title: "新規", path: "/new" });
  assert.deepEqual(await wrapped.applyPageChange(plan, signal()), { status: "applied", page: { siteId: "demo", pageId: "new", locale: "ja-JP", title: "新規", path: "/new" } });
  await assert.rejects(() => wrapped.preparePageChange({ ...change, siteId: "other" }, signal()), /一致しません/);
  await assert.rejects(() => wrapped.preparePageChange({ action: "visibility", target: { siteId: "other", pageId: "home", locale: "ja-JP" }, visibility: "private" }, signal()), /一致しません/);
  await assert.rejects(() => wrapped.applyPageChange({ ...plan, domain: "https://evil.example.test" }, signal()), /ページ変更の対象/);
  assert.equal(calls.pageChanges.length, 1); assert.equal(calls.applies.length, 1);
  await assert.rejects(() => setup(pageHostMethods(calls, { preparePageChange: async (input) => ({ change: input, confirmationToken: "t", domain: "https://evil.example.test", impact: { linkedFrom: [], navigation: [], notes: [] } }) })).wrapped.preparePageChange(change, signal()), /ページ変更の対象/);
  await assert.rejects(() => setup(pageHostMethods(calls, { applyPageChange: async () => ({ status: "applied", page: { siteId: "other", pageId: "x", locale: "ja-JP", title: "x" } }) })).wrapped.applyPageChange(plan, signal()), /結果/);
  assert.deepEqual(await wrapped.readSiteSettings("demo", signal()), { settings: { title: "デモ", locale: "ja" }, version: "s1" });
  await assert.rejects(() => wrapped.readSiteSettings("other", signal()), /プロジェクト外/);
  await assert.rejects(() => wrapped.saveSiteSettings({ siteId: "other", settings: { title: "x", locale: "ja" }, expectedVersion: "s1" }, signal()), /プロジェクト外/);
  await assert.rejects(() => wrapped.saveSiteSettings({ siteId: "demo", settings: { title: "x", locale: "ja", script: "x" }, expectedVersion: "s1" }, signal()));
  assert.deepEqual(await wrapped.saveSiteSettings({ siteId: "demo", settings: { title: "x", locale: "ja" }, expectedVersion: "s1" }, signal()), { status: "saved", version: "s2" });
  assert.deepEqual(calls.settings, ["demo"]); assert.deepEqual(calls.settingsSaves, [{ siteId: "demo", settings: { title: "x", locale: "ja" }, expectedVersion: "s1" }]);
});

const revisionEntry = { id: "rev_2", revision: 2, kind: "draft", createdAt: "2026-10-21T00:00:00.000Z", actor: "編集者" };
const revisionMethods = (calls, overrides = {}) => ({
  listRevisions: async (request) => { calls.lists.push(structuredClone(request)); return { entries: [revisionEntry], next: "c2" }; },
  readRevision: async (request) => { calls.readsRevision.push(structuredClone(request)); return { document: { ...fixture, ...request.target } }; },
  createSnapshot: async (request) => { calls.snapshots.push(structuredClone(request)); return { status: "saved", entry: { ...revisionEntry, id: "snap_1", kind: "snapshot", label: request.label } }; },
  ...overrides
});
test("revision methods are wrapped only when present, limited to the project site and validated", async () => {
  const { wrapped: legacy } = setup();
  for (const name of ["listRevisions", "readRevision", "createSnapshot"]) assert.equal(name in legacy, false, name);
  const calls = { lists: [], readsRevision: [], snapshots: [] };
  const only = setup({ listRevisions: revisionMethods(calls).listRevisions }).wrapped;
  assert.equal(typeof only.listRevisions, "function"); assert.equal("readRevision" in only, false); assert.equal("createSnapshot" in only, false);
  const { wrapped } = setup(revisionMethods(calls));
  const target = { siteId: "demo", pageId: "home", locale: "ja-JP" };
  assert.deepEqual(await wrapped.listRevisions({ target: { ...target, ignored: true }, cursor: "c1" }, signal()), { entries: [revisionEntry], next: "c2" });
  assert.deepEqual(calls.lists[0], { target, cursor: "c1" });
  assert.deepEqual(Object.keys(await wrapped.readRevision({ target, id: "rev_2" }, signal())), ["document"]);
  assert.deepEqual(calls.readsRevision[0], { target, id: "rev_2" });
  assert.deepEqual(await wrapped.createSnapshot({ target, expectedVersion: "v1", label: "公開前" }, signal()), { status: "saved", entry: { ...revisionEntry, id: "snap_1", kind: "snapshot", label: "公開前" } });
  assert.deepEqual(calls.snapshots[0], { target, expectedVersion: "v1", label: "公開前" });
  const other = { ...target, siteId: "other" };
  await assert.rejects(() => wrapped.listRevisions({ target: other }, signal()), /一致しません/);
  await assert.rejects(() => wrapped.readRevision({ target: other, id: "rev_2" }, signal()), /一致しません/);
  await assert.rejects(() => wrapped.createSnapshot({ target: other, expectedVersion: "v1", label: "x" }, signal()), /一致しません/);
  assert.equal(calls.lists.length, 1); assert.equal(calls.readsRevision.length, 1); assert.equal(calls.snapshots.length, 1);
  await assert.rejects(() => setup(revisionMethods(calls, { readRevision: async () => ({ document: { ...fixture, siteId: "other" } }) })).wrapped.readRevision({ target, id: "rev_2" }, signal()), /文書の対象/);
  await assert.rejects(() => setup(revisionMethods(calls, { listRevisions: async () => ({ entries: [{ ...revisionEntry, email: "x@example.test" }] }) })).wrapped.listRevisions({ target }, signal()));
  await assert.rejects(() => setup(revisionMethods(calls, { createSnapshot: async () => ({ status: "saved", entry: { ...revisionEntry, kind: "merge" } }) })).wrapped.createSnapshot({ target, expectedVersion: "v1", label: "x" }, signal()));
  assert.deepEqual(await setup(revisionMethods(calls, { createSnapshot: async () => ({ status: "conflict" }) })).wrapped.createSnapshot({ target, expectedVersion: "v1", label: "x" }, signal()), { status: "conflict" });
});
test("release plans keep a validated public URL and affected list through the project wrapper", async () => {
  const target = { siteId: "demo", pageId: "home", locale: "ja-JP" }, request = { target, expectedVersion: "v1", action: "publish" };
  const extra = { url: "https://example.test/about", affected: [{ kind: "shared", name: "ヘッダー", detail: "ナビゲーション", hidden: true }, { kind: "site", name: "サイト設定" }] };
  const { wrapped, calls } = setup({ prepareRelease: async (input) => ({ ...input, confirmationToken: "token", domain: "https://example.test", changes: [], ...extra }) });
  const plan = await wrapped.prepareRelease(request, signal());
  assert.equal(plan.url, "https://example.test/about");
  assert.deepEqual(plan.affected, [{ kind: "shared", name: "ヘッダー", detail: "ナビゲーション" }, { kind: "site", name: "サイト設定" }]);
  await wrapped.release(plan, signal()); assert.equal(calls.releases[0].url, "https://example.test/about");
  for (const url of ["https://evil.example.test/about", "https://www.example.test/about", "https://example.test.evil/x"])
    await assert.rejects(() => setup({ prepareRelease: async (input) => ({ ...input, confirmationToken: "token", domain: "https://example.test", changes: [], url }) }).wrapped.prepareRelease(request, signal()), /一致/);
  await assert.rejects(() => setup({ prepareRelease: async (input) => ({ ...input, confirmationToken: "token", domain: "https://example.test", changes: [], affected: [{ kind: "layout", name: "x" }] }) }).wrapped.prepareRelease(request, signal()), /一致/);
  await assert.rejects(() => wrapped.release({ ...plan, url: "https://evil.example.test/about" }, signal()), /一致/);
});
