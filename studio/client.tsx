import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectDashboard } from "../src/project-dashboard.js";
import { ProjectDirectory } from "../src/project-directory.js";
import { parseProjectDirectoryResult, type ProjectDirectoryResult } from "../src/project-read-model.js";
import type { Project } from "../src/projects.js";

type Screen = { readonly kind: "directory" } | { readonly kind: "dashboard"; readonly projectId: string; readonly siteId: string };
type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "expired" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly directory: ProjectDirectoryResult };

class SessionExpiredError extends Error {}

function screenFromLocation(): Screen {
  const match = /^\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})\/?$/u.exec(window.location.pathname);
  return match ? { kind: "dashboard", projectId: match[1]!, siteId: match[2]! } : { kind: "directory" };
}

async function api(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method: "GET", credentials: "same-origin", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (response.status === 401) throw new SessionExpiredError("Access session expired");
  if (!response.ok || !response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Error("Studio API request failed");
  return response.json() as Promise<unknown>;
}

function Notice({ title, children, retry }: { readonly title: string; readonly children: string; readonly retry?: () => void }) {
  return <main className="studio-state"><p className="studio-kicker">NIHO WEB</p><h1>{title}</h1><p>{children}</p>{retry && <button type="button" onClick={retry}>再試行</button>}</main>;
}

function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [screen, setScreen] = useState<Screen>(screenFromLocation);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const expire = useCallback(() => setSession({ status: "expired" }), []);

  const loadSession = useCallback(() => {
    const controller = new AbortController();
    setSession({ status: "loading" });
    void api("/api/session", controller.signal)
      .then(() => api("/api/projects", controller.signal))
      .then((value) => parseProjectDirectoryResult(value, () => false))
      .then((directory) => setSession({ status: "ready", directory }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSession({ status: error instanceof SessionExpiredError ? "expired" : "error" });
      });
    return () => controller.abort();
  }, []);

  useEffect(loadSession, [loadSession]);
  useEffect(() => {
    const onPopState = () => { setPendingProject(null); setScreen(screenFromLocation()); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Screen) => {
    const path = next.kind === "directory" ? "/" : `/projects/${encodeURIComponent(next.projectId)}/sites/${encodeURIComponent(next.siteId)}`;
    window.history.pushState(null, "", path);
    setPendingProject(null);
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const directoryAdapter = useMemo(() => ({
    loadDirectory: async (signal: AbortSignal) => {
      try { return await api("/api/projects", signal); }
      catch (error) { if (error instanceof SessionExpiredError) expire(); throw error; }
    },
    isThumbnailUrlAllowed: () => false
  }), [expire]);

  const dashboardAdapter = useMemo(() => ({
    loadDashboard: async ({ projectId, siteId }: { readonly projectId: string; readonly siteId: string }, signal: AbortSignal) => {
      try { return await api(`/api/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}/dashboard`, signal); }
      catch (error) { if (error instanceof SessionExpiredError) expire(); throw error; }
    }
  }), [expire]);

  if (session.status === "loading") return <Notice title="Studio を準備しています">認証と参加プロジェクトを確認しています。</Notice>;
  if (session.status === "expired") return <Notice title="セッションの確認が必要です" retry={() => window.location.reload()}>Cloudflare Access から再度ログインしてください。</Notice>;
  if (session.status === "error") return <Notice title="Studio を読み込めませんでした" retry={loadSession}>時間をおいて再度お試しください。</Notice>;
  if (session.directory.status === "forbidden") return <Notice title="アクセス権がありません" retry={loadSession}>Studio 管理者にプロジェクト参加資格を確認してください。</Notice>;

  const selected = screen.kind === "dashboard"
    ? session.directory.entries.find(({ project }) => project.id === screen.projectId && project.site.id === screen.siteId)?.project
    : undefined;

  return <div className="studio-app">
    <header className="studio-shell-header"><a href="/" onClick={(event) => { event.preventDefault(); navigate({ kind: "directory" }); }}><span>NIHO</span> Web Studio</a><span className="studio-access">Protected by Access</span></header>
    <main className="studio-content">
      {screen.kind === "dashboard" && !selected
        ? <Notice title="プロジェクトを表示できません">プロジェクトが存在しないか、現在のアカウントには参加資格がありません。</Notice>
        : selected
          ? <ProjectDashboard
              project={selected}
              adapter={dashboardAdapter}
              onBackToProjects={() => navigate({ kind: "directory" })}
              onOpenEditor={setPendingProject}
              onOpenSettings={() => undefined}
              editorAction="pending"
              settingsAction="disabled"
            />
          : <ProjectDirectory
              adapter={directoryAdapter}
              onCreateProject={() => undefined}
              onOpenDashboard={(project) => navigate({ kind: "dashboard", projectId: project.id, siteId: project.site.id })}
              onOpenEditor={setPendingProject}
              createAction="disabled"
              editorAction="pending"
              memberDetails="hidden"
            />}
    </main>
    {pendingProject && <div className="studio-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingProject(null); }}>
      <section className="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-pending-title">
        <p className="studio-kicker">{pendingProject.site.name}</p><h2 id="editor-pending-title">エディター接続待ち</h2>
        <p>この Studio はプロジェクト移動と権限境界のみを提供します。サイト編集 API は Issue #69 / #70 で接続予定です。現在、編集・保存・公開はできません。</p>
        <button type="button" autoFocus onClick={() => setPendingProject(null)}>閉じる</button>
      </section>
    </div>}
  </div>;
}

const container = document.getElementById("root");
if (!container) throw new Error("Studio root element is missing");
createRoot(container).render(<App />);
