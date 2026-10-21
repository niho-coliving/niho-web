import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, generatePageCss, pageScope, parseComponentLibrary, parsePageDocument, resolvePageDocument } from "@niho/web/core";
import { renderPageToHtml } from "@niho/web/server";
import { canvasCss } from "../dist/css.js";
import { carouselPreset, togglePreset } from "../dist/interaction-presets.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);
const reject = (input, blocks = {}, options) => assert.throws(() => parsePageDocument(input, blocks, options), DocumentValidationError);
const withBase = (declarations) => { const input = doc(); input.body[0].style.base = declarations; return input; };
const withStyle = (style) => { const input = doc(); input.body[0].children[2].style = style; return input; };
const link = (scope) => `[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="link"]`;

test("transform, transition and carousel properties accept only closed values at their limits", () => {
  for (const declarations of [{ translate: "12px" }, { translate: "12px -4px" }, { translate: 1000 }, { translate: "-1000px 64rem" }, { translate: "100% -100%" }, { translate: 0 },
    { rotate: "-360deg" }, { rotate: 360 }, { rotate: "45.5deg" }, { scale: 1.05 }, { scale: "1 1.2" }, { scale: 0 }, { scale: 5 }, { skew: 30 }, { skew: "12deg -5deg" }, ...["left top", "center", "right bottom", "center top"].map((transformOrigin) => ({ transformOrigin })),
    { transitionDuration: "0s" }, { transitionDuration: "5s" }, { transitionDuration: "5000ms" }, { transitionDuration: 300 }, { transitionDelay: ".2s" }, ...["ease", "ease-in", "ease-out", "ease-in-out", "linear"].map((transitionTimingFunction) => ({ transitionTimingFunction })),
    { overflowX: "auto" }, { overflowX: "scroll" }, { scrollSnapType: "x mandatory" }, { scrollSnapType: "x proximity" }, { scrollSnapAlign: "center" }]) {
    assert.doesNotThrow(() => parsePageDocument(withBase(declarations)), JSON.stringify(declarations));
  }
  for (const declarations of [{ translate: "calc(10px + 2px)" }, { translate: "1001px" }, { translate: "65rem" }, { translate: "101%" }, { translate: "1px 2px 3px" }, { translate: "1px  2px" }, { translate: "1px;color:red" },
    { rotate: "720deg" }, { rotate: "361deg" }, { rotate: -361 }, { rotate: "1turn" }, { rotate: "45" }, { scale: 10 }, { scale: "5.1" }, { scale: -1 }, { scale: "1 1 1" }, { scale: "105%" }, { skew: 181 }, { skew: "1deg 2deg 3deg" }, { skew: "calc(1deg)" },
    { transformOrigin: "top left" }, { transformOrigin: "50% 50%" }, { transitionDuration: "6s" }, { transitionDuration: "5001ms" }, { transitionDuration: "1min" }, { transitionDuration: "-1s" }, { transitionDuration: 5001 },
    { transitionTimingFunction: "cubic-bezier(0, 0, 1, 1)" }, { transitionTimingFunction: "steps(2)" }, { transitionProperty: "all" }, { transform: "rotate(10deg)" }, { animation: "spin 1s" },
    { overflowX: "clip" }, { scrollSnapType: "y mandatory" }, { scrollSnapType: "both" }, { scrollSnapAlign: "left" }, { rotate: { token: "space" } }]) {
    reject(withBase(declarations));
  }
  const css = generatePageCss(withBase({ translate: "12px -4px", rotate: -15, scale: "1 1.2", skew: "12deg -5deg", transformOrigin: "left top", overflowX: "auto", scrollSnapType: "x mandatory" }));
  for (const part of ["translate:12px -4px;", "rotate:-15deg;", "scale:1 1.2;", "transform:skew(12deg,-5deg);", "transform-origin:left top;", "overflow-x:auto;", "scroll-snap-type:x mandatory;"]) assert.ok(css.includes(part), part);
});

test("state styles allow only color, opacity, decoration and transform properties", () => {
  const input = doc(); input.tokens.accent = { type: "color", value: "#c0392b" };
  input.body[0].children[2].style = { states: { hover: { color: { token: "accent" }, translate: "0 -2px", textDecorationLine: "underline" }, focus: { backgroundColor: "#fff8e6", borderColor: "#195640" }, active: { opacity: 0.8, scale: 0.98, rotate: 2, skew: "2deg 3deg" } } };
  assert.deepEqual(parsePageDocument(input).body[0].children[2].style, input.body[0].children[2].style);
  for (const states of [{ hover: { width: 10 } }, { hover: { display: "none" } }, { hover: { fontSize: 20 } }, { visited: { color: "red" } }, { hover: { color: { token: "space" } } },
    { hover: { backgroundImage: { asset: { provider: "uploads", id: "x" } } } }, { hover: { color: "red;}" } }, { hover: { transitionDuration: 200 } }, { hover: [] }, []]) reject(withStyle({ states }));
});

test("appear and hidden ranges validate effects, timing and ordered non-overlapping widths", () => {
  for (const appear of [{ effect: "fade", trigger: "load", duration: 100, delay: 0 }, { effect: "zoom", trigger: "view", duration: 3000, delay: 3000, easing: "linear" }]) assert.doesNotThrow(() => parsePageDocument(withStyle({ appear })));
  for (const appear of [{ effect: "spin", trigger: "load", duration: 600, delay: 0 }, { effect: "fade", trigger: "click", duration: 600, delay: 0 }, { effect: "fade", trigger: "load", duration: 50, delay: 0 },
    { effect: "fade", trigger: "load", duration: 3001, delay: 0 }, { effect: "fade", trigger: "load", duration: 600.5, delay: 0 }, { effect: "fade", trigger: "load", duration: 600, delay: -1 },
    { effect: "fade", trigger: "load", duration: 600, delay: 0, easing: "cubic-bezier(0,0,1,1)" }, { effect: "fade", trigger: "load", duration: 600, delay: 0, script: "x" }, { effect: "fade", trigger: "load", delay: 0 }]) reject(withStyle({ appear }));
  for (const hidden of [[{ minWidth: 0, maxWidth: 767 }, { minWidth: 1280 }], [{ minWidth: 768, maxWidth: 1279 }], [{ minWidth: 0 }], []]) assert.doesNotThrow(() => parsePageDocument(withStyle({ hidden })), JSON.stringify(hidden));
  for (const hidden of [[{ minWidth: 0, maxWidth: 800 }, { minWidth: 768 }], [{ minWidth: 1280 }, { minWidth: 0, maxWidth: 767 }], [{ minWidth: 100, maxWidth: 200 }], [{ minWidth: 768, maxWidth: 768 }],
    [{ minWidth: 768 }, { minWidth: 1280 }], [{ minWidth: 768.5, maxWidth: 900 }], [{ minWidth: 768, maxWidth: 4000 }], [{ minWidth: "768" }], Array.from({ length: 13 }, (_, index) => ({ minWidth: 320 + index * 2, maxWidth: 321 + index * 2 })), {}]) reject(withStyle({ hidden }));
});

test("details and summary make a script-free toggle with closed attributes and nesting", () => {
  const toggle = (attrs, children) => { const input = doc(); input.body.push({ type: "element", id: "faq", tag: "details", ...(attrs ? { attrs } : {}), children }); return input; };
  const summary = (id = "question", children = [{ type: "text", text: "質問" }]) => ({ type: "element", id, tag: "summary", children });
  const answer = { type: "element", id: "answer", tag: "p", children: [{ type: "text", text: "答え" }] };
  const valid = toggle({ open: true }, [summary(), answer]);
  assert.deepEqual(parsePageDocument(valid).body.at(-1), valid.body.at(-1));
  assert.match(renderPageToHtml(valid), /<details open="" data-nw-node="faq"[^>]*><summary data-nw-node="question"[^>]*>質問<\/summary><p/);
  assert.doesNotThrow(() => parsePageDocument(toggle(undefined, [answer])));
  for (const input of [toggle({ open: "true" }, [summary(), answer]), toggle({ onclick: "alert(1)" }, [summary(), answer]), toggle({ onToggle: "x" }, [summary(), answer]), toggle(undefined, [answer, summary()]),
    toggle(undefined, [{ type: "text", text: " " }, summary(), answer]), toggle(undefined, [summary("a"), summary("b")]), toggle(undefined, [summary("q", [{ type: "element", id: "inner", tag: "a", attrs: { href: "/" }, children: [] }]), answer]),
    toggle(undefined, [summary("q", [{ type: "element", id: "inner", tag: "div", children: [] }])])]) reject(input);
  const outside = doc(); outside.body[0].children.push(summary()); reject(outside);
  const inLink = doc(); inLink.body[0].children[2].children = [{ type: "element", id: "faq", tag: "details", children: [] }]; reject(inLink);
  const inParagraph = doc(); inParagraph.body[0].children[1].children.push({ type: "element", id: "faq", tag: "details", children: [] }); reject(inParagraph);
  let counter = 0; const id = () => `preset_${++counter}`;
  const presets = doc(); presets.body.push(carouselPreset(id), togglePreset(id));
  const parsed = parsePageDocument(presets);
  assert.deepEqual(parsed.body.at(-2).attrs, { role: "region", "aria-label": "カルーセル", tabIndex: 0 });
  assert.equal(parsed.body.at(-1).children[0].tag, "summary");
  assert.ok(generatePageCss(presets).includes("scroll-snap-type:x mandatory;"));
});

test("state, motion, appear and hidden CSS respect hover devices, focus, reduced motion and rule order", () => {
  const input = doc(), scope = pageScope(input), selector = link(scope);
  input.body[0].children[2].style = { base: { transitionDuration: 200, transitionTimingFunction: "ease-out" }, responsive: [{ minWidth: 768, declarations: { transitionDuration: "0.4s" } }],
    states: { hover: { color: "#ff0000", translate: "0 -2px" }, focus: { color: "#ff0000", textDecorationLine: "underline" }, active: { scale: 0.98, skew: "2deg 3deg" } } };
  input.body[0].style.appear = { effect: "fade-up", trigger: "load", duration: 600, delay: 100 };
  input.body[0].children[0].style = { appear: { effect: "zoom", trigger: "view", duration: 600, delay: 0, easing: "ease-in-out" }, hidden: [{ minWidth: 768, maxWidth: 1279 }, { minWidth: 1440 }] };
  input.body[0].children[1].style = { hidden: [{ minWidth: 0, maxWidth: 767 }] };
  const css = generatePageCss(input), rules = css.split("\n");
  const hover = `@media (hover:hover){${selector}:hover{color:#ff0000;translate:0 -2px;}}`, focus = `${selector}:focus-visible{color:#ff0000;text-decoration-line:underline;}`, active = `${selector}:active{scale:0.98;transform:skew(2deg,3deg);}`;
  for (const rule of [hover, focus, active]) assert.ok(rules.includes(rule), rule);
  assert.ok(rules.indexOf(hover) < rules.indexOf(focus) && rules.indexOf(focus) < rules.indexOf(active));
  assert.ok(rules.includes(`@media (prefers-reduced-motion:no-preference){${selector}{transition-property:color,translate,scale,transform,text-decoration-color;transition-duration:200ms;transition-timing-function:ease-out;}}`));
  assert.ok(rules.includes(`@media (prefers-reduced-motion:no-preference) and (min-width:768px){${selector}{transition-duration:0.4s;}}`));
  assert.ok(!css.includes(`@media (min-width:768px){${selector}{}}`), "transition-only entries do not leave empty rules");
  assert.ok(rules.includes(`@media (prefers-reduced-motion:no-preference){[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="hero"]{animation:${scope}-fade-up 600ms ease 100ms both}}`));
  assert.ok(rules.includes(`@media (prefers-reduced-motion:no-preference){@supports (animation-timeline: view()){[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="heading"]{animation:${scope}-zoom auto ease-in-out both;animation-timeline:view();animation-range:entry 0% entry 60%}}}`));
  assert.deepEqual(rules.filter((rule) => rule.startsWith("@keyframes")), [`@keyframes ${scope}-fade-up{from{opacity:0;translate:0 24px}}`, `@keyframes ${scope}-zoom{from{opacity:0;scale:.92}}`]);
  for (const rule of rules) if (/animation|transition/.test(rule)) assert.ok(rule.startsWith("@media (prefers-reduced-motion:no-preference)"), rule);
  const hidden = [`@media (min-width:768px) and (max-width:1279.98px){[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="heading"]{display:none}}`,
    `@media (min-width:1440px){[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="heading"]{display:none}}`, `@media (max-width:767.98px){[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="lead"]{display:none}}`];
  assert.deepEqual(rules.slice(-3), hidden);
  // 状態スタイルの無いノードの遷移の指定は出さない。
  const still = withStyle({ base: { transitionDuration: 300, color: "#123456" } });
  assert.ok(!generatePageCss(still).includes("transition"));
  const html = renderPageToHtml(input);
  assert.ok(!/style="|hidden=""/.test(html.replace(/<style[^]*?<\/style>/, "")), "initial HTML never hides content inline");
});

test("old documents keep their exact output and editor canvas options stay internal", () => {
  const input = doc(), parsed = parsePageDocument(input);
  assert.equal(JSON.stringify(parsed), JSON.stringify(input));
  assert.ok(!/hover|keyframes|reduced-motion|display:none/.test(generatePageCss(input)));
  const styled = withStyle({ states: { hover: { color: "#ff0000" } }, base: { transitionDuration: 200 }, appear: { effect: "fade", trigger: "load", duration: 500, delay: 0 } });
  const document = parsePageDocument(styled), scope = pageScope(document);
  assert.equal(canvasCss(document, { forceState: { nodeId: "link", state: "hover" }, motion: "paused" }), `${link(scope)}[data-nw-node="link"]{color:#ff0000;}\n[data-nw-scope="${scope}"],[data-nw-scope="${scope}"] *{animation:none!important;transition:none!important}`);
  assert.equal(canvasCss(document, { motion: "play" }), "");
  assert.equal(canvasCss(document, { forceState: { nodeId: "heading", state: "hover" } }), "");
});

test("block slots reject state, appear, hidden and text style keys while instances accept them", () => {
  const blocks = { Cards: { props: {}, slots: { cta: { label: "ボタン", style: ["color", "backgroundColor"] } } } };
  const block = (slots) => { const input = doc(); input.body.push({ type: "component", id: "cards", block: "Cards", props: {}, slots }); return input; };
  assert.doesNotThrow(() => parsePageDocument(block({ cta: { base: { color: "#fff" } } }), blocks));
  for (const extra of [{ states: { hover: { color: "#000" } } }, { appear: { effect: "fade", trigger: "load", duration: 500, delay: 0 } }, { hidden: [{ minWidth: 0, maxWidth: 767 }] }, { textStyle: "heading" }]) {
    const input = block({ cta: { base: { color: "#fff" }, ...extra } }); input.textStyles = { heading: { base: { fontSize: 24 } } };
    reject(input, blocks);
  }
  const component = { id: "button", name: "ボタン", kind: "part", version: 1, root: { type: "element", id: "n1", tag: "a", attrs: { href: "/" }, style: { states: { hover: { color: "#195640" } }, hidden: [{ minWidth: 1280 }] }, children: [{ type: "text", text: "予約" }] } };
  const components = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [component] });
  const page = doc(); page.body.push({ type: "instance", id: "reserve", component: "button", style: { states: { hover: { backgroundColor: "#eef3ef" }, focus: { color: "#000" } }, appear: { effect: "fade", trigger: "view", duration: 500, delay: 0 } } });
  const resolved = resolvePageDocument(parsePageDocument(page, {}, { components }), components).document.body.at(-1);
  assert.deepEqual(resolved.style, { states: { hover: { color: "#195640", backgroundColor: "#eef3ef" }, focus: { color: "#000" } }, appear: { effect: "fade", trigger: "view", duration: 500, delay: 0 }, hidden: [{ minWidth: 1280 }] });
  const bad = structuredClone(page); bad.body.at(-1).style.states.hover.width = 10; reject(bad, {}, { components });
});
