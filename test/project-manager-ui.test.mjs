import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://manager.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Event", "MouseEvent", "FocusEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProjectManager } = await import("@niho/web/project-manager");
const { addProject, addProjectMember, parseProjectCatalog, removeProjectMember } = await import("@niho/web/projects");

const memberA = { userId: "user_alpha", displayName: "青木さん" };
const memberB = { userId: "user_beta", displayName: "森さん" };
const project = (id, siteId, members = [memberA]) => ({ id, name: `${id} 計画`, site: { id: siteId, name: `${siteId} サイト`, domains: [`https://${siteId}.example.test`] }, members });
const baseCatalog = () => parseProjectCatalog({ projects: [project("project_kamakura", "site_kamakura"), project("project_shonan", "site_shonan", [memberA, memberB])] });
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent === text);
const projectButton = (text) => [...document.querySelectorAll("button.pm-project")].find((node) => node.querySelector("strong")?.textContent === text);
const field = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector(":scope > span")?.textContent === text)?.querySelector("input,textarea");
async function click(text) { const target = button(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }
async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await flush();
}

async function setup(options = {}) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let catalog = structuredClone(options.catalog ?? baseCatalog()), version = 1, sequence = 1;
  const calls = { loads: 0, creates: [], resolves: [], adds: [], removes: [], opens: [] };
  const snapshot = () => ({ catalog: structuredClone(catalog), version: `v${version}` });
  const save = (next) => { catalog = next; version++; return { status: "saved", snapshot: snapshot() }; };
  const adapter = {
    loadCatalog: async (signal) => { calls.loads++; if (options.loadCatalog) return options.loadCatalog(signal, calls.loads); return snapshot(); },
    createProject: async (request, signal) => {
      calls.creates.push(structuredClone(request)); if (options.createProject) return options.createProject(request, signal, snapshot);
      if (request.expectedVersion !== `v${version}`) return { status: "conflict" };
      const id = `project_new_${sequence}`, siteId = `site_new_${sequence++}`;
      return save(addProject(catalog, { id, name: request.input.name, site: { id: siteId, name: request.input.siteName, domains: request.input.domains }, members: [] }));
    },
    resolveMember: async (input, signal) => { calls.resolves.push(input); if (options.resolveMember) return options.resolveMember(input, signal); return input === "account-b" ? memberB : input === "account-a" ? memberA : null; },
    addMember: async (request, signal) => {
      calls.adds.push(structuredClone(request)); if (options.addMember) return options.addMember(request, signal, snapshot);
      if (request.expectedVersion !== `v${version}`) return { status: "conflict" };
      const changed = addProjectMember(catalog, request.projectId, request.member);
      return changed.status === "unchanged" ? changed : save(changed.catalog);
    },
    removeMember: async (request, signal) => {
      calls.removes.push(structuredClone(request)); if (options.removeMember) return options.removeMember(request, signal, snapshot);
      if (request.expectedVersion !== `v${version}`) return { status: "conflict" };
      const changed = removeProjectMember(catalog, request.projectId, request.userId);
      return changed.status === "unchanged" ? changed : save(changed.catalog);
    }
  };
  const onOpenProject = (opened) => calls.opens.push(opened);
  const render = async (nextAdapter, initialSnapshot) => {
    await act(async () => root.render(createElement(ProjectManager, { adapter: nextAdapter, onOpenProject, ...(initialSnapshot ? { initialSnapshot } : {}) })));
    await flush();
  };
  await render(adapter, options.initialSnapshot);
  return { adapter, calls, root, container, snapshot, rerender: render, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("project manager creates, selects, opens, adds and confirms member removal", async () => {
  const app = await setup();
  try {
    assert.ok(projectButton("project_kamakura 計画")); assert.ok(projectButton("project_shonan 計画"));
    assert.ok(document.body.textContent.includes("登録済みアカウントのメールアドレスなどで追加できます"));
    assert.equal(document.body.textContent.includes("ユーザーIDだけを保存"), false);
    await act(async () => projectButton("project_shonan 計画").click()); await flush(); assert.ok(document.body.textContent.includes("森さん"));
    await click("プロジェクトを開く"); assert.equal(app.calls.opens[0].id, "project_shonan");
    await change(field("プロジェクト名"), "海辺の案内"); await change(field("サイト名"), "海辺サイト"); await change(field("公開先URL"), "https://seaside.example.test");
    await click("作成"); assert.ok(document.body.textContent.includes("プロジェクトを作成しました")); assert.ok(document.body.textContent.includes("海辺の案内"));
    await change(field("登録済みアカウント"), "account-b"); await click("メンバー追加");
    assert.equal(app.calls.adds[0].member.userId, memberB.userId); assert.equal("inputIdentifier" in app.calls.adds[0], false);
    assert.ok(document.body.textContent.includes("森さん")); assert.equal(field("登録済みアカウント").value, "");
    const remove = document.querySelector('[aria-label="森さんを解除"]'); assert.ok(remove); await act(async () => remove.click()); await flush();
    assert.ok(document.querySelector('[role="dialog"][aria-label="メンバー解除の確認"]'));
    assert.ok(document.activeElement?.textContent === "戻る");
    assert.equal(button("最新状態を確認").disabled, true);
    button("最新状態を確認").click(); await flush(); assert.equal(app.calls.loads, 1);
    await click("解除する"); assert.equal(app.calls.removes[0].userId, memberB.userId); assert.ok(document.body.textContent.includes("サイトとページは削除されません") === false);
  } finally { await app.cleanup(); }
});

test("create and member conflicts keep form input and the old optimistic version", async () => {
  const app = await setup({
    createProject: async () => ({ status: "conflict" }),
    addMember: async () => ({ status: "conflict" })
  });
  try {
    await change(field("プロジェクト名"), "保持する計画"); await change(field("サイト名"), "保持するサイト"); await click("作成");
    assert.equal(field("プロジェクト名").value, "保持する計画"); assert.equal(field("サイト名").value, "保持するサイト"); assert.equal(app.calls.creates[0].expectedVersion, "v1");
    await change(field("登録済みアカウント"), "account-b"); await click("メンバー追加");
    assert.equal(field("登録済みアカウント").value, "account-b"); assert.equal(app.calls.adds[0].expectedVersion, "v1"); assert.ok(document.body.textContent.includes("入力は保持しています"));
  } finally { await app.cleanup(); }
});

test("double submit and project switching are blocked while an operation is pending", async () => {
  let finish;
  const app = await setup({ createProject: async (request, signal, snapshot) => new Promise((resolve) => { finish = () => resolve({ status: "saved", snapshot: { catalog: addProject(snapshot().catalog, { id: "project_delayed", name: request.input.name, site: { id: "site_delayed", name: request.input.siteName, domains: [] }, members: [] }), version: "v2" } }); signal.addEventListener("abort", () => resolve({ status: "conflict" }), { once: true }); }) });
  try {
    await change(field("プロジェクト名"), "遅い作成"); await change(field("サイト名"), "遅いサイト");
    const create = button("作成"); await act(async () => { create.click(); create.click(); }); await flush();
    assert.equal(app.calls.creates.length, 1); assert.equal(projectButton("project_shonan 計画").disabled, true); assert.equal(create.disabled, true);
    assert.equal(button("最新状態を確認").disabled, true);
    button("最新状態を確認").click(); await flush(); assert.equal(app.calls.loads, 1);
    await act(async () => finish()); await flush(); assert.ok(document.body.textContent.includes("project_delayed") || document.body.textContent.includes("遅い作成"));
  } finally { await app.cleanup(); }
});

test("reload blocks mutations and project switching until the new snapshot arrives", async () => {
  let finishReload;
  const app = await setup({
    loadCatalog: async (_signal, count) => count === 1
      ? { catalog: baseCatalog(), version: "v1" }
      : new Promise((resolve) => { finishReload = () => resolve({ catalog: baseCatalog(), version: "v2" }); })
  });
  try {
    await change(field("プロジェクト名"), "再読込中の計画");
    await change(field("サイト名"), "再読込中のサイト");
    await change(field("登録済みアカウント"), "account-b");
    await click("最新状態を確認");
    assert.equal(button("最新状態を確認").disabled, true);
    assert.equal(button("作成").disabled, true);
    assert.equal(button("メンバー追加").disabled, true);
    assert.equal(button("プロジェクトを開く").disabled, true);
    assert.equal(projectButton("project_shonan 計画").disabled, true);
    await act(async () => { button("作成").click(); projectButton("project_shonan 計画").click(); }); await flush();
    assert.equal(app.calls.creates.length, 0);
    assert.equal(document.querySelector("main h2")?.textContent, "project_kamakura 計画");
    await act(async () => finishReload()); await flush();
    assert.equal(button("作成").disabled, false);
    assert.equal(button("メンバー追加").disabled, false);
    assert.equal(projectButton("project_shonan 計画").disabled, false);
  } finally { await app.cleanup(); }
});

test("adapter replacement aborts the old action and ignores its late response", async () => {
  let finishOldLookup, oldSignal;
  const app = await setup({ resolveMember: async (_input, signal) => {
    oldSignal = signal;
    return new Promise((resolve) => { finishOldLookup = resolve; });
  } });
  try {
    await change(field("登録済みアカウント"), "old-account");
    await click("メンバー追加");
    assert.equal(button("メンバー追加").disabled, true);

    const memberC = { userId: "3firebase-user", displayName: "新しい担当者" };
    let nextCatalog = parseProjectCatalog({ projects: [project("project_fresh", "site_fresh", [memberA])] });
    let nextVersion = 1, nextAdds = 0;
    const nextAdapter = {
      ...app.adapter,
      loadCatalog: async () => ({ catalog: structuredClone(nextCatalog), version: `next-v${nextVersion}` }),
      resolveMember: async () => memberC,
      addMember: async (request) => {
        nextAdds++;
        const changed = addProjectMember(nextCatalog, request.projectId, request.member);
        nextCatalog = changed.catalog; nextVersion++;
        return { status: "saved", snapshot: { catalog: structuredClone(nextCatalog), version: `next-v${nextVersion}` } };
      }
    };
    await app.rerender(nextAdapter);
    assert.equal(oldSignal.aborted, true);
    assert.ok(projectButton("project_fresh 計画"));
    assert.equal(button("最新状態を確認").disabled, false);

    await act(async () => finishOldLookup(memberB)); await flush();
    assert.equal(document.body.textContent.includes("森さん"), false);
    assert.equal(app.calls.adds.length, 0);

    await change(field("登録済みアカウント"), "new-account");
    await click("メンバー追加");
    assert.equal(nextAdds, 1);
    assert.ok(document.body.textContent.includes("新しい担当者"));
  } finally { await app.cleanup(); }
});

test("adapter replacement never exposes the old catalog when the new account fails to load", async () => {
  const app = await setup();
  try {
    await change(field("プロジェクト名"), "前のアカウントの下書き");
    const nextAdapter = { ...app.adapter, loadCatalog: async () => { throw new Error("new account offline"); } };
    await app.rerender(nextAdapter);
    assert.ok(document.body.textContent.includes("読み込めませんでした"));
    assert.equal(projectButton("project_kamakura 計画"), undefined);
    assert.equal(document.body.textContent.includes("森さん"), false);
    assert.equal(button("作成"), undefined);
    assert.equal(button("プロジェクトを開く"), undefined);
    assert.equal(app.calls.creates.length, 0);
  } finally { await app.cleanup(); }
});

test("adapter replacement adopts the new initial snapshot and clears the old account's form state", async () => {
  const initialSnapshot = { catalog: baseCatalog(), version: "v1" };
  const app = await setup({ initialSnapshot });
  try {
    assert.equal(app.calls.loads, 0);
    await change(field("プロジェクト名"), "前のアカウントの下書き");
    await change(field("登録済みアカウント"), "old-account");
    const nextSnapshot = { catalog: parseProjectCatalog({ projects: [project("project_next", "site_next", [])] }), version: "v1" };
    let loads = 0;
    const nextAdapter = { ...app.adapter, loadCatalog: async () => { loads++; throw new Error("must use initial snapshot"); } };
    await app.rerender(nextAdapter, nextSnapshot);
    assert.equal(loads, 0);
    assert.equal(projectButton("project_kamakura 計画"), undefined);
    assert.ok(projectButton("project_next 計画"));
    assert.equal(field("プロジェクト名").value, "");
    assert.equal(field("登録済みアカウント").value, "");
    await click("プロジェクトを開く");
    assert.equal(app.calls.opens.at(-1).id, "project_next");
  } finally { await app.cleanup(); }
});

test("replacing the initial snapshot resets the catalog even when the adapter is unchanged", async () => {
  const app = await setup({ initialSnapshot: { catalog: baseCatalog(), version: "initial-a" } });
  try {
    const nextSnapshot = { catalog: parseProjectCatalog({ projects: [project("project_replaced", "site_replaced", [])] }), version: "initial-b" };
    await app.rerender(app.adapter, nextSnapshot);
    assert.equal(app.calls.loads, 0);
    assert.equal(projectButton("project_kamakura 計画"), undefined);
    assert.ok(projectButton("project_replaced 計画"));
  } finally { await app.cleanup(); }
});

test("saved responses cannot replace a site or remove the target project", async () => {
  const replacedSite = await setup({ addMember: async (_request, _signal, snapshot) => {
    const corrupt = snapshot(); corrupt.version = "v2"; corrupt.catalog.projects[0].site.id = "site_replacement";
    return { status: "saved", snapshot: corrupt };
  } });
  try {
    await change(field("登録済みアカウント"), "account-b"); await click("メンバー追加");
    assert.ok(document.body.textContent.includes("操作を完了できませんでした"));
    assert.equal(document.body.textContent.includes("森さん"), false);
  } finally { await replacedSite.cleanup(); }

  const missingProject = await setup({ removeMember: async (request, _signal, snapshot) => {
    const corrupt = snapshot(); corrupt.version = "v2";
    corrupt.catalog.projects = corrupt.catalog.projects.filter((candidate) => candidate.id !== request.projectId);
    return { status: "saved", snapshot: corrupt };
  } });
  try {
    await act(async () => projectButton("project_shonan 計画").click()); await flush();
    await act(async () => document.querySelector('[aria-label="森さんを解除"]').click()); await flush();
    await click("解除する");
    assert.ok(document.body.textContent.includes("操作を完了できませんでした"));
    assert.ok(projectButton("project_shonan 計画"));
    assert.ok(document.querySelector('[role="dialog"][aria-label="メンバー解除の確認"]'));
  } finally { await missingProject.cleanup(); }
});

test("empty, loading, error and retry states are actionable", async () => {
  let resolveLoad;
  const loading = await setup({ loadCatalog: async () => new Promise((resolve) => { resolveLoad = resolve; }) });
  try {
    assert.ok(document.body.textContent.includes("読み込んでいます"));
    await act(async () => resolveLoad({ catalog: { projects: [] }, version: "v1" })); await flush();
    assert.ok(document.body.textContent.includes("プロジェクトはまだありません"));
  } finally { await loading.cleanup(); }
  const retry = await setup({ loadCatalog: async (_signal, count) => { if (count === 1) throw new Error("offline"); return { catalog: { projects: [] }, version: "v1" }; } });
  try {
    assert.ok(document.body.textContent.includes("読み込めませんでした")); await click("再試行");
    assert.equal(retry.calls.loads, 2); assert.ok(document.body.textContent.includes("プロジェクトはまだありません"));
  } finally { await retry.cleanup(); }
});

test("unmount aborts pending catalog and member lookup requests", async () => {
  let loadSignal;
  const pendingLoad = await setup({ loadCatalog: async (signal) => { loadSignal = signal; return new Promise(() => {}); } });
  await pendingLoad.cleanup(); assert.equal(loadSignal.aborted, true);
  let memberSignal;
  const pendingMember = await setup({ resolveMember: async (_input, signal) => { memberSignal = signal; return new Promise(() => {}); } });
  await change(field("登録済みアカウント"), "account-b"); await click("メンバー追加");
  await pendingMember.cleanup(); assert.equal(memberSignal.aborted, true);
});
