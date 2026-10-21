import { parseSiteStyles, type SiteStyles } from "./site-styles.js";
import { metaLimits, parsePageMeta } from "./document.js";
import type { ElementNode, PageDocument, PageImage, PageMeta, PageNode } from "./types.js";
import { fail, isSafeHttpsOrigin, isSafePublicUrl, keys, line, localeCode, record, string } from "./validation-utils.js";

export type { PageImage, PageMeta } from "./types.js";
export type PageKind = "page" | "template" | "shared";
export type PageVisibility = "public" | "private";
/** EditorPage と構造互換。React/editor 型を参照しない。 */
export type SitePage = {
  siteId: string;
  pageId: string;
  locale: string;
  /** ページ一覧に出す名前。検索結果の title は文書の title。 */
  title: string;
  /** `/` か `/a/b`。テンプレートは `/experiences/[slug]`。 */
  path?: string;
  kind?: PageKind;
  visibility?: PageVisibility;
  /** false は一度も公開していないページ。 */
  published?: boolean;
};
export type SiteSettings = SiteStyles & {
  title: string;
  description?: string;
  ogImage?: PageImage;
  favicon?: string;
  locale: string;
  noindex?: boolean;
};
export type PageMetadata = {
  title: string;
  description?: string;
  locale: string;
  robots: "index, follow" | "noindex, nofollow";
  canonical?: string;
  openGraph: {
    type: "website";
    title: string;
    description?: string;
    url?: string;
    siteName?: string;
    /** Open Graph の形式（ja-JP は ja_JP）。 */
    locale: string;
    image?: { url: string; alt: string };
  };
  icon?: string;
  structuredData: string[];
};
export type PageTreeNode =
  | { type: "page"; page: SitePage; depth: number }
  | { type: "folder"; path: string; name: string; depth: number; children: PageTreeNode[] };

export const PAGE_LIMITS = Object.freeze({
  pathLength: 160,
  pathDepth: 8,
  descriptionLength: metaLimits.descriptionLength,
  altLength: metaLimits.altLength,
  siteTitleLength: 120,
  structuredData: metaLimits.structuredData
});
export const PREVIEW_RESPONSE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });

const segment = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, dynamicSegment = /^\[[a-z][a-zA-Z0-9_]*\]$/;
const segmentsOf = (path: string): string[] => path === "/" ? [] : path.slice(1).split("/");

/** 通常ページのパスの問題を日本語で返す。正しければ null。 */
export function validatePagePath(path: unknown): string | null {
  if (typeof path !== "string" || !path) return "URL パスを入力してください。";
  if (path.length > PAGE_LIMITS.pathLength) return `URL パスは${PAGE_LIMITS.pathLength}文字以内にしてください。`;
  if (!path.startsWith("/")) return "URL パスは / から始めてください。";
  if (path === "/") return null;
  if (/[?#]/.test(path)) return "URL パスに ? や # は使えません。";
  if (path.endsWith("/")) return "URL パスの末尾に / は付けられません。";
  if (path.includes("//")) return "/ を続けて使えません。";
  const parts = segmentsOf(path);
  if (parts.length > PAGE_LIMITS.pathDepth) return `URL パスは${PAGE_LIMITS.pathDepth}階層までにしてください。`;
  if (parts.some((part) => dynamicSegment.test(part))) return "[ ] の動的パスはテンプレートだけで使えます。";
  if (parts.some((part) => !segment.test(part))) return "半角英小文字・数字と、区切りの - か _ だけを使えます。";
  return null;
}
/** `[name]` の動的セグメントを含むテンプレートのパスか。 */
export function isTemplatePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > PAGE_LIMITS.pathLength || !path.startsWith("/") || path === "/") return false;
  const parts = segmentsOf(path);
  return parts.length <= PAGE_LIMITS.pathDepth && parts.some((part) => dynamicSegment.test(part)) && parts.every((part) => dynamicSegment.test(part) || segment.test(part));
}
/** 動的セグメントは任意の1セグメントに一致する。 */
export function matchesTemplatePath(template: string, path: string): boolean {
  if (!isTemplatePath(template) || typeof path !== "string" || !path.startsWith("/")) return false;
  const pattern = segmentsOf(template), parts = segmentsOf(path);
  return pattern.length === parts.length && pattern.every((part, index) => dynamicSegment.test(part) ? !!parts[index] : part === parts[index]);
}
/** 同じサイト・locale で同じパスのページか、動的パスが一致するテンプレートを返す。 */
export function findPathConflict<T extends SitePage>(pages: readonly T[], request: { siteId: string; locale: string; path: string; exceptPageId?: string | undefined }): T | undefined {
  return pages.find((page) => page.siteId === request.siteId && page.locale === request.locale && page.pageId !== request.exceptPageId && typeof page.path === "string" &&
    (page.path === request.path || page.kind === "template" && matchesTemplatePath(page.path, request.path)));
}

/** ホームを先頭に、パスの親ごとのフォルダへ入れる。検索語があれば一致したページだけを平らに返す。 */
export function buildPageTree(pages: readonly SitePage[], query?: string): PageTreeNode[] {
  const needle = query?.trim().toLowerCase();
  if (needle) return pages.filter((page) => [page.title, page.path ?? "", page.pageId].some((value) => String(value).toLowerCase().includes(needle)))
    .map((page) => ({ type: "page", page, depth: 0 }));
  const root: PageTreeNode[] = [], folders = new Map<string, PageTreeNode[]>();
  for (const page of [...pages.filter((page) => page.path === "/"), ...pages.filter((page) => page.path !== "/")]) {
    const parts = typeof page.path === "string" ? page.path.split("/").filter(Boolean) : [];
    let children = root;
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const path = `/${parts.slice(0, depth + 1).join("/")}`;
      let next = folders.get(path);
      if (!next) { next = []; folders.set(path, next); children.push({ type: "folder", path, name: parts[depth]!, depth, children: next }); }
      children = next;
    }
    children.push({ type: "page", page, depth: Math.max(parts.length - 1, 0) });
  }
  return root;
}
export function pageUrl(domain: string, path: string): string {
  return `${domain}${path}`;
}

const trimSlash = (path: string): string => path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
/** @internal 同じサイトを指すリンクのパスと、残りの query / fragment。 */
export function linkTarget(href: string, domains: readonly string[]): { path: string; rest: string } | undefined {
  if (href.startsWith("/")) {
    if (href.startsWith("//")) return undefined;
    const index = href.search(/[?#]/);
    return { path: trimSlash(index < 0 ? href : href.slice(0, index)), rest: index < 0 ? "" : href.slice(index) };
  }
  if (!/^https:\/\//i.test(href)) return undefined;
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  return domains.includes(url.origin) ? { path: trimSlash(url.pathname), rest: url.search + url.hash } : undefined;
}
function eachLink(nodes: readonly PageNode[], visit: (node: ElementNode, target: { path: string; rest: string }) => void, domains: readonly string[]): void {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    const href = node.attrs?.href;
    if (node.tag === "a" && typeof href === "string") { const target = linkTarget(href, domains); if (target) visit(node, target); }
    eachLink(node.children, visit, domains);
  }
}
/** path を指す a 要素のノード ID。#id だけのリンクと他サイトは対象外。 */
export function findInternalLinks(document: Pick<PageDocument, "body">, path: string, domains: readonly string[]): string[] {
  const ids: string[] = [], wanted = trimSlash(path);
  eachLink(document.body, (node, target) => { if (target.path === wanted) ids.push(node.id); }, domains);
  return ids;
}
/** from を指すリンクを to へ置き換えた新しい文書。revision は変えない。 */
export function rewriteInternalLinks<T extends Pick<PageDocument, "body">>(document: T, from: string, to: string, domains: readonly string[]): T {
  if (validatePagePath(to) !== null) fail("$.to", "invalid page path");
  const copy = structuredClone(document), wanted = trimSlash(from);
  eachLink(copy.body, (node, target) => {
    if (target.path !== wanted || !node.attrs) return;
    // query・fragment を残すと長さの上限を超えることがあるため、保存できない文書を返さない。
    const href = `${to}${target.rest}`;
    if (!isSafePublicUrl(href)) fail(`$.body.${node.id}.attrs.href`, "rewritten link is not a safe URL");
    node.attrs.href = href;
  }, domains);
  return copy;
}

/** サイト共通の設定を検証し、未知の項目を拒否して新しいオブジェクトを返す。 */
export function parseSiteSettings(input: unknown): SiteSettings {
  const source = record(input, "$.site");
  keys(source, ["title", "description", "ogImage", "favicon", "locale", "noindex", "tokens", "textStyles"], "$.site");
  const title = line(source.title, "$.site.title", PAGE_LIMITS.siteTitleLength), locale = localeCode(source.locale, "$.site.locale");
  const shared = Object.fromEntries(["description", "ogImage", "favicon", "noindex"].flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
  const meta = parsePageMeta(shared, "$.site");
  return {
    title,
    ...parseSiteStyles(source as SiteStyles),
    ...(meta.description === undefined ? {} : { description: meta.description }),
    ...(meta.ogImage ? { ogImage: meta.ogImage } : {}),
    ...(meta.favicon === undefined ? {} : { favicon: meta.favicon }),
    locale,
    ...(meta.noindex ? { noindex: true } : {})
  };
}

const ogLocale = (locale: string): string => locale.replace(/^([a-z]{2,3})-([A-Za-z]{2})$/, (_, language: string, region: string) => `${language}_${region.toUpperCase()}`);
/** ページの値が無い項目はサイト設定で補い、プレビュー・非公開・noindex では canonical を出さない。 */
export function resolvePageMetadata(input: {
  document: Pick<PageDocument, "title" | "locale" | "meta">;
  site?: SiteSettings | undefined;
  domain?: string | undefined;
  path?: string | undefined;
  visibility?: PageVisibility | undefined;
  preview?: boolean | undefined;
}): PageMetadata {
  const source = record(input, "$"), document = record(source.document, "$.document");
  const title = string(document.title, "$.document.title", 300);
  if (!title.trim()) fail("$.document.title", "title is required");
  const locale = localeCode(document.locale, "$.document.locale");
  const meta = document.meta === undefined ? {} : parsePageMeta(document.meta, "$.document.meta");
  const site = source.site === undefined ? undefined : parseSiteSettings(source.site);
  const { domain, path, visibility, preview } = source;
  if (domain !== undefined && !isSafeHttpsOrigin(domain)) fail("$.domain", "invalid origin");
  if (path !== undefined && validatePagePath(path) !== null) fail("$.path", "invalid page path");
  if (visibility !== undefined && visibility !== "public" && visibility !== "private") fail("$.visibility", "invalid visibility");
  if (preview !== undefined && typeof preview !== "boolean") fail("$.preview", "expected boolean");
  const description = meta.description ?? site?.description, image = meta.ogImage ?? site?.ogImage, icon = meta.favicon ?? site?.favicon;
  const noindex = preview === true || visibility === "private" || !!meta.noindex || !!site?.noindex;
  const url = typeof domain === "string" && typeof path === "string" ? pageUrl(domain, path) : undefined;
  const absolute = (value: string) => typeof domain === "string" && value.startsWith("/") ? `${domain}${value}` : value;
  return {
    title,
    ...(description === undefined ? {} : { description }),
    locale,
    robots: noindex ? "noindex, nofollow" : "index, follow",
    ...(url && !noindex ? { canonical: url } : {}),
    openGraph: {
      type: "website", title,
      ...(description === undefined ? {} : { description }),
      ...(url ? { url } : {}),
      ...(site ? { siteName: site.title } : {}),
      locale: ogLocale(locale),
      ...(image ? { image: { url: absolute(image.src), alt: image.alt } } : {})
    },
    ...(icon === undefined ? {} : { icon: absolute(icon) }),
    structuredData: [...(meta.structuredData ?? [])]
  };
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => entities[char]!);
/** title・meta・link だけの HTML。すべての値を escape し、JSON-LD は含めない。 */
export function renderPageHead(metadata: PageMetadata): string {
  const source = record(metadata, "$.metadata"), og = record(source.openGraph, "$.metadata.openGraph");
  const text = (value: unknown, path: string, max = 4096) => value === undefined ? undefined : string(value, path, max);
  const href = (value: unknown, path: string, absolute: boolean) => {
    if (value === undefined) return undefined;
    if (!isSafePublicUrl(value) || value.startsWith("#") || absolute && !/^https:\/\//i.test(value)) fail(path, "unsafe URL");
    return value;
  };
  const title = text(source.title, "$.metadata.title", 300), robots = source.robots;
  if (title === undefined || !title.trim()) fail("$.metadata.title", "title is required");
  if (robots !== "index, follow" && robots !== "noindex, nofollow") fail("$.metadata.robots", "invalid robots");
  if (og.type !== "website") fail("$.metadata.openGraph.type", "unsupported type");
  const image = og.image === undefined ? undefined : record(og.image, "$.metadata.openGraph.image");
  const tags = [`<title>${escapeHtml(title)}</title>`];
  const meta = (attribute: "name" | "property", key: string, value: string | undefined) => { if (value !== undefined) tags.push(`<meta ${attribute}="${key}" content="${escapeHtml(value)}">`); };
  meta("name", "description", text(source.description, "$.metadata.description"));
  meta("name", "robots", robots);
  const canonical = href(source.canonical, "$.metadata.canonical", true);
  if (canonical) tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`);
  meta("property", "og:type", "website");
  meta("property", "og:title", text(og.title, "$.metadata.openGraph.title", 300) ?? title);
  meta("property", "og:description", text(og.description, "$.metadata.openGraph.description"));
  meta("property", "og:url", href(og.url, "$.metadata.openGraph.url", true));
  meta("property", "og:site_name", text(og.siteName, "$.metadata.openGraph.siteName", 300));
  meta("property", "og:locale", text(og.locale, "$.metadata.openGraph.locale", 40));
  if (image) {
    meta("property", "og:image", href(image.url, "$.metadata.openGraph.image.url", false) ?? fail("$.metadata.openGraph.image.url", "image URL is required"));
    const alt = text(image.alt, "$.metadata.openGraph.image.alt", metaLimits.altLength);
    if (alt) meta("property", "og:image:alt", alt);
    meta("name", "twitter:card", "summary_large_image");
  }
  const icon = href(source.icon, "$.metadata.icon", false);
  if (icon) tags.push(`<link rel="icon" href="${escapeHtml(icon)}">`);
  return tags.join("\n");
}

/** 通常ページ・公開・公開済み・パスあり・noindex でない場合だけ sitemap に含める。 */
export function shouldIncludeInSitemap({ page, meta, site }: { page: SitePage; meta?: PageMeta | undefined; site?: Pick<SiteSettings, "noindex"> | undefined }): boolean {
  return (page.kind ?? "page") === "page" && page.visibility !== "private" && page.published !== false &&
    validatePagePath(page.path) === null && meta?.noindex !== true && site?.noindex !== true;
}
