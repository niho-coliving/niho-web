import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, generatePageCss, isSafePublicUrl, pageScope, parsePageDocument, validateDocument } from "@niho/web";
import { validateDocument as validateCore } from "@niho/web/core";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);
const reject = (input, blocks = {}) => assert.throws(() => parsePageDocument(input, blocks), DocumentValidationError);

test("v1 document round trips without retaining mutable input references", () => {
  const input = doc(), result = parsePageDocument(input);
  assert.deepEqual(result, input);
  input.body[0].children[0].children[0].text = "changed";
  input.body[0].style.base.padding.token = "changed";
  assert.equal(result.body[0].children[0].children[0].text, "海のそばで過ごす");
  assert.deepEqual(result.body[0].style.base.padding, { token: "space" });
  assert.deepEqual(validateDocument(doc()), validateCore(doc()));
});

test("schema version, identity, unknown fields and malformed objects fail closed", () => {
  for (const input of [null, [], "html", { ...doc(), schemaVersion: 2 }, { ...doc(), revision: 0 },
    { ...doc(), revision: 1.5 }, { ...doc(), siteId: "a\"]body{" }, { ...doc(), locale: "ja\n" },
    { ...doc(), title: "" }, { ...doc(), script: "alert(1)" }, { ...doc(), body: {} }]) reject(input);
  const input = doc();
  input.body[0].attrs = JSON.parse('{"__proto__":{"polluted":true}}');
  reject(input);
  assert.equal({}.polluted, undefined);
});

test("only safe HTTPS, root relative and fragment URLs are allowed", () => {
  for (const url of ["https://example.com/image.jpg?a=1&b=2", "/about", "/images/a.webp", "#heading"]) assert.ok(isSafePublicUrl(url), url);
  for (const url of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "java\nscript:alert(1)", "data:image/svg+xml,<svg/>",
    "http://example.com", "//example.com", "/\\example.com", "/%2fexample.com", "/%5cexample.com", "/%0aexample.com", "/%zz", "https://user:pass@example.com", "https://example.com/\" onload=evil", "about", " https://example.com", "mailto:a@example.com"]) {
    assert.equal(isSafePublicUrl(url), false, url);
    const input = doc(); input.body[0].children[2].attrs.href = url; reject(input);
  }
});

test("scriptable tags and attributes, arbitrary HTML and JS are rejected", () => {
  for (const tag of ["script", "iframe", "style", "link", "object", "svg", "math", "custom-widget", "form", "input"]) {
    const input = doc(); input.body[0].tag = tag; reject(input);
  }
  for (const attrs of [{ onClick: "alert(1)" }, { onclick: "alert(1)" }, { style: "color:red" }, { srcDoc: "<script>" },
    { dangerouslySetInnerHTML: "<script>" }, { className: "global" }, { "data-nw-scope": "other" }, { target: "other" }]) {
    const input = doc(); input.body[0].attrs = attrs; reject(input);
  }
  const input = doc(); input.body[0].html = "<b>raw</b>"; reject(input);
});

test("duplicate IDs, void children and invalid HTML nesting cannot break hydration", () => {
  const duplicate = doc(); duplicate.body.push(structuredClone(duplicate.body[0])); reject(duplicate);
  const duplicateHtmlId = doc(); duplicateHtmlId.body[0].attrs.id = "same";
  duplicateHtmlId.body[0].children[0].attrs = { id: "same" }; reject(duplicateHtmlId);
  const voidChild = doc(); voidChild.body[0].tag = "br"; reject(voidChild);
  const paragraph = doc(); paragraph.body[0].tag = "p"; reject(paragraph);
  const nestedAnchor = doc(); nestedAnchor.body[0].tag = "a"; reject(nestedAnchor);
  const list = doc(); list.body[0].tag = "ul"; reject(list);
  const image = doc(); image.body = [{ type: "element", id: "photo", tag: "img", attrs: { src: "/photo.webp" }, children: [] }]; reject(image);
  image.body[0].attrs.alt = ""; assert.doesNotThrow(() => parsePageDocument(image));
});

test("picture requires source elements before exactly one fallback image", () => {
  const source = () => ({ type: "element", id: "source", tag: "source", attrs: { srcSet: "/image.avif", type: "image/avif" }, children: [] });
  const image = (id = "image") => ({ type: "element", id, tag: "img", attrs: { src: "/image.jpg", alt: "風景" }, children: [] });
  const picture = (children) => { const input = doc(); input.body = [{ type: "element", id: "picture", tag: "picture", children }]; return input; };

  assert.doesNotThrow(() => parsePageDocument(picture([source(), image()])));
  assert.doesNotThrow(() => parsePageDocument(picture([image()])));
  reject(picture([source()]));
  reject(picture([image("first"), image("second")]));
  reject(picture([image(), source()]));
});

test("depth and node limits reject pathological documents", () => {
  const deep = doc(); let children = deep.body;
  for (let i = 0; i < 50; i++) {
    const node = { type: "element", id: `n${i}`, tag: "div", children: [] }; children.push(node); children = node.children;
  }
  reject(deep);
  const wide = doc(); wide.body = Array.from({ length: 5001 }, () => ({ type: "text", text: "a" })); reject(wide);
  const large = doc(); large.body = Array.from({ length: 11 }, () => ({ type: "text", text: "a".repeat(100000) })); reject(large);
});

test("CSS uses document scoped selectors and mobile first overrides", () => {
  const input = doc(), css = generatePageCss(input), scope = pageScope(input);
  assert.ok(css.includes(`[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="hero"]{`));
  assert.ok(css.includes("--nw-ink:#172d25;"));
  assert.ok(css.includes("color:var(--nw-ink);"));
  assert.ok(css.includes("gap:16px;"));
  assert.ok(css.includes(`@media (min-width:768px){[data-nw-scope="${scope}"]`));
  assert.ok(css.indexOf("padding:var(--nw-space)") < css.indexOf("@media"));
  assert.notEqual(scope, pageScope({ ...input, siteId: "another" }));
  assert.notEqual(scope, pageScope({ ...input, revision: 2 }));
  assert.notEqual(pageScope({ ...input, siteId: "a-b", pageId: "c" }), pageScope({ ...input, siteId: "a", pageId: "b-c" }));
});

test("color, typography, dimensions, spacing, flex/grid and position CSS compile", () => {
  const input = doc(); input.body[0].style.base = {
    backgroundColor: "#fff", borderColor: "currentColor", fontFamily: "Open Sans, sans-serif", fontSize: 18,
    fontWeight: 600, lineHeight: 1.5, letterSpacing: "-0.01em", textAlign: "center",
    width: "100%", minHeight: "20rem", maxWidth: "64rem", margin: "-1rem auto 0", padding: "1rem 2rem",
    display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))", gridTemplateRows: "auto 1fr",
    gridColumn: "1 / 3", gridRow: "span 2", gap: "1rem", rowGap: 12,
    flexGrow: 1, flexShrink: 0, flexBasis: "auto", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center",
    position: "sticky", top: 0, left: "-2px", zIndex: 10, borderRadius: "1rem", borderWidth: 1, borderStyle: "solid", overflow: "hidden", opacity: 0.9, objectFit: "cover"
  };
  const css = generatePageCss(input);
  assert.ok(css.includes("grid-template-columns:repeat(auto-fit, minmax(16rem, 1fr));"));
  assert.ok(css.includes("font-size:18px;")); assert.ok(css.includes("line-height:1.5;"));
});

test("raw CSS, unsafe values, properties and selector escapes are rejected", () => {
  for (const declarations of [
    { color: "red; } body {display:none" }, { color: "var(--foreign)" }, { backgroundColor: "url(https://example.com/x)" },
    { backgroundImage: "url(https://example.com/x)" }, { fontFamily: "x</style><script>alert(1)</script>" },
    { width: "expression(alert(1))" }, { width: "calc(100% - 1px)" }, { width: "10px!important" },
    { display: "flex; color:red" }, { position: "absolute\n" }, { padding: "-1rem" }, { opacity: 2 }, { gap: Number.NaN },
    { gridTemplateColumns: "repeat(3, url(x))" }, { gridTemplateColumns: "repeat(3, minmax(0, 1fr)))" },
    { color: { token: "unknown" } }, { color: { token: "space" } }, { color: { token: "ink", css: "bad" } },
    { "--custom": "red" }, JSON.parse('{"__proto__":"red"}')
  ]) {
    const input = doc(); input.body[0].style.base = declarations; reject(input);
    assert.throws(() => generatePageCss(input), DocumentValidationError);
  }
  for (const responsive of [
    [{ minWidth: 100, declarations: {} }], [{ minWidth: 768, declarations: {} }, { minWidth: 768, declarations: {} }],
    [{ minWidth: 1024, declarations: {} }, { minWidth: 768, declarations: {} }], [{ minWidth: "768", declarations: {} }]
  ]) { const input = doc(); input.body[0].style.responsive = responsive; reject(input); }
});

test("token definitions validate types and cannot inject custom CSS", () => {
  for (const token of [{ type: "color", value: "red;display:none" }, { type: { toString: null }, value: "red" }, { type: "url", value: "https://example.com" },
    { type: "length", value: "calc(1px + 2px)" }, { type: "number", value: "1" }, { type: "fontFamily", value: "sans-serif;/*" }]) {
    const input = doc(); input.tokens.ink = token; reject(input);
  }
  const input = doc(); input.tokens.weight = { type: "number", value: 600 };
  input.body[0].style.base.fontWeight = { token: "weight" };
  assert.ok(generatePageCss(input).includes("font-weight:var(--nw-weight)"));
  input.tokens.weight.value = 1001; reject(input);
});

test("component registry allows only explicitly declared primitive public props", () => {
  const input = doc(); input.body.push({ type: "component", id: "dynamic", block: "PublicNotice", props: { heading: "Hello", count: 3, active: true, tone: "info", href: "/about" } });
  const blocks = { PublicNotice: { props: {
    heading: { type: "string", required: true, maxLength: 40 }, count: { type: "number", min: 0, max: 10 }, active: { type: "boolean" },
    tone: { type: "enum", values: ["info", "warning"] }, href: { type: "url" }
  } } };
  assert.deepEqual(parsePageDocument(input, blocks), input);
  reject(input);
  for (const props of [{ heading: "Hello", onClick: "evil" }, {}, { heading: {} }, { heading: "Hello", count: 11 },
    { heading: "Hello", count: Infinity }, { heading: "Hello", active: "true" }, { heading: "Hello", tone: "other" },
    { heading: "Hello", href: "javascript:alert(1)" }]) {
    const copy = structuredClone(input); copy.body.at(-1).props = props; reject(copy, blocks);
  }
  const inherited = Object.create({ PublicNotice: blocks.PublicNotice }); reject(input, inherited);
  const unsafeContract = { PublicNotice: { props: { onClick: { type: "string" } } } }; reject(input, unsafeContract);
  const inParagraph = doc(); inParagraph.body[0].children[1].children = [input.body.at(-1)]; reject(inParagraph, blocks);
});

test("img elements can reference a library asset instead of a URL and still require alt", () => {
  const image = (node) => { const input = doc(); input.body[0].children.push({ type: "element", id: "photo", tag: "img", children: [], ...node }); return input; };
  const input = image({ asset: { provider: "uploads", id: "sea-1.webp" }, attrs: { alt: "" } }), result = parsePageDocument(input);
  assert.deepEqual(result, input);
  input.body[0].children[3].asset.id = "changed";
  assert.equal(result.body[0].children[3].asset.id, "sea-1.webp");
  reject(image({ asset: { provider: "uploads", id: "sea" } }));
  reject(image({ asset: { provider: "uploads", id: "sea" }, attrs: {} }));
  reject(image({ asset: { provider: "uploads", id: "sea" }, attrs: { alt: "", src: "/sea.webp" } }));
  const div = doc(); div.body[0].asset = { provider: "uploads", id: "sea" }; reject(div);
  for (const asset of [{ provider: "1uploads", id: "sea" }, { provider: "up:loads", id: "sea" }, { provider: "uploads", id: "" }, { provider: "uploads", id: "../sea" },
    { provider: "uploads", id: "a/b" }, { provider: "uploads", id: "a b" }, { provider: "uploads", id: "a".repeat(129) }, { provider: "uploads", id: "sea", src: "/x.webp" },
    { provider: "uploads" }, "uploads:sea", null]) reject(image({ asset, attrs: { alt: "" } }));
});

test("background images accept only library asset references and background enums are closed", () => {
  const input = doc();
  Object.assign(input.body[0].style.base, { backgroundImage: { asset: { provider: "uploads", id: "wave" } }, backgroundSize: "cover", backgroundPosition: "top left", backgroundRepeat: "no-repeat" });
  assert.deepEqual(parsePageDocument(input), input);
  const css = generatePageCss(input);
  assert.ok(css.includes("background-position:top left;background-repeat:no-repeat;background-size:cover;color:var(--nw-ink);"));
  assert.ok(!css.includes("background-image"));
  for (const declarations of [{ backgroundImage: "url(/a.webp)" }, { backgroundImage: "/a.webp" }, { backgroundImage: { token: "ink" } }, { backgroundImage: 1 },
    { backgroundImage: { asset: { provider: "uploads", id: "a" }, url: "/a.webp" } }, { backgroundImage: { asset: { provider: "uploads", id: "a", src: "/a.webp" } } },
    { backgroundImage: { asset: "uploads:a" } }, { backgroundImage: {} }, { backgroundSize: "100px" }, { backgroundSize: 10 }, { backgroundSize: { token: "space" } },
    { backgroundPosition: "center;color:red" }, { backgroundPosition: "50% 50%" }, { backgroundRepeat: "round" }]) {
    const copy = doc(); copy.body[0].style.base = declarations; reject(copy);
  }
});
