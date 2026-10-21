import { createElement } from "react";
import { createInsertionNode, defineBuilder, layoutInsertionPresets } from "@niho/web/builder";
import { componentUsage, parseComponentLibrary, parsePageDocument, resolvePageDocument } from "@niho/web/core";
import { renderPageToHtml } from "@niho/web/server";

export const ATELIER_TARGET = Object.freeze({ siteId: "atelier", pageId: "home", locale: "ja-JP" });
export const ATELIER_DOMAIN = "https://atelier.example.test";

export const atelierBlocks = Object.freeze({
  WorkshopNote: {
    label: "制作ノート",
    props: {
      heading: { type: "string", required: true, maxLength: 80 },
      detail: { type: "string", required: true, maxLength: 240 }
    },
    styleProperties: ["margin", "padding", "backgroundColor", "color", "borderRadius", "states", "appear"],
    component: ({ heading, detail }) => createElement("aside", { style: { padding: "20px", border: "1px solid #b68a68", borderRadius: "12px" } },
      createElement("strong", null, String(heading)), createElement("p", null, String(detail)))
  }
});

const cardInsertion = {
  id: "atelier-card",
  label: "作品カード",
  group: "アトリエ",
  glyph: "◇",
  create: ({ id }) => ({
    type: "element", id: id(), tag: "article",
    style: { base: { display: "grid", gap: 12, padding: 20, backgroundColor: "#fffaf4", borderRadius: 12 } },
    children: [
      { type: "element", id: id(), tag: "h2", children: [{ type: "text", text: "新しい作品" }] },
      { type: "element", id: id(), tag: "p", children: [{ type: "text", text: "素材と制作の背景を書きます。" }] }
    ]
  })
};

export const atelierBuilderDefinition = defineBuilder({
  insertions: [...layoutInsertionPresets, cardInsertion],
  motions: [{
    id: "atelier-soft-rise",
    label: "静かな浮上",
    style: {
      base: { transitionDuration: 240, transitionTimingFunction: "ease-out" },
      states: { hover: { translate: "0 -6px", scale: 1.01 } },
      appear: { effect: "fade-up", trigger: "view", duration: 650, delay: 80, easing: "ease-out" }
    }
  }]
});

export const initialAtelierLibrary = parseComponentLibrary({
  schemaVersion: 1,
  siteId: "atelier",
  revision: 1,
  tokens: {},
  components: [{
    id: "atelier_signature",
    name: "アトリエ署名",
    kind: "section",
    version: 1,
    root: {
      type: "element", id: "signature_root", tag: "footer",
      style: { base: { marginTop: 48, padding: "24px 0", borderTopWidth: 1, borderStyle: "solid", borderColor: "#c9ad96" } },
      children: [{ type: "element", id: "signature_text", tag: "p", children: [{ type: "text", text: "Atelier Moku — 手で考える場所" }] }]
    },
    props: { label: { label: "署名", node: "signature_text", field: "text" } }
  }]
}, atelierBlocks);

export const initialAtelierDocument = parsePageDocument({
  schemaVersion: 1,
  siteId: "atelier",
  pageId: "home",
  locale: "ja-JP",
  revision: 1,
  title: "Atelier Moku",
  tokens: {
    ink: { type: "color", value: "#3f3027", label: "墨色" },
    paper: { type: "color", value: "#f5eee4", label: "紙色" },
    accent: { type: "color", value: "#a45f3f", label: "焼色" }
  },
  body: [{
    type: "element", id: "atelier_main", tag: "main",
    style: { base: { maxWidth: 1040, margin: "0 auto", padding: "56px 24px", color: { token: "ink" }, backgroundColor: { token: "paper" } } },
    children: [
      { type: "element", id: "atelier_title", tag: "h1", style: { base: { fontSize: 48, margin: "0 0 12px" } }, children: [{ type: "text", text: "Atelier Moku" }] },
      { type: "element", id: "atelier_lead", tag: "p", style: { base: { fontSize: 18, lineHeight: 1.8 } }, children: [{ type: "text", text: "木、土、布。手ざわりから始まる小さな制作室です。" }] },
      { type: "element", id: "atelier_photo", tag: "img", attrs: { src: "/atelier-image.svg", alt: "木の道具と器が並ぶアトリエ" }, style: { base: { display: "block", width: "100%", height: "auto", margin: "32px 0", borderRadius: 16 } }, children: [] },
      { type: "component", id: "atelier_note", block: "WorkshopNote", props: { heading: "今週の制作", detail: "栗の木を削り、日々使える小さなトレイを仕上げています。" }, style: { base: { margin: "24px 0" } } },
      { type: "instance", id: "atelier_signature_instance", component: "atelier_signature", props: { label: "Atelier Moku — 手で考える場所" } }
    ]
  }]
}, atelierBlocks, { components: initialAtelierLibrary });

function clone(value) { return structuredClone(value); }
function target(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "locale,pageId,siteId" || value.siteId !== ATELIER_TARGET.siteId || value.pageId !== ATELIER_TARGET.pageId || value.locale !== ATELIER_TARGET.locale) throw new Error("invalid target");
  return ATELIER_TARGET;
}
function documentTarget(value) {
  if (value.siteId !== ATELIER_TARGET.siteId || value.pageId !== ATELIER_TARGET.pageId || value.locale !== ATELIER_TARGET.locale) throw new Error("invalid target");
}
function version(value) {
  if (typeof value !== "string" || !/^atelier-(?:draft|components)-[1-9][0-9]*$/u.test(value)) throw new Error("invalid version");
  return value;
}

export function createAtelierHost() {
  let draft = clone(initialAtelierDocument);
  let library = clone(initialAtelierLibrary);
  let draftVersion = 1;
  let componentVersion = 1;
  let nextRevision = draft.revision + 1;
  let confirmed = null;
  let published = resolvePageDocument(draft, library, atelierBlocks).document;
  const snapshot = () => ({ document: clone(draft), version: `atelier-draft-${draftVersion}`, hasSavedDraft: true });
  const librarySnapshot = () => ({ library: clone(library), version: `atelier-components-${componentVersion}` });
  return {
    listSites: () => [{ id: "atelier", name: "Atelier Moku", domains: [ATELIER_DOMAIN] }],
    listPages: (siteId) => {
      if (siteId !== "atelier") throw new Error("invalid site");
      return [{ ...ATELIER_TARGET, title: "ホーム", path: "/", published: true }];
    },
    readDocument: (requested) => { target(requested); return snapshot(); },
    saveDraft: (request) => {
      target(request.target);
      if (version(request.expectedVersion) !== `atelier-draft-${draftVersion}`) return { status: "conflict" };
      const parsed = parsePageDocument(request.document, atelierBlocks, { components: library });
      documentTarget(parsed);
      draft = { ...parsed, revision: nextRevision++ };
      draftVersion++;
      confirmed = null;
      return { status: "saved", version: `atelier-draft-${draftVersion}`, revision: draft.revision };
    },
    readLibrary: (siteId) => { if (siteId !== "atelier") throw new Error("invalid site"); return librarySnapshot(); },
    saveLibrary: (request) => {
      if (request.siteId !== "atelier" || version(request.expectedVersion) !== `atelier-components-${componentVersion}`) return { status: "conflict" };
      const parsed = parseComponentLibrary(request.library, atelierBlocks);
      if (parsed.siteId !== "atelier") throw new Error("invalid component site");
      parsePageDocument(draft, atelierBlocks, { components: parsed });
      library = { ...parsed, revision: library.revision + 1 };
      componentVersion++;
      confirmed = null;
      return { status: "saved", version: `atelier-components-${componentVersion}`, revision: library.revision };
    },
    listUsage: (siteId) => {
      if (siteId !== "atelier") throw new Error("invalid site");
      return [{ target: ATELIER_TARGET, title: "ホーム", role: "page", components: componentUsage(draft, library) }];
    },
    prepareRelease: (request) => {
      target(request.target);
      if (request.action !== "publish" || request.revision !== undefined || request.expectedVersion !== `atelier-draft-${draftVersion}` || request.componentsVersion !== `atelier-components-${componentVersion}`) throw new Error("release target mismatch");
      const confirmationToken = `atelier-confirm-${globalThis.crypto.randomUUID()}`;
      confirmed = { confirmationToken, expectedVersion: request.expectedVersion, componentsVersion: request.componentsVersion, revision: draft.revision };
      return { ...request, confirmationToken, domain: ATELIER_DOMAIN, url: `${ATELIER_DOMAIN}/`, changes: [{ path: "document", before: `revision ${published.revision}`, after: `revision ${draft.revision}` }] };
    },
    release: (request) => {
      target(request.target);
      if (!confirmed || request.action !== "publish" || request.confirmationToken !== confirmed.confirmationToken || request.expectedVersion !== confirmed.expectedVersion || request.componentsVersion !== confirmed.componentsVersion || draft.revision !== confirmed.revision) return { status: "conflict" };
      published = resolvePageDocument(draft, library, atelierBlocks).document;
      confirmed = null;
      return { status: "released", snapshot: snapshot() };
    },
    renderDraft: () => renderPageToHtml(resolvePageDocument(draft, library, atelierBlocks).document, atelierBlocks),
    publishedDocument: () => clone(published),
    createInsertion: (id) => {
      const preset = atelierBuilderDefinition.insertions.find((entry) => entry.id === id);
      if (!preset) throw new Error("unknown insertion");
      return createInsertionNode(preset, { document: draft, blocks: atelierBlocks, components: library, insertableBlocks: ["WorkshopNote"], idPrefix: "atelier_added_" });
    }
  };
}
