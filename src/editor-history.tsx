"use client";

import { resolvePageStyles, type SiteStyles } from "./site-styles.js";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { changeLabels, hasRecoveredChanges, libraryChanges, mergeRecoveredLibrary, parseRecoveredLibrary, type LibraryMerge, type RecoveredLibrary } from "./component-session.js";
import { parsePageDocument } from "./document.js";
import { Dialog } from "./editor-dialog.js";
import { fingerprint, sameTarget } from "./editor-model.js";
import { Icon } from "./editor-pages.js";
import { diffDocuments, parseRevisionEntry, parseRevisionPage, RecoveryTooLargeError, type DocumentChange, type EditorRecoveryStore, type EditorRevisionEntry, type EditorRevisionKind } from "./history.js";
import type { EditorAdapter, EditorBlockRegistry, EditorReleaseAffected, EditorSnapshot, EditorTarget } from "./editor-types.js";
import type { ComponentLibrary, PageDocument } from "./types.js";

const pad = (value: number) => String(value).padStart(2, "0");
/** ja-JP の YYYY/MM/DD HH:MM（端末の時刻）。 */
export function formatDateTime(value: string | number | Date): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` : "";
}
const formatTime = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
export const revisionKindLabels: Readonly<Record<EditorRevisionKind, string>> = { draft: "下書き保存", autosave: "自動保存", snapshot: "スナップショット", publish: "公開", rollback: "公開版に戻す" };
export const targetKeyOf = (target: EditorTarget | undefined) => target ? JSON.stringify([target.siteId, target.pageId, target.locale]) : "";
const copyTarget = (target: EditorTarget): EditorTarget => ({ siteId: target.siteId, pageId: target.pageId, locale: target.locale });
const control = /[\u0000-\u001f\u007f]/u;
const silent = (task: () => void | Promise<void>) => { void Promise.resolve().then(task).catch(() => undefined); };

export type SaveProblem = "failed" | "conflict" | "library-conflict" | "auth" | "offline";
export const isOffline = () => typeof window !== "undefined" && window.navigator?.onLine === false;
/** 409 は競合、401/403 はログイン切れ、失敗時に navigator.onLine が false ならオフライン。 */
export function classifySaveError(error: unknown): SaveProblem {
  const status = error && typeof error === "object" && "status" in error ? (error as { status: unknown }).status : undefined;
  return status === 409 ? "conflict" : status === 401 || status === 403 ? "auth" : isOffline() ? "offline" : "failed";
}
export function autosaveDelay(option: boolean | { delayMs?: number } | undefined): number | undefined {
  if (!option) return undefined;
  const value = option === true ? 2000 : option.delayMs ?? 2000;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(60000, Math.max(100, Math.round(value))) : 2000;
}
/** 手動保存の文言は従来どおり。自動保存は次の操作を添える。 */
export function saveProblemNotice(problem: SaveProblem, auto: boolean, thrown: boolean): string {
  if (problem === "conflict") return auto ? "自動保存が競合しました（409）。編集内容を保持しています。「比較する」で最新の保存内容と見比べてください。"
    : thrown ? "保存が競合しました（409）。編集内容を保持しています。最新状態を確認してからやり直してください。" : "保存が競合しました（409）。編集内容を保持しています。コピーして保管するか、再読込して最新の文書を確認してください。";
  if (problem === "auth") return "ログインを確認できませんでした。編集内容を保持しています。再度ログインしてから「再試行」を押してください。";
  if (problem === "offline") return auto ? "オフラインのため自動保存できませんでした。編集内容を保持しています。接続が戻ると再試行します。" : "オフラインのため保存できませんでした。編集内容を保持しています。接続が戻ってから「再試行」を押してください。";
  return auto ? "自動保存できませんでした。編集内容を保持しています。「再試行」で保存できます。" : "下書きを保存できませんでした。編集内容を保持しています。時間をおいて再試行してください。";
}
const problemLabels: Record<SaveProblem, string> = { failed: "保存できませんでした", conflict: "競合しています", "library-conflict": "部品が競合しています", auth: "ログインを確認してください", offline: "オフラインです" };
/** ツールバーの保存状態。競合・部品の競合とログイン切れは内容が戻っても残し（保存の基準が古いため）、失敗とオフラインは未保存の間だけ出す。 */
export function saveStatus(state: { busy: string; hasInput: boolean; problem: SaveProblem | null; dirty: boolean; online: boolean; autosave: boolean; savedAt: Date | null; loaded: boolean }): { text: string; tone: "saved" | "dirty" | "problem"; problem: SaveProblem | null } {
  const problem = state.problem === "conflict" || state.problem === "library-conflict" || state.problem === "auth" || state.dirty ? state.problem : null;
  const tone = problem || state.dirty && !state.online ? "problem" : state.dirty ? "dirty" : "saved";
  const text = state.busy ? `${state.busy}…` : state.hasInput ? "入力を確認中" : problem ? problemLabels[problem] : state.dirty && !state.online ? "オフラインです"
    : state.dirty ? state.autosave ? "自動保存を待っています" : "未保存の変更あり" : !state.loaded ? "文書を選択してください" : state.savedAt ? `保存済み（${formatTime(state.savedAt)}）` : "保存済み";
  return { text, tone, problem };
}
/** 失敗・ログイン切れ・オフラインは「再試行」、ページの競合は「比較する」、部品の競合は「部品を読み直す」。 */
export function SaveStatus({ text, tone, problem, retry, compare, reload, retryDisabled, compareDisabled, reloadDisabled }: {
  text: string; tone: "saved" | "dirty" | "problem"; problem: SaveProblem | null; retry: () => void; compare: () => void; reload: () => void; retryDisabled: boolean; compareDisabled: boolean; reloadDisabled: boolean;
}) {
  return <>
    <span className={`e-status${tone === "saved" ? "" : " is-dirty"}${tone === "problem" ? " is-problem" : ""}`} role="status">{text}</span>
    {(problem === "failed" || problem === "auth" || problem === "offline") && <button type="button" className="e-small e-status-action" disabled={retryDisabled} onClick={retry}>再試行</button>}
    {problem === "conflict" && <button type="button" className="e-small e-status-action" disabled={compareDisabled} onClick={compare}>比較する</button>}
    {problem === "library-conflict" && <button type="button" className="e-small e-status-action" disabled={reloadDisabled} onClick={reload}>部品を読み直す</button>}
  </>;
}
export function AutosaveSwitch({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return <button type="button" role="switch" className="e-autosave" aria-checked={on} onClick={() => set(!on)}><span className="e-autosave-track" aria-hidden="true"><span className="e-autosave-thumb" /></span>自動保存</button>;
}
/** 確定した編集から delay だけ変更が無ければ run(target) を呼ぶ。条件・対象・文書が変わると待ち直す。 */
export function useAutosave(delay: number | undefined, ready: boolean, document: unknown, target: string, run: (target: string) => void): void {
  const runner = useRef(run); runner.current = run;
  useEffect(() => {
    if (!delay || !ready || !target) return;
    const timer = setTimeout(() => runner.current(target), delay);
    return () => clearTimeout(timer);
  }, [delay, ready, document, target]);
}
/** online / offline イベントを追い、接続が戻ったときに reconnected を呼ぶ。 */
export function useOnline(reconnected: () => void): boolean {
  const [online, setOnline] = useState(() => !isOffline()), callback = useRef(reconnected);
  callback.current = reconnected;
  useEffect(() => {
    const up = () => { setOnline(true); callback.current(); }, down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

export function DiffTable({ changes, columns }: { changes: readonly DocumentChange[]; columns: readonly [string, string, string] }) {
  return <table className="e-diff"><thead><tr><th>{columns[0]}</th><th>{columns[1]}</th><th>{columns[2]}</th></tr></thead>
    <tbody>{changes.length ? changes.map((change, index) => <tr key={index}><td>{change.path}</td><td>{change.before}</td><td>{change.after}</td></tr>) : <tr><td colSpan={3}>内容の差分はありません。</td></tr>}</tbody></table>;
}

export type RecoveryOffer = { target: EditorTarget; document: PageDocument; baseVersion: string; updatedAt: string };
type RecoveryPhase = { epoch: number; key: string; state: "checking" | "offer" | "idle" | "discarded"; at?: PageDocument | undefined };
// 共通部品のインスタンスを含む文書。ライブラリで展開できない退避内容は、消さずに残す（部品が戻れば復元できる）。
const hasInstance = (document: unknown) => { try { return JSON.stringify(document).includes('"type":"instance"'); } catch { return false; } };
function recoveredEntry(stored: unknown, target: EditorTarget, blocks: EditorBlockRegistry, components?: ComponentLibrary, siteStyles?: SiteStyles): RecoveryOffer | "component-unresolved" | "style-unresolved" | null {
  if (!stored || typeof stored !== "object") return null;
  const { target: place, baseVersion, baseRevision, document, updatedAt } = stored as Record<string, unknown>;
  if (!place || typeof place !== "object" || !sameTarget(place as EditorTarget, target) || typeof baseVersion !== "string" || !baseVersion ||
    typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1 || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) return null;
  try {
    const parsed = parsePageDocument(document, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
    return sameTarget(parsed, target) ? { target: copyTarget(target), document: parsed, baseVersion, updatedAt } : null;
  } catch { return hasInstance(document) ? "component-unresolved" : siteStyles ? "style-unresolved" : null; }
}
/**
 * 文書の読込ごとに退避内容を確認し、それ以外は確定した編集から 800ms 後に退避する。
 * 復元の提案中は退避内容を上書き・削除しない。保存などで未保存の変更が無くなったら消す。
 */
export function useRecovery({ store, session, dirty, blocks, components, siteStyles, epoch, report }: {
  store: EditorRecoveryStore | undefined; session: { target: EditorTarget; version: string; present: PageDocument } | undefined; dirty: boolean;
  /** 退避内容のインスタンスを検証する、文書を開いた時点の共通部品。変わっても確認し直さない。 */
  blocks: EditorBlockRegistry; components?: ComponentLibrary | undefined; siteStyles?: SiteStyles | undefined; epoch: number; report: (text: string) => void;
}) {
  const [offer, setOffer] = useState<RecoveryOffer | null>(null), [phase, setPhase] = useState<RecoveryPhase>({ epoch: -1, key: "", state: "idle" });
  const latest = useRef(session), phaseRef = useRef(phase), reporter = useRef(report), written = useRef(false), warned = useRef(false), pendingWrite = useRef<(() => void) | null>(null);
  const library = useRef(components), sharedStyles = useRef(siteStyles);
  latest.current = session; phaseRef.current = phase; reporter.current = report; library.current = components; sharedStyles.current = siteStyles;
  const key = targetKeyOf(session?.target), present = session?.present, version = session?.version;
  useEffect(() => {
    setOffer(null); written.current = false; warned.current = false; pendingWrite.current = null;
    const current = latest.current, currentKey = targetKeyOf(current?.target);
    if (!store || !current) { setPhase({ epoch, key: currentKey, state: "idle" }); return; }
    setPhase({ epoch, key: currentKey, state: "checking" });
    let cancelled = false;
    const target = copyTarget(current.target), loaded = current.present;
    Promise.resolve().then(() => store.read(target)).then((stored) => {
      if (cancelled) return;
      const recovered = stored ? recoveredEntry(stored, target, blocks, library.current, sharedStyles.current) : null;
      if (recovered === "component-unresolved" || recovered === "style-unresolved") {
        reporter.current(recovered === "component-unresolved"
          ? "端末に残っていた変更がありますが、共通部品の現在の内容と合わないため復元できません。"
          : "端末に残っていた変更がありますが、共通スタイルの現在の内容と合わないため復元できません。");
        setPhase({ epoch, key: currentKey, state: "idle" }); return;
      }
      if (recovered && fingerprint({ ...recovered.document, revision: 0 }) !== fingerprint({ ...loaded, revision: 0 })) { setOffer(recovered); setPhase({ epoch, key: currentKey, state: "offer" }); return; }
      if (stored) silent(() => store.remove(target));
      setPhase({ epoch, key: currentKey, state: "idle" });
    }, () => { if (!cancelled) setPhase({ epoch, key: currentKey, state: "idle" }); });
    return () => { cancelled = true; };
  }, [store, epoch, blocks]);
  useEffect(() => {
    pendingWrite.current = null;
    const current = latest.current;
    if (!store || !current || phase.epoch !== epoch || phase.key !== key || phase.state === "checking" || phase.state === "offer" || phase.state === "discarded" && phase.at === present) return;
    if (!dirty) { if (written.current) { written.current = false; silent(() => store.remove(copyTarget(current.target))); } return; }
    const write = () => {
      pendingWrite.current = null;
      const now = latest.current;
      if (!now || targetKeyOf(now.target) !== key) return;
      written.current = true;
      void Promise.resolve().then(() => store.write({ target: copyTarget(now.target), baseVersion: now.version, baseRevision: now.present.revision, document: now.present, updatedAt: new Date().toISOString() })).catch((error: unknown) => {
        if (warned.current) return;
        warned.current = true;
        reporter.current(error instanceof RecoveryTooLargeError ? "変更が大きすぎるため端末へ退避していません。保存して作業を残してください。" : "端末への退避ができませんでした。保存して作業を残してください。");
      });
    };
    pendingWrite.current = write;
    const timer = setTimeout(write, 800);
    return () => clearTimeout(timer);
  }, [store, present, version, dirty, phase, epoch, key]);
  useEffect(() => {
    const flush = () => pendingWrite.current?.();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  /** 変更の破棄に合わせて退避内容を消す。未解決の提案は残す。 */
  const drop = useCallback((target: EditorTarget) => {
    const current = phaseRef.current;
    if (!store || current.key === targetKeyOf(target) && (current.state === "offer" || current.state === "checking")) return;
    pendingWrite.current = null; written.current = false;
    setPhase({ ...current, state: "discarded", at: latest.current?.present });
    silent(() => store.remove(copyTarget(target)));
  }, [store]);
  const discard = () => {
    if (!offer || !store) return;
    const target = offer.target; setOffer(null); setPhase((previous) => ({ ...previous, state: "idle" }));
    silent(() => store.remove(target));
  };
  const accepted = () => { setOffer(null); setPhase((previous) => ({ ...previous, state: "idle" })); };
  return { offer, drop, discard, accepted };
}
export function RecoveryBanner({ offer, stale, disabled, compare, restore, discard }: { offer: RecoveryOffer; stale: boolean; disabled: boolean; compare: () => void; restore: () => void; discard: () => void }) {
  return <div className="e-recovery" role="status">
    <p><strong>保存されていない変更があります（{formatDateTime(offer.updatedAt)}）</strong>{stale && <span>その後、別の保存がありました。</span>}</p>
    <div className="e-recovery-actions"><button type="button" className="e-small" disabled={disabled} onClick={compare}>比較する</button>
      <button type="button" className="e-small e-primary" disabled={disabled} onClick={restore}>復元する</button>
      <button type="button" className="e-small" onClick={discard}>破棄</button></div>
  </div>;
}
export function RecoveryCompareDialog({ base, baseLabel, recovered, stale, close, apply }: { base: PageDocument; baseLabel: string; recovered: RecoveryOffer; stale: boolean; close: () => void; apply: () => void }) {
  return <Dialog name="端末に残っていた変更の比較" dismiss={close}><h2>端末に残っていた変更</h2>
    <p>{formatDateTime(recovered.updatedAt)} にこの端末へ退避した内容です。{stale && "退避した後に別の保存がありました。差分を確認してから復元してください。"}</p>
    <DiffTable changes={diffDocuments(base, recovered.document)} columns={["変更箇所", baseLabel, "端末に残っていた内容"]} />
    <div className="e-actions"><button type="button" autoFocus onClick={close}>閉じる</button><button type="button" className="e-primary" onClick={apply}>復元した内容で編集を続ける</button></div>
  </Dialog>;
}

type LibraryRecoveryPhase = { epoch: number; siteId: string; state: "checking" | "offer" | "idle" | "discarded"; at?: ComponentLibrary | undefined };
/**
 * 部品ライブラリを読み込むごと（epoch）に、そのサイトの退避内容を確認する。それ以外は確定した部品の変更から 800ms 後に退避する。
 * 復元の提案中は退避内容を上書き・削除しない。保存・破棄で未保存の部品の変更が無くなったら消す。
 * store が readLibrary / writeLibrary / removeLibrary の3つを持つ場合だけ動く。
 */
export function useLibraryRecovery({ store, session, dirty, blocks, epoch, report }: {
  store: EditorRecoveryStore | undefined;
  session: { siteId: string; version: string; present: ComponentLibrary; saved: ComponentLibrary } | undefined;
  dirty: boolean; blocks: EditorBlockRegistry; epoch: number; report: (text: string) => void;
}): { offer: RecoveredLibrary | null; drop: (siteId: string) => void; discard: () => void; accepted: () => void } {
  // ページだけの退避ストアでは部品の変更を退避しない。呼ぶときは library.readLibrary!(…) の形で this を保つ。
  const library = store?.readLibrary && store.writeLibrary && store.removeLibrary ? store : undefined;
  const [offer, setOffer] = useState<RecoveredLibrary | null>(null), [phase, setPhase] = useState<LibraryRecoveryPhase>({ epoch: -1, siteId: "", state: "idle" });
  const latest = useRef(session), phaseRef = useRef(phase), reporter = useRef(report), written = useRef(false), warned = useRef(false), pendingWrite = useRef<(() => void) | null>(null);
  latest.current = session; phaseRef.current = phase; reporter.current = report;
  const siteId = session?.siteId ?? "", present = session?.present, version = session?.version;
  useEffect(() => {
    setOffer(null); written.current = false; warned.current = false; pendingWrite.current = null;
    const current = latest.current, currentSite = current?.siteId ?? "";
    if (!library || !current) { setPhase({ epoch, siteId: currentSite, state: "idle" }); return; }
    setPhase({ epoch, siteId: currentSite, state: "checking" });
    let cancelled = false;
    const saved = current.saved;
    Promise.resolve().then(() => library.readLibrary!(currentSite)).then((stored) => {
      if (cancelled) return;
      if (!stored) { setPhase({ epoch, siteId: currentSite, state: "idle" }); return; }
      // 別サイトの内容・形が合わない内容・保存済みと変わらない内容は提案せずに消す。
      const entry = parseRecoveredLibrary(stored, currentSite, blocks);
      if (entry && hasRecoveredChanges(mergeRecoveredLibrary(entry, saved, blocks), saved)) { setOffer(entry); setPhase({ epoch, siteId: currentSite, state: "offer" }); return; }
      silent(() => library.removeLibrary!(currentSite));
      setPhase({ epoch, siteId: currentSite, state: "idle" });
    }, () => { if (!cancelled) setPhase({ epoch, siteId: currentSite, state: "idle" }); });
    return () => { cancelled = true; };
  }, [library, epoch, blocks]);
  useEffect(() => {
    pendingWrite.current = null;
    const current = latest.current;
    if (!library || !current || phase.epoch !== epoch || phase.siteId !== siteId || phase.state === "checking" || phase.state === "offer" || phase.state === "discarded" && phase.at === present) return;
    if (!dirty) { if (written.current) { written.current = false; silent(() => library.removeLibrary!(current.siteId)); } return; }
    const write = () => {
      pendingWrite.current = null;
      const now = latest.current;
      if (!now || now.siteId !== siteId) return;
      written.current = true;
      const changed = Object.fromEntries(libraryChanges(now.saved, now.present).map((change) => [change.id, change.base]));
      void Promise.resolve().then(() => library.writeLibrary!({ siteId: now.siteId, baseVersion: now.version, changed, baseTokens: structuredClone(now.saved.tokens), library: now.present, updatedAt: new Date().toISOString() })).catch((error: unknown) => {
        if (warned.current) return;
        warned.current = true;
        reporter.current(error instanceof RecoveryTooLargeError ? "部品の変更が大きすぎるため端末へ退避していません。保存して作業を残してください。" : "部品の変更を端末へ退避できませんでした。保存して作業を残してください。");
      });
    };
    pendingWrite.current = write;
    const timer = setTimeout(write, 800);
    return () => clearTimeout(timer);
  }, [library, present, version, dirty, phase, epoch, siteId]);
  useEffect(() => {
    const flush = () => pendingWrite.current?.();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  /** 部品の変更の破棄に合わせて退避内容を消す。未解決の提案は残す。 */
  const drop = useCallback((siteId: string) => {
    const current = phaseRef.current;
    if (!library || current.siteId === siteId && (current.state === "offer" || current.state === "checking")) return;
    pendingWrite.current = null; written.current = false;
    setPhase({ ...current, state: "discarded", at: latest.current?.present });
    silent(() => library.removeLibrary!(siteId));
  }, [library]);
  const discard = () => {
    if (!offer || !library) return;
    const siteId = offer.siteId; setOffer(null); setPhase((previous) => ({ ...previous, state: "idle" }));
    silent(() => library.removeLibrary!(siteId));
  };
  // 端末の内容はこの作業コピーの元になったため、後の保存・破棄で消す。
  const accepted = () => { setOffer(null); setPhase((previous) => ({ ...previous, state: "idle" })); written.current = true; };
  return { offer, drop, discard, accepted };
}
/** 端末に残っていた部品の変更の提案。復元できる部品が無ければ「破棄」だけを出す。 */
export function LibraryRecoveryBanner({ offer, merge, disabled, restore, discard }: { offer: RecoveredLibrary; merge: LibraryMerge; disabled: boolean; restore: () => void; discard: () => void }) {
  return <div className="e-recovery" role="status" aria-label="端末に残っていた部品の変更">
    <p><strong>保存されていない部品の変更があります（{formatDateTime(offer.updatedAt)}）</strong>
      {merge.library && merge.restored.length > 0 && <span>復元する部品: {merge.restored.map((change) => `${change.name}（${changeLabels[change.change]}）`).join("、")}</span>}
      {merge.library && merge.restoredTokens.length > 0 && <span>復元するスタイル: {merge.restoredTokens.join("、")}</span>}
      {merge.conflicts.length > 0 && <span>ほかの保存で変更されたため復元しない部品: {merge.conflicts.join("、")}</span>}
      {merge.tokenConflicts.length > 0 && <span>ほかの保存で変更されたため復元しないスタイル: {merge.tokenConflicts.join("、")}</span>}
      {!merge.library && <span>最新の共通部品と合わないため、復元できません。</span>}</p>
    <div className="e-recovery-actions">{merge.library && (merge.restored.length > 0 || merge.restoredTokens.length > 0) && <button type="button" className="e-small e-primary" disabled={disabled} onClick={restore}>復元する</button>}
      <button type="button" className="e-small" onClick={discard}>破棄</button></div>
  </div>;
}

export type LatestSnapshot = { snapshot: EditorSnapshot; document: PageDocument };
/** 409 のあと最新の保存内容を読み、差分を見てから残す内容を選ぶ。読込だけでは作業コピーを変えない。 */
export function ConflictDialog({ adapter, target, present, blocks, components, siteStyles, close, discard, overwrite }: {
  adapter: EditorAdapter; target: EditorTarget; present: PageDocument; blocks: EditorBlockRegistry; components?: ComponentLibrary | undefined; siteStyles?: SiteStyles | undefined;
  close: () => void; discard: (latest: LatestSnapshot) => void; overwrite: (latest: LatestSnapshot) => void;
}) {
  const [latest, setLatest] = useState<LatestSnapshot | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [confirmed, setConfirmed] = useState(false);
  const { siteId, pageId, locale } = target;
  useEffect(() => {
    const controller = new AbortController(), requested = { siteId, pageId, locale };
    setLatest(null); setFailed(false); setConfirmed(false);
    adapter.readDocument(requested, controller.signal).then((snapshot) => {
      if (controller.signal.aborted) return;
      const document = parsePageDocument(snapshot?.document, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
      if (!sameTarget(document, requested) || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("target mismatch");
      setLatest({ snapshot, document });
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [adapter, blocks, components, siteStyles, siteId, pageId, locale, attempt]);
  return <Dialog name="最新の保存内容との比較" dismiss={close}><h2>保存内容が競合しています</h2>
    <p>ほかの保存で内容が更新されています。最新の保存内容とあなたの編集を見比べて、残す内容を選んでください。</p>
    {failed ? <><p className="e-help e-problem" role="alert">最新の内容を取得できませんでした。編集内容は保持しています。</p><button type="button" className="e-small" onClick={() => setAttempt((value) => value + 1)}>再試行</button></>
      : !latest ? <p className="e-help">最新の内容を読み込み中…</p>
      : <><DiffTable changes={diffDocuments(latest.document, present)} columns={["変更箇所", "最新の保存内容", "あなたの編集"]} />
        <label className="e-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />最新の保存内容を上書きすることを確認しました</label></>}
    <div className="e-actions"><button type="button" autoFocus onClick={close}>閉じて編集を続ける</button>
      {latest && <><button type="button" className="e-danger" onClick={() => discard(latest)}>最新の内容を読み込む（あなたの編集を破棄）</button>
        <button type="button" className="e-primary" disabled={!confirmed} onClick={() => overwrite(latest)}>あなたの編集で上書き保存</button></>}</div>
  </Dialog>;
}

type RevisionList = { status: "idle" | "loading" | "error" | "ready"; entries: readonly EditorRevisionEntry[]; next: string | undefined; more: "idle" | "loading" | "error" };
const emptyList: RevisionList = { status: "idle", entries: [], next: undefined, more: "idle" };
type SnapshotForm = { label: string; error: string; busy: boolean };
/** 版履歴パネルの状態。ページ・サイトの切替と再読込で閉じ、進行中の要求を abort する。 */
export function useVersionHistory({ adapter, blocks, components, target, version, epoch, report, guard }: {
  /** 版のインスタンスを検証する共通部品。 */
  adapter: EditorAdapter; blocks: EditorBlockRegistry; components?: ComponentLibrary | undefined; target: EditorTarget | undefined; version: string | undefined; epoch: number;
  report: (text: string) => void; guard: () => string | undefined;
}) {
  const [open, setOpen] = useState(false), [list, setList] = useState<RevisionList>(emptyList), [attempt, setAttempt] = useState(0);
  const [viewing, setViewing] = useState<{ entry: EditorRevisionEntry; document: PageDocument } | null>(null), [reading, setReading] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"diff" | "snapshot" | null>(null), [snapshot, setSnapshot] = useState<SnapshotForm>({ label: "", error: "", busy: false });
  const controllers = useRef(new Set<AbortController>()), latest = useRef({ target, version, report, guard, list, components });
  latest.current = { target, version, report, guard, list, components };
  const key = targetKeyOf(target);
  const track = () => { const controller = new AbortController(); controllers.current.add(controller); return controller; };
  const untrack = (controller: AbortController) => { controllers.current.delete(controller); };
  const abortAll = () => { for (const controller of controllers.current) controller.abort(); controllers.current.clear(); };
  const current = () => latest.current.target ? copyTarget(latest.current.target) : undefined;
  useEffect(() => { abortAll(); setOpen(false); setViewing(null); setReading(null); setDialog(null); setList(emptyList); }, [key, epoch]);
  useEffect(() => () => abortAll(), []);
  useEffect(() => {
    const requested = current();
    if (!open || !adapter.listRevisions || !requested) return;
    const controller = track();
    setList((previous) => ({ ...previous, status: previous.status === "ready" ? "ready" : "loading", more: "idle" }));
    adapter.listRevisions({ target: requested }, controller.signal).then((page) => {
      if (controller.signal.aborted || targetKeyOf(latest.current.target) !== targetKeyOf(requested)) return;
      const parsed = parseRevisionPage(page);
      setList({ status: "ready", entries: parsed.entries, next: parsed.next || undefined, more: "idle" });
    }).catch(() => { if (!controller.signal.aborted) setList((previous) => ({ ...previous, status: "error" })); }).finally(() => untrack(controller));
    return () => { controller.abort(); untrack(controller); };
  }, [adapter, open, key, version, attempt]);
  function loadMore() {
    const requested = current(), cursor = latest.current.list.next;
    if (!adapter.listRevisions || !requested || !cursor || latest.current.list.more === "loading") return;
    const controller = track(); setList((previous) => ({ ...previous, more: "loading" }));
    adapter.listRevisions({ target: requested, cursor }, controller.signal).then((page) => {
      if (controller.signal.aborted || targetKeyOf(latest.current.target) !== targetKeyOf(requested)) return;
      const parsed = parseRevisionPage(page);
      setList((previous) => ({ ...previous, entries: [...previous.entries, ...parsed.entries.filter((entry) => !previous.entries.some((other) => other.id === entry.id))], next: parsed.next || undefined, more: "idle" }));
    }).catch(() => { if (!controller.signal.aborted) setList((previous) => ({ ...previous, more: "error" })); }).finally(() => untrack(controller));
  }
  const readController = useRef<AbortController | null>(null);
  function select(entry: EditorRevisionEntry | null) {
    if (!entry) { readController.current?.abort(); setReading(null); setViewing(null); setDialog((value) => value === "diff" ? null : value); return; }
    const problem = latest.current.guard(), requested = current();
    if (problem) { latest.current.report(problem); return; }
    if (!adapter.readRevision || !requested) return;
    readController.current?.abort();
    const controller = track(); readController.current = controller; setReading(entry.id);
    adapter.readRevision({ target: requested, id: entry.id }, controller.signal).then((result) => {
      if (controller.signal.aborted || targetKeyOf(latest.current.target) !== targetKeyOf(requested)) return;
      // 現在のサイト設定を過去版へ混ぜない。参照を持つ版はホストが保存時の snapshot を返す。
      const library = latest.current.components, raw = parsePageDocument(result?.document, blocks, { ...(library ? { components: library } : {}), ...(result.siteStyles ? { siteStyles: result.siteStyles } : {}) });
      const document = result.siteStyles ? resolvePageStyles(raw, result.siteStyles) : raw;
      if (!sameTarget(document, requested)) throw new Error("target mismatch");
      setViewing({ entry, document });
    }).catch(() => { if (!controller.signal.aborted) latest.current.report("この版を読み込めませんでした。"); })
      .finally(() => { untrack(controller); if (readController.current === controller) { readController.current = null; setReading(null); } });
  }
  function createSnapshot() {
    const requested = current(), expectedVersion = latest.current.version, label = snapshot.label;
    if (!adapter.createSnapshot || !requested || !expectedVersion || snapshot.busy) return;
    if (!label.trim() || label.length > 120 || control.test(label)) { setSnapshot((previous) => ({ ...previous, error: "スナップショット名は改行なしの120文字以内で入力してください。" })); return; }
    const controller = track(); setSnapshot((previous) => ({ ...previous, busy: true, error: "" }));
    const conflict = "保存先が更新されています（409）。最新の状態を確認してから作成してください。";
    adapter.createSnapshot({ target: requested, expectedVersion, label }, controller.signal).then((result) => {
      if (controller.signal.aborted || targetKeyOf(latest.current.target) !== targetKeyOf(requested)) return;
      if (result?.status === "conflict") { setSnapshot((previous) => ({ ...previous, busy: false, error: conflict })); return; }
      if (result?.status !== "saved") throw new Error("unexpected result");
      const entry = parseRevisionEntry(result.entry);
      setList((previous) => ({ ...previous, entries: [entry, ...previous.entries.filter((other) => other.id !== entry.id)] }));
      setSnapshot({ label: "", error: "", busy: false }); setDialog(null); latest.current.report("スナップショットを作成しました。");
    }).catch((error: unknown) => { if (!controller.signal.aborted) setSnapshot((previous) => ({ ...previous, busy: false, error: classifySaveError(error) === "conflict" ? conflict : "スナップショットを作成できませんでした。" })); })
      .finally(() => untrack(controller));
  }
  const close = () => { readController.current?.abort(); setOpen(false); setViewing(null); setReading(null); setDialog(null); };
  return {
    supported: typeof adapter.listRevisions === "function", canRead: typeof adapter.readRevision === "function", canSnapshot: typeof adapter.createSnapshot === "function",
    open, list, viewing, reading, dialog, snapshot,
    toggle: () => { if (open) close(); else setOpen(true); }, close, retry: () => setAttempt((value) => value + 1), loadMore, select,
    exit: () => select(null), showDiff: () => setDialog("diff"), closeDialog: () => setDialog(null),
    startSnapshot: () => { setSnapshot({ label: `スナップショット ${formatDateTime(new Date())}`, error: "", busy: false }); setDialog("snapshot"); },
    editSnapshot: (label: string) => setSnapshot((previous) => ({ ...previous, label, error: "" })), createSnapshot
  };
}
export type VersionHistory = ReturnType<typeof useVersionHistory>;

/** 右レールの「バージョン管理」。先頭は現在の編集内容、続いて新しい順の版。 */
export function VersionPanel({ history, status, snapshotBlock }: { history: VersionHistory; status: string;
  /** 作成できない理由。空文字は理由を出さずに無効化、undefined は作成できる。 */
  snapshotBlock: string | undefined }) {
  const { list } = history, snapshotDisabled = snapshotBlock !== undefined;
  return <section className="e-versions" aria-label="バージョン管理">
    <div className="e-versions-head"><h2>バージョン管理</h2><div className="e-versions-actions">
      {history.canSnapshot && <button type="button" className="e-icon-button" aria-label="スナップショットを作成" title={snapshotBlock || "スナップショットを作成"} disabled={snapshotDisabled} onClick={history.startSnapshot}><Icon name="plus" /></button>}
      <button type="button" className="e-icon-button" aria-label="履歴を閉じる" title="履歴を閉じる" onClick={history.close}><Icon name="close" /></button></div></div>
    {history.canSnapshot && snapshotBlock && <p className="e-help">{snapshotBlock}</p>}
    <ol className="e-timeline">
      <li><button type="button" className="e-version is-current" aria-pressed={!history.viewing} onClick={() => history.select(null)}><span className="e-version-time">現在の編集内容</span><small className="e-version-actor">{status}</small></button></li>
      {list.entries.map((entry) => <li key={entry.id}><button type="button" className="e-version" aria-pressed={history.viewing?.entry.id === entry.id} aria-busy={history.reading === entry.id} disabled={!history.canRead} onClick={() => history.select(entry)}>
        <span className="e-version-time">{formatDateTime(entry.createdAt)}</span>
        <span className="e-version-meta"><span className={`e-version-kind is-${entry.kind}`}>{revisionKindLabels[entry.kind]}</span>{entry.actor && <small className="e-version-actor">{entry.actor}</small>}</span>
        {entry.label && <span className="e-version-label">{entry.label}</span>}
      </button></li>)}
    </ol>
    {list.status === "loading" && <p className="e-help">履歴を読み込み中…</p>}
    {list.status === "error" && <div className="e-versions-error"><p className="e-help e-problem" role="alert">履歴を読み込めませんでした。</p><button type="button" className="e-small" onClick={history.retry}>再試行</button></div>}
    {list.status === "ready" && !list.entries.length && <p className="e-help">まだ版の記録はありません。</p>}
    {list.status === "ready" && list.next && list.more !== "error" && <button type="button" className="e-small e-versions-more" disabled={list.more === "loading"} onClick={history.loadMore}>{list.more === "loading" ? "読み込み中…" : "さらに表示"}</button>}
    {list.more === "error" && <div className="e-versions-error"><p className="e-help e-problem" role="alert">履歴を読み込めませんでした。</p><button type="button" className="e-small" onClick={history.loadMore}>再試行</button></div>}
  </section>;
}
/** 履歴モード中、キャンバス上部に浮かべる操作。 */
export function HistoryBar({ history, restore, restoreBlocked, rollback, rollbackHint }: { history: VersionHistory; restore: () => void; restoreBlocked?: string; rollback: (() => void) | undefined; rollbackHint: string | undefined }) {
  const viewing = history.viewing;
  if (!viewing) return null;
  return <div className="e-history-bar" role="region" aria-label="表示中の版">
    <span className="e-history-bar-title">{formatDateTime(viewing.entry.createdAt)} · {revisionKindLabels[viewing.entry.kind]}</span>
    <button type="button" onClick={history.showDiff}>差分を見る</button>
    <button type="button" className="e-primary" disabled={!!restoreBlocked} onClick={restore}>この版を復元</button>
    {rollback && <button type="button" disabled={!!rollbackHint} onClick={rollback}>公開版をこの版に戻す…</button>}
    <button type="button" onClick={history.exit}>閉じる</button>
    {(restoreBlocked || rollback && rollbackHint) && <small className="e-history-bar-hint">{restoreBlocked ?? rollbackHint}</small>}
  </div>;
}
function SnapshotDialog({ history }: { history: VersionHistory }) {
  const id = useId(), { label, error, busy } = history.snapshot;
  return <Dialog name="スナップショットを作成" dismiss={() => { if (!busy) history.closeDialog(); }}><h2>スナップショットを作成</h2>
    <p className="e-help">保存済みの状態に名前を付けて、版の一覧に残します。個人情報や秘密は名前に入れないでください。</p>
    <label className="e-field" htmlFor={id}><span>スナップショット名</span><input id={id} value={label} disabled={busy} autoFocus aria-invalid={!!error}
      onChange={(event) => history.editSnapshot(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); history.createSnapshot(); } }} /></label>
    {error && <p className="e-help e-problem" role="alert">{error}</p>}
    <div className="e-actions"><button type="button" disabled={busy} onClick={history.closeDialog}>キャンセル</button><button type="button" className="e-primary" disabled={busy} onClick={history.createSnapshot}>作成する</button></div>
  </Dialog>;
}
export function HistoryDialogs({ history, present }: { history: VersionHistory; present: PageDocument | undefined }) {
  if (history.dialog === "snapshot") return <SnapshotDialog history={history} />;
  if (history.dialog !== "diff" || !history.viewing || !present) return null;
  const { entry, document } = history.viewing;
  return <Dialog name="この版との差分" dismiss={history.closeDialog}><h2>{formatDateTime(entry.createdAt)} の版との差分</h2>
    <p className="e-help">{revisionKindLabels[entry.kind]}{entry.actor ? ` · ${entry.actor}` : ""}{entry.label ? ` · ${entry.label}` : ""}</p>
    <DiffTable changes={diffDocuments(present, document)} columns={["変更箇所", "現在の編集内容", "この版"]} />
    <div className="e-actions"><button type="button" autoFocus onClick={history.closeDialog}>閉じる</button></div>
  </Dialog>;
}

const affectedLabels: Readonly<Record<EditorReleaseAffected["kind"], string>> = { shared: "共通部品", page: "ページ", site: "サイト設定" };
export function ReleaseAffected({ affected }: { affected: readonly EditorReleaseAffected[] | undefined }) {
  if (!affected?.length) return null;
  return <div className="e-affected"><p>影響する共通部品・ページ・サイト設定</p><ul>{affected.map((item, index) => <li key={index}>
    <span className="e-badge">{affectedLabels[item.kind]}</span><span className="e-affected-name">{item.name}</span>{item.detail && <small className="e-help">{item.detail}</small>}</li>)}</ul></div>;
}
