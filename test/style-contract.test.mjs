import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, generatePageCss, pageScope, parsePageDocument } from "@niho/web/core";
import { renderPageToHtml } from "@niho/web/server";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);
const reject = (input) => assert.throws(() => parsePageDocument(input), DocumentValidationError);
const withStyles = () => {
  const input = doc();
  input.tokens.brand = { type: "color", value: "#195640", label: "メイン" };
  input.tokens.title = { type: "length", value: "2rem" };
  input.textStyles = {
    heading: { label: "見出し", base: { fontSize: 24, fontWeight: 700, lineHeight: 1.3 }, responsive: [{ minWidth: 768, declarations: { fontSize: { token: "title" } } }] },
    body: { base: { fontSize: 16, lineHeight: 1.6 } },
    unused: { label: "未使用", base: { fontSize: 40 } }
  };
  input.body[0].children[0].style = { textStyle: "heading" };
  input.body[0].children[1].style = { textStyle: "heading", base: { fontSize: 18 } };
  input.body[0].children[2].style = { textStyle: "body" };
  return input;
};

test("old documents keep the same output shape and CSS", () => {
  const input = doc(), result = parsePageDocument(input);
  assert.equal(Object.hasOwn(result, "textStyles"), false);
  assert.ok(Object.values(result.tokens).every((token) => !Object.hasOwn(token, "label")));
  assert.equal(JSON.stringify(result), JSON.stringify(input));
  const scope = pageScope(input);
  assert.equal(generatePageCss(input), [
    `[data-nw-scope="${scope}"]{box-sizing:border-box;--nw-bodyFont:sans-serif;--nw-ink:#172d25;--nw-space:1.5rem;}`,
    `[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node]{box-sizing:border-box;}`,
    `[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="hero"]{color:var(--nw-ink);display:flex;flex-direction:column;font-family:var(--nw-bodyFont);gap:16px;padding:var(--nw-space);}`,
    `@media (min-width:768px){[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="hero"]{margin:0 auto;max-width:64rem;}}`
  ].join("\n"));
});

test("token labels are optional display names with closed validation", () => {
  const input = doc(); input.tokens.ink.label = "  文字の色  ";
  assert.equal(parsePageDocument(input).tokens.ink.label, "  文字の色  ");
  for (const label of ["", "   ", "a".repeat(61), "改\n行", "tab\there", 3, null]) { const copy = doc(); copy.tokens.ink.label = label; reject(copy); }
  const unknown = doc(); unknown.tokens.ink.description = "x"; reject(unknown);
});

test("text styles validate names, properties, tokens and responsive rules", () => {
  const input = withStyles(), result = parsePageDocument(input);
  assert.deepEqual(result.textStyles, input.textStyles);
  assert.equal(result.body[0].children[0].style.textStyle, "heading");
  const cases = [
    (copy) => { copy.body[0].children[0].style.textStyle = "missing"; },
    (copy) => { copy.body[0].children[0].style.textStyle = 1; },
    (copy) => { copy.textStyles.heading.base.color = "#ff0000"; },
    (copy) => { copy.textStyles.heading.base.width = 10; },
    (copy) => { copy.textStyles.heading.base.fontSize = { token: "brand" }; },
    (copy) => { copy.textStyles.heading.base.fontSize = { token: "nothing" }; },
    (copy) => { copy.textStyles.heading.base.fontSize = "1rem;color:red"; },
    (copy) => { delete copy.textStyles.heading.base; },
    (copy) => { copy.textStyles.heading.extra = true; },
    (copy) => { copy.textStyles.heading.label = ""; },
    (copy) => { copy.textStyles.Heading = copy.textStyles.heading; },
    (copy) => { copy.textStyles["1st"] = { base: {} }; },
    (copy) => { copy.textStyles.heading.responsive = [{ minWidth: 100, declarations: {} }]; },
    (copy) => { copy.textStyles.heading.responsive = [{ minWidth: 1024, declarations: {} }, { minWidth: 768, declarations: {} }]; },
    (copy) => { copy.textStyles.heading.responsive = [{ minWidth: 768, declarations: {} }, { minWidth: 768, declarations: {} }]; },
    (copy) => { copy.textStyles.heading.responsive = Array.from({ length: 13 }, (_, index) => ({ minWidth: 400 + index, declarations: {} })); },
    (copy) => { copy.textStyles.heading.responsive[0].declarations.color = "red"; },
    (copy) => { copy.textStyles = []; },
    (copy) => { for (let index = 0; index < 65; index++) copy.textStyles[`s${index}`] = { base: {} }; },
    (copy) => { copy.textStyles = JSON.parse('{"__proto__":{"base":{}}}'); }
  ];
  for (const mutate of cases) { const copy = withStyles(); mutate(copy); reject(copy); }
  const component = withStyles();
  component.body.push({ type: "component", id: "notice", block: "Notice", props: {}, style: { textStyle: "body" } });
  assert.equal(parsePageDocument(component, { Notice: { props: {} } }).body.at(-1).style.textStyle, "body");
});

test("new text appearance properties accept only their closed values", () => {
  const input = doc();
  input.body[0].style.base = { ...input.body[0].style.base, fontStyle: "italic", textDecorationLine: "line-through" };
  const css = generatePageCss(input);
  for (const part of ["font-style:italic;", "text-decoration-line:line-through;"]) assert.ok(css.includes(part), part);
  for (const [property, value] of [["fontStyle", "oblique"], ["textDecorationLine", "underline overline"], ["fontStyle", { token: "space" }], ["textDecorationLine", "none;color:red"]]) {
    const copy = doc(); copy.body[0].style.base[property] = value; reject(copy);
  }
});

test("oversized lengths and stacking orders are rejected at unit specific limits", () => {
  const accept = (declarations) => { const copy = doc(); copy.body[0].style.base = declarations; assert.doesNotThrow(() => parsePageDocument(copy), JSON.stringify(declarations)); };
  const deny = (declarations) => { const copy = doc(); copy.body[0].style.base = declarations; reject(copy); };
  for (const declarations of [{ width: "10000px" }, { width: 10000 }, { marginTop: -10000 }, { width: "1000rem" }, { fontSize: "1000em" }, { width: "1000ch" },
    { width: "1000%" }, { height: "1000vh" }, { width: "1000vw" }, { width: "1000vmin" }, { width: "1000vmax" }, { marginLeft: "-1000rem" }, { zIndex: 9999 }, { zIndex: -9999 }, { zIndex: "auto" }]) accept(declarations);
  for (const declarations of [{ width: "10001px" }, { width: 10001 }, { marginTop: -10001 }, { width: "1001rem" }, { fontSize: "1000.5em" }, { width: "1001%" },
    { height: "1001vh" }, { letterSpacing: "-1001em" }, { padding: "1rem 1001rem" }, { gridTemplateColumns: "repeat(2, minmax(0, 10001px))" }, { zIndex: 10000 }, { zIndex: -10000 }, { zIndex: 99999 }]) deny(declarations);
  const token = doc(); token.tokens.space.value = "1001rem"; reject(token);
  const numeric = doc(); numeric.tokens.space.value = 10001; reject(numeric);
});

test("text style rules come before node rules, group their users and skip unused styles", () => {
  const input = withStyles(), css = generatePageCss(input), scope = pageScope(input);
  const node = (id) => `[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="${id}"]`;
  const heading = `${node("heading")},${node("lead")}{font-size:24px;font-weight:700;line-height:1.3;}`;
  const headingTablet = `@media (min-width:768px){${node("heading")},${node("lead")}{font-size:var(--nw-title);}}`;
  const body = `${node("link")}{font-size:16px;line-height:1.6;}`;
  for (const rule of [heading, headingTablet, body]) assert.ok(css.includes(rule), rule);
  assert.ok(css.indexOf(body) < css.indexOf(heading), "styles are sorted by name");
  assert.ok(css.indexOf(headingTablet) < css.indexOf(`${node("hero")}{`));
  assert.ok(css.indexOf(headingTablet) < css.indexOf(`${node("lead")}{font-size:18px;}`));
  assert.ok(css.indexOf("box-sizing:border-box;}") < css.indexOf(body));
  assert.ok(!css.includes("font-size:40px"));
  assert.ok(css.includes("--nw-brand:#195640;"));
  const html = renderPageToHtml(input);
  assert.ok(!html.includes("textStyle") && !html.includes("data-nw-text"));
  assert.match(html, /<h1 data-nw-node="heading" data-nw-owner="[^"]+">/);
});
