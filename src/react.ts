import { resolvePageStyles, type SiteStyles } from "./site-styles.js";
import { createElement, Fragment, type ComponentType, type ReactElement } from "react";
import type { BlockContract, PageDocument, PageNode, PublicPropValue, SitePresentation, SitePresentationExternalFrame, SitePresentationHostView, SitePresentationOverlay } from "./types.js";
import { parsePageDocument } from "./document.js";
import { cssForDocument, pageScope } from "./css.js";
import { parseResolvedAssets, resolvedAsset, type ResolvedAssetMap } from "./assets.js";
import { cssForSitePresentation, parseSitePresentation, presentationLayoutDocument, sitePresentationHostViewKey } from "./presentation.js";

export type BlockDefinition = BlockContract & {
  /** ホストアプリが所有する同期 React コンポーネント。JSON から実行コードを読まない。 */
  component: ComponentType<Record<string, PublicPropValue>>;
};
export type BlockRegistry = Readonly<Record<string, BlockDefinition>>;
/** 実行コード側だけで指定する外部frame policy。snapshotから権限を要求できない。 */
export type ExternalFramePolicy = (frame: Readonly<SitePresentationExternalFrame>) => "opaque" | "retain-origin";
export function createExternalFramePolicy({ parentOrigin, sources }: { parentOrigin: string; sources: readonly string[] }): ExternalFramePolicy {
  const parent = new URL(parentOrigin);
  if (!Array.isArray(sources) || sources.length > 16) throw new Error("Invalid external frame policy");
  const allowed = sources.map((source) => {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin === parent.origin) throw new Error("Frame origin retention requires a trusted external HTTPS source");
    return url;
  });
  return (frame) => {
    const url = new URL(frame.src);
    return !url.username && !url.password && !url.hash && allowed.some((source) => source.origin === url.origin && source.pathname === url.pathname) ? "retain-origin" : "opaque";
  };
}
export type PageRendererProps = {
  document: unknown; blocks?: BlockRegistry;
  siteStyles?: SiteStyles;
  /** ホストが解決した素材。描画前に検証する。 */
  assets?: ResolvedAssetMap;
  /** 解決できない素材画像。既定は描画しない。placeholder はエディター用。 */
  missingAssets?: "omit" | "placeholder";
  /** @internal SitePageRendererが検証済みoverlay controlへ付ける既知属性。 */
  overlayBindings?: readonly SitePresentationOverlay[];
  /** @internal SitePageRendererが検証済みhost block viewを解決する。 */
  hostViews?: readonly SitePresentationHostView[];
  /** @internal host view文書に既知属性だけを付ける。 */
  hostViewBinding?: SitePresentationHostView;
  /** display-only host viewの優先方法。公開hostはfallback/offで実componentを選べる。 */
  hostViewMode?: "prefer" | "fallback" | "off";
  externalFramePolicy?: ExternalFramePolicy;
};

/** useEffect を使わず、Next.js の初期 HTML と静的 SSR の両方で本文を返す。 */
export function PageRenderer({ document: input, blocks = {}, assets: assetInput, missingAssets = "omit", siteStyles, overlayBindings = [], hostViews = [], hostViewBinding, hostViewMode = "prefer", externalFramePolicy }: PageRendererProps): ReactElement {
  const document = resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles);
  const assets = assetInput === undefined ? {} : parseResolvedAssets(assetInput);
  const scope = pageScope(document);
  function render(node: PageNode): ReactElement | string | null {
    if (node.type === "text") return node.text;
    // 部品ライブラリなしの検証で拒否済み。下書きは resolvePageDocument で展開してから描画する。
    if (node.type === "instance") throw new Error("Unresolved component instance: resolve the document before rendering");
    if (node.type === "component") {
      const candidates = hostViews.filter((view) => view.block === node.block);
      const definition = blocks[node.block]!;
      if (candidates.length && hostViewMode !== "off" && (hostViewMode === "prefer" || !definition?.component)) {
        const view = candidates.find((candidate) => sitePresentationHostViewKey(candidate.block, candidate.props) === sitePresentationHostViewKey(node.block, node.props));
        if (!view) throw new Error(`Registered host view is missing for block props: ${node.block}`);
        return createElement("div", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-block": node.block, "data-nw-host-view": view.id },
          createElement(PageRenderer, { document: view.document, assets, missingAssets, hostViewBinding: view, hostViewMode: "off", ...(externalFramePolicy ? { externalFramePolicy } : {}) }));
      }
      if (!definition?.component) throw new Error(`Registered block has no React component: ${node.block}`);
      // 枠の属性や style をブロックの props へ混ぜない。
      return createElement("div", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-block": node.block }, createElement(definition.component, node.props));
    }
    const attrs = { ...node.attrs };
    if (hostViewBinding) {
      for (const [slot, ids] of Object.entries(hostViewBinding.slotBindings ?? {})) if (ids.includes(node.id)) attrs["data-nw-slot"] = slot;
      const binding = hostViewBinding.carousel;
      if (binding?.rootId === node.id) {
        attrs["data-nw-carousel"] = hostViewBinding.id;
        attrs["data-nw-carousel-loop"] = String(binding.loop !== false);
        attrs["data-nw-carousel-swipe"] = String(binding.swipe === true);
        if (binding.fadeMs !== undefined) attrs["data-nw-carousel-fade"] = binding.fadeMs;
        if (binding.autoplayMs !== undefined) attrs["data-nw-carousel-autoplay"] = binding.autoplayMs;
        if (binding.initiallyPlaying === false) attrs["data-nw-carousel-paused"] = "true";
      }
      const slide = binding?.slideIds.indexOf(node.id) ?? -1;
      if (slide >= 0) { attrs["data-nw-carousel-slide"] = slide; attrs["aria-hidden"] = slide === 0 ? "false" : "true"; if (slide !== 0) attrs.hidden = true; }
      if (binding?.previousIds?.includes(node.id)) attrs["data-nw-carousel-previous"] = "";
      if (binding?.nextIds?.includes(node.id)) attrs["data-nw-carousel-next"] = "";
      if (binding?.playPauseIds?.includes(node.id)) { attrs["data-nw-carousel-play-pause"] = ""; attrs["aria-pressed"] = String(binding.initiallyPlaying === false); }
    }
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
    const frame = hostViewBinding?.externalFrames?.find((candidate) => candidate.nodeId === node.id);
    if (frame) return createElement("iframe", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, src: frame.src, title: frame.title,
      loading: frame.loading ?? "lazy", referrerPolicy: frame.referrerPolicy ?? "strict-origin-when-cross-origin", sandbox: externalFramePolicy?.(frame) === "retain-origin" ? "allow-scripts allow-same-origin" : "allow-scripts",
      style: { width: "100%", height: "100%", border: 0, display: "block" },
      ...(frame.frameKey ? { "data-nw-frame-key": frame.frameKey, "data-nw-frame-max-height": frame.autoHeightMax ?? 1200 } : {}),
      ...(frame.allowFullScreen ? { allowFullScreen: true } : {}) });
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
export function SitePageRenderer({ document: input, presentation: presentationInput, blocks = {}, assets: assetInput, missingAssets = "omit", siteStyles, hostViewMode = "prefer", externalFramePolicy }: SitePageRendererProps): ReactElement {
  const document = resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles);
  const presentation: SitePresentation = parseSitePresentation(presentationInput, document, blocks);
  const assets = assetInput === undefined ? {} : parseResolvedAssets(assetInput);
  const output = cssForSitePresentation(presentation, document, blocks, assets), layout = presentationLayoutDocument(presentation);
  const layoutScope = pageScope(layout), shared = presentation.shared;
  const overlays = presentation.overlays ?? [], hostViews = presentation.hostViews ?? [];
  const hostOptions = { hostViews, hostViewMode, ...(externalFramePolicy ? { externalFramePolicy } : {}) };
  const header: PageDocument = document.pageId === shared.header.pageId ? document : shared.header;
  const footer: PageDocument = document.pageId === shared.footer.pageId ? document : shared.footer;
  const body = document.pageId === shared.header.pageId || document.pageId === shared.footer.pageId ? null
    : overlays.some((overlay) => document.pageId === overlay.document.pageId) ? null
    : createElement("main", { "data-nw-presentation-body": "" }, createElement(PageRenderer, { document, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions, ...(siteStyles ? { siteStyles } : {}) }));
  return createElement(Fragment, null,
    createElement("style", { "data-nw-presentation-style": output.scope, dangerouslySetInnerHTML: { __html: output.css } }),
    createElement("div", { "data-nw-presentation": output.scope, "data-nw-scope": layoutScope, lang: document.locale },
      createElement("div", { "data-nw-owner": layoutScope, "data-nw-node": "layout" },
      createElement("div", { "data-nw-presentation-header": "" }, createElement(PageRenderer, { document: header, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions })),
      body,
      createElement("div", { "data-nw-presentation-footer": "" }, createElement(PageRenderer, { document: footer, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions })),
      ...overlays.map((overlay) => {
        const editing = document.pageId === overlay.document.pageId, overlayDocument = editing ? document : overlay.document;
        return createElement("div", { key: overlay.id, id: overlay.id, role: "dialog", "aria-modal": "true", "aria-label": overlay.label, tabIndex: -1, "data-nw-overlay": overlay.id,
          ...(editing ? { "data-nw-overlay-editing": "" } : { hidden: true }) },
          createElement("button", { type: "button", tabIndex: -1, "aria-hidden": "true", "aria-label": overlay.label + "を閉じる", "data-nw-overlay-backdrop": "", "data-nw-overlay-close": overlay.id }),
          createElement("div", { "data-nw-overlay-content": "" }, createElement(PageRenderer, { document: overlayDocument, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions })));
      }))));
}
