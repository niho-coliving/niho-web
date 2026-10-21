import { parsePageDocument, type PageParseOptions } from "./document.js";
import { textStyleUsage, tokenUsage } from "./style-model.js";
import { parseTextStyles, parseTokens } from "./style-values.js";
import type { BlockContracts, DesignToken, PageDocument, SiteStyleLibrary, TextStyle } from "./types.js";
import { fail, identifier, keys, record } from "./validation-utils.js";

export type { SiteStyleLibrary } from "./types.js";

const pageFields = ["schemaVersion", "siteId", "pageId", "locale", "revision", "title", "meta", "tokens", "textStyles", "body"] as const;

function parseLibrary(input: unknown, path: string): SiteStyleLibrary {
  const source = record(input, path);
  keys(source, ["schemaVersion", "siteId", "revision", "tokens", "textStyles"], path);
  if (source.schemaVersion !== 1) fail(`${path}.schemaVersion`, "unsupported schema version");
  const siteId = identifier(source.siteId, `${path}.siteId`);
  if (typeof source.revision !== "number" || !Number.isSafeInteger(source.revision) || source.revision < 1) {
    fail(`${path}.revision`, "expected positive safe integer");
  }
  const tokens = parseTokens(source.tokens, `${path}.tokens`);
  const textStyles = parseTextStyles(source.textStyles, tokens, `${path}.textStyles`);
  return { schemaVersion: 1, siteId, revision: source.revision, tokens, textStyles };
}

/** 外部 JSON を閉じた CSS schema で検証し、入力から切り離した snapshot を返す。 */
export function parseSiteStyleLibrary(input: unknown): SiteStyleLibrary {
  return parseLibrary(input, "$");
}

type Prepared = {
  source: Record<string, unknown>;
  library: SiteStyleLibrary;
  localTokens: Record<string, DesignToken>;
  localTextStyles: Record<string, TextStyle>;
  effectiveTokens: Record<string, DesignToken>;
  effectiveTextStyles: Record<string, TextStyle>;
};

function prepare(input: unknown, siteStyles: unknown): Prepared {
  const source = record(input, "$"), library = parseLibrary(siteStyles, "$.siteStyles");
  keys(source, pageFields, "$");
  const siteId = identifier(source.siteId, "$.siteId");
  if (siteId !== library.siteId) fail("$.siteId", "site style library belongs to another site");
  const localTokens = parseTokens(source.tokens, "$.tokens");
  const effectiveTokens = { ...library.tokens, ...localTokens };
  // ページ上書きで token の型が変わった場合も、共有文字スタイルを再検証して fail closed にする。
  const sharedTextStyles = parseTextStyles(library.textStyles, effectiveTokens, "$.siteStyles.textStyles");
  const localTextStyles = source.textStyles === undefined ? {} : parseTextStyles(source.textStyles, effectiveTokens, "$.textStyles");
  return { source, library, localTokens, localTextStyles, effectiveTokens,
    effectiveTextStyles: { ...sharedTextStyles, ...localTextStyles } };
}

/** raw page を保存用のまま保ち、明示された共通 snapshot と合成した有効文書を返す。 */
export function materializeSiteStyles(
  input: unknown,
  siteStyles: unknown,
  blocks: BlockContracts = {},
  options: PageParseOptions = {}
): PageDocument {
  const prepared = prepare(input, siteStyles);
  return parsePageDocument({ ...prepared.source, tokens: prepared.effectiveTokens, textStyles: prepared.effectiveTextStyles }, blocks, options);
}

/** 共通設定を切り離しても見た目が変わらないよう、参照中の定義だけをページローカルへ移す。 */
export function detachSiteStyles(
  input: unknown,
  siteStyles: unknown,
  blocks: BlockContracts = {},
  options: PageParseOptions = {}
): PageDocument {
  const prepared = prepare(input, siteStyles);
  const effective = parsePageDocument({ ...prepared.source, tokens: prepared.effectiveTokens, textStyles: prepared.effectiveTextStyles }, blocks, options);
  const localTextStyles = { ...prepared.localTextStyles };
  for (const name of Object.keys(prepared.library.textStyles)) {
    if (!Object.hasOwn(localTextStyles, name) && textStyleUsage(effective, name).length) localTextStyles[name] = prepared.effectiveTextStyles[name]!;
  }
  // 未使用の共有文字スタイルから token を拾わないよう、ページに残す文字スタイルだけで使用状況を調べる。
  const inspected: PageDocument = { ...effective, textStyles: localTextStyles };
  const localTokens = { ...prepared.localTokens };
  for (const name of Object.keys(prepared.library.tokens)) {
    if (!Object.hasOwn(localTokens, name)) {
      const usage = tokenUsage(inspected, name);
      if (usage.nodes.length || usage.textStyles.length) localTokens[name] = prepared.effectiveTokens[name]!;
    }
  }
  const detached = { ...prepared.source, tokens: localTokens,
    ...(Object.keys(localTextStyles).length || prepared.source.textStyles !== undefined ? { textStyles: localTextStyles } : {}) };
  return parsePageDocument(detached, blocks, options);
}

export type SiteStyleImportConflict = { kind: "token" | "textStyle"; name: string };
export type SiteStyleImportPlan = {
  tokens: Record<string, DesignToken>;
  textStyles: Record<string, TextStyle>;
  conflicts: SiteStyleImportConflict[];
};

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => same(value, right[index]));
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key) && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** ページローカル定義を共通設定へ取り込む候補を返す。既存の同名定義は決して上書きしない。 */
export function planSiteStyleImport(
  input: unknown,
  siteStyles: unknown,
  blocks: BlockContracts = {},
  options: PageParseOptions = {}
): SiteStyleImportPlan {
  const prepared = prepare(input, siteStyles);
  // body の参照を含む有効文書全体も検証してから計画を返す。
  parsePageDocument({ ...prepared.source, tokens: prepared.effectiveTokens, textStyles: prepared.effectiveTextStyles }, blocks, options);
  const tokens: Record<string, DesignToken> = {}, textStyles: Record<string, TextStyle> = {}, conflicts: SiteStyleImportConflict[] = [];
  for (const [name, token] of Object.entries(prepared.localTokens)) {
    const shared = prepared.library.tokens[name];
    if (shared === undefined) tokens[name] = token;
    else if (!same(shared, token)) conflicts.push({ kind: "token", name });
  }
  for (const [name, style] of Object.entries(prepared.localTextStyles)) {
    const shared = prepared.library.textStyles[name];
    if (shared === undefined) textStyles[name] = style;
    else if (!same(shared, style)) conflicts.push({ kind: "textStyle", name });
  }
  return { tokens, textStyles, conflicts };
}
