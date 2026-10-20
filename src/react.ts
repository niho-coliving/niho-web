import { createElement, Fragment, type ComponentType, type ReactElement } from "react";
import type { BlockContract, PageNode, PublicPropValue } from "./types.js";
import { parsePageDocument } from "./document.js";
import { cssForDocument, pageScope } from "./css.js";
import { parseResolvedAssets, resolvedAsset, type ResolvedAssetMap } from "./assets.js";

export type BlockDefinition = BlockContract & {
  /** ホストアプリが所有する同期 React コンポーネント。JSON から実行コードを読まない。 */
  component: ComponentType<Record<string, PublicPropValue>>;
};
export type BlockRegistry = Readonly<Record<string, BlockDefinition>>;
export type PageRendererProps = {
  document: unknown; blocks?: BlockRegistry;
  /** ホストが解決した素材。描画前に検証する。 */
  assets?: ResolvedAssetMap;
  /** 解決できない素材画像。既定は描画しない。placeholder はエディター用。 */
  missingAssets?: "omit" | "placeholder";
};

/** useEffect を使わず、Next.js の初期 HTML と静的 SSR の両方で本文を返す。 */
export function PageRenderer({ document: input, blocks = {}, assets: assetInput, missingAssets = "omit" }: PageRendererProps): ReactElement {
  const document = parsePageDocument(input, blocks);
  const assets = assetInput === undefined ? {} : parseResolvedAssets(assetInput);
  const scope = pageScope(document);
  function render(node: PageNode): ReactElement | string | null {
    if (node.type === "text") return node.text;
    if (node.type === "component") {
      const definition = blocks[node.block]!;
      if (!definition.component) throw new Error(`Registered block has no React component: ${node.block}`);
      // 枠の属性や style をブロックの props へ混ぜない。
      return createElement("div", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-block": node.block }, createElement(definition.component, node.props));
    }
    const attrs = { ...node.attrs };
    if (node.asset) {
      const resolved = resolvedAsset(assets, node.asset);
      if (!resolved) return missingAssets === "placeholder" ? createElement("span", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-missing-asset": "", role: "img",
        "aria-label": typeof attrs.alt === "string" && attrs.alt ? attrs.alt : "画像を表示できません" }) : null;
      attrs.src = resolved.src;
      // 寸法を持たない画像にだけ付け、レイアウトのずれを防ぐ。
      if (attrs.width === undefined && attrs.height === undefined && resolved.width !== undefined && resolved.height !== undefined) { attrs.width = resolved.width; attrs.height = resolved.height; }
    }
    if (node.tag === "a" && attrs.target === "_blank") {
      attrs.rel = [...new Set(`${attrs.rel ?? ""} noopener noreferrer`.trim().split(/\s+/))].join(" ");
    }
    // children を渡さないことで React の void element 契約を守る。
    return createElement(node.tag, { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope },
      ...(node.children.length ? node.children.map(render) : []));
  }
  return createElement(Fragment, null,
    // React 18 HTML-escapes text children inside <style>, which changes CSS selectors.
    // cssForDocument only emits identifiers and values accepted by the closed CSS schema.
    createElement("style", { "data-nw-style": scope, dangerouslySetInnerHTML: { __html: cssForDocument(document, assets) } }),
    createElement("div", { "data-nw-scope": scope, lang: document.locale }, ...document.body.map(render)));
}
