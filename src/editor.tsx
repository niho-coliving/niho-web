"use client";

import { Component, memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageRenderer } from "./react.js";
import { parsePageDocument } from "./document.js";
import { pageScope } from "./css.js";
import { DocumentValidationError } from "./validation-utils.js";
import { acceptSavedRevision, commitHistory, editDocument, effectiveLocks, fingerprint, lockReason, newElement, nodeAt, sameTarget, travelHistory, validateReleasePlan, walkNodes, type EditorHistory, type EditorOperation, type NodePath } from "./editor-model.js";
import { editorCss, pagesCss } from "./editor-style.js";
import { styleEditorCss } from "./editor-style-css.js";
import { Field } from "./editor-fields.js";
import { StyleInspector, type StyleRange } from "./editor-style-inspector.js";
import { StyleLibrary } from "./editor-style-library.js";
import { editorTiers, normalizeBreakpoints, tierForWidth, tierName } from "./style-model.js";
import { Dialog } from "./editor-dialog.js";
import { PageChangeDialog, PageSettings, PagePanel, ReleaseSearchSummary, SiteSettingsPanel, pageChangeNotice, publicInfoMessage, useSiteSettings, type FieldOptions, type PageChangeStart } from "./editor-pages.js";
import { isDirectlyEditable, readEditableChildren } from "./editor-rich-text.js";
import { isSafePublicUrl } from "./validation-utils.js";
import type { EditorBlockRegistry, EditorLock, EditorPage, EditorPageChange, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorSnapshot, EditorTarget, PageEditorProps } from "./editor-types.js";
import type { ElementTag, PageDocument, PageNode } from "./types.js";
import { AssetLibraryPanel, BackgroundImageField, ImageSourceField, assetPlacement, useLocalAssetUsage, useResolvedAssets, type AssetAction, type AssetPicker } from "./editor-assets.js";
import { assetEditorCss, canvasAssetCss } from "./editor-assets-style.js";
import type { LibraryAsset, ResolvedAssetMap } from "./assets.js";

export type * from "./editor-types.js";
const emptyBlocks: EditorBlockRegistry = {};
type Session = { target: EditorTarget; history: EditorHistory; version: string; saved: string; locks: readonly EditorLock[]; releases: NonNullable<EditorSnapshot["releases"]> };
type Navigation = { type: "site"; id: string } | { type: "page"; target: EditorTarget } | { type: "reload" };
const message = (error: unknown) => error instanceof DocumentValidationError ? publicInfoMessage(error) ??
  (/nesting|parent|void element/.test(error.message) ? "この場所には要素を配置できません。別のセクションかボックスを選んでください。" : "文書のルールに合いません。URL・単位・親要素を確認してください。") :
  error instanceof Error ? error.message : "入力を適用できません。";
const conflict = (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 409;
const label = (node: PageNode, blocks: EditorBlockRegistry) => node.type === "text" ? `文字: ${node.text.slice(0, 24) || "（空）"}` : node.type === "component" ? `${blocks[node.block]?.label ?? node.block} · ${node.id}` : node.type === "instance" ? `部品 · ${node.component}` : `${node.tag} · ${node.id}`;
function sessionFrom(snapshot: EditorSnapshot, target: EditorTarget, blocks: EditorBlockRegistry): Session {
  const document = parsePageDocument(snapshot.document, blocks);
  if (!sameTarget(document, target) || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("読込対象が一致しません。");
  return { target, history: { past: [], present: document, future: [] }, version: snapshot.version, saved: fingerprint(document), locks: snapshot.locks ?? [], releases: snapshot.releases ?? [] };
}

class PreviewBoundary extends Component<{ document: PageDocument; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { document: PageDocument }) { if (previous.document !== this.props.document && this.state.failed) this.setState({ failed: false }); }
  render() { return this.state.failed ? <p role="alert">ブロックのプレビューを表示できません。レイヤーから編集を続けられます。</p> : this.props.children; }
}
const StablePageRenderer = memo(PageRenderer);
type DragItem = { kind: "palette"; type: string } | { kind: "node"; id: string };
type DropPlace = { parentId: string | null; index: number; marker: { left: number; top: number; width: number; height: number; inside: boolean } };
const asElement = (target: EventTarget | null): HTMLElement | null => target && typeof target === "object" && "nodeType" in target && (target as Node).nodeType === 1 ? target as HTMLElement : null;
function Canvas({ document, blocks, width, breakpoint, selection, select, dragItem, drop, pending, editText, resize, reportError, editable, locks, preview, assets }: {
  document: PageDocument; blocks: EditorBlockRegistry; width: number; selection: NodePath | null; select: (path: NodePath | null) => void;
  breakpoint: number | "base";
  dragItem: { current: DragItem | null }; drop: (item: DragItem, place: DropPlace) => void;
  pending: (key: string, value: boolean) => void;
  editText: (path: NodePath, children: PageNode[]) => string | undefined; resize: (path: NodePath, width: number, height: number) => string | undefined;
  reportError: (message: string) => void; editable: boolean; locks: readonly EditorLock[]; preview: boolean; assets: ResolvedAssetMap;
}) {
  const [body, setBody] = useState<HTMLElement | null>(null), frame = useRef<HTMLIFrameElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null), [dropPlace, setDropPlace] = useState<DropPlace | null>(null);
  const [handleRect, setHandleRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const resizing = useRef<{ element: HTMLElement; path: NodePath; x: number; y: number; width: number; height: number; inlineWidth: string; inlineHeight: string } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false), [linkHref, setLinkHref] = useState("/"), [linkError, setLinkError] = useState("");
  const originalHtml = useRef(""), savedRange = useRef<Range | null>(null);
  const scope = pageScope(document), entries = walkNodes(document);
  const selected = selection ? nodeAt(document, selection) : undefined;
  const selectedId = selected?.type === "text" && selection && selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : selected;
  const resizePath = selected?.type === "text" ? selection?.slice(0, -1) : selection;
  const canResize = editable && !preview && !editingId && selectedId && selectedId.type !== "text" && !!resizePath?.length &&
    !lockReason(document, resizePath, breakpoint === "base" ? "style.base.width" : "style.responsive", locks) &&
    !lockReason(document, resizePath, breakpoint === "base" ? "style.base.height" : "style.responsive", locks);
  const editing = editingId ? entries.find(({ node }) => node.type !== "text" && node.id === editingId) : undefined;
  useEffect(() => {
    if (!body || !canResize || !selectedId) { setHandleRect(null); return; }
    const element = Array.from(body.querySelectorAll<HTMLElement>("[data-nw-node]")).find((item) => item.dataset.nwNode === selectedId.id);
    if (!element) { setHandleRect(null); return; }
    const update = () => { const rect = element.getBoundingClientRect(); setHandleRect({ left: rect.left + (body.ownerDocument.defaultView?.scrollX ?? 0), top: rect.top + (body.ownerDocument.defaultView?.scrollY ?? 0), width: rect.width, height: rect.height }); };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update); observer?.observe(element);
    body.ownerDocument.defaultView?.addEventListener("scroll", update);
    return () => { observer?.disconnect(); body.ownerDocument.defaultView?.removeEventListener("scroll", update); };
  }, [body, canResize, selectedId && "id" in selectedId ? selectedId.id : undefined, width, document]);
  function endResize(commit: boolean) {
    const current = resizing.current; if (!current) return;
    const width = Number.parseFloat(current.element.style.width) || current.width, height = Number.parseFloat(current.element.style.height) || current.height;
    current.element.style.width = current.inlineWidth; current.element.style.height = current.inlineHeight;
    resizing.current = null;
    if (commit && (Math.abs(width - current.width) > 1 || Math.abs(height - current.height) > 1)) { const problem = resize(current.path, width, height); if (problem) reportError(problem); }
  }
  useEffect(() => {
    if (!body || !selectedId || selectedId.type === "text" || preview || editingId) return;
    const element = Array.from(body.querySelectorAll<HTMLElement>("[data-nw-node]")).find((item) => item.dataset.nwNode === selectedId.id);
    if (!element) return;
    element.draggable = true;
    return () => { element.removeAttribute("draggable"); };
  }, [body, selectedId?.type === "text" ? "" : selectedId?.id, preview, editingId]);
  useEffect(() => {
    if (!body || !editingId) return;
    const element = Array.from(body.querySelectorAll<HTMLElement>("[data-nw-node]")).find((item) => item.dataset.nwNode === editingId);
    if (!element) return;
    originalHtml.current = element.innerHTML;
    element.contentEditable = "true";
    element.setAttribute("spellcheck", "true");
    element.focus();
    const range = body.ownerDocument.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selectedRange = body.ownerDocument.getSelection(); selectedRange?.removeAllRanges(); selectedRange?.addRange(range);
    return () => { element.removeAttribute("contenteditable"); element.removeAttribute("spellcheck"); };
  }, [body, editingId]);
  useEffect(() => {
    if (!editingId) return;
    return () => pending(`direct-${editingId}`, false);
  }, [editingId, pending]);
  function editableElement(target: EventTarget | null): HTMLElement | null {
    const targetElement = asElement(target); if (!targetElement) return null;
    const candidate = targetElement.closest<HTMLElement>("div[role=group][aria-label='リッチテキスト'][data-nw-node]") ??
      targetElement.closest<HTMLElement>("p[data-nw-node],h1[data-nw-node],h2[data-nw-node],h3[data-nw-node],h4[data-nw-node],h5[data-nw-node],h6[data-nw-node]");
    const entry = entries.find(({ node }) => node.type !== "text" && node.id === candidate?.dataset.nwNode);
    if (!candidate || !entry || !isDirectlyEditable(entry.node)) return null;
    if (lockReason(document, entry.path, "children", locks)) return null;
    const descendants = walkNodes({ ...document, body: [entry.node] });
    if (descendants.some(({ node }) => node.type !== "text" && locks.some((lock) => lock.nodeId === node.id && lock.fields.some((field) => field === "*" || field === "children")))) return null;
    return candidate;
  }
  function stopEditing(commit: boolean) {
    if (!body || !editing || editing.node.type !== "element") { if (editingId) pending(`direct-${editingId}`, false); setEditingId(null); return; }
    const element = Array.from(body.querySelectorAll<HTMLElement>("[data-nw-node]")).find((item) => item.dataset.nwNode === editingId);
    if (!element) { pending(`direct-${editingId}`, false); setEditingId(null); return; }
    if (commit) {
      try {
        const problem = editText(editing.path, readEditableChildren(element, editing.node));
        if (problem) element.innerHTML = originalHtml.current;
      } catch (error) { element.innerHTML = originalHtml.current; reportError(error instanceof Error ? error.message : "文字の変更を適用できませんでした。"); }
    } else element.innerHTML = originalHtml.current;
    element.removeAttribute("contenteditable"); pending(`direct-${editingId}`, false); setEditingId(null); setLinkOpen(false); setLinkError("");
  }
  function placeAt(event: React.DragEvent<HTMLElement>): DropPlace {
    const target = asElement(event.target)?.closest<HTMLElement>(`[data-nw-owner="${scope}"][data-nw-node]`) ?? null;
    const entry = target ? entries.find(({ node }) => node.type !== "text" && node.id === target.dataset.nwNode) : undefined;
    if (!entry || !target) return { parentId: null, index: document.body.length, marker: { left: 8, top: body?.scrollHeight ?? 0, width: Math.max(120, width - 16), height: 2, inside: false } };
    const rect = target.getBoundingClientRect(), scrollX = body?.ownerDocument.defaultView?.scrollX ?? 0, scrollY = body?.ownerDocument.defaultView?.scrollY ?? 0;
    const canContain = entry.node.type === "element" && ["div", "section", "article", "header", "footer", "main", "nav", "aside", "li", "figure", "blockquote"].includes(entry.node.tag);
    const fraction = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    const inside = canContain && (event.altKey || fraction > .3 && fraction < .7);
    if (inside && entry.node.type === "element") return { parentId: entry.node.id, index: entry.node.children.length,
      marker: { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height, inside: true } };
    const parent = entry.path.length > 1 ? nodeAt(document, entry.path.slice(0, -1)) : null;
    const after = fraction >= .5;
    return { parentId: parent?.type === "element" ? parent.id : null, index: entry.path.at(-1)! + (after ? 1 : 0),
      marker: { left: rect.left + scrollX, top: (after ? rect.bottom : rect.top) + scrollY, width: rect.width, height: 2, inside: false } };
  }
  function format(command: string, value?: string) { body?.ownerDocument.execCommand?.(command, false, value); }
  function pastePlainText(value: string) {
    if (!body) return;
    if (body.ownerDocument.execCommand?.("insertText", false, value)) return;
    const selection = body.ownerDocument.getSelection(); if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0); range.deleteContents(); const text = body.ownerDocument.createTextNode(value); range.insertNode(text); range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
  }
  function insertLineBreak() {
    if (!body) return;
    if (body.ownerDocument.execCommand?.("insertLineBreak", false)) return;
    const selection = body.ownerDocument.getSelection(); if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0); range.deleteContents(); const breakNode = body.ownerDocument.createElement("br"); range.insertNode(breakNode); range.setStartAfter(breakNode); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
  }
  function applyLink() {
    if (!isSafePublicUrl(linkHref)) { setLinkError("HTTPSまたはサイト内URLを入力してください。"); return; }
    if (!savedRange.current || savedRange.current.collapsed) { setLinkError("リンクにする文字を選択してください。"); return; }
    const selection = body?.ownerDocument.getSelection();
    if (selection && savedRange.current) { selection.removeAllRanges(); selection.addRange(savedRange.current); }
    format("createLink", linkHref); setLinkOpen(false); setLinkError("");
    const element = body?.querySelector<HTMLElement>(`[data-nw-node="${editingId}"]`); element?.focus();
  }
  return <><iframe ref={frame} title="ページのライブキャンバス" sandbox="allow-same-origin" style={{ width }}
    srcDoc={'<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"></body></html>'}
    onLoad={() => setBody(frame.current?.contentDocument?.body ?? null)} />
    {body && createPortal(<div onClickCapture={(event) => {
      if (preview) { event.preventDefault(); event.stopPropagation(); return; }
      if (asElement(event.target)?.closest(".nw-resize-handle") || editingId && asElement(event.target)?.closest("[contenteditable=true],.nw-text-toolbar")) return;
      event.preventDefault(); event.stopPropagation();
      const target = event.target as HTMLElement;
      const element = typeof target.closest === "function" ? target.closest(`[data-nw-owner="${scope}"][data-nw-node]`) : null;
      select(entries.find(({ node }) => node.type !== "text" && node.id === element?.getAttribute("data-nw-node"))?.path ?? null);
    }} onDoubleClickCapture={(event) => {
      if (!editable || preview || editingId) return;
      const element = editableElement(event.target);
      if (element) { const path = entries.find(({ node }) => node.type !== "text" && node.id === element.dataset.nwNode)?.path; if (path) { select(path); const id = element.dataset.nwNode ?? null; setEditingId(id); if (id) pending(`direct-${id}`, true); } }
    }} onBlurCapture={(event) => { const target = asElement(event.target), next = asElement(event.relatedTarget); if (target?.dataset.nwNode === editingId && !linkOpen || linkOpen && target?.closest(".nw-text-toolbar") && !next?.closest(".nw-text-toolbar,[contenteditable=true]")) stopEditing(true); }}
      onKeyDownCapture={(event) => { if (!editingId || event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Escape") { event.preventDefault(); stopEditing(false); } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); stopEditing(true); } else if (event.key === "Enter" && editing?.node.type === "element" && editing.node.tag !== "div") { event.preventDefault(); insertLineBreak(); } }}
      onPasteCapture={(event) => { if (!editingId || !asElement(event.target)?.closest("[contenteditable=true]")) return; event.preventDefault(); pastePlainText(event.clipboardData.getData("text/plain")); }}
      onDragStartCapture={(event) => { if (!editable || preview || editingId) return; const target = asElement(event.target)?.closest<HTMLElement>("[data-nw-node][draggable=true]"); if (!target?.dataset.nwNode) return; dragItem.current = { kind: "node", id: target.dataset.nwNode }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", target.dataset.nwNode); }}
      onDragEndCapture={() => { dragItem.current = null; setDropPlace(null); }}
      onDragOverCapture={(event) => { if (!editable || preview || !dragItem.current) return; event.preventDefault(); event.dataTransfer.dropEffect = dragItem.current.kind === "node" ? "move" : "copy"; setDropPlace(placeAt(event)); }}
      onDragLeaveCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropPlace(null); }}
      onDropCapture={(event) => { event.preventDefault(); event.stopPropagation(); if (!editable || preview || !dragItem.current) return; const place = placeAt(event); drop(dragItem.current, place); dragItem.current = null; setDropPlace(null); }}
      onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <style>{`body{font-family:sans-serif;position:relative;}[data-nw-node]{cursor:pointer;}[data-nw-owner][data-nw-node]:is(section,div):empty{min-height:48px;outline:1px dashed #a4b9aa;}[contenteditable=true]{cursor:text!important;outline:2px solid #2d7356!important;outline-offset:3px;} ${selectedId && selectedId.type !== "text" ? `[data-nw-owner="${scope}"][data-nw-node="${selectedId.id}"]{outline:2px solid #198558!important;outline-offset:2px;}` : ""}
        .nw-drop-marker{position:absolute;pointer-events:none;z-index:2147483000;background:#34a66d;box-shadow:0 0 0 2px white}.nw-drop-marker.inside{background:#34a66d22;outline:2px dashed #198558;box-shadow:none}.nw-resize-handle{position:absolute;z-index:2147483001;width:15px;height:15px;border:2px solid white;border-radius:4px;background:#258858;box-shadow:0 0 0 1px #245b3f;cursor:nwse-resize;touch-action:none}
        .nw-text-toolbar{position:fixed;z-index:2147483001;right:12px;top:12px;display:flex;gap:4px;align-items:center;padding:6px;border:1px solid #d7e2d9;background:#fff;border-radius:10px;box-shadow:0 8px 24px #20382b30;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.nw-text-toolbar button,.nw-text-toolbar input{font:inherit;border:1px solid #d8e2d9;border-radius:6px;background:white;padding:5px 7px}.nw-text-toolbar input{width:170px}.nw-text-toolbar .problem{color:#a23d30}`}</style>
      <style>{canvasAssetCss}</style>
      <PreviewBoundary document={document}><StablePageRenderer document={document} blocks={blocks} assets={assets} missingAssets="placeholder" /></PreviewBoundary>
      {dropPlace && <div aria-hidden className={`nw-drop-marker${dropPlace.marker.inside ? " inside" : ""}`} style={{ left: dropPlace.marker.left, top: dropPlace.marker.top, width: dropPlace.marker.width, height: dropPlace.marker.height }} />}
      {canResize && handleRect && resizePath && <button type="button" className="nw-resize-handle" aria-label="ドラッグして要素のサイズを変更" title={`${Math.round(handleRect.width)} × ${Math.round(handleRect.height)} px`} style={{ left: handleRect.left + handleRect.width - 7, top: handleRect.top + handleRect.height - 7 }}
        onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); const element = body.querySelector<HTMLElement>(`[data-nw-node="${selectedId.id}"]`); if (!element) return; const bounds = element.getBoundingClientRect(), computed = body.ownerDocument.defaultView?.getComputedStyle(element); resizing.current = { element, path: resizePath, x: event.clientX, y: event.clientY, width: Number.parseFloat(computed?.width ?? "") || bounds.width, height: Number.parseFloat(computed?.height ?? "") || bounds.height, inlineWidth: element.style.width, inlineHeight: element.style.height }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { const current = resizing.current; if (!current) return; event.preventDefault(); current.element.style.width = `${Math.min(10000, Math.max(1, Math.round(current.width + event.clientX - current.x)))}px`; current.element.style.height = `${Math.min(10000, Math.max(1, Math.round(current.height + event.clientY - current.y)))}px`; }}
        onPointerUp={(event) => { event.preventDefault(); event.stopPropagation(); endResize(true); }} onPointerCancel={() => endResize(false)} />}
      {editingId && <div className="nw-text-toolbar" role="toolbar" aria-label="文字の装飾" contentEditable={false}>
        <button type="button" aria-label="太字" onMouseDown={(event) => event.preventDefault()} onClick={() => format("bold")}>B</button>
        <button type="button" aria-label="斜体" onMouseDown={(event) => event.preventDefault()} onClick={() => format("italic")}>I</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { savedRange.current = body.ownerDocument.getSelection()?.rangeCount ? body.ownerDocument.getSelection()!.getRangeAt(0).cloneRange() : null; setLinkOpen(true); }}>リンク</button>
        {editing?.node.type === "element" && editing.node.tag === "div" && <><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("formatBlock", "p")}>段落</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("formatBlock", "h2")}>見出し</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("insertUnorderedList")}>箇条書き</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("insertOrderedList")}>番号</button></>}
        {linkOpen && <><input aria-label="リンク先URL" value={linkHref} onChange={(event) => { setLinkHref(event.target.value); setLinkError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyLink(); } }} /><button type="button" onClick={applyLink}>適用</button>{linkError && <span className="problem" role="alert">{linkError}</span>}</>}
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => stopEditing(true)}>完了</button>
      </div>}
    </div>, body)}
  </>;
}

/** 認証済みホストに接続する共通エディター。ネットワーク URL や秘密を所有しない。 */
export function PageEditor({ adapter, blocks = emptyBlocks, insertableBlocks, assets, breakpoints: hostBreakpoints }: PageEditorProps) {
  const [sites, setSites] = useState<readonly EditorSite[]>([]), [siteId, setSiteId] = useState("");
  const [pages, setPages] = useState<readonly EditorPage[]>([]), [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const [selection, setSelection] = useState<NodePath | null>(null), [width, setWidth] = useState(1280);
  const [fieldEpoch, setFieldEpoch] = useState(0);
  const [breakpoint, setBreakpoint] = useState<number | "base">("base"), [notice, setNotice] = useState("");
  // 入力中のライブプレビュー。基準の文書が変わった（確定・undo/redo・保存・移動）時点で無効になる。
  const [draft, setDraft] = useState<{ base: PageDocument; document: PageDocument } | null>(null), [range, setRange] = useState<StyleRange>("wide");
  const breakpoints = normalizeBreakpoints(hostBreakpoints);
  const [busy, setBusy] = useState(""), [pendingFields, setPendingFields] = useState<Record<string, boolean>>({});
  const [navigation, setNavigation] = useState<Navigation | null>(null), [plan, setPlan] = useState<EditorReleasePlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [addType, setAddType] = useState("p"), [parentId, setParentId] = useState(""), [rollbackRevision, setRollbackRevision] = useState("");
  const [panel, setPanel] = useState<"add" | "pages" | "layers" | "styles" | "assets" | "components">("add");
  const [inspector, setInspector] = useState<"element" | "page" | "site">("page"), [preview, setPreview] = useState(false);
  const [layerDrop, setLayerDrop] = useState<{ id: string; position: "before" | "inside" | "after" } | null>(null);
  const dragItem = useRef<DragItem | null>(null);
  const [picker, setPicker] = useState<AssetPicker | null>(null), visiblePanel = picker ? "assets" : panel;
  useEffect(() => { setPicker(null); }, [selection]);
  const request = useRef<AbortController | null>(null), action = useRef<AbortController | null>(null), pageList = useRef<AbortController | null>(null);
  const [pageChange, setPageChange] = useState<PageChangeStart | null>(null), siteSettings = useSiteSettings(adapter, siteId);
  const pending = useCallback((key: string, value: boolean) => setPendingFields((previous) => {
    if (!!previous[key] === value) return previous;
    const next = { ...previous }; if (value) next[key] = true; else delete next[key]; return next;
  }), []);
  const hasInput = Object.values(pendingFields).some(Boolean), dirty = !!session && fingerprint(session.history.present) !== session.saved;
  const blocked = !!busy || !!plan || !!pageChange, editBlocked = blocked && busy !== "保存中";
  const replace = useCallback((next: Session | null) => { sessionRef.current = next; setSession(next); }, []);
  const load = useCallback(async (target: EditorTarget): Promise<boolean> => {
    const editorTarget: EditorTarget = { siteId: target.siteId, pageId: target.pageId, locale: target.locale };
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy("読込中"); setNotice("");
    try {
      const snapshot = await adapter.readDocument(editorTarget, controller.signal);
      if (controller.signal.aborted) return false;
      replace(sessionFrom(snapshot, editorTarget, blocks)); setSelection(null); setInspector("page"); setFieldEpoch((value) => value + 1); setPendingFields({}); setPlan(null); setRollbackRevision(""); setParentId("");
      return true;
    } catch { if (!controller.signal.aborted) setNotice("文書を読み込めませんでした。現在の編集内容は保持されています。"); return false; }
    finally { if (!controller.signal.aborted) setBusy(""); }
  }, [adapter, blocks, replace]);
  useEffect(() => {
    const controller = new AbortController();
    adapter.listSites(controller.signal).then((result) => { if (!controller.signal.aborted) { setSites(result); setSiteId(result[0]?.id ?? ""); } })
      .catch(() => { if (!controller.signal.aborted) setNotice("サイト一覧を読み込めませんでした。"); });
    return () => controller.abort();
  }, [adapter]);
  useEffect(() => {
    if (!siteId) return;
    const controller = new AbortController(); setPages([]); setBusy("読込中");
    adapter.listPages(siteId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.some((page) => page.siteId !== siteId)) throw new Error("site mismatch");
      setPages(result); if (result[0]) void load(result[0]); else { replace(null); setBusy(""); }
    }).catch(() => { if (!controller.signal.aborted) { setNotice("ページ一覧を読み込めませんでした。"); setBusy(""); } });
    return () => { controller.abort(); request.current?.abort(); pageList.current?.abort(); };
  }, [adapter, siteId, load, replace]);
  useEffect(() => () => { request.current?.abort(); action.current?.abort(); pageList.current?.abort(); }, []);
  useEffect(() => {
    function prevent(event: BeforeUnloadEvent) { event.preventDefault(); }
    if (dirty || hasInput || siteSettings.dirty) window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, hasInput, siteSettings.dirty]);
  /** 開いている文書は保持したまま、ページ一覧だけを取り直す。 */
  async function reloadPages(): Promise<boolean> {
    const current = siteId; if (!current) return false;
    pageList.current?.abort(); const controller = new AbortController(); pageList.current = controller;
    try {
      const result = await adapter.listPages(current, controller.signal);
      if (controller.signal.aborted) return false;
      if (result.some((page) => page.siteId !== current)) throw new Error("site mismatch");
      setPages(result); return true;
    } catch { if (!controller.signal.aborted) setNotice("ページ一覧を読み込めませんでした。"); return false; }
  }
  async function pageApplied(page: EditorPage, change: EditorPageChange) {
    setBusy("読込中"); setPageChange(null); const done = pageChangeNotice(change);
    const listed = await reloadPages(), loaded = await load({ siteId: page.siteId, pageId: page.pageId, locale: page.locale });
    setNotice(listed && loaded ? done : `${done}${loaded ? "ページ一覧" : "変更後の文書"}を読み込めませんでした。再読込してください。`);
  }

  function navigate(next: Navigation) {
    setNavigation(null); setSelection(null); setInspector("page"); setFieldEpoch((value) => value + 1); setPendingFields({});
    setPicker(null);
    if (next.type === "site") { replace(null); setSiteId(next.id); }
    else if (next.type === "page") void load(next.target);
    else if (sessionRef.current) void load(sessionRef.current.target);
  }
  function requestNavigation(next: Navigation) { if (blocked || next.type === "site" && siteSettings.busy) return; if (dirty || hasInput || next.type === "site" && siteSettings.dirty) setNavigation(next); else navigate(next); }
  function select(path: NodePath | null) { if (hasInput) { setNotice("入力を適用するか取り消してから選択を変えてください。"); return; } if (!editBlocked) { setSelection(path); setInspector(path ? "element" : "page"); setDraft(null); } }
  function apply(operation: EditorOperation): string | undefined {
    const current = sessionRef.current; if (!current || editBlocked) return "処理が完了してから編集してください。";
    try {
      const document = editDocument(current.history.present, operation, blocks, current.locks);
      replace({ ...current, history: commitHistory(current.history, document) }); setDraft(null); setNotice(""); return undefined;
    } catch (error) { setDraft(null); return message(error); }
  }
  function previewOperation(operation: EditorOperation | null) {
    const current = sessionRef.current;
    if (!operation || !current || editBlocked) { setDraft(null); return; }
    try { setDraft({ base: current.history.present, document: editDocument(current.history.present, operation, blocks, current.locks) }); } catch { /* 成功した入力だけを表示する */ }
  }
  function structural(operation: EditorOperation) { const error = apply(operation); if (error) setNotice(error); else setSelection(null); }
  function travel(direction: "undo" | "redo") {
    if (!session || blocked || hasInput) return;
    try { replace({ ...session, history: travelHistory(session.history, direction, blocks, session.locks) }); setSelection(null); setNotice(""); } catch (error) { setNotice(message(error)); }
  }
  async function save() {
    const current = sessionRef.current; if (!current || action.current || blocked || hasInput) return;
    const controller = new AbortController(); action.current = controller; setBusy("保存中"); setNotice("");
    const document = parsePageDocument(current.history.present, blocks);
    try {
      const result = await adapter.saveDraft({ target: current.target, document: structuredClone(document), expectedVersion: current.version }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "conflict") { setNotice("保存が競合しました（409）。編集内容を保持しています。コピーして保管するか、再読込して最新の文書を確認してください。"); return; }
      if (typeof result.version !== "string" || !result.version || result.version === current.version) throw new Error("version must advance");
      const latest = sessionRef.current;
      if (latest && sameTarget(latest.target, current.target) && latest.version === current.version) {
        const acknowledged = acceptSavedRevision(latest.history, document, result.revision);
        replace({ ...latest, ...acknowledged, version: result.version });
      }
      setNotice("下書きを保存しました。");
    } catch (error) { if (!controller.signal.aborted) setNotice(conflict(error) ? "保存が競合しました（409）。編集内容を保持しています。最新状態を確認してからやり直してください。" : "下書きを保存できませんでした。編集内容を保持しています。時間をおいて再試行してください。"); }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }
  async function prepare(actionType: "publish" | "rollback") {
    const current = sessionRef.current, site = sites.find((site) => site.id === current?.target.siteId);
    if (!current || !site || action.current || blocked || dirty || hasInput || (actionType === "rollback" && !current.releases.some((release) => release.revision === Number(rollbackRevision)))) return;
    const controller = new AbortController(); action.current = controller; setBusy("公開差分を取得中"); setNotice("");
    const input: EditorReleaseRequest = { target: current.target, expectedVersion: current.version, action: actionType,
      ...(actionType === "rollback" ? { revision: Number(rollbackRevision) } : {}) };
    try {
      const result = await adapter.prepareRelease(input, controller.signal);
      if (controller.signal.aborted) return;
      const reviewed = structuredClone(result); validateReleasePlan(reviewed, input, site); setPlan(reviewed); setConfirmed(false);
    } catch { if (!controller.signal.aborted) setNotice("対象ドメインと差分を確認できませんでした。保存状態と権限を確認して再試行してください。"); }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }
  async function release() {
    const current = sessionRef.current;
    if (!current || !plan || !confirmed || action.current || busy || dirty || hasInput) return;
    const controller = new AbortController(); action.current = controller; setBusy("公開を反映中");
    try {
      const result = await adapter.release(plan, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "conflict") { setNotice("公開が競合しました（409）。編集内容を保持しています。最新状態を確認してからやり直してください。"); setPlan(null); return; }
      replace(sessionFrom(result.snapshot, current.target, blocks)); setSelection(null); setFieldEpoch((value) => value + 1); setPlan(null); setNotice(plan.action === "rollback" ? "指定した版に戻しました。" : "公開しました。");
      setPicker(null);
    } catch { if (!controller.signal.aborted) { setNotice("反映結果を確認できませんでした。再試行前に公開状態をホスト側で確認してください。編集内容は保持しています。"); setPlan(null); } }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }

  const document = session?.history.present, entries = document ? walkNodes(document) : [];
  const node = document && selection ? nodeAt(document, selection) : undefined;
  const locks = document ? effectiveLocks(document, session?.locks ?? [], blocks) : [];
  const reason = (field: string) => document && selection ? lockReason(document, selection, field, locks) : undefined;
  const pathKey = `${fieldEpoch}-${selection?.join(".") ?? "page"}`;
  const tiers = document ? editorTiers(document, breakpoints) : [], tier = tiers.some((entry) => entry.key === breakpoint) ? breakpoint : "base";
  const shownTier = tierForWidth(tiers, width), canvasDocument = document && draft?.base === document ? draft.document : document;
  const nextTier = tiers[tiers.findIndex((entry) => entry.key === tier) + 1], until = range === "only" ? nextTier?.start : undefined;
  const resolvedAssets = useResolvedAssets(assets, session?.target.siteId, document, fieldEpoch), localUsage = useLocalAssetUsage(document);
  function field(name: string, value: string, operation: (value: string) => EditorOperation, key: string, options: FieldOptions = {}) {
    return <Field key={`${pathKey}-${key}`} name={name} value={value} fieldKey={`${pathKey}-${key}`} pending={pending} disabled={editBlocked}
      apply={(value) => apply(operation(value))} {...options} />;
  }
  function selectId(id: string) {
    const next = sessionRef.current?.history.present;
    const path = next && walkNodes(next).find(({ node }) => node.type !== "text" && node.id === id)?.path;
    if (path) select(path);
  }
  function makeNode(type: string): PageNode | undefined {
    const current = sessionRef.current?.history.present; if (!current) return undefined;
    const used = new Set(walkNodes(current).flatMap(({ node }) => node.type === "text" ? [] : [node.id])); let counter = 1; while (used.has(`node_${counter}`)) counter++;
    const id = `node_${counter}`;
    if (type === "text") return newElement("p", id);
    if (type === "richtext") return { type: "element", id, tag: "div", attrs: { role: "group", "aria-label": "リッチテキスト" }, children: [newElement("p", `edit_${crypto.randomUUID().replaceAll("-", "")}`)] };
    if (type === "box") return { type: "element", id, tag: "div", children: [] };
    if (type === "section") return { type: "element", id, tag: "section", children: [] };
    if (type.startsWith("block:")) {
      const block = type.slice(6), definition = blocks[block];
      if (!definition || insertableBlocks && !insertableBlocks.includes(block)) return undefined;
      const props = { ...definition.defaultProps };
      for (const [name, rule] of Object.entries(definition.props)) if (rule.required && props[name] === undefined) props[name] = rule.type === "boolean" ? false : rule.type === "number" ? Math.min(rule.max ?? Infinity, Math.max(rule.min ?? -Infinity, 0)) : rule.type === "enum" ? rule.values[0] ?? "" : rule.type === "url" ? "/" : "表示テキスト";
      return { type: "component", id, block, props };
    }
    return newElement(type as ElementTag, id);
  }
  function add(type = addType, place?: Pick<DropPlace, "parentId" | "index">) {
    if (!document || hasInput || editBlocked) return;
    const newNode = makeNode(type); if (!newNode) return;
    const error = apply({ type: "add", parentId: place ? place.parentId : parentId || null, node: newNode, ...(place ? { index: place.index } : {}) });
    if (error) setNotice(error); else if (newNode.type !== "text") selectId(newNode.id);
  }
  function dropAt(item: DragItem, place: Pick<DropPlace, "parentId" | "index">) {
    if (!document || hasInput || editBlocked) return;
    if (item.kind === "palette") { add(item.type, place); return; }
    const source = entries.find(({ node }) => node.type !== "text" && node.id === item.id);
    if (!source) return;
    const oldParent = source.path.length > 1 ? nodeAt(document, source.path.slice(0, -1)) : null;
    const oldParentId = oldParent?.type === "element" ? oldParent.id : null;
    const index = oldParentId === place.parentId && source.path.at(-1)! < place.index ? place.index - 1 : place.index;
    const error = apply({ type: "move", path: source.path, parentId: place.parentId, index });
    if (error) setNotice(error); else selectId(item.id);
  }
  function layerPlace(event: React.DragEvent<HTMLElement>, targetId: string): { position: "before" | "inside" | "after"; parentId: string | null; index: number } | null {
    if (!document) return null;
    const target = entries.find(({ node }) => node.type !== "text" && node.id === targetId); if (!target) return null;
    const rect = event.currentTarget.getBoundingClientRect(), fraction = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    const canContain = target.node.type === "element" && ["div", "section", "article", "header", "footer", "main", "nav", "aside", "li", "figure", "blockquote"].includes(target.node.tag);
    if (canContain && (event.altKey || fraction > .3 && fraction < .7) && target.node.type === "element") return { position: "inside", parentId: target.node.id, index: target.node.children.length };
    const parent = target.path.length > 1 ? nodeAt(document, target.path.slice(0, -1)) : null;
    const after = fraction >= .5;
    return { position: after ? "after" : "before", parentId: parent?.type === "element" ? parent.id : null, index: target.path.at(-1)! + (after ? 1 : 0) };
  }
  function moveBy(delta: number) {
    if (!document || !selection) return;
    const parent = selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : null;
    const current = nodeAt(document, selection), target = [...selection.slice(0, -1), selection.at(-1)! + delta];
    const problem = apply({ type: "move", path: selection, parentId: parent?.type === "element" ? parent.id : null, index: target.at(-1)! });
    if (problem) setNotice(problem); else if (current.type === "text") select(target); else selectId(current.id);
  }
  function moveToEnd() {
    if (!document || !selection) return;
    const current = nodeAt(document, selection);
    const destination = parentId ? entries.find(({ node }) => node.type !== "text" && node.id === parentId) : undefined;
    const count = destination?.node.type === "element" ? destination.node.children.length : document.body.length;
    const oldParent = selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : null;
    const sameParent = parentId === (oldParent?.type === "element" ? oldParent.id : "");
    const index = count - (sameParent ? 1 : 0);
    const problem = apply({ type: "move", path: selection, parentId: parentId || null, index });
    if (problem) { setNotice(problem); return; }
    if (current.type !== "text") selectId(current.id);
    else { const next = sessionRef.current?.history.present; const parent = parentId && next ? walkNodes(next).find(({ node }) => node.type !== "text" && node.id === parentId) : undefined; select([...(parent?.path ?? []), index]); }
  }
  function applyAsset(asset: LibraryAsset, action: AssetAction): string | undefined {
    const current = sessionRef.current;
    if (!current || editBlocked) return "処理が完了してから配置してください。";
    if (hasInput) return "入力を確定するか取り消してから配置してください。";
    const target = action === "pick" ? picker : action === "insert" ? { purpose: "insert" as const, selection } : selection && (action === "replace" ? { purpose: "image" as const, path: selection } : { purpose: "background" as const, path: selection, breakpoint: tier });
    if (!target) return "配置先の要素を選択してください。";
    try {
      const placement = assetPlacement(current.history.present, asset, target), error = apply(placement.operation);
      if (error) return error;
      setPicker(null); if (placement.notice) setNotice(placement.notice);
      if (placement.select) { setSelection(placement.select); setInspector("element"); setDraft(null); }
      return undefined;
    } catch (error) { return message(error); }
  }
  const siblingCount = document && selection ? selection.length === 1 ? document.body.length : (nodeAt(document, selection.slice(0, -1)) as { children: PageNode[] }).children.length : 0;
  const palette = [
    { type: "section", name: "セクション", glyph: "▤", group: "構造" }, { type: "box", name: "ボックス", glyph: "□", group: "構造" },
    { type: "text", name: "テキスト", glyph: "T", group: "文字" }, { type: "h2", name: "見出し", glyph: "H", group: "文字" },
    { type: "richtext", name: "リッチテキスト", glyph: "¶", group: "文字" }, { type: "a", name: "リンク", glyph: "↗", group: "文字" },
    { type: "img", name: "画像", glyph: "▧", group: "メディア" }
  ];
  const availableBlocks = Object.entries(blocks).filter(([key]) => !insertableBlocks || insertableBlocks.includes(key));
  const startDrag = (event: React.DragEvent<HTMLElement>, item: DragItem) => {
    if (!document || hasInput || editBlocked) { event.preventDefault(); return; }
    dragItem.current = item; event.dataTransfer.effectAllowed = item.kind === "node" ? "move" : "copy";
    event.dataTransfer.setData("text/plain", item.kind === "palette" ? item.type : item.id);
  };
  const site = sites.find((site) => site.id === siteId), page = session ? pages.find((page) => sameTarget(page, session.target)) : undefined;
  const pageOperations = !!adapter.preparePageChange && !!adapter.applyPageChange, unsaved = dirty || hasInput;
  const pageOperationsDisabled = unsaved || blocked || !!navigation || !site;
  const startPageChange = (start: PageChangeStart) => { if (pageOperations && !pageOperationsDisabled) setPageChange(start); };
  return <div className={`nw-editor${preview ? " is-preview" : ""}`}><style dangerouslySetInnerHTML={{ __html: editorCss + pagesCss + styleEditorCss }} />
    {assets && <style dangerouslySetInnerHTML={{ __html: assetEditorCss }} />}
    <header className="e-toolbar" ref={(element) => { if (element) element.inert = !!plan || !!navigation || !!pageChange; }}><div className="e-title"><strong className="e-brand">NIHO <span>Web</span></strong><span className="e-crumb">{sites.find((site) => site.id === siteId)?.name ?? "サイト"} / {pages.find((page) => page.pageId === session?.target.pageId)?.title ?? "ページ編集"}</span></div>
      <span className={`e-status${dirty ? " is-dirty" : ""}`} role="status">{busy || (hasInput ? "入力を確認中" : dirty ? "未保存の変更あり" : session ? "保存済み" : "文書を選択してください")}</span>
      <button onClick={() => travel("undo")} disabled={!session?.history.past.length || blocked || hasInput}>元に戻す</button>
      <button onClick={() => travel("redo")} disabled={!session?.history.future.length || blocked || hasInput}>やり直す</button>
      <button aria-pressed={preview} onClick={() => setPreview((value) => !value)} disabled={!document || blocked}>{preview ? "編集に戻る" : "プレビュー"}</button>
      <button onClick={() => void save()} disabled={!dirty || blocked || hasInput}>下書き保存</button>
      <button className="e-primary" onClick={() => void prepare("publish")} disabled={!session || dirty || blocked || hasInput}>公開前の確認</button>
    </header>
    {notice && <div className="e-notice" role="alert">{notice}</div>}
    <div className="e-body" ref={(element) => { if (element) element.inert = !!plan || !!navigation || !!pageChange; }}><aside className="e-rail e-left" aria-label="サイト・ページ・レイヤー">
      <nav className="e-tools" aria-label="編集ツール">{([
        ["add", "追加", "＋"], ["pages", "ページ", "▤"], ["layers", "レイヤー", "▦"], ["styles", "スタイル", "◐"], ["assets", "素材", "▧"], ["components", "部品", "◇"]
      ] as const).map(([key, name, glyph]) => <button key={key} type="button" aria-pressed={visiblePanel === key} title={name} onClick={() => { setPicker(null); setPanel(key); }}><span aria-hidden="true">{glyph}</span><small>{name}</small></button>)}</nav>
      <div className="e-panel">
        <section hidden={visiblePanel !== "add"} aria-label="要素を追加"><div className="e-panel-head"><h2>追加</h2><p>クリックで追加、ドラッグで配置</p></div>
          {["構造", "文字", "メディア"].map((group) => <div key={group}><h3>{group}</h3><div className="e-palette">{palette.filter((item) => item.group === group).map((item) => <button type="button" key={item.type} draggable={!!document && !editBlocked && !hasInput} onDragStart={(event) => startDrag(event, { kind: "palette", type: item.type })} onDragEnd={() => { dragItem.current = null; }} onClick={() => add(item.type)} disabled={!document || editBlocked || hasInput}><span aria-hidden="true">{item.glyph}</span>{item.name}</button>)}</div></div>)}
          <details><summary>挿入先と詳細</summary><label className="e-field"><span>追加・移動先</span><select aria-label="追加・移動先" value={parentId} disabled={editBlocked || hasInput} onChange={(event) => setParentId(event.target.value)}><option value="">ページ直下</option>{entries.filter(({ node }) => node.type === "element" && !["img", "source", "br", "hr"].includes(node.tag)).map(({ node }) => node.type === "element" && <option key={node.id} value={node.id}>{node.tag} · {node.id}</option>)}</select></label>
            <label className="e-field"><span>追加する要素</span><select aria-label="追加する要素" value={addType} onChange={(event) => setAddType(event.target.value)} disabled={editBlocked}><option value="p">段落</option><option value="h2">見出し</option><option value="section">セクション</option><option value="box">ボックス</option><option value="richtext">リッチテキスト</option><option value="a">リンク</option><option value="img">画像</option><option value="text">テキスト</option>{availableBlocks.map(([key, block]) => <option key={key} value={`block:${key}`}>{block.label ?? key}</option>)}</select></label>
            <button onClick={() => add()} disabled={!document || editBlocked || hasInput}>要素を追加</button></details>
        </section>
        <section hidden={visiblePanel !== "pages"} aria-label="ページ一覧">
          <PagePanel pages={pages} current={session?.target} disabled={blocked} operations={pageOperations} operationsDisabled={pageOperationsDisabled} unsaved={unsaved}
            select={(target) => { if (!session || !sameTarget(session.target, target)) requestNavigation({ type: "page", target }); }} start={startPageChange}>
            <label className="e-field"><span>編集するサイト</span><select aria-label="編集するサイト" value={siteId} disabled={blocked} onChange={(event) => requestNavigation({ type: "site", id: event.target.value })}>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
          </PagePanel>
          <button className="e-small" onClick={() => requestNavigation({ type: "reload" })} disabled={!session || blocked}>最新の文書を再読込</button>
        </section>
        <section hidden={visiblePanel !== "layers"} aria-label="レイヤー一覧"><div className="e-panel-head"><h2>レイヤー</h2><p>ドラッグで並べ替え、中央にも配置できます</p></div>
          <button className="e-layer" aria-pressed={!selection} onClick={() => select(null)} disabled={editBlocked}>ページ全体</button>
          <div className="e-layer-list">{entries.map(({ node, path }) => <button key={path.join(".")} type="button" className={`e-layer${layerDrop?.id === (node.type === "text" ? "" : node.id) ? ` drop-${layerDrop.position}` : ""}`} style={{ paddingLeft: 12 + (path.length - 1) * 13 }} aria-pressed={selection?.join(".") === path.join(".")} title={label(node, blocks)} onClick={() => select(path)} disabled={editBlocked} draggable={node.type !== "text" && !editBlocked && !hasInput}
            onDragStart={(event) => { if (node.type !== "text") startDrag(event, { kind: "node", id: node.id }); }} onDragEnd={() => { dragItem.current = null; setLayerDrop(null); }}
            onDragOver={(event) => { if (!dragItem.current || node.type === "text") return; const place = layerPlace(event, node.id); if (!place) return; event.preventDefault(); event.dataTransfer.dropEffect = dragItem.current.kind === "node" ? "move" : "copy"; setLayerDrop({ id: node.id, position: place.position }); }}
            onDrop={(event) => { if (!dragItem.current || node.type === "text") return; const place = layerPlace(event, node.id); if (place) { event.preventDefault(); dropAt(dragItem.current, place); } dragItem.current = null; setLayerDrop(null); }}>{label(node, blocks)}</button>)}</div>
          <label className="e-field"><span>移動先</span><select aria-label="移動先" value={parentId} disabled={editBlocked || hasInput} onChange={(event) => setParentId(event.target.value)}><option value="">ページ直下</option>{entries.filter(({ node }) => node.type === "element" && ["div", "section", "article", "header", "footer", "main", "nav", "aside", "li", "figure", "blockquote"].includes(node.tag)).map(({ node }) => node.type === "element" && <option key={node.id} value={node.id}>{node.tag} · {node.id}</option>)}</select></label>
          <div className="e-actions"><button disabled={!selection || editBlocked || hasInput} onClick={() => selection && structural({ type: "duplicate", path: selection })}>複製</button><button className="e-danger" disabled={!selection || editBlocked || hasInput} onClick={() => selection && structural({ type: "remove", path: selection })}>削除</button>
            <button disabled={!selection || selection.at(-1) === 0 || editBlocked || hasInput} onClick={() => moveBy(-1)}>上へ</button><button disabled={!selection || selection.at(-1)! >= siblingCount - 1 || editBlocked || hasInput} onClick={() => moveBy(1)}>下へ</button>
            <button disabled={!selection || editBlocked || hasInput} onClick={moveToEnd}>指定先の末尾へ</button>
          </div>
        </section>
        <section hidden={visiblePanel !== "styles"} aria-label="共通スタイル"><div className="e-panel-head"><h2>スタイル</h2><p>共通のカラーと文字スタイル</p></div>{document ? <StyleLibrary document={document} selection={selection} apply={apply} select={select} disabled={editBlocked} breakpoints={breakpoints} breakpoint={tier} until={until} preview={previewOperation} pending={pending} fieldKey={`${fieldEpoch}-library`} nodeLabel={(node) => label(node, blocks)} /> : <p className="e-help">ページを読み込むと、共通カラーとテキストスタイルを編集できます。</p>}</section>
        <section hidden={visiblePanel !== "assets"} aria-label="素材">{assets && session ? <AssetLibraryPanel key={session.target.siteId} adapter={assets} siteId={session.target.siteId} epoch={fieldEpoch} mode={picker ? "pick" : "library"} pickTitle={picker?.purpose === "background" ? "背景画像を選ぶ" : picker?.purpose === "replace" ? "置き換える画像を選ぶ" : "画像を選ぶ"} localUsage={localUsage}
          actions={{ replace: node?.type === "element" && node.tag === "img", background: node?.type === "component" || node?.type === "element" && !["img", "source", "br", "hr"].includes(node.tag), insert: !!document }}
          disabledReason={editBlocked ? "処理が完了してから配置してください。" : hasInput ? "入力を確定するか取り消してから配置してください。" : undefined} onApply={applyAsset} onClose={() => setPicker(null)} onReplaceUsages={(asset) => setPicker({ purpose: "replace", from: { provider: asset.provider, id: asset.id } })} />
          : <><div className="e-panel-head"><h2>素材</h2><p>画像の選択と差し替え</p></div><p className="e-help">現在は画像を追加し、右側の「画像 URL」で指定できます。</p><button type="button" onClick={() => add("img")} disabled={!document || editBlocked || hasInput}>画像を追加</button></>}</section>
        <section hidden={visiblePanel !== "components"} aria-label="部品"><div className="e-panel-head"><h2>部品</h2><p>サイトで利用できる部品</p></div>{availableBlocks.length ? <div className="e-palette">{availableBlocks.map(([key, block]) => <button type="button" key={key} draggable={!!document && !editBlocked && !hasInput} onDragStart={(event) => startDrag(event, { kind: "palette", type: `block:${key}` })} onDragEnd={() => { dragItem.current = null; }} onClick={() => add(`block:${key}`)} disabled={!document || editBlocked || hasInput}><span aria-hidden="true">◇</span>{block.label ?? key}</button>)}</div> : <p className="e-help">このサイトの部品はまだ登録されていません。</p>}</section>
        <details className="e-history"><summary>公開済みの版に戻す</summary><label className="e-field"><span>戻す版</span><select aria-label="戻す版" value={rollbackRevision} disabled={blocked} onChange={(event) => setRollbackRevision(event.target.value)}><option value="">版を選択</option>{session?.releases.map((release) => <option key={release.revision} value={release.revision}>{release.label}</option>)}</select></label><button disabled={!rollbackRevision || dirty || blocked || hasInput} onClick={() => void prepare("rollback")}>戻す内容を確認</button><small className="e-help">未保存の変更がある間は実行できません。</small></details>
      </div>
    </aside>
    <section className="e-canvas" aria-label="ライブプレビュー"><div className="e-canvas-tools"><div className="e-canvas-caption"><strong>{preview ? "プレビュー" : "キャンバス"}</strong><small>{preview ? "公開前の表示を確認" : "クリックで選択・ダブルクリックで文字編集"}</small></div>{resolvedAssets.failed && <button type="button" className="e-small" onClick={resolvedAssets.retry}>素材を再読み込み</button>}<label>表示幅 <select aria-label="表示幅" value={width} onChange={(event) => setWidth(Number(event.target.value))}>{[...new Set([320, 375, 768, 1280, 1440, width])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{({ 320: "小さいモバイル · ", 375: "モバイル · ", 768: "タブレット · ", 1280: "PC · ", 1440: "ワイド · " } as Record<number, string>)[value] ?? ""}{value}px</option>)}</select></label>{document && <span className="e-tier-note" title={`${tierName(shownTier)} の指定が効く幅です`}>表示中: {width}px（{shownTier.label} の段）</span>}</div><div className="e-stage">{document && canvasDocument ? <Canvas key={`${document.siteId}/${document.pageId}/${document.locale}`} document={canvasDocument} blocks={blocks} width={width} breakpoint={tier} selection={selection} select={select} dragItem={dragItem} drop={dropAt} pending={pending} editText={(path, children) => { const problem = apply({ type: "replaceChildren", path, children }); if (problem) setNotice(problem); return problem; }} resize={(path, width, height) => apply({ type: "resize", path, breakpoint: tier, width, height, ...(until === undefined ? {} : { until }) })} reportError={setNotice} editable={!editBlocked && !hasInput} locks={locks} preview={preview} assets={resolvedAssets.map} /> : <p className="e-empty">サイトとページを選ぶと、ここにプレビューを表示します。</p>}</div></section>
    <aside className="e-rail e-right" aria-label="インスペクタ"><div className="e-inspector-tabs" role="tablist" aria-label="設定の種類"><button type="button" role="tab" aria-selected={inspector === "element"} disabled={!node} onClick={() => setInspector("element")}>要素</button><button type="button" role="tab" aria-selected={inspector === "page"} onClick={() => setInspector("page")}>ページ</button><button type="button" role="tab" aria-selected={inspector === "site"} onClick={() => setInspector("site")}>サイト</button></div>
      {inspector === "site" && <section className="e-inspector-content"><SiteSettingsPanel site={site} state={siteSettings} /></section>}
      {inspector === "page" && <section className="e-inspector-content">{document && <PageSettings document={document} page={page} site={site} settings={siteSettings} field={field} apply={apply} report={setNotice} disabled={editBlocked}
        operations={pageOperations} operationsDisabled={pageOperationsDisabled} unsaved={unsaved} start={startPageChange} />}</section>}
      {inspector === "element" && <section className="e-inspector-content"><h2>{node ? label(node, blocks) : "要素を選択してください"}</h2>
      {node?.type === "text" && selection && field("テキスト", node.text, (value) => ({ type: "text", path: selection, value }), "text", { multiline: true, reason: document ? lockReason(document, selection, "text", locks) : undefined })}
      {node?.type === "element" && selection && <>{["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.tag) && <label className="e-field"><span>文字の種類</span><select aria-label="文字の種類" value={node.tag} disabled={editBlocked || !!reason("tag")} onChange={(event) => { const problem = apply({ type: "tag", path: selection, value: event.target.value as "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }); if (problem) setNotice(problem); }}><option value="p">段落</option><option value="h1">見出し 1</option><option value="h2">見出し 2</option><option value="h3">見出し 3</option><option value="h4">見出し 4</option><option value="h5">見出し 5</option><option value="h6">見出し 6</option></select></label>}{node.children.length === 1 && node.children[0]?.type === "text" && field("テキスト", node.children[0].text, (value) => ({ type: "text", path: [...selection, 0], value }), "child-text", { multiline: true, reason: document ? lockReason(document, [...selection, 0], "text", locks) : undefined })}
        {assets && node.tag === "img" && <ImageSourceField node={node} assets={resolvedAssets.map} failed={resolvedAssets.failed} lock={reason("attrs.src") ?? reason("asset")} disabled={editBlocked} onPick={() => setPicker({ purpose: "image", path: selection })}>
          {field("画像 URL", node.asset ? "" : String(node.attrs?.src ?? ""), (value) => ({ type: "image", path: selection, source: { src: value } }), "attrs.src", { reason: reason("attrs.src") })}</ImageSourceField>}
        {[...(node.tag === "a" ? [["href", "リンク先 URL"]] : []), ...(node.tag === "img" ? [...(assets ? [] : [["src", "画像 URL"]]), ["alt", "画像の説明"]] : [])].map(([name, caption]) => field(caption!, String(node.attrs?.[name!] ?? ""), (value) => ({ type: "attribute", path: selection, name: name!, value }), `attrs.${name}`, { reason: reason(`attrs.${name}`) }))}</>}
      {node?.type === "component" && selection && <><p className="e-help">表示用 props のみ編集できます。データ連動値はホストが管理します。</p>{Object.entries(blocks[node.block]!.props).map(([name, rule]) => {
        const locked = reason(`props.${name}`), value = node.props[name];
        if (rule.type === "boolean") return <label className="e-check" key={`${pathKey}-prop-${name}`}><input type="checkbox" checked={value === true} disabled={editBlocked || !!locked} onChange={(event) => { const error = apply({ type: "prop", path: selection, name, value: event.target.checked }); if (error) setNotice(error); }} />{name}{locked && <small className="e-help">ロック: {locked}</small>}</label>;
        if (rule.type === "enum") return <label className="e-field" key={`${pathKey}-prop-${name}`}><span>{name}</span><select aria-label={name} value={String(value ?? "")} disabled={editBlocked || !!locked} onChange={(event) => { const error = apply({ type: "prop", path: selection, name, value: event.target.value || undefined }); if (error) setNotice(error); }}><option value="">{rule.required ? "選択してください" : "未指定"}</option>{rule.values.map((option) => <option key={option}>{option}</option>)}</select>{locked && <small className="e-help">ロック: {locked}</small>}</label>;
        return field(name, String(value ?? ""), (input) => ({ type: "prop", path: selection, name, value: input === "" && !rule.required ? undefined : rule.type === "number" ? Number(input) : input }), `prop.${name}`, { reason: locked });
      })}</>}
      {node && node.type !== "text" && selection && document && <StyleInspector key={pathKey} document={document} saved={session?.saved} node={node} path={selection} blocks={blocks} tiers={tiers} tier={tier} setTier={setBreakpoint} range={range} setRange={setRange}
        width={width} setWidth={setWidth} apply={apply} preview={previewOperation} pending={pending} fieldKey={pathKey} disabled={editBlocked} tierLocked={hasInput} reason={reason} notify={setNotice}
        appearanceExtra={assets && (node.type !== "element" || !["img", "source", "br", "hr"].includes(node.tag)) && <BackgroundImageField key={`${pathKey}-${tier}-background`} declarations={tier === "base" ? node.style?.base : node.style?.responsive?.find((entry) => entry.minWidth === tier)?.declarations} assets={resolvedAssets.map}
          lock={(property) => reason(tier === "base" ? `style.base.${property}` : "style.responsive")} disabled={editBlocked} onPick={() => setPicker({ purpose: "background", path: selection, breakpoint: tier })}
          onClear={() => { const error = apply({ type: "background", path: selection, breakpoint: tier, asset: undefined }); if (error) setNotice(error); }} onStyle={(property, value) => { const error = apply({ type: "style", path: selection, breakpoint: tier, property, value }); if (error) setNotice(error); }} />} />}
      </section>}
    </aside></div>
    {navigation && <Dialog name="未保存の変更" dismiss={() => setNavigation(null)}><h2>未保存の変更があります</h2><p>移動・再読込すると、保存前の変更と入力途中の値を破棄します。</p><div className="e-actions"><button autoFocus onClick={() => setNavigation(null)}>編集を続ける</button><button className="e-danger" onClick={() => navigate(navigation)}>変更を破棄して移動</button></div></Dialog>}
    {plan && <Dialog name="公開前の対象と差分" dismiss={() => { if (!busy) setPlan(null); }}><h2>{plan.action === "rollback" ? `版 ${plan.revision} に戻す前の確認` : "公開前の確認"}</h2><p>反映先のドメイン</p><p className="e-domain">{plan.domain}</p><p>{session?.target.pageId} · {session?.target.locale}</p>
      <ReleaseSearchSummary document={document} page={page} domain={plan.domain} settings={siteSettings.settings} rollback={plan.action === "rollback"} /><table><thead><tr><th>変更箇所</th><th>現在の公開内容</th><th>反映する内容</th></tr></thead><tbody>{plan.changes.length ? plan.changes.map((change, index) => <tr key={index}><td>{change.path}</td><td>{change.before}</td><td>{change.after}</td></tr>) : <tr><td colSpan={3}>内容の差分はありません。</td></tr>}</tbody></table>
      <label className="e-check"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={(event) => setConfirmed(event.target.checked)} />このドメインと差分を確認し、反映する内容に同意しました</label>
      <div className="e-actions"><button autoFocus disabled={!!busy} onClick={() => setPlan(null)}>編集に戻る</button><button className="e-primary" disabled={!confirmed || !!busy} onClick={() => void release()}>{plan.action === "rollback" ? "この版に戻す" : "この内容を公開"}</button></div>
    </Dialog>}
    {pageChange && site && adapter.preparePageChange && adapter.applyPageChange && <PageChangeDialog start={pageChange} site={site} pages={pages} locale={session?.target.locale ?? pages[0]?.locale ?? siteSettings.settings?.locale ?? "ja"}
      prepare={(change, signal) => adapter.preparePageChange!(change, signal)} apply={(plan, signal) => adapter.applyPageChange!(plan, signal)}
      applied={(page, change) => void pageApplied(page, change)} conflicted={() => void reloadPages()} close={() => setPageChange(null)}
      reload={() => { const current = sessionRef.current?.target; setPageChange(null); void reloadPages().then(() => current && load(current)); }} />}
  </div>;
}
