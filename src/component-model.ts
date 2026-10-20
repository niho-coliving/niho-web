import { COMPONENT_LIMITS, instancesOf, instantiate, ownElements } from "./component-expand.js";
import { fitsPropField, parseComponentLibrary } from "./components.js";
import { parsePageDocument } from "./document.js";
import type { EditorLock } from "./editor-types.js";
import { copyId, nodeAt, siblingsAt, walkNodes, type NodePath } from "./node-tree.js";
import type {
  BlockContracts, ComponentDefinition, ComponentKind, ComponentLibrary, ComponentNode, ComponentPropDefinition, ElementNode, NodeStyle, PageDocument, PageNode, StyleDeclarations, StyleProperty
} from "./types.js";

// 部品の編集操作。すべて検証済みの新しいライブラリ・文書を返す。ページでの使用状況の確認は呼び出し側が行う。
const declarationSets = (style: NodeStyle | undefined): StyleDeclarations[] => style ? [style.base ?? {}, ...(style.responsive ?? []).map((entry) => entry.declarations), ...Object.values(style.states ?? {})] : [];
/** ノードの style と、業務ブロックなら表示領域（slots）の style のすべての宣言。 */
const nodeDeclarations = (node: Exclude<PageNode, { type: "text" }>): StyleDeclarations[] =>
  [...declarationSets(node.style), ...(node.type === "component" ? Object.values(node.slots ?? {}).flatMap(declarationSets) : [])];
function componentIndex(library: ComponentLibrary, componentId: string): number {
  const index = library.components.findIndex((component) => component.id === componentId);
  if (index < 0) throw new Error("部品が見つかりません。");
  return index;
}
function replaced(library: ComponentLibrary, index: number, definition: ComponentDefinition): ComponentLibrary {
  return { ...library, components: library.components.map((component, current) => current === index ? definition : component) };
}
function checkedName(library: ComponentLibrary, name: string, except?: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("部品の名前を入力してください。");
  if (library.components.some((component) => component.id !== except && component.name.trim() === trimmed)) throw new Error("同じ名前の部品があります。");
  return trimmed;
}
function nextComponentId(library: ComponentLibrary): string {
  const used = new Set(library.components.map((component) => component.id));
  let index = 1;
  while (used.has(`component_${index}`)) index++;
  return `component_${index}`;
}

/** 選択した element を部品にしてインスタンスへ置き換える。ノード ID は前順に n1, n2… と振り直し、HTML ID は保つ。 */
export function createComponentFromNode(document: PageDocument, path: NodePath, library: ComponentLibrary, input: { name: string; kind: ComponentKind },
  blocks: BlockContracts = {}, locks: readonly EditorLock[] = []): { document: PageDocument; library: ComponentLibrary; componentId: string } {
  const draft = structuredClone(document), node = nodeAt(draft, path);
  if (node.type !== "element") throw new Error("要素を選択してください。");
  const subtree = walkNodes({ ...draft, body: [node] });
  // ページ固有のロックはページのノード ID に結び付くため、部品の中へ持ち込まない。
  if (subtree.some(({ node }) => node.type !== "text" && locks.some((lock) => lock.nodeId === node.id))) throw new Error("データ連動値を含む要素は部品にできません。");
  const name = checkedName(library, input.name), componentId = nextComponentId(library), tokens = structuredClone(library.tokens);
  for (const { node: current } of subtree) {
    if (current.type === "text") continue;
    for (const declarations of nodeDeclarations(current)) for (const value of Object.values(declarations)) {
      if (typeof value === "object" && "token" in value && !Object.hasOwn(tokens, value.token) && Object.hasOwn(draft.tokens, value.token)) tokens[value.token] = structuredClone(draft.tokens[value.token]!);
    }
  }
  const root = structuredClone(node);
  let counter = 0;
  const renumber = (current: PageNode): void => {
    if (current.type === "text") return;
    current.id = `n${++counter}`;
    if (current.type === "element") current.children.forEach(renumber);
  };
  renumber(root);
  siblingsAt(draft, path)[path.at(-1)!] = { type: "instance", id: node.id, component: componentId };
  const next = parseComponentLibrary({ ...library, tokens, components: [...library.components, { id: componentId, name, kind: input.kind, version: 1, root }] }, blocks);
  return { document: parsePageDocument(draft, blocks, { components: next }), library: next, componentId };
}
export function renameComponent(library: ComponentLibrary, componentId: string, name: string, blocks: BlockContracts = {}): ComponentLibrary {
  const index = componentIndex(library, componentId);
  return parseComponentLibrary(replaced(library, index, { ...library.components[index]!, name: checkedName(library, name, componentId) }), blocks);
}
export function setComponentKind(library: ComponentLibrary, componentId: string, kind: ComponentKind, blocks: BlockContracts = {}): ComponentLibrary {
  const index = componentIndex(library, componentId);
  return parseComponentLibrary(replaced(library, index, { ...library.components[index]!, kind }), blocks);
}
/** 新しい ID と「<名前> のコピー」（重複時は末尾に 2, 3…）で複製する。version は 1 から。 */
export function duplicateComponent(library: ComponentLibrary, componentId: string, blocks: BlockContracts = {}): { library: ComponentLibrary; componentId: string } {
  const source = library.components[componentIndex(library, componentId)]!, id = nextComponentId(library);
  const names = new Set(library.components.map((component) => component.name.trim()));
  const named = (suffix: string) => `${source.name.trim().slice(0, COMPONENT_LIMITS.nameLength - suffix.length)}${suffix}`;
  let index = 1, name = named(" のコピー");
  while (names.has(name)) name = named(` のコピー ${++index}`);
  const copy: ComponentDefinition = { ...structuredClone(source), id, name, version: 1 };
  return { library: parseComponentLibrary({ ...library, components: [...library.components, copy] }, blocks), componentId: id };
}
export function removeComponent(library: ComponentLibrary, componentId: string, blocks: BlockContracts = {}): ComponentLibrary {
  const index = componentIndex(library, componentId);
  if (library.components.some((component) => component.id !== componentId && instancesOf([component.root]).some((instance) => instance.component === componentId))) {
    throw new Error("他の部品から使われているため削除できません。");
  }
  return parseComponentLibrary({ ...library, components: library.components.filter((_, current) => current !== index) }, blocks);
}
/** 公開 props を設定する。definition が undefined なら公開をやめる（インスタンスの値は文書に残る）。 */
export function setComponentProp(library: ComponentLibrary, componentId: string, name: string, definition: ComponentPropDefinition | undefined, blocks: BlockContracts = {}): ComponentLibrary {
  const index = componentIndex(library, componentId), current = library.components[index]!;
  const entries = Object.entries(current.props ?? {}), position = entries.findIndex(([key]) => key === name);
  if (definition) {
    if (position < 0) entries.push([name, definition]); else entries[position] = [name, definition];
  } else if (position >= 0) entries.splice(position, 1);
  const { id, name: componentName, kind, version, root } = current;
  return parseComponentLibrary(replaced(library, index, { id, name: componentName, kind, version, root, ...(entries.length ? { props: Object.fromEntries(entries) } : {}) }), blocks);
}
/** 部品の root を1つだけ持つ編集用の文書。tokens はライブラリの値。 */
export function componentDocument(library: ComponentLibrary, componentId: string, locale: string): PageDocument {
  const definition = library.components[componentIndex(library, componentId)]!;
  return { schemaVersion: 1, siteId: library.siteId, pageId: "component", locale, revision: library.revision, title: definition.name, tokens: structuredClone(library.tokens), body: [structuredClone(definition.root)] };
}
/** componentDocument で編集した文書を部品へ書き戻す。公開 props の対象は先に公開をやめないと削除・変更できない。 */
export function withComponentDocument(library: ComponentLibrary, componentId: string, document: PageDocument, blocks: BlockContracts = {}): ComponentLibrary {
  const index = componentIndex(library, componentId), current = library.components[index]!, root = document.body[0];
  if (document.body.length !== 1 || root?.type !== "element") throw new Error("部品には外枠の要素が1つだけ必要です。");
  const elements = ownElements(root);
  if (Object.values(current.props ?? {}).some((prop) => { const target = elements.get(prop.node); return !target || !fitsPropField(target, prop.field); })) {
    throw new Error("ページごとの値に使っている要素は削除・変更できません。先にページごとの値を解除してください。");
  }
  return parseComponentLibrary({ ...replaced(library, index, { ...current, root: structuredClone(root) }), tokens: structuredClone(document.tokens) }, blocks);
}
/** 保存済みの定義と内容（version 以外）が異なる部品だけ、保存済みの version + 1 にする。 */
export function bumpChangedComponentVersions(library: ComponentLibrary, saved: ComponentLibrary | undefined): ComponentLibrary {
  const previous = new Map((saved?.components ?? []).map((component) => [component.id, component]));
  const content = (component: ComponentDefinition) => JSON.stringify({ ...component, version: 0 });
  const result = structuredClone(library);
  for (const component of result.components) {
    const before = previous.get(component.id);
    if (before) component.version = content(component) === content(before) ? before.version : before.version + 1;
  }
  return result;
}
/**
 * インスタンスを1段だけ展開した element に置き換える。root はインスタンスの ID を保ち、内側は部品の ID
 * （文書で使用済みなら _copy<n> を付ける）にする。入れ子の部品はインスタンスのまま残す。
 * 文書にない部品ライブラリの token は値として埋め込む。文書へ token を写すと、同じ文書の他のインスタンスが
 * 以後のライブラリの token の変更を受けなくなるため。
 */
export function detachInstance(document: PageDocument, path: NodePath, library: ComponentLibrary, blocks: BlockContracts = {}): PageDocument {
  const draft = structuredClone(document), node = nodeAt(draft, path);
  if (node.type !== "instance") throw new Error("部品のインスタンスを選択してください。");
  const definition = library.components.find((component) => component.id === node.component);
  if (!definition) throw new Error("部品が見つかりません。");
  const root = instantiate(node, definition), used = new Set(walkNodes(draft).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
  const inline = (current: ElementNode | ComponentNode): void => {
    for (const declarations of nodeDeclarations(current)) for (const [property, value] of Object.entries(declarations)) {
      if (typeof value === "object" && "token" in value && !Object.hasOwn(draft.tokens, value.token) && Object.hasOwn(library.tokens, value.token)) declarations[property as StyleProperty] = library.tokens[value.token]!.value;
    }
  };
  const rename = (current: PageNode): void => {
    if (current.type === "text") return;
    if (used.has(current.id)) current.id = copyId(current.id, used); else used.add(current.id);
    if (current.type === "instance") return;
    inline(current);
    if (current.type === "element") current.children.forEach(rename);
  };
  inline(root);
  root.children.forEach(rename);
  root.id = node.id;
  siblingsAt(draft, path)[path.at(-1)!] = root;
  return parsePageDocument(draft, blocks, { components: library });
}
