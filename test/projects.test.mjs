import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_LIMITS, addProject, addProjectMember, commitProjectCatalog, createProjectCatalog,
  parseProjectCatalog, parseProjectCatalogSnapshot, readProjectCatalog, removeProjectMember
} from "@niho/web/projects";

const memberA = { userId: "user_alpha", displayName: "青木さん" };
const memberB = { userId: "user_beta", displayName: "森さん" };
const project = (id, siteId, members = [memberA]) => ({ id, name: `${id} 計画`, site: { id: siteId, name: `${siteId} サイト`, domains: [`https://${siteId}.example.test`] }, members: structuredClone(members) });
const fixture = () => ({ projects: [project("project_kamakura", "site_kamakura", [memberA, memberB]), project("project_shonan", "site_shonan", [memberA])] });

test("catalog validates two projects, multiple members and the same user in separate projects without retaining input references", () => {
  const input = fixture();
  const catalog = parseProjectCatalog(input);
  assert.equal(catalog.projects[0].members.length, 2);
  assert.equal(catalog.projects[1].members[0].userId, memberA.userId);
  input.projects[0].name = "外部で変更";
  input.projects[0].members[0].displayName = "外部で変更";
  input.projects[0].site.domains[0] = "https://changed.example.test";
  assert.equal(catalog.projects[0].name, "project_kamakura 計画");
  assert.equal(catalog.projects[0].members[0].displayName, "青木さん");
  assert.equal(catalog.projects[0].site.domains[0], "https://site_kamakura.example.test");
});

test("one site is mandatory and site arrays, permission data, prototype objects and unknown fields fail closed", () => {
  const base = project("project_one", "site_one");
  const invalid = [
    { ...base, site: undefined },
    { ...base, sites: [base.site] },
    { ...base, secondSite: base.site },
    { ...base, role: "owner" },
    { ...base, members: [{ ...memberA, email: "synthetic@example.test" }] },
    { ...base, site: { ...base.site, privateData: "hidden" } },
    Object.assign(Object.create({ polluted: true }), base)
  ];
  for (const value of invalid) assert.throws(() => parseProjectCatalog({ projects: [value] }));
  const polluted = JSON.parse('{"projects":[],"__proto__":{"polluted":true}}');
  assert.throws(() => parseProjectCatalog(polluted));
  assert.equal({}.polluted, undefined);
});

test("duplicate project, site and member IDs are rejected while cross-project membership is allowed", () => {
  assert.throws(() => parseProjectCatalog({ projects: [project("project_one", "site_one"), project("project_one", "site_two")] }), /duplicate project/);
  assert.throws(() => parseProjectCatalog({ projects: [project("project_one", "site_one"), project("project_two", "site_one")] }), /duplicate site/);
  assert.throws(() => parseProjectCatalog({ projects: [project("project_one", "site_one", [memberA, memberA])] }), /duplicate userId/);
  assert.doesNotThrow(() => parseProjectCatalog(fixture()));
});

test("IDs, HTTPS origins, controls and bounded arrays and strings are rejected strictly", () => {
  const invalidIds = ["", "1project", "project space", "project/one", "a".repeat(81)];
  for (const id of invalidIds) assert.throws(() => parseProjectCatalog({ projects: [{ ...project("project_one", "site_one"), id }] }));
  for (const domain of ["http://site.example.test", "https://site.example.test/", "https://site.example.test/path", "https://user:pass@site.example.test", "//site.example.test", "https://site.example.test\n"]) {
    assert.throws(() => parseProjectCatalog({ projects: [{ ...project("project_one", "site_one"), site: { ...project("project_one", "site_one").site, domains: [domain] } }] }), domain);
  }
  assert.throws(() => parseProjectCatalog({ projects: [{ ...project("project_one", "site_one"), name: "bad\nname" }] }));
  assert.throws(() => parseProjectCatalog({ projects: [{ ...project("project_one", "site_one"), name: "x".repeat(PROJECT_LIMITS.nameLength + 1) }] }));
  assert.throws(() => parseProjectCatalog({ projects: Array.from({ length: PROJECT_LIMITS.projects + 1 }, (_, index) => project(`project_${index}`, `site_${index}`)) }));
  assert.throws(() => parseProjectCatalog({ projects: [project("project_one", "site_one", Array.from({ length: PROJECT_LIMITS.membersPerProject + 1 }, (_, index) => ({ userId: `user_${index}`, displayName: "架空メンバー" })))] }));
  assert.throws(() => parseProjectCatalog({ projects: [{ ...project("project_one", "site_one"), site: { ...project("project_one", "site_one").site, domains: Array.from({ length: PROJECT_LIMITS.domainsPerSite + 1 }, (_, index) => `https://d${index}.example.test`) } }] }));
});

test("member user IDs are opaque up to 128 characters and reject empty, oversized or control-bearing values", () => {
  const numericUid = `1${"x".repeat(PROJECT_LIMITS.userIdLength - 1)}`;
  const catalog = parseProjectCatalog({ projects: [project("project_one", "site_one", [])] });
  const added = addProjectMember(catalog, "project_one", { userId: numericUid, displayName: "数字開始UID" });
  assert.equal(added.status, "changed");
  assert.equal(added.catalog.projects[0].members[0].userId, numericUid);
  const removed = removeProjectMember(added.catalog, "project_one", numericUid);
  assert.equal(removed.status, "changed");
  assert.deepEqual(removed.catalog.projects[0].members, []);
  for (const invalid of ["", "x".repeat(PROJECT_LIMITS.userIdLength + 1), "uid\ncontrol", "uid\u0085control"]) {
    assert.throws(() => addProjectMember(catalog, "project_one", { userId: invalid, displayName: "不正UID" }), /userId/);
    assert.throws(() => removeProjectMember(catalog, "project_one", invalid), /userId/);
  }
});

test("project and member operations are immutable, double add is explicit, and removal keeps project and site", () => {
  const empty = createProjectCatalog();
  const one = addProject(empty, project("project_one", "site_one", []));
  const first = addProjectMember(one, "project_one", memberA);
  assert.equal(first.status, "changed");
  const second = addProjectMember(first.catalog, "project_one", memberB);
  assert.equal(second.catalog.projects[0].members.length, 2);
  const duplicate = addProjectMember(second.catalog, "project_one", memberA);
  assert.deepEqual({ status: duplicate.status, reason: duplicate.reason }, { status: "unchanged", reason: "already-member" });
  const removed = removeProjectMember(second.catalog, "project_one", memberA.userId);
  assert.equal(removed.status, "changed");
  assert.equal(removed.catalog.projects.length, 1);
  assert.equal(removed.catalog.projects[0].site.id, "site_one");
  assert.deepEqual(removed.catalog.projects[0].members, [memberB]);
  const absent = removeProjectMember(removed.catalog, "project_one", memberA.userId);
  assert.deepEqual({ status: absent.status, reason: absent.reason }, { status: "unchanged", reason: "not-member" });
  assert.equal(one.projects[0].members.length, 0);
});

test("catalog store uses atomic opaque-version CAS and preserves the old snapshot on conflict", async () => {
  const old = parseProjectCatalogSnapshot({ catalog: fixture(), version: "opaque-v1" });
  const changed = removeProjectMember(old.catalog, "project_kamakura", memberB.userId);
  let captured;
  const conflictStore = {
    readCatalog: async () => old,
    compareAndSwapCatalog: async (request) => { captured = structuredClone(request); request.catalog.projects[0].members[0].displayName = "store mutation"; return { status: "conflict" }; }
  };
  assert.deepEqual(await readProjectCatalog(conflictStore, new AbortController().signal), old);
  const conflict = await commitProjectCatalog(conflictStore, old, changed.catalog, new AbortController().signal);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.snapshot.version, "opaque-v1");
  assert.equal(conflict.snapshot.catalog.projects[0].members[0].displayName, "青木さん");
  assert.equal(captured.expectedVersion, "opaque-v1");
  assert.equal(old.catalog.projects[0].members[0].displayName, "青木さん");
  let savedVersion = 1;
  const savedStore = { readCatalog: async () => old, compareAndSwapCatalog: async ({ catalog }) => ({ status: "saved", snapshot: { catalog, version: `opaque-v${++savedVersion}` } }) };
  const saved = await commitProjectCatalog(savedStore, old, changed.catalog, new AbortController().signal);
  assert.equal(saved.status, "saved");
  assert.equal(saved.snapshot.version, "opaque-v2");
  assert.throws(() => parseProjectCatalogSnapshot({ catalog: fixture(), version: "" }));
});

test("catalog commit rejects removed projects and replaced site mappings before calling the store", async () => {
  const old = parseProjectCatalogSnapshot({ catalog: fixture(), version: "opaque-v1" });
  let calls = 0;
  const store = { readCatalog: async () => old, compareAndSwapCatalog: async () => { calls++; return { status: "conflict" }; } };
  const missing = { projects: [old.catalog.projects[0]] };
  await assert.rejects(() => commitProjectCatalog(store, old, missing, new AbortController().signal), /existing project missing/);
  const replaced = structuredClone(old.catalog);
  replaced.projects[0].site.id = "site_replacement";
  await assert.rejects(() => commitProjectCatalog(store, old, replaced, new AbortController().signal), /existing project site changed/);
  assert.equal(calls, 0);
});

test("catalog commit accepts project and member additions but rejects a different successful write response", async () => {
  const old = parseProjectCatalogSnapshot({ catalog: fixture(), version: "opaque-v1" });
  const withProject = addProject(old.catalog, project("project_new", "site_new", []));
  let savedVersion = 1;
  const savedStore = { readCatalog: async () => old, compareAndSwapCatalog: async ({ catalog }) => ({ status: "saved", snapshot: { catalog, version: `opaque-v${++savedVersion}` } }) };
  const created = await commitProjectCatalog(savedStore, old, withProject, new AbortController().signal);
  assert.equal(created.status, "saved");
  const withMember = addProjectMember(created.snapshot.catalog, "project_new", { userId: "2firebase-user", displayName: "追加メンバー" });
  const memberSaved = await commitProjectCatalog(savedStore, created.snapshot, withMember.catalog, new AbortController().signal);
  assert.equal(memberSaved.status, "saved");

  for (const corrupt of [
    () => ({ projects: withProject.projects.filter((candidate) => candidate.id !== "project_shonan") }),
    () => ({ projects: withProject.projects.map((candidate) => candidate.id === "project_kamakura" ? { ...candidate, site: { ...candidate.site, id: "site_replacement" } } : candidate) }),
    () => ({ projects: withProject.projects.map((candidate) => candidate.id === "project_kamakura" ? { ...candidate, name: "要求外の変更" } : candidate) })
  ]) {
    const store = { readCatalog: async () => old, compareAndSwapCatalog: async () => ({ status: "saved", snapshot: { catalog: corrupt(), version: "opaque-v2" } }) };
    await assert.rejects(() => commitProjectCatalog(store, old, withProject, new AbortController().signal));
  }
});

test("catalog commit keeps independent comparison copies when the store mutates its request", async () => {
  const old = parseProjectCatalogSnapshot({ catalog: fixture(), version: "opaque-v1" });
  const changed = removeProjectMember(old.catalog, "project_kamakura", memberB.userId);
  const store = {
    readCatalog: async () => old,
    compareAndSwapCatalog: async (request) => {
      request.catalog.projects[0].name = "store mutation";
      return { status: "saved", snapshot: { catalog: request.catalog, version: "opaque-v2" } };
    }
  };
  await assert.rejects(() => commitProjectCatalog(store, old, changed.catalog, new AbortController().signal), /does not match submitted/);
  assert.equal(old.catalog.projects[0].name, "project_kamakura 計画");
  assert.equal(changed.catalog.projects[0].name, "project_kamakura 計画");
});
