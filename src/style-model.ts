import { expandDocument, instancesOf } from "./component-expand.js";
import { inheritedStyle, walkNodes, type InheritedStyle, type NodePath } from "./editor-model.js";
import type { EditorBreakpoint } from "./editor-types.js";
import { detachRemovedSiteStyles, resolvePageStyles, type SiteStyles } from "./site-styles.js";
import type { ComponentLibrary, ComponentNode, ElementNode, HiddenRange, InstanceNode, NodeStyle, PageDocument, StateName, StyleDeclarations, StyleProperty, StyleValue, TextStyleProperty } from "./types.js";
import { fail } from "./validation-utils.js";

/** 編集 UI の段の計算・使用状況・表示用の整形。React を使わない純粋関数。 */
export type TierKey = "base" | number;
export type EditorTier = { key: TierKey; start: number; end: number | null; label: string };
export type FieldState = {
  own?: StyleValue;
  inherited?: InheritedStyle;
  overriddenAt: number[];
};
export const defaultBreakpoints: readonly EditorBreakpoint[] = [{ minWidth: 768, label: "タブレット" }, { minWidth: 1280, label: "PC" }];

/** ホスト指定の段を検証し、不正なら既定値へ戻す。 */
export function normalizeBreakpoints(input: readonly EditorBreakpoint[] | undefined): readonly EditorBreakpoint[] {
  if (!Array.isArray(input) || input.length > 12) return defaultBreakpoints;
  let previous = 0;
  for (const entry of input) {
    if (!entry || !Number.isInteger(entry.minWidth) || entry.minWidth < 320 || entry.minWidth > 3840 || entry.minWidth <= previous ||
      typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 40) return defaultBreakpoints;
    previous = entry.minWidth;
  }
  return input;
}
export function editorTiers(document: PageDocument, breakpoints: readonly EditorBreakpoint[] = defaultBreakpoints): EditorTier[] {
  const widths = new Set(breakpoints.map((entry) => entry.minWidth));
  for (const { node } of walkNodes(document)) if (node.type !== "text") for (const entry of node.style?.responsive ?? []) widths.add(entry.minWidth);
  // 業務ブロックの表示領域で使う幅も段として選べるようにする。
  for (const { node } of walkNodes(document)) if (node.type === "component") for (const style of Object.values(node.slots ?? {})) for (const entry of style.responsive ?? []) widths.add(entry.minWidth);
  for (const style of Object.values(document.textStyles ?? {})) for (const entry of style.responsive ?? []) widths.add(entry.minWidth);
  const sorted = [...widths].sort((a, b) => a - b);
  return (["base", ...sorted] as TierKey[]).map((key, index) => {
    const next = sorted[index];
    return { key, start: key === "base" ? 0 : key, end: next === undefined ? null : next - 1,
      label: key === "base" ? "基本" : breakpoints.find((entry) => entry.minWidth === key)?.label ?? `${key}px〜` };
  });
}
export function tierForWidth(tiers: readonly EditorTier[], width: number): EditorTier {
  return [...tiers].reverse().find((tier) => tier.start <= width) ?? tiers[0] ?? { key: "base", start: 0, end: null, label: "基本" };
}
export const tierName = (tier: EditorTier) => tier.key === "base" ? tier.label : `${tier.label} ${tier.start}px〜`;
export function declarationsAt(style: NodeStyle | undefined, tier: TierKey): StyleDeclarations | undefined {
  return tier === "base" ? style?.base : style?.responsive?.find((entry) => entry.minWidth === tier)?.declarations;
}
/** own はその段の直接指定、inherited はその段の開始幅で own を除いて効く値。ノードの値が文字スタイルより優先する。 */
export function fieldState(document: PageDocument, node: ElementNode | ComponentNode | InstanceNode, property: StyleProperty, tier: TierKey): FieldState {
  const start = tier === "base" ? 0 : tier, responsive = node.style?.responsive ?? [];
  const own = declarationsAt(node.style, tier)?.[property], inherited = inheritedStyle(document, node, property, start);
  return { ...(own === undefined ? {} : { own }), ...(inherited ? { inherited } : {}),
    overriddenAt: responsive.filter((entry) => entry.minWidth > start && entry.declarations[property] !== undefined).map((entry) => entry.minWidth) };
}
export function tokenUsage(document: PageDocument, name: string): {
  /** slot は業務ブロックの表示領域での参照。 */
  nodes: { nodeId: string; path: NodePath; property: StyleProperty; breakpoint: TierKey; state?: StateName; slot?: string }[];
  textStyles: { name: string; property: TextStyleProperty; breakpoint: TierKey }[];
} {
  const uses = (values: StyleDeclarations | undefined) => Object.entries(values ?? {}).flatMap(([property, value]) => typeof value === "object" && "token" in value && value.token === name ? [property] : []);
  const nodes: ReturnType<typeof tokenUsage>["nodes"] = [], textStyles: ReturnType<typeof tokenUsage>["textStyles"] = [];
  for (const { node, path } of walkNodes(document)) {
    if (node.type === "text") continue;
    for (const property of uses(node.style?.base)) nodes.push({ nodeId: node.id, path, property: property as StyleProperty, breakpoint: "base" });
    for (const entry of node.style?.responsive ?? []) for (const property of uses(entry.declarations)) nodes.push({ nodeId: node.id, path, property: property as StyleProperty, breakpoint: entry.minWidth });
    for (const [state, values] of Object.entries(node.style?.states ?? {})) for (const property of uses(values)) nodes.push({ nodeId: node.id, path, property: property as StyleProperty, breakpoint: "base", state: state as StateName });
    if (node.type === "component") for (const [slot, style] of Object.entries(node.slots ?? {})) {
      for (const property of uses(style.base)) nodes.push({ nodeId: node.id, path, property: property as StyleProperty, breakpoint: "base", slot });
      for (const entry of style.responsive ?? []) for (const property of uses(entry.declarations)) nodes.push({ nodeId: node.id, path, property: property as StyleProperty, breakpoint: entry.minWidth, slot });
    }
  }
  for (const [style, value] of Object.entries(document.textStyles ?? {})) {
    for (const property of uses(value.base)) textStyles.push({ name: style, property: property as TextStyleProperty, breakpoint: "base" });
    for (const entry of value.responsive ?? []) for (const property of uses(entry.declarations)) textStyles.push({ name: style, property: property as TextStyleProperty, breakpoint: entry.minWidth });
  }
  return { nodes, textStyles };
}
/** 範囲全体が非表示の段。 */
export function hiddenTiers(node: { style?: NodeStyle | undefined }, tiers: readonly EditorTier[]): TierKey[] {
  const ranges = node.style?.hidden ?? [];
  return tiers.filter((tier) => ranges.some((range) => range.minWidth <= tier.start && (range.maxWidth === undefined || tier.end !== null && range.maxWidth >= tier.end))).map((tier) => tier.key);
}
/** 非表示にする段から範囲を作る。隣り合う段は 1 つの範囲にまとめる。 */
export function rangesForTiers(tiers: readonly EditorTier[], hiddenKeys: readonly TierKey[]): HiddenRange[] {
  const result: HiddenRange[] = [];
  let current: HiddenRange | undefined;
  for (const tier of tiers) {
    if (!hiddenKeys.includes(tier.key)) { current = undefined; continue; }
    if (!current) { current = { minWidth: tier.start }; result.push(current); }
    if (tier.end === null) delete current.maxWidth; else current.maxWidth = tier.end;
  }
  return result;
}
/** 表示幅 width でこのノードが非表示か。 */
export const hiddenAt = (node: { style?: NodeStyle | undefined }, width: number) => (node.style?.hidden ?? []).some((range) => range.minWidth <= width && (range.maxWidth === undefined || width <= range.maxWidth));
export function textStyleUsage(document: PageDocument, name: string): { nodeId: string; path: NodePath }[] {
  return walkNodes(document).flatMap(({ node, path }) => node.type !== "text" && node.style?.textStyle === name ? [{ nodeId: node.id, path }] : []);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * サイト共通スタイルを before から after へ変えると、検証済みの文書の参照または見た目が変わるか。
 * インスタンスは公開時と同じく部品を展開して比べ（tokens はページ > サイト共通 > ライブラリ）、部品の中だけで使う値の変化も含める。
 * library はインスタンスを含まない文書でだけ省略できる。
 */
export function affectedBySiteStyles(document: PageDocument, before: SiteStyles, after: SiteStyles, library?: ComponentLibrary): boolean {
  if (!library && instancesOf(document.body).length) fail("$.body", "component instance requires a component library");
  const detached = detachRemovedSiteStyles(document, before, after);
  if (!same(detached.body, document.body) || !same(detached.textStyles, document.textStyles)) return true;
  const resolve = (page: PageDocument, styles: SiteStyles) => { const resolved = resolvePageStyles(page, styles); return library ? expandDocument(resolved, library).document : resolved; };
  const previous = resolve(document, before), next = resolve(detached, after);
  for (const name of new Set([...Object.keys(previous.tokens), ...Object.keys(next.tokens)])) {
    if (same(previous.tokens[name], next.tokens[name])) continue;
    const usage = tokenUsage(previous, name);
    if (usage.nodes.length || usage.textStyles.some((entry) => textStyleUsage(previous, entry.name).length)) return true;
  }
  for (const name of new Set([...Object.keys(previous.textStyles ?? {}), ...Object.keys(next.textStyles ?? {})])) {
    if (!same(previous.textStyles?.[name], next.textStyles?.[name]) && textStyleUsage(previous, name).length) return true;
  }
  return false;
}
export function nextName(existing: Iterable<string>, prefix: string): string {
  const used = new Set(existing);
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}
export type LengthParts = { number: number; unit: string } | { keyword: string } | { token: string };
/** 数値だけの値は numberUnit（px のプロパティは "px"、倍率は ""）として返す。 */
export function splitLength(value: StyleValue, numberUnit = "px"): LengthParts {
  if (typeof value === "object") return { token: value.token };
  if (typeof value === "number") return { number: value, unit: numberUnit };
  const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|%|vh|vw|vmin|vmax|ch)?$/.exec(value);
  return match ? { number: Number(match[1]), unit: match[2] ?? "" } : { keyword: value };
}
/** HEX を `#RRGGBB` と、透明度があれば `/ 不透明度%` で表す。それ以外はそのまま。 */
export function formatColor(value: string | number): string {
  const parts = colorParts(String(value));
  return parts ? parts.alpha === 100 && !/^#(?:[\da-f]{4}|[\da-f]{8})$/i.test(String(value)) ? parts.hex.toUpperCase() : `${parts.hex.toUpperCase()} / ${parts.alpha}%` : String(value);
}
export function colorParts(value: string): { hex: string; alpha: number } | undefined {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (!match) return undefined;
  const digits = match[1]!.length <= 4 ? [...match[1]!].map((digit) => digit + digit).join("") : match[1]!;
  return { hex: `#${digits.slice(0, 6).toLowerCase()}`, alpha: digits.length === 8 ? Math.round(parseInt(digits.slice(6), 16) * 100 / 255) : 100 };
}
export function withAlpha(hex: string, alpha: number): string {
  return alpha >= 100 ? hex : `${hex}${Math.round(Math.max(0, alpha) * 255 / 100).toString(16).padStart(2, "0")}`;
}
/** token 参照を現在の値へ解決する。 */
export function resolveValue(document: PageDocument, value: StyleValue | undefined): string | number | undefined {
  return typeof value === "object" ? document.tokens[value.token]?.value : value;
}
/** CSS の 1〜4 値の shorthand を上・右・下・左（角丸は左上・右上・右下・左下）へ展開する。 */
export function expandBox(value: string | number): (string | number)[] {
  const parts: (string | number)[] = typeof value === "number" ? [value] : value.trim().split(/\s+/);
  const [a, b = a, c = a, d = b] = parts as [string | number, ...(string | number)[]];
  return [a, b, c, d];
}
