import { useEffect, useMemo, useState } from "react";
import { PageEditor } from "../src/editor.js";
import { createProjectEditorAdapter } from "../src/project-editor-adapter.js";
import type { EditorAdapter, EditorPage, EditorReleasePlan, EditorReleaseRequest, EditorReleaseResult, EditorSaveResult, EditorSite, EditorSnapshot, EditorTarget } from "../src/editor-types.js";
import type { Project } from "../src/projects.js";

const BASE = "/api/projects/project-kamakura/sites/kamakura/editor";
const DOMAIN = "https://next-kamakura.niho.life";
const SITE_NAME = "鎌倉サイト（新サイト確認用）";
const COMMON_PAGE_ID = /^(?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59}$/u;
const CONFIRMATION_TOKEN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}){2}$/u;
type RequestMethod = "GET" | "POST" | "PUT";
type LegacyPage = { readonly name: string; readonly path: string };
type Catalog = {
  readonly project: { readonly id: "kamakura-site"; readonly name: "NIHO kamakura"; readonly site: EditorSite };
  readonly sites: readonly EditorSite[];
  readonly pages: readonly EditorPage[];
  readonly legacy: readonly LegacyPage[];
};
type CatalogState = { readonly status: "loading" } | { readonly status: "error"; readonly code: number } | { readonly status: "ready"; readonly value: Catalog };

class EditorApiError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? "Cloudflare Access のセッションを確認してください。" : status === 403 ? "このプロジェクトの編集権限がありません。" : status === 404 ? "新形式のページが見つかりません。" : status === 503 ? "編集ブリッジを利用できません。" : "編集 API の要求を完了できませんでした。");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("編集 API の応答が正しくありません。");
  return value as Record<string, unknown>;
}

function line(value: unknown, maximum = 200): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("編集 API の応答が正しくありません。");
  return value;
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTarget(target: EditorTarget): EditorTarget {
  if (target.siteId !== "kamakura" || target.locale !== "ja" || !COMMON_PAGE_ID.test(target.pageId)) throw new Error("新形式の編集対象ではありません。");
  return { siteId: "kamakura", pageId: target.pageId, locale: "ja" };
}

function pagePath(target: EditorTarget): string {
  return `${BASE}/${validTarget(target).pageId}`;
}

async function api(path: string, method: RequestMethod, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    throw error;
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new EditorApiError(503);
  const value = await response.json() as unknown;
  if (!response.ok) throw new EditorApiError(response.status);
  return value;
}

function parseSite(value: unknown): EditorSite {
  const site = record(value);
  if (site.id !== "kamakura" || site.name !== SITE_NAME || !Array.isArray(site.domains) || site.domains.length !== 1 || site.domains[0] !== DOMAIN) throw new Error("編集対象のサイト情報が一致しません。");
  return { id: "kamakura", name: SITE_NAME, domains: [DOMAIN] };
}

function parseCatalog(value: unknown): Catalog {
  const source = record(value), project = record(source.project);
  if (project.id !== "kamakura-site" || project.name !== "NIHO kamakura") throw new Error("編集対象のプロジェクト情報が一致しません。");
  const projectSite = parseSite(project.site);
  if (!Array.isArray(source.sites) || source.sites.length !== 1 || !Array.isArray(source.pages) || source.pages.length > 500 || !Array.isArray(source.legacy) || source.legacy.length > 5_000) throw new Error("ページ一覧が正しくありません。");
  const site = parseSite(source.sites[0]);
  const pages = source.pages.map((entry): EditorPage => {
    const page = record(entry);
    if (page.siteId !== "kamakura" || page.locale !== "ja" || typeof page.pageId !== "string" || !COMMON_PAGE_ID.test(page.pageId)) throw new Error("ページ一覧に対象外のページが含まれています。");
    return { siteId: "kamakura", pageId: page.pageId, locale: "ja", title: line(page.title, 120) };
  });
  const pathPattern = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u;
  const legacy = source.legacy.map((entry): LegacyPage => {
    const page = record(entry), name = line(page.name), path = line(page.path, 2_048);
    if (!pathPattern.test(path)) throw new Error("旧形式ページの一覧が正しくありません。");
    return { name, path };
  });
  if (new Set(pages.map(({ pageId }) => pageId)).size !== pages.length || new Set(legacy.map(({ name }) => name)).size !== legacy.length || new Set(legacy.map(({ path }) => path)).size !== legacy.length) throw new Error("ページ一覧が重複しています。");
  return { project: { id: "kamakura-site", name: "NIHO kamakura", site: projectSite }, sites: [site], pages, legacy };
}

function parseSnapshot(value: unknown, target: EditorTarget): EditorSnapshot {
  const source = record(value), document = record(source.document), checked = validTarget(target);
  if (document.siteId !== checked.siteId || document.pageId !== checked.pageId || document.locale !== checked.locale || !validVersion(source.version)) throw new Error("文書の対象または版が一致しません。");
  return structuredClone(value) as EditorSnapshot;
}

function parseSaved(value: unknown): Extract<EditorSaveResult, { status: "saved" }> {
  const source = record(value);
  if (source.status !== "saved" || !validVersion(source.version) || !Number.isSafeInteger(source.revision) || (source.revision as number) < 1) throw new Error("下書き保存の結果が正しくありません。");
  return { status: "saved", version: source.version, revision: source.revision as number };
}

function releaseMatches(plan: EditorReleasePlan, request: EditorReleaseRequest): boolean {
  let target: EditorTarget;
  try { target = validTarget(plan.target); validTarget(request.target); }
  catch { return false; }
  if (target.siteId !== request.target.siteId || target.pageId !== request.target.pageId || target.locale !== request.target.locale || !validVersion(plan.expectedVersion) || plan.expectedVersion !== request.expectedVersion || plan.action !== request.action || plan.revision !== request.revision || plan.domain !== DOMAIN) return false;
  if (plan.action === "publish" ? plan.revision !== undefined : plan.action !== "rollback" || !Number.isSafeInteger(plan.revision) || plan.revision! <= 0) return false;
  if (typeof plan.confirmationToken !== "string" || !CONFIRMATION_TOKEN.test(plan.confirmationToken) || !Array.isArray(plan.changes) || plan.changes.length > 81) return false;
  return plan.changes.every((change) => !!change && typeof change.path === "string" && change.path.length <= 512 && typeof change.before === "string" && change.before.length <= 1_200 && typeof change.after === "string" && change.after.length <= 1_200);
}

function parsePlan(value: unknown, request: EditorReleaseRequest): EditorReleasePlan {
  const plan = structuredClone(value) as EditorReleasePlan;
  if (!releaseMatches(plan, request)) throw new Error("公開確認の対象・版・操作・ドメインが一致しません。再度確認してください。");
  return plan;
}

function parseReleased(value: unknown, target: EditorTarget): Extract<EditorReleaseResult, { status: "released" }> {
  const source = record(value);
  if (source.status !== "released") throw new Error("公開結果が正しくありません。");
  return { status: "released", snapshot: parseSnapshot(source.snapshot, target) };
}

function createKamakuraAdapter(catalog: Catalog, onStatus: (status: number | null) => void): EditorAdapter {
  async function request<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      onStatus(null);
      return result;
    } catch (error) {
      if (!signal.aborted && error instanceof EditorApiError && error.status !== 409) onStatus(error.status);
      else if (!signal.aborted && !(error instanceof EditorApiError)) onStatus(503);
      throw error;
    }
  }
  async function conflict<T extends EditorSaveResult | EditorReleaseResult>(run: () => Promise<T>): Promise<T | { status: "conflict" }> {
    try { return await run(); }
    catch (error) { if (error instanceof EditorApiError && error.status === 409) return { status: "conflict" }; throw error; }
  }
  return {
    listSites: (signal) => request(signal, async () => catalog.sites),
    listPages: (siteId, signal) => request(signal, async () => {
      if (siteId !== "kamakura") throw new Error("編集対象のサイトがありません。");
      return catalog.pages;
    }),
    readDocument: (target, signal) => request(signal, async () => parseSnapshot(await api(pagePath(target), "GET", undefined, signal), target)),
    saveDraft: (input, signal) => conflict(() => request(signal, async () => {
      if (!validVersion(input.expectedVersion)) throw new Error("保存対象の版が正しくありません。");
      return parseSaved(await api(`${pagePath(input.target)}/draft`, "PUT", { expectedVersion: input.expectedVersion, document: input.document }, signal));
    })),
    prepareRelease: (input, signal) => request(signal, async () => {
      validTarget(input.target);
      if (!validVersion(input.expectedVersion) || (input.action === "publish" ? input.revision !== undefined : input.action !== "rollback" || !Number.isSafeInteger(input.revision) || input.revision! <= 0)) throw new Error("公開操作と版の指定が一致しません。");
      const body = { expectedVersion: input.expectedVersion, action: input.action, ...(input.action === "rollback" ? { revision: input.revision } : {}) };
      return parsePlan(await api(`${pagePath(input.target)}/release-plan`, "POST", body, signal), input);
    }),
    release: (plan, signal) => conflict(() => request(signal, async () => {
      if (!releaseMatches(plan, plan)) throw new Error("公開確認が不正です。再度確認してください。");
      return parseReleased(await api(`${pagePath(plan.target)}/release`, "POST", { expectedVersion: plan.expectedVersion, confirmationToken: plan.confirmationToken }, signal), plan.target);
    }))
  };
}

function EditorAlert({ status }: { readonly status: number }) {
  return <div className={`studio-editor-alert studio-editor-alert-${status}`} role="alert">
    <strong>{status === 401 ? "セッションの再確認が必要です" : status === 403 ? "編集権限を確認できません" : status === 404 ? "新形式ページが見つかりません" : status === 503 ? "編集ブリッジを利用できません（503）" : "編集 API の要求を完了できませんでした"}</strong>
    <span>{status === 401 ? "編集内容を保持したまま、別タブで Cloudflare Access に再ログインしてから再読込してください。" : status === 403 ? "D1 の Kamakura プロジェクト参加資格が削除または変更されています。Studio 管理者へ確認してください。" : status === 404 ? "ページ一覧を読み直し、新形式ページが存在することを確認してください。" : status === 503 ? "kamakura-site の内部 endpoint、service binding、両 Worker の bridge secret を管理者が確認してください。" : "入力内容と接続状態を確認し、エディタ内から再試行してください。"}</span>
  </div>;
}

export function KamakuraEditor({ project }: { readonly project: Project }) {
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [status, setStatus] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ status: "loading" });
    void api(`${BASE}/catalog`, "GET", undefined, controller.signal)
      .then(parseCatalog)
      .then((value) => { if (!controller.signal.aborted) { setCatalog({ status: "ready", value }); setStatus(null); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) { const code = error instanceof EditorApiError ? error.status : 503; setCatalog({ status: "error", code }); setStatus(code); } });
    return () => controller.abort();
  }, [reload]);
  const ready = catalog.status === "ready" ? catalog.value : null;
  const adapter = useMemo(() => ready ? createProjectEditorAdapter(createKamakuraAdapter(ready, setStatus), project) : null, [ready, project]);
  return <main className="studio-editor">
    <header className="studio-editor-heading">
      <div><p className="studio-kicker">NIHO KAMAKURA</p><h1>サイト編集</h1><p>新形式へ移行済みの共通ページだけを Studio で編集します。CMS と旧形式ページは従来の管理画面に残ります。</p></div>
      <a href={`/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}`}>ダッシュボードに戻る</a>
    </header>
    {status !== null && <EditorAlert status={status} />}
    {catalog.status === "loading" && <section className="studio-editor-note" role="status"><h2>ページ一覧を確認しています</h2><p>kamakura-site の新形式ページと旧形式ページを読み込んでいます。</p></section>}
    {catalog.status === "error" && <section className="studio-editor-note"><h2>ページ一覧を読み込めませんでした</h2><p>編集内容は変更されていません。接続設定を確認して再試行してください。</p><button type="button" onClick={() => setReload((value) => value + 1)}>再試行</button></section>}
    {ready && <>
      <section className="studio-editor-note studio-kamakura-scope">
        <div><h2>編集範囲</h2><p>Studio が保存・公開するのは <strong>新形式ページ {ready.pages.length}件</strong>だけです。旧 STUDIO ページの移行は別作業で、記事・サークル・会社などの CMS データはここから変更しません。</p></div>
        <nav aria-label="従来の管理画面"><a href={`${DOMAIN}/admin/pages`} target="_blank" rel="noreferrer">旧形式のデザイン編集を開く</a><a href={`${DOMAIN}/admin`} target="_blank" rel="noreferrer">CMS 管理を開く</a></nav>
      </section>
      {ready.pages.length === 0 && <section className="studio-editor-note studio-editor-empty"><h2>新形式ページはまだありません</h2><p>現在の公開ページは旧形式のままです。#42 のページ移行が完了すると、対象ページがこの画面に表示され、下書き・公開・復元を利用できます。</p></section>}
      <section className="studio-legacy-pages" aria-labelledby="legacy-pages-title">
        <div><h2 id="legacy-pages-title">旧形式ページ（読み取り専用）</h2><p>一覧は確認用です。編集は上の「旧形式のデザイン編集を開く」から行ってください。</p></div>
        {ready.legacy.length === 0 ? <p>旧形式ページはありません。</p> : <ul>{ready.legacy.map((page) => <li key={page.name}><span>{page.name}</span><code>{page.path}</code></li>)}</ul>}
      </section>
      {adapter && ready.pages.length > 0 && <PageEditor adapter={adapter} insertableBlocks={[]} />}
    </>}
  </main>;
}
