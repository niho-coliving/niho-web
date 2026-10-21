const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const aliasIdentifier = /^[a-z][a-z0-9-]*$/u;
const environmentIdentifier = /^[a-z][a-z0-9-]*$/u;
const suffixPattern = /^(?:\/[a-z][a-z0-9-]*)*$/u;
const apiPrefixPattern = /^\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u;

function pathMatchesPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function integrationIdentity(projectId, siteId) {
  return `${projectId}\u0000${siteId}`;
}

/** trusted code に直書きした定義だけから、HTML/APIの閉じた解決器を作る。外部入力から登録を追加する入口ではない。 */
export function createTrustedIntegrationRegistry(definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) throw new Error("trusted integration registry is empty");
  const identities = new Set(), aliases = new Set(), htmlPaths = new Set(), apiScopes = new Set();
  const registrations = definitions.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !identifier.test(raw.projectId) || !identifier.test(raw.siteId) || !Array.isArray(raw.aliases) || !raw.environments || typeof raw.environments !== "object" || Array.isArray(raw.environments)) throw new Error("invalid trusted integration registration");
    if (Object.keys(raw).some((key) => !["projectId", "siteId", "aliases", "environments"].includes(key))) throw new Error("unknown trusted integration metadata");
    const identity = integrationIdentity(raw.projectId, raw.siteId);
    if (identities.has(identity)) throw new Error("duplicate trusted integration identity");
    identities.add(identity);
    const frozenAliases = Object.freeze(raw.aliases.map((alias) => {
      if (!aliasIdentifier.test(alias) || aliases.has(alias)) throw new Error("duplicate or invalid trusted integration alias");
      aliases.add(alias);
      return alias;
    }));
    const environments = Object.fromEntries(Object.entries(raw.environments).map(([environment, config]) => {
      if (!environmentIdentifier.test(environment) || !config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !["editorPathSuffix", "apiPrefix"].includes(key)) || !suffixPattern.test(config.editorPathSuffix) || !apiPrefixPattern.test(config.apiPrefix)) throw new Error("invalid trusted integration environment");
      const htmlPath = `/projects/${raw.projectId}/sites/${raw.siteId}/editor${config.editorPathSuffix}`;
      const apiScope = `${identity}\u0000${config.apiPrefix}`;
      if (htmlPaths.has(htmlPath) || apiScopes.has(apiScope)) throw new Error("duplicate trusted integration route");
      htmlPaths.add(htmlPath);
      apiScopes.add(apiScope);
      return [environment, Object.freeze({ editorPathSuffix: config.editorPathSuffix, apiPrefix: config.apiPrefix })];
    }));
    if (Object.keys(environments).length === 0) throw new Error("trusted integration has no environment");
    return Object.freeze({ projectId: raw.projectId, siteId: raw.siteId, aliases: frozenAliases, environments: Object.freeze(environments) });
  });
  const frozen = Object.freeze(registrations);
  const byIdentity = new Map(frozen.map((entry) => [integrationIdentity(entry.projectId, entry.siteId), entry]));

  function resolve(projectId, siteId, environment = "production") {
    const registration = byIdentity.get(integrationIdentity(projectId, siteId));
    if (!registration || !Object.hasOwn(registration.environments, environment)) return null;
    return Object.freeze({ registration, environment, config: registration.environments[environment] });
  }
  function resolveApi(projectId, siteId, action) {
    const registration = byIdentity.get(integrationIdentity(projectId, siteId));
    if (!registration) return null;
    const match = Object.entries(registration.environments)
      .filter(([, config]) => pathMatchesPrefix(action, config.apiPrefix))
      .sort((left, right) => right[1].apiPrefix.length - left[1].apiPrefix.length)[0];
    return match ? Object.freeze({ registration, environment: match[0], config: match[1] }) : null;
  }
  function resolvePage(pathname) {
    for (const registration of frozen) {
      for (const [environment, config] of Object.entries(registration.environments)) {
        const canonical = `/projects/${registration.projectId}/sites/${registration.siteId}/editor${config.editorPathSuffix}`;
        if (pathname === canonical || pathname === `${canonical}/`) return Object.freeze({ registration, environment, config });
        for (const alias of registration.aliases) {
          const aliased = `/projects/${alias}/admin/editor${config.editorPathSuffix}`;
          if (pathname === aliased || pathname === `${aliased}/`) return Object.freeze({ registration, environment, config });
        }
      }
    }
    return null;
  }
  function editorPath(projectId, siteId, environment = "production") {
    const resolved = resolve(projectId, siteId, environment);
    return resolved ? `/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}/editor${resolved.config.editorPathSuffix}` : null;
  }
  return Object.freeze({ registrations: frozen, resolve, resolveApi, resolvePage, editorPath });
}

const registry = createTrustedIntegrationRegistry([
  {
    projectId: "project-kamakura",
    siteId: "kamakura",
    aliases: ["kamakura-site"],
    environments: { production: { editorPathSuffix: "", apiPrefix: "/editor" } }
  },
  {
    projectId: "project-experience",
    siteId: "experience",
    aliases: ["niho-experience"],
    environments: {
      production: { editorPathSuffix: "", apiPrefix: "/editor" },
      staging: { editorPathSuffix: "/staging", apiPrefix: "/editor-staging" }
    }
  }
]);

/** Studio が信頼する固定の project / site / alias / environment だけを公開する。 */
export const TRUSTED_INTEGRATIONS = registry.registrations;
export const resolveTrustedIntegration = registry.resolve;
export const resolveTrustedEditorApi = registry.resolveApi;
export const resolveTrustedEditorPage = registry.resolvePage;
export const trustedEditorPath = registry.editorPath;
