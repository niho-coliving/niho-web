import type { EditorPage, EditorSite } from "../src/editor-types.js";

export const KAMAKURA_CATALOG_CONTRACT_ERROR_CODE = "upstream_contract_invalid" as const;
export const KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS = 502 as const;
export const KAMAKURA_EDITOR_SITE_ID = "kamakura" as const;
export const KAMAKURA_EDITOR_SITE_NAME = "鎌倉サイト（新サイト確認用）";
export const KAMAKURA_EDITOR_DOMAIN = "https://next-kamakura.niho.life";
export const KAMAKURA_COMMON_PAGE_ID = /^(?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59}$/u;

export type KamakuraLegacyPage = { readonly name: string; readonly path: string };
export type KamakuraCatalog = {
  readonly project: { readonly id: "kamakura-site"; readonly name: "NIHO kamakura"; readonly site: EditorSite };
  readonly sites: readonly EditorSite[];
  readonly pages: readonly EditorPage[];
  readonly legacy: readonly KamakuraLegacyPage[];
};

export class KamakuraCatalogContractError extends Error {
  readonly code = KAMAKURA_CATALOG_CONTRACT_ERROR_CODE;

  constructor() {
    super("Kamakura catalog does not match the supported contract");
    this.name = "KamakuraCatalogContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogText(value: unknown, maximum?: number): string {
  if (typeof value !== "string" || !value || (maximum !== undefined && value.length > maximum) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new KamakuraCatalogContractError();
  }
  return value;
}

function parseSite(value: unknown): EditorSite {
  if (!isRecord(value) || value.id !== KAMAKURA_EDITOR_SITE_ID || value.name !== KAMAKURA_EDITOR_SITE_NAME || !Array.isArray(value.domains) || value.domains.length !== 1 || value.domains[0] !== KAMAKURA_EDITOR_DOMAIN) {
    throw new KamakuraCatalogContractError();
  }
  return { id: KAMAKURA_EDITOR_SITE_ID, name: KAMAKURA_EDITOR_SITE_NAME, domains: [KAMAKURA_EDITOR_DOMAIN] };
}

/**
 * Validate and normalize the Kamakura catalog at both the Worker and browser
 * boundaries. Page titles are content, not identifiers; the Worker bounds the
 * complete upstream response to 2 MiB instead of imposing a UI-specific title
 * length that can drift from the producer's metadata.
 */
export function parseKamakuraCatalog(value: unknown): KamakuraCatalog {
  if (!isRecord(value) || !isRecord(value.project) || value.project.id !== "kamakura-site" || value.project.name !== "NIHO kamakura") {
    throw new KamakuraCatalogContractError();
  }

  const projectSite = parseSite(value.project.site);
  if (!Array.isArray(value.sites) || value.sites.length !== 1 || !Array.isArray(value.pages) || value.pages.length > 500 || !Array.isArray(value.legacy) || value.legacy.length > 5_000) {
    throw new KamakuraCatalogContractError();
  }

  const site = parseSite(value.sites[0]);
  const pages: EditorPage[] = value.pages.map((candidate): EditorPage => {
    if (!isRecord(candidate) || candidate.siteId !== KAMAKURA_EDITOR_SITE_ID || candidate.locale !== "ja" || typeof candidate.pageId !== "string" || !KAMAKURA_COMMON_PAGE_ID.test(candidate.pageId)) {
      throw new KamakuraCatalogContractError();
    }
    return { siteId: KAMAKURA_EDITOR_SITE_ID, pageId: candidate.pageId, locale: "ja", title: catalogText(candidate.title) };
  });
  if (new Set(pages.map(({ pageId }) => pageId)).size !== pages.length) throw new KamakuraCatalogContractError();

  const legacyPath = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u;
  const legacy: KamakuraLegacyPage[] = value.legacy.map((candidate): KamakuraLegacyPage => {
    if (!isRecord(candidate)) throw new KamakuraCatalogContractError();
    const name = catalogText(candidate.name, 200);
    const path = catalogText(candidate.path, 2_048);
    if (!legacyPath.test(path)) throw new KamakuraCatalogContractError();
    return { name, path };
  });
  if (new Set(legacy.map(({ name }) => name)).size !== legacy.length || new Set(legacy.map(({ path }) => path)).size !== legacy.length) {
    throw new KamakuraCatalogContractError();
  }

  return { project: { id: "kamakura-site", name: "NIHO kamakura", site: projectSite }, sites: [site], pages, legacy };
}
