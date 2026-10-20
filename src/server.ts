import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageRenderer, type BlockRegistry } from "./react.js";
import type { ResolvedAssetMap } from "./assets.js";

/** Astro 等の build/server 用。本文と scoped style を含む断片を返す。 */
export function renderPageToHtml(document: unknown, blocks: BlockRegistry = {}, options: { assets?: ResolvedAssetMap } = {}): string {
  return renderToStaticMarkup(createElement(PageRenderer, { document, blocks, ...(options.assets === undefined ? {} : { assets: options.assets }) }));
}
