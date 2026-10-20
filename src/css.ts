import type { BlockContracts, PageDocument, PageNode, StyleDeclarations, StyleProperty } from "./types.js";
import { parsePageDocument } from "./document.js";
import { declarationCss, tokenCssValue } from "./style-values.js";
import { parseResolvedAssets, resolvedAsset, type ResolvedAssetMap } from "./assets.js";

/** 長さを付けて区切るため、異なる ID の組み合わせが同じ scope にならない。 */
export function pageScope(document: Pick<PageDocument, "siteId" | "pageId" | "locale" | "revision">): string {
  return "nw-" + [document.siteId, document.pageId, document.locale, String(document.revision)]
    .map((value) => `${value.length}-${value}`).join("-");
}
function declarations(values: StyleDeclarations, assets: ResolvedAssetMap): string {
  return (Object.keys(values) as (StyleProperty | "backgroundImage")[]).sort().map((property) => {
    if (property !== "backgroundImage") return declarationCss(property, values[property]!);
    // src は parseResolvedAssets で引用符・空白・<> を拒否済み。解決できない宣言だけ省く。
    const resolved = resolvedAsset(assets, values.backgroundImage!.asset);
    return resolved ? `background-image:url("${resolved.src}");` : "";
  }).join("");
}
/** @internal 検証済み文書と素材マップだけで利用。公開 API は必ず再検証する。 */
export function cssForDocument(document: PageDocument, assets: ResolvedAssetMap = {}): string {
  const scope = `[data-nw-scope="${pageScope(document)}"]`;
  const rules: string[] = [];
  const tokens = Object.entries(document.tokens).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, token]) => `--nw-${name}:${tokenCssValue(token)};`).join("");
  // box sizing の規則も文書の外には出さない。
  const owner = `[data-nw-owner="${pageScope(document)}"]`;
  rules.push(`${scope}{box-sizing:border-box;${tokens}}`, `${scope} ${owner}[data-nw-node]{box-sizing:border-box;}`);
  function visit(nodes: PageNode[]): void {
    for (const node of nodes) {
      if (node.type === "text") continue;
      const selector = `${scope} ${owner}[data-nw-node="${node.id}"]`;
      if (node.style?.base) rules.push(`${selector}{${declarations(node.style.base, assets)}}`);
      for (const responsive of node.style?.responsive ?? []) {
        rules.push(`@media (min-width:${responsive.minWidth}px){${selector}{${declarations(responsive.declarations, assets)}}}`);
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
  return rules.join("\n");
}
export function generatePageCss(input: unknown, blocks: BlockContracts = {}, assets?: unknown): string {
  return cssForDocument(parsePageDocument(input, blocks), assets === undefined ? {} : parseResolvedAssets(assets));
}
