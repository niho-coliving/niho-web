"use client";

import { Component, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PageRenderer } from "./react.js";
import { parsePageDocument } from "./document.js";
import { pageScope } from "./css.js";
import { DocumentValidationError } from "./validation-utils.js";
import { acceptSavedRevision, commitHistory, editDocument, effectiveLocks, fingerprint, lockReason, newElement, nodeAt, sameTarget, travelHistory, validateReleasePlan, walkNodes, type EditorHistory, type EditorOperation, type NodePath } from "./editor-model.js";
import { editorCss } from "./editor-style.js";
import type { EditorBlockRegistry, EditorLock, EditorPage, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorSnapshot, EditorTarget, PageEditorProps } from "./editor-types.js";
import type { ElementTag, PageDocument, PageNode, StyleProperty, StyleValue } from "./types.js";

export type * from "./editor-types.js";
const emptyBlocks: EditorBlockRegistry = {};
type Session = { target: EditorTarget; history: EditorHistory; version: string; saved: string; locks: readonly EditorLock[]; releases: NonNullable<EditorSnapshot["releases"]> };
type Navigation = { type: "site"; id: string } | { type: "page"; target: EditorTarget } | { type: "reload" };
const message = (error: unknown) => error instanceof DocumentValidationError ? "文書のルールに合いません。URL・単位・親要素を確認してください。" : error instanceof Error ? error.message : "入力を適用できません。";
const conflict = (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 409;
const label = (node: PageNode, blocks: EditorBlockRegistry) => node.type === "text" ? `文字: ${node.text.slice(0, 24) || "（空）"}` : node.type === "component" ? `${blocks[node.block]?.label ?? node.block} · ${node.id}` : `${node.tag} · ${node.id}`;
function sessionFrom(snapshot: EditorSnapshot, target: EditorTarget, blocks: EditorBlockRegistry): Session {
  const document = parsePageDocument(snapshot.document, blocks);
  if (!sameTarget(document, target) || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("読込対象が一致しません。");
  return { target, history: { past: [], present: document, future: [] }, version: snapshot.version, saved: fingerprint(document), locks: snapshot.locks ?? [], releases: snapshot.releases ?? [] };
}

function Field({ name, value, apply, pending, fieldKey, disabled = false, reason, multiline = false, placeholder }: {
  name: string; value: string; apply: (value: string) => string | undefined; pending: (key: string, value: boolean) => void; fieldKey: string;
  disabled?: boolean; reason?: string | undefined; multiline?: boolean; placeholder?: string | undefined;
}) {
  const [buffer, setBuffer] = useState(value), [error, setError] = useState("");
  const inputId = useId();
  useEffect(() => { setBuffer(value); setError(""); pending(fieldKey, false); }, [value, fieldKey, pending]);
  useEffect(() => () => pending(fieldKey, false), [fieldKey, pending]);
  function commit() {
    if (buffer === value || disabled || reason) return;
    const problem = apply(buffer); setError(problem ?? ""); pending(fieldKey, !!problem);
  }
  const props = { id: inputId, value: buffer, disabled: disabled || !!reason, placeholder, "aria-invalid": !!error,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setBuffer(event.target.value); setError(""); pending(fieldKey, event.target.value !== value); },
    onBlur: commit };
  return <label className="e-field" htmlFor={inputId}><span>{name}</span>
    {multiline ? <textarea {...props} /> : <input {...props} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />}
    {reason && <small className="e-help">ロック: {reason}</small>}
    {error && <small className="e-help e-problem" role="alert">{error}</small>}
    {buffer !== value && <button className="e-small" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setBuffer(value); setError(""); pending(fieldKey, false); }}>入力を取り消す</button>}
  </label>;
}

function Dialog({ name, children, dismiss }: { name: string; children: ReactNode; dismiss: () => void }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { const previous = window.document.activeElement; return () => { if (previous && "focus" in previous && typeof previous.focus === "function") previous.focus(); }; }, []);
  return <div className="e-dialog-backdrop"><section ref={root} className="e-dialog" role="dialog" aria-modal="true" aria-label={name} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); dismiss(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(root.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]"));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
  }}>{children}</section></div>;
}

class PreviewBoundary extends Component<{ document: PageDocument; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: { document: PageDocument }) { if (previous.document !== this.props.document && this.state.failed) this.setState({ failed: false }); }
  render() { return this.state.failed ? <p role="alert">ブロックのプレビューを表示できません。レイヤーから編集を続けられます。</p> : this.props.children; }
}
function Canvas({ document, blocks, width, selection, select }: { document: PageDocument; blocks: EditorBlockRegistry; width: number; selection: NodePath | null; select: (path: NodePath | null) => void }) {
  const [body, setBody] = useState<HTMLElement | null>(null), frame = useRef<HTMLIFrameElement>(null);
  const scope = pageScope(document), entries = walkNodes(document);
  const selected = selection ? nodeAt(document, selection) : undefined;
  const selectedId = selected?.type === "text" && selection && selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : selected;
  return <><iframe ref={frame} title="ページのライブキャンバス" sandbox="allow-same-origin" style={{ width }}
    srcDoc={'<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"></body></html>'}
    onLoad={() => setBody(frame.current?.contentDocument?.body ?? null)} />
    {body && createPortal(<div onClickCapture={(event) => {
      event.preventDefault(); event.stopPropagation();
      const target = event.target as HTMLElement;
      const element = typeof target.closest === "function" ? target.closest(`[data-nw-owner="${scope}"][data-nw-node]`) : null;
      select(entries.find(({ node }) => node.type !== "text" && node.id === element?.getAttribute("data-nw-node"))?.path ?? null);
    }} onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <style>{`body{font-family:sans-serif;}[data-nw-node]{cursor:pointer;} ${selectedId && selectedId.type !== "text" ? `[data-nw-owner="${scope}"][data-nw-node="${selectedId.id}"]{outline:2px solid #198558!important;outline-offset:2px;}` : ""}`}</style>
      <PreviewBoundary document={document}><PageRenderer document={document} blocks={blocks} /></PreviewBoundary>
    </div>, body)}
  </>;
}

const styleGroups: [string, [property: StyleProperty, caption: string, choices?: readonly string[]][]][] = [
  ["色・文字", [["color", "文字色"], ["backgroundColor", "背景色"], ["fontFamily", "フォント"], ["fontSize", "文字サイズ"], ["fontWeight", "文字の太さ"], ["lineHeight", "行間"], ["textAlign", "文字揃え", ["left", "center", "right", "start", "end"]]]],
  ["サイズ・余白", [["width", "幅"], ["height", "高さ"], ["minWidth", "最小幅"], ["maxWidth", "最大幅"], ["minHeight", "最小高さ"], ["maxHeight", "最大高さ"], ["margin", "外側の余白"], ["padding", "内側の余白"], ["marginTop", "上の外余白"], ["marginBottom", "下の外余白"], ["paddingTop", "上の内余白"], ["paddingBottom", "下の内余白"], ["gap", "要素間の余白"]]],
  ["Flex・Grid", [["display", "配置方式", ["block", "flex", "grid", "inline", "inline-block", "inline-flex", "inline-grid", "none"]], ["flexDirection", "並ぶ向き", ["row", "column", "row-reverse", "column-reverse"]], ["flexWrap", "折り返し", ["nowrap", "wrap", "wrap-reverse"]], ["justifyContent", "主軸の配置", ["start", "end", "center", "flex-start", "flex-end", "space-between", "space-around", "space-evenly"]], ["alignItems", "交差軸の配置", ["start", "end", "center", "stretch", "baseline", "flex-start", "flex-end"]], ["flexGrow", "伸びる比率"], ["flexShrink", "縮む比率"], ["flexBasis", "基準サイズ"], ["gridTemplateColumns", "Grid の列"], ["gridTemplateRows", "Grid の行"], ["gridColumn", "Grid の列位置"], ["gridRow", "Grid の行位置"]]],
  ["位置・枠", [["position", "配置の基準", ["static", "relative", "absolute", "fixed", "sticky"]], ["top", "上から"], ["right", "右から"], ["bottom", "下から"], ["left", "左から"], ["zIndex", "重なり順"], ["borderColor", "枠の色"], ["borderWidth", "枠の太さ"], ["borderStyle", "枠線", ["none", "solid", "dashed", "dotted", "double"]], ["borderRadius", "角丸"], ["objectFit", "画像の収まり", ["fill", "contain", "cover", "none", "scale-down"]]]]
];
const styleText = (value: StyleValue | undefined) => value === undefined ? "" : typeof value === "object" ? `@${value.token}` : String(value);
const parseStyleText = (value: string): StyleValue | undefined => value === "" ? undefined : value.startsWith("@") ? { token: value.slice(1) } : /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : value;

/** 認証済みホストに接続する共通エディター。ネットワーク URL や秘密を所有しない。 */
export function PageEditor({ adapter, blocks = emptyBlocks }: PageEditorProps) {
  const [sites, setSites] = useState<readonly EditorSite[]>([]), [siteId, setSiteId] = useState("");
  const [pages, setPages] = useState<readonly EditorPage[]>([]), [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const [selection, setSelection] = useState<NodePath | null>(null), [width, setWidth] = useState(1280);
  const [fieldEpoch, setFieldEpoch] = useState(0);
  const [breakpoint, setBreakpoint] = useState<number | "base">("base"), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(""), [pendingFields, setPendingFields] = useState<Record<string, boolean>>({});
  const [navigation, setNavigation] = useState<Navigation | null>(null), [plan, setPlan] = useState<EditorReleasePlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [addType, setAddType] = useState("p"), [parentId, setParentId] = useState(""), [rollbackRevision, setRollbackRevision] = useState("");
  const request = useRef<AbortController | null>(null), action = useRef<AbortController | null>(null);
  const pending = useCallback((key: string, value: boolean) => setPendingFields((previous) => {
    if (!!previous[key] === value) return previous;
    const next = { ...previous }; if (value) next[key] = true; else delete next[key]; return next;
  }), []);
  const hasInput = Object.values(pendingFields).some(Boolean), dirty = !!session && fingerprint(session.history.present) !== session.saved;
  const blocked = !!busy || !!plan, editBlocked = blocked && busy !== "保存中";
  const replace = useCallback((next: Session | null) => { sessionRef.current = next; setSession(next); }, []);
  const load = useCallback(async (target: EditorTarget) => {
    const editorTarget: EditorTarget = { siteId: target.siteId, pageId: target.pageId, locale: target.locale };
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy("読込中"); setNotice("");
    try {
      const snapshot = await adapter.readDocument(editorTarget, controller.signal);
      if (controller.signal.aborted) return;
      replace(sessionFrom(snapshot, editorTarget, blocks)); setSelection(null); setFieldEpoch((value) => value + 1); setPendingFields({}); setPlan(null); setRollbackRevision(""); setParentId("");
    } catch { if (!controller.signal.aborted) setNotice("文書を読み込めませんでした。現在の編集内容は保持されています。"); }
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
    return () => { controller.abort(); request.current?.abort(); };
  }, [adapter, siteId, load, replace]);
  useEffect(() => () => { request.current?.abort(); action.current?.abort(); }, []);
  useEffect(() => {
    function prevent(event: BeforeUnloadEvent) { event.preventDefault(); }
    if (dirty || hasInput) window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, hasInput]);

  function navigate(next: Navigation) {
    setNavigation(null); setSelection(null); setFieldEpoch((value) => value + 1); setPendingFields({});
    if (next.type === "site") { replace(null); setSiteId(next.id); }
    else if (next.type === "page") void load(next.target);
    else if (sessionRef.current) void load(sessionRef.current.target);
  }
  function requestNavigation(next: Navigation) { if (blocked) return; if (dirty || hasInput) setNavigation(next); else navigate(next); }
  function select(path: NodePath | null) { if (hasInput) { setNotice("入力を適用するか取り消してから選択を変えてください。"); return; } if (!editBlocked) { setSelection(path); setBreakpoint("base"); } }
  function apply(operation: EditorOperation): string | undefined {
    const current = sessionRef.current; if (!current || editBlocked) return "処理が完了してから編集してください。";
    try {
      const document = editDocument(current.history.present, operation, blocks, current.locks);
      replace({ ...current, history: commitHistory(current.history, document) }); setNotice(""); return undefined;
    } catch (error) { return message(error); }
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
    } catch { if (!controller.signal.aborted) { setNotice("反映結果を確認できませんでした。再試行前に公開状態をホスト側で確認してください。編集内容は保持しています。"); setPlan(null); } }
    finally { if (!controller.signal.aborted) setBusy(""); action.current = null; }
  }

  const document = session?.history.present, entries = document ? walkNodes(document) : [];
  const node = document && selection ? nodeAt(document, selection) : undefined;
  const locks = document ? effectiveLocks(document, session?.locks ?? [], blocks) : [];
  const reason = (field: string) => document && selection ? lockReason(document, selection, field, locks) : undefined;
  const pathKey = `${fieldEpoch}-${selection?.join(".") ?? "page"}`;
  function field(name: string, value: string, operation: (value: string) => EditorOperation, key: string, options: { reason?: string | undefined; multiline?: boolean; placeholder?: string } = {}) {
    return <Field key={`${pathKey}-${key}`} name={name} value={value} fieldKey={`${pathKey}-${key}`} pending={pending} disabled={editBlocked}
      apply={(value) => apply(operation(value))} {...options} />;
  }
  function add() {
    if (!document || hasInput) return;
    const used = new Set(entries.flatMap(({ node }) => node.type === "text" ? [] : [node.id])); let counter = 1; while (used.has(`node_${counter}`)) counter++;
    const id = `node_${counter}`;
    let newNode: PageNode;
    if (addType === "text") newNode = { type: "text", text: "新しいテキスト" };
    else if (addType.startsWith("block:")) {
      const block = addType.slice(6), definition = blocks[block]!;
      const props = { ...definition.defaultProps };
      for (const [name, rule] of Object.entries(definition.props)) if (rule.required && props[name] === undefined) props[name] = rule.type === "boolean" ? false : rule.type === "number" ? Math.min(rule.max ?? Infinity, Math.max(rule.min ?? -Infinity, 0)) : rule.type === "enum" ? rule.values[0] ?? "" : rule.type === "url" ? "/" : "表示テキスト";
      newNode = { type: "component", id, block, props };
    } else newNode = newElement(addType as ElementTag, id);
    structural({ type: "add", parentId: parentId || null, node: newNode });
  }
  function moveBy(delta: number) {
    if (!document || !selection) return;
    const parent = selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : null;
    structural({ type: "move", path: selection, parentId: parent?.type === "element" ? parent.id : null, index: selection.at(-1)! + delta });
  }
  const siblingCount = document && selection ? selection.length === 1 ? document.body.length : (nodeAt(document, selection.slice(0, -1)) as { children: PageNode[] }).children.length : 0;
  return <div className="nw-editor"><style>{editorCss}</style>
    <header className="e-toolbar" ref={(element) => { if (element) element.inert = !!plan || !!navigation; }}><span className="e-brand">ページ編集</span>
      <span className="e-status" role="status">{busy || (hasInput ? "入力を確認中" : dirty ? "未保存の変更あり" : session ? "保存済み" : "文書を選択してください")}</span>
      <button onClick={() => travel("undo")} disabled={!session?.history.past.length || blocked || hasInput}>元に戻す</button>
      <button onClick={() => travel("redo")} disabled={!session?.history.future.length || blocked || hasInput}>やり直す</button>
      <button onClick={() => void save()} disabled={!dirty || blocked || hasInput}>下書き保存</button>
      <button className="e-primary" onClick={() => void prepare("publish")} disabled={!session || dirty || blocked || hasInput}>公開前の確認</button>
    </header>
    {notice && <div className="e-notice" role="alert">{notice}</div>}
    <div className="e-body" ref={(element) => { if (element) element.inert = !!plan || !!navigation; }}><aside className="e-rail e-left" aria-label="サイト・ページ・レイヤー">
      <h2>サイト</h2><label className="e-field"><span>編集するサイト</span><select aria-label="編集するサイト" value={siteId} disabled={blocked} onChange={(event) => requestNavigation({ type: "site", id: event.target.value })}>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <label className="e-field"><span>ページ</span><select aria-label="ページ" value={session ? `${session.target.pageId}/${session.target.locale}` : ""} disabled={blocked || !pages.length} onChange={(event) => { const page = pages.find((page) => `${page.pageId}/${page.locale}` === event.target.value); if (page) requestNavigation({ type: "page", target: page }); }}>
        {!session && <option value="">選択してください</option>}{pages.map((page) => <option key={`${page.pageId}/${page.locale}`} value={`${page.pageId}/${page.locale}`}>{page.title} · {page.locale}</option>)}
      </select></label>
      <button className="e-small" onClick={() => requestNavigation({ type: "reload" })} disabled={!session || blocked}>最新の文書を再読込</button>
      <h2>レイヤー</h2><button className="e-layer" aria-pressed={!selection} onClick={() => select(null)} disabled={editBlocked}>ページ全体</button>
      {entries.map(({ node, path }) => <button key={path.join(".")} className="e-layer" style={{ paddingLeft: 8 + (path.length - 1) * 12 }} aria-pressed={selection?.join(".") === path.join(".")} title={label(node, blocks)} onClick={() => select(path)} disabled={editBlocked}>{label(node, blocks)}</button>)}
      <h2>要素の操作</h2><label className="e-field"><span>追加・移動先</span><select aria-label="追加・移動先" value={parentId} disabled={editBlocked || hasInput} onChange={(event) => setParentId(event.target.value)}><option value="">ページ直下</option>{entries.filter(({ node }) => node.type === "element" && !["img", "source", "br", "hr"].includes(node.tag)).map(({ node }) => node.type === "element" && <option key={node.id} value={node.id}>{node.tag} · {node.id}</option>)}</select></label>
      <label className="e-field"><span>追加する要素</span><select aria-label="追加する要素" value={addType} onChange={(event) => setAddType(event.target.value)} disabled={editBlocked}><option value="p">段落</option><option value="h2">見出し</option><option value="section">セクション</option><option value="a">リンク</option><option value="img">画像</option><option value="text">テキスト</option>{Object.entries(blocks).map(([key, block]) => <option key={key} value={`block:${key}`}>{block.label ?? key}</option>)}</select></label>
      <button onClick={add} disabled={!document || editBlocked || hasInput}>要素を追加</button>
      <div className="e-actions"><button disabled={!selection || editBlocked || hasInput} onClick={() => selection && structural({ type: "duplicate", path: selection })}>複製</button><button className="e-danger" disabled={!selection || editBlocked || hasInput} onClick={() => selection && structural({ type: "remove", path: selection })}>削除</button>
        <button disabled={!selection || selection.at(-1) === 0 || editBlocked || hasInput} onClick={() => moveBy(-1)}>上へ</button><button disabled={!selection || selection.at(-1)! >= siblingCount - 1 || editBlocked || hasInput} onClick={() => moveBy(1)}>下へ</button>
        <button disabled={!selection || editBlocked || hasInput} onClick={() => { if (!document || !selection) return; const destination = parentId ? entries.find(({ node }) => node.type !== "text" && node.id === parentId)?.node : null; const count = destination?.type === "element" ? destination.children.length : document.body.length; const oldParent = selection.length > 1 ? nodeAt(document, selection.slice(0, -1)) : null; const sameParent = parentId === (oldParent?.type === "element" ? oldParent.id : ""); structural({ type: "move", path: selection, parentId: parentId || null, index: count - (sameParent ? 1 : 0) }); }}>指定先の末尾へ</button>
      </div>
      <details><summary>公開済みの版に戻す</summary><label className="e-field"><span>戻す版</span><select aria-label="戻す版" value={rollbackRevision} disabled={blocked} onChange={(event) => setRollbackRevision(event.target.value)}><option value="">版を選択</option>{session?.releases.map((release) => <option key={release.revision} value={release.revision}>{release.label}</option>)}</select></label><button disabled={!rollbackRevision || dirty || blocked || hasInput} onClick={() => void prepare("rollback")}>戻す内容を確認</button><small className="e-help">未保存の変更がある間は実行できません。</small></details>
    </aside>
    <section className="e-canvas" aria-label="ライブプレビュー"><div className="e-canvas-tools"><label>表示幅 <select aria-label="表示幅" value={width} onChange={(event) => setWidth(Number(event.target.value))}><option value="375">モバイル · 375px</option><option value="768">タブレット · 768px</option><option value="1280">デスクトップ · 1280px</option></select></label></div><div className="e-stage">{document ? <Canvas document={document} blocks={blocks} width={width} selection={selection} select={select} /> : <p className="e-empty">サイトとページを選ぶと、ここにプレビューを表示します。</p>}</div></section>
    <aside className="e-rail e-right" aria-label="インスペクタ"><h2>{node ? label(node, blocks) : "ページの設定"}</h2>
      {document && !node && field("ページタイトル", document.title, (value) => ({ type: "title", value }), "title")}
      {node?.type === "text" && selection && field("テキスト", node.text, (value) => ({ type: "text", path: selection, value }), "text", { multiline: true, reason: document ? lockReason(document, selection, "text", locks) : undefined })}
      {node?.type === "element" && selection && <>{node.children.length === 1 && node.children[0]?.type === "text" && field("テキスト", node.children[0].text, (value) => ({ type: "text", path: [...selection, 0], value }), "child-text", { multiline: true, reason: document ? lockReason(document, [...selection, 0], "text", locks) : undefined })}
        {[...(node.tag === "a" ? [["href", "リンク先 URL"]] : []), ...(node.tag === "img" ? [["src", "画像 URL"], ["alt", "画像の説明"]] : [])].map(([name, caption]) => field(caption!, String(node.attrs?.[name!] ?? ""), (value) => ({ type: "attribute", path: selection, name: name!, value }), `attrs.${name}`, { reason: reason(`attrs.${name}`) }))}</>}
      {node?.type === "component" && selection && <><p className="e-help">表示用 props のみ編集できます。データ連動値はホストが管理します。</p>{Object.entries(blocks[node.block]!.props).map(([name, rule]) => {
        const locked = reason(`props.${name}`), value = node.props[name];
        if (rule.type === "boolean") return <label className="e-check" key={`${pathKey}-prop-${name}`}><input type="checkbox" checked={value === true} disabled={editBlocked || !!locked} onChange={(event) => { const error = apply({ type: "prop", path: selection, name, value: event.target.checked }); if (error) setNotice(error); }} />{name}{locked && <small className="e-help">ロック: {locked}</small>}</label>;
        if (rule.type === "enum") return <label className="e-field" key={`${pathKey}-prop-${name}`}><span>{name}</span><select aria-label={name} value={String(value ?? "")} disabled={editBlocked || !!locked} onChange={(event) => { const error = apply({ type: "prop", path: selection, name, value: event.target.value || undefined }); if (error) setNotice(error); }}><option value="">{rule.required ? "選択してください" : "未指定"}</option>{rule.values.map((option) => <option key={option}>{option}</option>)}</select>{locked && <small className="e-help">ロック: {locked}</small>}</label>;
        return field(name, String(value ?? ""), (input) => ({ type: "prop", path: selection, name, value: input === "" && !rule.required ? undefined : rule.type === "number" ? Number(input) : input }), `prop.${name}`, { reason: locked });
      })}</>}
      {node && node.type !== "text" && selection && <><label className="e-field"><span>編集する幅</span><select aria-label="編集する幅" value={breakpoint} disabled={editBlocked || hasInput} onChange={(event) => setBreakpoint(event.target.value === "base" ? "base" : Number(event.target.value))}><option value="base">共通</option>{[...new Set([375, 768, 1280, ...(node.style?.responsive?.map((entry) => entry.minWidth) ?? [])])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value}px 以上</option>)}</select></label><small className="e-help">空欄にするとこの幅の指定を解除します。数値のサイズは px、トークンは @名前 で指定できます。</small>
        {styleGroups.map(([group, properties]) => <details key={group} open={group === "色・文字"}><summary>{group}</summary>{properties.map(([property, caption, choices]) => {
          const values = breakpoint === "base" ? node.style?.base : node.style?.responsive?.find((entry) => entry.minWidth === breakpoint)?.declarations;
          const value = styleText(values?.[property]), lock = reason(breakpoint === "base" ? `style.base.${property}` : "style.responsive");
          const operation = (input: string): EditorOperation => ({ type: "style", path: selection, breakpoint, property, value: parseStyleText(input) });
          if (choices) return <label key={`${pathKey}-${breakpoint}-${property}`} className="e-field"><span>{caption}</span><select aria-label={caption} value={value} disabled={editBlocked || !!lock} onChange={(event) => { const error = apply(operation(event.target.value)); if (error) setNotice(error); }}><option value="">指定なし</option>{choices.map((choice) => <option key={choice}>{choice}</option>)}</select>{lock && <small className="e-help">ロック: {lock}</small>}</label>;
          const placeholder = property.toLowerCase().includes("color") ? "例: #195640 / @ink" : property === "fontFamily" ? "例: sans-serif / @bodyFont" : property.startsWith("gridTemplate") ? "例: repeat(2, minmax(0, 1fr))" : "例: 16 / 1rem / @space";
          return field(caption, value, operation, `style-${breakpoint}-${property}`, { reason: lock, placeholder });
        })}</details>)}
      </>}
    </aside></div>
    {navigation && <Dialog name="未保存の変更" dismiss={() => setNavigation(null)}><h2>未保存の変更があります</h2><p>移動・再読込すると、保存前の変更と入力途中の値を破棄します。</p><div className="e-actions"><button autoFocus onClick={() => setNavigation(null)}>編集を続ける</button><button className="e-danger" onClick={() => navigate(navigation)}>変更を破棄して移動</button></div></Dialog>}
    {plan && <Dialog name="公開前の対象と差分" dismiss={() => { if (!busy) setPlan(null); }}><h2>{plan.action === "rollback" ? `版 ${plan.revision} に戻す前の確認` : "公開前の確認"}</h2><p>反映先のドメイン</p><p className="e-domain">{plan.domain}</p><p>{session?.target.pageId} · {session?.target.locale}</p><table><thead><tr><th>変更箇所</th><th>現在の公開内容</th><th>反映する内容</th></tr></thead><tbody>{plan.changes.length ? plan.changes.map((change, index) => <tr key={index}><td>{change.path}</td><td>{change.before}</td><td>{change.after}</td></tr>) : <tr><td colSpan={3}>内容の差分はありません。</td></tr>}</tbody></table>
      <label className="e-check"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={(event) => setConfirmed(event.target.checked)} />このドメインと差分を確認し、反映する内容に同意しました</label>
      <div className="e-actions"><button autoFocus disabled={!!busy} onClick={() => setPlan(null)}>編集に戻る</button><button className="e-primary" disabled={!confirmed || !!busy} onClick={() => void release()}>{plan.action === "rollback" ? "この版に戻す" : "この内容を公開"}</button></div>
    </Dialog>}
  </div>;
}
