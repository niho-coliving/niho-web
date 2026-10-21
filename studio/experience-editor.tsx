import { useMemo, useState, type CSSProperties } from "react";
import { PageEditor } from "../src/editor.js";
import { createProjectEditorAdapter } from "../src/project-editor-adapter.js";
import type { EditorAdapter, EditorBlockRegistry, EditorPage, EditorReleasePlan, EditorReleaseRequest, EditorReleaseResult, EditorSaveResult, EditorSite, EditorSnapshot, EditorTarget } from "../src/editor-types.js";
import type { Project } from "../src/projects.js";
import type { PublicPropValue } from "../src/types.js";
import { studioBuilderDefinition } from "./integration-builder.js";
import { projectRoutePath } from "./project-routes.mjs";

const BASE = "/api/projects/project-experience/sites/experience/editor";
const STAGING_BASE = "/api/projects/project-experience/sites/experience/editor-staging";
const DOMAIN = "https://experience.niho.life";
const PAGE_IDS = ["home", "experiences", "experience-detail", "booking", "host", "chrome"] as const;
const PAGE_ID_SET = new Set<string>(PAGE_IDS);
type Props = Record<string, PublicPropValue>;
type RequestMethod = "GET" | "POST" | "PUT";

class EditorApiError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? "Cloudflare Access のセッションを確認してください。" : status === 403 ? "このプロジェクトの編集権限がありません。" : status === 503 ? "編集ブリッジを利用できません。" : "編集 API の要求を完了できませんでした。");
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
  if (target.siteId !== "experience" || target.locale !== "en" || !PAGE_ID_SET.has(target.pageId)) throw new Error("編集対象が一致しません。");
  return { siteId: "experience", pageId: target.pageId, locale: "en" };
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

function parseSites(value: unknown): readonly EditorSite[] {
  const source = record(value);
  if (!Array.isArray(source.sites) || source.sites.length !== 1) throw new Error("編集対象のサイト情報が一致しません。");
  const site = record(source.sites[0]);
  if (site.id !== "experience" || site.name !== "NIHO Experience" || !Array.isArray(site.domains) || site.domains.length !== 1 || site.domains[0] !== DOMAIN) throw new Error("編集対象のサイト情報が一致しません。");
  return [{ id: "experience", name: "NIHO Experience", domains: [DOMAIN] }];
}

function parsePages(value: unknown): readonly EditorPage[] {
  const source = record(value);
  if (!Array.isArray(source.pages) || source.pages.length > PAGE_IDS.length) throw new Error("ページ一覧が正しくありません。");
  const pages = source.pages.map((entry): EditorPage => {
    const page = record(entry);
    if (page.siteId !== "experience" || page.locale !== "en" || typeof page.pageId !== "string" || !PAGE_ID_SET.has(page.pageId)) throw new Error("ページ一覧に対象外のページが含まれています。");
    const result: EditorPage = { siteId: "experience", pageId: page.pageId, locale: "en", title: line(page.title, 120) };
    if (page.path !== undefined) result.path = line(page.path, 160);
    if (page.kind !== undefined) {
      if (page.kind !== "page" && page.kind !== "template" && page.kind !== "shared") throw new Error("ページ一覧が正しくありません。");
      result.kind = page.kind;
    }
    if (page.visibility !== undefined) {
      if (page.visibility !== "public" && page.visibility !== "private") throw new Error("ページ一覧が正しくありません。");
      result.visibility = page.visibility;
    }
    if (page.published !== undefined) {
      if (typeof page.published !== "boolean") throw new Error("ページ一覧が正しくありません。");
      result.published = page.published;
    }
    return result;
  });
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length) throw new Error("ページ一覧が重複しています。");
  return pages;
}

function parseSnapshot(value: unknown, target: EditorTarget): EditorSnapshot {
  const source = record(value), document = record(source.document);
  const checked = validTarget(target);
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
  return target.siteId === request.target.siteId && target.pageId === request.target.pageId && target.locale === request.target.locale &&
    validVersion(plan.expectedVersion) && plan.expectedVersion === request.expectedVersion &&
    plan.action === request.action && plan.revision === request.revision && plan.domain === DOMAIN &&
    (plan.action === "publish" ? plan.revision === undefined : plan.action === "rollback" && Number.isSafeInteger(plan.revision) && plan.revision! > 0) &&
    typeof plan.confirmationToken === "string" && /^[A-Za-z0-9_-]{43}$/u.test(plan.confirmationToken) && Array.isArray(plan.changes) &&
    plan.changes.every((change) => !!change && typeof change.path === "string" && typeof change.before === "string" && typeof change.after === "string");
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

function createExperienceAdapter(onStatus: (status: number | null) => void, base: string): EditorAdapter {
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
    listSites: (signal) => request(signal, async () => parseSites(await api(`${base}/sites`, "GET", undefined, signal))),
    listPages: (siteId, signal) => request(signal, async () => {
      if (siteId !== "experience") throw new Error("編集対象のサイトがありません。");
      return parsePages(await api(`${base}/sites/experience/pages`, "GET", undefined, signal));
    }),
    readDocument: (target, signal) => request(signal, async () => parseSnapshot(await api(`${base}/sites/experience/pages/${validTarget(target).pageId}/en`, "GET", undefined, signal), target)),
    saveDraft: (input, signal) => conflict(() => request(signal, async () => {
      if (!validVersion(input.expectedVersion)) throw new Error("保存対象の版が正しくありません。");
      const target = validTarget(input.target);
      return parseSaved(await api(`${base}/sites/experience/pages/${target.pageId}/en/draft`, "PUT", { expectedVersion: input.expectedVersion, document: input.document }, signal));
    })),
    prepareRelease: (input, signal) => request(signal, async () => {
      const target = validTarget(input.target);
      const body = { expectedVersion: input.expectedVersion, action: input.action, ...(input.action === "rollback" ? { revision: input.revision } : {}) };
      return parsePlan(await api(`${base}/sites/experience/pages/${target.pageId}/en/release-plan`, "POST", body, signal), input);
    }),
    release: (plan, signal) => conflict(() => request(signal, async () => {
      if (!releaseMatches(plan, plan)) throw new Error("公開確認が不正です。再度確認してください。");
      const target = validTarget(plan.target);
      return parseReleased(await api(`${base}/sites/experience/pages/${target.pageId}/en/release`, "POST", { expectedVersion: plan.expectedVersion, confirmationToken: plan.confirmationToken }, signal), target);
    }))
  };
}

const text = (props: Props, key: string, fallback: string) => typeof props[key] === "string" && props[key].trim() ? props[key] : fallback;
const box: CSSProperties = { border: "1px solid #e6dfd2", borderRadius: 16, padding: 24, background: "#fbf8f2" };
const action: CSSProperties = { borderRadius: 24, padding: "12px 20px", background: "var(--niho-accent-ink)", color: "white", display: "inline-block" };

/** NIHO APIの7業務ブロックと同じ表示props。サンプルだけを描き、予約・決済・登録・API取得は実行しない。 */
const nihoExperiencePreviewBlocks = {
  ExperienceGrid: {
    label: "体験一覧",
    props: { heading: { type: "string", maxLength: 120 }, emptyMessage: { type: "string", maxLength: 200 }, columns: { type: "enum", values: ["two", "three"] } },
    component: (props: Props) => <section style={box}><h2>{text(props, "heading", "Experiences hosted by neighbors")}</h2><p>Layout sample · sample experiences</p><div style={{ display: "grid", gridTemplateColumns: `repeat(${props.columns === "two" ? 2 : 3}, minmax(0, 1fr))`, gap: 16 }}>
      {["A shared table", "A neighborhood walk", "Making by hand"].map((title) => <article key={title}><div style={{ aspectRatio: "4/3", borderRadius: 12, background: "#e6dfd2" }} /><h3>{title}</h3><p>Sample host · 料金・開催枠は公開サイトで取得</p></article>)}
    </div>{props.emptyMessage ? <p>{String(props.emptyMessage)}</p> : null}</section>
  },
  ExperienceDetail: {
    label: "体験詳細",
    props: { overviewHeading: { type: "string", maxLength: 120 }, detailsHeading: { type: "string", maxLength: 120 } },
    component: (props: Props) => <article style={box}><p>Layout sample · sample experience</p><h1>A day with local hosts</h1><div style={{ height: 160, background: "#e6dfd2", borderRadius: 12 }} /><h2>{text(props, "overviewHeading", "What you'll do")}</h2><p>公開済みの体験本文・販売者情報がここに入ります。</p><h2>{text(props, "detailsHeading", "How the time flows")}</h2><p>価格・開催枠・予約条件はNIHOで管理されます。</p></article>
  },
  BookingCTA: {
    label: "予約導線", props: { label: { type: "string", maxLength: 100 } },
    component: (props: Props) => <aside style={box}><h2>Choose your experience</h2><span style={action}>{text(props, "label", "Check dates and book")}</span><p>表示サンプルです。予約操作は実行しません。</p></aside>
  },
  BookingPanel: {
    label: "予約フォーム", props: {},
    component: () => <section style={box}><h2>Booking form preview</h2><p>日時・人数・料金・販売条件・送信は公開サイトと NIHO API が管理します。</p><p>この画面から予約や決済は実行できません。</p></section>
  },
  HostSignupCTA: {
    label: "提供者登録", props: { label: { type: "string", maxLength: 100 } },
    component: (props: Props) => <section style={box}><span style={action}>{text(props, "label", "Start with your NIHO account")}</span><p>登録先と受付状態は公開サイトの設定に従います。</p></section>
  },
  SiteHeader: {
    label: "共通ヘッダー", props: { brandLabel: { type: "string", maxLength: 80 }, exploreLabel: { type: "string", maxLength: 80 }, hostLabel: { type: "string", maxLength: 80 } },
    component: (props: Props) => <header style={{ ...box, display: "flex", flexWrap: "wrap", gap: 24, justifyContent: "space-between" }}><strong>{text(props, "brandLabel", "NIHO Experience")}</strong><span>{text(props, "exploreLabel", "Experiences")} · {text(props, "hostLabel", "Host with NIHO")}</span></header>
  },
  SiteFooter: {
    label: "共通フッター", props: { description: { type: "string", maxLength: 300 }, copyright: { type: "string", maxLength: 160 } },
    component: (props: Props) => <footer style={box}><strong>NIHO Experience</strong><p>{text(props, "description", "Small experiences hosted by people who live in Kamakura.")}</p><small>{text(props, "copyright", "")}</small></footer>
  }
} satisfies EditorBlockRegistry;

export function ExperienceEditor({ project, environment = "production" }: { readonly project: Project; readonly environment?: string }) {
  if (environment !== "production" && environment !== "staging") throw new Error("Experience editor environment is not registered");
  const [status, setStatus] = useState<number | null>(null);
  const base = environment === "staging" ? STAGING_BASE : BASE;
  const adapter = useMemo(() => createProjectEditorAdapter(createExperienceAdapter(setStatus, base), project), [base, project]);
  return <main className="studio-editor">
    {environment === "staging" && <aside className="studio-editor-note studio-editor-staging-note" role="status"><strong>STG環境</strong><span>読み書き・公開・復元は NIHO API STG に送信します。</span></aside>}
    {status !== null && <div className={`studio-editor-alert studio-editor-alert-${status}`} role="alert">
      <strong>{status === 401 ? "セッションの再確認が必要です" : status === 403 ? "編集権限を確認できません" : status === 503 ? "編集ブリッジを利用できません（503）" : "編集 API の要求を完了できませんでした"}</strong>
      <span>{status === 401 ? "編集内容を保持したまま、別タブで Cloudflare Access に再ログインしてから再読込してください。" : status === 403 ? "D1 の Experience プロジェクト参加資格が削除または変更されています。Studio 管理者へ確認してください。" : status === 503 ? "NIHO 側 editor API の反映状況と、Studio／NIHO API 両側の bridge secret 設定を管理者が確認してください。" : "入力内容と接続状態を確認し、エディタ内から再試行してください。"}</span>
    </div>}
    <PageEditor adapter={adapter} blocks={nihoExperiencePreviewBlocks} insertableBlocks={[]} builder={studioBuilderDefinition} toolbarStart={<a href={projectRoutePath(window.location.pathname, project.id, project.site.id, "dashboard")} aria-label="ダッシュボードに戻る" title="ダッシュボードに戻る">←</a>} />
  </main>;
}
