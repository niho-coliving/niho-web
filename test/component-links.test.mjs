import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteInternalLinks } from "@niho/web/pages";
import {
  DocumentValidationError, componentAssetReferences, findComponentLinks, findInstanceLinks, parseComponentLibrary, parsePageDocument, rewriteComponentLinks, rewriteInstanceLinks
} from "@niho/web/core";

const domains = ["https://demo.example.test"];
const link = (id, href, text) => ({ type: "element", id, tag: "a", attrs: { href }, children: [{ type: "text", text }] });
const library = () => parseComponentLibrary({
  schemaVersion: 1, siteId: "demo", revision: 4, tokens: {},
  components: [
    { id: "button", name: "ボタン", kind: "part", version: 2,
      root: { type: "element", id: "n1", tag: "p", children: [link("n2", "/contact", "問い合わせ")] },
      props: { href: { label: "リンク先", node: "n2", field: "href" } } },
    { id: "navbar", name: "サイトヘッダー", kind: "navigation", version: 5,
      root: { type: "element", id: "n1", tag: "nav", children: [
        link("n2", "/", "ホーム"), link("n3", "/about#team", "私たちについて"), link("n4", "https://demo.example.test/about?from=nav", "紹介"),
        link("n5", "https://other.example.test/about", "外部サイト"),
        { type: "instance", id: "n6", component: "button", props: { href: "/about" } }
      ] } },
    { id: "photo", name: "写真", kind: "part", version: 1,
      root: { type: "element", id: "n1", tag: "figure", style: { base: { backgroundImage: { asset: { provider: "library", id: "texture" } } } }, children: [
        { type: "element", id: "n2", tag: "img", asset: { provider: "library", id: "hero" }, attrs: { alt: "" }, children: [] }
      ] } }
  ]
});
const page = (body) => ({ schemaVersion: 1, siteId: "demo", pageId: "home", locale: "ja", revision: 3, title: "ホーム", tokens: {}, body });

test("links inside shared components count toward page path changes", () => {
  assert.deepEqual(findComponentLinks(library(), "/about", domains), [{ componentId: "navbar", nodeIds: ["n3", "n4", "n6"] }]);
  assert.deepEqual(findComponentLinks(library(), "/about/", domains), [{ componentId: "navbar", nodeIds: ["n3", "n4", "n6"] }]);
  assert.deepEqual(findComponentLinks(library(), "/contact", domains), [{ componentId: "button", nodeIds: ["n2"] }]);
  assert.deepEqual(findComponentLinks(library(), "/missing", domains), []);
});

test("rewriting component links keeps query and fragment, skips other sites and bumps only changed versions", () => {
  const source = library(), rewritten = rewriteComponentLinks(source, "/about", "/company", domains);
  const navbar = rewritten.components.find((component) => component.id === "navbar");
  assert.deepEqual(navbar.root.children.slice(0, 4).map((node) => node.attrs.href), ["/", "/company#team", "/company?from=nav", "https://other.example.test/about"]);
  assert.deepEqual(navbar.root.children[4].props, { href: "/company" });
  assert.deepEqual(rewritten.components.map(({ id, version }) => [id, version]), [["button", 2], ["navbar", 6], ["photo", 1]]);
  assert.equal(rewritten.revision, source.revision);
  assert.equal(source.components[1].root.children[1].attrs.href, "/about#team", "the input library is not mutated");
  assert.deepEqual(parseComponentLibrary(rewritten), rewritten);
  assert.throws(() => rewriteComponentLinks(source, "/about", "javascript:alert(1)", domains), DocumentValidationError);
});

test("page values that link to a moved page are found and rewritten on the document", () => {
  const components = library(), document = parsePageDocument(page([
    { type: "instance", id: "cta", component: "button", props: { href: "https://demo.example.test/about?ref=top" } },
    { type: "instance", id: "other", component: "button", props: { href: "/news" } },
    { type: "instance", id: "nav", component: "navbar" }
  ]), {}, { components });
  assert.deepEqual(findInstanceLinks(document, components, "/about", domains), ["cta"]);
  const rewritten = rewriteInstanceLinks(document, components, "/about", "/company", domains);
  assert.deepEqual(rewritten.body.map((node) => node.props ?? null), [{ href: "/company?ref=top" }, { href: "/news" }, null]);
  assert.equal(document.body[0].props.href, "https://demo.example.test/about?ref=top");
  assert.deepEqual(parsePageDocument(rewritten, {}, { components }), rewritten);
  assert.throws(() => rewriteInstanceLinks(document, components, "/about", "about", domains), DocumentValidationError);
});

test("asset references inside components are listed for usage and deletion checks", () => {
  assert.deepEqual(componentAssetReferences(library()), [{ componentId: "photo", placements: [
    { reference: { provider: "library", id: "texture" }, nodeId: "n1", target: "background", breakpoint: "base" },
    { reference: { provider: "library", id: "hero" }, nodeId: "n2", target: "image", breakpoint: "base" }
  ] }]);
});

test("rewrites that would exceed the URL limit are rejected instead of returning unsavable data", () => {
  const components = library(), long = `/about?q=${"x".repeat(2030)}`, to = "/company/history/2026";
  assert.equal(long.length <= 2048 && `${to}${long.slice(6)}`.length > 2048, true);
  const document = parsePageDocument(page([{ type: "instance", id: "cta", component: "button", props: { href: long } }]), {}, { components });
  assert.throws(() => rewriteInstanceLinks(document, components, "/about", to, domains), /\.props\.href: rewritten link is not a safe URL$/);
  const linked = parseComponentLibrary({ ...structuredClone(components), components: [{ ...structuredClone(components.components[0]),
    root: { type: "element", id: "n1", tag: "p", children: [link("n2", long, "長いリンク")] } }] });
  assert.throws(() => rewriteComponentLinks(linked, "/about", to, domains), /\.attrs\.href: rewritten link is not a safe URL$/);
  assert.throws(() => rewriteInternalLinks(page([link("n1", long, "長いリンク")]), "/about", to, domains), /\$\.body\.n1\.attrs\.href: rewritten link is not a safe URL$/);
});
