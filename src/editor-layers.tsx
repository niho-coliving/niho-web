import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { projectLayers, visibleLayers, type LayerEntry, type LayerLabels } from "./layers.js";
import type { PageDocument } from "./types.js";

function LayerGlyph({ kind }: { kind: LayerEntry["kind"] }) {
  return <svg className="e-layer-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
    {kind === "text" ? <><path d="M3 4h10M8 4v8M5.5 12h5" /></> : kind === "image" ? <><rect x="2.5" y="3" width="11" height="10" rx="1" /><circle cx="6" cy="6.5" r="1" /><path d="m3.5 11 3-2.5 2 1.5 2-2 2 2" /></> : kind === "component" || kind === "instance" ? <><path d="m5 2.5 3 3-3 3-3-3 3-3Zm6 5 3 3-3 3-3-3 3-3Z" /><path d="M8 5.5h3v2M5 8.5v2h3" /></> : <rect x="2.5" y="2.5" width="11" height="11" rx="1" />}
  </svg>;
}

export type LayerTreePanelProps = {
  document: PageDocument;
  labels?: LayerLabels;
  rootLabel: string;
  selectedId: string | null;
  disabled?: boolean;
  draggable?: boolean;
  trailing?: (entry: LayerEntry) => ReactNode;
  className?: (entry: LayerEntry) => string;
  select: (id: string | null) => void;
  dragStart?: (event: DragEvent<HTMLElement>, id: string) => void;
  dragEnd?: () => void;
  dragOver?: (event: DragEvent<HTMLElement>, id: string) => void;
  drop?: (event: DragEvent<HTMLElement>, id: string) => void;
};

/** ID を正本にした、折りたたみ・keyboard・DnD 共通レイヤーツリー。 */
export function LayerTreePanel({ document, labels, rootLabel, selectedId, disabled = false, draggable = false, trailing, className, select, dragStart, dragEnd, dragOver, drop }: LayerTreePanelProps) {
  const entries = useMemo(() => projectLayers(document, labels), [document, labels]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(entries.filter((entry) => entry.hasChildren).map((entry) => entry.id)));
  const [focusId, setFocusId] = useState<string | null>(selectedId);
  const known = useRef(new Set(entries.map((entry) => entry.id))), refs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const previous = known.current, addedParents = entries.filter((entry) => entry.hasChildren && !previous.has(entry.id)).map((entry) => entry.id);
    known.current = new Set(entries.map((entry) => entry.id));
    if (addedParents.length) setExpanded((current) => new Set([...current, ...addedParents]));
  }, [entries]);
  useEffect(() => {
    if (!selectedId) { setFocusId(null); return; }
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const)), ancestors: string[] = [];
    let current = byId.get(selectedId)?.parentId ?? null;
    while (current) { ancestors.push(current); current = byId.get(current)?.parentId ?? null; }
    if (ancestors.length) setExpanded((value) => ancestors.every((id) => value.has(id)) ? value : new Set([...value, ...ancestors]));
    setFocusId(selectedId);
  }, [selectedId, entries]);
  const visible = visibleLayers(entries, expanded), order = [null, ...visible.map((entry) => entry.id)] as (string | null)[];
  // effect が state を直す前の描画にも、必ず可視行を1つ roving tab stop にする。
  const visibleFocusId = focusId !== null && visible.some((entry) => entry.id === focusId) ? focusId : null;
  useEffect(() => {
    if (focusId === null || visible.some((entry) => entry.id === focusId)) return;
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const)), shown = new Set(visible.map((entry) => entry.id));
    let fallback = byId.get(focusId)?.parentId ?? null;
    while (fallback && !shown.has(fallback)) fallback = byId.get(fallback)?.parentId ?? null;
    setFocusId(fallback);
  }, [entries, visible, focusId]);
  const focus = (id: string | null) => { setFocusId(id); queueMicrotask(() => refs.current.get(id ?? "__root__")?.focus()); };
  const descendantOf = (id: string, ancestor: string) => {
    const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
    let parent = byId.get(id)?.parentId ?? null;
    while (parent) { if (parent === ancestor) return true; parent = byId.get(parent)?.parentId ?? null; }
    return false;
  };
  const toggle = (id: string, open?: boolean) => {
    const value = open ?? !expanded.has(id);
    if (!value && selectedId && descendantOf(selectedId, id)) { select(id); focus(id); }
    setExpanded((current) => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; });
  };
  function keys(event: KeyboardEvent<HTMLElement>, entry: LayerEntry | null) {
    const id = entry?.id ?? null, index = order.indexOf(id);
    if (["ArrowUp", "ArrowDown", "Home", "End", "ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) event.preventDefault(); else return;
    if (event.key === "ArrowUp") focus(order[Math.max(0, index - 1)] ?? null);
    else if (event.key === "ArrowDown") focus(order[Math.min(order.length - 1, index + 1)] ?? null);
    else if (event.key === "Home") focus(null);
    else if (event.key === "End") focus(order.at(-1) ?? null);
    else if (event.key === "Enter" || event.key === " ") select(id);
    else if (event.key === "ArrowRight" && entry?.hasChildren) {
      if (!expanded.has(entry.id)) toggle(entry.id, true); else focus(visible.find((item) => item.parentId === entry.id)?.id ?? entry.id);
    } else if (event.key === "ArrowLeft" && entry) {
      if (entry.hasChildren && expanded.has(entry.id)) toggle(entry.id, false); else focus(entry.parentId);
    }
  }
  return <div className="e-layer-list" role="tree" aria-label="ページのレイヤー">
    <div data-layer-key="root" className="e-layer-row">
      <button ref={(node) => { if (node) refs.current.set("__root__", node); else refs.current.delete("__root__"); }} type="button" role="treeitem" aria-level={1} aria-selected={selectedId === null} className="e-layer e-layer-root" aria-pressed={selectedId === null} tabIndex={visibleFocusId === null ? 0 : -1} onClick={() => { setFocusId(null); select(null); }} onKeyDown={(event) => keys(event, null)} disabled={disabled}>{rootLabel}</button>
    </div>
    {visible.map((entry) => <div key={entry.id} data-node-id={entry.id} data-layer-kind={entry.kind}
      className={`e-layer-row${className ? className(entry) : ""}`} style={{ paddingLeft: entry.depth * 13 }} draggable={draggable}
      onDragStart={(event) => dragStart?.(event, entry.id)} onDragEnd={dragEnd} onDragOver={(event) => dragOver?.(event, entry.id)} onDrop={(event) => drop?.(event, entry.id)}>
      {entry.hasChildren ? <button type="button" className="e-layer-toggle" aria-label={`${entry.label}を${expanded.has(entry.id) ? "閉じる" : "開く"}`} tabIndex={-1} onClick={() => toggle(entry.id)} disabled={disabled}>{expanded.has(entry.id) ? "⌄" : ">"}</button> : <span className="e-layer-toggle-placeholder" aria-hidden="true" />}
      <button ref={(node) => { if (node) refs.current.set(entry.id, node); else refs.current.delete(entry.id); }} type="button" role="treeitem" aria-level={entry.depth + 2} aria-selected={selectedId === entry.id} {...(entry.hasChildren ? { "aria-expanded": expanded.has(entry.id) } : {})} className="e-layer" aria-pressed={selectedId === entry.id} tabIndex={visibleFocusId === entry.id ? 0 : -1} title={entry.label} onClick={() => { setFocusId(entry.id); select(entry.id); }} onKeyDown={(event) => keys(event, entry)} disabled={disabled}>
        <LayerGlyph kind={entry.kind} /><span className="e-layer-label">{entry.label}</span>{trailing?.(entry)}
      </button>
    </div>)}
  </div>;
}
