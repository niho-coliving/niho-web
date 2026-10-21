export type ProjectAliasPage = "dashboard" | "editor";

export type ProjectAliasRoute =
  | { readonly slug: "kamakura-site"; readonly projectId: "project-kamakura"; readonly siteId: "kamakura"; readonly page: ProjectAliasPage }
  | { readonly slug: "niho-experience"; readonly projectId: "project-experience"; readonly siteId: "experience"; readonly page: ProjectAliasPage };

export function parseProjectAliasPath(pathname: string): ProjectAliasRoute | null;
export function projectAliasPath(projectId: string, siteId: string, page: ProjectAliasPage): string | null;
export function projectRoutePath(currentPathname: string, projectId: string, siteId: string, page: ProjectAliasPage): string;
