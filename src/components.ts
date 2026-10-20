import type {
  BlockContracts, ComponentDefinition, ComponentKind, ComponentLibrary, ComponentPropDefinition, ComponentPropField, ElementNode, PageDocument, PageNode
} from "./types.js";
import { COMPONENT_LIMITS, expandDocument, instancesOf, ownElements, type ResolvedOrigin } from "./component-expand.js";
import { isElementTag, parseNode, parsePageDocument, reservedPropNames, type ComponentShape, type NodeContext } from "./document.js";
import { collectAssetReferences, type AssetPlacement } from "./assets.js";
import { findInternalLinks, linkTarget, rewriteInternalLinks, validatePagePath } from "./pages.js";
import { parseTokens } from "./style-values.js";
import { DocumentValidationError, fail, identifier, keys, record } from "./validation-utils.js";

export { COMPONENT_LIMITS, type ResolvedOrigin } from "./component-expand.js";

const kinds: readonly string[] = ["header", "footer", "navigation", "section", "part"];
const fields: readonly string[] = ["text", "href", "src", "alt"];
const textless = new Set(["img", "source", "br", "hr", "ul", "ol", "dl", "picture"]);

/** @internal 公開 props の field を置ける element か。text は子が空か文字1つだけの element。 */
export function fitsPropField(node: ElementNode, field: ComponentPropField): boolean {
  if (field === "href") return node.tag === "a";
  // 素材ライブラリの画像（asset）は src と併用できないため、URL の画像だけ src を公開できる。
  if (field === "src") return node.tag === "img" && node.asset === undefined;
  if (field === "alt") return node.tag === "img";
  return !textless.has(node.tag) && (!node.children.length || node.children.length === 1 && node.children[0]!.type === "text");
}
function displayText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length > max || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid string");
  return value;
}
function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(path, "expected positive safe integer");
  return value;
}
function propDefinitions(value: unknown, path: string): Record<string, ComponentPropDefinition> {
  const source = record(value, path), result: Record<string, ComponentPropDefinition> = {};
  if (Object.keys(source).length > COMPONENT_LIMITS.props) fail(path, "too many component props");
  for (const [name, raw] of Object.entries(source)) {
    identifier(name, path);
    if (reservedPropNames.includes(name)) fail(path, "reserved prop name");
    const at = `${path}.${name}`, definition = record(raw, at);
    keys(definition, ["label", "node", "field"], at);
    const text = displayText(definition.label, `${at}.label`, COMPONENT_LIMITS.labelLength), node = identifier(definition.node, `${at}.node`);
    if (typeof definition.field !== "string" || !fields.includes(definition.field)) fail(`${at}.field`, "unknown prop field");
    result[name] = { label: text, node, field: definition.field as ComponentPropField };
  }
  return result;
}

/** 外部 JSON の部品ライブラリを検証し、未知フィールドを拒否して入力を参照しない新しいライブラリを返す。 */
export function parseComponentLibrary(input: unknown, blocks: BlockContracts = {}): ComponentLibrary {
  const source = record(input, "$");
  keys(source, ["schemaVersion", "siteId", "revision", "tokens", "components"], "$");
  if (source.schemaVersion !== 1) fail("$.schemaVersion", "unsupported schema version");
  const siteId = identifier(source.siteId, "$.siteId"), revision = positiveInteger(source.revision, "$.revision");
  const tokens = parseTokens(source.tokens, "$.tokens");
  if (!Array.isArray(source.components) || source.components.length > COMPONENT_LIMITS.components) fail("$.components", "expected component array within limits");
  // 入れ子の部品の検証が並び順に依存しないよう、全部品の ID・外枠のタグ・公開 props を先に読む。
  const shapes = new Map<string, ComponentShape>(), names = new Set<string>();
  const headers = source.components.map((raw, index) => {
    const at = `$.components[${index}]`, value = record(raw, at);
    keys(value, ["id", "name", "kind", "version", "root", "props"], at);
    const id = identifier(value.id, `${at}.id`);
    if (shapes.has(id)) fail(`${at}.id`, "duplicate component ID");
    const name = displayText(value.name, `${at}.name`, COMPONENT_LIMITS.nameLength);
    if (names.has(name.trim())) fail(`${at}.name`, "duplicate component name");
    names.add(name.trim());
    if (typeof value.kind !== "string" || !kinds.includes(value.kind)) fail(`${at}.kind`, "unknown component kind");
    const version = positiveInteger(value.version, `${at}.version`), root = record(value.root, `${at}.root`);
    if (root.type !== "element") fail(`${at}.root`, "component root must be an element");
    if (!isElementTag(root.tag)) fail(`${at}.root.tag`, "unsupported element");
    const props = value.props === undefined ? undefined : propDefinitions(value.props, `${at}.props`);
    shapes.set(id, { tag: root.tag, props: new Map(Object.entries(props ?? {}).map(([name, prop]) => [name, prop.field])) });
    return { id, name, kind: value.kind as ComponentKind, version, root: value.root, props };
  });
  // root は文書と同じ規則。ノード ID・HTML ID は部品ごと、ノード数と文字数はライブラリ全体で数える。
  const usage = { nodes: 0, text: 0 }, references = new Map<string, string[]>();
  const components = headers.map((header, index): ComponentDefinition => {
    const at = `$.components[${index}]`;
    const context: NodeContext = { blocks, tokens, instanceTokens: tokens, components: shapes, ids: new Set(), htmlIds: new Set(), usage };
    const root = parseNode(header.root, `${at}.root`, context);
    if (root.type !== "element") fail(`${at}.root`, "component root must be an element");
    const elements = ownElements(root), targets = new Set<string>();
    for (const [name, prop] of Object.entries(header.props ?? {})) {
      const target = elements.get(prop.node);
      if (!target) fail(`${at}.props.${name}.node`, "prop target not found");
      if (!fitsPropField(target, prop.field)) fail(`${at}.props.${name}.field`, "prop field does not fit the target");
      if (targets.has(`${prop.field} ${prop.node}`)) fail(`${at}.props.${name}`, "duplicate prop target");
      targets.add(`${prop.field} ${prop.node}`);
    }
    references.set(header.id, instancesOf([root]).map((instance) => instance.component));
    return { id: header.id, name: header.name, kind: header.kind, version: header.version, root, ...(header.props ? { props: header.props } : {}) };
  });
  // 葉の部品を1段とし、循環参照と上限を超える入れ子を拒否する。
  const order = new Map(components.map((component, index) => [component.id, index])), depths = new Map<string, number>();
  const depth = (id: string): number => {
    const known = depths.get(id);
    if (known === 0) fail(`$.components[${order.get(id)}]`, "circular component reference");
    if (known !== undefined) return known;
    depths.set(id, 0);
    const result = 1 + Math.max(0, ...references.get(id)!.map(depth));
    if (result > COMPONENT_LIMITS.nesting) fail(`$.components[${order.get(id)}]`, "component nesting too deep");
    depths.set(id, result);
    return result;
  };
  components.forEach((component) => depth(component.id));
  // 各部品を1つだけ置いた文書として展開し、展開後の HTML・ID・tokens・上限を検証する。
  // 葉から順に確かめ、入れ子の部品自体の不備はその部品の位置で返す。
  const library: ComponentLibrary = { schemaVersion: 1, siteId, revision, tokens, components };
  const leavesFirst = components.map((component, index) => ({ component, index })).sort((a, b) => depths.get(a.component.id)! - depths.get(b.component.id)!);
  for (const { component, index } of leavesFirst) {
    const preview = { schemaVersion: 1, siteId, pageId: "component", locale: "ja", revision, title: component.name, tokens, body: [{ type: "instance", id: "preview", component: component.id }] };
    try {
      parsePageDocument(preview, blocks, { components: library });
    } catch (error) {
      if (error instanceof DocumentValidationError) throw new DocumentValidationError(`$.components[${index}]${error.path.slice(1)}`, error.reason);
      throw error;
    }
  }
  return library;
}

/**
 * 下書き文書のインスタンスを部品の複製へ展開し、公開用の v1 文書と展開したノードの出所を返す。
 * library はインスタンスを含まない文書でだけ省略できる。
 */
export function resolvePageDocument(document: unknown, library: unknown, blocks: BlockContracts = {}): { document: PageDocument; origins: ReadonlyMap<string, ResolvedOrigin> } {
  if (library === undefined) return { document: parsePageDocument(document, blocks), origins: new Map() };
  const components = parseComponentLibrary(library, blocks);
  const expanded = expandDocument(parsePageDocument(document, blocks, { components }), components);
  return { document: parsePageDocument(expanded.document, blocks), origins: expanded.origins };
}

/** 検証済みの文書が使う部品ごとのインスタンス数。部品の中の部品は、置かれた回数を掛けて数える。 */
export function componentUsage(document: PageDocument, library: ComponentLibrary): Record<string, number> {
  const definitions = new Map(library.components.map((component) => [component.id, component])), nested = new Map<string, Map<string, number>>();
  const count = (nodes: readonly PageNode[], into: Map<string, number>): void => {
    for (const instance of instancesOf(nodes)) {
      into.set(instance.component, (into.get(instance.component) ?? 0) + 1);
      for (const [id, times] of inside(instance.component)) into.set(id, (into.get(id) ?? 0) + times);
    }
  };
  const inside = (id: string): Map<string, number> => {
    let result = nested.get(id);
    if (!result) {
      nested.set(id, result = new Map());
      const definition = definitions.get(id);
      if (definition) count([definition.root], result);
    }
    return result;
  };
  const total = new Map<string, number>();
  count(document.body, total);
  return Object.fromEntries([...total].filter(([, times]) => times > 0));
}

/** 部品が公開をやめた props の値を持つ、文書に直接置かれたインスタンス。 */
export function componentIssues(document: PageDocument, library: ComponentLibrary): { nodeId: string; component: string; staleProps: string[] }[] {
  const definitions = new Map(library.components.map((component) => [component.id, component]));
  return instancesOf(document.body).flatMap((instance) => {
    const props = definitions.get(instance.component)?.props ?? {};
    const staleProps = Object.keys(instance.props ?? {}).filter((name) => !Object.hasOwn(props, name));
    return staleProps.length ? [{ nodeId: instance.id, component: instance.component, staleProps }] : [];
  });
}

/** 部品が公開した href の props の名前。 */
const hrefProps = (library: ComponentLibrary): Map<string, string[]> =>
  new Map(library.components.map((component) => [component.id, Object.entries(component.props ?? {}).flatMap(([name, prop]) => prop.field === "href" ? [name] : [])]));
/** ページごとのリンク先（href の公開 props）で path を指すインスタンスの ID。 */
function instanceLinks(nodes: readonly PageNode[], library: ComponentLibrary, path: string, domains: readonly string[]): string[] {
  const names = hrefProps(library), wanted = path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
  return instancesOf(nodes).flatMap((instance) => (names.get(instance.component) ?? []).some((name) => {
    const value = instance.props?.[name];
    return typeof value === "string" && linkTarget(value, domains)?.path === wanted;
  }) ? [instance.id] : []);
}
function rewriteInstances<T extends { body: PageNode[] }>(container: T, library: ComponentLibrary, from: string, to: string, domains: readonly string[]): T {
  const copy = structuredClone(container), names = hrefProps(library), wanted = from.length > 1 ? from.replace(/\/+$/, "") || "/" : from;
  for (const instance of instancesOf(copy.body)) for (const name of names.get(instance.component) ?? []) {
    const value = instance.props?.[name], target = typeof value === "string" ? linkTarget(value, domains) : undefined;
    if (instance.props && target?.path === wanted) instance.props[name] = `${to}${target.rest}`;
  }
  return copy;
}

/**
 * ページのパス変更の影響に含める、部品の中で path を指すリンク。部品の root のリンクと、
 * 部品の中に置いた別部品のページごとのリンク先（href の公開 props）を返す。
 */
export function findComponentLinks(library: ComponentLibrary, path: string, domains: readonly string[]): { componentId: string; nodeIds: string[] }[] {
  return library.components.flatMap((component) => {
    const body = [component.root], nodeIds = [...findInternalLinks({ body }, path, domains), ...instanceLinks(body, library, path, domains)];
    return nodeIds.length ? [{ componentId: component.id, nodeIds }] : [];
  });
}
/** 部品の中の from を指すリンクを to へ置き換えたライブラリ。変わった部品だけ version を上げる。revision はホストが保存時に採番する。 */
export function rewriteComponentLinks(library: ComponentLibrary, from: string, to: string, domains: readonly string[]): ComponentLibrary {
  if (validatePagePath(to) !== null) fail("$.to", "invalid page path");
  return { ...structuredClone(library), components: library.components.map((component) => {
    const linked = rewriteInternalLinks({ body: [component.root as PageNode] }, from, to, domains), body = rewriteInstances(linked, library, from, to, domains).body;
    const root = body[0] as ElementNode, changed = JSON.stringify(root) !== JSON.stringify(component.root);
    return { ...structuredClone(component), root, version: changed ? component.version + 1 : component.version };
  }) };
}
/** 文書に置いたインスタンスのページごとのリンク先（href の公開 props）で path を指すもの。 */
export function findInstanceLinks(document: PageDocument, library: ComponentLibrary, path: string, domains: readonly string[]): string[] {
  return instanceLinks(document.body, library, path, domains);
}
/** インスタンスのページごとのリンク先を置き換えた文書。部品の中のリンクは rewriteComponentLinks、要素のリンクは rewriteInternalLinks で置き換える。 */
export function rewriteInstanceLinks(document: PageDocument, library: ComponentLibrary, from: string, to: string, domains: readonly string[]): PageDocument {
  if (validatePagePath(to) !== null) fail("$.to", "invalid page path");
  return rewriteInstances(document, library, from, to, domains);
}
/** 部品の中の素材参照。ホストは素材の使用状況・削除の可否にライブラリも含める。 */
export function componentAssetReferences(library: ComponentLibrary): { componentId: string; placements: AssetPlacement[] }[] {
  return library.components.flatMap((component) => {
    const placements = collectAssetReferences({ schemaVersion: 1, siteId: library.siteId, pageId: "component", locale: "ja", revision: library.revision, title: component.name, tokens: library.tokens, body: [component.root] });
    return placements.length ? [{ componentId: component.id, placements }] : [];
  });
}
