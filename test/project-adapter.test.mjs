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
  for (const name of ["preparePageChange", "applyPageChange", "readSiteSettings", "saveSiteSettings"]) assert.equal(name in wrapped, false, name);
  const calls = { pageChanges: [], applies: [], settings: [], settingsSaves: [] };
  const partial = setup({ readSiteSettings: pageHostMethods(calls).readSiteSettings }).wrapped;
  assert.equal(typeof partial.readSiteSettings, "function"); assert.equal("saveSiteSettings" in partial, false); assert.equal("preparePageChange" in partial, false);
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
