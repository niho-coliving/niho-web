import { parsePageDocument } from "./document.js";
import { cssForDocument, pageScope } from "./css.js";
import { parseResolvedAssets, type ResolvedAssetMap } from "./assets.js";
import { parseStyle, parseTokens } from "./style-values.js";
import type { BlockContracts, PageDocument, SiteFontFace, SitePresentation, SitePresentationOverlay } from "./types.js";
import { fail, identifier, isSafePublicUrl, keys, line, localeCode, record } from "./validation-utils.js";

export const SITE_PRESENTATION_LIMITS = Object.freeze({ fonts: 512, sourcesPerFont: 4, versionLength: 256, unicodeRangeLength: 4096, overlays: 8, bindingsPerOverlay: 16, overlayLabelLength: 160 });
const unicodeRange = /^(?:U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)(?:\s*,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/iu;

function fontFace(input: unknown, path: string): SiteFontFace {
  const source = record(input, path);
  keys(source, ["family", "sources", "style", "weight", "display", "unicodeRange"], path);
  const family = line(source.family, `${path}.family`, 80);
  if (!/^[A-Za-z][A-Za-z0-9 -]*$/u.test(family)) fail(`${path}.family`, "invalid font family");
  if (!Array.isArray(source.sources) || !source.sources.length || source.sources.length > SITE_PRESENTATION_LIMITS.sourcesPerFont) fail(`${path}.sources`, "invalid font sources");
  const sources = source.sources.map((value, index) => {
    const at = `${path}.sources[${index}]`, item = record(value, at);
    keys(item, ["url", "format"], at);
    if (!isSafePublicUrl(item.url) || String(item.url).startsWith("#")) fail(`${at}.url`, "unsafe font URL");
    if (item.format !== "woff2" && item.format !== "woff") fail(`${at}.format`, "unsupported font format");
    return { url: item.url, format: item.format } as SiteFontFace["sources"][number];
  });
  if (source.style !== undefined && source.style !== "normal" && source.style !== "italic") fail(`${path}.style`, "unsupported font style");
  if (source.display !== undefined && !["auto", "block", "swap", "fallback", "optional"].includes(String(source.display))) fail(`${path}.display`, "unsupported font display");
  if (source.weight !== undefined && !(typeof source.weight === "number" && Number.isInteger(source.weight) && source.weight >= 1 && source.weight <= 1000 ||
      typeof source.weight === "string" && /^(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$/.test(source.weight))) fail(`${path}.weight`, "unsupported font weight");
  if (typeof source.weight === "string") {
    const [min, max = min] = source.weight.split(" ").map(Number);
    if (min! > max!) fail(`${path}.weight`, "font weight range must be ascending");
  }
  if (source.unicodeRange !== undefined && (typeof source.unicodeRange !== "string" || source.unicodeRange.length > SITE_PRESENTATION_LIMITS.unicodeRangeLength || !unicodeRange.test(source.unicodeRange))) fail(`${path}.unicodeRange`, "invalid unicode range");
  return { family, sources, ...(source.style === undefined ? {} : { style: source.style as "normal" | "italic" }), ...(source.weight === undefined ? {} : { weight: source.weight as string | number }),
    ...(source.display === undefined ? {} : { display: source.display as NonNullable<SiteFontFace["display"]> }), ...(source.unicodeRange === undefined ? {} : { unicodeRange: source.unicodeRange as string }) };
}

/** 外部 snapshot の presentation を対象ページへ固定して検証する。 */
export function parseSitePresentation(input: unknown, target: Pick<PageDocument, "siteId" | "locale">, blocks: BlockContracts = {}): SitePresentation {
  const source = record(input, "presentation");
  keys(source, ["schemaVersion", "siteId", "locale", "version", "reset", "tokens", "layout", "fonts", "shared", "overlays"], "presentation");
  if (source.schemaVersion !== 1) fail("presentation.schemaVersion", "unsupported schema version");
  const siteId = identifier(source.siteId, "presentation.siteId"), locale = localeCode(source.locale, "presentation.locale");
  if (siteId !== target.siteId || locale !== target.locale) fail("presentation", "target mismatch");
  const version = line(source.version, "presentation.version", SITE_PRESENTATION_LIMITS.versionLength);
  if (source.reset !== "neutral-v1") fail("presentation.reset", "unsupported reset");
  const tokens = parseTokens(source.tokens, "presentation.tokens");
  const layout = source.layout === undefined ? undefined : parseStyle(source.layout, tokens, "presentation.layout", {}, false);
  if (!Array.isArray(source.fonts) || source.fonts.length > SITE_PRESENTATION_LIMITS.fonts) fail("presentation.fonts", "too many fonts");
  const fonts = source.fonts.map((value, index) => fontFace(value, `presentation.fonts[${index}]`));
  const shared = record(source.shared, "presentation.shared");
  keys(shared, ["header", "footer"], "presentation.shared");
  const header = parsePageDocument(shared.header, blocks), footer = parsePageDocument(shared.footer, blocks);
  for (const [name, document] of [["header", header], ["footer", footer]] as const) {
    if (document.siteId !== siteId || document.locale !== locale) fail(`presentation.shared.${name}`, "target mismatch");
  }
  if (header.pageId === footer.pageId) fail("presentation.shared", "shared page IDs must be distinct");
  if (source.overlays !== undefined && (!Array.isArray(source.overlays) || source.overlays.length > SITE_PRESENTATION_LIMITS.overlays)) fail("presentation.overlays", "too many overlays");
  const documentIds = new Set([header.pageId, footer.pageId]), overlayIds = new Set<string>(), bindings = new Set<string>();
  const overlays = (source.overlays as unknown[] | undefined ?? []).map((value, index): SitePresentationOverlay => {
    const path = `presentation.overlays[${index}]`, overlay = record(value, path);
    keys(overlay, ["id", "label", "document", "triggerIds", "closeIds"], path);
    const id = identifier(overlay.id, `${path}.id`), label = line(overlay.label, `${path}.label`, SITE_PRESENTATION_LIMITS.overlayLabelLength);
    if (overlayIds.has(id) || bindings.has(id)) fail(`${path}.id`, "duplicate overlay ID or binding");
    overlayIds.add(id);
    const document = parsePageDocument(overlay.document, blocks);
    if (document.siteId !== siteId || document.locale !== locale) fail(`${path}.document`, "target mismatch");
    if (documentIds.has(document.pageId)) fail(`${path}.document.pageId`, "shared page IDs must be distinct");
    documentIds.add(document.pageId);
    const parseBindings = (input: unknown, name: "triggerIds" | "closeIds") => {
      const at = `${path}.${name}`;
      if (!Array.isArray(input) || !input.length || input.length > SITE_PRESENTATION_LIMITS.bindingsPerOverlay) fail(at, "invalid bindings");
      return input.map((binding, bindingIndex) => {
        const result = identifier(binding, `${at}[${bindingIndex}]`);
        if (overlayIds.has(result) || bindings.has(result)) fail(`${at}[${bindingIndex}]`, "duplicate binding");
        bindings.add(result);
        return result;
      });
    };
    const triggerIds = parseBindings(overlay.triggerIds, "triggerIds"), closeIds = parseBindings(overlay.closeIds, "closeIds");
    return { id, label, document, triggerIds, closeIds };
  });
  return { schemaVersion: 1, siteId, locale, version, reset: "neutral-v1", tokens, ...(layout ? { layout } : {}), fonts, shared: { header, footer }, ...(overlays.length ? { overlays } : {}) };
}

/** layout を既存の閉じた NodeStyle CSS generatorへ渡すための内部文書。 */
export function presentationLayoutDocument(presentation: SitePresentation): PageDocument {
  return { schemaVersion: 1, siteId: presentation.siteId, pageId: `presentation-${presentation.version.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "v"}`,
    locale: presentation.locale, revision: 1, title: "Site presentation", tokens: presentation.tokens,
    body: [{ type: "element", id: "layout", tag: "div", ...(presentation.layout ? { style: presentation.layout } : {}), children: [] }] };
}

const quote = (value: string) => JSON.stringify(value);
export function cssForSitePresentation(presentationInput: unknown, target: Pick<PageDocument, "siteId" | "locale">, blocks: BlockContracts = {}, assetInput: unknown = {}): { presentation: SitePresentation; css: string; scope: string } {
  const presentation = parseSitePresentation(presentationInput, target, blocks), assets: ResolvedAssetMap = parseResolvedAssets(assetInput);
  const layout = presentationLayoutDocument(presentation), scope = pageScope(layout), root = `[data-nw-presentation="${scope}"]`;
  const fonts = presentation.fonts.map((face) => `@font-face{font-family:${quote(face.family)};${face.style ? `font-style:${face.style};` : ""}${face.weight ? `font-weight:${face.weight};` : ""}${face.display ? `font-display:${face.display};` : ""}${face.unicodeRange ? `unicode-range:${face.unicodeRange};` : ""}src:${face.sources.map((item) => `url(${quote(item.url)}) format(${quote(item.format)})`).join(",")};}`).join("\n");
  const reset = `${root},${root} *{box-sizing:border-box}${root} :where(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,dd,figure,blockquote){margin:0;padding:0}${root} :where(ul,ol){list-style:none}${root} :where(a){color:inherit;text-decoration:none}${root} :where(img){max-width:100%}`;
  // Only composition wrappers disappear from layout. Authored boxes keep their own display values.
  const slots = `${root} :where([data-nw-presentation-header],[data-nw-presentation-body],[data-nw-presentation-footer],div[data-nw-scope]){display:contents}`;
  const overlays = `${root} [data-nw-overlay][hidden]{display:none!important}${root} [data-nw-overlay]{position:fixed;inset:0;z-index:2147482000;overflow:auto}${root} [data-nw-overlay-backdrop]{position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:#00000029;cursor:pointer}${root} [data-nw-overlay-content]{position:relative;z-index:1;height:100%;min-height:100%;pointer-events:none}${root} [data-nw-overlay-content] :where(a[href],button,details,summary,[tabindex="0"]){pointer-events:auto}`;
  return { presentation, scope, css: [fonts, reset, slots, overlays, cssForDocument(layout, assets)].filter(Boolean).join("\n") };
}

/** 素材解決用。本文・共有文書を1文書へ写すだけで、保存や描画には使わない。 */
export function presentationAssetDocument(document: PageDocument, presentation?: SitePresentation): PageDocument {
  if (!presentation) return document;
  return { ...document, body: [
    ...presentationLayoutDocument(presentation).body,
    ...document.body,
    ...(document.pageId === presentation.shared.header.pageId ? [] : presentation.shared.header.body),
    ...(document.pageId === presentation.shared.footer.pageId ? [] : presentation.shared.footer.body),
    ...(presentation.overlays ?? []).flatMap((overlay) => document.pageId === overlay.document.pageId ? [] : overlay.document.body),
  ] };
}
