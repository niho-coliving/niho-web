import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectDashboard } from "../src/project-dashboard.js";
import { ProjectDirectory } from "../src/project-directory.js";
import { parseProjectDirectoryResult, type ProjectDirectoryResult } from "../src/project-read-model.js";
import type { Project } from "../src/projects.js";
import { parseProjectAliasPath, projectRoutePath } from "./project-routes.mjs";
import { ExperienceEditor } from "./experience-editor.js";
import { KamakuraEditor } from "./kamakura-editor.js";

type Role = "owner" | "editor";
type Screen =
  | { readonly kind: "directory" }
  | { readonly kind: "dashboard"; readonly projectId: string; readonly siteId: string }
  | { readonly kind: "editor"; readonly projectId: string; readonly siteId: string; readonly staging: boolean }
  | { readonly kind: "invite"; readonly projectId: string; readonly siteId: string; readonly token: string };
type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "expired" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly directory: ProjectDirectoryResult; readonly identity: { readonly subject: string; readonly email: string } };
type Member = {
  readonly subject: string;
  readonly email: string | null;
  readonly role: Role;
  readonly displayName: string;
  readonly createdAt: string;
  readonly isCurrent: boolean;
};
type Invitation = {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "expired" | "accepted" | "revoked";
};
type Administration = {
  readonly projectName: string;
  readonly siteName: string;
  readonly members: readonly Member[];
  readonly invitations: readonly Invitation[];
};
type InvitationPreview = {
  readonly projectName: string;
  readonly siteName: string;
  readonly role: Role;
  readonly expiresAt: string;
};
type AdministrationState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly value: Administration };
type InvitationState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "accepting" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly value: InvitationPreview };

class SessionExpiredError extends Error {}
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function screenFromLocation(): Screen {
  const projectAlias = parseProjectAliasPath(window.location.pathname);
  if (projectAlias) {
    return projectAlias.page === "editor"
      ? { kind: "editor", projectId: projectAlias.projectId, siteId: projectAlias.siteId, staging: false }
      : { kind: "dashboard", projectId: projectAlias.projectId, siteId: projectAlias.siteId };
  }
  const invite = /^\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})\/invite\/?$/u.exec(window.location.pathname);
  if (invite) {
    const token = new URLSearchParams(window.location.search).get("token") ?? new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    return { kind: "invite", projectId: invite[1]!, siteId: invite[2]!, token };
  }
  if (/^\/projects\/project-experience\/sites\/experience\/editor\/staging\/?$/u.test(window.location.pathname)) {
    return { kind: "editor", projectId: "project-experience", siteId: "experience", staging: true };
  }
  const editor = /^\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})\/editor\/?$/u.exec(window.location.pathname);
  if (editor) return { kind: "editor", projectId: editor[1]!, siteId: editor[2]!, staging: false };
  const dashboard = /^\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})\/?$/u.exec(window.location.pathname);
  return dashboard ? { kind: "dashboard", projectId: dashboard[1]!, siteId: dashboard[2]! } : { kind: "directory" };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid API response");
  return value as Record<string, unknown>;
}

async function api(path: string, options: { readonly method?: "GET" | "POST"; readonly body?: Record<string, unknown>; readonly signal?: AbortSignal } = {}): Promise<unknown> {
  const method = options.method ?? "GET";
  const response = await fetch(path, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: method === "POST" ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });
  if (response.status === 401) throw new SessionExpiredError("Access session expired");
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Error("Studio API request failed");
  const value = await response.json() as unknown;
  if (!response.ok) {
    const error = record(value).error;
    throw new ApiError(response.status, typeof error === "string" ? error : "request_failed");
  }
  return value;
}

function text(value: unknown, maximum = 254): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("invalid API response");
  return value;
}

function role(value: unknown): Role {
  if (value !== "owner" && value !== "editor") throw new Error("invalid API response");
  return value;
}

function timestamp(value: unknown): string {
  const parsed = text(value, 40);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error("invalid API response");
  return parsed;
}

function parseAdministration(value: unknown): Administration {
  const source = record(value);
  if (source.status !== "ready" || !Array.isArray(source.members) || !Array.isArray(source.invitations) || source.members.length > 500 || source.invitations.length > 100) throw new Error("invalid API response");
  const members = source.members.map((entry): Member => {
    const member = record(entry);
    return {
      subject: text(member.subject, 128),
      email: member.email === null ? null : text(member.email),
      role: role(member.role),
      displayName: text(member.displayName, 120),
      createdAt: text(member.createdAt, 40),
      isCurrent: member.isCurrent === true
    };
  });
  const invitations = source.invitations.map((entry): Invitation => {
    const invitation = record(entry);
    if (!(["pending", "expired", "accepted", "revoked"] as const).includes(invitation.status as Invitation["status"])) throw new Error("invalid API response");
    return {
      id: text(invitation.id, 64),
      email: text(invitation.email),
      role: role(invitation.role),
      createdAt: timestamp(invitation.createdAt),
      expiresAt: timestamp(invitation.expiresAt),
      status: invitation.status as Invitation["status"]
    };
  });
  return { projectName: text(source.projectName, 120), siteName: text(source.siteName, 120), members, invitations };
}

function parseInvitationPreview(value: unknown): InvitationPreview {
  const source = record(value);
  if (source.status !== "ready") throw new Error("invalid API response");
  const invitation = record(source.invitation);
  return { projectName: text(invitation.projectName, 120), siteName: text(invitation.siteName, 120), role: role(invitation.role), expiresAt: timestamp(invitation.expiresAt) };
}

function parseIdentity(value: unknown): { readonly subject: string; readonly email: string } {
  const source = record(value);
  if (source.status !== "authenticated") throw new Error("invalid API response");
  return { subject: text(source.subject, 128), email: text(source.email) };
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function roleLabel(value: Role): string { return value === "owner" ? "オーナー" : "編集者"; }

function editorEnabled(project: Project): boolean {
  return (project.id === "project-kamakura" && project.site.id === "kamakura")
    || (project.id === "project-experience" && project.site.id === "experience");
}

function Notice({ title, children, retry }: { readonly title: string; readonly children: string; readonly retry?: () => void }) {
  return <main className="studio-state"><p className="studio-kicker">NIHO WEB</p><h1>{title}</h1><p>{children}</p>{retry && <button type="button" onClick={retry}>再試行</button>}</main>;
}

function MemberAdministration({ project, expire }: { readonly project: Project; readonly expire: () => void }) {
  const [state, setState] = useState<AdministrationState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [expiry, setExpiry] = useState(7);
  const [invitationUrl, setInvitationUrl] = useState("");
  const base = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}`;

  const load = useCallback((signal?: AbortSignal) => {
    setState({ status: "loading" });
    void api(`${base}/membership`, signal ? { signal } : {})
      .then(parseAdministration)
      .then((value) => setState({ status: "ready", value }))
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        if (error instanceof SessionExpiredError) { expire(); return; }
        if (error instanceof ApiError && error.status === 403) { setState({ status: "hidden" }); return; }
        setState({ status: "error" });
      });
  }, [base, expire]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const mutate = useCallback(async (path: string, body: Record<string, unknown>, successMessage: string) => {
    setBusy(true);
    setMessage("");
    try {
      await api(`${base}${path}`, { method: "POST", body });
      setMessage(successMessage);
      load();
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.code === "final_owner_required") setMessage("最後のオーナーは降格・削除できません。");
      else if (error instanceof ApiError && error.status === 403) { setState({ status: "hidden" }); setMessage(""); }
      else setMessage("操作を完了できませんでした。最新の状態を確認して再度お試しください。");
    } finally { setBusy(false); }
  }, [base, expire, load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setInvitationUrl("");
    try {
      const response = record(await api(`${base}/invitations`, { method: "POST", body: { email, role: inviteRole, expiresInDays: expiry } }));
      const url = text(response.invitationUrl, 2048);
      setInvitationUrl(url);
      setEmail("");
      setMessage("招待を作成しました。この画面で一度だけ表示される URL を安全に共有してください。");
      load();
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 403) { setState({ status: "hidden" }); setMessage(""); }
      else setMessage("招待を作成できませんでした。入力と最新の権限を確認してください。");
    } finally { setBusy(false); }
  };

  if (state.status === "hidden") return null;
  if (state.status === "loading") return <section className="studio-members studio-members-loading" aria-live="polite">メンバー管理を確認しています。</section>;
  if (state.status === "error") return <section className="studio-members"><div className="studio-section-heading"><div><p className="studio-kicker">ACCESS</p><h2>メンバー管理</h2></div><button type="button" onClick={() => load()}>再読込</button></div><p role="alert">メンバー情報を取得できませんでした。</p></section>;
  const value = state.value;
  return <section className="studio-members" aria-label="メンバー管理">
    <div className="studio-section-heading"><div><p className="studio-kicker">ACCESS</p><h2>メンバー管理</h2><p>{value.projectName} / {value.siteName}</p></div><button type="button" className="studio-secondary" onClick={() => load()} disabled={busy}>再読込</button></div>
    {message && <p className="studio-message" role="status">{message}</p>}
    <form className="studio-invite-form" onSubmit={(event) => { void create(event); }}>
      <label><span>招待するメールアドレス</span><input type="email" required maxLength={254} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
      <label><span>権限</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}><option value="editor">編集者</option><option value="owner">オーナー</option></select></label>
      <label><span>有効期間</span><select value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}><option value={1}>1日</option><option value={3}>3日</option><option value={7}>7日</option></select></label>
      <button type="submit" disabled={busy}>招待 URL を作成</button>
    </form>
    <p className="studio-help">メールは送信されません。本人が Cloudflare Access で同じメールアドレスにログインし、URL から明示的に承諾すると参加します。</p>
    {invitationUrl && <div className="studio-copy"><label><span>一度だけ表示される招待 URL</span><input readOnly value={invitationUrl} onFocus={(event) => event.currentTarget.select()} /></label><button type="button" onClick={() => { void navigator.clipboard.writeText(invitationUrl).then(() => setMessage("招待 URL をコピーしました。")).catch(() => setMessage("URL 欄を選択してコピーしてください。")); }}>コピー</button></div>}
    <div className="studio-admin-grid">
      <section><h3>参加メンバー</h3><ul className="studio-admin-list">{value.members.map((member) => <li key={member.subject}>
        <div><strong>{member.displayName}</strong>{member.isCurrent && <span className="studio-you">自分</span>}<small>{member.email ?? "メール未登録（bootstrap）"}</small></div>
        <div className="studio-row-actions"><span className={`studio-role studio-role-${member.role}`}>{roleLabel(member.role)}</span><button type="button" className="studio-secondary" disabled={busy} onClick={() => { const next = member.role === "owner" ? "editor" : "owner"; if (window.confirm(`${member.displayName} を${roleLabel(next)}に変更しますか？`)) void mutate("/members/role", { subject: member.subject, role: next }, "権限を変更しました。"); }}>{member.role === "owner" ? "編集者に変更" : "オーナーに変更"}</button><button type="button" className="studio-danger" disabled={busy} onClick={() => { if (window.confirm(`${member.displayName} をプロジェクトから削除しますか？`)) void mutate("/members/remove", { subject: member.subject }, "メンバーを削除しました。"); }}>削除</button></div>
      </li>)}</ul></section>
      <section><h3>招待履歴</h3>{value.invitations.length === 0 ? <p className="studio-help">招待はまだありません。</p> : <ul className="studio-admin-list">{value.invitations.map((invitation) => <li key={invitation.id}>
        <div><strong>{invitation.email}</strong><small>{roleLabel(invitation.role)} ・ 期限 {dateLabel(invitation.expiresAt)}</small></div>
        <div className="studio-row-actions"><span className={`studio-status studio-status-${invitation.status}`}>{{ pending: "承諾待ち", expired: "期限切れ", accepted: "承諾済み", revoked: "取消済み" }[invitation.status]}</span>{invitation.status === "pending" && <button type="button" className="studio-danger" disabled={busy} onClick={() => { if (window.confirm(`${invitation.email} への招待を取り消しますか？`)) void mutate("/invitations/revoke", { invitationId: invitation.id }, "招待を取り消しました。"); }}>取消</button>}</div>
      </li>)}</ul>}</section>
    </div>
  </section>;
}

function InvitationAcceptance({ screen, expire, accepted }: { readonly screen: Extract<Screen, { kind: "invite" }>; readonly expire: () => void; readonly accepted: () => void }) {
  const [state, setState] = useState<InvitationState>({ status: "loading" });
  const base = `/api/projects/${encodeURIComponent(screen.projectId)}/sites/${encodeURIComponent(screen.siteId)}/invitations`;
  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(screen.token)) { setState({ status: "unavailable" }); return; }
    const controller = new AbortController();
    void api(`${base}/preview`, { method: "POST", body: { token: screen.token }, signal: controller.signal })
      .then(parseInvitationPreview)
      .then((value) => setState({ status: "ready", value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof SessionExpiredError) expire();
        else if (error instanceof ApiError && (error.status === 404 || error.status === 409)) setState({ status: "unavailable" });
        else setState({ status: "error" });
      });
    return () => controller.abort();
  }, [base, expire, screen.token]);

  const accept = async () => {
    setState({ status: "accepting" });
    try {
      await api(`${base}/accept`, { method: "POST", body: { token: screen.token } });
      accepted();
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && (error.status === 404 || error.status === 409)) setState({ status: "unavailable" });
      else setState({ status: "error" });
    }
  };

  if (state.status === "loading") return <Notice title="招待を確認しています">ログイン中のメールアドレスと招待を照合しています。</Notice>;
  if (state.status === "accepting") return <Notice title="参加処理を進めています">招待を一度だけ使用し、メンバー登録しています。</Notice>;
  if (state.status === "unavailable") return <Notice title="この招待は利用できません">宛先が異なるか、期限切れ・承諾済み・取消済みの招待です。オーナーへ新しい招待を依頼してください。</Notice>;
  if (state.status === "error") return <Notice title="招待を確認できませんでした">時間をおいて、受け取った URL から再度お試しください。</Notice>;
  return <main className="studio-state studio-invite-accept"><p className="studio-kicker">STUDIO INVITATION</p><h1>{state.value.projectName} に参加</h1><p>{state.value.siteName} の <strong>{roleLabel(state.value.role)}</strong> として招待されています。</p><dl><div><dt>有効期限</dt><dd>{dateLabel(state.value.expiresAt)}</dd></div></dl><p>参加するには、下のボタンで招待を明示的に承諾してください。招待は一度だけ使用できます。</p><button type="button" onClick={() => { void accept(); }}>招待を承諾する</button></main>;
}

function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [screen, setScreen] = useState<Screen>(screenFromLocation);
  const [pendingProject, setPendingProject] = useState<Project | null>(null);
  const expire = useCallback(() => setSession({ status: "expired" }), []);

  const loadSession = useCallback(() => {
    const controller = new AbortController();
    setSession({ status: "loading" });
    void api("/api/session", { signal: controller.signal })
      .then(async (value) => ({ identity: parseIdentity(value), directory: parseProjectDirectoryResult(await api("/api/projects", { signal: controller.signal }), () => false) }))
      .then(({ identity, directory }) => setSession({ status: "ready", directory, identity }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSession({ status: error instanceof SessionExpiredError ? "expired" : "error" });
      });
    return () => controller.abort();
  }, []);

  useEffect(loadSession, [loadSession]);
  useEffect(() => {
    if (screen.kind === "invite" && (window.location.search || window.location.hash)) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [screen]);
  useEffect(() => {
    const onPopState = () => { setPendingProject(null); setScreen(screenFromLocation()); };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: Exclude<Screen, { kind: "invite" }>) => {
    const path = next.kind === "directory"
      ? "/"
      : next.kind === "editor" && next.staging
        ? "/projects/project-experience/sites/experience/editor/staging"
        : projectRoutePath(window.location.pathname, next.projectId, next.siteId, next.kind === "editor" ? "editor" : "dashboard");
    window.history.pushState(null, "", path);
    setPendingProject(null);
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const directoryAdapter = useMemo(() => ({
    loadDirectory: async (signal: AbortSignal) => {
      try {
        const value = await api("/api/projects", { signal });
        const directory = parseProjectDirectoryResult(value, () => false);
        if (!signal.aborted) setSession((current) => current.status === "ready" ? { ...current, directory } : current);
        return value;
      }
      catch (error) { if (error instanceof SessionExpiredError) expire(); throw error; }
    },
    isThumbnailUrlAllowed: () => false
  }), [expire]);

  const dashboardAdapter = useMemo(() => ({
    loadDashboard: async ({ projectId, siteId }: { readonly projectId: string; readonly siteId: string }, signal: AbortSignal) => {
      try { return await api(`/api/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}/dashboard`, { signal }); }
      catch (error) { if (error instanceof SessionExpiredError) expire(); throw error; }
    }
  }), [expire]);

  const openEditor = useCallback((project: Project) => {
    if (editorEnabled(project)) {
      window.location.assign(projectRoutePath(window.location.pathname, project.id, project.site.id, "editor"));
      return;
    }
    setPendingProject(project);
  }, []);

  if (session.status === "loading") return <Notice title="Studio を準備しています">認証と参加プロジェクトを確認しています。</Notice>;
  if (session.status === "expired") return <Notice title="セッションの確認が必要です" retry={() => window.location.reload()}>Cloudflare Access から再度ログインしてください。</Notice>;
  if (session.status === "error") return <Notice title="Studio を読み込めませんでした" retry={loadSession}>時間をおいて再度お試しください。</Notice>;

  if (screen.kind === "invite") return <InvitationAcceptance screen={screen} expire={expire} accepted={() => {
    navigate({ kind: "dashboard", projectId: screen.projectId, siteId: screen.siteId });
    loadSession();
  }} />;
  if (session.directory.status === "forbidden") return <Notice title="アクセス権がありません" retry={loadSession}>Studio 管理者にプロジェクト参加資格を確認してください。</Notice>;

  const selected = screen.kind === "dashboard" || screen.kind === "editor"
    ? session.directory.entries.find(({ project }) => project.id === screen.projectId && project.site.id === screen.siteId)?.project
    : undefined;
  const kamakuraEditor = screen.kind === "editor" && !screen.staging && selected?.id === "project-kamakura" && selected.site.id === "kamakura";

  return <div className={`studio-app${kamakuraEditor ? " studio-kamakura-shell" : ""}`}>
    <header className="studio-shell-header"><a href="/" onClick={screen.kind === "editor" ? undefined : (event) => { event.preventDefault(); navigate({ kind: "directory" }); }}><span>NIHO</span> Web Studio</a><details className="studio-account"><summary>{session.identity.email}</summary><div><small>Google / Cloudflare Access</small><label>Access ID <code>{session.identity.subject}</code></label></div></details></header>
    <div className={`studio-content${screen.kind === "editor" ? " studio-content-editor" : ""}${kamakuraEditor ? " studio-kamakura-content" : ""}`}>
      {(screen.kind === "dashboard" || screen.kind === "editor") && !selected
        ? <Notice title="プロジェクトを表示できません">プロジェクトが存在しないか、現在のアカウントには参加資格がありません。</Notice>
        : selected && screen.kind === "editor"
          ? screen.staging
            ? selected.id === "project-experience" && selected.site.id === "experience"
              ? <ExperienceEditor project={selected} environment="staging" />
              : <Notice title="エディターを表示できません">STGエディターは NIHO Experience でのみ利用できます。</Notice>
            : editorEnabled(selected) && selected.id === "project-kamakura" && selected.site.id === "kamakura"
              ? <KamakuraEditor project={selected} />
              : editorEnabled(selected) && selected.id === "project-experience" && selected.site.id === "experience"
                ? <ExperienceEditor project={selected} />
                : <Notice title="エディターを表示できません">このサイトのエディターはまだ接続されていません。</Notice>
        : selected && screen.kind === "dashboard"
          ? <>
              <ProjectDashboard
                project={selected}
                adapter={dashboardAdapter}
                onBackToProjects={() => navigate({ kind: "directory" })}
                onOpenEditor={openEditor}
                onOpenSettings={() => undefined}
                editorAction={editorEnabled(selected) ? "enabled" : "pending"}
                settingsAction="disabled"
              />
              <MemberAdministration key={`${selected.id}:${selected.site.id}`} project={selected} expire={expire} />
            </>
          : <ProjectDirectory
              adapter={directoryAdapter}
              onCreateProject={() => undefined}
              onOpenDashboard={(project) => navigate({ kind: "dashboard", projectId: project.id, siteId: project.site.id })}
              onOpenEditor={openEditor}
              createAction="disabled"
              editorAction={(project) => editorEnabled(project) ? "enabled" : "pending"}
              memberDetails="hidden"
            />}
    </div>
    {pendingProject && <div className="studio-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingProject(null); }}>
      <section className="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-pending-title">
        <p className="studio-kicker">{pendingProject.site.name}</p><h2 id="editor-pending-title">エディター接続待ち</h2>
        <p>このサイトの編集 API はまだ Studio に接続されていません。現在、このサイトでは編集・保存・公開を利用できません。</p>
        <button type="button" autoFocus onClick={() => setPendingProject(null)}>閉じる</button>
      </section>
    </div>}
  </div>;
}

const container = document.getElementById("root");
if (!container) throw new Error("Studio root element is missing");
createRoot(container).render(<App />);
