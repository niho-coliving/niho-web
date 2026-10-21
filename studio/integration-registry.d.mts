export type TrustedIntegration = Readonly<{
  projectId: string;
  siteId: string;
  aliases: readonly string[];
  environments: Readonly<Record<string, Readonly<{ editorPathSuffix: string; apiPrefix: string }>>>;
}>;
export type ResolvedTrustedIntegration = Readonly<{
  registration: TrustedIntegration;
  environment: string;
  config: Readonly<{ editorPathSuffix: string; apiPrefix: string }>;
}>;
export type TrustedIntegrationRegistry = Readonly<{
  registrations: readonly TrustedIntegration[];
  resolve(projectId: string, siteId: string, environment?: string): ResolvedTrustedIntegration | null;
  resolveApi(projectId: string, siteId: string, action: string): ResolvedTrustedIntegration | null;
  resolvePage(pathname: string): ResolvedTrustedIntegration | null;
  editorPath(projectId: string, siteId: string, environment?: string): string | null;
}>;
export const TRUSTED_INTEGRATIONS: readonly TrustedIntegration[];
export function integrationIdentity(projectId: string, siteId: string): string;
export function createTrustedIntegrationRegistry(definitions: readonly TrustedIntegration[]): TrustedIntegrationRegistry;
export function resolveTrustedIntegration(projectId: string, siteId: string, environment?: string): ResolvedTrustedIntegration | null;
export function resolveTrustedEditorApi(projectId: string, siteId: string, action: string): ResolvedTrustedIntegration | null;
export function resolveTrustedEditorPage(pathname: string): ResolvedTrustedIntegration | null;
export function trustedEditorPath(projectId: string, siteId: string, environment?: string): string | null;
