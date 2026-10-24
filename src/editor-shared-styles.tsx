"use client";

import { useEffect, useState } from "react";
import { parsePageDocument } from "./document.js";
import { editDocument, sameTarget, type EditorOperation } from "./editor-model.js";
import { Dialog } from "./editor-dialog.js";
import type { Pending } from "./editor-fields.js";
import { StyleLibrary, type StyleLibraryProps } from "./editor-style-library.js";
import type { SiteSettingsState } from "./editor-pages.js";
import type { EditorAdapter, EditorBlockRegistry, EditorPage } from "./editor-types.js";
import type { ComponentLibrary, PageDocument } from "./types.js";
import { detachRemovedSiteStyles, parseSiteStyles, type SiteStyles } from "./site-styles.js";
import { affectedBySiteStyles } from "./style-model.js";

type Promotion = { kind: "token" | "textStyle"; name: string; styles: SiteStyles; document: PageDocument; collisions: string[] };
type Props = StyleLibraryProps & {
  adapter: EditorAdapter; pages: readonly EditorPage[]; blocks: EditorBlockRegistry; components: ComponentLibrary | undefined;
  /** 部品の編集中。rawDocument の tokens はライブラリの値で、document はサイト共通の同名の定義を優先した表示用の値。 */
  editingComponent: boolean;
  siteDisabled: boolean; state: SiteSettingsState; rawDocument: PageDocument; pageDirty: boolean;
  migrate: (document: PageDocument, styles: SiteStyles) => string | undefined;
  /** 「サイト共通」の欄の入力途中を知らせる。pageDirty（ページの未保存の変更・ページの欄の入力途中）には含めない。 */
  sitePending: Pending;
};
/** ページの未保存の変更・ページの欄の入力途中が残るあいだ、「サイト共通」を編集できない理由。 */
const pageHold = "ページの変更を保存してからサイト共通スタイルを編集してください。";
type Impact = { key: string; affected: string[]; failed: boolean };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** 部品の編集で、サイト共通に同名の定義がある値を変更できない理由。ページでの描画と同じくサイトの定義が優先され、ライブラリの写しを変えても見た目が変わらない。 */
export const sharedTokenReason = (siteEditable: boolean): string =>
  `サイト共通の値のため、コンポーネントの編集では変更できません。${siteEditable ? "ページに戻り、スタイルの「サイト共通」で変更してください。" : ""}`;

/** サイトとページの所有権・変更の影響・移行の確認を共通ライブラリの上に表示する。 */
export function SharedStyleLibrary({ adapter, pages, blocks, components, siteDisabled, editingComponent, state, rawDocument, pageDirty, sitePending, migrate, ...props }: Props) {
  const [scope, setScope] = useState<"page" | "site">("page"), [promotion, setPromotion] = useState<Promotion | null>(null), [problem, setProblem] = useState("");
  const [impact, setImpact] = useState<Impact | null>(null), [impactEpoch, setImpactEpoch] = useState(0);
  const supported = !editingComponent && state.supported && state.editable && state.status === "ready";
  const before: SiteStyles = state.settings ?? {}, after = state.styles;
  const impactKey = JSON.stringify([impactEpoch, rawDocument.siteId, before.tokens, before.textStyles, after, pages.map((page) => [page.pageId, page.locale, page.title])]);
  useEffect(() => {
    if (!supported || !state.stylesDirty) { setImpact(null); return; }
    const controller = new AbortController();
    // 使用数は一覧から推測せず、各ページの検証済み文書と override から数える。
    Promise.all(pages.map(async (page) => {
      if (page.siteId !== rawDocument.siteId) throw new Error("site mismatch");
      const snapshot = await adapter.readDocument(page, controller.signal);
      const document = parsePageDocument(snapshot.document, blocks, { ...(components ? { components } : {}), siteStyles: before });
      if (!sameTarget(document, page)) throw new Error("page mismatch");
      const candidate = detachRemovedSiteStyles(document, before, after);
      parsePageDocument(candidate, blocks, { ...(components ? { components } : {}), siteStyles: after });
      return affectedBySiteStyles(document, before, after, components) ? `${page.title} · ${page.locale}` : null;
    })).then((affected) => { if (!controller.signal.aborted) setImpact({ key: impactKey, affected: affected.filter((name): name is string => name !== null), failed: false }); })
      .catch(() => { if (!controller.signal.aborted) setImpact({ key: impactKey, affected: [], failed: true }); });
    return () => controller.abort();
  }, [adapter, blocks, components, impactKey, supported, state.stylesDirty]);
  if (editingComponent) {
    // 部品の値はライブラリ（「共通部品」）が持つ。サイト共通に同名の定義がある値はページでの描画と同じくサイトの定義で表示され、
    // ライブラリの写しを変えても見た目が変わらないため、ここでは変更・削除しない。新しい値の名前にもサイト共通の名前を使わない。
    const shared = after.tokens ?? {}, names = Object.keys(props.document.tokens);
    return <>
      {names.some((name) => Object.hasOwn(shared, name)) && <p className="e-help">サイト共通と同じ名前の値は、ページに置いたときと同じくサイト共通の値で表示します。</p>}
      <StyleLibrary {...props} origins={state.supported ? Object.fromEntries(names.map((name) => [`token:${name}`, Object.hasOwn(shared, name) ? "サイト共通" : "コンポーネント本体"])) : undefined}
        readOnlyToken={(name) => Object.hasOwn(shared, name) ? sharedTokenReason(state.editable) : undefined} reservedNames={Object.keys(shared)} />
    </>;
  }
  const siteDocument: PageDocument = { ...rawDocument, body: [], tokens: after.tokens ?? {}, ...(after.textStyles ? { textStyles: after.textStyles } : {}) };
  if (!after.textStyles) delete siteDocument.textStyles;
  function applySite(operation: EditorOperation): string | undefined {
    if (siteDisabled) return "処理が完了してからサイト共通スタイルを編集してください。";
    if (pageDirty) return pageHold;
    if ((operation.type === "token" && !operation.token && Object.hasOwn(before.tokens ?? {}, operation.name) || operation.type === "textStyle" && !operation.style && Object.hasOwn(before.textStyles ?? {}, operation.name)) && !adapter.siteStyleCapabilities?.atomicReferenceDetachment) return "このホストは全ページの参照を同時に切り離せないため、サイト共通スタイルを削除できません。";
    try {
      const next = editDocument(siteDocument, operation);
      const candidate: SiteStyles = { tokens: next.tokens, ...(next.textStyles ? { textStyles: next.textStyles } : {}) };
      parsePageDocument(detachRemovedSiteStyles(rawDocument, before, candidate), blocks, { ...(components ? { components } : {}), siteStyles: candidate });
      return state.editStyles(candidate);
    } catch { return "共通スタイルの種類・値・参照を確認してください。"; }
  }
  function promote(kind: Promotion["kind"], name: string) {
    const styles = structuredClone(after), page = structuredClone(rawDocument), collisions: string[] = [];
    const token = (key: string) => {
      const value = rawDocument.tokens[key];
      if (!value) return;
      if (Object.hasOwn(styles.tokens ?? {}, key)) collisions.push(`共通値 ${key}: ${JSON.stringify(styles.tokens![key])} → ${JSON.stringify(value)}`);
      (styles.tokens ??= {})[key] = structuredClone(value);
    };
    if (kind === "token") { token(name); delete page.tokens[name]; }
    else {
      const style = rawDocument.textStyles?.[name]; if (!style) return;
      if (Object.hasOwn(styles.textStyles ?? {}, name)) collisions.push(`テキストスタイル ${name}: ${JSON.stringify(styles.textStyles![name])} → ${JSON.stringify(style)}`);
      for (const values of [style.base, ...(style.responsive ?? []).map((entry) => entry.declarations)]) for (const value of Object.values(values)) if (typeof value === "object") token(value.token);
      (styles.textStyles ??= {})[name] = structuredClone(style); delete page.textStyles?.[name];
      if (page.textStyles && !Object.keys(page.textStyles).length) delete page.textStyles;
    }
    try { setPromotion({ kind, name, styles: parseSiteStyles(styles), document: page, collisions: [...new Set(collisions)] }); setProblem(""); }
    catch { setProblem("参照先の共通値をサイトへ移せません。名前と種類を確認してください。"); }
  }
  const origins = Object.fromEntries([
    ...Object.keys(props.document.tokens).map((name) => [`token:${name}`, Object.hasOwn(rawDocument.tokens, name) ? "このページ" : "サイト共通"]),
    ...Object.keys(props.document.textStyles ?? {}).map((name) => [`textStyle:${name}`, Object.hasOwn(rawDocument.textStyles ?? {}, name) ? "このページ" : "サイト共通"])
  ]);
  const readyImpact = impact?.key === impactKey ? impact : null;
  return <>
    {supported && <div className="e-seg" role="group" aria-label="スタイルの保存先"><button type="button" aria-pressed={scope === "page"} onClick={() => { setScope("page"); setProblem(""); }}>このページ</button><button type="button" aria-pressed={scope === "site"} onClick={() => { setScope("site"); setProblem(""); }}>サイト共通</button></div>}
    {supported && <p className="e-help">同じ名前は「このページ」の指定を優先します。サイト共通の変更は保存後、次の公開で反映されます。</p>}
    {supported && scope === "site" && pageDirty && <p className="e-help">{pageHold}</p>}
    {supported && scope === "site" ? <StyleLibrary {...props} document={siteDocument} selection={null} apply={applySite} preview={undefined} pending={sitePending} disabled={siteDisabled || state.busy || pageDirty} scopeLabel="サイト共通" fieldKey={`${props.fieldKey}-site`} />
      : <StyleLibrary {...props} origins={supported ? origins : undefined} onPromote={supported && !state.stylesDirty ? promote : undefined} canPromote={(kind, name) => Object.hasOwn(kind === "token" ? rawDocument.tokens : rawDocument.textStyles ?? {}, name)} />}
    {problem && <p className="e-help e-problem" role="alert">{problem}</p>}
    {supported && state.stylesDirty && <section className="e-section" aria-label="サイト共通スタイルの変更確認"><h3>サイト共通スタイルの変更</h3>
      {!readyImpact ? <p role="status">全ページの参照と影響を確認中…</p> : readyImpact.failed ? <><p role="alert" className="e-problem">影響を検証できません。参照の種類・ページの取得権限を確認してください。編集内容は保持しています。</p><button type="button" onClick={() => setImpactEpoch((value) => value + 1)}>影響を再確認</button></> : <><p>{readyImpact.affected.length} ページの参照または見た目に反映されます。</p>{!!readyImpact.affected.length && <ul>{readyImpact.affected.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}</ul>}</>}
      <details><summary>保存済み設定からの差分</summary><table><thead><tr><th>名前</th><th>保存済み</th><th>編集中</th></tr></thead><tbody>{(["tokens", "textStyles"] as const).flatMap((kind) => [...new Set([...Object.keys(before[kind] ?? {}), ...Object.keys(after[kind] ?? {})])].filter((name) => !equal(before[kind]?.[name], after[kind]?.[name])).map((name) => <tr key={`${kind}-${name}`}><td>{kind} / {name}</td><td>{JSON.stringify(before[kind]?.[name]) ?? "なし"}</td><td>{JSON.stringify(after[kind]?.[name]) ?? "削除（参照の見た目を保持）"}</td></tr>))}</tbody></table></details>
      <p className="e-help">公開中の値との差分は「公開前の確認」にサイト共通の変更として表示されます。</p>
      {state.message && <p role={state.message.alert ? "alert" : "status"}>{state.message.text}</p>}
      {state.latest && <details><summary>競合した最新設定と比較</summary><pre>{JSON.stringify(state.latest, null, 2)}</pre><p>編集中</p><pre>{JSON.stringify(after, null, 2)}</pre></details>}
      <div className="e-actions"><button type="button" className="e-primary" disabled={siteDisabled || !state.canSave || !readyImpact || readyImpact.failed} onClick={() => void state.save()}>サイト共通スタイルを保存</button><button type="button" disabled={state.busy} onClick={state.reset}>サイトの変更を取り消す</button></div>
    </section>}
    {promotion && <Dialog name="サイト共通スタイルへの移行確認" dismiss={() => setPromotion(null)}><h2>「{promotion.name}」をサイト共通へ移す</h2><p>同じ名前を参照する他のページにも反映されます。確認後はサイト共通スタイルを先に保存し、このページを保存してください。</p>
      {promotion.collisions.length ? <><p role="alert">同名のサイト共通定義があります。以下の値で置き換えます。</p><ul>{promotion.collisions.map((collision) => <li key={collision}>{collision}</li>)}</ul></> : <p>同名のサイト共通定義との衝突はありません。</p>}
      {problem && <p className="e-problem" role="alert">{problem}</p>}
      <div className="e-actions"><button type="button" onClick={() => setPromotion(null)}>戻る</button><button type="button" className="e-primary" onClick={() => { const error = migrate(promotion.document, promotion.styles); if (error) setProblem(error); else { setPromotion(null); setScope("site"); } }}>確認して移行</button></div>
    </Dialog>}
  </>;
}
