import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PageEditor, type EditorAdapter } from "@niho/web/editor";
import { createProjectEditorAdapter } from "@niho/web/project-editor";
import { ProjectManager, type ProjectAdapter } from "@niho/web/project-manager";
import { ProjectDirectory, type ProjectDirectoryAdapter } from "@niho/web/project-directory";
import { ProjectDashboard, type ProjectDashboardAdapter } from "@niho/web/project-dashboard";
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

// 表示用の値はProject正本と分ける。日時・解析値・画像はすべて公開可能な合成値。
const demoTime = "2026-10-20T09:00:00Z";
const directoryAdapter: ProjectDirectoryAdapter = {
  loadDirectory: async () => ({ status: "ready", entries: catalog.projects.map((project, index) => ({
    project,
    summary: {
      projectId: project.id, siteId: project.site.id,
      publicationStatus: index === 0 ? "published" : "unpublished",
      publishedUrl: index === 0 ? project.site.domains[0] ?? null : null,
      thumbnail: index < 2 ? { url: index === 0 ? "/preview-public.svg" : "/preview-draft.svg", alt: "合成サイトのプレビュー" } : null,
      updatedAt: index === 0 ? demoTime : null, lastAccessedAt: null
    }
  })) }),
  isThumbnailUrlAllowed: (url) => ["/preview-public.svg", "/preview-draft.svg"].includes(url)
};
const dashboardAdapter: ProjectDashboardAdapter = {
  loadDashboard: async ({ projectId, siteId }) => {
    const project = catalog.projects.find((value) => value.id === projectId && value.site.id === siteId);
    if (!project) return { status: "forbidden", projectId, siteId };
    const published = project.id === "project_kamakura";
    return {
      status: "ready", projectId, siteId, fetchedAt: demoTime,
      overview: { status: "ready", data: {
        publicationStatus: published ? "published" : "unpublished", publishedUrl: published ? project.site.domains[0] ?? null : null,
        lastPublishedAt: published ? demoTime : null, publishedPageCount: published ? 1 : 0, assetBytes: null,
        recentChanges: published ? [{ id: "demo_change", label: "合成ページの見出しを更新", changedAt: demoTime }] : []
      } },
      analytics: published ? { status: "ready", data: { period: { start: "2026-10-01T00:00:00Z", end: demoTime }, fetchedAt: demoTime, uniqueVisitors: 42, pageViews: 184 } } : { status: "disconnected" }
    };
  }
};

function DemoEditor({ project }: { project: Project }) {
  const scopedAdapter = useMemo(() => createProjectEditorAdapter(editorAdapter, project), [project]);
  return <PageEditor adapter={scopedAdapter} />;
}
function Demo() {
  const [screen, setScreen] = useState<"directory" | "dashboard" | "manager" | "editor" | "settings">("directory");
  const [selected, setSelected] = useState<Project | null>(null);
  const [editors, setEditors] = useState<readonly Project[]>([]);
  const [setting, setSetting] = useState<"site" | "analytics">("site");
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    const heading = Array.from(surface.current?.querySelectorAll<HTMLElement>("h1") ?? []).find((node) => !node.closest("[hidden]"));
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }, [screen, selected]);
  function openDashboard(project: Project) { setSelected(project); setScreen("dashboard"); }
  function openEditor(project: Project) {
    setSelected(project); setEditors((current) => current.some((value) => value.id === project.id) ? current : [...current, project]); setScreen("editor");
  }
  return <main ref={surface}>
    {screen === "directory" && <ProjectDirectory adapter={directoryAdapter} onCreateProject={() => setScreen("manager")} onOpenDashboard={openDashboard} onOpenEditor={openEditor} {...(selected ? { initialFocusProjectId: selected.id } : {})} />}
    {screen === "manager" && <><button type="button" onClick={() => setScreen("directory")}>‹ プロジェクト一覧</button><ProjectManager adapter={projectAdapter} onOpenProject={openDashboard} /></>}
    {screen === "dashboard" && selected && <ProjectDashboard project={selected} adapter={dashboardAdapter} onBackToProjects={() => setScreen("directory")} onOpenEditor={openEditor} onOpenSettings={(project, section) => { setSelected(project); setSetting(section); setScreen("settings"); }} />}
    {screen === "settings" && selected && <section style={{ background: "white", padding: 20, font: "14px/1.6 sans-serif" }}><button type="button" onClick={() => setScreen("dashboard")}>‹ ダッシュボード</button><h1>{setting === "analytics" ? "解析接続設定" : "サイト設定"}</h1><p>{selected.name}</p><p>このデモは設定の接続先を示すだけの合成画面です。実際の接続・認可・保存はホストが実装します。</p>{setting === "site" && <button type="button" onClick={() => setScreen("manager")}>作成・参加者管理</button>}</section>}
    {editors.map((project) => <section key={project.id} hidden={screen !== "editor" || selected?.id !== project.id}>
      <button type="button" onClick={() => setScreen("directory")}>‹ プロジェクト一覧</button><h1 style={{ font: "700 18px sans-serif" }}>{project.name}のページ編集</h1><DemoEditor project={project} />
    </section>)}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Demo />);
