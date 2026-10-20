import type {
  BlockContracts, ElementAttributes, ElementTag, PageDocument, PageImage, PageMeta, PageNode, PropRule, PublicPropValue
} from "./types.js";
import { parseStyle, parseTokens } from "./style-values.js";
import { fail, identifier, isSafePublicUrl, keys, line, localeCode, record, string } from "./validation-utils.js";

const tags = new Set("div section article header footer main nav aside h1 h2 h3 h4 h5 h6 p span a img picture source ul ol li dl dt dd strong em b i small blockquote figure figcaption br hr time".split(" "));
const voidTags = new Set(["img", "source", "br", "hr"]);
const phrasing = new Set("span a img strong em b i small br time".split(" "));
const phrasingParents = new Set("p span h1 h2 h3 h4 h5 h6 a strong em b i small time".split(" "));
const globalAttributes = ["id", "title", "lang", "dir", "role", "hidden", "tabIndex", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-current"];
const tagAttributes: Partial<Record<ElementTag, string[]>> = {
  a: ["href", "target", "rel", "hrefLang"], img: ["src", "alt", "width", "height", "loading", "decoding"],
  source: ["srcSet", "type", "media"], ol: ["start", "reversed"], li: ["value"], time: ["dateTime"]
};
function attributes(value: unknown, tag: ElementTag, path: string): ElementAttributes {
  const source = record(value, path), result: ElementAttributes = {};
  keys(source, [...globalAttributes, ...(tagAttributes[tag] ?? [])], path);
  for (const [name, value] of Object.entries(source)) {
    const at = `${path}.${name}`;
    if (name === "hidden" || name === "reversed") {
      if (typeof value !== "boolean") fail(at, "expected boolean");
    } else if (["width", "height", "start", "value", "tabIndex"].includes(name)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > 100000 ||
          (["width", "height"].includes(name) && value <= 0) || (name === "tabIndex" && ![-1, 0].includes(value))) fail(at, "invalid integer attribute");
    } else {
      const text = string(value, at, 2048);
      if (["href", "src"].includes(name) && !isSafePublicUrl(text)) fail(at, "unsafe URL");
      if (name === "srcSet") {
        // 一つの HTTPS / root relative URL のみ。候補文字列の独自パーサーは持たない。
        if (!isSafePublicUrl(text) || /[,\s]/.test(text)) fail(at, "srcSet supports one URL only");
      }
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
  if (tag === "img" && (typeof result.src !== "string" || typeof result.alt !== "string")) fail(path, "img requires src and alt");
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
  if (!isSafePublicUrl(value) || value.startsWith("#")) fail(path, "unsafe URL");
  return value;
}
export function parsePageImage(input: unknown, path: string): PageImage {
  const source = record(input, path);
  keys(source, ["src", "alt"], path);
  return { src: assetUrl(source.src, `${path}.src`), alt: line(source.alt, `${path}.alt`, metaLimits.altLength, true) };
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

/** 外部 JSON を検証し、未知フィールドを捨てずに拒否して新しい文書を返す。 */
export function parsePageDocument(input: unknown, blocks: BlockContracts = {}): PageDocument {
  const source = record(input, "$"), ids = new Set<string>(), htmlIds = new Set<string>();
  keys(source, ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "body"], "$");
  if (source.schemaVersion !== 1) fail("$.schemaVersion", "unsupported schema version");
  const siteId = identifier(source.siteId, "$.siteId"), pageId = identifier(source.pageId, "$.pageId");
  const locale = localeCode(source.locale, "$.locale");
  if (typeof source.revision !== "number" || !Number.isSafeInteger(source.revision) || source.revision < 1) fail("$.revision", "expected positive safe integer");
  const title = string(source.title, "$.title", 300);
  if (!title.trim()) fail("$.title", "title is required");
  const meta = source.meta === undefined ? {} : parsePageMeta(source.meta, "$.meta");
  const tokens = parseTokens(source.tokens, "$.tokens");
  let count = 0, totalText = 0;
  function nodes(input: unknown, path: string, depth: number, parent?: string, insideLink = false, inline = false): PageNode[] {
    if (!Array.isArray(input)) fail(path, "expected node array");
    if (depth > 48 || input.length > 5000) fail(path, "document exceeds limits");
    return input.map((raw, index) => {
      const at = `${path}[${index}]`, node = record(raw, at);
      if (++count > 5000) fail(at, "too many nodes");
      if (node.type === "text") {
        keys(node, ["type", "text"], at);
        const text = string(node.text, `${at}.text`, 100000);
        totalText += text.length;
        if (totalText > 1000000) fail(at, "too much text");
        if (["ul", "ol", "dl", "picture"].includes(parent ?? "") && text.trim()) fail(at, "text not allowed in this parent");
        return { type: "text", text };
      }
      if (node.type !== "element" && node.type !== "component") fail(`${at}.type`, "unknown node type");
      keys(node, node.type === "element" ? ["type", "id", "tag", "attrs", "style", "children"] : ["type", "id", "block", "props", "style"], at);
      const id = identifier(node.id, `${at}.id`);
      if (ids.has(id)) fail(`${at}.id`, "duplicate node ID");
      ids.add(id);
      const style = node.style === undefined ? {} : { style: parseStyle(node.style, tokens, `${at}.style`) };
      const constrainedParent = parent === "ul" || parent === "ol" ? ["li"] : parent === "dl" ? ["dt", "dd"] : parent === "picture" ? ["source", "img"] : undefined;
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
        return { type: "component", id, block, props, ...style };
      }
      if (typeof node.tag !== "string" || !tags.has(node.tag)) fail(`${at}.tag`, "unsupported element");
      const tag = node.tag as ElementTag;
      if (inline && !phrasing.has(tag) || constrainedParent && !constrainedParent.includes(tag) || insideLink && tag === "a") fail(at, "invalid HTML content nesting");
      const attrs = node.attrs === undefined ? {} : { attrs: attributes(node.attrs, tag, `${at}.attrs`) };
      const htmlId = attrs.attrs?.id;
      if (typeof htmlId === "string") {
        if (htmlIds.has(htmlId)) fail(`${at}.attrs.id`, "duplicate HTML ID");
        htmlIds.add(htmlId);
      }
      if (tag === "img" && !attrs.attrs) fail(at, "img requires attributes");
      const children = nodes(node.children, `${at}.children`, depth + 1, tag, insideLink || tag === "a", inline || phrasingParents.has(tag));
      if (voidTags.has(tag) && children.length) fail(at, "void element cannot have children");
      if (tag === "picture") {
        const childTags = children.flatMap((child) => child.type === "element" ? [child.tag] : []);
        if (childTags[childTags.length - 1] !== "img" || childTags.filter((childTag) => childTag === "img").length !== 1) {
          fail(`${at}.children`, "picture requires source elements followed by one img");
        }
      }
      return { type: "element", id, tag, ...attrs, ...style, children };
    });
  }
  return { schemaVersion: 1, siteId, pageId, locale, revision: source.revision, title, ...(Object.keys(meta).length ? { meta } : {}), tokens, body: nodes(source.body, "$.body", 0) };
}
