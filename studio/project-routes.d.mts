export type ProjectAliasPage = "dashboard" | "editor";

export type ProjectAliasRoute = { readonly slug: string; readonly projectId: string; readonly siteId: string; readonly page: ProjectAliasPage };

export function parseProjectAliasPath(pathname: string): ProjectAliasRoute | null;
export function projectAliasPath(projectId: string, siteId: string, page: ProjectAliasPage): string | null;
export function projectRoutePath(currentPathname: string, projectId: string, siteId: string, page: ProjectAliasPage): string;
