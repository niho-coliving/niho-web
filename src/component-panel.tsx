"use client";

import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ownElements } from "./component-expand.js";
import { fitsPropField } from "./components.js";
import {
  componentKinds, componentPreview, fieldCaptions, kindLabel, masterValue, placementProblem, removalProblem, roleLabels, sortedComponents, usageText, type ComponentUsageSummary
} from "./component-session.js";
import type { EditorBlockRegistry } from "./editor-types.js";
import type { NodePath } from "./node-tree.js";
import { PageRenderer } from "./react.js";
import type { ComponentDefinition, ComponentKind, ComponentLibrary, ComponentPropField, ElementNode, InstanceNode, PageDocument } from "./types.js";

// 共通部品の表示部品。編集操作はすべてエディターから受け取り、ここでは文書・ライブラリを変更しない。
/** エディターの入力欄。apply は問題があれば理由を返す。 */
export type InputRenderer = (name: string, value: string, apply: (value: string) => string | undefined, key: string, options?: { multiline?: boolean }) => ReactNode;
export type ComponentDialogState = { type: "create"; path: NodePath } | { type: "rename"; componentId: string } | { type: "remove"; componentId: string } | { type: "detach"; path: NodePath };
const dialogTitles = { create: "共通部品にする", rename: "名前を変更", remove: "共通部品を削除", detach: "部品を解除" } as const;
export const componentDialogTitle = (dialog: ComponentDialogState): string => dialogTitles[dialog.type];
const Glyph = () => <span className="e-part-glyph" aria-hidden="true">◇ </span>;
const longTextTags = new Set(["p", "blockquote", "li", "dd", "figcaption", "div", "section", "article", "aside"]);

class PreviewGuard extends Component<{ document: PageDocument; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { document: PageDocument }) { if (previous.document !== this.props.document && this.state.failed) this.setState({ failed: false }); }
  render() { return this.state.failed ? <p>プレビューを表示できません</p> : this.props.children; }
}
const StableRenderer = memo(PageRenderer);
const previewWidth = 960, previewHeight = 88, previewFrameHeight = 720, previewPad = 16, previewMaxScale = .6;
type Fit = { scale: number; x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };
/**
 * 縮小表示で見せる範囲。文字と画像の外形を優先し、全幅の背景で縮小表示が細い帯にならないようにする。
 * 文字も画像もない部品だけ、背景・枠のある要素の外形を使う。
 */
function contentBox(body: HTMLElement): Box | undefined {
  const document = body.ownerDocument, view = document.defaultView, root = body.querySelector("[data-nw-scope]");
  if (!view || !root) return undefined;
  const content: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }, decor: Box = { ...content };
  const add = (box: Box, rect: DOMRect) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    box.left = Math.min(box.left, rect.left); box.top = Math.min(box.top, rect.top); box.right = Math.max(box.right, rect.right); box.bottom = Math.min(Math.max(box.bottom, rect.bottom), previewFrameHeight);
  };
  const walker = document.createTreeWalker(root, view.NodeFilter.SHOW_TEXT | view.NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === view.Node.TEXT_NODE) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) add(content, rect);
    } else if (node instanceof view.Element) {
      if (["IMG", "HR", "PICTURE"].includes(node.tagName)) { add(content, node.getBoundingClientRect()); continue; }
      const style = view.getComputedStyle(node);
      if (style.backgroundImage !== "none" || !/^(?:transparent|rgba\(0, 0, 0, 0\))$/.test(style.backgroundColor) || parseFloat(style.borderTopWidth) > 0) add(decor, node.getBoundingClientRect());
    }
  }
  return [content, decor].find((box) => box.left < box.right && box.top < box.bottom);
}
/** 部品を 960px 幅で描き、見えている内容がカードに収まるよう拡大・縮小して中央に置く。内容が同じ間は同じ文書を渡し、再描画しない。 */
export function ComponentPreview({ library, componentId, blocks }: { library: ComponentLibrary; componentId: string; blocks: EditorBlockRegistry }) {
  const box = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null), last = useRef<{ text: string; document: PageDocument } | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null), [fit, setFit] = useState<Fit>({ scale: .23, x: 0, y: 0 });
  const document = useMemo(() => {
    try {
      const next = componentPreview(library, componentId, blocks), text = JSON.stringify(next);
      if (last.current?.text !== text) last.current = { text, document: next };
      return last.current.document;
    } catch { return null; }
  }, [library, componentId, blocks]);
  useEffect(() => {
    const element = box.current; if (!element) return;
    let frameRequest = 0;
    const update = () => {
      const width = element.clientWidth, height = element.clientHeight || previewHeight; if (!width) return;
      const content = body ? contentBox(body) : undefined;
      if (!content) { setFit({ scale: width / previewWidth, x: 0, y: 0 }); return; }
      const contentWidth = content.right - content.left + previewPad * 2, contentHeight = content.bottom - content.top + previewPad * 2;
      const scale = Math.min(width / contentWidth, height / contentHeight, previewMaxScale);
      setFit({ scale, x: (width - contentWidth * scale) / 2 - (content.left - previewPad) * scale, y: (height - contentHeight * scale) / 2 - (content.top - previewPad) * scale });
    };
    // jsdom 等の requestAnimationFrame がない環境では次のタスクで測る。
    const later = (callback: () => void) => typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : window.setTimeout(callback, 0);
    const cancel = (id: number) => typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : window.clearTimeout(id);
    const schedule = () => { cancel(frameRequest); frameRequest = later(update); };
    schedule();
    // 画像の読込後に外形が変わるため測り直す。
    body?.addEventListener("load", schedule, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule); observer?.observe(element);
    return () => { cancel(frameRequest); body?.removeEventListener("load", schedule, true); observer?.disconnect(); };
  }, [body, document]);
  return <div ref={box} className="e-part-thumb" aria-hidden="true">{document ? <><iframe ref={frame} aria-hidden="true" tabIndex={-1} sandbox="allow-same-origin" title=""
    srcDoc={'<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"></body></html>'}
    style={{ width: previewWidth, height: previewFrameHeight, transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})` }} onLoad={() => setBody(frame.current?.contentDocument?.body ?? null)} />
    {body && createPortal(<PreviewGuard document={document}><StableRenderer document={document} blocks={blocks} /></PreviewGuard>, body)}</> : <span>プレビューを表示できません</span>}</div>;
}

type CardActions = {
  place: (componentId: string) => void; drag: (event: React.DragEvent<HTMLElement>, componentId: string) => void; dragEnd: () => void;
  edit: (componentId: string) => void; rename: (componentId: string) => void; duplicate: (componentId: string) => void; remove: (componentId: string) => void;
};
/** 左パネルの共通部品。visible の間だけ縮小表示を描く。 */
export function ComponentPanel({ library, failed, visible, blocks, editing, usage, usageLoading, insertableBlocks, canPlace, disabled, ...actions }: CardActions & {
  library: ComponentLibrary | undefined; failed: boolean; visible: boolean; blocks: EditorBlockRegistry; editing: string | null;
  usage: ReadonlyMap<string, ComponentUsageSummary> | undefined; usageLoading: boolean; insertableBlocks: readonly string[] | undefined;
  /** 配置先の文書があり、編集できる状態か。 */
  canPlace: boolean;
  /** ライブラリを変更できない間。 */
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  if (!library) return <><h3>共通部品</h3><p className="e-help">{failed ? "共通部品を読み込めませんでした。" : "共通部品を読み込んでいます。"}</p></>;
  const list = sortedComponents(library, query);
  return <><h3>共通部品</h3>
    {library.components.length ? <>
      <input type="search" className="e-search" aria-label="共通部品を検索" placeholder="部品名で検索" value={query} onChange={(event) => setQuery(event.target.value)} />
      {list.length ? <div className="e-part-list">{list.map((component) => {
        const summary = usage?.get(component.id), placeProblem = placementProblem(library, component.id, insertableBlocks, editing), removeProblem = removalProblem(library, component.id, summary), current = editing === component.id;
        return <article key={component.id} className={`e-part-card${current ? " is-editing" : ""}`} aria-label={component.name}>
          {visible && <ComponentPreview library={library} componentId={component.id} blocks={blocks} />}
          <div className="e-part-meta"><strong>{component.name}</strong>{current && <span className="e-part-badge">編集中</span>}<small>{kindLabel(component.kind)} · {usageText(summary, usageLoading)}</small></div>
          <div className="e-actions"><button type="button" draggable={canPlace && !placeProblem} onDragStart={(event) => actions.drag(event, component.id)} onDragEnd={actions.dragEnd}
            onClick={() => actions.place(component.id)} disabled={!canPlace || !!placeProblem}>配置</button>
            <button type="button" onClick={() => actions.edit(component.id)} disabled={current}>編集</button></div>
          {placeProblem && <small className="e-help">{placeProblem}</small>}
          <details><summary>その他</summary><div className="e-actions"><button type="button" onClick={() => actions.rename(component.id)} disabled={disabled}>名前を変更</button>
            <button type="button" onClick={() => actions.duplicate(component.id)} disabled={disabled}>複製</button>
            <button type="button" className="e-danger" onClick={() => actions.remove(component.id)} disabled={disabled || !!removeProblem}>削除</button></div>
            {removeProblem && <small className="e-help">{removeProblem}</small>}</details>
        </article>;
      })}</div> : <p className="e-help">「{query.trim()}」に一致する部品はありません。</p>}
    </> : <p className="e-help">共通部品はまだありません。ページの要素を選び、右側の「部品にする」から登録できます。</p>}
  </>;
}

/** 部品の編集中にキャンバスの上へ出す表示。count が undefined なら使用状況は不明。 */
export function ComponentBanner({ name, count, back }: { name: string; count: number | undefined; back: () => void }) {
  return <div className="e-part-banner"><p role="status"><Glyph />共通部品「{name}」を編集中{count === undefined ? "" : count ? ` · 保存すると使用中の${count}文書に反映されます` : " · まだどの文書にも配置されていません"}</p>
    <button type="button" onClick={back}>ページに戻る</button></div>;
}

/** ページの要素を部品にする入口。 */
export function CreateComponentSection({ disabled, reason, open }: { disabled: boolean; reason: string | undefined; open: () => void }) {
  return <section className="e-sec" aria-label="共通部品"><h3>共通部品</h3>
    <button type="button" onClick={open} disabled={disabled || !!reason}>部品にする</button>
    <small className="e-help">選んだ要素を共通部品に登録し、ほかのページでも使えるようにします。</small>{reason && <small className="e-help">ロック: {reason}</small>}</section>;
}

/** ページに置いたインスタンスの設定。 */
export function InstanceInspector({ instance, definition, usage, staleProps, field, disabled, edit, detach, setValue, clean }: {
  instance: InstanceNode; definition: ComponentDefinition | undefined; usage: string; staleProps: readonly string[]; field: InputRenderer; disabled: boolean;
  edit: () => void; detach: () => void; setValue: (name: string, value: string | undefined) => string | undefined; clean: () => void;
}) {
  if (!definition) return <p className="e-help e-problem">部品が見つかりません。</p>;
  const props = Object.entries(definition.props ?? {}), values = instance.props ?? {}, elements = ownElements(definition.root);
  // 段落など長い文字だけ複数行で入力する。リンク・見出し・ラベルは1行。
  const multiline = (prop: { node: string; field: ComponentPropField }) => prop.field === "text" && longTextTags.has(elements.get(prop.node)?.tag ?? "");
  return <section className="e-sec" aria-label="共通部品の設定">
    <p className="e-part-kind">共通部品 · {kindLabel(definition.kind)} · {usage}</p>
    <small className="e-help">中身の見た目と構成は「部品を編集」で変更し、使用中のすべての文書に反映されます。</small>
    <div className="e-actions"><button type="button" onClick={edit} disabled={disabled}>部品を編集</button><button type="button" className="e-danger" onClick={detach} disabled={disabled}>部品を解除</button></div>
    <h3>ページごとの値</h3>
    {props.length ? props.map(([name, prop]) => {
      const master = masterValue(definition, name), overridden = Object.hasOwn(values, name);
      return <div key={name} className="e-part-value">{field(prop.label, overridden ? values[name]! : master, (value) => setValue(name, value === master ? undefined : value), `instance-${name}`, { multiline: multiline(prop) })}
        {overridden ? <><small className="e-help">このページだけの値</small><button type="button" className="e-small" disabled={disabled} onClick={() => setValue(name, undefined)}>部品の値に戻す</button></>
          : <small className="e-help">部品の値を使用中</small>}</div>;
    }) : <p className="e-help">この部品にはページごとに変えられる値がありません。「部品を編集」で設定できます。</p>}
    {staleProps.length > 0 && <div className="e-part-value"><p className="e-help">部品の更新で使われなくなった値が{staleProps.length}件あります。</p><button type="button" className="e-small" disabled={disabled} onClick={clean}>整理する</button></div>}
    <p className="e-help">外枠の見た目はこのページだけに適用されます。</p>
  </section>;
}

/** 部品の編集中、何も選んでいないときの設定。 */
export function ComponentSettings({ component, usage, usageLoading, field, disabled, rename, setKind, unpublish, back }: {
  component: ComponentDefinition; usage: ComponentUsageSummary | undefined; usageLoading: boolean; field: InputRenderer; disabled: boolean;
  rename: (name: string) => string | undefined; setKind: (kind: ComponentKind) => void; unpublish: (name: string) => void; back: () => void;
}) {
  const props = Object.entries(component.props ?? {});
  return <section className="e-inspector-content"><h2><Glyph />部品の設定</h2>
    {field("部品名", component.name, rename, "component-name")}
    <label className="e-field"><span>種類</span><select aria-label="種類" value={component.kind} disabled={disabled} onChange={(event) => setKind(event.target.value as ComponentKind)}>
      {componentKinds.map(([kind, name]) => <option key={kind} value={kind}>{name}</option>)}</select></label>
    <h3>使用状況</h3>
    {usage ? usage.rows.length ? <ul className="e-part-usage">{usage.rows.map((row, index) => <li key={index}><span>{row.title}</span><small>{roleLabels[row.role]}{row.current ? "（編集中・未保存を含む）" : ""}</small></li>)}</ul>
      : <p className="e-help">未使用</p> : <p className="e-help">{usageLoading ? "使用状況を確認中" : "使用状況を取得できません"}</p>}
    <h3>ページごとに変えられる値</h3>
    {props.length ? <ul className="e-part-usage">{props.map(([name, prop]) => <li key={name}><span>{prop.label}<small> · {fieldCaptions[prop.field]}</small></span>
      <button type="button" className="e-small" aria-label={`「${prop.label}」の公開をやめる`} disabled={disabled} onClick={() => unpublish(name)}>公開をやめる</button></li>)}</ul>
      : <p className="e-help">要素を選ぶと、ページごとに変えられる値を設定できます。</p>}
    <div className="e-actions"><button type="button" onClick={back}>ページに戻る</button></div>
  </section>;
}

/** 部品の編集中に選んだ要素の、ページごとに変えられる値。 */
export function MasterPropFields({ component, node, field, disabled, toggle, relabel }: {
  component: ComponentDefinition; node: ElementNode; field: InputRenderer; disabled: boolean;
  toggle: (field: ComponentPropField, exposed: boolean) => void; relabel: (name: string, label: string) => string | undefined;
}) {
  const fields = (["text", "href", "src", "alt"] as const).filter((name) => fitsPropField(node, name));
  if (!fields.length) return null;
  return <section className="e-sec" aria-label="ページごとの値"><h3>ページごとの値</h3>{fields.map((name) => {
    const entry = Object.entries(component.props ?? {}).find(([, prop]) => prop.node === node.id && prop.field === name);
    return <div key={name} className="e-part-value"><label className="e-check"><input type="checkbox" checked={!!entry} disabled={disabled} onChange={(event) => toggle(name, event.target.checked)} />ページごとに変えられるようにする（{fieldCaptions[name]}）</label>
      {entry && field(`値の名前（${fieldCaptions[name]}）`, entry[1].label, (value) => relabel(entry[0], value), `master-prop-${name}`)}</div>;
  })}</section>;
}

/** 部品にする・名前を変更・削除・解除の確認。submit は問題があれば理由を返し、ダイアログに残る。notice は登録時の補足。 */
export function ComponentDialogBody({ dialog, library, cancel, submit, notice }: {
  dialog: ComponentDialogState; library: ComponentLibrary; cancel: () => void; submit: (input: { name: string; kind: ComponentKind }) => string | undefined; notice?: string | undefined;
}) {
  const current = dialog.type === "rename" || dialog.type === "remove" ? library.components.find((component) => component.id === dialog.componentId) : undefined;
  const [name, setName] = useState(dialog.type === "rename" ? current?.name ?? "" : ""), [kind, setKind] = useState<ComponentKind>("section"), [error, setError] = useState("");
  const run = () => setError(submit({ name, kind }) ?? ""), named = dialog.type === "create" || dialog.type === "rename";
  return <><h2>{componentDialogTitle(dialog)}</h2>
    {named ? <label className="e-field"><span>部品名</span><input autoFocus aria-required="true" aria-invalid={!!error} value={name} maxLength={80}
      onChange={(event) => { setName(event.target.value); setError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); run(); } }} /></label>
      : <p>{dialog.type === "remove" ? `「${current?.name ?? ""}」を削除します。この操作は保存すると確定します。` : "この箇所は通常の要素になり、今後は部品の変更を受けません。ページごとの値と外枠の見た目はそのまま残ります。"}</p>}
    {dialog.type === "create" && <><label className="e-field"><span>種類</span><select aria-label="種類" value={kind} onChange={(event) => setKind(event.target.value as ComponentKind)}>
      {componentKinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p>選んだ要素はこの部品のインスタンスに置き換わります。保存するまでほかのページには影響しません。</p>{notice && <p className="e-help">{notice}</p>}</>}
    {error && <p className="e-help e-problem" role="alert">{error}</p>}
    <div className="e-actions"><button type="button" autoFocus={!named} onClick={cancel}>キャンセル</button>
      <button type="button" className={named ? "e-primary" : "e-danger"} onClick={run}>{({ create: "登録する", rename: "変更する", remove: "削除する", detach: "解除する" } as const)[dialog.type]}</button></div></>;
}
