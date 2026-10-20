import { parsePageDocument } from "./document.js";
import type { EditorBlockRegistry, EditorLock, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorTarget } from "./editor-types.js";
import type { AssetReference, ComponentNode, ElementNode, PageDocument, PageNode, PublicPropValue, StyleDeclarations, StyleProperty, StyleValue } from "./types.js";
import { isSafeHttpsOrigin } from "./validation-utils.js";

export type NodePath = readonly number[];
export type EditorOperation =
  | { type: "text"; path: NodePath; value: string }
  | { type: "attribute"; path: NodePath; name: string; value: string }
  | { type: "tag"; path: NodePath; value: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }
  | { type: "prop"; path: NodePath; name: string; value: PublicPropValue | undefined }
  | { type: "style"; path: NodePath; breakpoint: number | "base"; property: StyleProperty; value: StyleValue | undefined }
  | { type: "resize"; path: NodePath; breakpoint: number | "base"; width: number; height: number }
  | { type: "title"; value: string }
  | { type: "add"; parentId: string | null; node: PageNode; index?: number }
  | { type: "replaceChildren"; path: NodePath; children: PageNode[] }
  | { type: "image"; path: NodePath; source: { asset: AssetReference } | { src: string }; alt?: string }
  | { type: "background"; path: NodePath; breakpoint: number | "base"; asset: AssetReference | undefined }
  | { type: "replaceAsset"; from: AssetReference; to: AssetReference }
  | { type: "duplicate" | "remove"; path: NodePath }
  | { type: "move"; path: NodePath; parentId: string | null; index: number };
export type EditorHistory = { past: PageDocument[]; present: PageDocument; future: PageDocument[] };
export const fingerprint = (document: PageDocument): string => JSON.stringify(document);
export function nodeAt(document: PageDocument, path: NodePath): PageNode {
  if (!path.length) throw new Error("要素を選択してください。");
  let children = document.body, result: PageNode | undefined;
  for (const [level, index] of path.entries()) {
    if (!Number.isInteger(index) || index < 0 || !children[index]) throw new Error("選択した要素が見つかりません。");
    result = children[index]!;
    if (level < path.length - 1) {
      if (result.type !== "element") throw new Error("この要素は子を持てません。");
      children = result.children;
    }
  }
  return result!;
}
export function walkNodes(document: PageDocument): { node: PageNode; path: number[] }[] {
  const result: { node: PageNode; path: number[] }[] = [];
  function visit(nodes: PageNode[], parent: number[]): void {
    nodes.forEach((node, index) => {
      const path = [...parent, index]; result.push({ node, path });
      if (node.type === "element") visit(node.children, path);
    });
  }
  visit(document.body, []); return result;
}
export function effectiveLocks(document: PageDocument, locks: readonly EditorLock[], blocks: EditorBlockRegistry): EditorLock[] {
  return [...locks, ...walkNodes(document).flatMap(({ node }) => node.type === "component"
    ? Object.entries(blocks[node.block]?.lockedProps ?? {}).map(([name, reason]) => ({ nodeId: node.id, fields: [`props.${name}`], reason })) : [])];
}
function fieldValue(node: PageNode, field: string): unknown {
  if (field === "*") return node;
  let value: unknown = node;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function assertLocks(before: PageDocument, after: PageDocument, locks: readonly EditorLock[]): void {
  const index = (document: PageDocument) => new Map(walkNodes(document).flatMap(({ node }) => node.type === "text" ? [] : [[node.id, node] as const]));
  const previous = index(before), next = index(after);
  for (const lock of locks) {
    const oldNode = previous.get(lock.nodeId), newNode = next.get(lock.nodeId);
    if (!oldNode) continue;
    if (!newNode || lock.fields.some((field) => JSON.stringify(fieldValue(oldNode, field)) !== JSON.stringify(fieldValue(newNode, field)))) throw new Error(`データ連動値は変更できません。${lock.reason}`);
  }
}
export function lockReason(document: PageDocument, path: NodePath, field: string, locks: readonly EditorLock[]): string | undefined {
  for (let depth = 1; depth <= path.length; depth++) {
    const node = nodeAt(document, path.slice(0, depth));
    if (node.type === "text") continue;
    const inherited = depth < path.length;
    const lock = locks.find((lock) => lock.nodeId === node.id && lock.fields.some((locked) => locked === "*" ||
      (inherited ? locked === "children" : field === locked || field.startsWith(`${locked}.`))));
    if (lock) return lock.reason;
  }
  return undefined;
}
export function editDocument(document: PageDocument, operation: EditorOperation, blocks: EditorBlockRegistry = {}, locks: readonly EditorLock[] = []): PageDocument {
  const draft = structuredClone(document), allLocks = effectiveLocks(document, locks, blocks);
  const parentChildren = (path: NodePath): PageNode[] => {
    if (path.length === 1) return draft.body;
    const parent = nodeAt(draft, path.slice(0, -1));
    if (parent.type !== "element") throw new Error("移動先が要素ではありません。");
    return parent.children;
  };
  const targetChildren = (id: string | null): PageNode[] => {
    if (id === null) return draft.body;
    const found = walkNodes(draft).find(({ node }) => node.type !== "text" && node.id === id)?.node;
    if (!found || found.type !== "element") throw new Error("追加・移動先が見つかりません。");
    return found.children;
  };
  const declarationsAt = (node: ElementNode | ComponentNode, breakpoint: number | "base"): StyleDeclarations => {
    node.style ??= {};
    if (breakpoint === "base") return node.style.base ??= {};
    node.style.responsive ??= [];
    let entry = node.style.responsive.find((entry) => entry.minWidth === breakpoint);
    if (!entry) { entry = { minWidth: breakpoint, declarations: {} }; node.style.responsive.push(entry); }
    node.style.responsive.sort((a, b) => a.minWidth - b.minWidth);
    return entry.declarations;
  };
  const pruneResponsive = (node: ElementNode | ComponentNode) => { if (node.style?.responsive) node.style.responsive = node.style.responsive.filter((entry) => Object.keys(entry.declarations).length); };
  if (operation.type === "title") draft.title = operation.value;
  else if (operation.type === "add") {
    const destination = targetChildren(operation.parentId), index = operation.index ?? destination.length;
    if (!Number.isInteger(index) || index < 0 || index > destination.length) throw new Error("追加先の位置が不正です。");
    destination.splice(index, 0, structuredClone(operation.node));
  } else if (operation.type === "replaceAsset") {
    const { from, to } = operation, same = (reference: AssetReference) => reference.provider === from.provider && reference.id === from.id;
    let count = 0;
    for (const { node } of walkNodes(draft)) {
      if (node.type === "text") continue;
      if (node.type === "element" && node.asset && same(node.asset)) { node.asset = structuredClone(to); count++; }
      for (const declarations of [node.style?.base, ...(node.style?.responsive ?? []).map((entry) => entry.declarations)]) {
        if (declarations?.backgroundImage && same(declarations.backgroundImage.asset)) { declarations.backgroundImage = { asset: structuredClone(to) }; count++; }
      }
    }
    if (!count) throw new Error("置き換える素材がこのページにありません。");
  } else {
    const node = nodeAt(draft, operation.path);
    if (operation.type === "text") {
      if (node.type !== "text") throw new Error("テキストを選択してください。");
      node.text = operation.value;
    } else if (operation.type === "replaceChildren") {
      if (node.type !== "element") throw new Error("文字を編集できる要素を選択してください。");
      node.children = structuredClone(operation.children);
    } else if (operation.type === "tag") {
      if (node.type !== "element" || !["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.tag)) throw new Error("見出し・段落を選択してください。");
      node.tag = operation.value;
    } else if (operation.type === "attribute") {
      if (node.type !== "element") throw new Error("要素を選択してください。");
      node.attrs ??= {};
      if (operation.value === "" && !(node.tag === "img" && operation.name === "alt")) delete node.attrs[operation.name];
      else node.attrs[operation.name] = operation.value;
    } else if (operation.type === "prop") {
      if (node.type !== "component") throw new Error("ブロックを選択してください。");
      if (operation.value === undefined) delete node.props[operation.name]; else node.props[operation.name] = operation.value;
    } else if (operation.type === "style" || operation.type === "resize") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      const declarations = declarationsAt(node, operation.breakpoint);
      if (operation.type === "resize") {
        if (![operation.width, operation.height].every((value) => Number.isFinite(value) && value >= 1 && value <= 10000)) throw new Error("幅と高さは1〜10000pxで指定してください。");
        declarations.width = Math.round(operation.width); declarations.height = Math.round(operation.height);
      } else if (operation.value === undefined) delete declarations[operation.property]; else declarations[operation.property] = operation.value;
      pruneResponsive(node);
    } else if (operation.type === "image") {
      if (node.type !== "element" || node.tag !== "img") throw new Error("画像を選択してください。");
      node.attrs ??= {};
      if ("asset" in operation.source) { node.asset = structuredClone(operation.source.asset); delete node.attrs.src; }
      else { node.attrs.src = operation.source.src; delete node.asset; }
      if (operation.alt !== undefined) node.attrs.alt = operation.alt;
    } else if (operation.type === "background") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      const declarations = declarationsAt(node, operation.breakpoint);
      if (operation.asset === undefined) delete declarations.backgroundImage; else declarations.backgroundImage = { asset: structuredClone(operation.asset) };
      pruneResponsive(node);
    } else if (operation.type === "remove") parentChildren(operation.path).splice(operation.path.at(-1)!, 1);
    else if (operation.type === "duplicate") {
      const subtree = node.type === "text" ? [] : walkNodes({ ...draft, body: [node] });
      if (subtree.some(({ node }) => node.type !== "text" && allLocks.some((lock) => lock.nodeId === node.id))) throw new Error("データ連動値を含む要素は複製できません。");
      const copy = structuredClone(node), used = new Set(walkNodes(draft).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
      const usedHtmlIds = new Set(walkNodes(draft).flatMap(({ node }) => node.type === "element" && typeof node.attrs?.id === "string" ? [node.attrs.id] : []));
      const remap = new Map<string, string>();
      function unique(original: string, set: Set<string>): string { let index = 1, id = original; do { id = `${original.slice(0, 65)}_copy${index++}`; } while (set.has(id)); set.add(id); return id; }
      function rename(current: PageNode): void {
        if (current.type === "text") return;
        current.id = unique(current.id, used);
        if (current.type === "element") {
          if (typeof current.attrs?.id === "string") { const previous = current.attrs.id; current.attrs.id = unique(previous, usedHtmlIds); remap.set(previous, current.attrs.id); }
          current.children.forEach(rename);
        }
      }
      rename(copy);
      function links(current: PageNode): void {
        if (current.type !== "element") return;
        if (typeof current.attrs?.href === "string" && current.attrs.href.startsWith("#") && remap.has(current.attrs.href.slice(1))) current.attrs.href = `#${remap.get(current.attrs.href.slice(1))}`;
        for (const key of ["aria-labelledby", "aria-describedby"]) if (typeof current.attrs?.[key] === "string") current.attrs[key] = current.attrs[key].split(" ").map((id) => remap.get(id) ?? id).join(" ");
        current.children.forEach(links);
      }
      links(copy); parentChildren(operation.path).splice(operation.path.at(-1)! + 1, 0, copy);
    } else if (operation.type === "move") {
      if (operation.parentId && walkNodes({ ...draft, body: [node] }).some(({ node }) => node.type !== "text" && node.id === operation.parentId)) throw new Error("要素を自分の内側へ移動できません。");
      parentChildren(operation.path).splice(operation.path.at(-1)!, 1);
      const destination = targetChildren(operation.parentId);
      if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > destination.length) throw new Error("移動先の位置が不正です。");
      destination.splice(operation.index, 0, node);
    }
  }
  const result = parsePageDocument(draft, blocks);
  assertLocks(document, result, allLocks);
  return result;
}
export function commitHistory(history: EditorHistory, document: PageDocument): EditorHistory {
  if (fingerprint(document) === fingerprint(history.present)) return history;
  return { past: [...history.past.slice(-49), history.present], present: document, future: [] };
}
/** 内容と履歴の順序を保ち、保存先が採番した revision を編集の新しい基準にする。 */
export function acceptSavedRevision(history: EditorHistory, submitted: PageDocument, revision: number): { history: EditorHistory; saved: string } {
  if (!Number.isSafeInteger(revision) || revision <= submitted.revision || history.present.revision !== submitted.revision) throw new Error("保存後の revision が一致しません。編集内容は保持されています。");
  const rebase = (document: PageDocument): PageDocument => ({ ...document, revision });
  return {
    history: { past: history.past.map(rebase), present: rebase(history.present), future: history.future.map(rebase) },
    saved: fingerprint(rebase(submitted))
  };
}
export function travelHistory(history: EditorHistory, direction: "undo" | "redo", blocks: EditorBlockRegistry, locks: readonly EditorLock[]): EditorHistory {
  const target = direction === "undo" ? history.past.at(-1) : history.future[0];
  if (!target) return history;
  assertLocks(history.present, target, effectiveLocks(history.present, locks, blocks));
  return direction === "undo" ? { past: history.past.slice(0, -1), present: target, future: [history.present, ...history.future] }
    : { past: [...history.past, history.present], present: target, future: history.future.slice(1) };
}
export function sameTarget(left: EditorTarget, right: EditorTarget): boolean {
  return left.siteId === right.siteId && left.pageId === right.pageId && left.locale === right.locale;
}
export function validateReleasePlan(plan: EditorReleasePlan, request: EditorReleaseRequest, site: EditorSite): void {
  if (!isSafeHttpsOrigin(plan.domain) || !site.domains.includes(plan.domain) || !sameTarget(plan.target, request.target) || plan.expectedVersion !== request.expectedVersion || plan.action !== request.action || plan.revision !== request.revision ||
    typeof plan.confirmationToken !== "string" || !plan.confirmationToken || !Array.isArray(plan.changes) ||
    plan.changes.some((change) => !change || typeof change.path !== "string" || typeof change.before !== "string" || typeof change.after !== "string") ||
    (request.action === "rollback" && (!Number.isSafeInteger(request.revision) || request.revision! < 1))) throw new Error("公開対象または差分確認の情報が一致しません。再取得してください。");
}
export function newElement(tag: ElementNode["tag"], id: string): ElementNode {
  return tag === "img" ? { type: "element", id, tag, attrs: { src: "/placeholder.webp", alt: "画像の説明" }, children: [] }
    : { type: "element", id, tag, ...(tag === "a" ? { attrs: { href: "/" } } : {}), children: tag === "section" ? [] : [{ type: "text", text: tag === "a" ? "リンク" : "新しいテキスト" }] };
}
