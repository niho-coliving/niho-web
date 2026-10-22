import { blockSlots, parsePageDocument } from "./document.js";
import { cssForDocument, pageScope } from "./css.js";
import { parseResolvedAssets, type ResolvedAssetMap } from "./assets.js";
import { parseStyle, parseTokens } from "./style-values.js";
import type { BlockContracts, ComponentNode, ElementNode, PageDocument, PageNode, PublicPropValue, SiteFontFace, SitePresentation, SitePresentationCarousel, SitePresentationExternalFrame, SitePresentationHostView, SitePresentationOverlay } from "./types.js";
import { fail, identifier, isSafePublicUrl, keys, line, localeCode, record } from "./validation-utils.js";

export const SITE_PRESENTATION_LIMITS = Object.freeze({ fonts: 512, sourcesPerFont: 4, versionLength: 256, unicodeRangeLength: 4096, overlays: 8, bindingsPerOverlay: 16, overlayLabelLength: 160,
  hostViews: 64, hostViewBytes: 5_000_000, hostViewNodes: 20_000, framesPerView: 8, carouselSlides: 64, carouselControls: 16 });
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

function elements(document: PageDocument): Map<string, ElementNode> {
  const result = new Map<string, ElementNode>();
  const visit = (nodes: PageNode[]) => nodes.forEach((node) => {
    if (node.type === "component" || node.type === "instance") throw new Error("host view documents cannot contain components or instances");
    if (node.type === "element") { result.set(node.id, node); visit(node.children); }
  });
  visit(document.body);
  return result;
}

const propsKey = (block: string, props: Readonly<Record<string, PublicPropValue>>) => `${block}\n${JSON.stringify(Object.fromEntries(Object.entries(props).sort(([left], [right]) => left.localeCompare(right))))}`;

function normalizedBlockProps(block: string, input: unknown, siteId: string, locale: string, blocks: BlockContracts, path: string): Record<string, PublicPropValue> {
  const document = parsePageDocument({ schemaVersion: 1, siteId, pageId: "host-view-props", locale, revision: 1, title: "Host view props", tokens: {},
    body: [{ type: "component", id: "host-view-block", block, props: input }] }, blocks);
  const node = document.body[0] as ComponentNode;
  if (node.type !== "component") fail(path, "invalid host view props");
  return node.props;
}

function externalFrames(input: unknown, nodes: ReadonlyMap<string, ElementNode>, path: string): SitePresentationExternalFrame[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > SITE_PRESENTATION_LIMITS.framesPerView) fail(path, "too many external frames");
  const ids = new Set<string>();
  return input.map((raw, index) => {
    const at = `${path}[${index}]`, source = record(raw, at);
    keys(source, ["nodeId", "src", "title", "loading", "referrerPolicy", "allowFullScreen", "frameKey", "autoHeightMax"], at);
    const nodeId = identifier(source.nodeId, `${at}.nodeId`), node = nodes.get(nodeId);
    if (!node || node.tag !== "div" || node.children.length) fail(`${at}.nodeId`, "frame target must be an empty div");
    if (ids.has(nodeId)) fail(`${at}.nodeId`, "duplicate frame target");
    ids.add(nodeId);
    // Embed query strings may legitimately contain encoded spaces (for example a
    // Google Maps address). Keep the frame boundary HTTPS-only while rejecting
    // raw/encoded controls, markup delimiters, backslashes and credentials.
    const src = source.src;
    let frameUrl: URL | null = null, decoded = "";
    if (typeof src === "string" && src.length <= 2048 && !/[\s\u0000-\u001f\u007f\\<>"']/u.test(src)) {
      try { decoded = decodeURIComponent(src); frameUrl = new URL(src); } catch {}
    }
    if (typeof src !== "string" || !frameUrl || frameUrl.protocol !== "https:" || !frameUrl.hostname || frameUrl.username || frameUrl.password || /[\u0000-\u001f\u007f\\<>"']/u.test(decoded)) fail(`${at}.src`, "frame URL must be safe HTTPS");
    const title = line(source.title, `${at}.title`, 160);
    if (source.loading !== undefined && source.loading !== "lazy" && source.loading !== "eager") fail(`${at}.loading`, "invalid frame loading");
    if (source.referrerPolicy !== undefined && !["no-referrer", "no-referrer-when-downgrade", "strict-origin-when-cross-origin"].includes(String(source.referrerPolicy))) fail(`${at}.referrerPolicy`, "invalid referrer policy");
    if (source.allowFullScreen !== undefined && typeof source.allowFullScreen !== "boolean") fail(`${at}.allowFullScreen`, "invalid fullscreen flag");
    const frameKey = source.frameKey === undefined ? undefined : identifier(source.frameKey, `${at}.frameKey`);
    if (source.autoHeightMax !== undefined && (frameKey === undefined || typeof source.autoHeightMax !== "number" || !Number.isInteger(source.autoHeightMax) || source.autoHeightMax < 200 || source.autoHeightMax > 4000)) fail(`${at}.autoHeightMax`, "invalid auto height bound");
    return { nodeId, src, title,
      ...(source.loading === undefined ? {} : { loading: source.loading as "lazy" | "eager" }),
      ...(source.referrerPolicy === undefined ? {} : { referrerPolicy: source.referrerPolicy as NonNullable<SitePresentationExternalFrame["referrerPolicy"]> }),
      ...(source.allowFullScreen === undefined ? {} : { allowFullScreen: source.allowFullScreen }),
      ...(frameKey === undefined ? {} : { frameKey }),
      ...(source.autoHeightMax === undefined ? {} : { autoHeightMax: source.autoHeightMax }) };
  });
}

function slotBindings(input: unknown, block: string, blocks: BlockContracts, nodes: ReadonlyMap<string, ElementNode>, path: string): Record<string, string[]> {
  if (input === undefined) return {};
  const source = record(input, path), declared = blockSlots(blocks[block]!, path), result: Record<string, string[]> = {};
  keys(source, Object.keys(declared), path);
  const used = new Set<string>();
  for (const [name, raw] of Object.entries(source)) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 128) fail(`${path}.${name}`, "invalid slot bindings");
    const ids = raw.map((id, index) => identifier(id, `${path}.${name}[${index}]`));
    if (new Set(ids).size !== ids.length || ids.some((id) => !nodes.has(id) || used.has(id))) fail(`${path}.${name}`, "unknown or duplicate slot binding");
    ids.forEach((id) => used.add(id)); result[name] = ids;
  }
  return result;
}

function carousel(input: unknown, nodes: ReadonlyMap<string, ElementNode>, path: string): SitePresentationCarousel | undefined {
  if (input === undefined) return undefined;
  const source = record(input, path);
  keys(source, ["rootId", "slideIds", "previousIds", "nextIds", "playPauseIds", "autoplayMs", "fadeMs", "initiallyPlaying", "loop", "swipe"], path);
  const rootId = identifier(source.rootId, `${path}.rootId`);
  if (!nodes.has(rootId)) fail(`${path}.rootId`, "carousel root not found");
  const readIds = (value: unknown, name: "slideIds" | "previousIds" | "nextIds" | "playPauseIds", required: boolean, limit: number) => {
    const at = `${path}.${name}`;
    if (!Array.isArray(value) || required && value.length < 2 || value.length > limit) fail(at, "invalid carousel bindings");
    const ids = value.map((id, index) => identifier(id, `${at}[${index}]`));
    if (new Set(ids).size !== ids.length || ids.some((id) => !nodes.has(id))) fail(at, "unknown or duplicate carousel binding");
    return ids;
  };
  const slideIds = readIds(source.slideIds, "slideIds", true, SITE_PRESENTATION_LIMITS.carouselSlides);
  const previousIds = source.previousIds === undefined ? [] : readIds(source.previousIds, "previousIds", false, SITE_PRESENTATION_LIMITS.carouselControls);
  const nextIds = source.nextIds === undefined ? [] : readIds(source.nextIds, "nextIds", false, SITE_PRESENTATION_LIMITS.carouselControls);
  const playPauseIds = source.playPauseIds === undefined ? [] : readIds(source.playPauseIds, "playPauseIds", false, SITE_PRESENTATION_LIMITS.carouselControls);
  const all = [rootId, ...slideIds, ...previousIds, ...nextIds, ...playPauseIds];
  if (new Set(all).size !== all.length) fail(path, "carousel bindings overlap");
  if (source.autoplayMs !== undefined && (typeof source.autoplayMs !== "number" || !Number.isInteger(source.autoplayMs) || source.autoplayMs < 1000 || source.autoplayMs > 60000)) fail(`${path}.autoplayMs`, "invalid autoplay interval");
  if (source.fadeMs !== undefined && (typeof source.fadeMs !== "number" || !Number.isInteger(source.fadeMs) || source.fadeMs < 0 || source.fadeMs > 3000)) fail(`${path}.fadeMs`, "invalid fade duration");
  if (source.initiallyPlaying !== undefined && typeof source.initiallyPlaying !== "boolean" || source.loop !== undefined && typeof source.loop !== "boolean" || source.swipe !== undefined && typeof source.swipe !== "boolean") fail(path, "invalid carousel option");
  if (source.initiallyPlaying !== undefined && source.autoplayMs === undefined) fail(`${path}.initiallyPlaying`, "playing state requires an autoplay interval");
  return { rootId, slideIds, ...(previousIds.length ? { previousIds } : {}), ...(nextIds.length ? { nextIds } : {}), ...(playPauseIds.length ? { playPauseIds } : {}),
    ...(source.autoplayMs === undefined ? {} : { autoplayMs: source.autoplayMs }), ...(source.fadeMs === undefined ? {} : { fadeMs: source.fadeMs }), ...(source.initiallyPlaying === undefined ? {} : { initiallyPlaying: source.initiallyPlaying }),
    ...(source.loop === undefined ? {} : { loop: source.loop }), ...(source.swipe === undefined ? {} : { swipe: source.swipe }) };
}

/** 外部 snapshot の presentation を対象ページへ固定して検証する。 */
export function parseSitePresentation(input: unknown, target: Pick<PageDocument, "siteId" | "locale">, blocks: BlockContracts = {}): SitePresentation {
  const source = record(input, "presentation");
  keys(source, ["schemaVersion", "siteId", "locale", "version", "reset", "tokens", "layout", "fonts", "shared", "overlays", "hostViews"], "presentation");
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
  if (source.hostViews !== undefined && (!Array.isArray(source.hostViews) || source.hostViews.length > SITE_PRESENTATION_LIMITS.hostViews || JSON.stringify(source.hostViews).length > SITE_PRESENTATION_LIMITS.hostViewBytes)) fail("presentation.hostViews", "host views exceed limits");
  let hostViewNodes = 0;
  const viewIds = new Set<string>(), viewKeys = new Set<string>();
  const hostViews = (source.hostViews as unknown[] | undefined ?? []).map((raw, index): SitePresentationHostView => {
    const path = `presentation.hostViews[${index}]`, view = record(raw, path);
    keys(view, ["id", "block", "props", "document", "slotBindings", "externalFrames", "carousel"], path);
    const id = identifier(view.id, `${path}.id`), block = identifier(view.block, `${path}.block`);
    if (viewIds.has(id)) fail(`${path}.id`, "duplicate host view ID");
    viewIds.add(id);
    const props = normalizedBlockProps(block, view.props, siteId, locale, blocks, `${path}.props`), key = propsKey(block, props);
    if (viewKeys.has(key)) fail(`${path}.props`, "duplicate host view match");
    viewKeys.add(key);
    const document = parsePageDocument(view.document, {});
    if (document.siteId !== siteId || document.locale !== locale) fail(`${path}.document`, "target mismatch");
    if (documentIds.has(document.pageId)) fail(`${path}.document.pageId`, "presentation document IDs must be distinct");
    documentIds.add(document.pageId);
    let nodes: Map<string, ElementNode>;
    try { nodes = elements(document); } catch { return fail(`${path}.document`, "host view cannot contain components or instances"); }
    hostViewNodes += nodes.size;
    if (hostViewNodes > SITE_PRESENTATION_LIMITS.hostViewNodes) fail("presentation.hostViews", "too many host view nodes");
    const slots = slotBindings(view.slotBindings, block, blocks, nodes, `${path}.slotBindings`);
    const frames = externalFrames(view.externalFrames, nodes, `${path}.externalFrames`), binding = carousel(view.carousel, nodes, `${path}.carousel`);
    return { id, block, props, document, ...(Object.keys(slots).length ? { slotBindings: slots } : {}), ...(frames.length ? { externalFrames: frames } : {}), ...(binding ? { carousel: binding } : {}) };
  });
  return { schemaVersion: 1, siteId, locale, version, reset: "neutral-v1", tokens, ...(layout ? { layout } : {}), fonts, shared: { header, footer }, ...(overlays.length ? { overlays } : {}), ...(hostViews.length ? { hostViews } : {}) };
}

/** renderer用の安定した完全一致key。parseSitePresentationでprops検証後だけ使う。 */
export const sitePresentationHostViewKey = propsKey;

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
  const reset = `${root},${root} *{box-sizing:border-box}${root} :where(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,dd,figure,blockquote){margin:0;padding:0}${root} :where(ul,ol){list-style:none}${root} :where(a){color:inherit;text-decoration:none}${root} :where(img){max-width:100%}${root} details:not([open])>:not(summary){display:none!important}${root} summary{list-style:none}${root} summary::-webkit-details-marker{display:none}`;
  // Only composition wrappers disappear from layout. Authored boxes keep their own display values.
  const slots = `${root} :where([data-nw-presentation-header],[data-nw-presentation-body],[data-nw-presentation-footer],div[data-nw-scope]){display:contents}`;
  const overlays = `${root} [data-nw-overlay][hidden]{display:none!important}${root} [data-nw-overlay]{position:fixed;inset:0;z-index:2147482000;overflow:auto}${root} [data-nw-overlay-backdrop]{position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:#00000029;cursor:pointer}${root} [data-nw-overlay-content]{position:relative;z-index:1;height:100%;min-height:100%;pointer-events:none}${root} [data-nw-overlay-content] :where(a[href],button,details,summary,[tabindex="0"]){pointer-events:auto}`;
  const hostViews = `${root} [data-nw-host-view]>[data-nw-scope]{display:contents}${root} [data-nw-carousel-slide][hidden]{display:none!important}`;
  return { presentation, scope, css: [fonts, reset, slots, overlays, hostViews, cssForDocument(layout, assets)].filter(Boolean).join("\n") };
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
    ...(presentation.hostViews ?? []).flatMap((view) => view.document.body),
  ] };
}
