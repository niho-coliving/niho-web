import type { PageDocument, PageNode } from "./types.js";

export type LayerKind = "box" | "image" | "text" | "component" | "instance";
export type LayerEntry = {
  id: string;
  parentId: string | null;
  path: number[];
  depth: number;
  kind: LayerKind;
  label: string;
  node: Exclude<PageNode, { type: "text" }>;
  hasChildren: boolean;
};
export type LayerLabels = {
  blocks?: Readonly<Record<string, string>>;
  components?: ReadonlyMap<string, string>;
};

const textTags = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "span", "label", "button", "a"]);
const plain = (node: PageNode): string => node.type === "text" ? node.text : node.type === "element" ? node.children.map(plain).join(" ") : "";
const excerpt = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 32);

/** レイヤー名は文書へ複製せず、現在のノードから人向けに投影する。raw text は親要素の内容なので行を作らない。 */
export function layerLabel(node: Exclude<PageNode, { type: "text" }>, labels: LayerLabels = {}): string {
  if (node.type === "component") return labels.blocks?.[node.block] ?? "コンポーネント";
  if (node.type === "instance") return labels.components?.get(node.component) ?? "共通部品";
  if (node.tag === "img" || node.tag === "picture") return "画像";
  if (textTags.has(node.tag)) {
    const value = excerpt(plain(node));
    return value || "テキスト";
  }
  return "ボックス";
}

export function layerKind(node: Exclude<PageNode, { type: "text" }>): LayerKind {
  if (node.type === "component") return "component";
  if (node.type === "instance") return "instance";
  if (node.tag === "img" || node.tag === "picture") return "image";
  return textTags.has(node.tag) ? "text" : "box";
}

/** PageDocument の順序と親子関係をそのまま投影する。ID が各行の正本で、path は現在文書でだけ有効な派生値。 */
export function projectLayers(document: PageDocument, labels: LayerLabels = {}): LayerEntry[] {
  const result: LayerEntry[] = [];
  function visit(nodes: readonly PageNode[], parentPath: readonly number[], parentId: string | null): void {
    nodes.forEach((node, index) => {
      if (node.type === "text") return;
      const path = [...parentPath, index];
      const children = node.type === "element" ? node.children : [];
      result.push({ id: node.id, parentId, path, depth: path.length - 1, kind: layerKind(node), label: layerLabel(node, labels), node, hasChildren: children.some((child) => child.type !== "text") });
      if (node.type === "element") visit(node.children, path, node.id);
    });
  }
  visit(document.body, [], null);
  return result;
}

/** 配列位置は保持せず、現在の文書から安定 ID の path を引き直す。 */
export function pathForNodeId(document: PageDocument, id: string | null | undefined): number[] | null {
  if (!id) return null;
  const entry = projectLayers(document).find((item) => item.id === id);
  return entry ? entry.path : null;
}

export function visibleLayers(entries: readonly LayerEntry[], expanded: ReadonlySet<string>): LayerEntry[] {
  const hidden = new Set<string>();
  const result: LayerEntry[] = [];
  for (const entry of entries) {
    if (entry.parentId && hidden.has(entry.parentId)) hidden.add(entry.id);
    else result.push(entry);
    if (entry.hasChildren && !expanded.has(entry.id)) hidden.add(entry.id);
  }
  return result;
}

/** 表示倍率はページ幅と独立し、作業領域へ収める場合も 100% を越えて拡大しない。 */
export function fitCanvasScale(pageWidth: number, availableWidth: number): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  return Math.max(0.1, Math.min(1, availableWidth / pageWidth));
}

/** 倍率後も作業領域の高さを使えるよう、iframe が持つ実寸の viewport 高を返す。 */
export function canvasViewportHeight(scale: number, availableHeight: number, minimum = 800): number {
  const floor = Number.isFinite(minimum) && minimum > 0 ? minimum : 800;
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(availableHeight) || availableHeight <= 0) return floor;
  return Math.max(floor, Math.ceil(availableHeight / scale));
}
