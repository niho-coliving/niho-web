import { useEffect, useMemo, useState } from "react";
import { PageEditor } from "../src/editor.js";
import { createProjectEditorAdapter } from "../src/project-editor-adapter.js";
import type { EditorAdapter, EditorReleasePlan, EditorReleaseRequest, EditorReleaseResult, EditorSaveResult, EditorSnapshot, EditorTarget } from "../src/editor-types.js";
import type { Project } from "../src/projects.js";
import { studioBuilderDefinition } from "./integration-builder.js";
import { projectRoutePath } from "./project-routes.mjs";
import { kamakuraAssetLibrary } from "./kamakura-assets.js";
import { createKamakuraEditorBlocks } from "./kamakura-editor-blocks.js";
import { KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, KAMAKURA_COMMON_PAGE_ID as COMMON_PAGE_ID, KAMAKURA_EDITOR_DOMAIN as DOMAIN, KAMAKURA_EDITOR_SITE_ID, KamakuraCatalogContractError, parseKamakuraCatalog } from "./kamakura-catalog.js";
import type { KamakuraCatalog } from "./kamakura-catalog.js";

const BASE = "/api/projects/project-kamakura/sites/kamakura/editor";
const CONFIRMATION_TOKEN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}){2}$/u;
type RequestMethod = "GET" | "POST" | "PUT";
type EditorApiStatus = { readonly status: number; readonly errorCode: string | null; readonly supportId: string | null };
type CatalogState = { readonly status: "loading" } | { readonly status: "error"; readonly code: number; readonly errorCode: string | null; readonly supportId: string | null } | { readonly status: "ready"; readonly value: KamakuraCatalog };

class EditorApiError extends Error {
  constructor(readonly status: number, readonly code: string | null = null, readonly supportId: string | null = null) {
    super(code === KAMAKURA_CATALOG_CONTRACT_ERROR_CODE ? "Kamakura catalog contract mismatch" : status === 401 ? "Cloudflare Access のセッションを確認してください。" : status === 403 ? "このプロジェクトの編集権限がありません。" : status === 404 ? "新形式のページが見つかりません。" : status === 503 ? "編集ブリッジを利用できません。" : "編集 API の要求を完了できませんでした。");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("編集 API の応答が正しくありません。");
  return value as Record<string, unknown>;
}

function readSupportId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) return null;
  return value;
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTarget(target: EditorTarget): EditorTarget {
  if (target.siteId !== KAMAKURA_EDITOR_SITE_ID || target.locale !== "ja" || !COMMON_PAGE_ID.test(target.pageId)) throw new Error("新形式の編集対象ではありません。");
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
  if (!response.ok) {
    const errorObject = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const errorCode = errorObject && typeof errorObject.error === "string"
      ? errorObject.error
      : null;
    throw new EditorApiError(response.status, errorCode, readSupportId(errorObject?.supportId));
  }
  return value;
}

function statusFromError(error: unknown): EditorApiStatus {
  if (error instanceof EditorApiError) return { status: error.status, errorCode: error.code, supportId: error.supportId };
  if (error instanceof KamakuraCatalogContractError) return { status: KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, errorCode: KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, supportId: null };
  return { status: 503, errorCode: null, supportId: null };
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

function createKamakuraAdapter(catalog: KamakuraCatalog, onStatus: (status: EditorApiStatus | null) => void): EditorAdapter {
  async function request<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      onStatus(null);
      return result;
    } catch (error) {
      if (!signal.aborted && error instanceof EditorApiError && error.status !== 409) onStatus(statusFromError(error));
      else if (!signal.aborted && !(error instanceof EditorApiError)) onStatus(statusFromError(error));
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

function EditorAlert({ status }: { readonly status: EditorApiStatus }) {
  const code = status.status;
  const catalogContractMismatch = status.errorCode === KAMAKURA_CATALOG_CONTRACT_ERROR_CODE;
  return <div className={`studio-editor-alert studio-editor-alert-${code}`} role="alert">
    <strong>{catalogContractMismatch ? "ページ一覧の形式を確認できません" : code === 401 ? "セッションの再確認が必要です" : code === 403 ? "編集権限を確認できません" : code === 404 ? "新形式ページが見つかりません" : code === 503 ? "サイト編集サービスに接続できません" : "編集 API の要求を完了できませんでした"}</strong>
    <span>{catalogContractMismatch ? "ページ一覧の形式に対応できません。編集内容は変更されていません。管理者がサイト側とStudio側の対応状態を確認してください。" : code === 401 ? "編集内容を保持したまま、別タブで Cloudflare Access に再ログインしてから再読込してください。" : code === 403 ? "D1 の Kamakura プロジェクト参加資格が削除または変更されています。Studio 管理者へ確認してください。" : code === 404 ? "ページ一覧を読み直し、新形式ページが存在することを確認してください。" : code === 503 ? "編集内容は変更されていません。時間をおいてから再試行してください。続く場合は管理者へ確認してください。" : "入力内容と接続状態を確認し、エディタ内から再試行してください。"}{status.supportId !== null && <><br />問い合わせID: <code>{status.supportId}</code></>}</span>
  </div>;
}

export function KamakuraEditor({ project, environment }: { readonly project: Project; readonly environment: string }) {
  if (environment !== "production") throw new Error("Kamakura editor environment is not registered");
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading" });
  const [status, setStatus] = useState<EditorApiStatus | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ status: "loading" });
    setStatus(null);
    void api(`${BASE}/catalog`, "GET", undefined, controller.signal)
      .then(parseKamakuraCatalog)
      .then((value) => { if (!controller.signal.aborted) { setCatalog({ status: "ready", value }); setStatus(null); } })
      .catch((error: unknown) => { if (!controller.signal.aborted) { const failure = statusFromError(error); setCatalog({ status: "error", code: failure.status, errorCode: failure.errorCode, supportId: failure.supportId }); } });
    return () => controller.abort();
  }, [reload]);
  const ready = catalog.status === "ready" ? catalog.value : null;
  const adapter = useMemo(() => ready ? createProjectEditorAdapter(createKamakuraAdapter(ready, setStatus), project) : null, [ready, project]);
  const blocks = useMemo(() => ready ? createKamakuraEditorBlocks(ready.blockContracts) : {}, [ready]);
  return <main className="studio-editor studio-kamakura-editor">
    {status !== null && <EditorAlert status={status} />}
    {catalog.status === "loading" && <section className="studio-kamakura-state" role="status"><p>ページを読み込んでいます…</p></section>}
    {catalog.status === "error" && <section className="studio-kamakura-state" role="alert"><h1>ページを読み込めませんでした</h1><p>{catalog.errorCode === KAMAKURA_CATALOG_CONTRACT_ERROR_CODE ? "ページ一覧の形式に対応できません。編集内容は変更されていません。管理者へ確認してください。" : "編集内容は変更されていません。接続状態を確認して再試行してください。"}</p>{catalog.supportId !== null && <p>問い合わせID: <code>{catalog.supportId}</code></p>}<button type="button" onClick={() => setReload((value) => value + 1)}>再試行</button></section>}
    {ready && (ready.pages.length === 0
      ? <section className="studio-kamakura-state"><h1>編集できるページはありません</h1><p>編集対象のページがありません。ページ一覧を再読み込みしてください。</p><button type="button" onClick={() => setReload((value) => value + 1)}>再読み込み</button></section>
      : adapter && <PageEditor adapter={adapter} blocks={blocks} assets={kamakuraAssetLibrary} insertableBlocks={[]} builder={studioBuilderDefinition} toolbarStart={<a href={projectRoutePath(window.location.pathname, project.id, project.site.id, "dashboard")} aria-label="ダッシュボードに戻る" title="ダッシュボードに戻る">←</a>} />)}
  </main>;
}
