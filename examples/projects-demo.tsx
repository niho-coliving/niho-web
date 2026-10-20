import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PageEditor, type EditorAdapter } from "@niho/web/editor";
import { createProjectEditorAdapter } from "@niho/web/project-editor";
import { ProjectManager, type ProjectAdapter } from "@niho/web/project-manager";
import {
  addProject, addProjectMember, parseProjectCatalog,
  removeProjectMember, type Project, type ProjectCatalog, type ProjectMember
} from "@niho/web/projects";
import fixture from "./page.json";
import type { PageDocument } from "@niho/web/core";

// 公開可能な合成データだけを使う。認証・本番API・実ユーザー・永続ストレージには接続しない。
let catalog: ProjectCatalog = parseProjectCatalog({ projects: [
  {
    id: "project_kamakura", name: "鎌倉サイト計画",
    site: { id: "kamakura_site", name: "kamakura-site 対応例", domains: ["https://kamakura.example.test"] },
    members: [{ userId: "demo_shared", displayName: "共通デモメンバー" }, { userId: "demo_writer", displayName: "記事担当（架空）" }]
  },
  {
    id: "project_experience", name: "体験サイト計画",
    site: { id: "niho_experience_site", name: "niho-experience-site 対応例", domains: ["https://experience.example.test"] },
    members: [{ userId: "demo_shared", displayName: "共通デモメンバー" }, { userId: "demo_designer", displayName: "デザイン担当（架空）" }]
  }
] });
let catalogVersion = 1, idSequence = 1;
const documents = new Map<string, PageDocument>();
const documentVersions = new Map<string, number>();
for (const project of catalog.projects) {
  documents.set(project.site.id, { ...(structuredClone(fixture) as PageDocument), siteId: project.site.id, title: `${project.name} ホーム` });
  documentVersions.set(project.site.id, 1);
}
const snapshot = () => ({ catalog: structuredClone(catalog), version: `catalog-${catalogVersion}` });
function saved(next: ProjectCatalog) { catalog = next; catalogVersion++; return { status: "saved" as const, snapshot: snapshot() }; }

const accounts: Readonly<Record<string, ProjectMember>> = {
  "demo-shared": { userId: "demo_shared", displayName: "共通デモメンバー" },
  "demo-editor": { userId: "demo_editor", displayName: "編集担当（架空）" }
};

const projectAdapter: ProjectAdapter = {
  loadCatalog: async () => snapshot(),
  createProject: async ({ input, expectedVersion }) => {
    if (expectedVersion !== `catalog-${catalogVersion}`) return { status: "conflict" };
    const projectId = `project_demo_${idSequence}`, siteId = `site_demo_${idSequence++}`;
    const project = { id: projectId, name: input.name, site: { id: siteId, name: input.siteName, domains: input.domains }, members: [] };
    documents.set(siteId, { ...(structuredClone(fixture) as PageDocument), siteId, title: `${input.name} ホーム` }); documentVersions.set(siteId, 1);
    return saved(addProject(catalog, project));
  },
  resolveMember: async (inputIdentifier) => accounts[inputIdentifier] ? structuredClone(accounts[inputIdentifier]) : null,
  addMember: async ({ projectId, member, expectedVersion }) => {
    if (expectedVersion !== `catalog-${catalogVersion}`) return { status: "conflict" };
    const result = addProjectMember(catalog, projectId, member);
    return result.status === "unchanged" ? result : saved(result.catalog);
  },
  removeMember: async ({ projectId, userId, expectedVersion }) => {
    if (expectedVersion !== `catalog-${catalogVersion}`) return { status: "conflict" };
    const result = removeProjectMember(catalog, projectId, userId);
    return result.status === "unchanged" ? result : saved(result.catalog);
  }
};

const editorAdapter: EditorAdapter = {
  listSites: async () => catalog.projects.map((project) => project.site),
  listPages: async (siteId) => [{ siteId, pageId: "home", locale: "ja-JP", title: "ホーム" }],
  readDocument: async (target) => ({ document: { ...structuredClone(documents.get(target.siteId)!), pageId: target.pageId, locale: target.locale }, version: `document-${documentVersions.get(target.siteId)}` }),
  saveDraft: async ({ target, document, expectedVersion }) => {
    const version = documentVersions.get(target.siteId)!;
    if (expectedVersion !== `document-${version}`) return { status: "conflict" };
    const stored = { ...structuredClone(document), revision: document.revision + 1 }; documents.set(target.siteId, stored); documentVersions.set(target.siteId, version + 1);
    return { status: "saved", version: `document-${version + 1}`, revision: stored.revision };
  },
  prepareRelease: async (request) => {
    const site = catalog.projects.find((project) => project.site.id === request.target.siteId)!.site;
    const domain = site.domains[0]; if (!domain) throw new Error("公開先が設定されていません。");
    return { ...request, confirmationToken: `demo-${request.target.siteId}`, domain, changes: [{ path: "ページ", before: "メモリ内の公開内容", after: "メモリ内の下書き" }] };
  },
  release: async (plan) => ({ status: "released", snapshot: { document: structuredClone(documents.get(plan.target.siteId)!), version: `document-${documentVersions.get(plan.target.siteId)}` } })
};

function Demo() {
  const [opened, setOpened] = useState<Project | null>(null), [openNotice, setOpenNotice] = useState("");
  const scopedAdapter = useMemo(() => opened ? createProjectEditorAdapter(editorAdapter, opened) : null, [opened]);
  function open(project: Project) {
    if (opened && opened.id !== project.id) { setOpenNotice("デモでは編集中の内容を守るため、開いているエディターを自動で切り替えません。実ホストは未保存確認後に切り替えてください。"); return; }
    setOpenNotice(""); setOpened(project);
  }
  return <><ProjectManager adapter={projectAdapter} onOpenProject={open} />
    {openNotice && <p role="alert" style={{ font: "13px sans-serif", color: "#8d3026" }}>{openNotice}</p>}
    {opened && scopedAdapter && <section style={{ marginTop: 24 }}><h2 style={{ font: "700 18px sans-serif" }}>{opened.name}のページ編集</h2><p style={{ font: "13px sans-serif" }}>このエディター接続は選択したプロジェクトの1サイトだけに限定されています。</p><PageEditor adapter={scopedAdapter} /></section>}
  </>;
}

createRoot(document.getElementById("root")!).render(<Demo />);
