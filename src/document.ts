import { mergeSiteStyles, parseSiteStyles, resolvePageStyles, type SiteStyles } from "./site-styles.js";
import type {
  BlockContract, BlockContracts, BlockSlot, ComponentLibrary, ComponentPropField, DesignToken, ElementAttributes, ElementTag, NodeStyle, PageDocument, PageImage, PageMeta, PageNode, PropRule, PublicPropValue, TextStyle
} from "./types.js";
import { COMPONENT_LIMITS, expandDocument, instancesOf } from "./component-expand.js";
import { isStyleProperty, parseStyle, parseTextStyles, parseTokens } from "./style-values.js";
import { DocumentValidationError, fail, identifier, isSafePublicLink, isSafePublicUrl, keys, line, localeCode, parseAssetReference, publicImageSrcSet, publicImageUrl, record, string } from "./validation-utils.js";

const tags = new Set("div section article header footer main nav aside h1 h2 h3 h4 h5 h6 p span a img picture source ul ol li dl dt dd strong em b i small blockquote figure figcaption br hr time details summary".split(" "));
const voidTags = new Set(["img", "source", "br", "hr"]);
const phrasing = new Set("span a img strong em b i small br time".split(" "));
const phrasingParents = new Set("p span h1 h2 h3 h4 h5 h6 a strong em b i small time summary".split(" "));
// 開閉（details / summary）は JS なしで動く。summary の中にリンクや入れ子の開閉は置けない。
const interactive = new Set(["a", "details", "summary"]);
const globalAttributes = ["id", "title", "lang", "dir", "role", "hidden", "tabIndex", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-current"];
const tagAttributes: Partial<Record<ElementTag, string[]>> = {
  a: ["href", "target", "rel", "hrefLang"], img: ["src", "srcSet", "alt", "width", "height", "loading", "decoding"],
  source: ["srcSet", "type", "media"], ol: ["start", "reversed"], li: ["value"], time: ["dateTime"], details: ["open"]
};
function attributes(value: unknown, tag: ElementTag, path: string, asset = false): ElementAttributes {
  const source = record(value, path), result: ElementAttributes = {};
  keys(source, [...globalAttributes, ...(tagAttributes[tag] ?? [])], path);
  for (const [name, value] of Object.entries(source)) {
    const at = `${path}.${name}`;
    if (name === "hidden" || name === "reversed" || name === "open") {
      if (typeof value !== "boolean") fail(at, "expected boolean");
    } else if (["width", "height", "start", "value", "tabIndex"].includes(name)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > 100000 ||
          (["width", "height"].includes(name) && value <= 0) || (name === "tabIndex" && ![-1, 0].includes(value))) fail(at, "invalid integer attribute");
    } else {
      const text = string(value, at, 2048);
      if (name === "href" && !isSafePublicLink(text)) fail(at, "unsafe URL");
      if (name === "src") publicImageUrl(text, at);
      if (name === "srcSet") publicImageSrcSet(text, at);
      if (name === "media" && !/^\((?:min|max)-width: [1-9]\d{1,3}px\)$/.test(text)) fail(at, "unsupported media condition");
      if (name === "type" && !["image/avif", "image/webp", "image/png", "image/jpeg"].includes(text)) fail(at, "unsupported image type");
      if (name === "id") identifier(text, at);
      if (["aria-labelledby", "aria-describedby"].includes(name) && !/^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z][A-Za-z0-9_-]*)*$/.test(text)) fail(at, "invalid ID references");
      if (name === "aria-hidden" && !["true", "false"].includes(text)) fail(at, "invalid aria-hidden");
      if (name === "aria-current" && !["page", "step", "location", "date", "time", "true", "false"].includes(text)) fail(at, "invalid aria-current");
      if (name === "target" && !["_blank", "_self"].includes(text)) fail(at, "unsupported target");
      if (name === "rel" && !/^(?:noopener|noreferrer|nofollow|sponsored|ugc)(?: (?:noopener|noreferrer|nofollow|sponsored|ugc))*$/.test(text)) fail(at, "unsupported rel");
      if (name === "dir" && !["ltr", "rtl", "auto"].includes(text)) fail(at, "invalid direction");
      if (name === "lang" && !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(text)) fail(at, "invalid language");
      if (name === "role" && !["banner", "navigation", "main", "contentinfo", "complementary", "region", "group", "list", "listitem", "img", "presentation", "none", "note"].includes(text)) fail(at, "unsupported role");
      if (name === "loading" && !["lazy", "eager"].includes(text)) fail(at, "invalid loading");
      if (name === "decoding" && !["async", "sync", "auto"].includes(text)) fail(at, "invalid decoding");
    }
    result[name] = value as string | number | boolean;
  }
  if (tag === "img" && asset && (Object.hasOwn(result, "src") || Object.hasOwn(result, "srcSet"))) fail(path, "img uses either URL sources or asset");
  if (tag === "img" && (!asset && typeof result.src !== "string" || typeof result.alt !== "string")) fail(path, asset ? "img requires alt" : "img requires src and alt");
  return result;
}

function prop(value: unknown, rule: PropRule, path: string): PublicPropValue {
  switch (rule.type) {
    case "string": return string(value, path, Math.min(rule.maxLength ?? 4096, 4096));
    case "url": {
      if (!isSafePublicUrl(value)) fail(path, "unsafe URL prop");
      return value;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < (rule.min ?? -Number.MAX_SAFE_INTEGER) || value > (rule.max ?? Number.MAX_SAFE_INTEGER)) fail(path, "invalid numeric prop");
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") fail(path, "expected boolean prop");
      return value;
    }
    case "enum": {
      if (typeof value !== "string" || !rule.values.includes(value)) fail(path, "invalid enum prop");
      return value;
    }
    default: return fail(path, "unsupported prop contract");
  }
}

export const metaLimits = { descriptionLength: 500, altLength: 300, structuredData: 16 } as const;
/** HTTPS か / から始まる同一サイト内のパス。#id は画像・アイコンに使えない。 */
function assetUrl(value: unknown, path: string): string {
  return publicImageUrl(value, path);
}
/** src（URL）か asset（素材参照）のどちらか一方を持つ。 */
export function parsePageImage(input: unknown, path: string): PageImage {
  const source = record(input, path);
  keys(source, ["src", "asset", "alt"], path);
  if ((source.src === undefined) === (source.asset === undefined)) fail(path, "image uses either src or asset");
  const alt = line(source.alt, `${path}.alt`, metaLimits.altLength, true);
  return source.asset === undefined ? { src: assetUrl(source.src, `${path}.src`), alt } : { asset: parseAssetReference(source.asset, `${path}.asset`), alt };
}
/** 公開メタ情報を検証して新しいオブジェクトを返す。false・空配列は保存しない。 */
export function parsePageMeta(input: unknown, path = "$.meta"): PageMeta {
  const source = record(input, path), result: PageMeta = {};
  keys(source, ["description", "ogImage", "favicon", "noindex", "structuredData"], path);
  if (source.description !== undefined) result.description = line(source.description, `${path}.description`, metaLimits.descriptionLength);
  if (source.ogImage !== undefined) result.ogImage = parsePageImage(source.ogImage, `${path}.ogImage`);
  if (source.favicon !== undefined) result.favicon = assetUrl(source.favicon, `${path}.favicon`);
  if (source.noindex !== undefined) {
    if (typeof source.noindex !== "boolean") fail(`${path}.noindex`, "expected boolean");
    if (source.noindex) result.noindex = true;
  }
  if (source.structuredData !== undefined) {
    const at = `${path}.structuredData`;
    if (!Array.isArray(source.structuredData) || source.structuredData.length > metaLimits.structuredData) fail(at, "expected an ID array within limits");
    const ids = Array.from(source.structuredData as unknown[], (id, index) => identifier(id, `${at}[${index}]`));
    if (new Set(ids).size !== ids.length) fail(at, "duplicate ID");
    if (ids.length) result.structuredData = ids;
  }
  return result;
}

/** @internal インスタンスの検証に使う部品の外形（外枠のタグと公開 props の field）。 */
export type ComponentShape = { readonly tag: ElementTag; readonly props: ReadonlyMap<string, ComponentPropField> };
/** @internal 文書の body と部品の root で共有する検証状態。ノード数と文字数は usage へ合算する。 */
export type NodeContext = {
  readonly blocks: BlockContracts;
  readonly tokens: Record<string, DesignToken>;
  /** インスタンスの style は部品ライブラリと文書の tokens を重ねて検証する。 */
  readonly instanceTokens: Record<string, DesignToken>;
  /** 文書の文字スタイル。部品の root では持たない。 */
  readonly textStyles?: Readonly<Record<string, TextStyle>>;
  readonly components: ReadonlyMap<string, ComponentShape> | undefined;
  readonly ids: Set<string>;
  readonly htmlIds: Set<string>;
  readonly usage: { nodes: number; text: number };
};
/** @internal */
export const reservedPropNames: readonly string[] = ["__proto__", "prototype", "constructor"];
/** @internal */
export const isElementTag = (value: unknown): value is ElementTag => typeof value === "string" && tags.has(value);
/** @internal */
export function componentShapes(library: ComponentLibrary): Map<string, ComponentShape> {
  return new Map(library.components.map((component): [string, ComponentShape] =>
    [component.id, { tag: component.root.tag, props: new Map(Object.entries(component.props ?? {}).map(([name, prop]) => [name, prop.field])) }]));
}
function instanceProps(value: unknown, shape: ComponentShape, path: string): { props?: Record<string, string> } {
  if (value === undefined) return {};
  const source = record(value, path), props: Record<string, string> = {};
  if (Object.keys(source).length > COMPONENT_LIMITS.instanceProps) fail(path, "too many instance props");
  for (const [name, raw] of Object.entries(source)) {
    identifier(name, path);
    if (reservedPropNames.includes(name)) fail(path, "reserved prop name");
    // 公開をやめた名前の値も保持するため、文字列としてだけ検証する。
    const field = shape.props.get(name), at = `${path}.${name}`;
    if (field === "href" || field === "src") {
      if (field === "href") {
        if (!isSafePublicLink(raw)) fail(at, "unsafe URL");
      } else if (!isSafePublicUrl(raw)) fail(at, "unsafe URL");
      props[name] = raw;
    } else props[name] = string(raw, at, field === "alt" ? 2048 : 4096);
  }
  return { props };
}
const nonBlank = (value: unknown) => typeof value === "string" && value.length <= 200 && !!value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
/** @internal registry は信頼できるコードだが、selector と UI に出す slot 宣言の形だけは確かめる。 */
export function blockSlots(contract: BlockContract, at: string): Readonly<Record<string, BlockSlot>> {
  const slots = contract.slots ?? {};
  for (const [name, slot] of Object.entries(slots)) {
    const textProp = slot.text === undefined || Object.hasOwn(contract.props, slot.text) && contract.props[slot.text]!.type === "string";
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name) || reservedPropNames.includes(name) || !nonBlank(slot.label) || !textProp ||
        slot.style !== undefined && (!Array.isArray(slot.style) || !slot.style.every(isStyleProperty)) ||
        slot.data !== undefined && (!nonBlank(slot.data.reason) || !nonBlank(slot.data.source))) fail(`${at}.block`, "invalid block slot contract");
  }
  return slots;
}
/** 宣言された領域に、その領域で許可されたプロパティだけを指定できる。 */
function slotStyles(value: unknown, contract: BlockContract, tokens: Record<string, DesignToken>, at: string): { slots?: Record<string, NodeStyle> } {
  const declared = blockSlots(contract, at);
  if (value === undefined) return {};
  const source = record(value, `${at}.slots`), slots: Record<string, NodeStyle> = {};
  for (const [name, raw] of Object.entries(source)) {
    const path = `${at}.slots.${name}`;
    if (!Object.hasOwn(declared, name)) fail(path, "unknown block slot");
    // 状態・登場・幅別の非表示・文字スタイルは領域では使えない。
    const style = parseStyle(raw, tokens, path, {}, false), allowed: readonly string[] = declared[name]!.style ?? [];
    for (const declarations of [style.base ?? {}, ...(style.responsive ?? []).map((entry) => entry.declarations)]) {
      if (Object.keys(declarations).some((property) => !allowed.includes(property))) fail(path, "style not allowed in this slot");
    }
    slots[name] = style;
  }
  return { slots };
}

/** @internal 文書の body と部品の root を同じ規則で検証し、新しいノードを返す。 */
export function parseNodes(input: unknown, path: string, context: NodeContext, depth = 0, parent?: string, insideLink = false, inline = false): PageNode[] {
  if (!Array.isArray(input)) fail(path, "expected node array");
  if (depth > 48 || input.length > 5000) fail(path, "document exceeds limits");
  return input.map((raw, index) => parseNode(raw, `${path}[${index}]`, context, depth, parent, insideLink, inline));
}
/** @internal depth はノードを含む配列の深さ。 */
export function parseNode(raw: unknown, at: string, context: NodeContext, depth = 0, parent?: string, insideLink = false, inline = false): PageNode {
  const node = record(raw, at), { blocks, tokens, ids, htmlIds, usage } = context;
  if (++usage.nodes > 5000) fail(at, "too many nodes");
  if (node.type === "text") {
    keys(node, ["type", "text"], at);
    const text = string(node.text, `${at}.text`, 100000);
    usage.text += text.length;
    if (usage.text > 1000000) fail(at, "too much text");
    if (["ul", "ol", "dl", "picture"].includes(parent ?? "") && text.trim()) fail(at, "text not allowed in this parent");
    return { type: "text", text };
  }
  if (node.type === "instance" && !context.components) fail(at, "component instance requires a component library");
  if (node.type !== "element" && node.type !== "component" && node.type !== "instance") fail(`${at}.type`, "unknown node type");
  keys(node, node.type === "element" ? ["type", "id", "tag", "asset", "attrs", "style", "children"] : node.type === "component" ? ["type", "id", "block", "props", "style", "slots"] : ["type", "id", "component", "props", "style"], at);
  const id = identifier(node.id, `${at}.id`);
  if (ids.has(id)) fail(`${at}.id`, "duplicate node ID");
  ids.add(id);
  const style = node.style === undefined ? {} : { style: parseStyle(node.style, node.type === "instance" ? context.instanceTokens : tokens, `${at}.style`, context.textStyles) };
  const constrainedParent = parent === "ul" || parent === "ol" ? ["li"] : parent === "dl" ? ["dt", "dd"] : parent === "picture" ? ["source", "img"] : undefined;
  if (node.type === "instance") {
    const component = identifier(node.component, `${at}.component`), shape = context.components?.get(component);
    if (!shape) fail(`${at}.component`, "unknown component");
    // 展開後の root と同じ入れ子規則。内側の規則は展開後の文書で検証する。
    if (inline && !phrasing.has(shape.tag) || constrainedParent && !constrainedParent.includes(shape.tag) || insideLink && interactive.has(shape.tag) || shape.tag === "summary" && parent !== "details") fail(at, "invalid HTML content nesting");
    return { type: "instance", id, component, ...instanceProps(node.props, shape, `${at}.props`), ...style };
  }
  if (node.type === "component") {
    if (inline || constrainedParent) fail(at, "component requires a flow content parent");
    const block = identifier(node.block, `${at}.block`);
    if (!Object.hasOwn(blocks, block)) fail(`${at}.block`, "unregistered block");
    const contract = blocks[block]!;
    const sourceProps = record(node.props, `${at}.props`), props: Record<string, PublicPropValue> = {};
    keys(sourceProps, Object.keys(contract.props), `${at}.props`);
    for (const [name, rule] of Object.entries(contract.props)) {
      if (["__proto__", "prototype", "constructor", "key", "ref", "children", "dangerouslySetInnerHTML"].includes(name) || /^on/i.test(name)) fail(`${at}.props`, "unsafe prop contract");
      if (!Object.hasOwn(sourceProps, name)) {
        if (rule.required) fail(`${at}.props.${name}`, "required prop missing");
      } else props[name] = prop(sourceProps[name], rule, `${at}.props.${name}`);
    }
    return { type: "component", id, block, props, ...style, ...slotStyles(node.slots, contract, tokens, at) };
  }
  if (!isElementTag(node.tag)) fail(`${at}.tag`, "unsupported element");
  const tag = node.tag;
  if (inline && !phrasing.has(tag) || constrainedParent && !constrainedParent.includes(tag) || insideLink && interactive.has(tag)) fail(at, "invalid HTML content nesting");
  if (tag === "summary" && parent !== "details") fail(at, "summary must be the first child of details");
  if (node.asset !== undefined && tag !== "img") fail(`${at}.asset`, "only img can reference an asset");
  const asset = node.asset === undefined ? {} : { asset: parseAssetReference(node.asset, `${at}.asset`) };
  const attrs = node.attrs === undefined ? {} : { attrs: attributes(node.attrs, tag, `${at}.attrs`, !!asset.asset) };
  const htmlId = attrs.attrs?.id;
  if (typeof htmlId === "string") {
    if (htmlIds.has(htmlId)) fail(`${at}.attrs.id`, "duplicate HTML ID");
    htmlIds.add(htmlId);
  }
  if (tag === "img" && !attrs.attrs) fail(at, "img requires attributes");
  const children = parseNodes(node.children, `${at}.children`, context, depth + 1, tag, insideLink || interactive.has(tag) && tag !== "details", inline || phrasingParents.has(tag));
  if (voidTags.has(tag) && children.length) fail(at, "void element cannot have children");
  if (tag === "details") {
    const summaries = children.flatMap((child, index) => (child.type === "element" ? child.tag : child.type === "instance" ? context.components!.get(child.component)!.tag : "") === "summary" ? [index] : []);
    if (summaries.length > 1 || summaries.length === 1 && summaries[0] !== 0) fail(`${at}.children`, "summary must be the first child of details");
  }
  if (tag === "picture") {
    const childTags = children.flatMap((child) => child.type === "element" ? [child.tag] : child.type === "instance" ? [context.components!.get(child.component)!.tag] : []);
    if (childTags[childTags.length - 1] !== "img" || childTags.filter((childTag) => childTag === "img").length !== 1) {
      fail(`${at}.children`, "picture requires source elements followed by one img");
    }
  }
  return { type: "element", id, tag, ...asset, ...attrs, ...style, children };
}

export type PageParseOptions = {
  /** parseComponentLibrary で検証済みの同じサイトのライブラリ。インスタンスを含む文書の検証に必須。 */
  components?: ComponentLibrary;
  /** 同じサイトの設定。継承値は返すページ JSON に混ぜない。 */
  siteStyles?: SiteStyles;
};
/**
 * 外部 JSON を検証し、未知フィールドを捨てずに拒否して新しい文書を返す。
 * インスタンスは展開せずに返すが、展開後の文書も検証し、その失敗は $.resolved 以下の位置で返す。
 */
export function parsePageDocument(input: unknown, blocks: BlockContracts = {}, options: PageParseOptions = {}): PageDocument {
  const source = record(input, "$"), library = options.components;
  keys(source, ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "textStyles", "body"], "$");
  if (source.schemaVersion !== 1) fail("$.schemaVersion", "unsupported schema version");
  const siteId = identifier(source.siteId, "$.siteId"), pageId = identifier(source.pageId, "$.pageId");
  if (library && library.siteId !== siteId) fail("$.siteId", "component library belongs to another site");
  const locale = localeCode(source.locale, "$.locale");
  if (typeof source.revision !== "number" || !Number.isSafeInteger(source.revision) || source.revision < 1) fail("$.revision", "expected positive safe integer");
  const title = string(source.title, "$.title", 300);
  if (!title.trim()) fail("$.title", "title is required");
  const meta = source.meta === undefined ? {} : parsePageMeta(source.meta, "$.meta");
  const tokens = parseTokens(source.tokens, "$.tokens");
  const effectiveTokens = { ...parseSiteStyles(options.siteStyles ?? {}).tokens, ...tokens };
  const textStyles = source.textStyles === undefined ? undefined : parseTextStyles(source.textStyles, effectiveTokens, "$.textStyles");
  const effective = mergeSiteStyles({ tokens, ...(textStyles ? { textStyles } : {}) }, options.siteStyles);
  const context: NodeContext = {
    blocks, ...effective, instanceTokens: library ? { ...library.tokens, ...effective.tokens } : effective.tokens, components: library && componentShapes(library),
    ids: new Set(), htmlIds: new Set(), usage: { nodes: 0, text: 0 }
  };
  const document: PageDocument = { schemaVersion: 1, siteId, pageId, locale, revision: source.revision, title, ...(Object.keys(meta).length ? { meta } : {}), tokens, ...(textStyles ? { textStyles } : {}), body: parseNodes(source.body, "$.body", context) };
  if (library && instancesOf(document.body).length) {
    try {
      parsePageDocument(expandDocument(resolvePageStyles(document, options.siteStyles), library).document, blocks, options.siteStyles ? { siteStyles: options.siteStyles } : {});
    } catch (error) {
      if (error instanceof DocumentValidationError) throw new DocumentValidationError(`$.resolved${error.path.slice(1)}`, error.reason);
      throw error;
    }
  }
  return document;
}
