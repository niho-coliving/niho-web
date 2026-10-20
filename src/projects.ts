import { fail, identifier, isSafeHttpsOrigin, keys, record } from "./validation-utils.js";

export const PROJECT_LIMITS = Object.freeze({
  projects: 100,
  membersPerProject: 500,
  domainsPerSite: 20,
  nameLength: 120,
  versionLength: 200,
  userIdLength: 128,
  memberIdentifierLength: 320
});

export type ProjectMember = {
  /** ホストの不変なユーザーID。メールアドレス等の入力識別子は保存しない。 */
  readonly userId: string;
  readonly displayName: string;
};

/** EditorSite と構造互換だが、pure入口からReact/editor型を参照しない。 */
export type ProjectSite = {
  readonly id: string;
  readonly name: string;
  readonly domains: readonly string[];
};

export type Project = {
  readonly id: string;
  readonly name: string;
  /** 1プロジェクトに唯一のサイト。後から差し替える操作は提供しない。 */
  readonly site: ProjectSite;
  readonly members: readonly ProjectMember[];
};

export type ProjectCatalog = { readonly projects: readonly Project[] };
export type ProjectCatalogSnapshot = { readonly catalog: ProjectCatalog; readonly version: string };
export type ProjectMemberChange =
  | { readonly status: "changed"; readonly catalog: ProjectCatalog }
  | { readonly status: "unchanged"; readonly reason: "already-member" | "not-member"; readonly catalog: ProjectCatalog };

export type ProjectCatalogStoreWriteResult =
  | { readonly status: "saved"; readonly snapshot: unknown }
  | { readonly status: "conflict" };

/** 永続化はホストが実装する。compareAndSwap は expectedVersion の比較と書込みを原子的に行う。 */
export interface ProjectCatalogStore {
  readCatalog(signal: AbortSignal): Promise<unknown>;
  compareAndSwapCatalog(request: { catalog: ProjectCatalog; expectedVersion: string }, signal: AbortSignal): Promise<ProjectCatalogStoreWriteResult>;
}

export type ProjectCatalogCommitResult =
  | { readonly status: "saved"; readonly snapshot: ProjectCatalogSnapshot }
  | { readonly status: "conflict"; readonly snapshot: ProjectCatalogSnapshot };

function boundedString(value: unknown, path: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0) || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(path, "invalid string");
  }
  return value;
}

function boundedArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, "invalid array");
  return value;
}

function opaqueUserId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > PROJECT_LIMITS.userIdLength || /\p{Cc}/u.test(value)) {
    fail(path, "invalid userId");
  }
  return value;
}

export function parseProjectMember(input: unknown, path = "member"): ProjectMember {
  const value = record(input, path);
  keys(value, ["userId", "displayName"], path);
  return {
    userId: opaqueUserId(value.userId, `${path}.userId`),
    displayName: boundedString(value.displayName, `${path}.displayName`, PROJECT_LIMITS.nameLength)
  };
}

export function parseProjectSite(input: unknown, path = "site"): ProjectSite {
  const value = record(input, path);
  keys(value, ["id", "name", "domains"], path);
  const domains = boundedArray(value.domains, `${path}.domains`, PROJECT_LIMITS.domainsPerSite).map((domain, index) => {
    if (!isSafeHttpsOrigin(domain)) fail(`${path}.domains[${index}]`, "expected an HTTPS origin");
    return domain;
  });
  if (new Set(domains).size !== domains.length) fail(`${path}.domains`, "duplicate origin");
  return {
    id: identifier(value.id, `${path}.id`),
    name: boundedString(value.name, `${path}.name`, PROJECT_LIMITS.nameLength),
    domains
  };
}

export function parseProject(input: unknown, path = "project"): Project {
  const value = record(input, path);
  keys(value, ["id", "name", "site", "members"], path);
  const members = boundedArray(value.members, `${path}.members`, PROJECT_LIMITS.membersPerProject).map((member, index) => parseProjectMember(member, `${path}.members[${index}]`));
  const userIds = members.map((member) => member.userId);
  if (new Set(userIds).size !== userIds.length) fail(`${path}.members`, "duplicate userId");
  return {
    id: identifier(value.id, `${path}.id`),
    name: boundedString(value.name, `${path}.name`, PROJECT_LIMITS.nameLength),
    site: parseProjectSite(value.site, `${path}.site`),
    members
  };
}

export function parseProjectCatalog(input: unknown): ProjectCatalog {
  const value = record(input, "catalog");
  keys(value, ["projects"], "catalog");
  const projects = boundedArray(value.projects, "catalog.projects", PROJECT_LIMITS.projects).map((project, index) => parseProject(project, `catalog.projects[${index}]`));
  const projectIds = projects.map((project) => project.id);
  const siteIds = projects.map((project) => project.site.id);
  if (new Set(projectIds).size !== projectIds.length) fail("catalog.projects", "duplicate project id");
  if (new Set(siteIds).size !== siteIds.length) fail("catalog.projects", "duplicate site id");
  return { projects };
}

export function parseProjectCatalogSnapshot(input: unknown): ProjectCatalogSnapshot {
  const value = record(input, "snapshot");
  keys(value, ["catalog", "version"], "snapshot");
  return {
    catalog: parseProjectCatalog(value.catalog),
    version: boundedString(value.version, "snapshot.version", PROJECT_LIMITS.versionLength)
  };
}

export function createProjectCatalog(projects: readonly unknown[] = []): ProjectCatalog {
  return parseProjectCatalog({ projects });
}

/** 既存Projectを保持し、ProjectとSiteの結び付きを変更していないことを検証する。 */
export function assertExistingProjectSiteMappings(previousInput: ProjectCatalog, nextInput: ProjectCatalog): void {
  const previous = parseProjectCatalog(previousInput);
  const next = parseProjectCatalog(nextInput);
  for (const project of previous.projects) {
    const candidate = next.projects.find((value) => value.id === project.id);
    if (!candidate) fail("catalog.projects", `existing project missing: ${project.id}`);
    if (candidate.site.id !== project.site.id) fail("catalog.projects", `existing project site changed: ${project.id}`);
  }
}

function sameProjectCatalog(left: ProjectCatalog, right: ProjectCatalog): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Project と唯一の Site を同じ操作で追加する。重複IDは検証で拒否する。 */
export function addProject(catalog: ProjectCatalog, project: unknown): ProjectCatalog {
  const current = parseProjectCatalog(catalog);
  const added = parseProject(project);
  return parseProjectCatalog({ projects: [...current.projects, added] });
}

/** 二重追加は成功扱いで書き換えず、already-member を返す。 */
export function addProjectMember(catalog: ProjectCatalog, projectId: string, member: unknown): ProjectMemberChange {
  const current = parseProjectCatalog(catalog);
  const checkedProjectId = identifier(projectId, "projectId");
  const checkedMember = parseProjectMember(member);
  const target = current.projects.find((project) => project.id === checkedProjectId);
  if (!target) fail("projectId", "unknown project");
  if (target.members.some((candidate) => candidate.userId === checkedMember.userId)) return { status: "unchanged", reason: "already-member", catalog: current };
  return {
    status: "changed",
    catalog: parseProjectCatalog({ projects: current.projects.map((project) => project.id === checkedProjectId ? { ...project, members: [...project.members, checkedMember] } : project) })
  };
}

/** 未参加者の解除は書き換えず、not-member を返す。Project / Site は常に保持する。 */
export function removeProjectMember(catalog: ProjectCatalog, projectId: string, userId: string): ProjectMemberChange {
  const current = parseProjectCatalog(catalog);
  const checkedProjectId = identifier(projectId, "projectId");
  const checkedUserId = opaqueUserId(userId, "userId");
  const target = current.projects.find((project) => project.id === checkedProjectId);
  if (!target) fail("projectId", "unknown project");
  if (!target.members.some((member) => member.userId === checkedUserId)) return { status: "unchanged", reason: "not-member", catalog: current };
  return {
    status: "changed",
    catalog: parseProjectCatalog({ projects: current.projects.map((project) => project.id === checkedProjectId ? { ...project, members: project.members.filter((member) => member.userId !== checkedUserId) } : project) })
  };
}

/** 競合時は入力 snapshot（catalog と旧 version）をそのまま検証済みコピーとして返す。 */
export async function commitProjectCatalog(
  store: ProjectCatalogStore,
  snapshotInput: ProjectCatalogSnapshot,
  catalogInput: ProjectCatalog,
  signal: AbortSignal
): Promise<ProjectCatalogCommitResult> {
  const snapshot = parseProjectCatalogSnapshot(snapshotInput);
  const submitted = parseProjectCatalog(catalogInput);
  assertExistingProjectSiteMappings(snapshot.catalog, submitted);
  // Storeが引数をmutateしても、応答照合とconflict返却の基準を汚染しないよう別copyを渡す。
  const catalogForStore = parseProjectCatalog(submitted);
  const result = await store.compareAndSwapCatalog({ catalog: catalogForStore, expectedVersion: snapshot.version }, signal);
  if (result.status === "conflict") return { status: "conflict", snapshot };
  const saved = parseProjectCatalogSnapshot(result.snapshot);
  if (saved.version === snapshot.version) fail("snapshot.version", "version must advance");
  assertExistingProjectSiteMappings(snapshot.catalog, saved.catalog);
  if (!sameProjectCatalog(submitted, saved.catalog)) fail("snapshot.catalog", "saved catalog does not match submitted catalog");
  return { status: "saved", snapshot: saved };
}

export async function readProjectCatalog(store: ProjectCatalogStore, signal: AbortSignal): Promise<ProjectCatalogSnapshot> {
  return parseProjectCatalogSnapshot(await store.readCatalog(signal));
}
