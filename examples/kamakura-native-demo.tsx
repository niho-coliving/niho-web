import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PageEditor, type EditorAdapter } from "../src/editor.js";
import { parsePageDocument, parseSitePresentation, type PageDocument, type SitePresentation } from "../src/core.js";
import type { AssetLibraryAdapter, ResolvedAssetMap } from "../src/assets.js";

declare const KAMAKURA_DEMO_DOCUMENT: PageDocument;
declare const KAMAKURA_DEMO_PRESENTATION: SitePresentation;
declare const KAMAKURA_DEMO_ASSETS: ResolvedAssetMap;

let stored = parsePageDocument(KAMAKURA_DEMO_DOCUMENT), version = 1;
const presentation = parseSitePresentation(KAMAKURA_DEMO_PRESENTATION, stored);
const menuLabel = presentation.overlays?.[0]?.label ?? "native overlay";
const target = { siteId: stored.siteId, pageId: stored.pageId, locale: stored.locale };
const assetAdapter: AssetLibraryAdapter = {
  listAssets: async () => ({ assets: [], folders: [] }),
  uploadAsset: async () => ({ status: "rejected", reason: "permission" }),
  updateAsset: async () => ({ status: "rejected", reason: "permission" }),
  listAssetUsages: async () => [],
  deleteAsset: async () => ({ status: "rejected", reason: "permission" }),
  resolveAssets: async (request) => Object.fromEntries(request.references.flatMap((reference) => {
    const key = `${reference.provider}:${reference.id}`, resolved = KAMAKURA_DEMO_ASSETS[key];
    return resolved ? [[key, resolved]] : [];
  })),
};
const adapter: EditorAdapter = {
  listSites: async () => [{ id: stored.siteId, name: "鎌倉 native fixture", domains: ["https://demo.invalid"] }],
  listPages: async () => [{ ...target, title: stored.title, path: "/business-plan" }],
  readDocument: async () => ({ document: structuredClone(stored), version: `memory-${version}`, presentation: structuredClone(presentation) }),
  saveDraft: async (request) => {
    if (request.expectedVersion !== `memory-${version}` || request.presentationVersion !== presentation.version) return { status: "conflict" };
    stored = { ...parsePageDocument(request.document), revision: stored.revision + 1 }; version++;
    return { status: "saved", version: `memory-${version}`, revision: stored.revision };
  },
  prepareRelease: async () => { throw new Error("このfixtureは公開しません"); },
  release: async () => { throw new Error("このfixtureは公開しません"); },
};

function Demo() {
  const [ssrWidth, setSsrWidth] = useState(1280);
  return <main style={{ fontFamily: "sans-serif" }}>
    <aside style={{ display: "flex", gap: 8, alignItems: "center", padding: 8, background: "#eef2ee" }}>
      <strong>同じ native context のSSR比較 + {menuLabel}</strong>
      {[375, 768, 1280].map((width) => <button key={width} type="button" onClick={() => setSsrWidth(width)}>{width}px</button>)}
      <a href={`/ssr?width=${ssrWidth}`} target="native-ssr">別窓</a>
      <span>保存・再読込はメモリ内のみです。</span>
      <span>Editorは「プレビュー」後、SSRは右側のMENUから開閉できます。</span>
    </aside>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(760px,1fr) minmax(320px,0.7fr)", gap: 12, alignItems: "start" }}>
      <PageEditor adapter={adapter} assets={assetAdapter} insertableBlocks={[]} />
      <iframe name="native-ssr" title="同じSSR renderer" src={`/ssr?width=${ssrWidth}`} style={{ width: ssrWidth > 768 ? "100%" : ssrWidth, maxWidth: "100%", height: "90vh", border: "1px solid #9baa9e" }} />
    </div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Demo />);
