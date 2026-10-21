"use client";

import { useEffect, useId, useMemo, useRef } from "react";
import type { InputRenderer } from "./component-panel.js";
import { editDocument, nodeAt, walkNodes, type EditorOperation, type NodePath } from "./editor-model.js";
import { StyleInspector, type StyleInspectorProps } from "./editor-style-inspector.js";
import type { EditorBlockRegistry } from "./editor-types.js";
import { declarationsAt } from "./style-model.js";
import { isStyleProperty } from "./style-values.js";
import type { BlockSlot, ComponentNode, NodeStyle, PageDocument, PageNode } from "./types.js";
import { DocumentValidationError } from "./validation-utils.js";

// 業務ブロックの表示領域（slots）の表示部品。文書は変更せず、操作はエディターの apply / preview へ渡す。値（料金・在庫・予約先）の入力欄は持たない。

const previews = new WeakMap<EditorBlockRegistry, EditorBlockRegistry>();
/** キャンバスと部品の縮小表示で描く registry。preview を持つブロックだけ描画を差し替え、無ければ同じ registry を返す。 */
export function previewRegistry(blocks: EditorBlockRegistry): EditorBlockRegistry {
  if (!Object.values(blocks).some((block) => block.preview)) return blocks;
  let derived = previews.get(blocks);
  if (!derived) previews.set(blocks, derived = Object.fromEntries(Object.entries(blocks).map(([name, block]) => [name, block.preview ? { ...block, component: block.preview } : block])));
  return derived;
}

/** キャンバスで押した要素に最も近い data-nw-slot が、ブロックの枠の内側にある宣言済みの領域ならその名前。 */
export function slotFromTarget(target: Element, wrapper: Element, slots: Readonly<Record<string, BlockSlot>> | undefined): string | null {
  const element = target.closest("[data-nw-slot]"), name = element?.getAttribute("data-nw-slot");
  return element && name && element !== wrapper && wrapper.contains(element) && slots && Object.hasOwn(slots, name) ? name : null;
}

/** registry が宣言した表示領域。Object.prototype の名前は領域として扱わない。 */
export const declaredSlot = (definition: EditorBlockRegistry[string] | undefined, slot: string): BlockSlot | undefined =>
  definition?.slots && Object.hasOwn(definition.slots, slot) ? definition.slots[slot] : undefined;
const problem = (error: unknown) => error instanceof DocumentValidationError ? "文書のルールに合いません。URL・単位・親要素を確認してください。" : error instanceof Error ? error.message : "入力を適用できません。";
/**
 * 表示領域へ向けた見た目の操作（StyleInspector の変更とキャンバスのサイズ変更）を slotStyle の並びにする。問題があれば理由を返す。
 * 領域の見た目をノードの style に見立てた 1 ノードの文書で同じ操作を試し、変わった宣言だけを書く。「〜だけ」の範囲、サイズの丸めと上限もノードと同じになる。
 */
export function slotOperations(document: PageDocument, path: NodePath, slot: string, blocks: EditorBlockRegistry, operation: EditorOperation): EditorOperation[] | string {
  let node: PageNode;
  try { node = nodeAt(document, path); } catch { return "表示領域が見つかりません。"; }
  const definition = node.type === "component" ? blocks[node.block] : undefined, declared = declaredSlot(definition, slot);
  if (node.type !== "component" || !definition || !declared) return "表示領域が見つかりません。";
  const allowed: readonly string[] = declared.style ?? [];
  if (operation.type === "resize" && !(allowed.includes("width") && allowed.includes("height"))) return "この領域ではサイズを直接変更できません。";
  if (operation.type !== "style" && operation.type !== "styles" && operation.type !== "styleRange" && operation.type !== "resize" ||
    (operation.type === "style" ? [operation.property] : operation.type === "resize" ? [] : Object.keys(operation.values)).some((property) => !allowed.includes(property))) return "この領域では変更できない見た目です。";
  const before: NodeStyle = node.slots?.[slot] ?? {};
  let after: NodeStyle;
  try {
    const probe: PageDocument = { ...document, body: [{ type: "component", id: node.id, block: node.block, props: node.props, style: before }] };
    const result = editDocument(probe, { ...operation, path: [0] }, { [node.block]: { ...definition, styleProperties: declared.style ?? [] } }).body[0];
    after = result?.type === "component" ? result.style ?? {} : {};
  } catch (error) { return problem(error); }
  const widths = [...new Set([...before.responsive ?? [], ...after.responsive ?? []].map((entry) => entry.minWidth))].sort((a, b) => a - b);
  return (["base", ...widths] as (number | "base")[]).flatMap((breakpoint) => {
    const old = declarationsAt(before, breakpoint) ?? {}, next = declarationsAt(after, breakpoint) ?? {};
    return [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(isStyleProperty).filter((property) => JSON.stringify(old[property]) !== JSON.stringify(next[property]))
      .map((property): EditorOperation => ({ type: "slotStyle", path, slot, breakpoint, property, value: next[property] }));
  });
}
/** slotOperations の結果を 1 回の履歴として apply する。 */
export function applyToSlot(document: PageDocument, path: NodePath, slot: string, blocks: EditorBlockRegistry, operation: EditorOperation, apply: (operations: readonly EditorOperation[]) => string | undefined): string | undefined {
  const operations = slotOperations(document, path, slot, blocks, operation);
  return typeof operations === "string" ? operations : operations.length ? apply(operations) : undefined;
}

/** 押した行・ボタンが消えてフォーカスを失ったときだけ、次に操作する要素へ移す。キャンバスから選んだときは動かさない。 */
function useFocusWhenLost<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current, focused = element?.ownerDocument.activeElement;
    if (active && element && (!focused || focused === element.ownerDocument.body)) element.focus();
  }, [active]);
  return ref;
}
function SlotRow({ slot, choose, disabled, focus }: { slot: BlockSlot; choose: () => void; disabled: boolean; focus: boolean }) {
  const id = useId(), button = useFocusWhenLost<HTMLButtonElement>(focus);
  return <li><button ref={button} type="button" className="e-slot" aria-labelledby={`${id}-name`} aria-describedby={slot.data ? `${id}-style ${id}-data` : `${id}-style`} disabled={disabled} onClick={choose}>
    <span id={`${id}-name`} className="e-slot-name">{slot.label}</span>
    <small id={`${id}-style`}>{slot.style?.length ? "見た目を変更できます" : "見た目は変更できません"}</small>{slot.data && <small id={`${id}-data`}>値は{slot.data.source}が正本です</small>}
  </button></li>;
}
/** ブロックの表示領域の一覧。行を選ぶと、キャンバスで領域を押したときと同じくその領域を選ぶ。focus は「ブロック全体に戻る」で戻った領域。 */
export function BlockSlotList({ slots, choose, disabled, focus }: { slots: Readonly<Record<string, BlockSlot>> | undefined; choose: (slot: string) => void; disabled: boolean; focus?: string | undefined }) {
  const entries = Object.entries(slots ?? {});
  if (!entries.length) return null;
  return <section className="e-sec" aria-label="表示領域"><h3>表示領域</h3>
    <p className="e-help">領域を選ぶと、見た目の設定と値の正本を確認できます。キャンバスで押しても選べます。</p>
    <ul className="e-slot-list">{entries.map(([name, slot]) => <SlotRow key={name} slot={slot} choose={() => choose(name)} disabled={disabled} focus={focus === name} />)}</ul>
  </section>;
}

function replaceAt(nodes: readonly PageNode[], path: NodePath, next: PageNode): PageNode[] {
  const [index, ...rest] = path;
  return nodes.map((node, at) => at !== index ? node : !rest.length ? next : node.type === "element" ? { ...node, children: replaceAt(node.children, rest, next) } : node);
}
/** StyleInspector に渡す、エディターの段・表示幅・入力中の状態。fieldKey は領域ごとに分ける。 */
export type SlotStyleContext = Pick<StyleInspectorProps, "tiers" | "tier" | "setTier" | "range" | "setRange" | "width" | "setWidth" | "pending" | "fieldKey" | "disabled" | "tierLocked">;
/**
 * 選んだ表示領域の設定。見た目は StyleInspector を領域の見た目で使い（ブロックの style を領域の style に置き換えた文書とノード、
 * styleProperties を領域の style にした registry）、操作は slotStyle へ写す。text は表示用の文字だけ、data は理由と正本だけを示す。
 */
export function BlockSlotInspector({ document, node, path, slot, blocks, saved, back, apply, preview, reason, notify, input, style }: {
  document: PageDocument; node: ComponentNode; path: NodePath; slot: string; blocks: EditorBlockRegistry;
  /** 保存済み文書の fingerprint。領域の保存済みの見た目と比べて「保存前」を付ける。 */
  saved: string | undefined;
  back: () => void;
  apply: (operations: readonly EditorOperation[]) => string | undefined;
  preview: (operations: readonly EditorOperation[] | null) => void;
  reason: (field: string) => string | undefined;
  notify: (message: string) => void;
  input: InputRenderer;
  style: SlotStyleContext;
}) {
  const definition = blocks[node.block], declared = declaredSlot(definition, slot);
  const heading = useFocusWhenLost<HTMLHeadingElement>(true);
  const view = useMemo(() => {
    const pseudo: ComponentNode = { ...node, style: node.slots?.[slot] ?? {} };
    return { node: pseudo, document: { ...document, body: replaceAt(document.body, path, pseudo) } };
  }, [document, node, path, slot]);
  const scoped = useMemo(() => definition ? { ...blocks, [node.block]: { ...definition, styleProperties: declared?.style ?? [] } } : blocks, [blocks, definition, declared, node.block]);
  // StyleInspector は保存済みの文書から同じ ID のノードの style を読むため、保存済みの領域の見た目をその style にした文書を渡す。
  const savedSlot = useMemo(() => {
    if (saved === undefined) return undefined;
    try {
      const before = walkNodes(JSON.parse(saved) as PageDocument).find(({ node: entry }) => entry.type === "component" && entry.id === node.id)?.node as ComponentNode | undefined;
      return JSON.stringify({ body: before ? [{ ...before, style: before.slots?.[slot] ?? {} }] : [] });
    } catch { return undefined; }
  }, [saved, node.id, slot]);
  if (!definition || !declared) return null;
  const run = (operation: EditorOperation) => applyToSlot(document, path, slot, blocks, operation, apply);
  const draft = (operation: EditorOperation | null) => {
    if (!operation) { preview(null); return; }
    const operations = slotOperations(document, path, slot, blocks, operation);
    if (typeof operations !== "string") preview(operations);
  };
  const text = declared.text, rule = text === undefined ? undefined : definition.props[text];
  const max = Math.min(rule?.type === "string" ? rule.maxLength ?? 4096 : 4096, 4096);
  const change = (value: string) => !text || !rule ? undefined : value.length > max ? `${max}文字以内で入力してください。`
    : apply([{ type: "prop", path, name: text, value: value === "" && !rule.required ? undefined : value }]);
  return <>
    <h2 ref={heading} tabIndex={-1}>{definition.label ?? "業務ブロック"} · {declared.label}</h2>
    <div className="e-actions"><button type="button" disabled={style.disabled} onClick={back}>ブロック全体に戻る</button></div>
    <p className="e-help">ブロックの中の同じ領域（繰り返すカードなど）すべてに同じ見た目を適用します。</p>
    {declared.data && <p className="e-slot-note" role="note">値は{declared.data.source}が正本です。{declared.data.reason}</p>}
    {text && rule && input(`${declared.label}の文字`, String(node.props[text] ?? ""), change, `slot-${slot}-text`,
      { reason: reason(`props.${text}`), ...(rule.type === "string" && rule.maxLength !== undefined ? { hint: (value: string) => `${value.length} / ${max}文字` } : {}) })}
    {declared.style?.length ? <StyleInspector {...style} scope="slot" document={view.document} node={view.node} path={path} blocks={scoped} saved={savedSlot} apply={run} preview={draft}
      reason={(field) => reason(field === "style" || field.startsWith("style.") ? `slots.${slot}${field.slice(5)}` : field)} notify={notify} />
      : <p className="e-help">この領域の見た目は変更できません。</p>}
  </>;
}
