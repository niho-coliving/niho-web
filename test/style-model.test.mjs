import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { colorParts, editorTiers, expandBox, fieldState, formatColor, nextName, normalizeBreakpoints, splitLength, textStyleUsage, tierForWidth, tokenUsage, withAlpha } from "../dist/style-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const styled = () => {
  const doc = structuredClone(fixture);
  doc.tokens.title = { type: "length", value: "2rem" };
  doc.textStyles = { heading: { label: "見出し", base: { fontSize: 24, lineHeight: 1.3 }, responsive: [{ minWidth: 1024, declarations: { fontSize: { token: "title" } } }] } };
  doc.body[0].children[0].style = { textStyle: "heading", base: { color: { token: "ink" } }, responsive: [{ minWidth: 768, declarations: { lineHeight: 1.2 } }, { minWidth: 1280, declarations: { fontSize: 40, color: "#fff" } }] };
  return doc;
};

test("tiers combine host breakpoints with widths used by the document", () => {
  assert.deepEqual(editorTiers(fixture), [
    { key: "base", start: 0, end: 767, label: "基本" }, { key: 768, start: 768, end: 1279, label: "タブレット" }, { key: 1280, start: 1280, end: null, label: "PC" }
  ]);
  const tiers = editorTiers(styled(), [{ minWidth: 600, label: "小" }]);
  assert.deepEqual(tiers.map(({ key, label, end }) => [key, label, end]), [["base", "基本", 599], [600, "小", 767], [768, "768px〜", 1023], [1024, "1024px〜", 1279], [1280, "1280px〜", null]]);
  assert.equal(tierForWidth(tiers, 375).key, "base");
  assert.equal(tierForWidth(tiers, 768).key, 768);
  assert.equal(tierForWidth(tiers, 1100).key, 1024);
  assert.equal(tierForWidth(tiers, 3000).key, 1280);
  assert.deepEqual(editorTiers({ ...fixture, body: [] }, []), [{ key: "base", start: 0, end: null, label: "基本" }]);
  for (const invalid of [[{ minWidth: 100, label: "x" }], [{ minWidth: 800, label: "a" }, { minWidth: 700, label: "b" }], [{ minWidth: 768.5, label: "x" }], [{ minWidth: 768, label: " " }], "768"]) assert.equal(normalizeBreakpoints(invalid).length, 2);
  const custom = [{ minWidth: 600, label: "小" }]; assert.equal(normalizeBreakpoints(custom), custom);
});

test("field state separates own values, inherited values and higher overrides", () => {
  const doc = styled(), heading = doc.body[0].children[0], hero = doc.body[0];
  assert.deepEqual(fieldState(doc, heading, "color", "base"), { own: { token: "ink" }, overriddenAt: [1280] });
  assert.deepEqual(fieldState(doc, heading, "color", 768), { inherited: { value: { token: "ink" }, from: "base", via: "node" }, overriddenAt: [1280] });
  assert.deepEqual(fieldState(doc, heading, "color", 1280), { own: "#fff", inherited: { value: { token: "ink" }, from: "base", via: "node" }, overriddenAt: [] });
  // ノードの下位の段 → 文字スタイルの順に探す。
  assert.deepEqual(fieldState(doc, heading, "lineHeight", 1280), { inherited: { value: 1.2, from: 768, via: "node" }, overriddenAt: [] });
  assert.deepEqual(fieldState(doc, heading, "lineHeight", "base"), { inherited: { value: 1.3, from: "base", via: "textStyle", textStyle: "heading" }, overriddenAt: [768] });
  assert.deepEqual(fieldState(doc, heading, "fontSize", 1024), { inherited: { value: { token: "title" }, from: 1024, via: "textStyle", textStyle: "heading" }, overriddenAt: [1280] });
  assert.deepEqual(fieldState(doc, heading, "fontSize", 768), { inherited: { value: 24, from: "base", via: "textStyle", textStyle: "heading" }, overriddenAt: [1280] });
  assert.deepEqual(fieldState(doc, heading, "width", 768), { overriddenAt: [] });
  assert.deepEqual(fieldState(doc, hero, "margin", "base"), { overriddenAt: [768] });
  assert.deepEqual(fieldState(doc, hero, "margin", 1280), { inherited: { value: "0 auto", from: 768, via: "node" }, overriddenAt: [] });
});

test("usage lists nodes and text styles that reference a token or text style", () => {
  const doc = styled();
  assert.deepEqual(tokenUsage(doc, "ink"), { nodes: [{ nodeId: "hero", path: [0], property: "color", breakpoint: "base" }, { nodeId: "heading", path: [0, 0], property: "color", breakpoint: "base" }], textStyles: [] });
  assert.deepEqual(tokenUsage(doc, "title"), { nodes: [], textStyles: [{ name: "heading", property: "fontSize", breakpoint: 1024 }] });
  assert.deepEqual(tokenUsage(doc, "missing"), { nodes: [], textStyles: [] });
  assert.deepEqual(textStyleUsage(doc, "heading"), [{ nodeId: "heading", path: [0, 0] }]);
  assert.deepEqual(textStyleUsage(doc, "other"), []);
});

test("names, lengths and colors are formatted for the inspector", () => {
  assert.equal(nextName([], "color"), "color-1");
  assert.equal(nextName(["color-1", "color-2", "text-1"], "color"), "color-3");
  assert.equal(nextName(new Set(["size-2"]), "size"), "size-1");
  assert.deepEqual(splitLength(16), { number: 16, unit: "px" });
  assert.deepEqual(splitLength(1.5, ""), { number: 1.5, unit: "" });
  assert.deepEqual(splitLength("1.5rem"), { number: 1.5, unit: "rem" });
  assert.deepEqual(splitLength("-.5em"), { number: -0.5, unit: "em" });
  assert.deepEqual(splitLength("50%"), { number: 50, unit: "%" });
  assert.deepEqual(splitLength("0"), { number: 0, unit: "" });
  assert.deepEqual(splitLength("auto"), { keyword: "auto" });
  assert.deepEqual(splitLength("0 auto"), { keyword: "0 auto" });
  assert.deepEqual(splitLength({ token: "space" }), { token: "space" });
  assert.equal(formatColor("#ffffff00"), "#FFFFFF / 0%");
  assert.equal(formatColor("#195640"), "#195640");
  assert.equal(formatColor("#abc"), "#AABBCC");
  assert.equal(formatColor("#19564080"), "#195640 / 50%");
  assert.equal(formatColor("transparent"), "transparent");
  assert.deepEqual(colorParts("#FFF8"), { hex: "#ffffff", alpha: 53 });
  assert.equal(colorParts("red"), undefined);
  assert.equal(withAlpha("#195640", 50), "#19564080");
  assert.equal(withAlpha("#195640", 100), "#195640");
  assert.deepEqual(expandBox("1rem 2rem"), ["1rem", "2rem", "1rem", "2rem"]);
  assert.deepEqual(expandBox("1px 2px 3px"), ["1px", "2px", "3px", "2px"]);
  assert.deepEqual(expandBox(8), [8, 8, 8, 8]);
});
