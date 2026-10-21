"use client";

import type { KeyboardEvent, ReactNode } from "react";

export type WorkspaceScale = "fit" | 0.25 | 0.5 | 0.75 | 1 | 1.5 | 2;

/** The shared three-column presentation shell. Hosts supply content through named slots. */
export function EditorWorkspace({ preview, leftOpen, rightOpen, chrome, left, canvas, right, dialogs, setBody }: {
  preview: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  chrome?: ReactNode;
  left: ReactNode;
  canvas: ReactNode;
  right: ReactNode;
  dialogs?: ReactNode;
  setBody?: (element: HTMLDivElement | null) => void;
}) {
  return <div className={`nw-editor${preview ? " is-preview" : ""}`}>
    {chrome}
    <div className={`e-body${leftOpen ? "" : " is-left-closed"}${rightOpen ? "" : " is-right-closed"}`} ref={setBody}>
      {left}{canvas}{right}
    </div>
    {dialogs}
  </div>;
}

type IconName = "back" | "close" | "desktop" | "tablet" | "mobile" | "undo" | "redo" | "history" | "preview" | "save" | "publish" | "leftPanel" | "rightPanel";

export function WorkspaceIcon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<IconName, ReactNode> = {
    back: <><path d="m14.5 5-7 7 7 7" /><path d="M8 12h11" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    desktop: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    tablet: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M11 18h2" /></>,
    mobile: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>,
    undo: <><path d="M9 7 4 12l5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" /></>,
    redo: <><path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" /></>,
    history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" /><path d="M4 4v4.6h4.6M12 8v4l3 2" /></>,
    preview: <path d="m8 5 11 7-11 7V5Z" />,
    save: <><path d="M5 3h12l2 2v16H5z" /><path d="M8 3v6h8V3M8 16h8" /></>,
    publish: <><path d="M12 3v12M7 8l5-5 5 5" /><path d="M5 13v8h14v-8" /></>,
    leftPanel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    rightPanel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>
  };
  return <svg className="e-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...common}>{paths[name]}</svg>;
}

export function PanelToggle({ side, open, onClick }: { side: "left" | "right"; open: boolean; onClick: () => void }) {
  const name = side === "left" ? "左パネル" : "右パネル";
  return <button type="button" className="e-panel-toggle" aria-label={`${name}を${open ? "閉じる" : "開く"}`} title={`${name}を${open ? "閉じる" : "開く"}`} aria-pressed={open} onClick={onClick}>
    <WorkspaceIcon name={side === "left" ? "leftPanel" : "rightPanel"} />
  </button>;
}

export type WorkspaceTab<T extends string> = { value: T; label: string };

export function InspectorTabs<T extends string>({ tabs, active, disabled, onChange }: {
  tabs: readonly WorkspaceTab<T>[];
  active: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const chooseByKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
    const next = tabs[nextIndex]; if (next) onChange(next.value);
  };
  return <div className="e-inspector-tabs" role="tablist" aria-label="要素の編集パネル">{tabs.map(({ value, label }, index) => <button key={value} type="button" role="tab" id={`e-inspector-tab-${value}`} aria-controls="e-inspector-panel" aria-selected={active === value} tabIndex={active === value ? 0 : -1} disabled={disabled}
    onClick={() => onChange(value)} onKeyDown={(event) => chooseByKey(event, index)}>{label}</button>)}</div>;
}

export function WorkspaceScaleSelect({ scale, fitPercent, onScale }: { scale: WorkspaceScale; fitPercent: number; onScale: (value: WorkspaceScale) => void }) {
  return <label className="e-zoom-field"><span className="e-vh">表示倍率</span><select aria-label="表示倍率" value={String(scale)} onChange={(event) => onScale(event.target.value === "fit" ? "fit" : Number(event.target.value) as WorkspaceScale)}>
    <option value="fit">全体 {fitPercent}%</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option>
  </select></label>;
}

export function CanvasViewportToolbar({ width, widthField, leftOpen, rightOpen, disabled, onWidthInput, onWidthCommit, toggleLeft, toggleRight, children }: {
  width: number;
  widthField: string;
  leftOpen: boolean;
  rightOpen: boolean;
  disabled?: boolean;
  onWidthInput: (value: string) => void;
  onWidthCommit: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  children?: ReactNode;
}) {
  const preset = (value: number, icon: "desktop" | "tablet" | "mobile", label: string) => <button type="button" className="e-device-button" aria-label={`${label} ${value}px`} title={`${label} ${value}px`} aria-pressed={width === value} disabled={disabled}
    onClick={() => { onWidthInput(String(value)); }}><WorkspaceIcon name={icon} /></button>;
  return <div className="e-canvas-tools" role="toolbar" aria-label="キャンバス表示">
    {!leftOpen && <PanelToggle side="left" open={false} onClick={toggleLeft} />}
    <label className="e-width-field"><span className="e-vh">表示幅</span><input aria-label="表示幅" type="number" min={320} max={1920} step={1} value={widthField} disabled={disabled} onChange={(event) => onWidthInput(event.target.value)} onBlur={onWidthCommit} /><span>px</span></label>
    <div className="e-device-group" role="group" aria-label="デバイス幅">{preset(1280, "desktop", "PC")}{preset(768, "tablet", "タブレット")}{preset(375, "mobile", "モバイル")}</div>
    {children}
    {!rightOpen && <PanelToggle side="right" open={false} onClick={toggleRight} />}
  </div>;
}
