import type { DesignToken, PageDocument, PageNode, TextStyle } from "./types.js";
import { parseTextStyles, parseTokens } from "./style-values.js";

/** サイト設定のスタイル部分。ページ JSON へ継承値を書き戻さない。 */
export type SiteStyles = { tokens?: Record<string, DesignToken>; textStyles?: Record<string, TextStyle> };

/** サイト単体で解決できる参照だけを受け付ける。ページの値による補完は禁止。 */
export function parseSiteStyles(input: SiteStyles): SiteStyles {
  const tokens = input.tokens === undefined ? undefined : parseTokens(input.tokens, "$.site.tokens");
  const textStyles = input.textStyles === undefined ? undefined : parseTextStyles(input.textStyles, tokens ?? {}, "$.site.textStyles");
  return { ...(tokens === undefined ? {} : { tokens }), ...(textStyles === undefined ? {} : { textStyles }) };
}

/** 同名の値はページが優先。継承した文字スタイルも実効 tokens で再検証する。 */
export function mergeSiteStyles(page: SiteStyles, site: SiteStyles = {}): { tokens: Record<string, DesignToken>; textStyles?: Record<string, TextStyle> } {
  const shared = parseSiteStyles(site), tokens = parseTokens({ ...shared.tokens, ...page.tokens }, "$.tokens");
  const hasStyles = shared.textStyles !== undefined || page.textStyles !== undefined;
  const textStyles = hasStyles ? parseTextStyles({ ...shared.textStyles, ...page.textStyles }, tokens, "$.textStyles") : undefined;
  return { tokens, ...(textStyles === undefined ? {} : { textStyles }) };
}

/** 検証・描画・プレビューで共有する実効値。保存する文書には使用しない。 */
export function resolvePageStyles(document: PageDocument, site: SiteStyles = {}): PageDocument {
  return { ...document, ...mergeSiteStyles(document, site) };
}

/** 編集用の実効値から、変更のない継承値だけを外してページの保存形式に戻す。 */
export function retainPageStyles(document: PageDocument, original: PageDocument, site: SiteStyles): PageDocument {
  const copy = { ...document, tokens: { ...document.tokens }, ...(document.textStyles ? { textStyles: { ...document.textStyles } } : {}) };
  for (const name of Object.keys(site.tokens ?? {})) if (!Object.hasOwn(original.tokens, name) && JSON.stringify(copy.tokens[name]) === JSON.stringify(site.tokens![name])) delete copy.tokens[name];
  for (const name of Object.keys(site.textStyles ?? {})) if (!Object.hasOwn(original.textStyles ?? {}, name) && JSON.stringify(copy.textStyles?.[name]) === JSON.stringify(site.textStyles![name])) delete copy.textStyles?.[name];
  if (copy.textStyles && !Object.keys(copy.textStyles).length && original.textStyles === undefined) delete copy.textStyles;
  return copy;
}

/** サイトで削除する定義をページ所有へ切り離す。全 draft / 公開参照の原子的保存はホストが行う。 */
export function detachRemovedSiteStyles(document: PageDocument, before: SiteStyles, after: SiteStyles): PageDocument {
  const old = parseSiteStyles(before), next = parseSiteStyles(after), copy = structuredClone(document);
  const removedSiteTokens = new Set(Object.keys(old.tokens ?? {}).filter((name) => !Object.hasOwn(next.tokens ?? {}, name)));
  const removedTokens = new Set([...removedSiteTokens].filter((name) => !Object.hasOwn(document.tokens, name)));
  const removedStyles = Object.keys(old.textStyles ?? {}).filter((name) => !Object.hasOwn(next.textStyles ?? {}, name) && !Object.hasOwn(document.textStyles ?? {}, name));
  const usedStyles = new Set<string>();
  const visit = (nodes: readonly PageNode[]): void => { for (const node of nodes) { if (node.type === "text") continue; if (node.style?.textStyle) usedStyles.add(node.style.textStyle); if (node.type === "element") visit(node.children); } };
  visit(document.body);
  // 削除する文字スタイルをページの override として保持することで responsive とノード指定の優先順位を保存する。
  for (const name of removedStyles) if (usedStyles.has(name)) (copy.textStyles ??= {})[name] = structuredClone(old.textStyles![name]!);
  // 残る共有文字スタイルが削除 token を使う場合も、ページの実効値を固定する。
  for (const [name, style] of Object.entries(old.textStyles ?? {})) if (usedStyles.has(name) && !Object.hasOwn(copy.textStyles ?? {}, name) && JSON.stringify(style).includes('"token"')) {
    const references = [style.base, ...(style.responsive ?? []).map((entry) => entry.declarations)].some((values) => Object.values(values).some((value) => typeof value === "object" && removedSiteTokens.has(value.token)));
    if (references) (copy.textStyles ??= {})[name] = structuredClone(style);
  }
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== "object") return value;
    if ("token" in value && typeof value.token === "string" && removedTokens.has(value.token)) return old.tokens![value.token]!.value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
  };
  copy.body = replace(copy.body) as PageDocument["body"];
  if (copy.textStyles) copy.textStyles = replace(copy.textStyles) as NonNullable<PageDocument["textStyles"]>;
  return copy;
}
