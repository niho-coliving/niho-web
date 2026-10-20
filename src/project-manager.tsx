"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { projectManagerCss } from "./project-manager-style.js";
import type { CreateProjectInput, ProjectAdapterWriteResult, ProjectManagerProps } from "./project-manager-types.js";
import { PROJECT_LIMITS, assertExistingProjectSiteMappings, parseProject, parseProjectCatalogSnapshot, parseProjectMember, type Project, type ProjectCatalogSnapshot, type ProjectMember } from "./projects.js";
import { isSafeHttpsOrigin } from "./validation-utils.js";

export type * from "./project-manager-types.js";

function Dialog({ name, children, dismiss }: { name: string; children: ReactNode; dismiss: () => void }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = window.document.activeElement;
    root.current?.querySelector<HTMLElement>("[autofocus],button:not(:disabled)")?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <div className="pm-dialog-backdrop"><section ref={root} className="pm-dialog" role="dialog" aria-modal="true" aria-label={name} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
    if (event.key !== "Tab") return;
    const controls = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href]") ?? []);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
  }}>{children}</section></div>;
}

function domainsFromInput(input: string): readonly string[] | null {
  const domains = input.split(/[\n,]/u).map((value) => value.trim()).filter(Boolean);
  return domains.length <= PROJECT_LIMITS.domainsPerSite && domains.every(isSafeHttpsOrigin) && new Set(domains).size === domains.length ? domains : null;
}

type RunOperation = (work: (controller: AbortController, generation: number) => Promise<void>) => void;

function MemberForm({ project, snapshot, adapter, busy, run, adopt, announce }: {
  project: Project;
  snapshot: ProjectCatalogSnapshot;
  adapter: ProjectManagerProps["adapter"];
  busy: boolean;
  run: RunOperation;
  adopt: (snapshot: ProjectCatalogSnapshot) => void;
  announce: (notice: string, error?: boolean) => void;
}) {
  const [identifier, setIdentifier] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const inputIdentifier = identifier.trim();
    if (!inputIdentifier || inputIdentifier.length > PROJECT_LIMITS.memberIdentifierLength || /[\u0000-\u001f\u007f]/u.test(inputIdentifier)) {
      announce("登録済みアカウントの入力内容を確認してください。", true); return;
    }
    run(async (controller) => {
      const resolved = await adapter.resolveMember(inputIdentifier, controller.signal);
      if (controller.signal.aborted) return;
      if (resolved === null) { announce("一致する登録済みアカウントがありません。入力を確認してください。", true); return; }
      const member = parseProjectMember(resolved);
      if (project.members.some((candidate) => candidate.userId === member.userId)) {
        announce(`${member.displayName}はすでに参加しています。`); return;
      }
      const result = await adapter.addMember({ projectId: project.id, member, expectedVersion: snapshot.version }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === "conflict") { announce("ほかの更新と重なりました。入力は保持しています。最新状態を読み込んでから再試行してください。", true); return; }
      if (result.status === "unchanged") { announce(result.reason === "already-member" ? "このメンバーはすでに参加しています。" : "メンバーを追加できませんでした。", result.reason !== "already-member"); return; }
      const saved = savedSnapshot(result, snapshot)!;
      const savedProject = saved.catalog.projects.find((candidate) => candidate.id === project.id);
      if (!savedProject?.members.some((candidate) => candidate.userId === member.userId)) throw new Error("saved member missing");
      adopt(saved); setIdentifier(""); announce(`${member.displayName}を追加しました。`);
    });
  }
  return <form className="pm-member-form" onSubmit={submit}>
    <label className="pm-field"><span>登録済みアカウント</span><input value={identifier} maxLength={PROJECT_LIMITS.memberIdentifierLength} disabled={busy} onChange={(event) => setIdentifier(event.target.value)} placeholder="メールアドレスなど" autoComplete="off" /><small className="pm-help">登録済みアカウントのメールアドレスなどで追加できます。</small></label>
    <button className="pm-primary" type="submit" disabled={busy || !identifier.trim()}>メンバー追加</button>
  </form>;
}

function savedSnapshot(result: ProjectAdapterWriteResult, previous: ProjectCatalogSnapshot): ProjectCatalogSnapshot | null {
  if (result.status !== "saved") return null;
  const snapshot = parseProjectCatalogSnapshot(result.snapshot);
  if (snapshot.version === previous.version) throw new Error("version must advance");
  assertExistingProjectSiteMappings(previous.catalog, snapshot.catalog);
  return snapshot;
}

/** 認証済みホスト用のプロジェクト管理画面。認証・アカウント照合・永続化は adapter が所有する。 */
export function ProjectManager({ adapter, onOpenProject, initialSnapshot }: ProjectManagerProps) {
  const [source, setSource] = useState({ adapter, initialSnapshot, generation: 0 });
  if (source.adapter !== adapter || source.initialSnapshot !== initialSnapshot) {
    setSource({ adapter, initialSnapshot, generation: source.generation + 1 });
    return null;
  }
  return <ProjectManagerSession key={source.generation} adapter={adapter} onOpenProject={onOpenProject} {...(initialSnapshot ? { initialSnapshot } : {})} />;
}

function ProjectManagerSession({ adapter, onOpenProject, initialSnapshot }: ProjectManagerProps) {
  const [snapshot, setSnapshot] = useState<ProjectCatalogSnapshot | null>(() => initialSnapshot ? parseProjectCatalogSnapshot(initialSnapshot) : null);
  const [selectedId, setSelectedId] = useState(() => initialSnapshot ? parseProjectCatalogSnapshot(initialSnapshot).catalog.projects[0]?.id ?? "" : "");
  const [loading, setLoading] = useState(!initialSnapshot), [loadFailed, setLoadFailed] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [noticeError, setNoticeError] = useState(false);
  const [projectName, setProjectName] = useState(""), [siteName, setSiteName] = useState(""), [domainInput, setDomainInput] = useState("");
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const loadController = useRef<AbortController | null>(null), actionController = useRef<AbortController | null>(null), generation = useRef(0);
  const announce = useCallback((text: string, error = false) => { setNotice(text); setNoticeError(error); }, []);
  const adopt = useCallback((next: ProjectCatalogSnapshot) => {
    setSnapshot(next);
    setSelectedId((current) => next.catalog.projects.some((project) => project.id === current) ? current : next.catalog.projects[0]?.id ?? "");
  }, []);
  const load = useCallback(() => {
    loadController.current?.abort();
    const controller = new AbortController(); loadController.current = controller;
    const currentGeneration = ++generation.current;
    setLoading(true); setLoadFailed(false); announce("");
    adapter.loadCatalog(controller.signal).then((input) => {
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      adopt(parseProjectCatalogSnapshot(input)); setLoading(false);
    }).catch(() => { if (!controller.signal.aborted && currentGeneration === generation.current) { setLoading(false); setLoadFailed(true); announce("プロジェクト一覧を読み込めませんでした。再試行してください。", true); } });
  }, [adapter, adopt, announce]);
  useEffect(() => {
    setBusy(false); setRemoving(null);
    if (!initialSnapshot) load();
    return () => {
      generation.current++;
      loadController.current?.abort(); loadController.current = null;
      actionController.current?.abort(); actionController.current = null;
    };
  }, [adapter, initialSnapshot, load]);
  const run = useCallback<RunOperation>((work) => {
    if (actionController.current) return;
    loadController.current?.abort(); setLoading(false);
    const controller = new AbortController(); actionController.current = controller;
    const operationGeneration = ++generation.current; setBusy(true); announce("");
    void work(controller, operationGeneration).catch(() => { if (!controller.signal.aborted && operationGeneration === generation.current) announce("操作を完了できませんでした。入力と現在の一覧は保持されています。再試行してください。", true); }).finally(() => {
      if (actionController.current === controller) actionController.current = null;
      if (!controller.signal.aborted && operationGeneration === generation.current) setBusy(false);
    });
  }, [announce]);
  function create(event: FormEvent) {
    event.preventDefault(); if (!snapshot) return;
    const name = projectName.trim(), nextSiteName = siteName.trim(), domains = domainsFromInput(domainInput);
    if (!name || !nextSiteName || name.length > PROJECT_LIMITS.nameLength || nextSiteName.length > PROJECT_LIMITS.nameLength || domains === null) {
      announce("プロジェクト名・サイト名・公開先URLを確認してください。", true); return;
    }
    const input: CreateProjectInput = { name, siteName: nextSiteName, domains };
    run(async (controller, operationGeneration) => {
      const before = new Set(snapshot.catalog.projects.map((project) => project.id));
      const result = await adapter.createProject({ input, expectedVersion: snapshot.version }, controller.signal);
      if (controller.signal.aborted || operationGeneration !== generation.current) return;
      if (result.status === "conflict") { announce("ほかの更新と重なりました。入力は保持しています。最新状態を読み込んでから再試行してください。", true); return; }
      if (result.status === "unchanged") { announce("プロジェクトを追加できませんでした。", true); return; }
      const saved = savedSnapshot(result, snapshot)!;
      const created = saved.catalog.projects.find((project) => !before.has(project.id));
      if (!created || created.name !== name || created.site.name !== nextSiteName || created.site.domains.length !== domains.length || !created.site.domains.every((domain, index) => domain === domains[index])) throw new Error("created project missing");
      adopt(saved); setSelectedId(created.id); setProjectName(""); setSiteName(""); setDomainInput(""); announce("プロジェクトを作成しました。");
    });
  }
  const selected = snapshot?.catalog.projects.find((project) => project.id === selectedId) ?? null;
  const interactionBusy = busy || loading;
  function removeMember() {
    if (!snapshot || !selected || !removing) return;
    const projectId = selected.id, member = removing;
    run(async (controller, operationGeneration) => {
      const result = await adapter.removeMember({ projectId, userId: member.userId, expectedVersion: snapshot.version }, controller.signal);
      if (controller.signal.aborted || operationGeneration !== generation.current) return;
      if (result.status === "conflict") { setRemoving(null); announce("ほかの更新と重なりました。最新状態を読み込んでから再試行してください。", true); return; }
      if (result.status === "unchanged") { setRemoving(null); announce("このメンバーはすでに解除されています。"); return; }
      const saved = savedSnapshot(result, snapshot)!;
      const savedProject = saved.catalog.projects.find((project) => project.id === projectId);
      if (!savedProject) throw new Error("saved project missing");
      if (savedProject.members.some((candidate) => candidate.userId === member.userId)) throw new Error("removed member remains");
      adopt(saved); setRemoving(null); announce(`${member.displayName}を解除しました。`);
    });
  }
  if (loading && !snapshot) return <div className="nw-project-manager"><style dangerouslySetInnerHTML={{ __html: projectManagerCss }} /><p className="pm-empty" role="status">プロジェクト一覧を読み込んでいます。</p></div>;
  if (loadFailed && !snapshot) return <div className="nw-project-manager"><style dangerouslySetInnerHTML={{ __html: projectManagerCss }} /><div className="pm-empty"><p className="pm-error" role="alert">プロジェクト一覧を読み込めませんでした。</p><button onClick={load}>再試行</button></div></div>;
  return <div className="nw-project-manager"><style dangerouslySetInnerHTML={{ __html: projectManagerCss }} />
    <header className="pm-header"><h1>プロジェクト管理</h1><span className={`pm-status${noticeError ? " pm-error" : ""}`} role={noticeError ? "alert" : "status"}>{busy ? "処理中…" : loading ? "読込中…" : notice}</span><button onClick={load} disabled={interactionBusy || !!removing}>最新状態を確認</button></header>
    <div ref={(element) => { if (element) element.inert = !!removing; }}>
      <section className="pm-create" aria-labelledby="pm-create-title"><h2 id="pm-create-title">プロジェクト作成</h2><form className="pm-form" onSubmit={create}>
        <label className="pm-field"><span>プロジェクト名</span><input value={projectName} maxLength={PROJECT_LIMITS.nameLength} disabled={interactionBusy} onChange={(event) => setProjectName(event.target.value)} /></label>
        <label className="pm-field"><span>サイト名</span><input value={siteName} maxLength={PROJECT_LIMITS.nameLength} disabled={interactionBusy} onChange={(event) => setSiteName(event.target.value)} /></label>
        <label className="pm-field pm-domain"><span>公開先URL</span><textarea value={domainInput} disabled={interactionBusy} onChange={(event) => setDomainInput(event.target.value)} placeholder="https://example.com（1行1件）" /><small className="pm-help">未設定でも作成できます。パスや末尾の / は含めません。</small></label>
        <button className="pm-primary" type="submit" disabled={interactionBusy || !projectName.trim() || !siteName.trim()}>作成</button>
      </form></section>
      <div className="pm-layout"><nav className="pm-list" aria-label="プロジェクト一覧"><h2>プロジェクト一覧</h2>{snapshot?.catalog.projects.length ? snapshot.catalog.projects.map((project) => <button type="button" className="pm-project" key={project.id} aria-current={project.id === selectedId} disabled={interactionBusy} onClick={() => { setSelectedId(project.id); announce(""); }}><strong>{project.name}</strong><span>{project.site.name}</span></button>) : <p className="pm-empty">プロジェクトはまだありません。上のフォームから作成できます。</p>}</nav>
        <main className="pm-detail" key={selected?.id ?? "empty"}>{selected && snapshot ? <><div className="pm-title"><div><h2>{selected.name}</h2><p>{selected.site.name}{selected.site.domains.length ? ` · ${selected.site.domains.join(" · ")}` : " · 公開先未設定"}</p></div><button className="pm-primary" type="button" disabled={interactionBusy} onClick={() => onOpenProject(parseProject(selected))}>プロジェクトを開く</button></div>
          <section className="pm-members" aria-labelledby={`members-${selected.id}`}><h2 id={`members-${selected.id}`}>参加メンバー</h2><MemberForm key={selected.id} project={selected} snapshot={snapshot} adapter={adapter} busy={interactionBusy} run={run} adopt={adopt} announce={announce} />
            {selected.members.length ? <ul className="pm-member-list">{selected.members.map((member) => <li className="pm-member" key={member.userId}><span>{member.displayName}</span><button className="pm-danger" type="button" disabled={interactionBusy} aria-label={`${member.displayName}を解除`} onClick={() => setRemoving(member)}>解除</button></li>)}</ul> : <p className="pm-empty">参加メンバーはまだいません。</p>}
          </section></> : <p className="pm-empty">プロジェクトを作成すると、サイトとメンバーを管理できます。</p>}</main></div>
    </div>
    {removing && <Dialog name="メンバー解除の確認" dismiss={() => { if (!busy) setRemoving(null); }}><h2>メンバー解除</h2><p>{removing.displayName}をこのプロジェクトから解除します。サイトとページは削除されません。</p><div className="pm-dialog-actions"><button autoFocus disabled={busy} onClick={() => setRemoving(null)}>戻る</button><button className="pm-danger" disabled={busy} onClick={removeMember}>解除する</button></div></Dialog>}
  </div>;
}
