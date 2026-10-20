import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  acceptTranslationResult, adoptTranslationCandidate, collectLocalizationUnits, createLocalizationOverlay, editLocalizedValue,
  localizedValuesForDocument, materializeLocalizedPage, reviewLocalizedValue, validateLocalizedDocumentSave
} from "@niho/web/localization";

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://editor.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PageEditor } = await import("@niho/web/editor");
const flush = async (turns = 3) => { for (let index = 0; index < turns; index++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0))); };
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent === text);
async function click(text) { const target = button(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }
const tool = (text) => [...document.querySelectorAll(".e-tools button")].find((node) => node.querySelector("small")?.textContent === text);
async function clickTool(text) { const target = tool(text); assert.ok(target, text); await act(async () => target.click()); await flush(); }
const input = (text) => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === text)?.querySelector("input,textarea,select");
async function change(target, value) {
  assert.ok(target);
  await act(async () => {
    const prototype = target.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : target.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(target, value);
    target.dispatchEvent(new dom.window.Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  if (target.tagName !== "SELECT") await act(async () => target.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })));
  await flush();
}
async function typeWithoutBlur(target, value) {
  assert.ok(target);
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(target, value); target.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await flush();
}
const config = (siteId, sourceLocale) => ({ schemaVersion: 1, siteId, sourceLocale, defaultLocale: sourceLocale, enabledLocales: sourceLocale === "ja" ? ["ja", "en"] : ["en", "ja"],
  documentLocales: { ja: "ja-JP", en: "en-US" }, glossaryVersion: "demo-g1", contextVersion: "demo-c1" });
const sourcePage = (siteId, pageId, locale, title) => ({ schemaVersion: 1, siteId, pageId, locale, revision: 1, title, tokens: { ink: { type: "color", value: "#17382d" } }, body: [
  { type: "element", id: "hero", tag: "section", style: { base: { color: { token: "ink" }, padding: 24 } }, children: [
    { type: "element", id: "heading", tag: "h1", children: [{ type: "text", text: locale.startsWith("ja") ? "海辺で暮らす" : "Live by the sea" }] },
    { type: "element", id: "lead", tag: "p", children: [{ type: "text", text: locale.startsWith("ja") ? "詳しくは" : "Read " }, { type: "element", id: "details", tag: "a", attrs: { href: "/details" }, children: [{ type: "text", text: locale.startsWith("ja") ? "こちら" : "details" }] }] },
    { type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "main" }, attrs: { alt: locale.startsWith("ja") ? "海の写真" : "Sea" }, children: [] }
  ] }
] });
const translateRich = (value) => ({ ...value, children: value.children.map(function map(node) { return node.type === "text" ? { ...node, text: node.text ? `訳:${node.text}` : node.text } : { ...node, children: node.children.map(map) }; }) });
async function localizedSite(siteId, sourceLocale, labels) {
  const cfg = config(siteId, sourceLocale), sourceDocument = sourcePage(siteId, "home", cfg.documentLocales[sourceLocale], labels.source);
  const collection = await collectLocalizationUnits(cfg, sourceDocument, sourceLocale === "ja" ? "en" : "ja");
  let overlay = createLocalizationOverlay(collection);
  for (const unit of collection.units.filter((entry) => entry.scope === "page")) {
    const value = unit.kind === "asset" ? { kind: "asset", asset: { provider: "uploads", id: `${siteId}-localized` } }
      : unit.kind === "rich-text" ? translateRich(unit.sourceValue) : unit.unitId === "page.title" ? labels.manual : `訳:${unit.sourceValue}`;
    overlay = editLocalizedValue(overlay, collection, { unitId: unit.unitId, value, expectedVersion: overlay.version });
  }
  overlay = acceptTranslationResult(overlay, collection, { schemaVersion: 1, resultId: `${siteId}Candidate`, siteId, pageId: "home", sourceLocale,
    targetLocale: sourceLocale === "ja" ? "en" : "ja", baseVersion: overlay.version, values: [{ unitId: "page.title", sourceFingerprint: collection.units.find((unit) => unit.unitId === "page.title").sourceFingerprint, value: labels.candidate }] });
  const targetDocument = (await materializeLocalizedPage(cfg, sourceDocument, collection, overlay)).document;
  return { cfg, sourceDocument, targetDocument, collection, overlay, labels, documentVersion: 1, localizationVersion: 1, siteVersion: 1, job: { state: "failed", message: "合成した失敗" } };
}
async function setup({ conflictOnce = false, conflictSourceChange = false, rejectCommandOnce = false, delayedRead = false, delayedSite = false, delayedSiteAfterFirst = false, rejectSiteOnce = false, rejectPageOnce = false, unsupportedLocale = false, recovery } = {}) {
  const kamakura = await localizedSite("kamakura", "ja", { source: "鎌倉ホーム", manual: "Manual Kamakura", candidate: "Candidate Kamakura" });
  const experience = await localizedSite("experience", "en", { source: "Experience home", manual: "体験（手修正）", candidate: "体験（翻訳案）" });
  const sites = { kamakura, experience }, calls = { saves: [], commands: [], siteReads: 0, pageReads: 0 }; let conflict = conflictOnce, rejectCommand = rejectCommandOnce, delayedResolve, delayedSiteResolve, failSite = rejectSiteOnce, failPage = rejectPageOnce;
  const stateFor = (target) => sites[target.siteId], isSource = (state, target) => target.locale === state.cfg.documentLocales[state.cfg.sourceLocale];
  const readPage = async (target, signal) => {
    calls.pageReads++;
    if (failPage) { failPage = false; throw new Error("synthetic page failure"); }
    const state = stateFor(target);
    if (delayedRead) await new Promise((resolve) => { delayedResolve = resolve; signal.addEventListener("abort", resolve, { once: true }); });
    return { sourceDocument: structuredClone(state.sourceDocument), sourceVersion: `source-${state.sourceDocument.revision}`, overlay: structuredClone(state.overlay), version: `loc-${state.localizationVersion}`, job: structuredClone(state.job) };
  };
  const adapter = {
    listSites: async () => [{ id: "kamakura", name: "鎌倉", domains: ["https://kamakura.example"] }, { id: "experience", name: "Experience", domains: ["https://experience.example"] }],
    listPages: async (siteId) => [{ siteId, pageId: "home", locale: unsupportedLocale && siteId === "kamakura" ? "fr-FR" : sites[siteId].cfg.documentLocales[sites[siteId].cfg.sourceLocale], title: sites[siteId].labels.source }],
    readDocument: async (target) => { const state = stateFor(target), value = structuredClone(isSource(state, target) ? state.sourceDocument : state.targetDocument); if (unsupportedLocale && target.locale === "fr-FR") value.locale = target.locale; return { document: value, version: `doc-${state.documentVersion}` }; },
    saveDraft: async (request) => {
      calls.saves.push(structuredClone(request)); const state = stateFor(request.target);
      if (isSource(state, request.target)) state.sourceDocument = { ...structuredClone(request.document), revision: state.sourceDocument.revision + 1 };
      else {
        assert.ok(request.localization); const validated = await validateLocalizedDocumentSave(state.cfg, state.sourceDocument, request.document);
        const values = localizedValuesForDocument(request.document, state.collection);
        for (const unit of state.collection.units.filter((entry) => entry.scope === "page")) {
          const entry = state.overlay.entries.find((item) => item.unitId === unit.unitId);
          if (JSON.stringify(entry?.draftValue) !== JSON.stringify(values[unit.unitId])) state.overlay = editLocalizedValue(state.overlay, state.collection, { unitId: unit.unitId, value: values[unit.unitId], expectedVersion: state.overlay.version });
        }
        state.targetDocument = { ...validated.document, revision: state.targetDocument.revision + 1 }; state.localizationVersion++;
      }
      state.documentVersion++; return { status: "saved", version: `doc-${state.documentVersion}`, revision: (isSource(state, request.target) ? state.sourceDocument : state.targetDocument).revision };
    },
    prepareRelease: async (request) => ({ ...request, confirmationToken: "demo", domain: "https://example.test", changes: [] }),
    release: async () => ({ status: "conflict" }),
    localization: {
      readSite: async (siteId, signal) => { calls.siteReads++; if (failSite) { failSite = false; throw new Error("synthetic site failure"); }
        if (delayedSite || delayedSiteAfterFirst && calls.siteReads > 1) await new Promise((resolve) => { delayedSiteResolve = resolve; signal.addEventListener("abort", resolve, { once: true }); });
        const state = sites[siteId]; return { config: structuredClone(state.cfg), version: `site-${state.siteVersion}`, job: structuredClone(state.job), pages: [
        { siteId, pageId: "home", title: state.labels.source, path: "/", locales: { ja: { state: state.cfg.sourceLocale === "ja" ? "source" : "review-needed" }, en: { state: state.cfg.sourceLocale === "en" ? "source" : "review-needed" } } }
      ] }; },
      readPage,
      command: async (request) => {
        calls.commands.push(structuredClone(request)); const state = stateFor(request.target);
        if (rejectCommand) { rejectCommand = false; throw new Error("synthetic command failure"); }
        if (conflict) {
          conflict = false;
          if (conflictSourceChange) {
            const currentUnit = state.collection.units.find((unit) => unit.unitId === request.unitId);
            state.overlay = editLocalizedValue(state.overlay, state.collection, { unitId: currentUnit.unitId, value: "Remote accepted", expectedVersion: state.overlay.version });
            state.overlay = reviewLocalizedValue(state.overlay, state.collection, { unitId: currentUnit.unitId, expectedVersion: state.overlay.version });
            state.sourceDocument = { ...state.sourceDocument, revision: state.sourceDocument.revision + 1, title: "Remote source title" };
            state.collection = await collectLocalizationUnits(state.cfg, state.sourceDocument, state.cfg.sourceLocale === "ja" ? "en" : "ja");
            state.targetDocument = (await materializeLocalizedPage(state.cfg, state.sourceDocument, state.collection, state.overlay)).document;
            state.localizationVersion++; state.documentVersion++;
          }
          return { status: "conflict" };
        }
        if (request.expectedVersion !== `loc-${state.localizationVersion}` || request.expectedOverlayVersion !== state.overlay.version) return { status: "conflict" };
        if (request.action === "set-value") {
          const unit = state.collection.units.find((item) => item.unitId === request.unitId), entry = state.overlay.entries.find((item) => item.unitId === request.unitId);
          if (!unit || request.sourceFingerprint !== unit.sourceFingerprint || request.expectedEntryVersion !== (entry?.version ?? 0)) return { status: "conflict" };
          state.overlay = editLocalizedValue(state.overlay, state.collection, { unitId: request.unitId, value: request.value, expectedVersion: state.overlay.version });
          state.targetDocument = (await materializeLocalizedPage(state.cfg, state.sourceDocument, state.collection, state.overlay)).document; state.documentVersion++;
        } else if (request.action === "adopt-candidate") state.overlay = adoptTranslationCandidate(state.overlay, state.collection, { unitId: request.unitId, expectedVersion: state.overlay.version, candidateVersion: request.candidateVersion });
        else if (request.action === "review-current") state.overlay = reviewLocalizedValue(state.overlay, state.collection, { unitId: request.unitId, expectedVersion: state.overlay.version });
        else state.job = { state: "queued" };
        state.localizationVersion++;
        if (request.action === "adopt-candidate") state.targetDocument = (await materializeLocalizedPage(state.cfg, state.sourceDocument, state.collection, state.overlay)).document;
        return { status: "applied", version: `loc-${state.localizationVersion}` };
      },
      requestSiteTranslation: async ({ siteId }) => { const state = sites[siteId]; state.siteVersion++; state.job = { state: "queued" }; return { status: "applied", version: `site-${state.siteVersion}` }; }
    }
  };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(PageEditor, { adapter, ...(recovery ? { recovery } : {}) }))); await flush(6);
  return { sites, calls, adapter, resolveDelayed: () => delayedResolve?.(), resolveDelayedSite: () => delayedSiteResolve?.(), cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

async function setupSharedComponents() {
  const cfg = config("shared", "ja"), components = { schemaVersion: 1, siteId: "shared", revision: 1, tokens: {}, components: [{
    id: "header", name: "共通ヘッダー", kind: "header", version: 1,
    root: { type: "element", id: "headerRoot", tag: "header", children: [
      { type: "element", id: "sharedText", tag: "p", children: [{ type: "text", text: "共有原文" }] },
      { type: "element", id: "sharedRich", tag: "p", children: [{ type: "text", text: "海の" }, { type: "element", id: "sharedMark", tag: "strong", children: [{ type: "text", text: "近く" }] }, { type: "element", id: "sharedLink", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "詳しく" }] }] },
      { type: "element", id: "sharedImage", tag: "img", asset: { provider: "uploads", id: "shared-source" }, attrs: { alt: "" }, children: [] }
    ] }
  }] };
  const source = (pageId, title) => ({ schemaVersion: 1, siteId: "shared", pageId, locale: "ja-JP", revision: 1, title, tokens: {}, body: [
    { type: "instance", id: `${pageId}HeaderA`, component: "header" }, { type: "element", id: `${pageId}Main`, tag: "main", children: [] }, { type: "instance", id: `${pageId}HeaderB`, component: "header" }
  ] });
  const pages = new Map();
  for (const [pageId, title] of [["home", "ホーム"], ["about", "About"]]) {
    const sourceDocument = source(pageId, title), collection = await collectLocalizationUnits(cfg, sourceDocument, "en", { components }); let overlay = createLocalizationOverlay(collection);
    overlay = editLocalizedValue(overlay, collection, { unitId: "component.header.node.sharedText.text", value: "Shared draft", expectedVersion: overlay.version });
    const unit = collection.units.find((item) => item.unitId === "component.header.node.sharedText.text");
    overlay = acceptTranslationResult(overlay, collection, { schemaVersion: 1, resultId: `candidate_${pageId}`, siteId: "shared", pageId, sourceLocale: "ja", targetLocale: "en", baseVersion: overlay.version,
      values: [{ unitId: unit.unitId, sourceFingerprint: unit.sourceFingerprint, value: "Shared candidate" }] });
    pages.set(pageId, { source: sourceDocument, collection, overlay, target: (await materializeLocalizedPage(cfg, sourceDocument, collection, overlay, { components })).document, documentVersion: 1, localizationVersion: 1 });
  }
  const pageFor = (target) => pages.get(target.pageId), calls = [], librarySaves = []; let libraryVersion = 1;
  const pickedAsset = { provider: "uploads", id: "shared-target", siteId: "shared", kind: "image", status: "ready", name: "言語別の共有画像", mimeType: "image/png", bytes: 100, width: 100, height: 50, alt: "", version: "1", updatedAt: "2026-10-21T00:00:00.000Z" };
  const assets = {
    listAssets: async () => ({ assets: [pickedAsset], folders: [] }), uploadAsset: async () => ({ status: "rejected", reason: "permission" }), updateAsset: async () => ({ status: "rejected", reason: "permission" }),
    listAssetUsages: async () => [], deleteAsset: async () => ({ status: "rejected", reason: "permission" }),
    resolveAssets: async ({ references }) => Object.fromEntries(references.map((reference) => [`${reference.provider}:${reference.id}`, { src: `/${reference.id}.png`, width: 100, height: 50 }]))
  };
  const adapter = {
    listSites: async () => [{ id: "shared", name: "Shared", domains: ["https://shared.example"] }],
    listPages: async () => [...pages.entries()].map(([pageId, page]) => ({ siteId: "shared", pageId, locale: "ja-JP", title: page.source.title })),
    readDocument: async (target) => { const page = pageFor(target); return { document: structuredClone(target.locale === "ja-JP" ? page.source : page.target), version: `doc-${page.documentVersion}` }; },
    saveDraft: async () => ({ status: "conflict" }), prepareRelease: async (request) => ({ ...request, confirmationToken: "x", domain: "https://shared.example", changes: [] }), release: async () => ({ status: "conflict" }),
    components: {
      readLibrary: async () => ({ library: structuredClone(components), version: `lib-${libraryVersion}` }),
      saveLibrary: async (request) => {
        librarySaves.push(structuredClone(request));
        const revision = request.library.revision + 1;
        Object.assign(components, structuredClone({ ...request.library, revision })); libraryVersion++;
        return { status: "saved", version: `lib-${libraryVersion}`, revision };
      },
      listUsage: async () => []
    },
    localization: {
      readSite: async () => ({ config: structuredClone(cfg), version: "site-1", pages: [...pages.entries()].map(([pageId, page]) => ({ siteId: "shared", pageId, title: page.source.title, locales: { ja: { state: "source" }, en: { state: "review-needed" } } })) }),
      readPage: async (target) => { const page = pageFor(target); return { sourceDocument: structuredClone(page.source), sourceVersion: `source-1-lib-${libraryVersion}`, overlay: structuredClone(page.overlay), version: `loc-${page.localizationVersion}` }; },
      command: async (request) => {
        calls.push(structuredClone(request)); const page = pageFor(request.target), unit = page.collection.units.find((item) => item.unitId === request.unitId);
        if (request.expectedSourceVersion !== `source-1-lib-${libraryVersion}` || request.expectedVersion !== `loc-${page.localizationVersion}` || request.expectedOverlayVersion !== page.overlay.version) return { status: "conflict" };
        if (request.action === "set-value") {
          const entry = page.overlay.entries.find((item) => item.unitId === unit.unitId);
          if (request.sourceFingerprint !== unit.sourceFingerprint || request.expectedEntryVersion !== (entry?.version ?? 0)) return { status: "conflict" };
          page.overlay = editLocalizedValue(page.overlay, page.collection, { unitId: unit.unitId, value: request.value, expectedVersion: page.overlay.version });
        } else if (request.action === "adopt-candidate") page.overlay = adoptTranslationCandidate(page.overlay, page.collection, { unitId: unit.unitId, expectedVersion: page.overlay.version, candidateVersion: request.candidateVersion });
        else if (request.action === "review-current") page.overlay = reviewLocalizedValue(page.overlay, page.collection, { unitId: unit.unitId, expectedVersion: page.overlay.version });
        if (unit.scope === "shared-component") {
          const current = page.overlay.entries.find((item) => item.unitId === unit.unitId);
          for (const other of pages.values()) if (other !== page) {
            other.overlay = editLocalizedValue(other.overlay, other.collection, { unitId: unit.unitId, value: current.draftValue, expectedVersion: other.overlay.version });
            if (request.action === "review-current") other.overlay = reviewLocalizedValue(other.overlay, other.collection, { unitId: unit.unitId, expectedVersion: other.overlay.version });
            other.localizationVersion++;
          }
        }
        page.target = (await materializeLocalizedPage(cfg, page.source, page.collection, page.overlay, { components })).document; page.localizationVersion++; page.documentVersion++;
        return { status: "applied", version: `loc-${page.localizationVersion}` };
      }
    }
  };
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(PageEditor, { adapter, assets }))); await flush(6);
  return { pages, components, calls, librarySaves, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("same logical page switches locale through the dirty guard, saves real target content and keeps source unchanged", async () => {
  const app = await setup();
  try {
    assert.ok(button("日本語（原文）")); assert.ok(button("English（訳文）"));
    await clickTool("ページ");
    assert.equal([...document.querySelectorAll(".e-page-name")].filter((node) => node.textContent === "鎌倉ホーム").length, 1);
    assert.ok(document.body.textContent.includes("JA 原文")); assert.ok(document.body.textContent.includes("EN 更新あり"));
    await click("ページ"); await typeWithoutBlur(input("ページタイトル"), "入力途中の原文");
    await click("English（訳文）"); assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける");
    assert.equal(input("ページタイトル").value, "入力途中の原文");
    await act(async () => input("ページタイトル").dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }))); await flush();
    await click("English（訳文）"); await click("保存して移動"); await flush(5);
    assert.equal(input("ページタイトル").value, "Manual Kamakura");
    assert.equal(tool("スタイル").disabled, true); assert.ok(button("元に戻す").disabled);
    await click("h1 · heading"); await change(input("テキスト"), "Edited target heading"); await click("下書き保存");
    assert.equal(app.sites.kamakura.sourceDocument.body[0].children[0].children[0].text, "海辺で暮らす");
    assert.equal(app.sites.kamakura.targetDocument.body[0].children[0].children[0].text, "Edited target heading");
    assert.ok(app.calls.saves.at(-1).localization.expectedSourceVersion.startsWith("source-"));
    await clickTool("レイヤー"); await click("a · details"); assert.equal(input("リンク先 URL").disabled, true); assert.ok(document.body.textContent.includes("共通デザインは原文側で編集"));
    await change([...document.querySelectorAll('select[aria-label="編集するサイト"]')][0], "experience"); await flush(6);
    assert.ok(button("English（原文）")); assert.ok(button("日本語（訳文）")); assert.equal(input("ページタイトル").value, "Experience home");
  } finally { await app.cleanup(); }
});

test("candidate stays separate until adoption, command conflicts retry, failures are visible, and late target reads are ignored", async () => {
  const app = await setup({ conflictOnce: true });
  try {
    await click("English（訳文）"); await flush(5); await click("翻訳");
    assert.ok(document.body.textContent.includes("Manual Kamakura")); assert.ok(document.body.textContent.includes("Candidate Kamakura"));
    assert.ok(document.body.textContent.includes("翻訳に失敗しました"));
    await click("翻訳案を採用"); assert.ok(document.body.textContent.includes("409")); assert.equal(app.sites.kamakura.targetDocument.title, "Manual Kamakura");
    await click("翻訳案を採用"); await flush(5); assert.equal(app.sites.kamakura.targetDocument.title, "Candidate Kamakura");
    await click("翻訳"); await click("現在の訳を確認済みにする");
    assert.ok(app.sites.kamakura.overlay.entries.some((entry) => entry.reviewedSourceFingerprint));
    await click("ページ"); await change(input("ページタイトル"), "Manual after review"); await click("下書き保存");
    assert.equal(app.sites.kamakura.overlay.entries.find((entry) => entry.unitId === "page.title").reviewedSourceFingerprint, undefined);
  } finally { await app.cleanup(); }
  const late = await setup({ delayedRead: true });
  try {
    await click("English（訳文）"); await click("日本語（原文）"); late.resolveDelayed(); await flush(5);
    assert.equal(button("翻訳"), undefined); assert.equal(input("ページタイトル").value, "鎌倉ホーム");
  } finally { await late.cleanup(); }
});

test("source component editing saves through the canonical library session and target rendering uses its localized view", async () => {
  const app = await setupSharedComponents();
  try {
    await clickTool("部品"); await click("編集"); await click("p · sharedText");
    await change(input("テキスト"), "共有原文を更新"); await click("下書き保存");
    assert.equal(app.librarySaves.length, 1);
    assert.equal(app.components.components[0].root.children[0].children[0].text, "共有原文を更新");

    await click("ページに戻る"); await click("English（訳文）"); await flush(7);
    const frame = document.querySelector('iframe[title="ページのライブキャンバス"]'); assert.ok(frame);
    await act(async () => frame.dispatchEvent(new dom.window.Event("load"))); await flush();
    assert.equal((frame.contentDocument.body.textContent.match(/Shared draft/g) ?? []).length, 2);
    assert.equal(app.components.components[0].root.children[0].children[0].text, "共有原文を更新", "localized rendering must not mutate the authoritative library");
  } finally { await app.cleanup(); }
});

test("shared component units are shown once, manually edited, adopted, reviewed and rendered in every instance without flattening", async () => {
  const app = await setupSharedComponents();
  const rail = document.querySelector(".e-right"), originalScroll = Object.getOwnPropertyDescriptor(rail, "scrollTop"), scrolled = [];
  let scrollTop = 0;
  Object.defineProperty(rail, "scrollTop", { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; scrolled.push(value); } });
  const section = () => document.querySelector('[data-unit-id="component.header.node.sharedText.text"]');
  const sectionButton = (label) => [...section().querySelectorAll("button")].find((item) => item.textContent === label);
  try {
    await click("English（訳文）"); await flush(7);
    const expanded = document.querySelector("iframe")?.contentDocument?.querySelector('[data-nw-node="homeHeaderA--sharedText"]'); assert.ok(expanded);
    await act(async () => expanded.click()); await flush();
    assert.equal(document.querySelectorAll('[data-unit-id="component.header.node.sharedText.text"]').length, 1);
    assert.ok(section().classList.contains("is-selected"));
    assert.match(section().textContent, /共通部品「共通ヘッダー」/);
    assert.match(section().querySelector("h3").textContent, /共有原文/);
    assert.doesNotMatch(section().querySelector("h3").textContent, /sharedText/);
    assert.ok(scrolled.length > 0);
    assert.equal(window.scrollY, 0);
    const canvasText = () => document.querySelector("iframe")?.contentDocument?.body.textContent ?? "";
    assert.equal((canvasText().match(/Shared draft/g) ?? []).length, 2);

    const manual = section().querySelector("textarea"); await change(manual, "Shared manual");
    await act(async () => sectionButton("手修正を保存").click()); await flush(8);
    assert.equal(app.calls.at(-1).action, "set-value"); assert.equal(app.calls.at(-1).expectedEntryVersion > 0, true);
    assert.equal(app.components.components[0].root.children[0].children[0].text, "共有原文");
    assert.equal((canvasText().match(/Shared manual/g) ?? []).length, 2);

    await click("翻訳");
    await act(async () => sectionButton("翻訳案を採用").click()); await flush(8);
    assert.equal((canvasText().match(/Shared candidate/g) ?? []).length, 2);
    await click("翻訳");
    await act(async () => sectionButton("現在の訳を確認済みにする").click()); await flush(6);
    await click("翻訳");
    assert.match(section().textContent, /確認済み/);

    const rich = document.querySelector('[data-unit-id="component.header.node.sharedRich.richText"]'), richEditor = rich.querySelector(".e-localization-rich");
    await act(async () => { richEditor.querySelector('[data-nw-node="sharedMark"]').textContent = "near"; richEditor.querySelector('[data-nw-node="sharedLink"]').textContent = "details"; richEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); await flush();
    await act(async () => [...rich.querySelectorAll("button")].find((item) => item.textContent === "手修正を保存").click()); await flush(7);
    assert.equal(app.calls.at(-1).value.kind, "rich-text");
    assert.deepEqual(app.calls.at(-1).value.children.filter((node) => node.type === "element").map((node) => node.id), ["sharedMark", "sharedLink"]);
    assert.equal(app.components.components[0].root.children[1].children[2].attrs.href, "/about");

    await click("翻訳");
    const assetUnit = document.querySelector('[data-unit-id="component.header.node.sharedImage.asset"]'); assert.ok(assetUnit);
    await act(async () => [...assetUnit.querySelectorAll("button")].find((item) => item.textContent === "素材を選ぶ").click()); await flush(5);
    const assetCard = document.querySelector(".e-asset-card"); assert.ok(assetCard); await act(async () => assetCard.click()); await flush(8);
    assert.deepEqual(app.calls.at(-1).value, { kind: "asset", asset: { provider: "uploads", id: "shared-target" } });

    await click("翻訳");
    const alt = document.querySelector('[data-unit-id="component.header.node.sharedImage.attr.alt"]');
    assert.ok(alt); assert.equal(alt.querySelector("textarea").value, "");
    await act(async () => [...alt.querySelectorAll("button")].find((item) => item.textContent === "手修正を保存").click()); await flush(7);
    assert.equal(app.calls.at(-1).value, "");

    await clickTool("ページ");
    const about = [...document.querySelectorAll(".e-page")].find((item) => item.textContent.includes("About")); assert.ok(about);
    await act(async () => about.click()); await flush(8);
    assert.equal((canvasText().match(/Shared candidate/g) ?? []).length, 2);
    assert.equal(app.pages.get("about").target.body.filter((node) => node.type === "instance").length, 2);
  } finally {
    if (originalScroll === undefined) delete rail.scrollTop; else Object.defineProperty(rail, "scrollTop", originalScroll);
    await app.cleanup();
  }
});

test("manual text input guards locale, site and inspector navigation, participates in beforeunload, and only explicit discard drops its scope", async () => {
  const app = await setup();
  const titleSection = () => document.querySelector('[data-unit-id="page.title"]');
  const manual = () => titleSection()?.querySelector("input,textarea");
  try {
    await click("English（訳文）"); await flush(5); await click("翻訳");
    await change(manual(), "Keep this localized title");
    assert.equal(document.querySelector(".e-status").textContent, "入力を確認中");
    const unload = new dom.window.Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
    assert.equal([...titleSection().querySelectorAll("button")].find((item) => item.textContent === "翻訳案を採用").disabled, true);
    assert.equal(button("翻訳を再試行").disabled, true);

    await click("日本語（原文）"); assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける");
    assert.equal(manual().value, "Keep this localized title");
    await click("ページ"); assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける");
    assert.equal(manual().value, "Keep this localized title");
    await change(document.querySelector('select[aria-label="編集するサイト"]'), "experience"); assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける");
    assert.equal(manual().value, "Keep this localized title");

    await click("日本語（原文）"); await click("変更を破棄して移動"); await flush(6);
    assert.equal(input("ページタイトル").value, "鎌倉ホーム");
    await click("English（訳文）"); await flush(5); await click("翻訳");
    assert.equal(manual().value, "Manual Kamakura");
  } finally { await app.cleanup(); }
});

test("rich manual input guards node, page and inspector changes; discard is scoped and broken structure is cancelled without loss", async () => {
  const app = await setupSharedComponents();
  const richSection = () => document.querySelector('[data-unit-id="component.header.node.sharedRich.richText"]');
  const richEditor = () => richSection()?.querySelector('.e-localization-rich');
  const sectionButton = (label) => [...richSection().querySelectorAll("button")].find((item) => item.textContent === label);
  try {
    await click("English（訳文）"); await flush(6); await click("翻訳");
    assert.equal(richEditor().getAttribute("role"), "textbox"); assert.equal(richEditor().getAttribute("aria-multiline"), "true");
    await act(async () => { richEditor().querySelector('[data-nw-node="sharedMark"]').textContent = "編集中"; richEditor().dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); await flush();
    await click("ページ"); assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける");
    assert.equal(richEditor().querySelector('[data-nw-node="sharedMark"]').textContent, "編集中");

    const otherSharedNode = document.querySelector("iframe")?.contentDocument?.querySelector('[data-nw-node="homeHeaderA--sharedText"]');
    await act(async () => otherSharedNode.click()); await flush(); assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける");
    assert.equal(richEditor().querySelector('[data-nw-node="sharedMark"]').textContent, "編集中");

    await clickTool("ページ");
    const about = [...document.querySelectorAll(".e-page")].find((item) => item.textContent.includes("About"));
    await act(async () => about.click()); await flush(); assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける");
    assert.equal(richEditor().querySelector('[data-nw-node="sharedMark"]').textContent, "編集中");
    await act(async () => about.click()); await flush(); await click("変更を破棄して移動"); await flush(7);
    await clickTool("ページ"); const home = [...document.querySelectorAll(".e-page")].find((item) => item.textContent.includes("ホーム")); await act(async () => home.click()); await flush(7); await click("翻訳");
    assert.equal(richEditor().querySelector('[data-nw-node="sharedMark"]').textContent, "近く");

    const mark = richEditor().querySelector('[data-nw-node="sharedMark"]'); mark.removeAttribute("data-nw-node");
    await act(async () => richEditor().dispatchEvent(new dom.window.Event("input", { bubbles: true }))); await flush();
    await act(async () => sectionButton("手修正を保存").click()); await flush();
    assert.match(richSection().textContent, /リンクや装飾/); assert.equal(app.calls.filter((call) => call.action === "set-value" && call.unitId.includes("sharedRich")).length, 0);
    assert.equal(richEditor().querySelector('[data-nw-node="sharedMark"]'), null);
    await act(async () => sectionButton("入力を取り消す").click()); await flush();
    assert.equal(richEditor().querySelector('[data-nw-node="sharedMark"]').textContent, "近く");
  } finally { await app.cleanup(); }
});

test("manual save keeps its buffer through 409 and rejection, reloads current comparison, retries with fresh versions, and clears only after success", async () => {
  let app = await setup({ conflictOnce: true, conflictSourceChange: true });
  const titleSection = () => document.querySelector('[data-unit-id="page.title"]');
  const manual = () => titleSection()?.querySelector("input,textarea");
  const manualButton = (label) => [...titleSection().querySelectorAll("button")].find((item) => item.textContent === label);
  try {
    await click("English（訳文）"); await flush(5); await click("翻訳"); await change(manual(), "My conflict-safe value");
    const beforeUnload = new dom.window.Event("beforeunload", { cancelable: true }); window.dispatchEvent(beforeUnload); assert.equal(beforeUnload.defaultPrevented, true);
    await act(async () => manualButton("手修正を保存").click()); await flush(10);
    assert.equal(manual().value, "My conflict-safe value"); assert.equal(document.querySelector(".e-status").textContent, "入力を確認中");
    assert.match(titleSection().textContent, /Remote source title/); assert.match(titleSection().textContent, /Remote accepted/); assert.match(titleSection().textContent, /更新あり/);
    assert.equal(manualButton("翻訳案を採用")?.disabled ?? true, true); assert.equal(manualButton("現在の訳を確認済みにする").disabled, true);
    const first = app.calls.commands.at(-1);
    await act(async () => manualButton("手修正を保存").click()); await flush(12);
    const retry = app.calls.commands.at(-1); assert.notEqual(retry.expectedVersion, first.expectedVersion); assert.ok(retry.expectedEntryVersion > first.expectedEntryVersion);
    assert.equal(app.sites.kamakura.targetDocument.title, "My conflict-safe value"); assert.notEqual(document.querySelector(".e-status").textContent, "入力を確認中");
    const afterUnload = new dom.window.Event("beforeunload", { cancelable: true }); window.dispatchEvent(afterUnload); assert.equal(afterUnload.defaultPrevented, false);

    await change(manual(), "Cancel me"); await act(async () => manualButton("入力を取り消す").click()); await flush();
    assert.equal(manual().value, "My conflict-safe value"); assert.notEqual(document.querySelector(".e-status").textContent, "入力を確認中");
  } finally { await app.cleanup(); }

  app = await setup({ rejectCommandOnce: true });
  try {
    await click("English（訳文）"); await flush(5); await click("翻訳"); await change(manual(), "Keep after network rejection");
    await act(async () => manualButton("手修正を保存").click()); await flush(5);
    assert.equal(manual().value, "Keep after network rejection"); assert.equal(document.querySelector(".e-status").textContent, "入力を確認中");
    assert.match(document.body.textContent, /入力は保持されています/);
    await act(async () => manualButton("手修正を保存").click()); await flush(10);
    assert.equal(app.sites.kamakura.targetDocument.title, "Keep after network rejection"); assert.notEqual(document.querySelector(".e-status").textContent, "入力を確認中");
  } finally { await app.cleanup(); }
});

test("localization config and target context fail closed while loading, on errors, on retry, and for an unmapped document locale", async () => {
  let app = await setup({ delayedSite: true });
  try {
    assert.match(document.body.textContent, /言語設定と翻訳状態を読み込み中/);
    assert.equal(input("ページタイトル").disabled, true);
    assert.equal(button("公開前の確認").disabled, true);
    app.resolveDelayedSite(); await flush(6);
    assert.equal(input("ページタイトル").disabled, false);
  } finally { await app.cleanup(); }

  app = await setup({ rejectSiteOnce: true });
  try {
    assert.match(document.body.textContent, /言語設定または翻訳状態を確認できません/);
    assert.equal(input("ページタイトル").disabled, true);
    await click("再試行"); await flush(6);
    assert.equal(input("ページタイトル").disabled, false);
  } finally { await app.cleanup(); }

  app = await setup({ rejectPageOnce: true });
  try {
    await click("English（訳文）"); await flush(5);
    assert.match(document.body.textContent, /言語設定または翻訳状態を確認できません/);
    assert.equal(input("ページタイトル").disabled, true);
    await click("再試行"); await flush(6);
    assert.equal(input("ページタイトル").disabled, false);
  } finally { await app.cleanup(); }

  app = await setup({ unsupportedLocale: true });
  try {
    assert.match(document.body.textContent, /言語設定または翻訳状態を確認できません/);
    assert.equal(input("ページタイトル").disabled, true);
    assert.equal(button("公開前の確認").disabled, true);
  } finally { await app.cleanup(); }
});

test("a target save stays fail closed while site and page localization state reloads", async () => {
  const app = await setup({ delayedSiteAfterFirst: true });
  try {
    await click("English（訳文）"); await flush(5);
    await click("h1 · heading"); await change(input("テキスト"), "Saved before refresh"); await click("下書き保存"); await flush();
    assert.match(document.body.textContent, /言語設定と翻訳状態を読み込み中/);
    assert.equal(input("テキスト").disabled, true);
    assert.equal(button("下書き保存").disabled, true);
    assert.equal(button("公開前の確認").disabled, true);
    app.resolveDelayedSite(); await flush(8);
    assert.equal(input("テキスト").disabled, false);
    assert.equal(app.calls.saves.at(-1).localization.expectedOverlayVersion > 0, true);
  } finally { await app.cleanup(); }
});

test("target content undo/redo works and emergency recovery accepts content but rejects structure tampering", async () => {
  let recovered;
  const store = {
    read: async (target) => target.locale === "en-US" ? recovered : null,
    write: async () => {}, remove: async () => {}
  };
  let app = await setup({ recovery: store });
  try {
    const recoveryDocument = structuredClone(app.sites.kamakura.targetDocument); recoveryDocument.title = "Recovered target title";
    recovered = { target: { siteId: "kamakura", pageId: "home", locale: "en-US" }, baseVersion: "doc-1", baseRevision: recoveryDocument.revision, document: recoveryDocument, updatedAt: new Date().toISOString() };
    await click("English（訳文）"); await flush(6);
    assert.ok(document.querySelector(".e-recovery")); await click("復元する"); await flush(5);
    assert.equal(input("ページタイトル").value, "Recovered target title");
    assert.equal(button("元に戻す").disabled, false); await click("元に戻す"); assert.equal(input("ページタイトル").value, "Manual Kamakura");
    assert.equal(button("やり直す").disabled, false); await click("やり直す"); assert.equal(input("ページタイトル").value, "Recovered target title");
  } finally { await app.cleanup(); }

  app = await setup({ recovery: store });
  try {
    const recoveryDocument = structuredClone(app.sites.kamakura.targetDocument); recoveryDocument.body[0].style.base.padding = 999;
    recovered = { target: { siteId: "kamakura", pageId: "home", locale: "en-US" }, baseVersion: "doc-1", baseRevision: recoveryDocument.revision, document: recoveryDocument, updatedAt: new Date().toISOString() };
    await click("English（訳文）"); await flush(6); await click("復元する"); await flush(5);
    assert.match(document.body.textContent, /共通構造|non-localizable|文書のルール|変更できません/);
    assert.notEqual(app.sites.kamakura.targetDocument.body[0].style.base.padding, 999);
  } finally { await app.cleanup(); }
});
