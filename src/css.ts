import { resolvePageStyles, type SiteStyles } from "./site-styles.js";
import type { AppearEffect, BlockContracts, NodeStyle, PageDocument, PageNode, StateName, StateProperty, StyleDeclarations, StyleProperty } from "./types.js";
import { parsePageDocument } from "./document.js";
import { declarationCss, motionProperties, tokenCssValue } from "./style-values.js";
import { parseResolvedAssets, resolvedAsset, type ResolvedAssetMap } from "./assets.js";

/** 長さを付けて区切るため、異なる ID の組み合わせが同じ scope にならない。 */
export function pageScope(document: Pick<PageDocument, "siteId" | "pageId" | "locale" | "revision">): string {
  return "nw-" + [document.siteId, document.pageId, document.locale, String(document.revision)]
    .map((value) => `${value.length}-${value}`).join("-");
}
// 遷移は状態スタイルを持つノードの動きの規則だけに出す。
const motion = new Set<string>(motionProperties);
const sideBorderWidths = new Set<string>(["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]);
function declarations(values: StyleDeclarations, assets: ResolvedAssetMap): string {
  const properties = (Object.keys(values) as (StyleProperty | "backgroundImage")[]).filter((property) => !motion.has(property)).sort();
  const commonWidth = properties.indexOf("borderWidth"), firstSideWidth = properties.findIndex((property) => sideBorderWidths.has(property));
  // CSS shorthand は後にあると side-specific longhand を上書きするため、同じ rule 内で先に出す。
  if (commonWidth > firstSideWidth && firstSideWidth >= 0) properties.splice(firstSideWidth, 0, properties.splice(commonWidth, 1)[0]!);
  return properties.map((property) => {
    if (property !== "backgroundImage") return declarationCss(property, values[property]!);
    // src は parseResolvedAssets で引用符・空白・<> を拒否済み。解決できない宣言だけ省く。
    const resolved = resolvedAsset(assets, values.backgroundImage!.asset);
    return resolved ? `background-image:url("${resolved.src}");` : "";
  }).join("");
}
const reduced = "@media (prefers-reduced-motion:no-preference)";
const transitionNames: readonly [StateProperty, string][] = [["color", "color"], ["backgroundColor", "background-color"], ["borderColor", "border-color"], ["opacity", "opacity"],
  ["translate", "translate"], ["rotate", "rotate"], ["scale", "scale"], ["skew", "transform"], ["textDecorationLine", "text-decoration-color"]];
// 動き始めの姿だけを持つ。終わりは要素の通常の見た目なので、動かない環境では内容がそのまま見える。
const keyframes: Record<AppearEffect, string> = { fade: "opacity:0", "fade-up": "opacity:0;translate:0 24px", "fade-down": "opacity:0;translate:0 -24px",
  "fade-left": "opacity:0;translate:24px 0", "fade-right": "opacity:0;translate:-24px 0", zoom: "opacity:0;scale:.92" };
const stateRule = (selector: string, state: StateName, body: string) => state === "hover" ? `@media (hover:hover){${selector}:hover{${body}}}` : `${selector}:${state === "focus" ? "focus-visible" : "active"}{${body}}`;
/** @internal エディターのキャンバス用。forceState は選択中の要素へ状態の見た目を擬似クラスなしで重ね、paused は動きを止める。 */
export type CanvasCssOptions = { forceState?: { nodeId: string; state: StateName } | undefined; motion?: "paused" | "play" | undefined };
/** @internal 文書の CSS の後に置く、キャンバスだけの規則。 */
export function canvasCss(document: PageDocument, options: CanvasCssOptions, assets: ResolvedAssetMap = {}): string {
  const rules: string[] = [], scope = pageScope(document), forced = options.forceState;
  if (forced) {
    const visit = (nodes: PageNode[]): NodeStyle | undefined => { for (const node of nodes) { if (node.type === "text") continue; if (node.id === forced.nodeId) return node.style; if (node.type === "element") { const found = visit(node.children); if (found) return found; } } return undefined; };
    const values = visit(document.body)?.states?.[forced.state];
    if (values && Object.keys(values).length) rules.push(`[data-nw-scope="${scope}"] [data-nw-owner="${scope}"][data-nw-node="${forced.nodeId}"][data-nw-node="${forced.nodeId}"]{${declarations(values, assets)}}`);
  }
  if (options.motion === "paused") rules.push(`[data-nw-scope="${scope}"],[data-nw-scope="${scope}"] *{animation:none!important;transition:none!important}`);
  return rules.join("\n");
}
/** @internal 検証済み文書と素材マップだけで利用。公開 API は必ず再検証する。 */
export function cssForDocument(document: PageDocument, assets: ResolvedAssetMap = {}, options: CanvasCssOptions = {}): string {
  const scope = `[data-nw-scope="${pageScope(document)}"]`;
  const rules: string[] = [];
  const tokens = Object.entries(document.tokens).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, token]) => `--nw-${name}:${tokenCssValue(token)};`).join("");
  // box sizing の規則も文書の外には出さない。
  const owner = `[data-nw-owner="${pageScope(document)}"]`;
  rules.push(`${scope}{box-sizing:border-box;${tokens}}`, `${scope} ${owner}[data-nw-node]{box-sizing:border-box;}`);
  // 文字スタイルはノード規則より前に出す。selector の詳細度が同じなので、後に出るノード個別の指定が全幅で勝つ。
  const users = new Map<string, string[]>();
  (function collect(nodes: PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.style?.textStyle) users.set(node.style.textStyle, [...users.get(node.style.textStyle) ?? [], `${scope} ${owner}[data-nw-node="${node.id}"]`]);
      if (node.type === "element") collect(node.children);
    }
  })(document.body);
  for (const [name, style] of Object.entries(document.textStyles ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const selector = users.get(name)?.join(",");
    if (!selector) continue;
    if (Object.keys(style.base).length) rules.push(`${selector}{${declarations(style.base, assets)}}`);
    for (const responsive of style.responsive ?? []) {
      if (Object.keys(responsive.declarations).length) rules.push(`@media (min-width:${responsive.minWidth}px){${selector}{${declarations(responsive.declarations, assets)}}}`);
    }
  }
  function visit(nodes: PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      const selector = `${scope} ${owner}[data-nw-node="${node.id}"]`;
      // 遷移だけの指定は動きの規則に出すので、空の規則を残さない（旧文書の空の規則はそのまま）。
      const motionOnly = (values: StyleDeclarations) => Object.keys(values).some((property) => motion.has(property)) && !declarations(values, assets);
      if (node.style?.base && !motionOnly(node.style.base)) rules.push(`${selector}{${declarations(node.style.base, assets)}}`);
      for (const responsive of node.style?.responsive ?? []) {
        if (!motionOnly(responsive.declarations)) rules.push(`@media (min-width:${responsive.minWidth}px){${selector}{${declarations(responsive.declarations, assets)}}}`);
      }
      if (node.type === "component") for (const [slot, style] of Object.entries(node.slots ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        // ブロックが data-nw-slot を付けた内側の要素。繰り返すカード等、同じ領域のすべてに適用する。
        const inner = `${selector} [data-nw-slot="${slot}"]`;
        if (style.base) rules.push(`${inner}{${declarations(style.base, assets)}}`);
        for (const responsive of style.responsive ?? []) rules.push(`@media (min-width:${responsive.minWidth}px){${inner}{${declarations(responsive.declarations, assets)}}}`);
      }
      if (node.type === "element") visit(node.children);
    }
  }
  visit(document.body);
  // 状態 → 動き（遷移・登場）→ 幅別の非表示の順。非表示は最後なので、どの段の display より優先する。
  const styled: { selector: string; style: NodeStyle }[] = [];
  (function each(nodes: PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      if (node.style) styled.push({ selector: `${scope} ${owner}[data-nw-node="${node.id}"]`, style: node.style });
      if (node.type === "element") each(node.children);
    }
  })(document.body);
  for (const { selector, style } of styled) for (const state of ["hover", "focus", "active"] as const) {
    const values = style.states?.[state];
    if (values && Object.keys(values).length) rules.push(stateRule(selector, state, declarations(values, assets)));
  }
  const paused = options.motion === "paused", effects = new Set<AppearEffect>(), name = (effect: AppearEffect) => `${pageScope(document)}-${effect}`;
  for (const { selector, style } of paused ? [] : styled) {
    const used = new Set(Object.values(style.states ?? {}).flatMap((values) => Object.keys(values)));
    const properties = transitionNames.filter(([property]) => used.has(property)).map(([, css]) => css).join(",");
    const timing = (values: StyleDeclarations | undefined) => motionProperties.filter((property) => values?.[property] !== undefined).map((property) => declarationCss(property, values![property]!)).join("");
    const base = timing(style.base), widths = (style.responsive ?? []).map((entry) => [entry.minWidth, timing(entry.declarations)] as const).filter(([, body]) => body);
    if (properties && (base || widths.length)) {
      rules.push(`${reduced}{${selector}{transition-property:${properties};${base}}}`);
      for (const [minWidth, body] of widths) rules.push(`${reduced} and (min-width:${minWidth}px){${selector}{${body}}}`);
    }
    const appear = style.appear;
    if (!appear) continue;
    effects.add(appear.effect);
    const easing = appear.easing ?? "ease";
    rules.push(appear.trigger === "load" ? `${reduced}{${selector}{animation:${name(appear.effect)} ${appear.duration}ms ${easing} ${appear.delay}ms both}}`
      : `${reduced}{@supports (animation-timeline: view()){${selector}{animation:${name(appear.effect)} auto ${easing} both;animation-timeline:view();animation-range:entry 0% entry 60%}}}`);
  }
  // keyframes は文書 scope 付きの名前で、使われた効果だけ。
  for (const effect of [...effects].sort()) rules.push(`@keyframes ${name(effect)}{from{${keyframes[effect]}}}`);
  for (const { selector, style } of styled) for (const range of style.hidden ?? []) {
    const media = [range.minWidth ? `(min-width:${range.minWidth}px)` : "", range.maxWidth === undefined ? "" : `(max-width:${range.maxWidth}.98px)`].filter(Boolean).join(" and ");
    rules.push(media ? `@media ${media}{${selector}{display:none}}` : `${selector}{display:none}`);
  }
  const extra = canvasCss(document, options, assets);
  if (extra) rules.push(extra);
  return rules.join("\n");
}
export function generatePageCss(input: unknown, blocks: BlockContracts = {}, assets?: unknown, siteStyles?: SiteStyles): string {
  return cssForDocument(resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles), assets === undefined ? {} : parseResolvedAssets(assets));
}
