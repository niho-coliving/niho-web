import { createRoot } from "react-dom/client";
import { PageEditor, type EditorAdapter, type EditorBlockRegistry } from "@niho/web/editor";
import fixture from "./page.json";
import type { PageDocument, PageNode } from "@niho/web/core";

// 公開可能なインメモリ動作例。認証や本番 API には接続しない。
let draft = structuredClone(fixture) as PageDocument;
draft.body.push({ type: "component", id: "notice", block: "PublicNotice", props: { heading: "今月のお知らせ", count: 3 } }); draft.revision++;
let published = structuredClone(draft), version = 1;
let confirmedPlan: string | null = null;
function summary(document: PageDocument): Record<string, string> {
  const values: Record<string, string> = { "ページタイトル": document.title }, layers: string[] = [];
  function visit(nodes: PageNode[], parent = "ページ"): void {
    nodes.forEach((node, index) => {
      if (node.type === "text") { values[`${parent} のテキスト ${index + 1}`] = node.text; return; }
      layers.push(`${node.id} (${node.type === "element" ? node.tag : node.block})`);
      values[`${node.id} の見た目`] = JSON.stringify(node.style ?? {});
      if (node.type === "element") { for (const [key, value] of Object.entries(node.attrs ?? {})) values[`${node.id} の ${key}`] = String(value); visit(node.children, node.id); }
      else for (const [key, value] of Object.entries(node.props)) values[`${node.id} の ${key}`] = String(value);
    });
  }
  visit(document.body); values["レイヤー構成"] = layers.join(" → "); return values;
}
const blocks: EditorBlockRegistry = {
  PublicNotice: {
    label: "お知らせ",
    props: { heading: { type: "string", required: true }, count: { type: "number", required: true } },
    defaultProps: { heading: "新しいお知らせ", count: 3 }, lockedProps: { count: "公開データの件数です。ホスト側で管理します。" },
    component: ({ heading, count }) => <aside style={{ margin: 24, padding: 20, border: "1px solid #b8c9bd", borderRadius: 12 }}><strong>{heading}</strong><p>公開データ: {count} 件</p></aside>
  }
};
const adapter: EditorAdapter = {
  listSites: async () => [{ id: "demo", name: "デモサイト", domains: ["https://demo.example.test"] }],
  listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }],
  readDocument: async () => ({ document: draft, version: `draft-${version}`, releases: [{ revision: 1, label: "デモの最初の公開版" }] }),
  saveDraft: async (request) => {
    if (request.expectedVersion !== `draft-${version}`) return { status: "conflict" };
    draft = { ...structuredClone(request.document), revision: draft.revision + 1 }; version++; return { status: "saved", version: `draft-${version}`, revision: draft.revision };
  },
  prepareRelease: async (request) => {
    if (request.expectedVersion !== `draft-${version}`) throw new Error("conflict");
    confirmedPlan = `demo-confirm-${version}-${request.action}`;
    const before = summary(published), after = summary(request.action === "rollback" ? fixture as PageDocument : draft);
    const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).map((path) => ({ path, before: before[path] ?? "（なし）", after: after[path] ?? "（なし）" }));
    return { ...request, confirmationToken: confirmedPlan, domain: "https://demo.example.test", changes };
  },
  release: async (request) => {
    if (request.expectedVersion !== `draft-${version}` || request.confirmationToken !== confirmedPlan) return { status: "conflict" };
    confirmedPlan = null; if (request.action === "rollback") draft = { ...structuredClone(fixture) as PageDocument, revision: draft.revision + 1 };
    published = structuredClone(draft); version++;
    return { status: "released", snapshot: { document: draft, version: `draft-${version}`, releases: [{ revision: 1, label: "デモの最初の公開版" }] } };
  }
};
createRoot(document.getElementById("root")!).render(<PageEditor adapter={adapter} blocks={blocks} />);
