import type { SiteStyles } from "./site-styles.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageRenderer, SitePageRenderer, type BlockRegistry, type ExternalFramePolicy } from "./react.js";
import type { ResolvedAssetMap } from "./assets.js";

/** Astro 等の build/server 用。本文と scoped style を含む断片を返す。 */
export function renderPageToHtml(document: unknown, blocks: BlockRegistry = {}, options: { assets?: ResolvedAssetMap; siteStyles?: SiteStyles } = {}): string {
  return renderToStaticMarkup(createElement(PageRenderer, { document, blocks, ...(options.siteStyles ? { siteStyles: options.siteStyles } : {}), ...(options.assets === undefined ? {} : { assets: options.assets }) }));
}

/** PageEditor canvas と同じ native site composition を静的 HTML にする。 */
export function renderSitePageToHtml(document: unknown, presentation: unknown, blocks: BlockRegistry = {}, options: { assets?: ResolvedAssetMap; siteStyles?: SiteStyles; hostViewMode?: "prefer" | "fallback" | "off"; externalFramePolicy?: ExternalFramePolicy } = {}): string {
  return renderToStaticMarkup(createElement(SitePageRenderer, { document, presentation, blocks, ...(options.siteStyles ? { siteStyles: options.siteStyles } : {}), ...(options.assets === undefined ? {} : { assets: options.assets }), ...(options.hostViewMode === undefined ? {} : { hostViewMode: options.hostViewMode }), ...(options.externalFramePolicy ? { externalFramePolicy: options.externalFramePolicy } : {}) }));
}
