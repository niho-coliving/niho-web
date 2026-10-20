import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, parsePageDocument } from "@niho/web/core";
import {
  PAGE_LIMITS, PREVIEW_RESPONSE_HEADERS, buildPageTree, findInternalLinks, findPathConflict, isTemplatePath, matchesTemplatePath, pageUrl,
  parseSiteSettings, renderPageHead, resolvePageMetadata, rewriteInternalLinks, shouldIncludeInSitemap, validatePagePath
} from "@niho/web/pages";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const page = (pageId, path, extra = {}) => ({ siteId: "demo", pageId, locale: "ja-JP", title: pageId, ...(path === undefined ? {} : { path }), ...extra });

test("page paths accept lowercase segments and reject the documented forms", () => {
  for (const path of ["/", "/about", "/circles/kamakura-go", "/a_b/c-1/2026", `/${"a/".repeat(7)}a`]) assert.equal(validatePagePath(path), null, path);
  for (const path of ["", "about", "/about/", "/a//b", "/About", "/a.html", "/a b", "/a?x=1", "/a#top", "/-a", "/a-", "/a--b", "/[slug]", `/${"a".repeat(160)}`, `/${"a/".repeat(8)}a`, undefined, 1])
    assert.equal(typeof validatePagePath(path), "string", String(path));
  assert.match(validatePagePath("/experiences/[slug]"), /テンプレート/);
  assert.match(validatePagePath("/a/"), /末尾/);
  assert.equal(PAGE_LIMITS.pathLength, 160); assert.ok(Object.isFrozen(PAGE_LIMITS));
});

test("template paths match one dynamic segment and conflicts respect site, locale and the edited page", () => {
  assert.equal(isTemplatePath("/experiences/[slug]"), true); assert.equal(isTemplatePath("/experiences"), false); assert.equal(isTemplatePath("/x/[Slug]"), false);
  assert.equal(matchesTemplatePath("/experiences/[slug]", "/experiences/kayak"), true);
  assert.equal(matchesTemplatePath("/experiences/[slug]", "/experiences"), false);
  assert.equal(matchesTemplatePath("/experiences/[slug]", "/experiences/a/b"), false);
  const pages = [page("home", "/"), page("about", "/about"), page("detail", "/experiences/[slug]", { kind: "template" }), page("en", "/about", { locale: "en" }), page("other", "/news", { siteId: "other" }), page("header", undefined, { kind: "shared" })];
  assert.equal(findPathConflict(pages, { siteId: "demo", locale: "ja-JP", path: "/about" })?.pageId, "about");
  assert.equal(findPathConflict(pages, { siteId: "demo", locale: "ja-JP", path: "/about", exceptPageId: "about" }), undefined);
  assert.equal(findPathConflict(pages, { siteId: "demo", locale: "ja-JP", path: "/experiences/kayak" })?.pageId, "detail");
  assert.equal(findPathConflict(pages, { siteId: "demo", locale: "ja-JP", path: "/news" }), undefined);
  assert.equal(findPathConflict(pages, { siteId: "demo", locale: "en", path: "/about" })?.pageId, "en");
  assert.equal(findPathConflict([page("x", "/experiences/[slug]")], { siteId: "demo", locale: "ja-JP", path: "/experiences/kayak" }), undefined);
});

test("page tree puts home first, groups paths into folders at the first descendant and filters flat by query", () => {
  const pages = [page("about", "/about"), page("badminton", "/circles/badminton", { title: "バドミントン" }), page("header", undefined, { kind: "shared", title: "ヘッダー" }),
    page("home", "/", { title: "ホーム" }), page("go", "/circles/kamakura-go", { title: "囲碁" }), page("deep", "/a/b/c")];
  const tree = buildPageTree(pages);
  const shape = (nodes) => nodes.map((node) => node.type === "folder" ? { folder: node.path, name: node.name, depth: node.depth, children: shape(node.children) } : [node.page.pageId, node.depth]);
  assert.deepEqual(shape(tree), [
    ["home", 0], ["about", 0],
    { folder: "/circles", name: "circles", depth: 0, children: [["badminton", 1], ["go", 1]] },
    ["header", 0],
    { folder: "/a", name: "a", depth: 0, children: [{ folder: "/a/b", name: "b", depth: 1, children: [["deep", 2]] }] }
  ]);
  assert.deepEqual(buildPageTree(pages, "  CIRCLES ").map((node) => [node.type, node.page.pageId, node.depth]), [["page", "badminton", 0], ["page", "go", 0]]);
  assert.deepEqual(buildPageTree(pages, "囲碁").map((node) => node.page.pageId), ["go"]);
  assert.deepEqual(buildPageTree(pages, "head").map((node) => node.page.pageId), ["header"]);
  assert.equal(buildPageTree(pages, "   ").length, 5);
  assert.equal(pageUrl("https://example.test", "/"), "https://example.test/"); assert.equal(pageUrl("https://example.test", "/about"), "https://example.test/about");
});

const link = (id, href) => ({ type: "element", id, tag: "a", attrs: { href }, children: [{ type: "text", text: id }] });
const linked = () => parsePageDocument({ ...structuredClone(fixture), body: [{ type: "element", id: "nav", tag: "nav", children: [
  link("relative", "/about"), link("query", "/about?x=1"), link("hash", "/about#team"), link("absolute", "https://example.test/about"),
  link("alias", "https://www.example.test/about/"), link("foreign", "https://other.test/about"), link("anchor", "#about"), link("prefix", "/about-us"),
  link("slash", "/about/"), link("home", "/"), link("upper", "https://EXAMPLE.test/about?y=2#z")
] }] });
const domains = ["https://example.test", "https://www.example.test"];

test("internal links resolve relative, query, fragment and approved absolute URLs only", () => {
  assert.deepEqual(findInternalLinks(linked(), "/about", domains), ["relative", "query", "hash", "absolute", "alias", "slash", "upper"]);
  assert.deepEqual(findInternalLinks(linked(), "/", domains), ["home"]);
  assert.deepEqual(findInternalLinks(linked(), "/about", []), ["relative", "query", "hash", "slash"]);
});

test("rewriting internal links returns a new valid document and keeps query and fragment", () => {
  const original = linked(), result = rewriteInternalLinks(original, "/about", "/company", domains);
  const hrefs = Object.fromEntries(result.body[0].children.map((node) => [node.id, node.attrs.href]));
  assert.deepEqual(hrefs, { relative: "/company", query: "/company?x=1", hash: "/company#team", absolute: "/company", alias: "/company", foreign: "https://other.test/about",
    anchor: "#about", prefix: "/about-us", slash: "/company", home: "/", upper: "/company?y=2#z" });
  assert.equal(original.body[0].children[0].attrs.href, "/about"); assert.equal(result.revision, original.revision);
  assert.doesNotThrow(() => parsePageDocument(result));
  assert.throws(() => rewriteInternalLinks(original, "/about", "javascript:alert(1)", domains), DocumentValidationError);
});

test("site settings are validated, copied and reject unknown keys", () => {
  const settings = parseSiteSettings({ noindex: false, locale: "ja", title: "鎌倉の家", favicon: "/favicon.ico", ogImage: { src: "/og.jpg", alt: "" }, description: "海のそばの家" });
  assert.deepEqual(Object.keys(settings), ["title", "description", "ogImage", "favicon", "locale"]);
  assert.deepEqual(parseSiteSettings({ title: "a", locale: "ja-JP", noindex: true }), { title: "a", locale: "ja-JP", noindex: true });
  for (const [input, path] of [[{ locale: "ja" }, "$.site.title"], [{ title: " ", locale: "ja" }, "$.site.title"], [{ title: "a".repeat(121), locale: "ja" }, "$.site.title"],
    [{ title: "a\nb", locale: "ja" }, "$.site.title"], [{ title: "a" }, "$.site.locale"], [{ title: "a", locale: "Japanese" }, "$.site.locale"],
    [{ title: "a", locale: "ja", ogImage: { src: "http://x.test/a.jpg", alt: "" } }, "$.site.ogImage.src"], [{ title: "a", locale: "ja", favicon: "#icon" }, "$.site.favicon"],
    [{ title: "a", locale: "ja", description: "a\nb" }, "$.site.description"], [{ title: "a", locale: "ja", canonical: "https://x.test" }, "$.site"], [null, "$.site"]])
    assert.throws(() => parseSiteSettings(input), (error) => error instanceof DocumentValidationError && error.path === path, JSON.stringify(input));
});

const site = { title: "鎌倉の家", description: "サイトの説明", ogImage: { src: "/og.jpg", alt: "海の写真" }, favicon: "/favicon.ico", locale: "ja" };
const document = { title: "私たちについて", locale: "ja-JP" };
test("page metadata falls back to site settings and resolves absolute URLs and canonical", () => {
  const metadata = resolvePageMetadata({ document, site, domain: "https://example.test", path: "/about", visibility: "public" });
  assert.deepEqual(metadata, {
    title: "私たちについて", description: "サイトの説明", locale: "ja-JP", robots: "index, follow", canonical: "https://example.test/about",
    openGraph: { type: "website", title: "私たちについて", description: "サイトの説明", url: "https://example.test/about", siteName: "鎌倉の家", locale: "ja_JP", image: { url: "https://example.test/og.jpg", alt: "海の写真" } },
    icon: "https://example.test/favicon.ico", structuredData: []
  });
  const own = resolvePageMetadata({ document: { ...document, meta: { description: "ページの説明", ogImage: { src: "https://cdn.example.test/a.jpg", alt: "" }, structuredData: ["organization"] } }, site });
  assert.equal(own.description, "ページの説明"); assert.equal(own.openGraph.image.url, "https://cdn.example.test/a.jpg"); assert.deepEqual(own.structuredData, ["organization"]);
  assert.equal(own.canonical, undefined); assert.equal(own.openGraph.url, undefined); assert.equal(own.icon, "/favicon.ico");
  const bare = resolvePageMetadata({ document: { title: "t", locale: "ja" } });
  assert.deepEqual(bare, { title: "t", locale: "ja", robots: "index, follow", openGraph: { type: "website", title: "t", locale: "ja" }, structuredData: [] });
});

test("preview, private pages, page noindex and site noindex suppress indexing and canonical", () => {
  for (const input of [{ preview: true }, { visibility: "private" }, { document: { ...document, meta: { noindex: true } } }, { site: { ...site, noindex: true } }]) {
    const metadata = resolvePageMetadata({ document, site, domain: "https://example.test", path: "/about", ...input });
    assert.equal(metadata.robots, "noindex, nofollow"); assert.equal(metadata.canonical, undefined); assert.equal(metadata.openGraph.url, "https://example.test/about");
  }
  for (const input of [{ domain: "https://example.test/" }, { domain: "http://example.test" }, { path: "/About" }, { path: "about" }, { visibility: "draft" }, { preview: "yes" },
    { site: { ...site, extra: true } }, { document: { ...document, meta: { favicon: "javascript:x" } } }, { document: { title: " ", locale: "ja" } }])
    assert.throws(() => resolvePageMetadata({ document, ...input }), DocumentValidationError, JSON.stringify(input));
});

test("rendered head escapes every value, omits JSON-LD and only adds the Twitter card with an image", () => {
  const hostile = `</title><script>alert("x")</script>'&`;
  const head = renderPageHead(resolvePageMetadata({ document: { title: hostile, locale: "ja-JP", meta: { description: `"説明" <b>` } }, site: { ...site, title: hostile }, domain: "https://example.test", path: "/" }));
  assert.ok(!head.includes("<script>")); assert.ok(!head.includes("<b>"));
  assert.ok(head.includes("<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&amp;</title>"));
  assert.ok(head.includes('<meta name="description" content="&quot;説明&quot; &lt;b&gt;">'));
  assert.ok(head.includes('<link rel="canonical" href="https://example.test/">'));
  assert.ok(head.includes('<meta property="og:image" content="https://example.test/og.jpg">'));
  assert.ok(head.includes('<meta property="og:image:alt" content="海の写真">'));
  assert.ok(head.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(head.includes('<meta property="og:locale" content="ja_JP">'));
  assert.ok(head.includes('<link rel="icon" href="https://example.test/favicon.ico">'));
  assert.ok(!head.includes("ld+json"));
  const plain = renderPageHead(resolvePageMetadata({ document: { title: "t", locale: "ja" }, preview: true }));
  assert.ok(!plain.includes("twitter:card")); assert.ok(plain.includes('<meta name="robots" content="noindex, nofollow">')); assert.ok(!plain.includes("canonical"));
  const valid = resolvePageMetadata({ document, site, domain: "https://example.test", path: "/about" });
  for (const metadata of [{ ...valid, canonical: "javascript:alert(1)" }, { ...valid, canonical: "/about" }, { ...valid, icon: "data:image/png;base64,AA" }, { ...valid, robots: "all" },
    { ...valid, openGraph: { ...valid.openGraph, image: { url: "http://x.test/a.jpg", alt: "" } } }, { ...valid, openGraph: { ...valid.openGraph, url: "https://x.test/\" onload=\"x" } }])
    assert.throws(() => renderPageHead(metadata), DocumentValidationError);
});

test("sitemap includes only public, published, indexable normal pages with a path", () => {
  const base = page("about", "/about");
  assert.equal(shouldIncludeInSitemap({ page: base }), true);
  assert.equal(shouldIncludeInSitemap({ page: { ...base, kind: "page", visibility: "public", published: true }, meta: {}, site: { noindex: false } }), true);
  for (const input of [{ page: { ...base, kind: "template" } }, { page: { ...base, kind: "shared" } }, { page: { ...base, visibility: "private" } }, { page: { ...base, published: false } },
    { page: page("x") }, { page: page("x", "/experiences/[slug]") }, { page: base, meta: { noindex: true } }, { page: base, site: { noindex: true } }])
    assert.equal(shouldIncludeInSitemap(input), false, JSON.stringify(input));
});

test("preview response headers are fixed and frozen", () => {
  assert.deepEqual({ ...PREVIEW_RESPONSE_HEADERS }, { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });
  assert.ok(Object.isFrozen(PREVIEW_RESPONSE_HEADERS));
  assert.throws(() => { "use strict"; PREVIEW_RESPONSE_HEADERS["X-Robots-Tag"] = "all"; }, TypeError);
});
