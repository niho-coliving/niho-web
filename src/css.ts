import type { BlockContracts, PageDocument, PageNode, StyleDeclarations, StyleProperty } from "./types.js";
import { parsePageDocument } from "./document.js";
import { declarationCss, tokenCssValue } from "./style-values.js";

/** 長さを付けて区切るため、異なる ID の組み合わせが同じ scope にならない。 */
export function pageScope(document: Pick<PageDocument, "siteId" | "pageId" | "locale" | "revision">): string {
  return "nw-" + [document.siteId, document.pageId, document.locale, String(document.revision)]
    .map((value) => `${value.length}-${value}`).join("-");
}
function declarations(values: StyleDeclarations): string {
  return (Object.keys(values) as StyleProperty[]).sort().map((property) => declarationCss(property, values[property]!)).join("");
}
/** @internal 検証済み文書だけで利用。公開 API は必ず再検証する。 */
export function cssForDocument(document: PageDocument): string {
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
      if (node.style?.base) rules.push(`${selector}{${declarations(node.style.base)}}`);
      for (const responsive of node.style?.responsive ?? []) {
        rules.push(`@media (min-width:${responsive.minWidth}px){${selector}{${declarations(responsive.declarations)}}}`);
      }
      if (node.type === "element") visit(node.children);
    }
  }
  visit(document.body);
  return rules.join("\n");
}
export function generatePageCss(input: unknown, blocks: BlockContracts = {}): string {
  return cssForDocument(parsePageDocument(input, blocks));
}
