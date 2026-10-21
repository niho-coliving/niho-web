const PROJECT_ALIASES = Object.freeze([
  Object.freeze({ slug: "kamakura-site", projectId: "project-kamakura", siteId: "kamakura" }),
  Object.freeze({ slug: "niho-experience", projectId: "project-experience", siteId: "experience" })
]);

export function parseProjectAliasPath(pathname) {
  const match = /^\/projects\/([a-z][a-z0-9-]*)\/admin(?:\/(editor))?\/?$/u.exec(pathname);
  if (!match) return null;
  const project = PROJECT_ALIASES.find(({ slug }) => slug === match[1]);
  if (!project) return null;
  return { ...project, page: match[2] ? "editor" : "dashboard" };
}

export function projectAliasPath(projectId, siteId, page) {
  const project = PROJECT_ALIASES.find((candidate) => candidate.projectId === projectId && candidate.siteId === siteId);
  if (!project) return null;
  return `/projects/${project.slug}/admin${page === "editor" ? "/editor" : ""}`;
}

export function projectRoutePath(currentPathname, projectId, siteId, page) {
  const currentAlias = parseProjectAliasPath(currentPathname);
  const aliasPath = currentAlias?.projectId === projectId && currentAlias.siteId === siteId
    ? projectAliasPath(projectId, siteId, page)
    : null;
  if (aliasPath) return aliasPath;
  return `/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}${page === "editor" ? "/editor" : ""}`;
}
