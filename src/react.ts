import { resolvePageStyles, type SiteStyles } from "./site-styles.js";
import { createElement, Fragment, type ComponentType, type ReactElement } from "react";
import type { BlockContract, PageDocument, PageNode, PublicPropValue, SitePresentation, SitePresentationOverlay } from "./types.js";
import { parsePageDocument } from "./document.js";
import { cssForDocument, pageScope } from "./css.js";
import { parseResolvedAssets, resolvedAsset, type ResolvedAssetMap } from "./assets.js";
import { cssForSitePresentation, parseSitePresentation, presentationLayoutDocument } from "./presentation.js";

export type BlockDefinition = BlockContract & {
  /** ホストアプリが所有する同期 React コンポーネント。JSON から実行コードを読まない。 */
  component: ComponentType<Record<string, PublicPropValue>>;
};
export type BlockRegistry = Readonly<Record<string, BlockDefinition>>;
export type PageRendererProps = {
  document: unknown; blocks?: BlockRegistry;
  siteStyles?: SiteStyles;
  /** ホストが解決した素材。描画前に検証する。 */
  assets?: ResolvedAssetMap;
  /** 解決できない素材画像。既定は描画しない。placeholder はエディター用。 */
  missingAssets?: "omit" | "placeholder";
  /** @internal SitePageRendererが検証済みoverlay controlへ付ける既知属性。 */
  overlayBindings?: readonly SitePresentationOverlay[];
};

/** useEffect を使わず、Next.js の初期 HTML と静的 SSR の両方で本文を返す。 */
export function PageRenderer({ document: input, blocks = {}, assets: assetInput, missingAssets = "omit", siteStyles, overlayBindings = [] }: PageRendererProps): ReactElement {
  const document = resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles);
  const assets = assetInput === undefined ? {} : parseResolvedAssets(assetInput);
  const scope = pageScope(document);
  function render(node: PageNode): ReactElement | string | null {
    if (node.type === "text") return node.text;
    // 部品ライブラリなしの検証で拒否済み。下書きは resolvePageDocument で展開してから描画する。
    if (node.type === "instance") throw new Error("Unresolved component instance: resolve the document before rendering");
    if (node.type === "component") {
      const definition = blocks[node.block]!;
      if (!definition.component) throw new Error(`Registered block has no React component: ${node.block}`);
      // 枠の属性や style をブロックの props へ混ぜない。
      return createElement("div", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-block": node.block }, createElement(definition.component, node.props));
    }
    const attrs = { ...node.attrs };
    const htmlId = typeof attrs.id === "string" ? attrs.id : undefined;
    const opens = htmlId ? overlayBindings.find((overlay) => overlay.triggerIds.includes(htmlId)) : undefined;
    const closes = htmlId ? overlayBindings.find((overlay) => overlay.closeIds.includes(htmlId)) : undefined;
    if (opens) { attrs["aria-controls"] = opens.id; attrs["aria-expanded"] = "false"; attrs["data-nw-overlay-open"] = opens.id; }
    if (closes) attrs["data-nw-overlay-close"] = closes.id;
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

export type SitePageRendererProps = PageRendererProps & { presentation: unknown };
/**
 * PageEditor と SSR が共有する native site composition。
 * 編集対象が canonical header/footer 自身なら、その文書を該当 slot にだけ置き、本文へ複製しない。
 */
export function SitePageRenderer({ document: input, presentation: presentationInput, blocks = {}, assets: assetInput, missingAssets = "omit", siteStyles }: SitePageRendererProps): ReactElement {
  const document = resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles);
  const presentation: SitePresentation = parseSitePresentation(presentationInput, document, blocks);
  const assets = assetInput === undefined ? {} : parseResolvedAssets(assetInput);
  const output = cssForSitePresentation(presentation, document, blocks, assets), layout = presentationLayoutDocument(presentation);
  const layoutScope = pageScope(layout), shared = presentation.shared;
  const overlays = presentation.overlays ?? [];
  const header: PageDocument = document.pageId === shared.header.pageId ? document : shared.header;
  const footer: PageDocument = document.pageId === shared.footer.pageId ? document : shared.footer;
  const body = document.pageId === shared.header.pageId || document.pageId === shared.footer.pageId ? null
    : overlays.some((overlay) => document.pageId === overlay.document.pageId) ? null
    : createElement("main", { "data-nw-presentation-body": "" }, createElement(PageRenderer, { document, blocks, assets, missingAssets, overlayBindings: overlays, ...(siteStyles ? { siteStyles } : {}) }));
  return createElement(Fragment, null,
    createElement("style", { "data-nw-presentation-style": output.scope, dangerouslySetInnerHTML: { __html: output.css } }),
    createElement("div", { "data-nw-presentation": output.scope, "data-nw-scope": layoutScope, lang: document.locale },
      createElement("div", { "data-nw-owner": layoutScope, "data-nw-node": "layout" },
      createElement("div", { "data-nw-presentation-header": "" }, createElement(PageRenderer, { document: header, blocks, assets, missingAssets, overlayBindings: overlays })),
      body,
      createElement("div", { "data-nw-presentation-footer": "" }, createElement(PageRenderer, { document: footer, blocks, assets, missingAssets, overlayBindings: overlays })),
      ...overlays.map((overlay) => {
        const editing = document.pageId === overlay.document.pageId, overlayDocument = editing ? document : overlay.document;
        return createElement("div", { key: overlay.id, id: overlay.id, role: "dialog", "aria-modal": "true", "aria-label": overlay.label, tabIndex: -1, "data-nw-overlay": overlay.id,
          ...(editing ? { "data-nw-overlay-editing": "" } : { hidden: true }) },
          createElement("button", { type: "button", tabIndex: -1, "aria-hidden": "true", "aria-label": overlay.label + "を閉じる", "data-nw-overlay-backdrop": "", "data-nw-overlay-close": overlay.id }),
          createElement("div", { "data-nw-overlay-content": "" }, createElement(PageRenderer, { document: overlayDocument, blocks, assets, missingAssets, overlayBindings: overlays })));
      }))));
}
