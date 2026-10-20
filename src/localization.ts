import { parseComponentLibrary } from "./components.js";
import { parsePageDocument } from "./document.js";
import type {
  BlockContracts, ComponentDefinition, ComponentNode, ElementNode, InstanceNode, PageDocument, PageNode
} from "./types.js";
import { fail, identifier, keys, line, localeCode, parseAssetReference, publicImageSrcSet, publicImageUrl, record, string } from "./validation-utils.js";
import type {
  BlockLocalizationSchema, LocalizationCollection, LocalizationDraftEntry, LocalizationExtractionOptions, LocalizationIssue, LocalizationLocale,
  LocalizationOverlay, LocalizationStatus, LocalizationUnit, LocalizationUnitScope, LocalizationValue, LocalizationValueKind, LocalizedRichText,
  LocalizedDocumentSaveValidation, LocalizedRichTextNode, MaterializedLocalization, SiteLocalizationConfig, TranslationCandidate, TranslationResult
} from "./localization-types.js";

export type * from "./localization-types.js";

const LOCALES: readonly LocalizationLocale[] = ["ja", "en"];
const INLINE_TAGS = new Set(["a", "strong", "em", "b", "i", "small", "span", "br"]);
const RICH_GROUP_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "a", "strong", "em", "b", "i", "small", "time", "summary", "blockquote", "figcaption", "li", "dt", "dd"]);
const INLINE_ONLY_GROUP_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "a", "strong", "em", "b", "i", "small", "time", "summary"]);
const MAX_UNITS = 10_000;
const MAX_VALUE_TEXT = 100_000;
const MAX_RICH_DEPTH = 48;
const MAX_PROTECTED_REFERENCES = 2_000;

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(path, "expected positive safe integer");
  return value;
}
function localizationLocale(value: unknown, path: string): LocalizationLocale {
  if (typeof value !== "string" || !LOCALES.includes(value as LocalizationLocale)) fail(path, "unsupported localization locale");
  return value as LocalizationLocale;
}
function fingerprint(value: unknown, path: string): string {
  const result = string(value, path, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) fail(path, "invalid source fingerprint");
  return result;
}
function detached<T>(value: T): T { return structuredClone(value); }

/** Validate config without inventing a source locale or inferring one from site metadata. */
export function parseSiteLocalizationConfig(input: unknown): SiteLocalizationConfig {
  const source = record(input, "$config");
  keys(source, ["schemaVersion", "siteId", "sourceLocale", "defaultLocale", "enabledLocales", "documentLocales", "glossaryVersion", "contextVersion"], "$config");
  if (source.schemaVersion !== 1) fail("$config.schemaVersion", "unsupported schema version");
  const siteId = identifier(source.siteId, "$config.siteId");
  const sourceLocale = localizationLocale(source.sourceLocale, "$config.sourceLocale");
  const defaultLocale = localizationLocale(source.defaultLocale, "$config.defaultLocale");
  if (!Array.isArray(source.enabledLocales) || source.enabledLocales.length < 1 || source.enabledLocales.length > LOCALES.length) {
    fail("$config.enabledLocales", "expected a bounded locale array");
  }
  const enabledLocales = source.enabledLocales.map((value, index) => localizationLocale(value, `$config.enabledLocales[${index}]`));
  if (new Set(enabledLocales).size !== enabledLocales.length) fail("$config.enabledLocales", "duplicate locale");
  if (!enabledLocales.includes(sourceLocale)) fail("$config.sourceLocale", "source locale must be enabled");
  if (!enabledLocales.includes(defaultLocale)) fail("$config.defaultLocale", "default locale must be enabled");
  const mappings = record(source.documentLocales, "$config.documentLocales");
  keys(mappings, LOCALES, "$config.documentLocales");
  const documentLocales = {
    ja: localeCode(mappings.ja, "$config.documentLocales.ja"),
    en: localeCode(mappings.en, "$config.documentLocales.en")
  };
  if (documentLocales.ja.split("-", 1)[0]!.toLowerCase() !== "ja") fail("$config.documentLocales.ja", "document locale must use the ja language family");
  if (documentLocales.en.split("-", 1)[0]!.toLowerCase() !== "en") fail("$config.documentLocales.en", "document locale must use the en language family");
  if (documentLocales.ja === documentLocales.en) fail("$config.documentLocales", "document locale mappings must be distinct");
  const glossaryVersion = line(source.glossaryVersion, "$config.glossaryVersion", 80);
  const contextVersion = line(source.contextVersion, "$config.contextVersion", 80);
  return { schemaVersion: 1, siteId, sourceLocale, defaultLocale, enabledLocales, documentLocales, glossaryVersion, contextVersion };
}

export function documentLocaleFor(configInput: unknown, localeInput: unknown): string {
  const config = parseSiteLocalizationConfig(configInput), locale = localizationLocale(localeInput, "$locale");
  return config.documentLocales[locale];
}

export function localizationLocaleFor(configInput: unknown, documentLocaleInput: unknown): LocalizationLocale {
  const config = parseSiteLocalizationConfig(configInput), documentLocale = localeCode(documentLocaleInput, "$documentLocale");
  const match = LOCALES.find((locale) => config.documentLocales[locale] === documentLocale);
  if (!match) fail("$documentLocale", "document locale has no explicit mapping");
  return match;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("fingerprint input is not canonical JSON");
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type PendingUnit = Omit<LocalizationUnit, "sourceFingerprint"> & { fingerprintBindings?: unknown };
type Collector = { units: PendingUnit[]; issues: LocalizationIssue[]; ids: Set<string> };

function addUnit(state: Collector, unit: PendingUnit): void {
  if (state.ids.has(unit.unitId)) fail("$localization", "duplicate localization unit ID");
  if (state.units.length >= MAX_UNITS) fail("$localization", "too many localization units");
  state.ids.add(unit.unitId);
  state.units.push(unit);
}

function richNode(node: PageNode): LocalizedRichTextNode | undefined {
  if (node.type === "text") return { type: "text", text: node.text };
  if (node.type !== "element" || !INLINE_TAGS.has(node.tag)) return undefined;
  if (node.tag === "br") return node.children.length ? undefined : { type: "element", id: node.id, tag: "br", children: [] };
  const children: LocalizedRichTextNode[] = [];
  for (const child of node.children) {
    const converted = richNode(child);
    if (!converted) return undefined;
    children.push(converted);
  }
  return { type: "element", id: node.id, tag: node.tag as Exclude<LocalizedRichTextNode, { type: "text" }>["tag"], children };
}

function protectedRichBindings(nodes: readonly PageNode[]): unknown[] {
  const result: unknown[] = [];
  const visit = (node: PageNode): void => {
    if (node.type !== "element") return;
    if (node.tag === "a") result.push({ id: node.id, href: node.attrs?.href ?? null });
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return result;
}

function collectInlineAttributes(nodes: readonly PageNode[], scope: LocalizationUnitScope, ownerId: string, state: Collector): void {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    collectAttributes(node, scope, ownerId, state);
    collectInlineAttributes(node.children, scope, ownerId, state);
  }
}

function textLength(value: LocalizedRichTextNode[]): number {
  return value.reduce((total, node) => total + (node.type === "text" ? node.text.length : textLength(node.children)), 0);
}

function hasMeaningfulText(nodes: readonly PageNode[]): boolean {
  return nodes.some((node) => node.type === "text" ? !!node.text.trim() : node.type === "element" ? hasMeaningfulText(node.children) : node.type === "instance");
}

function fieldPrefix(scope: LocalizationUnitScope, ownerId: string): string {
  return scope === "page" ? "page" : `component.${ownerId}`;
}

function collectAttributes(node: ElementNode, scope: LocalizationUnitScope, ownerId: string, state: Collector): void {
  const prefix = fieldPrefix(scope, ownerId);
  for (const name of ["alt", "aria-label", "title"] as const) {
    const raw = node.attrs?.[name];
    if (typeof raw !== "string") continue;
    addUnit(state, { unitId: `${prefix}.node.${node.id}.attr.${name}`, scope, ownerId, field: `node.${node.id}.attr.${name}`,
      kind: "text", translatable: true, required: true, sourceValue: raw, context: `${node.tag} ${name}`, maxLength: 2048, allowEmpty: name === "alt" });
  }
  if (node.tag === "img" && (node.asset || typeof node.attrs?.src === "string")) {
    addUnit(state, { unitId: `${prefix}.node.${node.id}.asset`, scope, ownerId, field: `node.${node.id}.asset`, kind: "asset", translatable: false, required: false,
      sourceValue: node.asset ? { kind: "asset", asset: detached(node.asset) } : { kind: "image-url", src: node.attrs!.src as string,
        ...(typeof node.attrs?.srcSet === "string" ? { srcset: node.attrs.srcSet } : {}) }, context: "image source override" });
  }
}

function collectInstance(instance: InstanceNode, definition: ComponentDefinition | undefined, scope: LocalizationUnitScope, ownerId: string, state: Collector): void {
  if (!definition || !instance.props) return;
  const prefix = fieldPrefix(scope, ownerId);
  for (const [name, value] of Object.entries(instance.props)) {
    const prop = definition.props?.[name];
    if (!prop || (prop.field !== "text" && prop.field !== "alt")) continue;
    addUnit(state, { unitId: `${prefix}.instance.${instance.id}.prop.${name}`, scope, ownerId, field: `instance.${instance.id}.prop.${name}`,
      kind: "text", translatable: true, required: true, sourceValue: value, context: `component instance ${instance.component} ${prop.field}`,
      maxLength: prop.field === "alt" ? 2048 : 4096, allowEmpty: true });
  }
}

function validateBlockAllowlist(blocks: BlockContracts, schema: BlockLocalizationSchema | undefined): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  if (!schema) return result;
  const source = record(schema, "$blockLocalization");
  for (const [block, raw] of Object.entries(source)) {
    identifier(block, "$blockLocalization");
    if (!Object.hasOwn(blocks, block)) fail(`$blockLocalization.${block}`, "unknown block");
    const value = record(raw, `$blockLocalization.${block}`);
    keys(value, ["props"], `$blockLocalization.${block}`);
    if (!Array.isArray(value.props) || value.props.length > 64) fail(`$blockLocalization.${block}.props`, "expected a bounded prop array");
    const names = value.props.map((name, index) => identifier(name, `$blockLocalization.${block}.props[${index}]`));
    if (new Set(names).size !== names.length) fail(`$blockLocalization.${block}.props`, "duplicate prop");
    const allowed = new Map<string, number>();
    for (const name of names) {
      const rule = blocks[block]!.props[name];
      if (!rule || rule.type !== "string") fail(`$blockLocalization.${block}.props`, "localizable prop must be a declared string");
      allowed.set(name, Math.min(rule.maxLength ?? 4096, 4096));
    }
    result.set(block, allowed);
  }
  return result;
}

function collectBlock(node: ComponentNode, allowlist: Map<string, Map<string, number>>, scope: LocalizationUnitScope, ownerId: string, state: Collector): void {
  const allowed = allowlist.get(node.block);
  if (!allowed) return;
  const prefix = fieldPrefix(scope, ownerId);
  for (const [name, maxLength] of allowed) {
    const value = node.props[name];
    if (typeof value !== "string") continue;
    addUnit(state, { unitId: `${prefix}.block.${node.id}.prop.${name}`, scope, ownerId, field: `block.${node.id}.prop.${name}`,
      kind: "text", translatable: true, required: true, sourceValue: value, context: `block ${node.block} prop ${name}`,
      maxLength, allowEmpty: true });
  }
}

function collectNodes(nodes: readonly PageNode[], scope: LocalizationUnitScope, ownerId: string, definitions: ReadonlyMap<string, ComponentDefinition>,
  allowlist: Map<string, Map<string, number>>, state: Collector, parentId?: string): void {
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.text.trim()) state.issues.push({ code: "UNANCHORED_TEXT", scope, ownerId, ...(parentId ? { nodeId: parentId } : {}),
        message: "Text must be grouped under an ID-bearing element before localization." });
      continue;
    }
    if (node.type === "component") { collectBlock(node, allowlist, scope, ownerId, state); continue; }
    if (node.type === "instance") { collectInstance(node, definitions.get(node.component), scope, ownerId, state); continue; }
    collectAttributes(node, scope, ownerId, state);
    if (!node.children.length) continue;
    if (node.children.length === 1 && node.children[0]!.type === "text") {
      const text = node.children[0]!.text;
      if (text.length) {
        const prefix = fieldPrefix(scope, ownerId);
        addUnit(state, { unitId: `${prefix}.node.${node.id}.text`, scope, ownerId, field: `node.${node.id}.text`, kind: "text", translatable: true, required: true,
          sourceValue: text, context: `${node.tag} text`, maxLength: MAX_VALUE_TEXT, allowEmpty: true });
      }
      continue;
    }
    const rich = node.children.map(richNode);
    const isDeclaredRichGroup = RICH_GROUP_TAGS.has(node.tag) || node.tag === "div" && node.attrs?.role === "group";
    if (isDeclaredRichGroup && rich.every((value): value is LocalizedRichTextNode => value !== undefined) && textLength(rich) > 0) {
      const prefix = fieldPrefix(scope, ownerId);
      addUnit(state, { unitId: `${prefix}.node.${node.id}.richText`, scope, ownerId, field: `node.${node.id}.richText`, kind: "rich-text", translatable: true, required: true,
        sourceValue: { kind: "rich-text", children: rich }, context: `${node.tag} grouped inline rich text`, fingerprintBindings: protectedRichBindings(node.children) });
      collectInlineAttributes(node.children, scope, ownerId, state);
      continue;
    }
    if (INLINE_ONLY_GROUP_TAGS.has(node.tag) && hasMeaningfulText(node.children)) {
      state.issues.push({ code: "UNSUPPORTED_RICH_TEXT", scope, ownerId, nodeId: node.id,
        message: "Mixed or unsupported inline content must be normalized into an ID-bearing supported group." });
      collectInlineAttributes(node.children, scope, ownerId, state);
      continue;
    }
    const hasDirectText = node.children.some((child) => child.type === "text" && !!child.text.trim());
    if (hasDirectText) state.issues.push({ code: "UNSUPPORTED_RICH_TEXT", scope, ownerId, nodeId: node.id,
      message: "Mixed or unsupported inline content must be normalized into an ID-bearing supported group." });
    collectNodes(node.children, scope, ownerId, definitions, allowlist, state, node.id);
  }
}

/** Parse source inputs, extract stable units, and bind each unit to direction/context with SHA-256. */
export async function collectLocalizationUnits(configInput: unknown, documentInput: unknown, targetLocaleInput: unknown,
  options: LocalizationExtractionOptions = {}): Promise<LocalizationCollection> {
  const config = parseSiteLocalizationConfig(configInput), targetLocale = localizationLocale(targetLocaleInput, "$targetLocale");
  if (targetLocale === config.sourceLocale || !config.enabledLocales.includes(targetLocale)) fail("$targetLocale", "target locale must be a different enabled locale");
  const blocks = options.blocks ?? {}, components = options.components === undefined ? undefined : parseComponentLibrary(options.components, blocks);
  const document = parsePageDocument(documentInput, blocks, components ? { components } : {});
  if (document.siteId !== config.siteId) fail("$.siteId", "document belongs to another site");
  if (document.locale !== config.documentLocales[config.sourceLocale]) fail("$.locale", "document locale does not match the explicit source locale mapping");
  const definitions = new Map((components?.components ?? []).map((component) => [component.id, component]));
  const allowlist = validateBlockAllowlist(blocks, options.blockLocalization);
  const state: Collector = { units: [], issues: [], ids: new Set() };
  addUnit(state, { unitId: "page.title", scope: "page", ownerId: document.pageId, field: "title", kind: "text", translatable: true, required: true,
    sourceValue: document.title, context: "page title", maxLength: 300 });
  if (document.meta?.description !== undefined) addUnit(state, { unitId: "page.meta.description", scope: "page", ownerId: document.pageId,
    field: "meta.description", kind: "text", translatable: true, required: true, sourceValue: document.meta.description, context: "page description", maxLength: 500, singleLine: true });
  if (document.meta?.ogImage) addUnit(state, { unitId: "page.meta.ogImage.alt", scope: "page", ownerId: document.pageId,
    field: "meta.ogImage.alt", kind: "text", translatable: true, required: true, sourceValue: document.meta.ogImage.alt, context: "Open Graph image alt", maxLength: 300, allowEmpty: true, singleLine: true });
  if (document.meta?.ogImage) addUnit(state, { unitId: "page.meta.ogImage.src", scope: "page", ownerId: document.pageId,
    field: "meta.ogImage.src", kind: "asset", translatable: false, required: false,
    sourceValue: { kind: "image-url", src: document.meta.ogImage.src }, context: "Open Graph image source override" });
  collectNodes(document.body, "page", document.pageId, definitions, allowlist, state);
  for (const component of components?.components ?? []) collectNodes([component.root], "shared-component", component.id, definitions, allowlist, state);
  const units = await Promise.all(state.units.map(async (pending): Promise<LocalizationUnit> => {
    const { fingerprintBindings, ...unit } = pending;
    return { ...unit, sourceFingerprint: await sha256({
    schema: 1, siteId: config.siteId, pageId: unit.scope === "page" ? document.pageId : null, unitId: unit.unitId, scope: unit.scope, sourceLocale: config.sourceLocale,
    targetLocale, glossaryVersion: config.glossaryVersion, contextVersion: config.contextVersion, context: unit.context, sourceValue: unit.sourceValue,
    protectedReferences: fingerprintBindings ?? null
  }) };
  }));
  return { siteId: config.siteId, pageId: document.pageId, sourceLocale: config.sourceLocale, targetLocale, units, issues: detached(state.issues) };
}

function parseRichNode(input: unknown, path: string, count: { nodes: number; text: number }, depth = 0, insideAnchor = false): LocalizedRichTextNode {
  if (depth > MAX_RICH_DEPTH) fail(path, "rich text exceeds depth limit");
  const source = record(input, path);
  if (++count.nodes > 5_000) fail(path, "rich text exceeds node limit");
  if (source.type === "text") {
    keys(source, ["type", "text"], path);
    const text = string(source.text, `${path}.text`, MAX_VALUE_TEXT);
    if ((count.text += text.length) > MAX_VALUE_TEXT) fail(path, "rich text exceeds text limit");
    return { type: "text", text };
  }
  keys(source, ["type", "id", "tag", "children"], path);
  if (source.type !== "element" || typeof source.tag !== "string" || !INLINE_TAGS.has(source.tag)) fail(path, "unsupported rich text node");
  const id = identifier(source.id, `${path}.id`);
  if (!Array.isArray(source.children)) fail(`${path}.children`, "expected node array");
  if (source.tag === "br" && source.children.length) fail(`${path}.children`, "line break cannot have children");
  if (source.tag === "a" && insideAnchor) fail(path, "rich text cannot nest anchors");
  return { type: "element", id, tag: source.tag as Exclude<LocalizedRichTextNode, { type: "text" }>["tag"],
    children: source.children.map((child, index) => parseRichNode(child, `${path}.children[${index}]`, count, depth + 1, insideAnchor || source.tag === "a")) };
}

function parseValue(input: unknown, kind: LocalizationValueKind, path: string): LocalizationValue {
  if (kind === "text") return string(input, path, MAX_VALUE_TEXT);
  const source = record(input, path);
  if (kind === "asset") {
    if (source.kind === "asset") {
      keys(source, ["kind", "asset"], path);
      return { kind: "asset", asset: parseAssetReference(source.asset, `${path}.asset`) };
    }
    keys(source, ["kind", "src", "srcset"], path);
    if (source.kind !== "image-url") fail(`${path}.kind`, "expected image source value");
    return { kind: "image-url", src: publicImageUrl(source.src, `${path}.src`),
      ...(source.srcset === undefined ? {} : { srcset: publicImageSrcSet(source.srcset, `${path}.srcset`) }) };
  }
  keys(source, ["kind", "children"], path);
  if (source.kind !== "rich-text" || !Array.isArray(source.children)) fail(path, "expected rich-text value");
  const count = { nodes: 0, text: 0 };
  return { kind: "rich-text", children: source.children.map((child, index) => parseRichNode(child, `${path}.children[${index}]`, count)) };
}

function richSignature(nodes: readonly LocalizedRichTextNode[]): string[] {
  const result: string[] = [];
  const visit = (node: LocalizedRichTextNode, parent: string): void => {
    if (node.type === "text") return;
    result.push(`${parent}:${node.id}:${node.tag}`);
    node.children.forEach((child) => visit(child, node.id));
  };
  nodes.forEach((node) => visit(node, "$root"));
  return result.sort();
}

function richTextContent(nodes: readonly LocalizedRichTextNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.text : richTextContent(node.children)).join("");
}

type ProtectedTextReferences = { urls: string[]; emails: string[]; numericIds: string[]; numbers: string[] };

function sortedMatches(value: string, expression: RegExp, normalize: (match: string) => string = (match) => match): string[] {
  const matches: string[] = [];
  for (const match of value.matchAll(expression)) {
    matches.push(normalize(match[0]));
    if (matches.length > MAX_PROTECTED_REFERENCES) fail("$result", "too many protected textual references");
  }
  return matches.sort();
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?)}\]]+$/u, "");
}

function normalizeNumber(value: string): string {
  const compact = value.replace(/[\s'_’\u00a0\u202f]/gu, "");
  const sign = compact.startsWith("-") ? "-" : "";
  const unsigned = compact.replace(/^[+-]/u, "");
  const separators = [...unsigned].flatMap((character, index) => character === "." || character === "," ? [index] : []);
  if (!separators.length) return `${sign}${unsigned}`;
  const last = separators.at(-1)!;
  const trailing = unsigned.length - last - 1;
  const separator = unsigned[last]!;
  const sameSeparator = separators.every((index) => unsigned[index] === separator);
  const groups = unsigned.split(separator);
  const groupedInteger = sameSeparator && trailing === 3 && groups.slice(1).every((group) => group.length === 3);
  if (groupedInteger) return `${sign}${groups.join("")}`;
  const integer = unsigned.slice(0, last).replace(/[.,]/gu, "");
  return `${sign}${integer}.${unsigned.slice(last + 1)}`;
}

function protectedTextReferences(value: string): ProtectedTextReferences {
  const urls = sortedMatches(value, /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/giu, trimUrlPunctuation);
  const emails = sortedMatches(value, /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu);
  // Japanese source copy may use full-width digits and separators. Compare their numeric value with ASCII output.
  const numericText = value.replace(/[\uFF0B-\uFF0F\uFF10-\uFF19]/gu, (character) => character.normalize("NFKC"));
  const numericIds = sortedMatches(numericText, /(?<!\p{N})\d+(?:[-/]\d+)+(?!\p{N})/gu);
  const numbers = sortedMatches(numericText,
    /(?<!\p{N})[+-]?(?:\d{1,3}(?:[ '_’\u00a0\u202f,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*)(?!\p{N})/gu,
    normalizeNumber);
  if (urls.length + emails.length + numericIds.length + numbers.length > MAX_PROTECTED_REFERENCES) {
    fail("$result", "too many protected textual references");
  }
  return { urls, emails, numericIds, numbers };
}

function assertGeneratedReferences(source: string, translated: string, path: string): void {
  if (canonical(protectedTextReferences(source)) !== canonical(protectedTextReferences(translated))) {
    fail(path, "generated translation changed protected URL, email, or numeric reference");
  }
}

function valueForUnit(input: unknown, unit: LocalizationUnit, path: string, generated = false): LocalizationValue {
  if (generated && !unit.translatable) fail(path, "manual-only unit cannot accept generated output");
  const value = parseValue(input, unit.kind, path);
  if (unit.field === "meta.ogImage.src" && (typeof value === "string" || value.kind !== "image-url")) fail(path, "Open Graph image requires a URL source");
  if (unit.field === "meta.ogImage.src" && typeof value !== "string" && value.kind === "image-url" && value.srcset !== undefined) fail(path, "Open Graph image does not support srcset");
  if (typeof value === "string") {
    if (unit.maxLength !== undefined && value.length > unit.maxLength) fail(path, "localized text exceeds field limit");
    if (unit.singleLine && /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "localized text must be one line");
    if (generated && !value.trim()) fail(path, "generated translation cannot be blank");
    if (!unit.allowEmpty && !value.trim()) fail(path, "localized text cannot be blank");
    if (generated) assertGeneratedReferences(unit.sourceValue as string, value, path);
  }
  if (unit.kind === "rich-text") {
    const source = unit.sourceValue as LocalizedRichText, translated = value as LocalizedRichText;
    const translatedText = richTextContent(translated.children);
    if (generated && !translatedText.trim()) fail(path, "generated translation cannot be blank");
    if (!unit.allowEmpty && !translatedText.trim()) fail(path, "localized text cannot be blank");
    const expected = richSignature(source.children), actual = richSignature(translated.children);
    if (new Set(actual).size !== actual.length || canonical(expected) !== canonical(actual)) fail(path, "protected rich text identities or marks changed");
    if (generated) assertGeneratedReferences(richTextContent(source.children), translatedText, path);
  }
  return value;
}

function parseCandidate(input: unknown, kind: LocalizationValueKind, path: string): TranslationCandidate {
  const source = record(input, path);
  keys(source, ["candidateId", "sourceFingerprint", "value", "version"], path);
  return { candidateId: identifier(source.candidateId, `${path}.candidateId`), sourceFingerprint: fingerprint(source.sourceFingerprint, `${path}.sourceFingerprint`),
    value: parseValue(source.value, kind, `${path}.value`), version: positiveInteger(source.version, `${path}.version`) };
}

function parseEntry(input: unknown, path: string): LocalizationDraftEntry {
  const source = record(input, path);
  keys(source, ["unitId", "kind", "version", "draftValue", "editOrigin", "reviewedSourceFingerprint", "candidate"], path);
  const unitId = string(source.unitId, `${path}.unitId`, 300);
  if (!unitId || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(unitId)) fail(`${path}.unitId`, "invalid unit ID");
  if (!["text", "rich-text", "asset"].includes(source.kind as string)) fail(`${path}.kind`, "invalid value kind");
  const kind = source.kind as LocalizationValueKind, version = positiveInteger(source.version, `${path}.version`);
  const draftValue = source.draftValue === undefined ? undefined : parseValue(source.draftValue, kind, `${path}.draftValue`);
  let editOrigin: "AUTO" | "MANUAL" | undefined;
  if (source.editOrigin !== undefined) {
    if (source.editOrigin !== "AUTO" && source.editOrigin !== "MANUAL") fail(`${path}.editOrigin`, "invalid edit origin");
    editOrigin = source.editOrigin;
  }
  if ((draftValue === undefined) !== (editOrigin === undefined)) fail(path, "draft value and edit origin must be present together");
  const reviewedSourceFingerprint = source.reviewedSourceFingerprint === undefined ? undefined : fingerprint(source.reviewedSourceFingerprint, `${path}.reviewedSourceFingerprint`);
  if (reviewedSourceFingerprint && draftValue === undefined) fail(path, "review requires a draft value");
  const candidate = source.candidate === undefined ? undefined : parseCandidate(source.candidate, kind, `${path}.candidate`);
  if (draftValue === undefined && candidate === undefined) fail(path, "empty draft entry");
  return { unitId, kind, version, ...(draftValue !== undefined ? { draftValue, editOrigin: editOrigin! } : {}),
    ...(reviewedSourceFingerprint ? { reviewedSourceFingerprint } : {}), ...(candidate ? { candidate } : {}) };
}

/** Parse persisted draft/candidate state; deleted-source entries remain valid and become obsolete status entries. */
export function parseLocalizationOverlay(input: unknown): LocalizationOverlay {
  const source = record(input, "$overlay");
  keys(source, ["schemaVersion", "siteId", "pageId", "sourceLocale", "targetLocale", "version", "entries"], "$overlay");
  if (source.schemaVersion !== 1) fail("$overlay.schemaVersion", "unsupported schema version");
  const siteId = identifier(source.siteId, "$overlay.siteId"), pageId = identifier(source.pageId, "$overlay.pageId");
  const sourceLocale = localizationLocale(source.sourceLocale, "$overlay.sourceLocale"), targetLocale = localizationLocale(source.targetLocale, "$overlay.targetLocale");
  if (sourceLocale === targetLocale) fail("$overlay.targetLocale", "target locale must differ from source locale");
  const version = positiveInteger(source.version, "$overlay.version");
  if (!Array.isArray(source.entries) || source.entries.length > MAX_UNITS) fail("$overlay.entries", "expected a bounded entry array");
  const entries = source.entries.map((entry, index) => parseEntry(entry, `$overlay.entries[${index}]`));
  if (new Set(entries.map((entry) => entry.unitId)).size !== entries.length) fail("$overlay.entries", "duplicate unit ID");
  if (entries.some((entry) => entry.version > version || entry.candidate && entry.candidate.version > version)) fail("$overlay.entries", "entry version exceeds overlay version");
  return { schemaVersion: 1, siteId, pageId, sourceLocale, targetLocale, version, entries };
}

export function createLocalizationOverlay(collection: LocalizationCollection): LocalizationOverlay {
  validateCollection(collection);
  return { schemaVersion: 1, siteId: collection.siteId, pageId: collection.pageId, sourceLocale: collection.sourceLocale,
    targetLocale: collection.targetLocale, version: 1, entries: [] };
}

function validateCollection(collection: LocalizationCollection): void {
  const source = record(collection, "$collection");
  keys(source, ["siteId", "pageId", "sourceLocale", "targetLocale", "units", "issues"], "$collection");
  identifier(source.siteId, "$collection.siteId");
  identifier(source.pageId, "$collection.pageId");
  const sourceLocale = localizationLocale(source.sourceLocale, "$collection.sourceLocale");
  const targetLocale = localizationLocale(source.targetLocale, "$collection.targetLocale");
  if (sourceLocale === targetLocale) fail("$collection.targetLocale", "target locale must differ from source locale");
  if (!Array.isArray(collection.units) || collection.units.length > MAX_UNITS || !Array.isArray(collection.issues) || collection.issues.length > MAX_UNITS) {
    fail("$collection", "invalid localization collection");
  }
  const unitIds = collection.units.map((unit, index) => {
    const path = `$collection.units[${index}].unitId`;
    const unitId = string(record(unit, `$collection.units[${index}]`).unitId, path, 300);
    if (!unitId || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(unitId)) fail(path, "invalid unit ID");
    return unitId;
  });
  if (new Set(unitIds).size !== unitIds.length) fail("$collection.units", "duplicate unit ID");
}

function comparableCollection(collection: LocalizationCollection): unknown {
  return {
    siteId: collection.siteId,
    pageId: collection.pageId,
    sourceLocale: collection.sourceLocale,
    targetLocale: collection.targetLocale,
    units: [...collection.units].sort((left, right) => left.unitId.localeCompare(right.unitId)),
    issues: [...collection.issues].sort((left, right) => canonical(left).localeCompare(canonical(right)))
  };
}

function assertCurrentCollection(collection: LocalizationCollection, current: LocalizationCollection): void {
  validateCollection(collection);
  try {
    if (canonical(comparableCollection(collection)) !== canonical(comparableCollection(current))) {
      fail("$collection", "collection is stale or does not match current source inputs");
    }
  } catch (error) {
    if (error instanceof TypeError) fail("$collection", "collection is not canonical JSON");
    throw error;
  }
}

function scoped(overlayInput: unknown, collection: LocalizationCollection): { overlay: LocalizationOverlay; units: Map<string, LocalizationUnit> } {
  validateCollection(collection);
  const overlay = parseLocalizationOverlay(overlayInput);
  if (overlay.siteId !== collection.siteId || overlay.pageId !== collection.pageId || overlay.sourceLocale !== collection.sourceLocale || overlay.targetLocale !== collection.targetLocale) {
    fail("$overlay", "localization scope does not match current collection");
  }
  return { overlay, units: new Map(collection.units.map((unit) => [unit.unitId, unit])) };
}

function nextEntries(overlay: LocalizationOverlay): LocalizationDraftEntry[] { return detached(overlay.entries); }
function upsert(entries: LocalizationDraftEntry[], unitId: string, create: () => LocalizationDraftEntry, update: (entry: LocalizationDraftEntry) => LocalizationDraftEntry): void {
  const index = entries.findIndex((entry) => entry.unitId === unitId);
  if (index < 0) entries.push(create()); else entries[index] = update(entries[index]!);
}
function assertVersion(overlay: LocalizationOverlay, expectedVersion: number, path: string): void {
  if (overlay.version !== expectedVersion) fail(path, "stale optimistic version");
}

function parseTranslationResult(input: unknown): TranslationResult {
  const source = record(input, "$result");
  keys(source, ["schemaVersion", "resultId", "siteId", "pageId", "sourceLocale", "targetLocale", "baseVersion", "values"], "$result");
  if (source.schemaVersion !== 1) fail("$result.schemaVersion", "unsupported schema version");
  const resultId = identifier(source.resultId, "$result.resultId"), siteId = identifier(source.siteId, "$result.siteId"), pageId = identifier(source.pageId, "$result.pageId");
  const sourceLocale = localizationLocale(source.sourceLocale, "$result.sourceLocale"), targetLocale = localizationLocale(source.targetLocale, "$result.targetLocale");
  const baseVersion = positiveInteger(source.baseVersion, "$result.baseVersion");
  if (!Array.isArray(source.values) || source.values.length < 1 || source.values.length > MAX_UNITS) fail("$result.values", "expected a bounded non-empty result array");
  const values = source.values.map((raw, index) => {
    const path = `$result.values[${index}]`, value = record(raw, path);
    keys(value, ["unitId", "sourceFingerprint", "value"], path);
    return { unitId: string(value.unitId, `${path}.unitId`, 300), sourceFingerprint: fingerprint(value.sourceFingerprint, `${path}.sourceFingerprint`), value: value.value as string | LocalizedRichText };
  });
  if (new Set(values.map((value) => value.unitId)).size !== values.length) fail("$result.values", "duplicate unit ID");
  return { schemaVersion: 1, resultId, siteId, pageId, sourceLocale, targetLocale, baseVersion, values };
}

/** Store generated values only as candidates; an existing manual or adopted draft is never replaced. */
export function acceptTranslationResult(overlayInput: unknown, collection: LocalizationCollection, resultInput: unknown): LocalizationOverlay {
  const { overlay, units } = scoped(overlayInput, collection), result = parseTranslationResult(resultInput);
  if (result.siteId !== overlay.siteId || result.pageId !== overlay.pageId || result.sourceLocale !== overlay.sourceLocale || result.targetLocale !== overlay.targetLocale) {
    fail("$result", "translation result has foreign scope");
  }
  assertVersion(overlay, result.baseVersion, "$result.baseVersion");
  const version = overlay.version + 1, entries = nextEntries(overlay);
  for (let index = 0; index < result.values.length; index++) {
    const incoming = result.values[index]!, unit = units.get(incoming.unitId), path = `$result.values[${index}]`;
    if (!unit) fail(`${path}.unitId`, "unknown localization unit");
    if (incoming.sourceFingerprint !== unit.sourceFingerprint) fail(`${path}.sourceFingerprint`, "source fingerprint is stale");
    const value = valueForUnit(incoming.value, unit, `${path}.value`, true);
    const candidate: TranslationCandidate = { candidateId: result.resultId, sourceFingerprint: unit.sourceFingerprint, value, version };
    upsert(entries, unit.unitId, () => ({ unitId: unit.unitId, kind: unit.kind, version, candidate }), (entry) => {
      if (entry.kind !== unit.kind) fail(path, "stored value kind conflicts with current unit");
      return { ...entry, version, candidate };
    });
  }
  return { ...overlay, version, entries };
}

export function editLocalizedValue(overlayInput: unknown, collection: LocalizationCollection, editInput: unknown): LocalizationOverlay {
  const { overlay, units } = scoped(overlayInput, collection);
  const edit = record(editInput, "$edit");
  keys(edit, ["unitId", "value", "expectedVersion"], "$edit");
  assertVersion(overlay, positiveInteger(edit.expectedVersion, "$edit.expectedVersion"), "$edit.expectedVersion");
  const unitId = string(edit.unitId, "$edit.unitId", 300), unit = units.get(unitId);
  if (!unit) fail("$edit.unitId", "unknown localization unit");
  const value = valueForUnit(edit.value, unit, "$edit.value"), version = overlay.version + 1, entries = nextEntries(overlay);
  upsert(entries, unit.unitId, () => ({ unitId: unit.unitId, kind: unit.kind, version, draftValue: value, editOrigin: "MANUAL" }),
    (entry) => {
      const { reviewedSourceFingerprint: _reviewed, ...unreviewed } = entry;
      return { ...unreviewed, kind: unit.kind, version, draftValue: value, editOrigin: "MANUAL" };
    });
  return { ...overlay, version, entries };
}

export function adoptTranslationCandidate(overlayInput: unknown, collection: LocalizationCollection, adoptionInput: unknown): LocalizationOverlay {
  const { overlay, units } = scoped(overlayInput, collection);
  const adoption = record(adoptionInput, "$adoption");
  keys(adoption, ["unitId", "expectedVersion", "candidateVersion"], "$adoption");
  assertVersion(overlay, positiveInteger(adoption.expectedVersion, "$adoption.expectedVersion"), "$adoption.expectedVersion");
  const unitId = string(adoption.unitId, "$adoption.unitId", 300), unit = units.get(unitId);
  if (!unit) fail("$adoption.unitId", "unknown localization unit");
  const entries = nextEntries(overlay), index = entries.findIndex((entry) => entry.unitId === unit.unitId), entry = entries[index];
  if (!entry?.candidate) fail("$adoption.unitId", "candidate not found");
  if (entry.candidate.version !== positiveInteger(adoption.candidateVersion, "$adoption.candidateVersion")) fail("$adoption.candidateVersion", "stale candidate version");
  if (entry.candidate.sourceFingerprint !== unit.sourceFingerprint) fail("$adoption.unitId", "candidate source is stale");
  const candidateValue = valueForUnit(entry.candidate.value, unit, "$adoption.candidate", true);
  const version = overlay.version + 1;
  entries[index] = { unitId: unit.unitId, kind: unit.kind, version, draftValue: candidateValue, editOrigin: "AUTO" };
  return { ...overlay, version, entries };
}

/** Mark the current draft reviewed against current source, with or without adopting a newer candidate. */
export function reviewLocalizedValue(overlayInput: unknown, collection: LocalizationCollection, reviewInput: unknown): LocalizationOverlay {
  const { overlay, units } = scoped(overlayInput, collection);
  const review = record(reviewInput, "$review");
  keys(review, ["unitId", "expectedVersion"], "$review");
  assertVersion(overlay, positiveInteger(review.expectedVersion, "$review.expectedVersion"), "$review.expectedVersion");
  const unitId = string(review.unitId, "$review.unitId", 300), unit = units.get(unitId);
  if (!unit) fail("$review.unitId", "unknown localization unit");
  const entries = nextEntries(overlay), index = entries.findIndex((entry) => entry.unitId === unit.unitId), entry = entries[index];
  if (entry?.draftValue === undefined) fail("$review.unitId", "draft value not found");
  const version = overlay.version + 1;
  entries[index] = { ...entry, version, reviewedSourceFingerprint: unit.sourceFingerprint };
  return { ...overlay, version, entries };
}

export function localizationStatus(overlayInput: unknown, collection: LocalizationCollection): LocalizationStatus {
  const { overlay, units } = scoped(overlayInput, collection), entries = new Map(overlay.entries.map((entry) => [entry.unitId, entry]));
  let reviewed = 0, sourceFallback = 0, missing = 0, draft = 0, reviewNeeded = 0, candidates = 0;
  const details = collection.units.map((unit) => {
    const entry = entries.get(unit.unitId);
    if (entry?.candidate) candidates++;
    let state: "source" | "missing" | "draft" | "review-needed" | "reviewed";
    if (entry?.draftValue === undefined && !unit.required) { state = "source"; sourceFallback++; }
    else if (entry?.draftValue === undefined) { state = "missing"; missing++; }
    else if (entry.reviewedSourceFingerprint === unit.sourceFingerprint) { state = "reviewed"; reviewed++; }
    else if (entry.reviewedSourceFingerprint) { state = "review-needed"; reviewNeeded++; }
    else { state = "draft"; draft++; }
    return { unitId: unit.unitId, state, hasCandidate: !!entry?.candidate };
  });
  const obsolete = overlay.entries.filter((entry) => !units.has(entry.unitId)).length;
  return { complete: missing === 0 && draft === 0 && reviewNeeded === 0 && collection.issues.length === 0, units: collection.units.length,
    reviewed, sourceFallback, missing, draft, reviewNeeded, candidates, obsolete, issues: collection.issues.length, details };
}

function sourceElementForRich(node: ElementNode, id: string): ElementNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const found = sourceElementForRich(child, id);
    if (found) return found;
  }
  return undefined;
}

function materializeRich(value: LocalizedRichText, sourceRoot: ElementNode): PageNode[] {
  const build = (node: LocalizedRichTextNode): PageNode => {
    if (node.type === "text") return { type: "text", text: node.text };
    const source = sourceElementForRich(sourceRoot, node.id);
    if (!source || source.tag !== node.tag) fail("$overlay", "rich text source structure changed");
    const copy = detached(source);
    copy.children = node.children.map(build);
    return copy;
  };
  return value.children.map(build);
}

function findNode(nodes: PageNode[], id: string): ElementNode | ComponentNode | InstanceNode | undefined {
  for (const node of nodes) {
    if (node.type !== "text" && node.id === id) return node;
    if (node.type === "element") {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function valueFromPageUnit(document: PageDocument, unit: LocalizationUnit): LocalizationValue {
  if (unit.field === "title") return document.title;
  if (unit.field === "meta.description") {
    if (document.meta?.description === undefined) fail("$target.meta.description", "localized field is missing");
    return document.meta.description;
  }
  if (unit.field === "meta.ogImage.alt") {
    if (!document.meta?.ogImage) fail("$target.meta.ogImage", "localized field is missing");
    return document.meta.ogImage.alt;
  }
  if (unit.field === "meta.ogImage.src") {
    if (!document.meta?.ogImage) fail("$target.meta.ogImage", "localized field is missing");
    return { kind: "image-url", src: document.meta.ogImage.src };
  }
  const parts = unit.field.split("."), node = findNode(document.body, parts[1]!);
  if (!node) fail("$target.body", "localization node no longer exists");
  if (parts[0] === "node") {
    if (node.type !== "element") fail("$target.body", "localization node kind changed");
    if (parts[2] === "text") {
      if (node.children.length !== 1 || node.children[0]?.type !== "text") fail("$target.body", "localized text structure changed");
      return node.children[0].text;
    }
    if (parts[2] === "richText") {
      const children = node.children.map(richNode);
      if (children.some((child) => child === undefined)) fail("$target.body", "localized rich text structure changed");
      return { kind: "rich-text", children: children as LocalizedRichTextNode[] };
    }
    if (parts[2] === "asset") return node.asset ? { kind: "asset", asset: detached(node.asset) }
      : typeof node.attrs?.src === "string" ? { kind: "image-url", src: node.attrs.src, ...(typeof node.attrs.srcSet === "string" ? { srcset: node.attrs.srcSet } : {}) }
        : detached(unit.sourceValue);
    if (parts[2] === "attr") {
      const value = node.attrs?.[parts[3]!];
      if (typeof value !== "string") fail("$target.body", "localized attribute is missing");
      return value;
    }
  }
  if (parts[0] === "instance") {
    if (node.type !== "instance") fail("$target.body", "localization instance kind changed");
    const value = node.props?.[parts[3]!];
    if (typeof value !== "string") fail("$target.body", "localized instance value is missing");
    return value;
  }
  if (parts[0] === "block") {
    if (node.type !== "component") fail("$target.body", "localization block kind changed");
    const value = node.props[parts[3]!];
    if (typeof value !== "string") fail("$target.body", "localized block value is missing");
    return value;
  }
  fail("$target", "unsupported localized field");
}

/** Read only the page values declared by a previously collected localization contract. */
export function localizedValuesForDocument(documentInput: unknown, collection: LocalizationCollection,
  options: LocalizationExtractionOptions = {}): Readonly<Record<string, LocalizationValue>> {
  validateCollection(collection);
  const components = options.components === undefined ? undefined : parseComponentLibrary(options.components, options.blocks ?? {});
  const document = parsePageDocument(documentInput, options.blocks ?? {}, components ? { components } : {});
  if (document.siteId !== collection.siteId || document.pageId !== collection.pageId) fail("$document", "document scope does not match localization collection");
  return Object.fromEntries(collection.units.filter((unit) => unit.scope === "page").map((unit) => [unit.unitId, detached(valueFromPageUnit(document, unit))]));
}

function applyPageUnit(document: PageDocument, unit: LocalizationUnit, value: LocalizationValue): void {
  if (unit.field === "title") { document.title = value as string; return; }
  if (unit.field === "meta.description") { if (!document.meta) document.meta = {}; document.meta.description = value as string; return; }
  if (unit.field === "meta.ogImage.alt") { if (!document.meta?.ogImage) fail("$overlay", "Open Graph image source changed"); document.meta.ogImage.alt = value as string; return; }
  if (unit.field === "meta.ogImage.src") {
    if (!document.meta?.ogImage || typeof value === "string" || value.kind !== "image-url") fail("$overlay", "Open Graph image source changed");
    document.meta.ogImage.src = value.src; return;
  }
  applyNodeField(document.body, unit, value);
}

function applyNodeField(nodes: PageNode[], unit: LocalizationUnit, value: LocalizationValue): void {
  const parts = unit.field.split("."), category = parts[0];
  if (category === "node") {
    const node = findNode(nodes, parts[1]!);
    if (!node || node.type !== "element") fail("$overlay", "localization node no longer exists");
    if (parts[2] === "text") node.children = [{ type: "text", text: value as string }];
    else if (parts[2] === "richText") node.children = materializeRich(value as LocalizedRichText, node);
    else if (parts[2] === "asset") {
      if (typeof value === "string" || value.kind === "rich-text") fail("$overlay", "invalid image source override");
      node.attrs ??= {};
      if (value.kind === "asset") { node.asset = detached(value.asset); delete node.attrs.src; delete node.attrs.srcSet; }
      else { node.attrs.src = value.src; if (value.srcset === undefined) delete node.attrs.srcSet; else node.attrs.srcSet = value.srcset; delete node.asset; }
    }
    else if (parts[2] === "attr") node.attrs = { ...node.attrs, [parts[3]!]: value as string };
    return;
  }
  if (category === "instance") {
    const node = findNode(nodes, parts[1]!);
    if (!node || node.type !== "instance") fail("$overlay", "component instance no longer exists");
    node.props = { ...node.props, [parts[3]!]: value as string };
    return;
  }
  if (category === "block") {
    const node = findNode(nodes, parts[1]!);
    if (!node || node.type !== "component") fail("$overlay", "block no longer exists");
    node.props = { ...node.props, [parts[3]!]: value as string };
  }
}

/** Recollect current source, then apply adopted/manual draft values; candidates alone never materialize. */
export async function materializeLocalizedPage(configInput: unknown, documentInput: unknown, collection: LocalizationCollection, overlayInput: unknown,
  options: LocalizationExtractionOptions = {}): Promise<MaterializedLocalization> {
  validateCollection(collection);
  const config = parseSiteLocalizationConfig(configInput), blocks = options.blocks ?? {};
  const currentCollection = await collectLocalizationUnits(config, documentInput, collection.targetLocale, options);
  assertCurrentCollection(collection, currentCollection);
  const sourceComponents = options.components === undefined ? undefined : parseComponentLibrary(options.components, blocks);
  const sourceDocument = parsePageDocument(documentInput, blocks, sourceComponents ? { components: sourceComponents } : {});
  const { overlay } = scoped(overlayInput, currentCollection), document = detached(sourceDocument), components = sourceComponents && detached(sourceComponents);
  const entries = new Map(overlay.entries.map((entry) => [entry.unitId, entry]));
  const materializationUnits = [...currentCollection.units].sort((left, right) => Number(right.field.endsWith(".richText")) - Number(left.field.endsWith(".richText")));
  for (const unit of materializationUnits) {
    const entry = entries.get(unit.unitId);
    if (entry?.draftValue === undefined) continue;
    valueForUnit(entry.draftValue, unit, "$overlay.entries.draftValue", entry.editOrigin === "AUTO");
    if (unit.scope === "page") applyPageUnit(document, unit, entry.draftValue);
    else {
      const component = components?.components.find((item) => item.id === unit.ownerId);
      if (!component) fail("$overlay", "shared component no longer exists");
      applyNodeField([component.root], unit, entry.draftValue);
    }
  }
  document.locale = config.documentLocales[currentCollection.targetLocale];
  const parsedComponents = components && parseComponentLibrary(components, blocks);
  const parsedDocument = parsePageDocument(document, blocks, parsedComponents ? { components: parsedComponents } : {});
  return { document: parsedDocument, ...(parsedComponents ? { components: parsedComponents } : {}), status: localizationStatus(overlay, currentCollection) };
}

/**
 * Validate a translated document at the host save boundary. The target is reduced to values declared by
 * the current collector and rebuilt through the normal materializer, so node IDs, links, layout, styles,
 * business props and every other common field must still match the authoritative source document.
 */
export async function validateLocalizedDocumentSave(configInput: unknown, sourceDocumentInput: unknown, targetDocumentInput: unknown,
  options: LocalizationExtractionOptions = {}): Promise<LocalizedDocumentSaveValidation> {
  const config = parseSiteLocalizationConfig(configInput), blocks = options.blocks ?? {};
  const components = options.components === undefined ? undefined : parseComponentLibrary(options.components, blocks);
  const sourceDocument = parsePageDocument(sourceDocumentInput, blocks, components ? { components } : {});
  const targetDocument = parsePageDocument(targetDocumentInput, blocks, components ? { components } : {});
  if (sourceDocument.siteId !== targetDocument.siteId || sourceDocument.pageId !== targetDocument.pageId) fail("$target", "translated document scope does not match source");
  if (sourceDocument.locale !== config.documentLocales[config.sourceLocale]) fail("$source.locale", "source document locale does not match config");
  const targetLocale = localizationLocaleFor(config, targetDocument.locale);
  if (targetLocale === config.sourceLocale) fail("$target.locale", "translated document must use a configured target locale");
  const collection = await collectLocalizationUnits(config, sourceDocument, targetLocale, options);
  if (collection.issues.length) fail("$source", "source document has unsupported or unanchored localization content");
  let overlay = createLocalizationOverlay(collection);
  const values: Record<string, LocalizationValue> = {};
  for (const unit of collection.units.filter((entry) => entry.scope === "page")) {
    const value = valueFromPageUnit(targetDocument, unit);
    values[unit.unitId] = detached(value);
    overlay = editLocalizedValue(overlay, collection, { unitId: unit.unitId, value, expectedVersion: overlay.version });
  }
  const materialized = await materializeLocalizedPage(config, sourceDocument, collection, overlay, options);
  const expected = { ...materialized.document, revision: targetDocument.revision };
  if (canonical(expected) !== canonical(targetDocument)) fail("$target", "translated document changed common structure or a non-localizable field");
  return { document: detached(targetDocument), collection: detached(collection), values: detached(values) };
}
