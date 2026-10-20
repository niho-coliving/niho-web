import { createRoot } from "react-dom/client";
import { PageEditor, type EditorAdapter, type EditorBlockRegistry, type EditorPage, type EditorPageChange, type EditorPageImpact, type EditorRevisionEntry } from "@niho/web/editor";
import { createBrowserRecoveryStore, diffDocuments } from "@niho/web/history";
import { findInternalLinks, findPathConflict, pageUrl, parseSiteSettings, rewriteInternalLinks, validatePagePath, type SiteSettings } from "@niho/web/pages";
import fixture from "./page.json";
import type { ElementNode, PageDocument, PageNode } from "@niho/web/core";
import { createMemoryAssetLibrary } from "./memory-asset-library.mjs";

/** editor-demo.mjs がサーバーで生成した、出所ごとの素材のメタデータ。 */
declare const DEMO_ASSET_SEED: Readonly<Record<"uploads" | "experience" | "stock", readonly Record<string, unknown>[]>>;

// 公開可能なインメモリ動作例。認証や本番 API には接続しない。
const domain = "https://demo.example.test", domains = [domain];
type Revision = { entry: EditorRevisionEntry; document: PageDocument };
/** revisions は古い順。版の識別子は opaque な値として返す。 */
type Entry = { page: EditorPage; draft: PageDocument; published: PageDocument | null; version: number; confirmedPlan: string | null; revisions: Revision[] };
const actor = "デモ編集者";
let nextRevision = 1;
function record(item: Entry, kind: EditorRevisionEntry["kind"], document: PageDocument, label?: string): EditorRevisionEntry {
  const entry: EditorRevisionEntry = { id: `rev-${nextRevision++}`, revision: document.revision, kind, createdAt: new Date().toISOString(), actor, ...(label ? { label } : {}) };
  item.revisions.push({ entry, document: structuredClone(document) }); return entry;
}
const text = (value: string): PageNode => ({ type: "text", text: value });
const link = (id: string, href: string, label: string): PageNode => ({ type: "element", id, tag: "a", attrs: { href }, children: [text(label)] });
function pageDocument(pageId: string, title: string, children: PageNode[]): PageDocument {
  return { schemaVersion: 1, siteId: "demo", pageId, locale: "ja-JP", revision: 1, title, tokens: structuredClone((fixture as PageDocument).tokens),
    body: [{ type: "element", id: "main", tag: "section", style: { base: { padding: { token: "space" }, fontFamily: { token: "bodyFont" } } }, children }] };
}
const home = structuredClone(fixture) as PageDocument;
(home.body[0] as ElementNode).children.push({ type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "seed-sea" }, attrs: { alt: "朝の海辺の景色" }, style: { base: { maxWidth: "100%", height: "auto", borderRadius: 12 } }, children: [] });
home.body.push({ type: "component", id: "notice", block: "PublicNotice", props: { heading: "今月のお知らせ", count: 3 }, style: { base: { marginTop: 24 } } }); home.revision++;
// 共通カラーとテキストスタイル（タブレット以上で文字サイズを上書き）の例。
home.tokens = { ...home.tokens, ink: { type: "color", value: "#172d25", label: "文字の色" }, brand: { type: "color", value: "#195640", label: "メイン" }, accent: { type: "color", value: "#f2b70533", label: "アクセント" } };
home.textStyles = {
  heading: { label: "見出し", base: { fontSize: 28, fontWeight: 700, lineHeight: 1.3 }, responsive: [{ minWidth: 768, declarations: { fontSize: 40 } }] },
  body: { label: "本文", base: { fontSize: 16, lineHeight: 1.8 }, responsive: [{ minWidth: 768, declarations: { fontSize: 17 } }] }
};
const [heading, lead] = (home.body[0] as ElementNode).children as ElementNode[];
heading!.style = { textStyle: "heading", base: { color: { token: "brand" } } };
lead!.style = { textStyle: "body" };
// 演出の例: ボタン風のリンクのホバー・フォーカス・押下中と、セクションの登場（動きを減らす設定では動かない）。
const cta = (home.body[0] as ElementNode).children[2] as ElementNode;
cta.style = { base: { display: "inline-block", padding: "10px 18px", borderRadius: 999, backgroundColor: { token: "brand" }, color: "#ffffff", transitionDuration: 200, transitionTimingFunction: "ease-out" },
  states: { hover: { backgroundColor: "#0f3d2c", translate: "0 -2px" }, focus: { backgroundColor: "#0f3d2c", translate: "0 -2px" }, active: { scale: 0.98 } } };
(home.body[0] as ElementNode).style!.appear = { effect: "fade-up", trigger: "load", duration: 700, delay: 0, easing: "ease-out" };
const seeds: [EditorPage, PageDocument][] = [
  [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" }, home],
  [{ siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about" }, pageDocument("about", "私たちについて", [
    { type: "element", id: "heading", tag: "h1", children: [text("私たちについて")] }, { type: "element", id: "lead", tag: "p", children: [text("海のそばで暮らす人の集まりです。")] },
    link("to_badminton", "/circles/badminton", "バドミントンの会")])],
  [{ siteId: "demo", pageId: "badminton", locale: "ja-JP", title: "バドミントン", path: "/circles/badminton" }, pageDocument("badminton", "バドミントンの会", [
    { type: "element", id: "heading", tag: "h1", children: [text("バドミントンの会")] }, link("to_about", "/about", "運営について"), link("to_home", "/", "ホームへ")])],
  [{ siteId: "demo", pageId: "kamakura_go", locale: "ja-JP", title: "鎌倉囲碁", path: "/circles/kamakura-go", visibility: "private" }, pageDocument("kamakura_go", "鎌倉囲碁の会", [
    { type: "element", id: "heading", tag: "h1", children: [text("鎌倉囲碁の会（準備中）")] }])],
  [{ siteId: "demo", pageId: "experience", locale: "ja-JP", title: "体験詳細", path: "/experiences/[slug]", kind: "template" }, pageDocument("experience", "体験の詳細", [
    { type: "element", id: "heading", tag: "h1", children: [text("体験の名前がここに入ります")] }])],
  [{ siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared" }, pageDocument("header", "ヘッダー", [
    { type: "element", id: "nav", tag: "nav", children: [link("nav_home", "/", "ホーム"), link("nav_about", "https://demo.example.test/about", "私たちについて")] }])]
];
const entries = new Map<string, Entry>(seeds.map(([page, document]) => [page.pageId, { page, draft: document, published: structuredClone(document), version: 1, confirmedPlan: null,
  revisions: [{ entry: { id: `rev-${nextRevision++}`, revision: document.revision, kind: "publish", createdAt: "2026-10-01T09:00:00+09:00", actor, label: "最初の公開" }, document: structuredClone(document) }] }]));
const recovery = createBrowserRecoveryStore({ scope: "demo-staff" });
let pageListVersion = 1, nextPage = 1, nextToken = 1;
const pageTokens = new Map<string, { change: string; listVersion: number }>();
let siteSettings: SiteSettings = { title: "デモサイト", description: "鎌倉の海のそばで暮らす人のための動作例です。", locale: "ja" }, settingsVersion = 1;

function entry(pageId: string): Entry {
  const found = entries.get(pageId);
  if (!found) throw new Error("not found");
  return found;
}
const listed = (item: Entry): EditorPage => ({ ...structuredClone(item.page), published: item.published !== null });
/** 公開・rollback した版だけを戻せる公開版として返す。 */
const releases = (item: Entry) => [...new Map(item.revisions.filter(({ entry }) => entry.kind === "publish" || entry.kind === "rollback")
  .map(({ entry }) => [entry.revision, { revision: entry.revision, label: `版 ${entry.revision}（${entry.label ?? (entry.kind === "rollback" ? "公開版に戻した版" : "公開")}）` }])).values()].reverse();
const snapshot = (item: Entry) => ({ document: item.draft, version: `draft-${item.version}`, releases: releases(item) });
const blank = (document: PageDocument): PageDocument => ({ schemaVersion: 1, siteId: document.siteId, pageId: document.pageId, locale: document.locale, revision: document.revision, title: "", tokens: {}, body: [] });
function releasedDocument(item: Entry, revision: number | undefined): PageDocument {
  const found = [...item.revisions].reverse().find(({ entry }) => entry.revision === revision && (entry.kind === "publish" || entry.kind === "rollback"));
  if (!found) throw new Error("revision not found");
  return found.document;
}
/** 変更要求を既知の項目だけで比較する。 */
function changeKey(change: EditorPageChange): string {
  const target = (value: { siteId: string; pageId: string; locale: string }) => [value.siteId, value.pageId, value.locale];
  return JSON.stringify(change.action === "create" ? [change.action, change.siteId, change.locale, change.title, change.path] : change.action === "duplicate" ? [change.action, ...target(change.source), change.title, change.path]
    : change.action === "update" ? [change.action, ...target(change.target), change.title, change.path] : [change.action, ...target(change.target), change.visibility]);
}
function linksTo(path: string, except: string): Pick<EditorPageImpact, "linkedFrom" | "navigation"> {
  const linkedFrom: EditorPageImpact["linkedFrom"][number][] = [], navigation: string[] = [];
  for (const item of entries.values()) {
    const count = item.page.pageId === except ? 0 : findInternalLinks(item.draft, path, domains).length;
    if (!count) continue;
    if (item.page.kind === "shared") navigation.push(item.page.title);
    else linkedFrom.push({ pageId: item.page.pageId, locale: item.page.locale, title: item.page.title, count });
  }
  return { linkedFrom, navigation };
}
/** ホスト側の再検証。予約パス・重複・テンプレートとの一致・ホスト管理の種類を拒否する。 */
function checkChange(change: EditorPageChange): void {
  const pages = [...entries.values()].map(listed);
  const target = change.action === "create" ? undefined : change.action === "duplicate" ? change.source : change.target;
  if ((target ? target.siteId : change.action === "create" ? change.siteId : "") !== "demo") throw new Error("forbidden");
  if (target && (entries.get(target.pageId)?.page.kind ?? "page") !== "page") throw new Error("host owned");
  if (change.action === "visibility") return;
  if (!change.title.trim() || validatePagePath(change.path) !== null || ["/admin", "/api"].some((reserved) => change.path === reserved || change.path.startsWith(`${reserved}/`)) ||
    findPathConflict(pages, { siteId: "demo", locale: "ja-JP", path: change.path, ...(change.action === "update" ? { exceptPageId: change.target.pageId } : {}) })) throw new Error("invalid path");
}

const blocks: EditorBlockRegistry = {
  PublicNotice: {
    label: "お知らせ",
    props: { heading: { type: "string", required: true }, count: { type: "number", required: true } },
    defaultProps: { heading: "新しいお知らせ", count: 3 }, lockedProps: { count: "公開データの件数です。ホスト側で管理します。" },
    // このブロックで変えられる見た目（余白・背景色・テキストスタイル）だけをインスペクタに出す。
    styleProperties: ["marginTop", "marginBottom", "backgroundColor", "textStyle"],
    component: ({ heading, count }) => <aside style={{ margin: 24, padding: 20, border: "1px solid #b8c9bd", borderRadius: 12 }}><strong>{heading}</strong><p>公開データ: {count} 件</p></aside>
  }
};
const adapter: EditorAdapter = {
  listSites: async () => [{ id: "demo", name: "デモサイト", domains, structuredData: [
    { id: "organization", label: "組織", description: "運営者の名前とロゴ" }, { id: "localBusiness", label: "店舗・施設", description: "住所と営業時間" }] }],
  listPages: async () => [...entries.values()].map(listed),
  readDocument: async (target) => snapshot(entry(target.pageId)),
  saveDraft: async (request) => {
    const item = entry(request.target.pageId);
    if (request.expectedVersion !== `draft-${item.version}`) return { status: "conflict" };
    item.draft = { ...structuredClone(request.document), revision: item.draft.revision + 1 }; item.version++; record(item, request.trigger === "autosave" ? "autosave" : "draft", item.draft);
    return { status: "saved", version: `draft-${item.version}`, revision: item.draft.revision };
  },
  prepareRelease: async (request) => {
    const item = entry(request.target.pageId);
    if (request.expectedVersion !== `draft-${item.version}`) throw new Error("conflict");
    item.confirmedPlan = `demo-confirm-${item.version}-${request.action}-${request.revision ?? ""}`;
    const after = request.action === "rollback" ? releasedDocument(item, request.revision) : item.draft;
    const changes = diffDocuments(item.published ?? blank(after), after);
    const header = entries.get("header")?.page;
    return { ...request, confirmationToken: item.confirmedPlan, domain, changes, ...(item.page.path && validatePagePath(item.page.path) === null ? { url: pageUrl(domain, item.page.path) } : {}),
      affected: [...(header && header.pageId !== item.page.pageId ? [{ kind: "shared" as const, name: header.title, detail: "全ページで共通のナビゲーションです。このページの公開では変わりません。" }] : []),
        { kind: "site" as const, name: "サイト共通の設定", detail: "保存済みのタイトル・説明文がこの公開で反映されます。" }] };
  },
  release: async (request) => {
    const item = entry(request.target.pageId);
    if (request.expectedVersion !== `draft-${item.version}` || request.confirmationToken !== item.confirmedPlan) return { status: "conflict" };
    item.confirmedPlan = null; if (request.action === "rollback") item.draft = { ...structuredClone(releasedDocument(item, request.revision)), revision: item.draft.revision + 1 };
    item.published = structuredClone(item.draft); item.version++;
    record(item, request.action, item.draft, request.action === "rollback" ? `版 ${request.revision} に戻した` : undefined);
    return { status: "released", snapshot: snapshot(item) };
  },
  listRevisions: async ({ target, cursor }) => {
    const all = [...entry(target.pageId).revisions].reverse().map(({ entry }) => structuredClone(entry)), start = cursor ? Number(cursor.replace("page-", "")) : 0;
    return { entries: all.slice(start, start + 5), ...(start + 5 < all.length ? { next: `page-${start + 5}` } : {}) };
  },
  readRevision: async ({ target, id }) => {
    const found = entry(target.pageId).revisions.find(({ entry }) => entry.id === id);
    if (!found) throw new Error("not found");
    return { document: structuredClone(found.document) };
  },
  createSnapshot: async ({ target, expectedVersion, label }) => {
    const item = entry(target.pageId);
    if (expectedVersion !== `draft-${item.version}`) return { status: "conflict" };
    return { status: "saved", entry: structuredClone(record(item, "snapshot", item.draft, label)) };
  },
  preparePageChange: async (change) => {
    checkChange(change);
    let impact: EditorPageImpact;
    if (change.action === "create" || change.action === "duplicate") impact = { after: pageUrl(domain, change.path), linkedFrom: [], navigation: [], notes: ["新しいページは未公開の下書きとして作成します。公開するまで sitemap に含めません。"] };
    else {
      const item = entry(change.target.pageId), path = item.page.path, before = path ? pageUrl(domain, path) : undefined;
      const links = path ? linksTo(path, item.page.pageId) : { linkedFrom: [], navigation: [] };
      if (change.action === "update") {
        const moved = path !== change.path, after = pageUrl(domain, change.path);
        impact = { ...(before ? { before } : {}), after, ...(moved && before && item.published ? { redirect: { from: before, to: after } } : {}), ...links,
          notes: moved ? ["リンク元の URL を新しいパスへ書き換えます。書き換えた文書は公開確認を経て反映します。", "sitemap と canonical の URL が変わります。"] : ["ページ名だけを変更します。"] };
      } else impact = change.visibility === "private"
        ? { ...(before ? { before } : {}), ...links, notes: ["公開サイトでは表示されなくなり、sitemap から外します。", "検索エンジンには noindex を返します。"] }
        : { ...(before ? { after: before } : {}), linkedFrom: [], navigation: [], notes: [item.published ? "公開済みの版を表示します。" : "まだ公開した版がありません。公開確認を経て表示されます。"] };
    }
    const confirmationToken = `demo-page-${nextToken++}`;
    pageTokens.set(confirmationToken, { change: changeKey(change), listVersion: pageListVersion });
    return { change, confirmationToken, domain, impact };
  },
  applyPageChange: async (plan) => {
    const token = pageTokens.get(plan.confirmationToken); pageTokens.delete(plan.confirmationToken);
    if (!token || token.change !== changeKey(plan.change) || token.listVersion !== pageListVersion) return { status: "conflict" };
    try { checkChange(plan.change); } catch { return { status: "conflict" }; }
    const change = plan.change;
    let result: Entry;
    if (change.action === "create" || change.action === "duplicate") {
      const pageId = `page_${nextPage++}`, source = change.action === "duplicate" ? entry(change.source.pageId) : undefined;
      const draft = source ? { ...structuredClone(source.draft), pageId, revision: 1 } : pageDocument(pageId, change.title, [{ type: "element", id: "heading", tag: "h1", children: [text(change.title)] }]);
      result = { page: { siteId: "demo", pageId, locale: "ja-JP", title: change.title, path: change.path }, draft, published: null, version: 1, confirmedPlan: null, revisions: [] };
      record(result, "draft", draft, change.action === "duplicate" ? "複製して作成" : "ページを作成"); entries.set(pageId, result);
    } else {
      result = entry(change.target.pageId);
      if (change.action === "visibility") result.page = { ...result.page, visibility: change.visibility };
      else {
        const from = result.page.path;
        result.page = { ...result.page, title: change.title, path: change.path };
        if (from && from !== change.path) for (const item of entries.values()) {
          if (!findInternalLinks(item.draft, from, domains).length) continue;
          item.draft = { ...rewriteInternalLinks(item.draft, from, change.path, domains), revision: item.draft.revision + 1 }; item.version++; record(item, "draft", item.draft, "リンク先の URL を更新");
        }
      }
    }
    pageListVersion++;
    return { status: "applied", page: listed(result) };
  },
  readSiteSettings: async () => ({ settings: structuredClone(siteSettings), version: `site-${settingsVersion}` }),
  saveSiteSettings: async (request) => {
    if (request.expectedVersion !== `site-${settingsVersion}`) return { status: "conflict" };
    siteSettings = parseSiteSettings(request.settings); settingsVersion++;
    return { status: "saved", version: `site-${settingsVersion}` };
  }
};
// 出所は3つ。体験写真は CMS 側の正本を参照するだけで、ここでは編集・削除しない。ストックは ?stock=connected のときだけ接続する。
const stockConnected = new URLSearchParams(location.search).get("stock") === "connected";
const closed = { upload: false, editMetadata: false, delete: false, folders: false, acquire: false };
const providers = [
  { id: "uploads", kind: "upload", label: "サイト", origin: "このサイトにアップロードした素材", status: "available", capabilities: { upload: true, editMetadata: true, delete: true, folders: true, acquire: false }, seed: DEMO_ASSET_SEED.uploads },
  { id: "experience", kind: "cms", label: "体験写真", origin: "NIHO の体験原稿で公開を許可された写真", terms: "体験の公開中だけ表示されます。写真の差し替え・非公開は体験原稿で行います。", status: "available", capabilities: closed, seed: DEMO_ASSET_SEED.experience },
  stockConnected
    ? { id: "stock", kind: "stock", label: "ストック", origin: "ライセンスを確認済みのストック素材", status: "available", capabilities: { ...closed, acquire: true }, seed: DEMO_ASSET_SEED.stock }
    : { id: "stock", kind: "stock", label: "ストック", origin: "ライセンスを確認済みのストック素材", status: "unavailable", unavailableReason: "ライセンス確認済みのストック素材はまだ接続されていません。", capabilities: closed }
];
// 素材の保存・配信だけをデモサーバーに任せ、一覧・使用状況・削除の可否はメモリ内で判定する。
const assets = createMemoryAssetLibrary({
  siteId: "demo", providers, folders: [{ id: "photos", name: "写真" }, { id: "documents", name: "資料" }], quota: { limitBytes: 1024 ** 3 },
  upload: { accept: ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "application/pdf"], maxBytes: 5 * 1024 * 1024 },
  documents: () => [...entries.values()].flatMap((item) => [
    { pageId: item.page.pageId, locale: item.page.locale, title: item.page.title, state: "draft", document: item.draft },
    ...(item.published ? [{ pageId: item.page.pageId, locale: item.page.locale, title: item.page.title, state: "published", document: item.published }] : [])
  ]),
  store: async (file: Blob, meta: { name: string; mimeType: string }) => {
    const response = await fetch("/demo-assets", { method: "POST", headers: { "content-type": meta.mimeType, "x-file-name": encodeURIComponent(meta.name) }, body: file });
    if (!response.ok) throw Object.assign(new Error("upload failed"), { status: response.status });
    return await response.json();
  }
});
createRoot(document.getElementById("root")!).render(<PageEditor adapter={adapter} blocks={blocks} assets={assets} autosave={{ delayMs: 1500 }} recovery={recovery} />);
