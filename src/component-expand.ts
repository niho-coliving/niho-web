import type { ComponentDefinition, ComponentLibrary, ElementNode, InstanceNode, NodeStyle, PageDocument, PageNode, StyleDeclarations } from "./types.js";
import { fail } from "./validation-utils.js";

export const COMPONENT_LIMITS = Object.freeze({
  components: 200,
  /** ライブラリ全体のノード数。 */
  nodes: 5000,
  props: 32,
  instanceProps: 64,
  nesting: 4,
  nameLength: 80,
  labelLength: 40
});

/** 展開したノードの出所。chain は文書のインスタンス ID から、部品の中に書かれた入れ子のインスタンス ID の順。 */
export type ResolvedOrigin = { instance: string; component: string; node: string; chain: readonly string[] };

/** @internal 前順。インスタンスは子を持たないため、部品の内側へは入らない。 */
export function instancesOf(nodes: readonly PageNode[]): InstanceNode[] {
  return nodes.flatMap((node) => node.type === "instance" ? [node] : node.type === "element" ? instancesOf(node.children) : []);
}
/** @internal root と子孫の element。入れ子にした部品の内部は含まない。 */
export function ownElements(root: ElementNode): Map<string, ElementNode> {
  const result = new Map<string, ElementNode>();
  const visit = (node: PageNode): void => { if (node.type === "element") { result.set(node.id, node); node.children.forEach(visit); } };
  visit(root);
  return result;
}
/** @internal インスタンスの style を部品の root の style へプロパティ単位で重ねる。登場・幅別の非表示は丸ごと置き換える。空の指定は残さない。 */
export function mergeStyle(base: NodeStyle | undefined, overlay: NodeStyle): NodeStyle | undefined {
  const declarations: StyleDeclarations = { ...base?.base, ...overlay.base }, widths = new Map<number, StyleDeclarations>();
  for (const entry of [...(base?.responsive ?? []), ...(overlay.responsive ?? [])]) widths.set(entry.minWidth, { ...widths.get(entry.minWidth), ...entry.declarations });
  const responsive = [...widths].sort(([a], [b]) => a - b).filter(([, values]) => Object.keys(values).length).map(([minWidth, values]) => ({ minWidth, declarations: values }));
  const states: NonNullable<NodeStyle["states"]> = {};
  for (const name of ["hover", "focus", "active"] as const) {
    const values = { ...base?.states?.[name], ...overlay.states?.[name] };
    if (Object.keys(values).length) states[name] = values;
  }
  const appear = overlay.appear ?? base?.appear, hidden = overlay.hidden ?? base?.hidden, textStyle = overlay.textStyle ?? base?.textStyle;
  const result: NodeStyle = { ...(textStyle ? { textStyle } : {}), ...(Object.keys(declarations).length ? { base: declarations } : {}), ...(responsive.length ? { responsive } : {}),
    ...(Object.keys(states).length ? { states } : {}), ...(appear ? { appear } : {}), ...(hidden?.length ? { hidden } : {}) };
  return Object.keys(result).length ? structuredClone(result) : undefined;
}
/** @internal 公開 props と外枠の style を適用した部品 root の複製。ID は部品の中のまま。 */
export function instantiate(instance: InstanceNode, definition: ComponentDefinition): ElementNode {
  const root = structuredClone(definition.root), elements = ownElements(root);
  for (const [name, value] of Object.entries(instance.props ?? {})) {
    // 部品が公開をやめた値は適用せずに文書へ残す。
    if (!definition.props || !Object.hasOwn(definition.props, name)) continue;
    const prop = definition.props[name]!, target = elements.get(prop.node);
    if (!target) continue;
    if (prop.field === "text") target.children = value === "" ? [] : [{ type: "text", text: value }];
    else target.attrs = { ...target.attrs, [prop.field]: value };
  }
  if (instance.style) {
    const style = mergeStyle(root.style, instance.style);
    if (style) root.style = style; else delete root.style;
  }
  return root;
}

type Expansion = { components: ReadonlyMap<string, ComponentDefinition>; origins: Map<string, ResolvedOrigin>; nodes: number; text: number };
// 文書検証と同じ前順・同じ上限で数え、入れ子の部品による膨張を検証前に作り切らない。
function spend(state: Expansion, node: PageNode, at: string): void {
  if (++state.nodes > 5000) fail(at, "too many nodes");
  if (node.type === "text" && (state.text += node.text.length) > 1000000) fail(at, "too much text");
}
function expandInstance(instance: InstanceNode, id: string, chain: readonly string[], at: string, state: Expansion): ElementNode {
  const definition = state.components.get(instance.component);
  if (!definition) fail(`${at}.component`, "unknown component");
  const links = Object.freeze([...chain, instance.id]), root = instantiate(instance, definition);
  const visit = (node: PageNode, at: string): PageNode => {
    if (node.type === "text") { spend(state, node, at); return node; }
    // root はインスタンスの ID、内側は <インスタンスの ID>--<部品内の ID>。HTML の attrs.id は付け替えない。
    const resolved = node === root ? id : `${id}--${node.id}`;
    if (node.type === "instance") return expandInstance(node, resolved, links, at, state);
    spend(state, node, at);
    state.origins.set(resolved, { instance: links[0]!, component: definition.id, node: node.id, chain: links });
    node.id = resolved;
    if (node.type === "element") node.children = node.children.map((child, index) => visit(child, `${at}.children[${index}]`));
    return node;
  };
  return visit(root, at) as ElementNode;
}
/**
 * @internal 検証済みの文書とライブラリから、インスタンスを element に置き換えた文書を作る。
 * インスタンスがある場合だけ tokens をライブラリ → 文書の順に重ねる。結果は呼び出し側が文書として検証する。
 */
export function expandDocument(document: PageDocument, library: ComponentLibrary): { document: PageDocument; origins: Map<string, ResolvedOrigin> } {
  const state: Expansion = { components: new Map(library.components.map((component) => [component.id, component])), origins: new Map(), nodes: 0, text: 0 };
  const result = structuredClone(document);
  if (!instancesOf(result.body).length) return { document: result, origins: state.origins };
  const visit = (nodes: PageNode[], path: string): PageNode[] => nodes.map((node, index) => {
    const at = `${path}[${index}]`;
    if (node.type === "instance") return expandInstance(node, node.id, [], at, state);
    spend(state, node, at);
    if (node.type === "element") node.children = visit(node.children, `${at}.children`);
    return node;
  });
  result.tokens = { ...structuredClone(library.tokens), ...result.tokens };
  result.body = visit(result.body, "$.body");
  return { document: result, origins: state.origins };
}
