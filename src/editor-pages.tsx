"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog } from "./editor-dialog.js";
import { pageChangeProblems, sameTarget, validatePageChangePlan, type EditorOperation } from "./editor-model.js";
import type { EditorAdapter, EditorPage, EditorPageChange, EditorPageChangePlan, EditorPageChangeResult, EditorSite, EditorTarget } from "./editor-types.js";
import { buildPageTree, findPathConflict, pageUrl, parseSiteSettings, resolvePageMetadata, validatePagePath, type PageMetadata, type PageTreeNode, type PageVisibility, type SiteSettings } from "./pages.js";
import type { PageDocument } from "./types.js";
import { DocumentValidationError } from "./validation-utils.js";

const iconPaths = {
  page: "M4.5 2.5h4.8l2.7 2.7v8.3H4.5z M9.2 2.5v2.8H12",
  home: "M2.5 7.4 8 2.8l5.5 4.6 M4 6.3v7.2h8V6.3 M6.6 13.5V10h2.8v3.5",
  folder: "M2.2 4.2h3.9l1.4 1.5h6.3v7.1H2.2z",
  template: "M2.5 2.5h11v11h-11z M2.5 6h11 M6.2 6v7.5",
  shared: "M8 2.2 13.3 5v6L8 13.8 2.7 11V5z M2.7 5 8 7.8 13.3 5 M8 7.8v6",
  search: "M7.2 11.8a4.6 4.6 0 1 0 0-9.2 4.6 4.6 0 0 0 0 9.2z M10.6 10.6l3 3",
  plus: "M8 3.2v9.6 M3.2 8h9.6",
  more: "M3.6 8h.01 M8 8h.01 M12.4 8h.01",
  chevron: "M6.2 4.2 10 8l-3.8 3.8"
} as const;
function Icon({ name, className }: { name: keyof typeof iconPaths; className?: string }) {
  return <svg className={className ? `e-icon ${className}` : "e-icon"} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d={iconPaths[name]} /></svg>;
}

export type PageChangeStart = { action: "create" } | { action: "duplicate"; page: EditorPage } | { action: "update"; page: EditorPage } | { action: "visibility"; page: EditorPage; visibility: PageVisibility };
export type FieldOptions = { reason?: string | undefined; multiline?: boolean; placeholder?: string; hint?: (value: string) => ReactNode };
/** editor.tsx の Field を描く関数。未確定・無効な入力の扱いを共通にする。 */
export type FieldRenderer = (name: string, value: string, operation: (value: string) => EditorOperation, key: string, options?: FieldOptions) => ReactNode;

const isConflict = (error: unknown) => !!error && typeof error === "object" && "status" in error && error.status === 409;
const targetOf = (page: EditorTarget): EditorTarget => ({ siteId: page.siteId, pageId: page.pageId, locale: page.locale });
const pageKey = (page: EditorTarget) => `${page.pageId}/${page.locale}`;
const kindLabels: Record<string, string> = { page: "ページ", template: "テンプレート", shared: "共通枠" };
const publicPath = (page: EditorPage | undefined) => page?.path !== undefined && validatePagePath(page.path) === null ? page.path : undefined;
function metadataFor(document: PageDocument, page: EditorPage | undefined, domain: string | undefined, settings: SiteSettings | undefined): PageMetadata | undefined {
  try { return resolvePageMetadata({ document, site: settings, domain, path: publicPath(page), visibility: page?.visibility }); } catch { return undefined; }
}

/** 公開情報・サイト設定の検証エラーを入力欄向けの文にする。対象外は undefined。 */
export function publicInfoMessage(error: unknown): string | undefined {
  if (!(error instanceof DocumentValidationError) || !/^\$\.(?:meta|site)(?:\.|$)/.test(error.path)) return undefined;
  const field = error.path.replace(/^\$\.(?:meta|site)\.?/, "");
  if (field === "title") return "サイトタイトルは改行なしの120文字以内で入力してください。";
  if (field === "description") return "説明文は改行なしの500文字以内で入力してください。";
  if (field === "ogImage.src" || field === "favicon") return "URL は https:// か / から始まる形式で入力してください。";
  if (field === "ogImage.alt") return "画像の説明は改行なしの300文字以内で入力してください。";
  if (field === "locale") return "言語は ja や ja-JP の形式で入力してください。";
  if (field.startsWith("structuredData")) return "構造化データは16件までです。指定を確認してください。";
  return "公開情報の値を確認してください。";
}

function PageMenu({ page, open, setOpen, disabled, start }: { page: EditorPage; open: boolean; setOpen: (open: boolean) => void; disabled: boolean; start: (start: PageChangeStart) => void }) {
  const trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), toggle = useRef(setOpen);
  toggle.current = setOpen;
  const shown = open && !disabled;
  useEffect(() => { if (open && disabled) toggle.current(false); }, [open, disabled]);
  useEffect(() => {
    if (!shown) return;
    list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const owner = trigger.current?.ownerDocument;
    const outside = (event: Event) => { const target = event.target as Node | null; if (target && !list.current?.contains(target) && !trigger.current?.contains(target)) toggle.current(false); };
    owner?.addEventListener("mousedown", outside);
    return () => owner?.removeEventListener("mousedown", outside);
  }, [shown]);
  const choose = (next: PageChangeStart) => { setOpen(false); trigger.current?.focus(); start(next); };
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")), index = items.indexOf(event.target as HTMLElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (event.key === "Tab") setOpen(false);
  }
  const makePrivate = page.visibility !== "private";
  return <>
    <button ref={trigger} type="button" className="e-icon-button e-page-more" aria-label={`${page.title} の操作`} aria-haspopup="menu" aria-expanded={shown} disabled={disabled} onClick={() => setOpen(!open)}><Icon name="more" className="e-icon-dots" /></button>
    {shown && <div ref={list} className="e-menu" role="menu" aria-label={`${page.title} の操作`} onKeyDown={keys}>
      <button type="button" role="menuitem" onClick={() => choose({ action: "update", page })}>名前とURLを変更</button>
      <button type="button" role="menuitem" onClick={() => choose({ action: "duplicate", page })}>複製</button>
      <button type="button" role="menuitem" className={makePrivate ? "e-danger" : undefined} onClick={() => choose({ action: "visibility", page, visibility: makePrivate ? "private" : "public" })}>{makePrivate ? "非公開にする" : "公開する"}</button>
    </div>}
  </>;
}

/** 左レールのページ一覧。検索、パスごとのフォルダ、種類と公開状態、行ごとの操作を表示する。 */
export function PagePanel({ pages, current, disabled, operations, operationsDisabled, unsaved, select, start, children }: {
  pages: readonly EditorPage[]; current: EditorTarget | undefined; disabled: boolean;
  /** 見出しの下に置くホスト側の部品（サイトの選択など）。 */
  children?: ReactNode;
  /** ホストがページ操作を実装しているか。 */
  operations: boolean; operationsDisabled: boolean; unsaved: boolean;
  select: (page: EditorPage) => void; start: (start: PageChangeStart) => void;
}) {
  const [searching, setSearching] = useState(false), [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<readonly string[]>([]), [menu, setMenu] = useState("");
  const tree = buildPageTree(pages, searching ? query : undefined), multiLocale = new Set(pages.map((page) => page.locale)).size > 1;
  const normal = pages.filter((page) => (page.kind ?? "page") === "page");
  const published = normal.filter((page) => page.visibility !== "private" && page.published !== false).length;
  const closeSearch = () => { setSearching(false); setQuery(""); };
  function row(node: PageTreeNode): ReactNode {
    if (node.type === "folder") {
      const open = !collapsed.includes(node.path);
      return <li key={`folder:${node.path}`}>
        <button type="button" className="e-page e-folder" aria-expanded={open} title={node.path} style={{ paddingLeft: 4 + node.depth * 14 }}
          onClick={() => setCollapsed((previous) => open ? [...previous, node.path] : previous.filter((path) => path !== node.path))}>
          <Icon name="chevron" className="e-chevron" /><Icon name="folder" /><span className="e-page-name">{node.name}</span>
        </button>
        {open && <ul>{node.children.map(row)}</ul>}
      </li>;
    }
    const page: EditorPage = node.page, kind = page.kind ?? "page", key = pageKey(page);
    const secondary = [page.path, multiLocale ? page.locale : undefined].filter(Boolean).join(" · ");
    return <li key={key}><div className="e-page-row">
      <button type="button" className="e-page" aria-current={current && sameTarget(page, current) ? "page" : undefined} style={{ paddingLeft: 8 + node.depth * 14 }}
        disabled={disabled} title={[page.title, secondary].filter(Boolean).join(" · ")} onClick={() => select(page)}>
        <Icon name={kind === "template" ? "template" : kind === "shared" ? "shared" : page.path === "/" ? "home" : "page"} />
        <span className="e-page-name">{page.title}</span>{secondary && <span className="e-page-path">{secondary}</span>}
        {kind !== "page" && kindLabels[kind] && <span className="e-badge">{kindLabels[kind]}</span>}
        {page.visibility === "private" && <span className="e-badge e-badge-private">非公開</span>}
        {page.published === false && <span className="e-badge">未公開</span>}
      </button>
      {operations && kind === "page" && <PageMenu page={page} open={menu === key} setOpen={(open) => setMenu(open ? key : "")} disabled={disabled || operationsDisabled} start={start} />}
    </div></li>;
  }
  return <div className="e-pages">
    <div className="e-panel-head e-pages-head"><div><h2>ページ</h2><p>編集するページを選択</p></div>
      <div className="e-pages-actions"><button type="button" className="e-icon-button" aria-label="検索" aria-pressed={searching} onClick={() => searching ? closeSearch() : setSearching(true)}><Icon name="search" /></button>
        {operations && <button type="button" className="e-icon-button" aria-label="ページを追加" disabled={disabled || operationsDisabled} onClick={() => start({ action: "create" })}><Icon name="plus" /></button>}</div>
    </div>
    {children}
    {searching && <input className="e-page-search" type="search" aria-label="ページを検索" placeholder="ページ名・パスで検索" value={query} autoFocus
      onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeSearch(); } }} />}
    {tree.length ? <ul className="e-page-tree">{tree.map(row)}</ul> : <p className="e-help">{searching && query.trim() ? "一致するページはありません" : "ページがありません"}</p>}
    {operations && unsaved && <small className="e-help">未保存の変更を保存してから操作できます。</small>}
    <p className="e-page-count">公開中 {published} / {normal.length} ページ</p>
  </div>;
}

export function pageChangeNotice(change: EditorPageChange): string {
  return change.action === "create" ? "ページを作成しました。" : change.action === "duplicate" ? "ページを複製しました。" : change.action === "update" ? "ページ名とURLを変更しました。"
    : change.visibility === "private" ? "ページを非公開にしました。" : "ページを公開状態にしました。";
}
const dialogTitle = (start: PageChangeStart) => start.action === "visibility" ? start.visibility === "private" ? "ページを非公開にする" : "ページを公開する"
  : start.action === "create" ? "ページを追加" : start.action === "duplicate" ? "ページを複製" : "ページ名とURLを変更";
function initialValues(start: PageChangeStart, pages: readonly EditorPage[], site: EditorSite, locale: string): { title: string; path: string } {
  const free = (base: string, pageLocale: string) => {
    for (let index = 1; index < 100; index++) { const candidate = index === 1 ? base : `${base}-${index}`; if (!findPathConflict(pages, { siteId: site.id, locale: pageLocale, path: candidate })) return candidate; }
    return base;
  };
  if (start.action === "create") return { title: "", path: free("/new-page", locale) };
  if (start.action === "duplicate") return { title: `${start.page.title} のコピー`, path: free(`${start.page.path === undefined ? "/new-page" : start.page.path === "/" ? "/home" : start.page.path}-copy`, start.page.locale) };
  return { title: start.page.title, path: start.page.path ?? "" };
}

/** ページ操作の二段階確認。影響を確認し、明示の同意後だけ反映する。 */
export function PageChangeDialog({ start, site, pages, locale, prepare, apply, applied, conflicted, reload, close }: {
  start: PageChangeStart; site: EditorSite; pages: readonly EditorPage[];
  /** 新しいページの locale。 */
  locale: string;
  prepare: (change: EditorPageChange, signal: AbortSignal) => Promise<EditorPageChangePlan>;
  apply: (plan: EditorPageChangePlan, signal: AbortSignal) => Promise<EditorPageChangeResult>;
  applied: (page: EditorPage, change: EditorPageChange) => void; conflicted: () => void; reload: () => void; close: () => void;
}) {
  const [initial] = useState(() => initialValues(start, pages, site, locale));
  const [title, setTitle] = useState(initial.title), [path, setPath] = useState(initial.path), [touched, setTouched] = useState<readonly string[]>([]);
  const [plan, setPlan] = useState<EditorPageChangePlan | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(""), [message, setMessage] = useState(""), [unknown, setUnknown] = useState(false);
  const controller = useRef<AbortController | null>(null), id = useId();
  useEffect(() => () => controller.current?.abort(), []);
  const change: EditorPageChange = start.action === "create" ? { action: "create", siteId: site.id, locale, title, path }
    : start.action === "duplicate" ? { action: "duplicate", source: targetOf(start.page), title, path }
    : start.action === "update" ? { action: "update", target: targetOf(start.page), title, path }
    : { action: "visibility", target: targetOf(start.page), visibility: start.visibility };
  const problems = pageChangeProblems(change, pages, site), makePrivate = start.action === "visibility" && start.visibility === "private";
  const problemFor = (field: "title" | "path", value: string) => touched.includes(field) || value !== "" ? problems.find((problem) => problem.field === field)?.message : undefined;
  const titleProblem = problemFor("title", title), pathProblem = problemFor("path", path), changeProblem = problems.find((problem) => problem.field === "change")?.message;
  const begin = () => { controller.current?.abort(); const next = new AbortController(); controller.current = next; return next; };
  async function review() {
    if (problems.length || busy) return;
    const current = begin(), requested = structuredClone(change); setBusy("影響を確認中…"); setMessage("");
    try {
      const result = await prepare(requested, current.signal);
      if (current.signal.aborted) return;
      setPlan(validatePageChangePlan(structuredClone(result), requested, site)); setConfirmed(false);
    } catch { if (!current.signal.aborted) setMessage("影響を確認できませんでした。権限と入力を確認して再試行してください。"); }
    finally { if (!current.signal.aborted) setBusy(""); }
  }
  function conflict() {
    setPlan(null); setConfirmed(false); conflicted();
    setMessage("ほかの変更と競合しました（409）。ページ一覧を再読込しました。内容を確認してやり直してください。");
  }
  async function confirm() {
    if (!plan || !confirmed || busy || unknown) return;
    const current = begin(); setBusy("反映中…"); setMessage("");
    try {
      const result = await apply(plan, current.signal);
      if (current.signal.aborted) return;
      if (result.status === "conflict") { conflict(); return; }
      const page = result.status === "applied" ? result.page : undefined;
      if (!page || page.siteId !== site.id || typeof page.pageId !== "string" || typeof page.locale !== "string" || typeof page.title !== "string") throw new Error("invalid result");
      applied(page, plan.change);
    } catch (error) {
      if (current.signal.aborted) return;
      if (isConflict(error)) conflict();
      else { setUnknown(true); setMessage("反映されたか確認できません。ページ一覧を再読込して状態を確認してください。"); }
    } finally { if (!current.signal.aborted) setBusy(""); }
  }
  const touch = (field: string) => setTouched((previous) => previous.includes(field) ? previous : [...previous, field]);
  const status = <>{busy && <p className="e-help" role="status">{busy}</p>}{message && <p className="e-help e-problem" role="alert">{message}</p>}</>;
  let body: ReactNode;
  if (!plan) {
    body = <>
      <h2>{dialogTitle(start)}</h2>
      {start.action !== "create" && <p className="e-help">{start.page.title}{start.page.path ? ` · ${start.page.path}` : ""}</p>}
      {start.action === "visibility" ? <p>{makePrivate ? "公開中のURLは表示されなくなり、検索エンジンと sitemap からも外れます。次の画面でリンク元とナビゲーションへの影響を確認できます。" : "公開サイトにこのページを表示できる状態にします。表示する内容は、公開済みの版です。"}</p> : <>
        <label className="e-field" htmlFor={`${id}-title`}><span>ページ名</span>
          <input id={`${id}-title`} value={title} autoFocus disabled={!!busy} aria-invalid={!!titleProblem} aria-describedby={titleProblem ? `${id}-title-problem` : undefined}
            onChange={(event) => setTitle(event.target.value)} onBlur={() => touch("title")} />
          {titleProblem && <small id={`${id}-title-problem`} className="e-help e-problem" role="alert">{titleProblem}</small>}
        </label>
        <label className="e-field" htmlFor={`${id}-path`}><span>URL パス</span>
          <span className="e-url-input">{site.domains[0] && <span className="e-url-prefix" aria-hidden="true">{site.domains[0]}</span>}
            <input id={`${id}-path`} value={path} disabled={!!busy} spellCheck={false} autoCapitalize="off" aria-invalid={!!pathProblem} aria-describedby={`${id}-path-help`}
              onChange={(event) => setPath(event.target.value)} onBlur={() => touch("path")} /></span>
          {pathProblem && <small className="e-help e-problem" role="alert">{pathProblem}</small>}
          <small id={`${id}-path-help`} className="e-help">半角英小文字・数字と - _ を / で区切ります。例: /circles/kamakura-go</small>
        </label>
      </>}
      {changeProblem && <p className="e-help">{changeProblem}</p>}
      {status}
      <div className="e-actions"><button type="button" disabled={!!busy} onClick={close}>キャンセル</button><button type="button" className="e-primary" disabled={problems.length > 0 || !!busy} onClick={() => void review()}>影響を確認</button></div>
    </>;
  } else {
    const { impact } = plan, list = (items: readonly string[], empty: string) => items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="e-help">{empty}</p>;
    const beforeEmpty = start.action === "create" || start.action === "duplicate" ? "（新しいページ）" : start.action === "visibility" && !makePrivate ? "（非公開）" : "（なし）";
    body = <>
      <h2>変更の影響を確認</h2>
      <p>反映先のドメイン</p><p className="e-domain">{plan.domain}</p>
      <div className="e-impact">
        <h3>URL</h3>
        <dl className="e-rows"><div><dt>変更前</dt><dd>{impact.before ?? beforeEmpty}</dd></div><div><dt>変更後</dt><dd>{impact.after ?? (makePrivate ? "公開サイトに表示されなくなります" : "（なし）")}</dd></div></dl>
        {impact.redirect && <><h3>リダイレクト</h3><p className="e-url-change">{impact.redirect.from} → {impact.redirect.to}</p></>}
        <h3>このページへのリンク</h3>
        {impact.linkedFrom.length ? <ul>{impact.linkedFrom.map((link, index) => <li key={index}>{link.title} · {link.count} 件</li>)}</ul> : <p className="e-help">リンク元はありません</p>}
        <h3>影響するナビゲーション</h3>{list(impact.navigation, "ありません")}
        {impact.notes.length > 0 && <><h3>注意事項</h3>{list(impact.notes, "")}</>}
      </div>
      <label className="e-check"><input type="checkbox" checked={confirmed} disabled={!!busy || unknown} onChange={(event) => setConfirmed(event.target.checked)} />影響を確認し、この変更を反映することに同意しました</label>
      {status}
      <div className="e-actions">{unknown ? <><button type="button" autoFocus className="e-primary" onClick={reload}>ページ一覧を再読込</button><button type="button" onClick={close}>閉じる</button></>
        : <><button type="button" autoFocus disabled={!!busy} onClick={() => { setPlan(null); setConfirmed(false); setMessage(""); }}>戻る</button>
          <button type="button" className={makePrivate ? "e-danger-primary" : "e-primary"} disabled={!confirmed || !!busy} onClick={() => void confirm()}>{makePrivate ? "非公開にする" : "変更を反映"}</button></>}</div>
    </>;
  }
  return <Dialog name={dialogTitle(start)} dismiss={() => { if (!busy) close(); }}>{body}</Dialog>;
}

type SiteForm = { title: string; description: string; imageSrc: string; imageAlt: string; favicon: string; locale: string; noindex: boolean };
const emptyForm: SiteForm = { title: "", description: "", imageSrc: "", imageAlt: "", favicon: "", locale: "", noindex: false };
const formFrom = (settings: SiteSettings): SiteForm => ({ title: settings.title, description: settings.description ?? "", imageSrc: settings.ogImage?.src ?? "", imageAlt: settings.ogImage?.alt ?? "",
  favicon: settings.favicon ?? "", locale: settings.locale, noindex: !!settings.noindex });
const settingsFrom = (form: SiteForm) => ({ title: form.title, ...(form.description.trim() ? { description: form.description } : {}), ...(form.imageSrc ? { ogImage: { src: form.imageSrc, alt: form.imageAlt } } : {}),
  ...(form.favicon ? { favicon: form.favicon } : {}), locale: form.locale, ...(form.noindex ? { noindex: true } : {}) });
export type SiteSettingsState = {
  /** readSiteSettings / saveSiteSettings をホストが実装しているか。 */
  supported: boolean; editable: boolean;
  status: "idle" | "loading" | "error" | "ready";
  /** 保存済みの設定。 */
  settings: SiteSettings | undefined;
  form: SiteForm; dirty: boolean; problem: string | undefined; canSave: boolean; busy: boolean;
  message: { text: string; alert: boolean } | null; conflict: boolean;
  edit: (patch: Partial<SiteForm>) => void; reset: () => void; reload: () => void; save: () => Promise<void>;
};
/** サイト設定は文書と別に、opaque な version の楽観ロックで保存する。 */
export function useSiteSettings(adapter: EditorAdapter, siteId: string): SiteSettingsState {
  const [loaded, setLoaded] = useState<{ siteId: string; settings: SiteSettings; version: string } | null>(null);
  const [status, setStatus] = useState<SiteSettingsState["status"]>("idle"), [form, setForm] = useState(emptyForm), [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<SiteSettingsState["message"]>(null), [conflict, setConflict] = useState(false);
  const saving = useRef<AbortController | null>(null);
  useEffect(() => {
    saving.current?.abort(); saving.current = null; setLoaded(null); setForm(emptyForm); setMessage(null); setConflict(false); setBusy(false);
    if (!siteId || !adapter.readSiteSettings) { setStatus("idle"); return; }
    const controller = new AbortController(); setStatus("loading");
    adapter.readSiteSettings(siteId, controller.signal).then((snapshot) => {
      if (controller.signal.aborted) return;
      if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("version is required");
      const settings = parseSiteSettings(snapshot.settings);
      setLoaded({ siteId, settings, version: snapshot.version }); setForm(formFrom(settings)); setStatus("ready");
    }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [adapter, siteId, epoch]);
  useEffect(() => () => saving.current?.abort(), []);
  const dirty = status === "ready" && !!loaded && JSON.stringify(form) !== JSON.stringify(formFrom(loaded.settings));
  let parsed: SiteSettings | undefined, problem: string | undefined;
  if (dirty) try { parsed = parseSiteSettings(settingsFrom(form)); } catch (error) { problem = publicInfoMessage(error) ?? "サイト設定の値を確認してください。"; }
  const editable = typeof adapter.saveSiteSettings === "function";
  async function save() {
    if (!loaded || !parsed || !adapter.saveSiteSettings || saving.current) return;
    const controller = new AbortController(), settings = parsed; saving.current = controller; setBusy(true); setMessage(null); setConflict(false);
    const failed = (error?: unknown) => {
      if (isConflict(error)) { setConflict(true); setMessage({ text: "サイト設定が競合しました（409）。入力を保持しています。", alert: true }); }
      else setMessage({ text: "サイト設定を保存できませんでした。入力を保持しています。", alert: true });
    };
    try {
      const result = await adapter.saveSiteSettings({ siteId: loaded.siteId, settings: structuredClone(settings), expectedVersion: loaded.version }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "conflict") { failed({ status: 409 }); return; }
      if (result.status !== "saved" || typeof result.version !== "string" || !result.version || result.version === loaded.version) throw new Error("version must advance");
      setLoaded({ siteId: loaded.siteId, settings, version: result.version }); setForm(formFrom(settings)); setMessage({ text: "サイト設定を保存しました。", alert: false });
    } catch (error) { if (!controller.signal.aborted) failed(error); }
    finally { if (saving.current === controller) { saving.current = null; setBusy(false); } }
  }
  return {
    supported: typeof adapter.readSiteSettings === "function", editable, status, settings: loaded?.settings, form, dirty, problem,
    canSave: editable && dirty && !!parsed && !busy, busy, message, conflict,
    edit: (patch) => { setForm((previous) => ({ ...previous, ...patch })); setMessage(null); },
    reset: () => { if (loaded) setForm(formFrom(loaded.settings)); setMessage(null); setConflict(false); },
    reload: () => setEpoch((value) => value + 1),
    save
  };
}

function TextInput({ label, value, change, disabled, multiline = false, placeholder }: { label: string; value: string; change: (value: string) => void; disabled: boolean; multiline?: boolean; placeholder?: string }) {
  const id = useId(), props = { id, value, disabled, placeholder, onChange: (event: { target: { value: string } }) => change(event.target.value) };
  return <label className="e-field" htmlFor={id}><span>{label}</span>{multiline ? <textarea {...props} rows={3} /> : <input {...props} />}</label>;
}
/** 右レール「サイト」タブの内容。サイト設定は文書と別に保存する。 */
export function SiteSettingsPanel({ site, state }: { site: EditorSite | undefined; state: SiteSettingsState }) {
  const { form, status } = state, locked = !state.editable || state.busy;
  return <>
    <section className="e-section"><h3>公開ドメイン</h3>{site && <p className="e-help">{site.name}</p>}
      {site?.domains.length ? <ul className="e-domains">{site.domains.map((domain) => <li key={domain}>{domain}</li>)}</ul> : <p className="e-help">公開ドメインはありません。</p>}
    </section>
    <section className="e-section"><h3>サイト共通の設定</h3>
      {!state.supported ? <p className="e-help">このサイトではサイト設定を編集できません。</p>
        : status === "error" ? <><p className="e-help e-problem" role="alert">サイト設定を読み込めませんでした。</p><button type="button" className="e-small" onClick={state.reload}>再試行</button></>
        : status !== "ready" ? <p className="e-help" role="status">サイト設定を読み込み中…</p>
        : <>
          <TextInput label="サイトタイトル" value={form.title} disabled={locked} change={(title) => state.edit({ title })} />
          <TextInput label="説明文" value={form.description} disabled={locked} multiline change={(description) => state.edit({ description: description.replace(/[\r\n]+/g, " ") })} />
          <h4>ソーシャルカバー</h4>
          <TextInput label="画像 URL" value={form.imageSrc} disabled={locked} placeholder="https://… または /images/cover.jpg" change={(imageSrc) => state.edit({ imageSrc })} />
          <TextInput label="画像の説明" value={form.imageAlt} disabled={locked || !form.imageSrc} change={(imageAlt) => state.edit({ imageAlt })} />
          <TextInput label="ファビコン URL" value={form.favicon} disabled={locked} change={(favicon) => state.edit({ favicon })} />
          <TextInput label="言語" value={form.locale} disabled={locked} placeholder="ja / ja-JP" change={(locale) => state.edit({ locale })} />
          <label className="e-check"><input type="checkbox" checked={form.noindex} disabled={locked} onChange={(event) => state.edit({ noindex: event.target.checked })} />サイト全体を検索エンジンに表示しない</label>
          {state.problem && <p className="e-help e-problem" role="alert">{state.problem}</p>}
          {state.message && <p className={state.message.alert ? "e-help e-problem" : "e-help"} role={state.message.alert ? "alert" : "status"}>{state.message.text}</p>}
          {state.conflict && <button type="button" className="e-small" disabled={state.busy} onClick={state.reload}>最新の設定を読み込む（入力を破棄）</button>}
          {state.editable ? <><div className="e-actions"><button type="button" className="e-primary" disabled={!state.canSave} onClick={() => void state.save()}>サイト設定を保存</button>
            <button type="button" disabled={!state.dirty || state.busy} onClick={state.reset}>変更を取り消す</button></div>
            <small className="e-help">保存したサイト設定は、次の公開で反映されます。</small></>
            : <small className="e-help">このサイトではサイト設定を表示だけできます。</small>}
        </>}
    </section>
  </>;
}

function SearchPreview({ metadata, url }: { metadata: PageMetadata | undefined; url: string | undefined }) {
  if (!metadata) return null;
  return <section className="e-section"><h3>検索結果での見え方</h3>
    <div className="e-serp">
      {url && <p className="e-serp-url">{url}</p>}
      <p className="e-serp-title">{metadata.title}</p>
      <p className="e-serp-desc">{metadata.description ?? "説明文が未設定です。"}</p>
    </div>
    {metadata.robots !== "index, follow" && <p className="e-help e-problem">検索エンジンには表示されません</p>}
  </section>;
}

/** 右レール「ページ」タブの内容。ページ操作は確認付き、公開情報は文書の編集として undo/redo の対象にする。 */
export function PageSettings({ document, page, site, settings, field, apply, report, disabled, operations, operationsDisabled, unsaved, start }: {
  document: PageDocument; page: EditorPage | undefined; site: EditorSite | undefined; settings: SiteSettingsState;
  field: FieldRenderer; apply: (operation: EditorOperation) => string | undefined; report: (message: string) => void; disabled: boolean;
  operations: boolean; operationsDisabled: boolean; unsaved: boolean; start: (start: PageChangeStart) => void;
}) {
  const meta = document.meta ?? {}, kind = page?.kind ?? "page", domain = site?.domains[0], path = publicPath(page);
  const canChange = operations && !!page && kind === "page", changeDisabled = disabled || operationsDisabled;
  const run = (operation: EditorOperation) => { const problem = apply(operation); if (problem) report(problem); };
  const offered = (site?.structuredData ?? []).filter((preset, index, all) => all.findIndex((other) => other.id === preset.id) === index);
  const selected = meta.structuredData ?? [], unsupported = selected.filter((value) => !offered.some((preset) => preset.id === value));
  const structured = (value: string, on: boolean) => run({ type: "meta", field: "structuredData", value: on ? [...selected.filter((other) => other !== value), value] : selected.filter((other) => other !== value) });
  const image = meta.ogImage, cover = image && (image.src.startsWith("https://") ? image.src : image.src.startsWith("/") && domain ? `${domain}${image.src}` : undefined);
  return <div className="e-page-settings">
      <section className="e-section">
        <div className="e-section-head"><h3>ページ設定</h3>{canChange && <button type="button" className="e-small" aria-label="ページ名とURLを変更" disabled={changeDisabled} onClick={() => start({ action: "update", page })}>変更</button>}</div>
        <dl className="e-rows">
          <div><dt>ページ名</dt><dd>{page?.title ?? "—"}</dd></div>
          <div><dt>パス</dt><dd>{page?.path ?? "未設定"}</dd></div>
          <div><dt>種類</dt><dd>{kindLabels[kind] ?? kind}</dd></div>
          {!canChange && <div><dt>公開状態</dt><dd>{page?.visibility === "private" ? "非公開" : page?.published === false ? "未公開" : "公開"}</dd></div>}
        </dl>
        {canChange && <button type="button" role="switch" className="e-switch" aria-checked={page.visibility === "private"} disabled={changeDisabled}
          onClick={() => start({ action: "visibility", page, visibility: page.visibility === "private" ? "public" : "private" })}>
          <span className="e-switch-track" aria-hidden="true"><span className="e-switch-thumb" /></span>ページを非公開にする</button>}
        {operations && page && kind !== "page" && <small className="e-help">テンプレートと共通枠はホストが管理します。</small>}
        {canChange && unsaved && <small className="e-help">未保存の変更を保存してから操作できます。</small>}
      </section>
      <section className="e-section"><h3>公開情報</h3>
        {field("ページタイトル", document.title, (value) => ({ type: "title", value }), "title")}
        {field("説明文", meta.description ?? "", (value) => ({ type: "meta", field: "description", value: value.trim() ? value.replace(/[\r\n]+/g, " ") : undefined }), "meta.description",
          { multiline: true, hint: (value) => `${value.length} / 500 · 検索結果に表示される文章です。` })}
        <h4>ソーシャルカバー</h4>
        {field("画像 URL", image?.src ?? "", (value) => ({ type: "meta", field: "ogImage", value: value ? { src: value, alt: image?.alt ?? "" } : undefined }), "meta.ogImage.src", { placeholder: "https://… または /images/cover.jpg" })}
        {image && field("画像の説明", image.alt, (value) => ({ type: "meta", field: "ogImage", value: { src: image.src, alt: value } }), "meta.ogImage.alt")}
        {cover && <img className="e-cover" src={cover} alt="" />}
        {field("ファビコン URL", meta.favicon ?? "", (value) => ({ type: "meta", field: "favicon", value: value || undefined }), "meta.favicon")}
        <label className="e-check"><input type="checkbox" checked={!!meta.noindex} disabled={disabled} onChange={(event) => run({ type: "meta", field: "noindex", value: event.target.checked })} />検索エンジンに表示しない（noindex）</label>
        {(offered.length > 0 || unsupported.length > 0) && <><h4>構造化データ</h4>
          {offered.map((preset) => <label className="e-check" key={preset.id}><input type="checkbox" checked={selected.includes(preset.id)} disabled={disabled} onChange={(event) => structured(preset.id, event.target.checked)} />
            <span>{preset.label}{preset.description && <small className="e-help">{preset.description}</small>}</span></label>)}
          {unsupported.map((value) => <div className="e-unsupported" key={value}><span>未対応: {value}</span><button type="button" className="e-small" aria-label={`${value} を外す`} disabled={disabled} onClick={() => structured(value, false)}>外す</button></div>)}
          <small className="e-help">中身はサイトのデータからホストが作成します。</small></>}
      </section>
      <SearchPreview metadata={metadataFor(document, page, domain, settings.settings)} url={domain && path ? pageUrl(domain, path) : undefined} />
  </div>;
}

/** 公開確認に添える公開URLと、検索結果に出る情報。rollback は戻す版の内容が手元に無いため URL だけを出す。 */
export function ReleaseSearchSummary({ document, page, domain, settings, rollback }: { document: PageDocument | undefined; page: EditorPage | undefined; domain: string; settings: SiteSettings | undefined; rollback: boolean }) {
  if (!document) return null;
  const path = publicPath(page), metadata = rollback ? undefined : metadataFor(document, page, domain, settings);
  return <>
    {path && <><p>公開URL</p><p className="e-release-url">{pageUrl(domain, path)}</p></>}
    {metadata && <div className="e-release-seo"><p>検索結果に出る情報</p><dl className="e-rows">
      <div><dt>タイトル</dt><dd>{metadata.title}</dd></div>
      <div><dt>説明文</dt><dd>{metadata.description ?? "（なし）"}</dd></div>
      <div><dt>検索エンジン</dt><dd>{metadata.robots === "index, follow" ? "表示する" : "表示しない（noindex）"}</dd></div>
    </dl></div>}
  </>;
}
