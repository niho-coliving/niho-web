"use client";

import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageRenderer } from "./react.js";
import { parsePageDocument } from "./document.js";
import { canvasCss, pageScope } from "./css.js";
import { DocumentValidationError } from "./validation-utils.js";
import { acceptSavedRevision, commitHistory, editDocument, effectiveLocks, fingerprint, lockReason, newElement, nodeAt, parseEditorReadOnly, sameTarget, travelHistory, validateReleasePlan, walkNodes, type EditorHistory, type EditorOperation, type NodePath } from "./editor-model.js";
import { editorCss, historyCss, pagesCss } from "./editor-style.js";
import { styleEditorCss } from "./editor-style-css.js";
import { Field } from "./editor-fields.js";
import { StyleInspector, type StyleRange } from "./editor-style-inspector.js";
import { StyleLibrary } from "./editor-style-library.js";
import type { StyleState } from "./editor-style-motion.js";
import { carouselPreset, togglePreset } from "./interaction-presets.js";
import { editorTiers, hiddenAt, normalizeBreakpoints, tierForWidth, tierName } from "./style-model.js";
import { Dialog } from "./editor-dialog.js";
import { PageChangeDialog, PageSettings, PagePanel, ReleaseSearchSummary, SiteSettingsPanel, chooseSiteCover, coverReferences, pageChangeNotice, publicInfoMessage, useSiteSettings, type FieldOptions, type PageChangeStart } from "./editor-pages.js";
import { AutosaveSwitch, ConflictDialog, HistoryBar, HistoryDialogs, RecoveryBanner, RecoveryCompareDialog, ReleaseAffected, SaveStatus, VersionPanel, autosaveDelay, classifySaveError, formatDateTime, isOffline, saveProblemNotice, saveStatus, targetKeyOf, useAutosave, useOnline, useRecovery, useVersionHistory, type LatestSnapshot, type SaveProblem } from "./editor-history.js";
import { isDirectlyEditable, readEditableChildren } from "./editor-rich-text.js";
import { isSafePublicUrl } from "./validation-utils.js";
import type { ComponentUsageEntry, EditorBlockRegistry, EditorLocaleReleasePlan, EditorLocaleReleaseState, EditorLock, EditorPage, EditorPageChange, EditorReadOnly, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorSnapshot, EditorTarget, PageEditorProps } from "./editor-types.js";
import type { ComponentKind, ComponentLibrary, ElementTag, PageDocument, PageNode } from "./types.js";
import { AssetLibraryPanel, BackgroundImageField, ImageSourceField, assetPlacement, socialImageProblem, useLocalAssetUsage, useResolvedAssets, type AssetAction, type AssetPicker } from "./editor-assets.js";
import { assetEditorCss, canvasAssetCss } from "./editor-assets-style.js";
import type { LibraryAsset, ResolvedAssetMap } from "./assets.js";
import { componentIssues, componentUsage, parseComponentLibrary, type ResolvedOrigin } from "./components.js";
import { bumpChangedComponentVersions, componentDocument, createComponentFromNode, duplicateComponent, removeComponent, renameComponent, setComponentKind, setComponentProp, withComponentDocument } from "./component-model.js";
import { ComponentBanner, ComponentDialogBody, ComponentPanel, ComponentSettings, CreateComponentSection, InstanceInspector, MasterPropFields, componentDialogTitle, type ComponentDialogState, type InputRenderer } from "./component-panel.js";
import { BlockSlotInspector, BlockSlotList, applyToSlot, declaredSlot, previewRegistry, slotFromTarget } from "./block-slot-panel.js";
import {
  acceptSavedLibrary, commitLibrary, componentProblem, exposeComponentProp, fitsLibrary, libraryFingerprint, librarySessionFrom, parseUsage, placementProblem,
  relabelComponentProp, releaseAffected, resolveCanvas, summarizeUsage, textStylePaths, travelLibrary, usageText, type LibrarySession
} from "./component-session.js";
import { LanguageSelector, LocalizationPanel, localizationEditorCss, localizedOperationProblem, useEditorLocalization, type EditorLocalizationCommandOutcome, type EditorLocalizationManualBuffer } from "./editor-localization.js";
import { parseEditorLocaleReleaseApplyResult, parseEditorLocaleReleasePlan, parseEditorLocaleReleaseState } from "./editor-locale-release.js";
import { documentLocaleFor, localizationLocaleFor, validateLocalizedDocumentSave, type LocalizationLocale } from "./localization.js";

export type * from "./editor-types.js";
const emptyBlocks: EditorBlockRegistry = {};
type Session = { target: EditorTarget; history: EditorHistory; version: string; saved: string; hasSavedDraft?: boolean | undefined; locks: readonly EditorLock[]; releases: NonNullable<EditorSnapshot["releases"]>; readOnly?: EditorReadOnly };
type Inspector = "element" | "page" | "site" | "localization";
type Navigation = { type: "site"; id: string } | { type: "page"; target: EditorTarget } | { type: "reload" }
  | { type: "inspector"; inspector: Inspector } | { type: "node"; path: NodePath; canvasId?: string }
  | { type: "localization-unit"; unitId: string; canvasId: string };
const message = (error: unknown) => error instanceof DocumentValidationError ? publicInfoMessage(error) ??
  (/nesting|parent|void element/.test(error.message) ? "この場所には要素を配置できません。別のセクションかボックスを選んでください。" : "文書のルールに合いません。URL・単位・親要素を確認してください。") :
  error instanceof Error ? error.message : "入力を適用できません。";
const releasePreparationNotice = (error: unknown): string => {
  const status = error && typeof error === "object" && "status" in error ? error.status : null;
  if (status === 409) return "公開する下書きの状態が変わりました。編集内容を保持しています。最新の文書を確認してから再試行してください。";
  if (status === 401) return "認証を確認してから、公開前の確認をやり直してください。編集内容は保持しています。";
  if (status === 403) return "公開する権限がありません。管理者に確認してください。編集内容は保持しています。";
  return "公開先と差分を確認できませんでした。接続を確認して再試行してください。編集内容は保持しています。";
};
const label = (node: PageNode, blocks: EditorBlockRegistry, names?: ReadonlyMap<string, string>) => node.type === "text" ? `文字: ${node.text.slice(0, 24) || "（空）"}` : node.type === "component" ? `${blocks[node.block]?.label ?? node.block} · ${node.id}` : node.type === "instance" ? names?.get(node.component) ?? "共通部品" : `${node.tag} · ${node.id}`;
const partGlyph = (node: PageNode | undefined) => node?.type === "instance" && <span className="e-part-glyph" aria-hidden="true">◇ </span>;
const noOrigins: ReadonlyMap<string, ResolvedOrigin> = new Map();
/** components はインスタンスを含む文書の検証に使う、同じサイトの検証済みライブラリ。 */
function sessionFrom(snapshot: EditorSnapshot, target: EditorTarget, blocks: EditorBlockRegistry, components?: ComponentLibrary): Session {
  const document = parsePageDocument(snapshot.document, blocks, components ? { components } : {});
  if (!sameTarget(document, target) || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("読込対象が一致しません。");
  if (snapshot.hasSavedDraft !== undefined && typeof snapshot.hasSavedDraft !== "boolean") throw new Error("公開状態が正しくありません。");
  const readOnly = parseEditorReadOnly(snapshot.readOnly);
  return { target, history: { past: [], present: document, future: [] }, version: snapshot.version, saved: fingerprint(document), locks: snapshot.locks ?? [], releases: snapshot.releases ?? [], ...(snapshot.hasSavedDraft === undefined ? {} : { hasSavedDraft: snapshot.hasSavedDraft }), ...(readOnly ? { readOnly } : {}) };
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
function Canvas({ document, blocks, width, breakpoint, selection, selectedNodeId, slot, select, canEditNode, dragItem, drop, pending, editText, resize, reportError, editable, structureEditable, locks, preview, assets, motionCss, replay, rendered, origins, openInstance }: {
  document: PageDocument; blocks: EditorBlockRegistry; width: number; selection: NodePath | null; selectedNodeId?: string; select: (path: NodePath | null, nodeId?: string, slot?: string | null) => void;
  canEditNode?: (nodeId: string) => boolean;
  slot: string | null;

  breakpoint: number | "base";
  dragItem: { current: DragItem | null }; drop: (item: DragItem, place: DropPlace) => void;
  pending: (key: string, value: boolean) => void;
  editText: (path: NodePath, nodeId: string, children: PageNode[]) => string | undefined; resize: (path: NodePath, width: number, height: number) => string | undefined;
  reportError: (message: string) => void; editable: boolean; structureEditable: boolean; locks: readonly EditorLock[]; preview: boolean; assets: ResolvedAssetMap;
  /** 状態の強制表示と動きの停止。replay が変わると描画を作り直し、登場をもう一度見せる。 */
  motionCss: string; replay: string;
  /** 描画する展開済みの文書と、展開したノードの出所。選択・ドラッグ等は document のノードで扱う。 */
  rendered: PageDocument; origins: ReadonlyMap<string, ResolvedOrigin>; openInstance: (instanceId: string, nodeId: string) => void;
}) {
  const [body, setBody] = useState<HTMLElement | null>(null), frame = useRef<HTMLIFrameElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null), [dropPlace, setDropPlace] = useState<DropPlace | null>(null);
  const [handleRect, setHandleRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const resizing = useRef<{ element: HTMLElement; path: NodePath; x: number; y: number; width: number; height: number; inlineWidth: string; inlineHeight: string } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false), [linkHref, setLinkHref] = useState("/"), [linkError, setLinkError] = useState("");
  const originalHtml = useRef(""), savedRange = useRef<Range | null>(null);
  const scope = pageScope(rendered), entries = walkNodes(document), renderedEntries = rendered === document ? entries : walkNodes(rendered);
  const selected = selectedNodeId ? renderedEntries.find(({ node }) => node.type !== "text" && node.id === selectedNodeId)?.node : selection ? nodeAt(document, selection) : undefined;
  const selectedId = selected?.type === "text" && selection && selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : selected;
  const resizePath = selected?.type === "text" ? selection?.slice(0, -1) : selection;
  // 表示領域を選んでいる間は、幅と高さを変えられる領域だけ、その最初の要素にサイズ変更の枠を出す。
  const slotSize = slot && selectedId?.type === "component" ? declaredSlot(blocks[selectedId.block], slot)?.style ?? [] : undefined;
  const sizeField = (property: "width" | "height") => `${slot ? `slots.${slot}` : "style"}.${breakpoint === "base" ? `base.${property}` : "responsive"}`;
  const canResize = structureEditable && !preview && !editingId && selectedId && selectedId.type !== "text" && !!resizePath?.length && (!slotSize || slotSize.includes("width") && slotSize.includes("height")) &&
    !lockReason(document, resizePath, sizeField("width"), locks) &&
    !lockReason(document, resizePath, sizeField("height"), locks);
  const sizeTarget = (id: string) => { const element = body && Array.from(body.querySelectorAll<HTMLElement>("[data-nw-node]")).find((item) => item.dataset.nwNode === id); return slot ? element?.querySelector<HTMLElement>(`[data-nw-slot="${slot}"]`) ?? undefined : element ?? undefined; };

  const editing = editingId ? entries.find(({ node }) => node.type !== "text" && node.id === editingId) : undefined;
  // 部品の内側に描いたノードは、文書に置いたインスタンス（ID を引き継いだ外枠）として扱う。
  const ownerElement = (element: HTMLElement | null): HTMLElement | null => {
    const origin = element?.dataset.nwNode ? origins.get(element.dataset.nwNode) : undefined;
    return element && origin && origin.instance !== element.dataset.nwNode ? element.closest<HTMLElement>(`[data-nw-owner="${scope}"][data-nw-node="${origin.instance}"]`) : element;
  };
  useEffect(() => {
    if (!body || !canResize || !selectedId) { setHandleRect(null); return; }
    const element = sizeTarget(selectedId.id);
    if (!element) { setHandleRect(null); return; }
    const update = () => { const rect = element.getBoundingClientRect(); setHandleRect({ left: rect.left + (body.ownerDocument.defaultView?.scrollX ?? 0), top: rect.top + (body.ownerDocument.defaultView?.scrollY ?? 0), width: rect.width, height: rect.height }); };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update); observer?.observe(element);
    body.ownerDocument.defaultView?.addEventListener("scroll", update);
    return () => { observer?.disconnect(); body.ownerDocument.defaultView?.removeEventListener("scroll", update); };
  }, [body, canResize, selectedId && "id" in selectedId ? selectedId.id : undefined, width, document, slot]);
  function endResize(commit: boolean) {
    const current = resizing.current; if (!current) return;
    const width = Number.parseFloat(current.element.style.width) || current.width, height = Number.parseFloat(current.element.style.height) || current.height;
    current.element.style.width = current.inlineWidth; current.element.style.height = current.inlineHeight;
    resizing.current = null;
    if (commit && (Math.abs(width - current.width) > 1 || Math.abs(height - current.height) > 1)) { const problem = resize(current.path, width, height); if (problem) reportError(problem); }
  }
  useEffect(() => {
    if (!body || !structureEditable || !selectedId || selectedId.type === "text" || preview || editingId) return;
    const element = Array.from(body.querySelectorAll<HTMLElement>("[data-nw-node]")).find((item) => item.dataset.nwNode === selectedId.id);
    if (!element) return;
    element.draggable = true;
    return () => { element.removeAttribute("draggable"); };
  }, [body, structureEditable, selectedId?.type === "text" ? "" : selectedId?.id, preview, editingId]);
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
    // 部品のインスタンスを含む文字は直接編集すると要素へ置き換わるため、インスペクタで編集する。
    if (descendants.some(({ node }) => node.type === "instance")) return null;
    return candidate;
  }
  function stopEditing(commit: boolean) {
    if (!body || !editing || editing.node.type !== "element") { if (editingId) pending(`direct-${editingId}`, false); setEditingId(null); return; }
    const element = Array.from(body.querySelectorAll<HTMLElement>("[data-nw-node]")).find((item) => item.dataset.nwNode === editingId);
    if (!element) { pending(`direct-${editingId}`, false); setEditingId(null); return; }
    if (commit) {
      try {
        const problem = editText(editing.path, editing.node.id, readEditableChildren(element, editing.node));
        if (problem) element.innerHTML = originalHtml.current;
      } catch (error) { element.innerHTML = originalHtml.current; reportError(error instanceof Error ? error.message : "文字の変更を適用できませんでした。"); }
    } else element.innerHTML = originalHtml.current;
    element.removeAttribute("contenteditable"); pending(`direct-${editingId}`, false); setEditingId(null); setLinkOpen(false); setLinkError("");
  }
  function placeAt(event: React.DragEvent<HTMLElement>): DropPlace {
    const target = ownerElement(asElement(event.target)?.closest<HTMLElement>(`[data-nw-owner="${scope}"][data-nw-node]`) ?? null);
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
      const element = typeof target.closest === "function" ? target.closest<HTMLElement>(`[data-nw-owner="${scope}"][data-nw-node]`) : null;
      const id = element?.dataset.nwNode, entry = entries.find(({ node }) => node.type !== "text" && node.id === id);
      select(entry?.path ?? null, id, structureEditable && element && entry?.node.type === "component" ? slotFromTarget(target, element, blocks[entry.node.block]?.slots) : null);

    }} onDoubleClickCapture={(event) => {
      if (!editable || preview || editingId) return;
      // インスタンスの中は部品の編集を開き、最上位の部品の中で対応するノード（入れ子の部品ならそのインスタンス）を選ぶ。
      const origin = origins.get(asElement(event.target)?.closest<HTMLElement>(`[data-nw-owner="${scope}"][data-nw-node]`)?.dataset.nwNode ?? "");
      if (origin) {
        if (!structureEditable) { select(null, asElement(event.target)?.closest<HTMLElement>(`[data-nw-owner="${scope}"][data-nw-node]`)?.dataset.nwNode); return; }
        openInstance(origin.instance, origin.chain.length === 1 ? origin.node : origin.chain[1]!); return;
      }
      const element = editableElement(event.target);
      if (element) { const path = entries.find(({ node }) => node.type !== "text" && node.id === element.dataset.nwNode)?.path, id = element.dataset.nwNode ?? ""; if (path) { select(path, id); if (!canEditNode || canEditNode(id)) { setEditingId(id); pending(`direct-${id}`, true); } } }
    }} onBlurCapture={(event) => { const target = asElement(event.target), next = asElement(event.relatedTarget); if (target?.dataset.nwNode === editingId && !linkOpen || linkOpen && target?.closest(".nw-text-toolbar") && !next?.closest(".nw-text-toolbar,[contenteditable=true]")) stopEditing(true); }}
      onKeyDownCapture={(event) => { if (!editingId || event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Escape") { event.preventDefault(); stopEditing(false); } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); stopEditing(true); } else if (event.key === "Enter" && editing?.node.type === "element" && editing.node.tag !== "div") { event.preventDefault(); insertLineBreak(); } }}
      onPasteCapture={(event) => { if (!editingId || !asElement(event.target)?.closest("[contenteditable=true]")) return; event.preventDefault(); pastePlainText(event.clipboardData.getData("text/plain")); }}
      onDragStartCapture={(event) => { if (!editable || preview || editingId) return; const target = asElement(event.target)?.closest<HTMLElement>("[data-nw-node][draggable=true]"); if (!target?.dataset.nwNode) return; dragItem.current = { kind: "node", id: target.dataset.nwNode }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", target.dataset.nwNode); }}
      onDragEndCapture={() => { dragItem.current = null; setDropPlace(null); }}
      onDragOverCapture={(event) => { if (!editable || preview || !dragItem.current) return; event.preventDefault(); event.dataTransfer.dropEffect = dragItem.current.kind === "node" ? "move" : "copy"; setDropPlace(placeAt(event)); }}
      onDragLeaveCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropPlace(null); }}
      onDropCapture={(event) => { event.preventDefault(); event.stopPropagation(); if (!editable || preview || !dragItem.current) return; const place = placeAt(event); drop(dragItem.current, place); dragItem.current = null; setDropPlace(null); }}
      onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <style>{`body{font-family:sans-serif;position:relative;}[data-nw-node]{cursor:pointer;}[data-nw-owner][data-nw-node]:is(section,div):empty{min-height:48px;outline:1px dashed #a4b9aa;}[contenteditable=true]{cursor:text!important;outline:2px solid #2d7356!important;outline-offset:3px;} ${selectedId && selectedId.type !== "text" ? `[data-nw-owner="${scope}"][data-nw-node="${selectedId.id}"]{outline:2px ${selectedId.type === "instance" ? "dashed #5b46a8" : "solid #198558"}!important;outline-offset:2px;}` : ""}${selectedId?.type === "component" && slot ? `[data-nw-owner="${scope}"][data-nw-node="${selectedId.id}"] [data-nw-slot="${slot}"]{outline:2px dashed #198558!important;outline-offset:2px;}` : ""}
        .nw-drop-marker{position:absolute;pointer-events:none;z-index:2147483000;background:#34a66d;box-shadow:0 0 0 2px white}.nw-drop-marker.inside{background:#34a66d22;outline:2px dashed #198558;box-shadow:none}.nw-resize-handle{position:absolute;z-index:2147483001;width:15px;height:15px;border:2px solid white;border-radius:4px;background:#258858;box-shadow:0 0 0 1px #245b3f;cursor:nwse-resize;touch-action:none}
        .nw-text-toolbar{position:fixed;z-index:2147483001;right:12px;top:12px;display:flex;gap:4px;align-items:center;padding:6px;border:1px solid #d7e2d9;background:#fff;border-radius:10px;box-shadow:0 8px 24px #20382b30;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.nw-text-toolbar button,.nw-text-toolbar input{font:inherit;border:1px solid #d8e2d9;border-radius:6px;background:white;padding:5px 7px}.nw-text-toolbar input{width:170px}.nw-text-toolbar .problem{color:#a23d30}`}</style>
      <style>{canvasAssetCss}</style>
      <PreviewBoundary document={rendered}><StablePageRenderer key={replay} document={rendered} blocks={blocks} assets={assets} missingAssets="placeholder" /></PreviewBoundary>
      <style>{motionCss}</style>
      {dropPlace && <div aria-hidden className={`nw-drop-marker${dropPlace.marker.inside ? " inside" : ""}`} style={{ left: dropPlace.marker.left, top: dropPlace.marker.top, width: dropPlace.marker.width, height: dropPlace.marker.height }} />}
      {canResize && handleRect && resizePath && <button type="button" className="nw-resize-handle" aria-label="ドラッグして要素のサイズを変更" title={`${Math.round(handleRect.width)} × ${Math.round(handleRect.height)} px`} style={{ left: handleRect.left + handleRect.width - 7, top: handleRect.top + handleRect.height - 7 }}
        onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); const element = sizeTarget(selectedId.id); if (!element) return; const bounds = element.getBoundingClientRect(), computed = body.ownerDocument.defaultView?.getComputedStyle(element); resizing.current = { element, path: resizePath, x: event.clientX, y: event.clientY, width: Number.parseFloat(computed?.width ?? "") || bounds.width, height: Number.parseFloat(computed?.height ?? "") || bounds.height, inlineWidth: element.style.width, inlineHeight: element.style.height }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { const current = resizing.current; if (!current) return; event.preventDefault(); current.element.style.width = `${Math.min(10000, Math.max(1, Math.round(current.width + event.clientX - current.x)))}px`; current.element.style.height = `${Math.min(10000, Math.max(1, Math.round(current.height + event.clientY - current.y)))}px`; }}
        onPointerUp={(event) => { event.preventDefault(); event.stopPropagation(); endResize(true); }} onPointerCancel={() => endResize(false)} />}
      {editingId && <div className="nw-text-toolbar" role="toolbar" aria-label="文字の装飾" contentEditable={false}>
        {structureEditable ? <><button type="button" aria-label="太字" onMouseDown={(event) => event.preventDefault()} onClick={() => format("bold")}>B</button>
        <button type="button" aria-label="斜体" onMouseDown={(event) => event.preventDefault()} onClick={() => format("italic")}>I</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { savedRange.current = body.ownerDocument.getSelection()?.rangeCount ? body.ownerDocument.getSelection()!.getRangeAt(0).cloneRange() : null; setLinkOpen(true); }}>リンク</button>
        {editing?.node.type === "element" && editing.node.tag === "div" && <><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("formatBlock", "p")}>段落</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("formatBlock", "h2")}>見出し</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("insertUnorderedList")}>箇条書き</button><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => format("insertOrderedList")}>番号</button></>}</> : <span>リンクと装飾を保持して文字だけ編集します</span>}
        {linkOpen && <><input aria-label="リンク先URL" value={linkHref} onChange={(event) => { setLinkHref(event.target.value); setLinkError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyLink(); } }} /><button type="button" onClick={applyLink}>適用</button>{linkError && <span className="problem" role="alert">{linkError}</span>}</>}
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => stopEditing(true)}>完了</button>
      </div>}
    </div>, body)}
  </>;
}

/** 認証済みホストに接続する共通エディター。ネットワーク URL や秘密を所有しない。 */
export function PageEditor({ adapter, blocks = emptyBlocks, insertableBlocks, assets, breakpoints: hostBreakpoints, autosave, recovery }: PageEditorProps) {
  const adapterRef = useRef(adapter); adapterRef.current = adapter;
  const [sites, setSites] = useState<readonly EditorSite[]>([]), [siteId, setSiteId] = useState("");
  const [pages, setPages] = useState<readonly EditorPage[]>([]), [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const [selection, setSelection] = useState<NodePath | null>(null), [selectedLocalizationUnit, setSelectedLocalizationUnit] = useState<string | null>(null), [selectedCanvasNode, setSelectedCanvasNode] = useState<string | null>(null), [width, setWidth] = useState(1280);
  // 選んだ業務ブロックの表示領域。of は選んだときの selection で、選択・部品の編集・ページ・サイトが変わると（同じノードを選び直しても）外れる。back は「ブロック全体に戻る」で戻った領域。
  const [slotChoice, setSlotChoice] = useState<{ of: NodePath; name: string | null; back?: string } | null>(null);

  const [fieldEpoch, setFieldEpoch] = useState(0);
  const [breakpoint, setBreakpoint] = useState<number | "base">("base"), [notice, setNotice] = useState("");
  // 入力中のライブプレビュー。基準の文書が変わった（確定・undo/redo・保存・移動）時点で無効になる。
  const [draft, setDraft] = useState<{ base: PageDocument; document: PageDocument } | null>(null), [range, setRange] = useState<StyleRange>("wide");
  // 編集中の状態（ホバー等）はキャンバスへ強制表示する。動きは初期は止め、選択枠がずれないようにする。
  const [styleState, setStyleState] = useState<StyleState>("normal"), [motion, setMotion] = useState(false), [replay, setReplay] = useState(0);
  const breakpoints = normalizeBreakpoints(hostBreakpoints);
  const [busy, setBusy] = useState(""), [pendingFields, setPendingFields] = useState<Record<string, boolean>>({});
  const [navigation, setNavigation] = useState<Navigation | null>(null), [plan, setPlan] = useState<EditorReleasePlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [localeRelease, setLocaleRelease] = useState<EditorLocaleReleaseState | null>(null), [localeReleasePlan, setLocaleReleasePlan] = useState<EditorLocaleReleasePlan | null>(null);
  const [localeReleaseConfirmed, setLocaleReleaseConfirmed] = useState(false), [localeReleaseLoading, setLocaleReleaseLoading] = useState(false), [localeReleaseEpoch, setLocaleReleaseEpoch] = useState(0);
  const [localeRollbackId, setLocaleRollbackId] = useState("");
  const [addType, setAddType] = useState("p"), [parentId, setParentId] = useState(""), [rollbackRevision, setRollbackRevision] = useState("");
  const [panel, setPanel] = useState<"add" | "pages" | "layers" | "styles" | "assets" | "components">("add");
  const [inspector, setInspector] = useState<Inspector>("page"), [preview, setPreview] = useState(false);
  const [localizationManual, setLocalizationManual] = useState<EditorLocalizationManualBuffer | null>(null);
  const [layerDrop, setLayerDrop] = useState<{ id: string; position: "before" | "inside" | "after" } | null>(null);
  const dragItem = useRef<DragItem | null>(null);
  const [picker, setPicker] = useState<AssetPicker | null>(null), [localizationAssetUnit, setLocalizationAssetUnit] = useState<string | null>(null), visiblePanel = picker || localizationAssetUnit ? "assets" : panel;
  useEffect(() => { setPicker(null); }, [selection]);
  // 共通部品は adapter.components があるホストだけ。usage は undefined が取得中、null が取得失敗。editing は編集中の部品。
  const components = adapter.components, [library, setLibrary] = useState<LibrarySession | null>(null), libraryRef = useRef(library); libraryRef.current = library;
  const libraryPresent = library?.history.present;
  const [libraryFailed, setLibraryFailed] = useState(false), [usage, setUsage] = useState<readonly ComponentUsageEntry[] | null | undefined>(undefined);
  const [editing, setEditing] = useState<string | null>(null), [componentDialog, setComponentDialog] = useState<ComponentDialogState | null>(null), usageRequest = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null), action = useRef<AbortController | null>(null), pageList = useRef<AbortController | null>(null), releaseRead = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), [adapter]);
  const [pageChange, setPageChange] = useState<PageChangeStart | null>(null), siteSettings = useSiteSettings(adapter, siteId);
  const [problem, setProblem] = useState<SaveProblem | null>(null), [savedAt, setSavedAt] = useState<Date | null>(null), [loadEpoch, setLoadEpoch] = useState(0);
  const [conflictView, setConflictView] = useState(0), [recoveryCompare, setRecoveryCompare] = useState(false), [autosaveOn, setAutosaveOn] = useState(true);
  const localization = useEditorLocalization(adapter, siteId, session?.target, blocks, libraryPresent, loadEpoch, setNotice);
  let selectedLocale: LocalizationLocale | undefined;
  try { if (localization.site && session) selectedLocale = localizationLocaleFor(localization.site.config, session.target.locale); } catch { /* read hook reports the invalid mapping */ }
  const targetMode = !!localization.site && !!selectedLocale && selectedLocale !== localization.site.config.sourceLocale;
  const localePublication = !!adapter.localization?.readRelease && !!adapter.localization.prepareRelease && !!adapter.localization.applyRelease && !!adapter.localization.rollbackRelease;
  const localizationReady = !localization.supported || localization.siteState === "ready" && !!localization.site && !!selectedLocale &&
    (selectedLocale === localization.site.config.sourceLocale || localization.pageState === "ready" && !!localization.context && !!session && sameTarget(localization.context.target, session.target));
  const problemRef = useRef(problem); problemRef.current = problem;
  const pending = useCallback((key: string, value: boolean) => setPendingFields((previous) => {
    if (!!previous[key] === value) return previous;
    const next = { ...previous }; if (value) next[key] = true; else delete next[key]; return next;
  }), []);
  const pageInputPending = Object.values(pendingFields).some(Boolean);
  const manualInputPending = !!localizationManual?.pending && !!session && sameTarget(localizationManual.target, session.target);
  const hasInput = pageInputPending || manualInputPending, dirty = !!session && fingerprint(session.history.present) !== session.saved;
  const masterId = editing && libraryPresent?.components.some((component) => component.id === editing) ? editing : null;
  const libraryDirty = !!library && libraryFingerprint(library.history.present) !== library.saved, pendingChanges = dirty || libraryDirty, locale = session?.target.locale ?? "ja";
  const blocked = !!busy || !!plan || !!localeReleasePlan || !!pageChange;
  const versions = useVersionHistory({ adapter, blocks, components: libraryPresent, target: session?.target, version: session?.version, epoch: loadEpoch, report: setNotice,
    guard: () => hasInput ? "入力を適用するか取り消してから版を選んでください。" : busy ? "処理が完了してから版を選んでください。" : undefined });
  // 部品の保存中はライブラリの編集だけを止め、ページは保存中と同じく編集を続けられる。版の表示中はどちらも止める。
  const documentReadOnly = !masterId ? session?.readOnly : undefined;
  const historyMode = !!versions.viewing, libraryBlocked = (blocked && busy !== "保存中") || historyMode || targetMode || !localizationReady,
    pageOperationalBlocked = (blocked && busy !== "保存中" && busy !== "部品を保存中") || historyMode || !localizationReady,
    pageBlocked = pageOperationalBlocked || !!documentReadOnly;
  const editBlocked = masterId ? libraryBlocked : pageBlocked;
  // 退避はページの作業コピーだけ。共通部品の現在の内容で展開できない退避内容は復元させない。
  const recoveryState = useRecovery({ store: recovery, session: session && !session.readOnly ? { target: session.target, version: session.version, present: session.history.present } : undefined, dirty: dirty && !session?.readOnly, blocks, components: libraryPresent, epoch: loadEpoch, report: setNotice });
  const autosaveMs = autosaveDelay(autosave), autosaveActive = autosaveMs !== undefined && autosaveOn;
  // オフラインで失敗した後、接続が戻ったら自動保存は1回だけ再試行する。
  const online = useOnline(() => { if (problemRef.current !== "offline") return; if (!autosaveActive) setProblem("failed"); else if (!pendingChanges) setProblem(null); else void save("auto"); });
  const modal = !!plan || !!localeReleasePlan || !!navigation || !!pageChange || conflictView > 0 || recoveryCompare || versions.dialog !== null || !!componentDialog;
  // 自動保存は手動保存と同じく部品 → ページの順に保存する。部品とページのどちらが変わっても待ち直す。
  const autosaveSubject = useMemo(() => [session?.history.present, libraryPresent], [session?.history.present, libraryPresent]);
  // ページが無いサイトでも、部品の変更は部品ライブラリ単位の key で自動保存する（部品は端末の退避の対象外のため）。
  const autosaveKey = (target: EditorTarget | undefined, lib: LibrarySession | null) => target ? targetKeyOf(target) : lib ? JSON.stringify(["library", lib.siteId]) : "";
  useAutosave(autosaveMs, autosaveActive && pendingChanges && (!dirty || !session?.readOnly) && !hasInput && !busy && !modal && !historyMode && online && !problem && localizationReady, autosaveSubject, autosaveKey(session?.target, library),
    (key) => { if (autosaveKey(sessionRef.current?.target, libraryRef.current) === key) void save("auto"); });
  const replace = useCallback((next: Session | null) => { sessionRef.current = next; setSession(next); }, []);
  const replaceLibrary = useCallback((next: LibrarySession | null) => { libraryRef.current = next; setLibrary(next); }, []);
  useEffect(() => {
    releaseRead.current?.abort(); setLocaleRelease(null); setLocaleRollbackId("");
    if (!targetMode || !localePublication || !localization.site || !selectedLocale) { setLocaleReleaseLoading(false); return; }
    const controller = new AbortController(); releaseRead.current = controller; setLocaleReleaseLoading(true);
    adapter.localization!.readRelease!({ siteId: localization.site.config.siteId, locale: selectedLocale }, controller.signal).then((value) => {
      if (!controller.signal.aborted) setLocaleRelease(parseEditorLocaleReleaseState(value, localization.site!.config.siteId, selectedLocale!));
    }).catch(() => { if (!controller.signal.aborted) setNotice("この言語の公開状態を読み込めませんでした。管理者権限と接続を確認して再試行してください。"); })
      .finally(() => { if (!controller.signal.aborted) setLocaleReleaseLoading(false); });
    return () => controller.abort();
  }, [adapter, localePublication, targetMode, localization.site?.config.siteId, selectedLocale, localeReleaseEpoch]);
  const refreshUsage = useCallback((siteId: string) => {
    if (!components) return;
    usageRequest.current?.abort(); const controller = new AbortController(); usageRequest.current = controller;
    components.listUsage(siteId, controller.signal).then((entries) => { if (!controller.signal.aborted) setUsage(parseUsage(entries, siteId)); })
      .catch(() => { if (!controller.signal.aborted) setUsage(null); });
  }, [components]);
  /** ページより先に読み、失敗してもページの読込は続ける（部品を含むページは検証できず表示できない）。 */
  const openLibrary = useCallback(async (siteId: string, signal: AbortSignal) => {
    if (!components) return;
    try {
      const snapshot = await components.readLibrary(siteId, signal);
      if (signal.aborted) return;
      replaceLibrary(librarySessionFrom(snapshot, siteId, blocks)); refreshUsage(siteId);
    } catch { if (!signal.aborted) setLibraryFailed(true); }
  }, [components, blocks, replaceLibrary, refreshUsage]);
  const load = useCallback(async (target: EditorTarget, options?: { preserveView?: boolean }): Promise<boolean> => {
    const editorTarget: EditorTarget = { siteId: target.siteId, pageId: target.pageId, locale: target.locale };
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy("読込中"); setNotice("");
    try {
      const snapshot = await adapter.readDocument(editorTarget, controller.signal);
      if (controller.signal.aborted) return false;
      replace(sessionFrom(snapshot, editorTarget, blocks, libraryRef.current?.history.present));
      if (!options?.preserveView) { setSelection(null); setInspector("page"); setSelectedLocalizationUnit(null); setSelectedCanvasNode(null); setLocalizationManual(null); }
      setFieldEpoch((value) => value + 1); setPendingFields({}); setPlan(null); setRollbackRevision(""); setParentId("");
      setProblem(null); setSavedAt(null); setConflictView(0); setRecoveryCompare(false); setLoadEpoch((value) => value + 1); setEditing(null);
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
    replaceLibrary(null); setLibraryFailed(false); setUsage(undefined); setEditing(null); usageRequest.current?.abort();
    const listed = components ? openLibrary(siteId, controller.signal).then(() => controller.signal.aborted ? [] : adapter.listPages(siteId, controller.signal)) : adapter.listPages(siteId, controller.signal);
    listed.then((result) => {
      if (controller.signal.aborted) return;
      if (result.some((page) => page.siteId !== siteId)) throw new Error("site mismatch");
      setPages(result); if (result[0]) void load(result[0]); else { replace(null); setBusy(""); }
    }).catch(() => { if (!controller.signal.aborted) { setNotice("ページ一覧を読み込めませんでした。"); setBusy(""); } });
    return () => { controller.abort(); request.current?.abort(); pageList.current?.abort(); };
  }, [adapter, siteId, load, replace, components, openLibrary, replaceLibrary]);
  useEffect(() => () => { request.current?.abort(); action.current?.abort(); pageList.current?.abort(); releaseRead.current?.abort(); }, []);
  useEffect(() => () => usageRequest.current?.abort(), []);
  useEffect(() => {
    function prevent(event: BeforeUnloadEvent) { event.preventDefault(); }
    if (pendingChanges || hasInput || siteSettings.dirty) window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [pendingChanges, hasInput, siteSettings.dirty]);
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
    // ページの追加・複製・公開範囲の変更で使用状況が変わるため取り直す。
    if (libraryRef.current) refreshUsage(libraryRef.current.siteId);
  }

  function navigate(next: Navigation) {
    setNavigation(null);
    if (next.type === "inspector") { setLocalizationManual(null); setPendingFields({}); setInspector(next.inspector); return; }
    if (next.type === "node") { setLocalizationManual(null); setSelection(next.path); setSelectedLocalizationUnit(null); setSelectedCanvasNode(next.canvasId ?? null); setInspector("element"); setDraft(null); setStyleState("normal"); return; }
    if (next.type === "localization-unit") { setLocalizationManual(null); setSelection(null); setSelectedCanvasNode(next.canvasId); setSelectedLocalizationUnit(next.unitId); setInspector("localization"); setDraft(null); return; }
    setSelection(null); setInspector("page"); setSelectedLocalizationUnit(null); setSelectedCanvasNode(null); setLocalizationManual(null); setFieldEpoch((value) => value + 1); setPendingFields({});
    setPicker(null);
    if (editing) { setEditing(null); setParentId(""); }
    if (next.type === "site") { replace(null); replaceLibrary(null); setSiteId(next.id); setProblem(null); setSavedAt(null); }
    else if (next.type === "page") void load(next.target);
    else if (sessionRef.current) void load(sessionRef.current.target);
  }
  // ページの移動では部品の変更を保持するため、部品の未保存はサイトの移動だけで確認する。
  function requestNavigation(next: Navigation) { if (blocked || next.type === "site" && siteSettings.busy) return; if (dirty || hasInput || next.type === "site" && (siteSettings.dirty || libraryDirty)) setNavigation(next); else navigate(next); }
  function requestInspector(next: Inspector) { if (next === inspector) return; if (manualInputPending) { setNavigation({ type: "inspector", inspector: next }); return; } setInspector(next); }
  function select(path: NodePath | null, slot: string | null = null) { if (manualInputPending && path) { setNavigation({ type: "node", path }); return; } if (hasInput) { setNotice("入力を適用するか取り消してから選択を変えてください。"); return; } if (!(masterId ? libraryBlocked : pageOperationalBlocked)) { setSelection(path); setSlotChoice(path && slot && !targetMode ? { of: path, name: slot } : null); setSelectedLocalizationUnit(null); setSelectedCanvasNode(null); setInspector(path ? "element" : "page"); setDraft(null); setStyleState("normal"); } }
  /** 選択中の業務ブロックの表示領域を選ぶ。null は「ブロック全体に戻る」。 */
  function chooseSlot(name: string | null) { if (hasInput) { setNotice("入力を適用するか取り消してから選択を変えてください。"); return; } if (!targetMode && !editBlocked && selection) { setSlotChoice({ of: selection, name, ...(!name && slotName ? { back: slotName } : {}) }); setDraft(null); setStyleState("normal"); } }

  /** 複数の操作は1回の履歴にまとめる。部品の編集中は部品の root を1つだけ持つ文書を編集し、ライブラリへ書き戻す。 */
  function apply(operation: EditorOperation | readonly EditorOperation[]): string | undefined {
    const operations: readonly EditorOperation[] = "type" in operation ? [operation] : operation;
    if (masterId) {
      setDraft(null);
      // 部品はページのタイトル・公開情報・文字スタイルを持たない。
      if (operations.some((next) => next.type === "title" || next.type === "meta" || next.type === "textStyle" || next.type === "restore" || next.type === "nodeTextStyle" && next.name !== undefined)) return "部品の編集中は、文字スタイルとページの設定を変更できません。ページに戻ってから操作してください。";
      return updateLibrary((library) => withComponentDocument(library, masterId, operations.reduce((master, next) => editDocument(master, next, blocks, [], library), componentDocument(library, masterId, locale)), blocks));
    }
    const current = sessionRef.current; if (!current || editBlocked) return current?.readOnly?.reason ?? "処理が完了してから編集してください。";
    try {
      const lib = libraryRef.current?.history.present;
      if (targetMode) {
        if (!localization.context || !sameTarget(localization.context.target, current.target)) return "訳文の状態を読み込んでから編集してください。";
        const problem = operations.map((next) => localizedOperationProblem(current.history.present, next, localization.context!.collection)).find(Boolean);
        if (problem) return problem;
      }
      const document = operations.reduce((page, next) => editDocument(page, next, blocks, current.locks, lib), current.history.present);
      replace({ ...current, history: commitHistory(current.history, document) }); setDraft(null); setNotice(""); return undefined;
    } catch (error) { setDraft(null); return message(error); }
  }
  function previewOperation(operation: EditorOperation | readonly EditorOperation[] | null) {
    // 部品の編集中は部品の文書で、ページはインスタンスを検証できるようライブラリを渡して試す。
    const current = sessionRef.current, base = master ?? current?.history.present;
    if (!operation || !base || editBlocked) { setDraft(null); return; }
    const operations: readonly EditorOperation[] = "type" in operation ? [operation] : operation;
    if (!master && targetMode && (!localization.context || operations.some((next) => localizedOperationProblem(current!.history.present, next, localization.context!.collection)))) { setDraft(null); return; }
    try { setDraft({ base, document: operations.reduce((document, next) => editDocument(document, next, blocks, master ? [] : current?.locks ?? [], libraryRef.current?.history.present), base) }); } catch { /* 成功した入力だけを表示する */ }

  }
  /** ライブラリを変更する。編集中のページを展開できなくなる変更は受け付けない。 */
  function updateLibrary(change: (library: ComponentLibrary) => ComponentLibrary): string | undefined {
    const current = libraryRef.current, page = sessionRef.current?.history.present;
    if (!current || libraryBlocked) return "処理が完了してから編集してください。";
    try {
      const next = change(current.history.present);
      if (page && !fitsLibrary(page, next, blocks)) return "編集中のページで部品を展開できなくなるため、この変更はできません。";
      replaceLibrary({ ...current, history: commitLibrary(current.history, next) }); setNotice(""); return undefined;
    } catch (error) { return componentProblem(error) ?? message(error); }
  }
  function structural(operation: EditorOperation) { const error = apply(operation); if (error) setNotice(error); else setSelection(null); }
  function travel(direction: "undo" | "redo") {
    if (blocked || hasInput || historyMode || !masterId && session?.readOnly) return;
    // 部品とページの履歴は別に持つため、もう一方と合わなくなる移動は止める。
    const mismatch = "共通部品とページの内容が合わなくなるため、この操作はできません。";
    if (masterId) {
      const current = libraryRef.current; if (!current) return;
      const history = travelLibrary(current.history, direction), page = sessionRef.current?.history.present;
      if (page && !fitsLibrary(page, history.present, blocks)) { setNotice(mismatch); return; }
      replaceLibrary({ ...current, history }); setSelection(null); setNotice("");
      if (!history.present.components.some((component) => component.id === masterId)) resetMode();
      return;
    }
    if (!session) return;
    try {
      const lib = libraryRef.current?.history.present, history = travelHistory(session.history, direction, blocks, session.locks, lib);
      if (lib && !fitsLibrary(history.present, lib, blocks)) { setNotice(mismatch); return; }
      replace({ ...session, history }); setSelection(null); setNotice("");
    } catch (error) { setNotice(message(error)); }
  }
  /**
   * 成功時だけ true。競合・失敗時は部品とページの変更を保持し、保存状態に問題を出して自動保存を止める。
   * 部品の競合を見比べる画面は無いため、保存状態は「保存できませんでした」にする。
   */
  async function saveComponents(current: LibrarySession, signal: AbortSignal, auto: boolean): Promise<boolean> {
    if (!components) return true;
    const conflicted = "共通部品の保存が競合しました（409）。部品とページの変更を保持しています。最新の状態を確認してからやり直してください。";
    const failure = auto ? "共通部品を自動保存できませんでした。部品とページの変更を保持しています。「再試行」で保存できます。" : "共通部品を保存できませんでした。部品とページの変更を保持しています。時間をおいて再試行してください。";
    const failed = (next: SaveProblem, text: string) => { if (libraryRef.current?.siteId !== current.siteId) return; setProblem(next); setNotice(text); };
    setBusy("部品を保存中");
    try {
      const library = parseComponentLibrary(bumpChangedComponentVersions(current.history.present, current.savedLibrary), blocks);
      const result = await components.saveLibrary({ siteId: current.siteId, library: structuredClone(library), expectedVersion: current.version, ...(auto ? { trigger: "autosave" as const } : {}) }, signal);
      if (signal.aborted) return false;
      if (result.status === "conflict") { failed("failed", conflicted); return false; }
      if (typeof result.version !== "string" || !result.version || result.version === current.version) throw new Error("version must advance");
      const latest = libraryRef.current;
      if (latest && latest.siteId === current.siteId && latest.version === current.version) replaceLibrary(acceptSavedLibrary(latest, current.history.present, library, result));
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      const kind = classifySaveError(error);
      failed(kind === "conflict" ? "failed" : kind, kind === "conflict" ? conflicted : kind === "failed" ? failure : saveProblemNotice(kind, auto, true));
      return false;
    }
  }
  /**
   * 手動保存と自動保存の共通処理。部品 → ページの順に保存し、部品を保存できなければページは保存しない
   * （ページは保存していない部品の変更に依存しうるため）。応答は送信時のサイト・ページ・locale と version が一致する場合だけ採用する。
   */
  async function save(mode: "manual" | "auto" = "manual"): Promise<boolean> {
    const changed = libraryRef.current, libraryChanged = !!changed && libraryFingerprint(changed.history.present) !== changed.saved;
    if (!sessionRef.current && !libraryChanged || action.current || blocked || hasInput || historyMode || !!sessionRef.current && !localizationReady || mode === "auto" && isOffline()) return false;
    const controller = new AbortController(), auto = mode === "auto", hadProblem = !!problemRef.current; action.current = controller; if (!auto) setNotice("");
    let current = sessionRef.current, librarySaved = false, pageSaved = false;
    const sameSession = () => { const latest = sessionRef.current; return !!latest && !!current && sameTarget(latest.target, current.target); };
    const failed = (next: SaveProblem, thrown: boolean) => { if (!sameSession()) return; setProblem(next); setNotice(saveProblemNotice(next, auto, thrown)); if (next === "conflict" && !auto) setConflictView((value) => value + 1); };
    try {
      if (changed && libraryChanged) { if (!await saveComponents(changed, controller.signal, auto)) return false; librarySaved = true; current = sessionRef.current; }
      if (librarySaved && (!current || fingerprint(current.history.present) === current.saved)) {
        setProblem(null); setSavedAt(new Date()); if (!auto) setNotice("共通部品を保存しました。"); else if (hadProblem) setNotice("");
        return true;
      }
      if (!current) return false;
      if (current.readOnly) { if (!auto) setNotice(current.readOnly.reason); return false; }
      setBusy("保存中");
      const lib = libraryRef.current?.history.present, document = parsePageDocument(current.history.present, blocks, lib ? { components: lib } : {});
      const localized = targetMode ? localization.context : null;
      if (targetMode && (!localized || !sameTarget(localized.target, current.target))) throw new Error("訳文の状態を読み込んでから保存してください。");
      if (localized) await validateLocalizedDocumentSave(localized.config, localized.sourceDocument, document, localized.options);
      const result = await adapter.saveDraft({ target: current.target, document: structuredClone(document), expectedVersion: current.version, ...(auto ? { trigger: "autosave" as const } : {}),
        ...(localized ? { localization: { expectedSourceVersion: localized.sourceVersion, expectedVersion: localized.version, expectedOverlayVersion: localized.overlay.version } } : {}) }, controller.signal);
      if (controller.signal.aborted) return false;
      if (result.status === "conflict") { failed("conflict", false); return false; }
      if (typeof result.version !== "string" || !result.version || result.version === current.version) throw new Error("version must advance");
      const latest = sessionRef.current;
      if (latest && sameTarget(latest.target, current.target) && latest.version === current.version) {
        const acknowledged = acceptSavedRevision(latest.history, document, result.revision);
        replace({ ...latest, ...acknowledged, version: result.version, hasSavedDraft: true });
      }
      if (sameSession()) { setProblem(null); setSavedAt(new Date()); setConflictView(0); }
      if (localized) localization.reloadPage();
      if (!auto) setNotice(librarySaved ? "共通部品と下書きを保存しました。" : "下書きを保存しました。"); else if (hadProblem) setNotice("");
      pageSaved = true; return true;
    } catch (error) { if (!controller.signal.aborted) failed(classifySaveError(error), true); return false; }
    finally {
      if (!controller.signal.aborted) {
        setBusy("");
        if (librarySaved || pageSaved) {
          if (libraryRef.current) refreshUsage(libraryRef.current.siteId);
          if (adapter.localization) localization.reloadSite();
        }
      }
      action.current = null;
    }
  }
  async function prepare(actionType: "publish" | "rollback", revision = Number(rollbackRevision)) {
    const current = sessionRef.current, site = sites.find((site) => site.id === current?.target.siteId);
    if (!current || current.readOnly || !site || action.current || blocked || dirty || libraryDirty || masterId || hasInput || targetMode || !localizationReady || current.hasSavedDraft === false || (actionType === "rollback" && !current.releases.some((release) => release.revision === revision))) return;
    const controller = new AbortController(); action.current = controller; setBusy("公開差分を取得中"); setNotice("");
    // 確認 token を、表示している部品ライブラリの version にも結び付ける。
    const input: EditorReleaseRequest = { target: current.target, expectedVersion: current.version, action: actionType,
      ...(actionType === "rollback" ? { revision } : {}), ...(components && libraryRef.current ? { componentsVersion: libraryRef.current.version } : {}) };
    try {
      const result = await adapter.prepareRelease(input, controller.signal);
      if (controller.signal.aborted) return;
      const reviewed = structuredClone(result); validateReleasePlan(reviewed, input, site); setPlan(reviewed); setConfirmed(false);
    } catch (error) { if (!controller.signal.aborted) setNotice(releasePreparationNotice(error)); }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }
  async function release() {
    const current = sessionRef.current;
    if (!current || current.readOnly || current.hasSavedDraft === false || !plan || !confirmed || action.current || busy || dirty || libraryDirty || hasInput || targetMode || !localizationReady) return;
    const controller = new AbortController(); action.current = controller; setBusy("公開を反映中");
    try {
      const result = await adapter.release(plan, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "conflict") { setNotice("公開が競合しました（409）。編集内容を保持しています。最新状態を確認してからやり直してください。"); setPlan(null); return; }
      replace(sessionFrom(result.snapshot, current.target, blocks, libraryRef.current?.history.present)); setSelection(null); setFieldEpoch((value) => value + 1); setPlan(null); setProblem(null); setNotice(plan.action === "rollback" ? "指定した版に戻しました。" : "公開しました。");
      setPicker(null);
    } catch { if (!controller.signal.aborted) { setNotice("反映結果を確認できませんでした。再試行前に公開状態をホスト側で確認してください。編集内容は保持しています。"); setPlan(null); } }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }
  async function prepareLocaleRelease(actionType: "publish" | "rollback") {
    const current = sessionRef.current, siteState = localization.site, selected = selectedLocale, rollback = localeRelease?.history.find((entry) => entry.releaseId === localeRollbackId);
    if (!current || current.readOnly || !siteState || !selected || !targetMode || !localePublication || !localeRelease || localeReleaseLoading || action.current || blocked || dirty || libraryDirty || masterId || hasInput || historyMode || !localizationReady || actionType === "rollback" && !rollback) return;
    const controller = new AbortController(), startedAdapter = adapter, startedTarget = current.target; action.current = controller; setBusy(actionType === "rollback" ? "言語全体の復元内容を取得中" : "言語全体の公開内容を取得中"); setNotice("");
    const input = { siteId: siteState.config.siteId, locale: selected, action: actionType, expectedSiteVersion: siteState.version, expectedCurrentVersion: localeRelease.current?.version ?? null,
      ...(actionType === "rollback" ? { rollbackReleaseId: rollback!.releaseId } : {}) } as const;
    try {
      const result = await adapter.localization!.prepareRelease!(input, controller.signal);
      if (controller.signal.aborted || adapterRef.current !== startedAdapter || !sessionRef.current || !sameTarget(sessionRef.current.target, startedTarget)) return;
      const site = sites.find((entry) => entry.id === input.siteId);
      if (!site) throw new Error("release site is unavailable");
      const reviewed = parseEditorLocaleReleasePlan(structuredClone(result), input, site.domains);
      const expectedPages = siteState.pages.filter((page) => page.kind !== "shared" && page.visibility !== "private" && page.published !== false).map((page) => page.pageId).sort();
      const preparedPages = reviewed.pages.map((page) => page.pageId).sort();
      if (!preparedPages.length || (actionType === "publish" ? JSON.stringify(preparedPages) !== JSON.stringify(expectedPages) : preparedPages.some((id) => !expectedPages.includes(id))))
        throw new Error("release plan does not match the public page catalogue");
      setLocaleReleasePlan(reviewed); setLocaleReleaseConfirmed(false);
    } catch (error) {
      if (!controller.signal.aborted && adapterRef.current === startedAdapter && sessionRef.current && sameTarget(sessionRef.current.target, startedTarget)) {
        const refreshed = await load(startedTarget, { preserveView: true });
        if (!controller.signal.aborted && adapterRef.current === startedAdapter && sessionRef.current && sameTarget(sessionRef.current.target, startedTarget)) {
          localization.reloadAll(); setLocaleReleaseEpoch((value) => value + 1);
          setNotice(classifySaveError(error) === "conflict"
            ? "原文または公開状態が更新されています（409）。最新状態を読み直してから、公開内容を確認し直してください。"
            : refreshed ? "公開内容を確認できませんでした。最新状態を読み直しました。対象と権限を確認して再試行してください。"
              : "公開内容と最新の文書を読み込めませんでした。下書きは保持しています。接続と権限を確認して再試行してください。");
        }
      }
    }
    finally { if (!controller.signal.aborted && action.current === controller) setBusy(""); if (action.current === controller) action.current = null; }
  }
  async function applyLocaleRelease() {
    const current = sessionRef.current, localePlan = localeReleasePlan;
    if (!current || current.readOnly || !localePlan || !localePlan.complete || !localeReleaseConfirmed || !targetMode || !localePublication || action.current || busy || dirty || libraryDirty || masterId || hasInput || historyMode || !localizationReady) return;
    const controller = new AbortController(), startedAdapter = adapter, startedTarget = current.target; action.current = controller; setBusy(localePlan.action === "rollback" ? "言語全体を復元中" : "言語全体を公開中");
    const request = { confirmationToken: localePlan.confirmationToken, siteId: localePlan.siteId, locale: localePlan.locale, expectedCurrentVersion: localePlan.expectedCurrentVersion,
      optimisticVersion: localePlan.optimisticVersion, preparedReleaseId: localePlan.prepared.releaseId, preparedVersion: localePlan.prepared.version };
    try {
      const response = localePlan.action === "rollback" ? await adapter.localization!.rollbackRelease!(request, controller.signal) : await adapter.localization!.applyRelease!(request, controller.signal);
      if (controller.signal.aborted || adapterRef.current !== startedAdapter || !sessionRef.current || !sameTarget(sessionRef.current.target, startedTarget)) return;
      const result = parseEditorLocaleReleaseApplyResult(response, localePlan);
      setLocaleReleasePlan(null);
      if (result.status === "conflict") setNotice("言語全体の公開状態が競合しました（409）。下書きは変更していません。最新状態を確認してからやり直してください。");
      else if (result.status === "expired") setNotice("確認の有効期限が切れました。下書きは変更していません。もう一度、公開内容を確認してください。");
      else setNotice(localePlan.action === "rollback" ? "以前の言語全体版を新しい公開版として復元しました。" : "言語全体を公開しました。");
    } catch { if (!controller.signal.aborted) { setLocaleReleasePlan(null); setNotice("反映結果を確認できませんでした。再実行する前に現在の言語公開状態を確認してください。下書きは保持しています。"); } }
    finally {
      if (!controller.signal.aborted && action.current === controller) { setBusy(""); setLocaleReleaseEpoch((value) => value + 1); localization.reloadAll(); }
      if (action.current === controller) action.current = null;
    }
  }
  /** 版・退避内容を通常の編集として作業コピーへ適用する。履歴モード中も呼べる。 */
  async function restoreDocument(source: PageDocument): Promise<string | undefined> {
    const current = sessionRef.current;
    if (!current || blocked && busy !== "保存中") return "処理が完了してから復元してください。";
    if (current.readOnly) return current.readOnly.reason;
    if (hasInput) return "入力を適用するか取り消してから復元してください。";
    if (masterId) return "部品の編集を終えてから復元してください。";
    try {
      if (targetMode) {
        const localized = localization.context;
        if (!localized || !sameTarget(localized.target, current.target)) return "訳文の状態を読み込んでから復元してください。";
        await validateLocalizedDocumentSave(localized.config, localized.sourceDocument, source, localized.options);
      }
      const latest = sessionRef.current;
      if (!latest || !sameTarget(latest.target, current.target) || latest.version !== current.version || fingerprint(latest.history.present) !== fingerprint(current.history.present)) return "復元の確認中に編集内容が変わりました。もう一度確認してください。";
      // 部品のインスタンスは現在の正本ライブラリで検証し、展開できない内容は復元しない。
      replace({ ...latest, history: commitHistory(latest.history, editDocument(latest.history.present, { type: "restore", document: source }, blocks, latest.locks, libraryRef.current?.history.present)) });
      setSelection(null); setInspector("page"); return undefined;
    } catch (error) { return message(error); }
  }
  async function restoreRecovered() {
    const offer = recoveryState.offer; if (!offer) return;
    const problem = await restoreDocument(offer.document);
    setRecoveryCompare(false);
    if (problem) { setNotice(problem); return; }
    recoveryState.accepted(); setNotice("端末に残っていた変更を復元しました。保存すると新しい版として記録されます。");
  }
  async function restoreRevision() {
    const viewing = versions.viewing; if (!viewing) return;
    const problem = await restoreDocument(viewing.document);
    if (problem) { setNotice(problem); return; }
    versions.exit(); setNotice(`${formatDateTime(viewing.entry.createdAt)} の版を作業コピーに復元しました。保存すると新しい版として記録されます。`);
  }
  /** 最新の保存内容へ切り替え、手元の編集と退避内容を破棄する。 */
  function loadLatest({ snapshot }: LatestSnapshot) {
    const current = sessionRef.current; if (!current) return;
    try {
      const next = sessionFrom(snapshot, current.target, blocks, libraryRef.current?.history.present);
      recoveryState.drop(current.target); replace(next); setSelection(null); setInspector("page"); setFieldEpoch((value) => value + 1); setPendingFields({}); setRollbackRevision(""); setParentId(""); setEditing(null);
      setProblem(null); setSavedAt(null); setConflictView(0); setNotice("最新の保存内容を読み込みました。");
    } catch { setNotice("最新の内容を読み込めませんでした。編集内容は保持しています。"); }
  }
  /** 最新の version と revision を基準にして、あなたの編集で保存し直す。 */
  function overwriteWith({ snapshot, document: latest }: LatestSnapshot) {
    const current = sessionRef.current, latestReadOnly = parseEditorReadOnly(snapshot.readOnly);
    if (!current || current.readOnly || latestReadOnly || !sameTarget(current.target, latest)) {
      if (latestReadOnly) setNotice(latestReadOnly.reason);
      return;
    }
    const rebase = (document: PageDocument): PageDocument => ({ ...document, revision: latest.revision });
    const history = { past: current.history.past.map(rebase), present: rebase(current.history.present), future: current.history.future.map(rebase) };
    replace({ ...current, history, version: snapshot.version, saved: fingerprint(latest), hasSavedDraft: snapshot.hasSavedDraft, locks: snapshot.locks ?? [], releases: snapshot.releases ?? [] });
    setConflictView(0); setProblem(null);
    if (fingerprint(history.present) === fingerprint(latest)) { setNotice("最新の保存内容と同じ内容です。"); return; }
    void save("manual");
  }
  async function saveAndNavigate(next: Navigation) {
    setNavigation(null);
    if (!await save("manual")) return;
    const current = sessionRef.current;
    if (current && fingerprint(current.history.present) !== current.saved) { setNotice("保存中に変更がありました。もう一度保存してから移動してください。"); return; }
    navigate(next);
  }

  // 部品の編集中は、キャンバス・レイヤー・選択・インスペクタが部品の root を1つだけ持つ文書を扱う。
  const master = useMemo(() => libraryPresent && masterId ? componentDocument(libraryPresent, masterId, locale) : undefined, [libraryPresent, masterId, locale]);
  const document = master ?? session?.history.present, entries = document ? walkNodes(document) : [];
  const names = useMemo(() => new Map(libraryPresent?.components.map((component) => [component.id, component.name] as const)), [libraryPresent]);
  const pageDocument = session?.history.present, pageTitle = session ? pages.find((page) => sameTarget(page, session.target))?.title ?? session.history.present.title : undefined;
  const usageSummary = useMemo(() => libraryPresent && summarizeUsage(usage, session && pageDocument && pageTitle !== undefined ? { target: session.target, title: pageTitle, counts: componentUsage(pageDocument, libraryPresent) } : undefined, libraryPresent, pages),
    [usage, session?.target, pageDocument, pageTitle, libraryPresent, pages]);
  const masterComponent = masterId ? libraryPresent?.components.find((component) => component.id === masterId) : undefined;
  const node = document && selection ? nodeAt(document, selection) : undefined;
  const staleProps = node?.type === "instance" && document && libraryPresent ? componentIssues(document, libraryPresent).find((issue) => issue.nodeId === node.id)?.staleProps ?? [] : [];
  const locks = document ? effectiveLocks(document, masterId ? [] : session?.locks ?? [], blocks) : [];
  const reason = (field: string) => document && selection ? lockReason(document, selection, field, locks) : undefined;
  const pathKey = `${fieldEpoch}-${selection?.join(".") ?? "page"}`;
  const slotName = !targetMode && slotChoice?.name && slotChoice.of === selection && node?.type === "component" && declaredSlot(blocks[node.block], slotChoice.name) ? slotChoice.name : null;
  const slotBack = slotChoice && slotChoice.of === selection && !slotChoice.name ? slotChoice.back : undefined, canvasBlocks = previewRegistry(blocks);
  // 表示領域を選んでいる間は、選択中のブロックへの見た目の操作（キャンバスのサイズ変更・スタイルパネルの適用）をその領域へ写す。
  const applyStyle = (operation: EditorOperation) => slotName && document && selection && "path" in operation && operation.path.join(".") === selection.join(".") ? applyToSlot(document, selection, slotName, blocks, operation, apply) : apply(operation);
  const tiers = document ? editorTiers(document, breakpoints) : [], tier = tiers.some((entry) => entry.key === breakpoint) ? breakpoint : "base";
  const shownTier = tierForWidth(tiers, width), canvasDocument = document && draft?.base === document ? draft.document : document;
  const nextTier = tiers[tiers.findIndex((entry) => entry.key === tier) + 1], until = range === "only" ? nextTier?.start : undefined;
  // キャンバスは部品を展開した文書を描き、素材・状態の強制表示も展開後の文書から作る（部品の中の画像も表示する）。
  const shown = versions.viewing?.document ?? canvasDocument;
  // 訳文では正本 LibrarySession 自体を変えず、同じ canonical ID を持つ表示専用のlocalized libraryだけを展開に使う。
  const canvasLibrary = targetMode && !masterId ? localization.context?.localizedComponents : libraryPresent;
  const canvas = useMemo(() => shown && resolveCanvas(shown, canvasLibrary, blocks), [shown, canvasLibrary, blocks]);
  const renderedCanvas = canvas?.document, canvasOrigins = canvas?.origins ?? noOrigins;
  const resolvedAssets = useResolvedAssets(assets, session?.target.siteId, canvas?.document ?? versions.viewing?.document ?? document, fieldEpoch, coverReferences(document, siteSettings)), localUsage = useLocalAssetUsage(document);
  const savedMaster = useMemo(() => library && masterId && library.savedLibrary.components.some((component) => component.id === masterId) ? fingerprint(componentDocument(library.savedLibrary, masterId, locale)) : undefined,
    [library?.savedLibrary, masterId, locale]);
  function field(name: string, value: string, operation: (value: string) => EditorOperation, key: string, options: FieldOptions = {}) {
    const localizationReason = targetMode && key === "meta.favicon" ? "共通設定は原文側で編集してください。" : targetMode && document && localization.context ? localizedOperationProblem(document, operation(value), localization.context.collection) : undefined;
    return <Field key={`${pathKey}-${key}`} name={name} value={value} fieldKey={`${pathKey}-${key}`} pending={pending} disabled={editBlocked}
      apply={(value) => apply(operation(value))} {...options} reason={options.reason ?? localizationReason} />;
  }
  const input: InputRenderer = (name, value, change, key, options = {}) => <Field key={`${pathKey}-${key}`} name={name} value={value} fieldKey={`${pathKey}-${key}`} pending={pending} disabled={editBlocked} apply={change} {...options} />;
  function currentDocument(): PageDocument | undefined {
    const lib = libraryRef.current?.history.present;
    return masterId && lib?.components.some((component) => component.id === masterId) ? componentDocument(lib, masterId, locale) : sessionRef.current?.history.present;
  }
  function openComponent(componentId: string, nodeId?: string) {
    if (hasInput) { setNotice("入力を適用するか取り消してから選択を変えてください。"); return; }
    const lib = libraryRef.current?.history.present;
    if (pageOperationalBlocked || !lib?.components.some((component) => component.id === componentId)) return;
    const next = componentDocument(lib, componentId, locale), path = nodeId ? walkNodes(next).find(({ node }) => node.type !== "text" && node.id === nodeId)?.path : undefined;
    // 部品の外枠の外（ページ直下）には置けないため、追加・移動先の既定を外枠にする。版履歴はページのものなので閉じる。
    if (versions.open) versions.close();
    setEditing(componentId); setParentId(next.body[0]?.type === "element" ? next.body[0].id : ""); setSelection(path ?? null); setInspector(path ? "element" : "page"); setDraft(null); setPicker(null); setStyleState("normal"); setFieldEpoch((value) => value + 1);
  }
  function resetMode() { setEditing(null); setSelection(null); setInspector("page"); setDraft(null); setPicker(null); setStyleState("normal"); setParentId(""); setFieldEpoch((value) => value + 1); }
  function leaveComponent() { if (hasInput) setNotice("入力を適用するか取り消してから選択を変えてください。"); else resetMode(); }
  function openInstance(instanceId: string, nodeId: string) {
    const instance = entries.find(({ node }) => node.type === "instance" && node.id === instanceId)?.node;
    if (instance?.type === "instance") openComponent(instance.component, nodeId);
  }
  function createComponent(path: NodePath, name: string, kind: ComponentKind): string | undefined {
    const current = sessionRef.current, lib = libraryRef.current;
    if (!current || !lib || libraryBlocked) return "処理が完了してから編集してください。";
    try {
      // 部品は文書の文字スタイルを参照できないため、選んだ範囲の文字スタイルは同じ見た目の個別指定にしてから登録する。
      const source = textStylePaths(current.history.present, path).reduce((document, at) => editDocument(document, { type: "nodeTextStyle", path: at, name: undefined, detach: true }, blocks, current.locks, lib.history.present), current.history.present);
      // 選んだ要素は同じ ID のインスタンスになるため、選択はそのまま新しいインスタンスを指す。
      const created = createComponentFromNode(source, path, lib.history.present, { name, kind }, blocks, current.locks);
      replaceLibrary({ ...lib, history: commitLibrary(lib.history, created.library) }); replace({ ...current, history: commitHistory(current.history, created.document) });
      setNotice(""); setFieldEpoch((value) => value + 1); return undefined;
    } catch (error) { return componentProblem(error) ?? message(error); }
  }
  function submitComponentDialog(dialog: ComponentDialogState, values: { name: string; kind: ComponentKind }): string | undefined {
    const problem = dialog.type === "create" ? createComponent(dialog.path, values.name, values.kind)
      : dialog.type === "rename" ? updateLibrary((library) => renameComponent(library, dialog.componentId, values.name, blocks))
      : dialog.type === "remove" ? updateLibrary((library) => removeComponent(library, dialog.componentId, blocks)) : apply({ type: "detach", path: dialog.path });
    if (problem) return problem;
    setComponentDialog(null); setFieldEpoch((value) => value + 1);
    if (dialog.type === "remove" && dialog.componentId === masterId) resetMode();
    return undefined;
  }
  const reportProblem = (problem: string | undefined) => { if (problem) setNotice(problem); };
  const componentDialogNotice = componentDialog?.type === "create" && session && textStylePaths(session.history.present, componentDialog.path).length ? "テキストスタイルを使っている文字は、部品の中では同じ見た目の個別指定になります。" : undefined;
  function selectId(id: string) {
    const next = currentDocument();
    const path = next && walkNodes(next).find(({ node }) => node.type !== "text" && node.id === id)?.path;
    if (path) select(path);
  }
  function sharedUnitForCanvasNode(id: string) {
    const origin = canvasOrigins.get(id), context = localization.context;
    if (!origin || !context) return undefined;
    return context.collection.units.find((unit) => unit.scope === "shared-component" && unit.ownerId === origin.component && unit.field.startsWith(`node.${origin.node}.`));
  }
  function selectCanvas(_path: NodePath | null, id?: string, slot: string | null = null) {
    if (!id) { select(null); return; }
    const unit = sharedUnitForCanvasNode(id);
    if (unit) {
      if (manualInputPending && localizationManual?.unitId !== unit.unitId) { setNavigation({ type: "localization-unit", unitId: unit.unitId, canvasId: id }); return; }
      if (hasInput && localizationManual?.unitId !== unit.unitId) { setNotice("入力を適用するか取り消してから選択を変えてください。"); return; }
      setSelection(null); setSelectedCanvasNode(id); setSelectedLocalizationUnit(unit.unitId); setInspector("localization"); setDraft(null); return;
    }
    const raw = document && walkNodes(document).find(({ node }) => node.type !== "text" && node.id === id)?.path;
    if (raw) { if (manualInputPending) setNavigation({ type: "node", path: raw, canvasId: id }); else { select(raw, slot); setSelectedCanvasNode(id); } return; }
    const origin = canvasOrigins.get(id), instance = origin && document && walkNodes(document).find(({ node }) => node.type === "instance" && node.id === origin.instance)?.path;
    if (instance) { select(instance); if (targetMode) setSelectedCanvasNode(id); }
  }
  const canEditCanvasNode = (id: string) => !canvasOrigins.has(id) && !!document && walkNodes(document).some(({ node }) => node.type !== "text" && node.id === id);
  const editCanvasText = (_path: NodePath, id: string, children: PageNode[]) => {
    const raw = document && walkNodes(document).find(({ node }) => node.type !== "text" && node.id === id)?.path;
    if (!raw) return "共通部品の訳文は翻訳パネルで編集してください。";
    const problem = apply({ type: "replaceChildren", path: raw, children }); if (problem) setNotice(problem); return problem;
  };
  function makeNode(type: string): PageNode | undefined {
    const current = currentDocument(); if (!current) return undefined;
    // 部品の中の ID は展開後に <インスタンスID>--<ID> になるため短く保つ。
    const prefix = masterId ? "n" : "node_", used = new Set(walkNodes(current).flatMap(({ node }) => node.type === "text" ? [] : [node.id])); let counter = 1; while (used.has(`${prefix}${counter}`)) counter++;
    const id = `${prefix}${counter}`;
    if (type.startsWith("instance:")) {
      const component = type.slice(9), lib = libraryRef.current?.history.present;
      if (!lib?.components.some((item) => item.id === component) || placementProblem(lib, component, insertableBlocks, masterId)) return undefined;
      return { type: "instance", id, component };
    }
    if (type === "carousel" || type === "toggle") {
      const next = () => { while (used.has(`${prefix}${counter}`)) counter++; used.add(`${prefix}${counter}`); return `${prefix}${counter}`; };
      return type === "carousel" ? carouselPreset(next) : togglePreset(next);
    }
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
  function dropAt(item: DragItem, drop: Pick<DropPlace, "parentId" | "index">) {
    if (!document || hasInput || editBlocked) return;
    // 部品の編集中、外枠の外への配置は外枠の末尾へ置く。
    const root = master?.body[0], place = root?.type === "element" && drop.parentId === null ? { parentId: root.id, index: root.children.length } : drop;
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
    else { const next = currentDocument(); const parent = parentId && next ? walkNodes(next).find(({ node }) => node.type !== "text" && node.id === parentId) : undefined; select([...(parent?.path ?? []), index]); }
  }
  function applyAsset(asset: LibraryAsset, action: AssetAction): string | undefined {
    if (action === "pick" && picker?.purpose === "siteOgImage") { const problem = chooseSiteCover(siteSettings, asset); if (!problem) setPicker(null); return problem; }
    const current = currentDocument();
    if (!current || editBlocked) return "処理が完了してから配置してください。";
    if (targetMode && action !== "pick" && action !== "replace") return "共通デザインは原文側で編集してください。";
    if (hasInput) return "入力を確定するか取り消してから配置してください。";
    const target = action === "pick" ? (picker?.purpose === "siteOgImage" ? null : picker) : action === "insert" ? { purpose: "insert" as const, selection } : selection && (action === "replace" ? { purpose: "image" as const, path: selection } : { purpose: "background" as const, path: selection, breakpoint: tier });
    if (!target) return "配置先の要素を選択してください。";
    try {
      const placement = assetPlacement(current, asset, target), error = apply(placement.operation);
      if (error) return error;
      setPicker(null); if (placement.notice) setNotice(placement.notice);
      if (placement.select) { setSelection(placement.select); setInspector("element"); setDraft(null); }
      return undefined;
    } catch (error) { return message(error); }
  }
  function applyLocalizationAsset(asset: LibraryAsset): string | undefined {
    const context = localization.context, unit = context?.collection.units.find((entry) => entry.unitId === localizationAssetUnit);
    if (!context || !unit || unit.kind !== "asset") return "翻訳する画像の欄を確認できません。";
    if (unit.field === "meta.ogImage.src") {
      const problem = socialImageProblem(asset);
      if (problem) return problem;
    }
    const entry = context.overlay.entries.find((item) => item.unitId === unit.unitId);
    void runLocalizationCommand({ action: "set-value", target: context.target, unitId: unit.unitId, value: { kind: "asset", asset: { provider: asset.provider, id: asset.id } },
      sourceFingerprint: unit.sourceFingerprint, expectedEntryVersion: entry?.version ?? 0, expectedSourceVersion: context.sourceVersion, expectedVersion: context.version, expectedOverlayVersion: context.overlay.version });
    setLocalizationAssetUnit(null); return undefined;
  }
  const siblingCount = document && selection ? selection.length === 1 ? document.body.length : (nodeAt(document, selection.slice(0, -1)) as { children: PageNode[] }).children.length : 0;
  const palette = [
    { type: "section", name: "セクション", glyph: "▤", group: "構造" }, { type: "box", name: "ボックス", glyph: "□", group: "構造" },
    { type: "text", name: "テキスト", glyph: "T", group: "文字" }, { type: "h2", name: "見出し", glyph: "H", group: "文字" },
    { type: "richtext", name: "リッチテキスト", glyph: "¶", group: "文字" }, { type: "a", name: "リンク", glyph: "↗", group: "文字" },
    { type: "img", name: "画像", glyph: "▧", group: "メディア" },
    { type: "carousel", name: "カルーセル", glyph: "⇆", group: "インタラクション" }, { type: "toggle", name: "トグル（開閉）", glyph: "▾", group: "インタラクション" }
  ];
  const availableBlocks = Object.entries(blocks).filter(([key]) => !insertableBlocks || insertableBlocks.includes(key));
  const startDrag = (event: React.DragEvent<HTMLElement>, item: DragItem) => {
    if (!document || hasInput || editBlocked || targetMode) { event.preventDefault(); return; }
    dragItem.current = item; event.dataTransfer.effectAllowed = item.kind === "node" ? "move" : "copy";
    event.dataTransfer.setData("text/plain", item.kind === "palette" ? item.type : item.id);
  };
  async function runLocalizationCommand(command: import("./editor-types.js").EditorLocalizationCommand): Promise<EditorLocalizationCommandOutcome> {
    const current = sessionRef.current, context = localization.context;
    const activeManual = command.action === "set-value" && manualInputPending && localizationManual?.unitId === command.unitId && sameTarget(localizationManual.target, command.target);
    if (!adapter.localization || !current || current.readOnly || !context || !sameTarget(context.target, current.target) || dirty || libraryDirty || pageInputPending || manualInputPending && !activeManual || action.current) return "failed";
    const controller = new AbortController(); action.current = controller; setBusy("翻訳状態を更新中"); setNotice("");
    try {
      const result = await adapter.localization.command(command, controller.signal);
      if (controller.signal.aborted) return "failed";
      if (result.status === "conflict") { setNotice("翻訳状態が競合しました（409）。編集内容は保持されています。最新状態を読み込んで再試行してください。"); localization.reloadAll(); return "conflict"; }
      if (result.status !== "applied") throw new Error("invalid localization command result");
      if (!result.version || result.version === context.version) throw new Error("version must advance");
      localization.reloadPage(); localization.reloadSite();
      if (command.action === "adopt-candidate" || command.action === "set-value") await load(current.target, { preserveView: true });
      setNotice(command.action === "request-translation" ? "翻訳を依頼しました。" : command.action === "adopt-candidate" ? "翻訳案を採用しました。確認済みにはしていません。" : command.action === "set-value" ? "訳文を手修正しました。確認済みにはしていません。" : "現在の訳を現在の原文に対して確認済みにしました。");
      return "applied";
    } catch { if (!controller.signal.aborted) setNotice("翻訳状態を更新できませんでした。入力は保持されています。再試行してください。"); return "failed"; }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }
  async function requestSiteTranslation() {
    const currentSite = localization.site;
    if (!adapter.localization?.requestSiteTranslation || !currentSite || dirty || libraryDirty || hasInput || action.current) return;
    const targetLocale = currentSite.config.enabledLocales.find((locale) => locale !== currentSite.config.sourceLocale); if (!targetLocale) return;
    const controller = new AbortController(); action.current = controller; setBusy("サイト翻訳を依頼中"); setNotice("");
    try {
      const result = await adapter.localization.requestSiteTranslation({ siteId: currentSite.config.siteId, targetLocale, expectedVersion: currentSite.version }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "conflict") { setNotice("サイトの翻訳状態が競合しました（409）。最新状態を読み込んで再試行してください。"); localization.reloadSite(); return; }
      if (result.status !== "applied") throw new Error("invalid localization command result");
      if (!result.version || result.version === currentSite.version) throw new Error("version must advance");
      localization.reloadSite(); localization.reloadPage(); setNotice("サイト全体の翻訳を依頼しました。");
    } catch { if (!controller.signal.aborted) setNotice("サイト全体の翻訳を依頼できませんでした。再試行してください。"); }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }
  const selectLocale = (locale: LocalizationLocale) => {
    const current = sessionRef.current, currentSite = localization.site; if (!current || !currentSite) return;
    if (locale === selectedLocale) return;
    // 訳文のCASは保存済みの原文＋部品versionに結び付く。未保存の部品を表示用sourceとして持ち込まない。
    if (libraryDirty) { setNotice("共通部品の変更を保存してから言語を切り替えてください。"); return; }
    requestNavigation({ type: "page", target: { siteId: current.target.siteId, pageId: current.target.pageId, locale: documentLocaleFor(currentSite.config, locale) } });
  };
  const panelLocale = selectedLocale ?? localization.site?.config.sourceLocale;
  const panelPages: readonly EditorPage[] = localization.site && panelLocale ? localization.site.pages.map(({ locales, ...page }) => ({
    ...page, locale: documentLocaleFor(localization.site!.config, panelLocale), ...(locales[panelLocale]?.published === undefined ? {} : { published: locales[panelLocale]!.published })
  })) : pages;
  const site = sites.find((site) => site.id === siteId), page = session ? panelPages.find((page) => page.pageId === session.target.pageId) ?? pages.find((page) => page.pageId === session.target.pageId) : undefined;
  const pageOperations = !!adapter.preparePageChange && !!adapter.applyPageChange, unsaved = dirty || hasInput;
  const pageOperationsDisabled = unsaved || blocked || !!navigation || !site || historyMode || targetMode || !!session?.readOnly;
  const startPageChange = (start: PageChangeStart) => { if (pageOperations && !pageOperationsDisabled) setPageChange(start); };
  const status = saveStatus({ busy, hasInput, problem, dirty: pendingChanges, online, autosave: autosaveActive, savedAt, loaded: !!session });
  const recoveryStale = !!recoveryState.offer && !!session && recoveryState.offer.baseVersion !== session.version;
  const viewed = versions.viewing?.entry, viewedRelease = viewed && (viewed.kind === "publish" || viewed.kind === "rollback") && session?.releases.some((release) => release.revision === viewed.revision) ? viewed.revision : undefined;
  const activeHistory = masterId ? library?.history : session?.history;
  const publishHold = libraryDirty ? "部品の変更を保存してから公開を確認してください。" : masterId ? "ページに戻ってから公開を確認してください。" : session?.hasSavedDraft === false ? "文字や画像を編集し、下書きを保存してから公開・復元を確認してください。" : undefined;
  const rawSelected = document && selection ? nodeAt(document, selection) : undefined;
  const rawSelectedOwner = document && rawSelected?.type === "text" && selection && selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : rawSelected;
  const canvasSelectedNodeId = selectedCanvasNode ?? (rawSelectedOwner && rawSelectedOwner.type !== "text" ? rawSelectedOwner.id : undefined);
  const localizationGate = localization.supported && !localizationReady ? localization.siteState === "loading" || localization.pageState === "loading"
    ? "言語設定と翻訳状態を読み込み中です。完了するまで編集・保存・公開はできません。"
    : "言語設定または翻訳状態を確認できません。編集内容を保持したまま停止しています。再試行してください。" : "";
  return <div className={`nw-editor${preview ? " is-preview" : ""}`}><style dangerouslySetInnerHTML={{ __html: editorCss + pagesCss + styleEditorCss + historyCss + localizationEditorCss }} />
    {assets && <style dangerouslySetInnerHTML={{ __html: assetEditorCss }} />}
    <header className="e-toolbar" ref={(element) => { if (element) element.inert = modal; }}><div className="e-title"><strong className="e-brand">NIHO <span>Web</span></strong><span className="e-crumb">{sites.find((site) => site.id === siteId)?.name ?? "サイト"} / {panelPages.find((page) => page.pageId === session?.target.pageId)?.title ?? "ページ編集"}</span></div>
      {localization.site && selectedLocale && <LanguageSelector config={localization.site.config} locale={selectedLocale} disabled={blocked} select={selectLocale} />}
      <SaveStatus {...status} retry={() => void save()} compare={() => setConflictView((value) => value + 1)} retryDisabled={blocked || hasInput || historyMode || !localizationReady} compareDisabled={targetMode || !!busy || hasInput || historyMode || !localizationReady} />
      {autosaveMs !== undefined && <AutosaveSwitch on={autosaveOn} set={setAutosaveOn} />}
      <button onClick={() => travel("undo")} disabled={!activeHistory?.past.length || blocked || hasInput || historyMode || !localizationReady || !!session?.readOnly && !masterId}>元に戻す</button>
      <button onClick={() => travel("redo")} disabled={!activeHistory?.future.length || blocked || hasInput || historyMode || !localizationReady || !!session?.readOnly && !masterId}>やり直す</button>
      {versions.supported && <button aria-pressed={versions.open} onClick={versions.toggle} disabled={!session || preview || !!masterId || targetMode}>履歴</button>}
      <button aria-pressed={preview} onClick={() => setPreview((value) => !value)} disabled={!document || blocked || historyMode}>{preview ? "編集に戻る" : "プレビュー"}</button>
      <button onClick={() => void save()} disabled={!pendingChanges || blocked || hasInput || historyMode || !localizationReady || !!session?.readOnly && !libraryDirty}>下書き保存</button>
      {targetMode ? localePublication ? <button className="e-primary" title={session?.readOnly?.reason ?? "この言語の全ページと共通内容をまとめて確認します"} onClick={() => void prepareLocaleRelease("publish")}
        disabled={!localeRelease || localeReleaseLoading || !session || !!session.readOnly || dirty || libraryDirty || !!masterId || blocked || hasInput || historyMode || !localizationReady}>言語全体の公開確認</button>
        : <button className="e-primary" title="このサイトでは訳文の公開を利用できません。管理者に確認してください。" disabled>公開前の確認</button>
        : <button className="e-primary" title={session?.readOnly?.reason ?? publishHold} onClick={() => void prepare("publish")} disabled={!session || !!session.readOnly || session.hasSavedDraft === false || dirty || libraryDirty || !!masterId || blocked || hasInput || historyMode || !localizationReady}>公開前の確認</button>}
      {publishHold && !targetMode && <small className="e-hold">{publishHold}</small>}
      {targetMode && !localePublication && <small className="e-hold">このサイトでは訳文の公開を利用できません。管理者に確認してください。</small>}
    </header>
    {notice && <div className="e-notice" role="alert">{notice}</div>}
    {session?.readOnly && <div className="e-readonly" role="status"><div><strong>{targetMode ? "この言語（読み取り専用）" : "原文（読み取り専用）"}</strong><span>{session.readOnly.reason}</span></div>{session.readOnly.editUrl && <a className="e-small" href={session.readOnly.editUrl} {...(/^https:\/\//iu.test(session.readOnly.editUrl) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{session.readOnly.editLabel ?? (targetMode ? "正本の編集画面を開く" : "原文の編集画面を開く")}</a>}</div>}
    {components && libraryFailed && <div className="e-notice" role="alert">共通部品を読み込めませんでした。部品を含むページは表示できません。</div>}
    {localizationGate && <div className="e-localization-gate" role={localization.siteState === "error" || localization.pageState === "error" ? "alert" : "status"}><span>{localizationGate}</span><button type="button" className="e-small" disabled={localization.siteState === "loading" || localization.pageState === "loading"} onClick={localization.reloadAll}>再試行</button></div>}
    <div className="e-body" ref={(element) => { if (element) element.inert = modal; }}><aside className="e-rail e-left" aria-label="サイト・ページ・レイヤー">
      <nav className="e-tools" aria-label="編集ツール">{([
        ["add", "追加", "＋"], ["pages", "ページ", "▤"], ["layers", "レイヤー", "▦"], ["styles", "スタイル", "◐"], ["assets", "素材", "▧"], ["components", "部品", "◇"]
      ] as const).map(([key, name, glyph]) => { const common = targetMode && ["add", "styles", "components"].includes(key); return <button key={key} type="button" aria-pressed={visiblePanel === key} title={common ? "共通デザインは原文側で編集" : name} disabled={common} onClick={() => { setPicker(null); setPanel(key); }}><span aria-hidden="true">{glyph}</span><small>{name}</small></button>; })}</nav>
      <div className="e-panel">
        <section hidden={visiblePanel !== "add"} aria-label="要素を追加"><div className="e-panel-head"><h2>追加</h2><p>クリックで追加、ドラッグで配置</p></div>
          {targetMode && <p className="e-help">共通デザインは原文側で編集してください。</p>}{["構造", "文字", "メディア", "インタラクション"].map((group) => <div key={group}><h3>{group}</h3><div className="e-palette">{palette.filter((item) => item.group === group).map((item) => <button type="button" key={item.type} draggable={!!document && !editBlocked && !hasInput && !targetMode} onDragStart={(event) => startDrag(event, { kind: "palette", type: item.type })} onDragEnd={() => { dragItem.current = null; }} onClick={() => add(item.type)} disabled={!document || editBlocked || hasInput || targetMode}><span aria-hidden="true">{item.glyph}</span>{item.name}</button>)}</div></div>)}
          <details><summary>挿入先と詳細</summary><label className="e-field"><span>追加・移動先</span><select aria-label="追加・移動先" value={parentId} disabled={editBlocked || hasInput || targetMode} onChange={(event) => setParentId(event.target.value)}>{!masterId && <option value="">ページ直下</option>}{entries.filter(({ node }) => node.type === "element" && !["img", "source", "br", "hr"].includes(node.tag)).map(({ node }) => node.type === "element" && <option key={node.id} value={node.id}>{node.tag} · {node.id}</option>)}</select></label>
            <label className="e-field"><span>追加する要素</span><select aria-label="追加する要素" value={addType} onChange={(event) => setAddType(event.target.value)} disabled={editBlocked || targetMode}><option value="p">段落</option><option value="h2">見出し</option><option value="section">セクション</option><option value="box">ボックス</option><option value="richtext">リッチテキスト</option><option value="a">リンク</option><option value="img">画像</option><option value="text">テキスト</option>{availableBlocks.map(([key, block]) => <option key={key} value={`block:${key}`}>{block.label ?? key}</option>)}</select></label>
            <button onClick={() => add()} disabled={!document || editBlocked || hasInput || targetMode}>要素を追加</button></details>
        </section>
        <section hidden={visiblePanel !== "pages"} aria-label="ページ一覧">
          <PagePanel pages={panelPages} {...(localization.site ? { localizedPages: localization.site.pages } : {})} current={session?.target} disabled={blocked} operations={pageOperations} operationsDisabled={pageOperationsDisabled} unsaved={unsaved}
            select={(target) => { if (!session || !sameTarget(session.target, target)) requestNavigation({ type: "page", target }); }} start={startPageChange}>
            <label className="e-field"><span>編集するサイト</span><select aria-label="編集するサイト" value={siteId} disabled={blocked} onChange={(event) => requestNavigation({ type: "site", id: event.target.value })}>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
            {localization.site && adapter.localization?.requestSiteTranslation && <button type="button" className="e-small" disabled={blocked || unsaved || libraryDirty || localization.site.job?.state === "queued" || localization.site.job?.state === "running"} onClick={() => void requestSiteTranslation()}>{localization.site.job?.state === "failed" ? "サイト全体の翻訳を再試行" : "サイト全体を翻訳"}</button>}
            {localization.site?.job && localization.site.job.state !== "idle" && <p className={`e-help${localization.site.job.state === "failed" ? " e-problem" : ""}`} role={localization.site.job.state === "failed" ? "alert" : "status"}>{localization.site.job.state === "queued" ? "サイト全体の翻訳を待機中です。" : localization.site.job.state === "running" ? "サイト全体を翻訳中です。" : `サイト全体の翻訳に失敗しました。${localization.site.job.message ? ` ${localization.site.job.message}` : ""}`}</p>}
            {localization.site?.job && ["queued", "running", "failed"].includes(localization.site.job.state) && <button type="button" className="e-small" disabled={blocked || unsaved} onClick={localization.reloadAll}>翻訳状況を更新</button>}
            {localization.supported && !localization.site && !localization.siteBusy && <button type="button" className="e-small" onClick={localization.reloadAll}>言語設定を再読込</button>}
          </PagePanel>
          <button className="e-small" onClick={() => requestNavigation({ type: "reload" })} disabled={!session || blocked}>最新の文書を再読込</button>
        </section>
        <section hidden={visiblePanel !== "layers"} aria-label="レイヤー一覧"><div className="e-panel-head"><h2>レイヤー</h2><p>ドラッグで並べ替え、中央にも配置できます</p></div>
          <button className="e-layer" aria-pressed={!selection} onClick={() => select(null)} disabled={masterId ? libraryBlocked : pageOperationalBlocked}>{masterId ? "部品全体" : "ページ全体"}</button>
          {targetMode && <p className="e-help">構造・配置は共通です。共通デザインは原文側で編集してください。</p>}<div className="e-layer-list">{entries.map(({ node, path }) => <button key={path.join(".")} type="button" className={`e-layer${layerDrop?.id === (node.type === "text" ? "" : node.id) ? ` drop-${layerDrop.position}` : ""}${node.type !== "text" && hiddenAt(node, width) ? " is-hidden-here" : ""}`} style={{ paddingLeft: 12 + (path.length - 1) * 13 }} aria-pressed={selection?.join(".") === path.join(".")} title={label(node, blocks, names)} onClick={() => select(path)} disabled={masterId ? libraryBlocked : pageOperationalBlocked} draggable={node.type !== "text" && !editBlocked && !hasInput && !targetMode}
            onDragStart={(event) => { if (node.type !== "text") startDrag(event, { kind: "node", id: node.id }); }} onDragEnd={() => { dragItem.current = null; setLayerDrop(null); }}
            onDragOver={(event) => { if (!dragItem.current || node.type === "text") return; const place = layerPlace(event, node.id); if (!place) return; event.preventDefault(); event.dataTransfer.dropEffect = dragItem.current.kind === "node" ? "move" : "copy"; setLayerDrop({ id: node.id, position: place.position }); }}
            onDrop={(event) => { if (!dragItem.current || node.type === "text") return; const place = layerPlace(event, node.id); if (place) { event.preventDefault(); dropAt(dragItem.current, place); } dragItem.current = null; setLayerDrop(null); }}>{partGlyph(node)}{label(node, blocks, names)}{node.type !== "text" && hiddenAt(node, width) && <small className="e-layer-hidden">この幅で非表示</small>}</button>)}</div>
          <label className="e-field"><span>移動先</span><select aria-label="移動先" value={parentId} disabled={editBlocked || hasInput || targetMode} onChange={(event) => setParentId(event.target.value)}>{!masterId && <option value="">ページ直下</option>}{entries.filter(({ node }) => node.type === "element" && ["div", "section", "article", "header", "footer", "main", "nav", "aside", "li", "figure", "blockquote"].includes(node.tag)).map(({ node }) => node.type === "element" && <option key={node.id} value={node.id}>{node.tag} · {node.id}</option>)}</select></label>
          <div className="e-actions"><button disabled={targetMode || !selection || editBlocked || hasInput} onClick={() => selection && structural({ type: "duplicate", path: selection })}>複製</button><button className="e-danger" disabled={targetMode || !selection || editBlocked || hasInput} onClick={() => selection && structural({ type: "remove", path: selection })}>削除</button>
            <button disabled={targetMode || !selection || selection.at(-1) === 0 || editBlocked || hasInput} onClick={() => moveBy(-1)}>上へ</button><button disabled={targetMode || !selection || selection.at(-1)! >= siblingCount - 1 || editBlocked || hasInput} onClick={() => moveBy(1)}>下へ</button>
            <button disabled={targetMode || !selection || editBlocked || hasInput} onClick={moveToEnd}>指定先の末尾へ</button>
          </div>
        </section>
        <section hidden={visiblePanel !== "styles"} aria-label="共通スタイル"><div className="e-panel-head"><h2>スタイル</h2><p>共通のカラーと文字スタイル</p></div>{targetMode ? <p className="e-help">共通デザインは原文側で編集してください。</p> : document ? <StyleLibrary document={document} selection={selection} apply={applyStyle} select={select} disabled={editBlocked} breakpoints={breakpoints} breakpoint={tier} until={until} preview={previewOperation} pending={pending} fieldKey={`${fieldEpoch}-library`} nodeLabel={(node) => label(node, blocks, names)} /> : <p className="e-help">ページを読み込むと、共通カラーとテキストスタイルを編集できます。</p>}</section>
        <section hidden={visiblePanel !== "assets"} aria-label="素材">{assets && session ? <AssetLibraryPanel key={session.target.siteId} adapter={assets} siteId={session.target.siteId} epoch={fieldEpoch} mode={picker || localizationAssetUnit ? "pick" : "library"} pickTitle={localizationAssetUnit === "page.meta.ogImage.src" ? "ソーシャルカバーを選ぶ" : localizationAssetUnit ? "共通部品・訳文の画像を選ぶ" : picker?.purpose === "background" ? "背景画像を選ぶ" : picker?.purpose === "replace" ? "置き換える画像を選ぶ" : picker?.purpose === "ogImage" || picker?.purpose === "siteOgImage" ? "ソーシャルカバーを選ぶ" : "画像を選ぶ"} localUsage={localUsage}
          actions={{ replace: !localizationAssetUnit && node?.type === "element" && node.tag === "img", background: !slotName && !localizationAssetUnit && !targetMode && (node?.type === "component" || node?.type === "instance" || node?.type === "element" && !["img", "source", "br", "hr"].includes(node.tag)), insert: !localizationAssetUnit && !targetMode && !!document }}
          disabledReason={editBlocked ? "処理が完了してから配置してください。" : hasInput ? "入力を確定するか取り消してから配置してください。" : undefined} onApply={(asset, action) => localizationAssetUnit ? applyLocalizationAsset(asset) : applyAsset(asset, action)} onClose={() => { setPicker(null); setLocalizationAssetUnit(null); }} onReplaceUsages={(asset) => setPicker({ purpose: "replace", from: { provider: asset.provider, id: asset.id } })} />
          : <><div className="e-panel-head"><h2>素材</h2><p>画像の選択と差し替え</p></div><p className="e-help">現在は画像を追加し、右側の「画像 URL」で指定できます。</p><button type="button" onClick={() => add("img")} disabled={!document || editBlocked || hasInput}>画像を追加</button></>}</section>
        <section hidden={visiblePanel !== "components"} aria-label="部品"><div className="e-panel-head"><h2>部品</h2><p>サイトで利用できる部品</p></div>
          {targetMode ? <p className="e-help">共通部品の構造は原文側で編集してください。訳文は右側の「翻訳」で編集できます。</p> : components && <><ComponentPanel library={libraryPresent} failed={libraryFailed} visible={visiblePanel === "components" && !preview} blocks={canvasBlocks} editing={masterId} usage={usageSummary} usageLoading={usage === undefined}

            insertableBlocks={insertableBlocks} canPlace={!!document && !editBlocked && !hasInput} disabled={libraryBlocked || hasInput} place={(id) => add(`instance:${id}`)}
            drag={(event, id) => startDrag(event, { kind: "palette", type: `instance:${id}` })} dragEnd={() => { dragItem.current = null; }} edit={(id) => openComponent(id)}
            rename={(id) => setComponentDialog({ type: "rename", componentId: id })} duplicate={(id) => reportProblem(updateLibrary((library) => duplicateComponent(library, id, blocks).library))}
            remove={(id) => setComponentDialog({ type: "remove", componentId: id })} /><h3>業務ブロック</h3></>}
          {!targetMode && (availableBlocks.length ? <div className="e-palette">{availableBlocks.map(([key, block]) => <button type="button" key={key} draggable={!!document && !editBlocked && !hasInput} onDragStart={(event) => startDrag(event, { kind: "palette", type: `block:${key}` })} onDragEnd={() => { dragItem.current = null; }} onClick={() => add(`block:${key}`)} disabled={!document || editBlocked || hasInput}><span aria-hidden="true">◇</span>{block.label ?? key}</button>)}</div> : <p className="e-help">{components ? "このサイトの業務ブロックはまだ登録されていません。" : "このサイトの部品はまだ登録されていません。"}</p>)}</section>
        {targetMode ? <details className="e-history"><summary>以前の言語全体版へ戻す</summary>{localePublication ? <><label className="e-field"><span>戻す言語全体版</span><select aria-label="戻す言語全体版" value={localeRollbackId} disabled={blocked || localeReleaseLoading || !!session?.readOnly} onChange={(event) => setLocaleRollbackId(event.target.value)}><option value="">版を選択</option>{localeRelease?.history.map((release) => <option key={release.releaseId} value={release.releaseId}>{release.label}（{release.pages}ページ）</option>)}</select></label>
          <button disabled={!localeRollbackId || !!session?.readOnly || dirty || libraryDirty || !!masterId || blocked || hasInput || historyMode || !localizationReady} onClick={() => void prepareLocaleRelease("rollback")}>言語全体の復元内容を確認</button><small className="e-help">{session?.readOnly?.reason ?? "ページ単位ではなく、当時のページ・共通部品・ナビ・スタイルをまとめて復元します。現在非公開のページは復元されません。"}</small></> : <small className="e-help">このサイトでは訳文の復元を利用できません。管理者に確認してください。</small>}</details>
          : <details className="e-history"><summary>公開済みの版に戻す</summary><label className="e-field"><span>戻す版</span><select aria-label="戻す版" value={rollbackRevision} disabled={blocked || !!session?.readOnly} onChange={(event) => setRollbackRevision(event.target.value)}><option value="">版を選択</option>{session?.releases.map((release) => <option key={release.revision} value={release.revision}>{release.label}</option>)}</select></label><button disabled={!rollbackRevision || !!session?.readOnly || session?.hasSavedDraft === false || dirty || libraryDirty || !!masterId || blocked || hasInput} onClick={() => void prepare("rollback")}>戻す内容を確認</button><small className="e-help">{session?.readOnly?.reason ?? "未保存の変更がある間は実行できません。"}</small>{publishHold && <small className="e-help">{publishHold}</small>}</details>}
      </div>
    </aside>
    <section className="e-canvas" aria-label="ライブプレビュー">{masterComponent && <ComponentBanner name={masterComponent.name} count={usageSummary?.get(masterComponent.id)?.rows.length} back={leaveComponent} />}<div className="e-canvas-tools"><div className="e-canvas-caption"><strong>{historyMode ? "版を表示中" : preview ? "プレビュー" : "キャンバス"}</strong><small>{historyMode ? "読み取り専用です" : preview ? "公開前の表示を確認" : "クリックで選択・ダブルクリックで文字編集"}</small></div>{resolvedAssets.failed && <button type="button" className="e-small" onClick={resolvedAssets.retry}>素材を再読み込み</button>}<label>表示幅 <select aria-label="表示幅" value={width} onChange={(event) => setWidth(Number(event.target.value))}>{[...new Set([320, 375, 768, 1280, 1440, width])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{({ 320: "小さいモバイル · ", 375: "モバイル · ", 768: "タブレット · ", 1280: "PC · ", 1440: "ワイド · " } as Record<number, string>)[value] ?? ""}{value}px</option>)}</select></label>{document && <span className="e-tier-note" title={`${tierName(shownTier)} の指定が効く幅です`}>表示中: {width}px（{shownTier.label} の段）</span>}{document && <button type="button" className="e-small e-motion-toggle" aria-pressed={motion || preview} disabled={preview} title={preview ? "プレビュー中は動きを再生します" : "登場や状態の変化の動きを再生します"}
        onClick={() => { setMotion((value) => !value); if (!motion) setReplay((value) => value + 1); }}>動きを再生</button>}</div>
      {recoveryState.offer && session && !session.readOnly && <RecoveryBanner offer={recoveryState.offer} stale={recoveryStale} disabled={!localizationReady || historyMode || (blocked && busy !== "保存中") || !!masterId} compare={() => setRecoveryCompare(true)}
        restore={() => { if (recoveryStale) setRecoveryCompare(true); else void restoreRecovered(); }} discard={recoveryState.discard} />}
      <div className="e-stage"><HistoryBar history={versions} restore={restoreRevision} {...(session?.readOnly ? { restoreBlocked: session.readOnly.reason } : {})} rollbackHint={session?.readOnly ? session.readOnly.reason : session?.hasSavedDraft === false ? publishHold : dirty || libraryDirty || hasInput ? "未保存の変更を保存してから公開版を戻せます。" : blocked ? "処理が完了してから操作できます。" : undefined}
        rollback={session?.readOnly || session?.hasSavedDraft === false || viewedRelease === undefined ? undefined : () => { versions.exit(); setRollbackRevision(String(viewedRelease)); void prepare("rollback", viewedRelease); }} />
{document && shown && renderedCanvas && localizationReady ? <Canvas key={`${document.siteId}/${document.pageId}/${document.locale}/${masterId ?? ""}`} document={shown} rendered={renderedCanvas} origins={canvasOrigins} openInstance={openInstance} blocks={canvasBlocks} width={width} breakpoint={tier} selection={targetMode ? null : historyMode ? null : selection} {...(!historyMode && canvasSelectedNodeId ? { selectedNodeId: canvasSelectedNodeId } : {})} slot={historyMode ? null : slotName} select={selectCanvas} canEditNode={canEditCanvasNode} dragItem={dragItem} drop={dropAt} pending={pending} editText={editCanvasText} resize={(path, width, height) => applyStyle({ type: "resize", path, breakpoint: tier, width, height, ...(until === undefined ? {} : { until }) })} reportError={setNotice} editable={!editBlocked && !hasInput} structureEditable={!editBlocked && !hasInput && !targetMode} locks={locks} preview={preview || historyMode} assets={resolvedAssets.map} replay={`${replay}-${preview}`}
        motionCss={canvasCss(renderedCanvas, { forceState: !preview && !historyMode && styleState !== "normal" && node && node.type !== "text" ? { nodeId: node.id, state: styleState } : undefined, motion: (preview || motion) && !historyMode ? "play" : "paused" })} /> : <p className="e-empty">{localizationGate || "サイトとページを選ぶと、ここにプレビューを表示します。"}</p>}</div></section>
    <aside className="e-rail e-right" aria-label="インスペクタ">{versions.open ? <VersionPanel history={versions} status={status.text} snapshotBlock={!session || busy ? "" : session.readOnly ? session.readOnly.reason : dirty || hasInput ? "スナップショットは保存済みの状態にだけ作成できます。" : historyMode ? "版の表示を閉じてから作成できます。" : undefined} /> : <><div className="e-inspector-tabs" role="tablist" aria-label="設定の種類"><button type="button" role="tab" aria-selected={inspector === "element"} disabled={!node} onClick={() => requestInspector("element")}>要素</button><button type="button" role="tab" aria-selected={inspector === "page"} onClick={() => requestInspector("page")}>{masterId ? "部品" : "ページ"}</button><button type="button" role="tab" aria-selected={inspector === "site"} onClick={() => requestInspector("site")}>サイト</button>{targetMode && <button type="button" role="tab" aria-selected={inspector === "localization"} onClick={() => requestInspector("localization")}>翻訳</button>}</div>
      {inspector === "site" && <section className="e-inspector-content">{targetMode ? <p className="e-help">サイト共通設定とデザインは原文側で編集してください。</p> : <SiteSettingsPanel site={site} state={siteSettings} cover={assets ? { assets: resolvedAssets.map, failed: resolvedAssets.failed, pick: () => setPicker({ purpose: "siteOgImage" }) } : undefined} />}</section>}
      {inspector === "localization" && localization.context && document && <section className="e-inspector-content"><LocalizationPanel context={localization.context} document={document} disabled={blocked || !!session?.readOnly || dirty || libraryDirty || pageInputPending || !localizationReady} selectedUnit={selectedLocalizationUnit} run={runLocalizationCommand} refresh={localization.reloadAll} manualBuffer={localizationManual} setManualBuffer={setLocalizationManual} pickAsset={(unit) => { setPicker(null); setLocalizationAssetUnit(unit.unitId); }} /></section>}
      {inspector === "page" && !masterComponent && <section className="e-inspector-content">{document && <PageSettings document={document} page={page} site={site} settings={siteSettings} field={field} apply={apply} report={setNotice} disabled={editBlocked} targetMode={targetMode}
        cover={assets ? { assets: resolvedAssets.map, failed: resolvedAssets.failed, pick: () => setPicker({ purpose: "ogImage" }) } : undefined}

        operations={pageOperations} operationsDisabled={pageOperationsDisabled} unsaved={unsaved} start={startPageChange} />}</section>}
      {inspector === "page" && masterComponent && <ComponentSettings component={masterComponent} usage={usageSummary?.get(masterComponent.id)} usageLoading={usage === undefined} field={input} disabled={libraryBlocked || hasInput}
        rename={(name) => updateLibrary((library) => renameComponent(library, masterComponent.id, name, blocks))} setKind={(kind) => reportProblem(updateLibrary((library) => setComponentKind(library, masterComponent.id, kind, blocks)))}
        unpublish={(name) => reportProblem(updateLibrary((library) => setComponentProp(library, masterComponent.id, name, undefined, blocks)))} back={leaveComponent} />}
      {inspector === "element" && <section className="e-inspector-content">{slotName && node?.type === "component" && selection && document ? <BlockSlotInspector key={`${pathKey}-slot-${slotName}`} document={document} node={node} path={selection} slot={slotName} blocks={blocks}
        saved={masterId ? savedMaster : session?.saved} back={() => chooseSlot(null)} apply={apply} preview={previewOperation} reason={reason} notify={setNotice} input={input}
        style={{ tiers, tier, setTier: setBreakpoint, range, setRange, width, setWidth, pending, fieldKey: `${pathKey}-slot-${slotName}`, disabled: editBlocked, tierLocked: hasInput }} /> : <><h2>{partGlyph(node)}{node ? label(node, blocks, names) : "要素を選択してください"}</h2>
      {node?.type === "text" && selection && field("テキスト", node.text, (value) => ({ type: "text", path: selection, value }), "text", { multiline: true, reason: document ? lockReason(document, selection, "text", locks) : undefined })}
      {node?.type === "element" && selection && <>{["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.tag) && <label className="e-field"><span>文字の種類</span><select aria-label="文字の種類" value={node.tag} disabled={targetMode || editBlocked || !!reason("tag")} onChange={(event) => { const problem = apply({ type: "tag", path: selection, value: event.target.value as "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }); if (problem) setNotice(problem); }}><option value="p">段落</option><option value="h1">見出し 1</option><option value="h2">見出し 2</option><option value="h3">見出し 3</option><option value="h4">見出し 4</option><option value="h5">見出し 5</option><option value="h6">見出し 6</option></select>{targetMode && <small className="e-help">共通デザインは原文側で編集してください。</small>}</label>}{node.children.length === 1 && node.children[0]?.type === "text" && field("テキスト", node.children[0].text, (value) => ({ type: "text", path: [...selection, 0], value }), "child-text", { multiline: true, reason: document ? lockReason(document, [...selection, 0], "text", locks) : undefined })}
        {node.tag === "img" && (assets ? <ImageSourceField node={node} assets={resolvedAssets.map} failed={resolvedAssets.failed} lock={reason("attrs.src") ?? reason("asset")} disabled={editBlocked} onPick={() => setPicker({ purpose: "image", path: selection })}>
          {field("画像 URL", node.asset ? "" : String(node.attrs?.src ?? ""), (value) => ({ type: "image", path: selection, source: { src: value } }), "attrs.src", { reason: reason("attrs.src") })}</ImageSourceField>
          : field("画像 URL", String(node.attrs?.src ?? ""), (value) => ({ type: "image", path: selection, source: { src: value } }), "attrs.src", { reason: reason("attrs.src") }))}
        {node.tag === "img" && !node.asset && field("レスポンシブ画像 URL", String(node.attrs?.srcSet ?? ""), (value) => ({ type: "image", path: selection, source: { src: String(node.attrs?.src ?? ""), ...(value ? { srcset: value } : {}) } }), "attrs.srcSet", { reason: reason("attrs.srcSet") })}
        {[...(node.tag === "a" ? [["href", "リンク先 URL"]] : []), ...(node.tag === "img" ? [["alt", "画像の説明"]] : [])].map(([name, caption]) => field(caption!, String(node.attrs?.[name!] ?? ""), (value) => ({ type: "attribute", path: selection, name: name!, value }), `attrs.${name}`, { reason: reason(`attrs.${name}`) }))}</>}
      {node?.type === "component" && selection && <><p className="e-help">表示用 props のみ編集できます。データ連動値はホストが管理します。</p>{Object.entries(blocks[node.block]!.props).map(([name, rule]) => {
        const locked = reason(`props.${name}`), value = node.props[name];
        const localizedLock = targetMode && localization.context ? localizedOperationProblem(document!, { type: "prop", path: selection, name, value }, localization.context.collection) : undefined;
        if (rule.type === "boolean") return <label className="e-check" key={`${pathKey}-prop-${name}`}><input type="checkbox" checked={value === true} disabled={editBlocked || !!locked || !!localizedLock} onChange={(event) => { const error = apply({ type: "prop", path: selection, name, value: event.target.checked }); if (error) setNotice(error); }} />{name}{(locked || localizedLock) && <small className="e-help">{locked ? `ロック: ${locked}` : localizedLock}</small>}</label>;
        if (rule.type === "enum") return <label className="e-field" key={`${pathKey}-prop-${name}`}><span>{name}</span><select aria-label={name} value={String(value ?? "")} disabled={editBlocked || !!locked || !!localizedLock} onChange={(event) => { const error = apply({ type: "prop", path: selection, name, value: event.target.value || undefined }); if (error) setNotice(error); }}><option value="">{rule.required ? "選択してください" : "未指定"}</option>{rule.values.map((option) => <option key={option}>{option}</option>)}</select>{(locked || localizedLock) && <small className="e-help">{locked ? `ロック: ${locked}` : localizedLock}</small>}</label>;
        return field(name, String(value ?? ""), (input) => ({ type: "prop", path: selection, name, value: input === "" && !rule.required ? undefined : rule.type === "number" ? Number(input) : input }), `prop.${name}`, { reason: locked });
      })}<BlockSlotList slots={blocks[node.block]!.slots} choose={chooseSlot} disabled={editBlocked} focus={slotBack} /></>}
      {node?.type === "instance" && selection && libraryPresent && <InstanceInspector instance={node} definition={libraryPresent.components.find((component) => component.id === node.component)} usage={usageText(usageSummary?.get(node.component), usage === undefined)}
        staleProps={staleProps} field={input} disabled={editBlocked || hasInput || targetMode}
        edit={() => openComponent(node.component)} detach={() => setComponentDialog({ type: "detach", path: selection })} setValue={(name, value) => apply({ type: "instanceProp", path: selection, name, value })}
        clean={() => reportProblem(apply(staleProps.map((name): EditorOperation => ({ type: "instanceProp", path: selection, name, value: undefined }))))} />}
      {node?.type === "element" && selection && libraryPresent && (masterComponent ? <MasterPropFields component={masterComponent} node={node} field={input} disabled={libraryBlocked || hasInput}
        toggle={(name, exposed) => reportProblem(updateLibrary((library) => exposeComponentProp(library, masterComponent.id, node.id, name, exposed, blocks)))} relabel={(name, value) => updateLibrary((library) => relabelComponentProp(library, masterComponent.id, name, value, blocks))} />
        : !targetMode && <CreateComponentSection disabled={libraryBlocked || hasInput} reason={reason("*")} open={() => setComponentDialog({ type: "create", path: selection })} />)}
      {node && node.type !== "text" && selection && document && <StyleInspector key={pathKey} document={document} saved={masterId ? savedMaster : session?.saved} node={node} path={selection} blocks={blocks} tiers={tiers} tier={tier} setTier={setBreakpoint} range={range} setRange={setRange}
        width={width} setWidth={setWidth} apply={apply} preview={previewOperation} pending={pending} fieldKey={pathKey} disabled={editBlocked || targetMode} tierLocked={hasInput} reason={reason} notify={setNotice} styleState={styleState} setStyleState={setStyleState}
        appearanceExtra={assets && (node.type !== "element" || !["img", "source", "br", "hr"].includes(node.tag)) && <BackgroundImageField key={`${pathKey}-${tier}-background`} declarations={tier === "base" ? node.style?.base : node.style?.responsive?.find((entry) => entry.minWidth === tier)?.declarations} assets={resolvedAssets.map}
          lock={(property) => reason(tier === "base" ? `style.base.${property}` : "style.responsive")} disabled={editBlocked} onPick={() => setPicker({ purpose: "background", path: selection, breakpoint: tier })}
          onClear={() => { const error = apply({ type: "background", path: selection, breakpoint: tier, asset: undefined }); if (error) setNotice(error); }} onStyle={(property, value) => { const error = apply({ type: "style", path: selection, breakpoint: tier, property, value }); if (error) setNotice(error); }} />} />}
      </>}</section>}
    </>}</aside></div>
    {navigation && <Dialog name="未保存の変更" dismiss={() => setNavigation(null)}><h2>未保存の変更があります</h2><p>移動・再読込すると、保存前の変更と入力途中の値を破棄します。</p><div className="e-actions"><button autoFocus onClick={() => setNavigation(null)}>編集を続ける</button><button className="e-danger" onClick={() => { if (session && ["site", "page", "reload"].includes(navigation.type)) recoveryState.drop(session.target); navigate(navigation); }}>変更を破棄して移動</button>
      {(dirty || navigation.type === "site" && libraryDirty) && !hasInput && !historyMode && (navigation.type === "site" || navigation.type === "page" || navigation.type === "reload") && !(navigation.type === "site" && siteSettings.dirty) && <button className="e-primary" onClick={() => void saveAndNavigate(navigation)}>保存して移動</button>}</div></Dialog>}
    {plan && <Dialog name="公開前の対象と差分" dismiss={() => { if (!busy) setPlan(null); }}><h2>{plan.action === "rollback" ? `版 ${plan.revision} に戻す前の確認` : "公開前の確認"}</h2><p>反映先のドメイン</p><p className="e-domain">{plan.domain}</p><p>{session?.target.pageId} · {session?.target.locale}</p>
      <ReleaseSearchSummary document={pageDocument} page={page} domain={plan.domain} settings={siteSettings.settings} rollback={plan.action === "rollback"} url={plan.url} /><ReleaseAffected affected={releaseAffected(plan.affected, pageDocument, libraryPresent)} /><table><thead><tr><th>変更箇所</th><th>現在の公開内容</th><th>反映する内容</th></tr></thead><tbody>{plan.changes.length ? plan.changes.map((change, index) => <tr key={index}><td>{change.path}</td><td>{change.before}</td><td>{change.after}</td></tr>) : <tr><td colSpan={3}>内容の差分はありません。</td></tr>}</tbody></table>
      <label className="e-check"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={(event) => setConfirmed(event.target.checked)} />このドメインと差分を確認し、反映する内容に同意しました</label>
      <div className="e-actions"><button autoFocus disabled={!!busy} onClick={() => setPlan(null)}>編集に戻る</button><button className="e-primary" disabled={!confirmed || !!busy} onClick={() => void release()}>{plan.action === "rollback" ? "この版に戻す" : "この内容を公開"}</button></div>
    </Dialog>}
    {localeReleasePlan && <Dialog name="言語全体の公開前確認" dismiss={() => { if (!busy) setLocaleReleasePlan(null); }}><h2>{localeReleasePlan.action === "rollback" ? "言語全体を復元する前の確認" : "言語全体を公開する前の確認"}</h2>
      <p>反映先のドメイン</p><p className="e-domain">{localeReleasePlan.domain}</p>
      <dl className="e-rows"><div><dt>言語</dt><dd>{localeReleasePlan.locale === "ja" ? "日本語" : "English"}</dd></div><div><dt>現在の公開版</dt><dd>{localeReleasePlan.previous ? `${localeReleasePlan.previous.label} / ${localeReleasePlan.previous.version}` : "未公開"}</dd></div><div><dt>準備した版</dt><dd>{localeReleasePlan.prepared.label} / {localeReleasePlan.prepared.version}</dd></div><div><dt>確認期限</dt><dd>{new Date(localeReleasePlan.expiresAt).toLocaleString("ja-JP")}</dd></div></dl>
      {localeReleasePlan.action === "rollback" && <p className="e-help">現在非公開のページは復元されません。</p>}
      {localeReleasePlan.incompleteReasons.length > 0 && <div role="alert" className="e-release-incomplete"><strong>この言語はまだ公開できません。</strong><ul>{localeReleasePlan.incompleteReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
      <h3>対象ページ（{localeReleasePlan.pages.length}件）</h3><table><thead><tr><th>ページ</th><th>URL</th><th>準備状況</th></tr></thead><tbody>{localeReleasePlan.pages.map((page) => <tr key={page.pageId}><td>{page.title}</td><td>{page.path}</td><td>{page.complete ? "完了" : page.reasons.join("\n") || "未完了"}</td></tr>)}</tbody></table>
      <h3>共通内容（{localeReleasePlan.sharedResources.length}件）</h3><table><thead><tr><th>共通内容</th><th>種類</th><th>準備状況</th></tr></thead><tbody>{localeReleasePlan.sharedResources.map((resource) => <tr key={resource.id}><td>{resource.label}</td><td>{({ component: "共通部品", navigation: "ナビ", style: "スタイル", resource: "関連データ" } as const)[resource.kind]}</td><td>{resource.complete ? "完了" : resource.reasons.join("\n") || "未完了"}</td></tr>)}</tbody></table>
      <label className="e-check"><input type="checkbox" checked={localeReleaseConfirmed} disabled={!!busy || !localeReleasePlan.complete} onChange={(event) => setLocaleReleaseConfirmed(event.target.checked)} />このドメイン、全ページ、共通内容と公開版の切り替えに同意しました</label>
      <div className="e-actions"><button autoFocus disabled={!!busy} onClick={() => setLocaleReleasePlan(null)}>編集に戻る</button><button className="e-primary" disabled={!localeReleasePlan.complete || !localeReleaseConfirmed || !!busy} onClick={() => void applyLocaleRelease()}>{localeReleasePlan.action === "rollback" ? "この言語全体版を復元" : "この言語全体を公開"}</button></div>
    </Dialog>}
    {componentDialog && libraryPresent && <Dialog name={componentDialogTitle(componentDialog)} dismiss={() => setComponentDialog(null)}>
      <ComponentDialogBody dialog={componentDialog} library={libraryPresent} cancel={() => setComponentDialog(null)} submit={(values) => submitComponentDialog(componentDialog, values)} notice={componentDialogNotice} /></Dialog>}
    {pageChange && site && adapter.preparePageChange && adapter.applyPageChange && <PageChangeDialog start={pageChange} site={site} pages={pages} locale={session?.target.locale ?? pages[0]?.locale ?? siteSettings.settings?.locale ?? "ja"}
      prepare={(change, signal) => adapter.preparePageChange!(change, signal)} apply={(plan, signal) => adapter.applyPageChange!(plan, signal)}
      applied={(page, change) => void pageApplied(page, change)} conflicted={() => void reloadPages()} close={() => setPageChange(null)}
      reload={() => { const current = sessionRef.current?.target; setPageChange(null); void reloadPages().then(() => current && load(current)); }} />}
    {conflictView > 0 && session && pageDocument && <ConflictDialog key={conflictView} adapter={adapter} target={session.target} present={pageDocument} blocks={blocks} components={libraryPresent} close={() => setConflictView(0)} discard={loadLatest} overwrite={overwriteWith} />}
    {recoveryCompare && recoveryState.offer && pageDocument && <RecoveryCompareDialog base={pageDocument} baseLabel={dirty ? "現在の編集内容" : "保存済みの内容"} recovered={recoveryState.offer} stale={recoveryStale} close={() => setRecoveryCompare(false)} apply={restoreRecovered} />}
    <HistoryDialogs history={versions} present={pageDocument} />
  </div>;
}
