import { createRoot } from "react-dom/client";
import { PageEditor, type ComponentLibrarySnapshot, type ComponentUsageEntry, type EditorAdapter, type EditorComponentAdapter, type EditorPage, type EditorReleasePlan, type EditorReleaseResult, type EditorSaveResult, type EditorSite, type EditorSnapshot } from "@niho/web/editor";
import { atelierBlocks, atelierBuilderDefinition } from "./atelier-builder-host.mjs";

async function request<T>(path: string, signal: AbortSignal, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    cache: "no-store",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const type = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!type.startsWith("application/json")) throw new Error("デモサーバーの応答形式が正しくありません。");
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "デモサーバーへ接続できません。");
  return value as T;
}

const components: EditorComponentAdapter = {
  readLibrary: (siteId, signal) => request<ComponentLibrarySnapshot>(`/api/components?siteId=${encodeURIComponent(siteId)}`, signal),
  saveLibrary: (input, signal) => request<EditorSaveResult>("/api/components", signal, "PUT", input),
  listUsage: (siteId, signal) => request<readonly ComponentUsageEntry[]>(`/api/components/usage?siteId=${encodeURIComponent(siteId)}`, signal)
};

const adapter: EditorAdapter = {
  listSites: (signal) => request<readonly EditorSite[]>("/api/sites", signal),
  listPages: (siteId, signal) => request<readonly EditorPage[]>(`/api/pages?siteId=${encodeURIComponent(siteId)}`, signal),
  readDocument: (target, signal) => request<EditorSnapshot>(`/api/document?siteId=${encodeURIComponent(target.siteId)}&pageId=${encodeURIComponent(target.pageId)}&locale=${encodeURIComponent(target.locale)}`, signal),
  saveDraft: (input, signal) => request<EditorSaveResult>("/api/document", signal, "PUT", input),
  prepareRelease: (input, signal) => request<EditorReleasePlan>("/api/release-plan", signal, "POST", input),
  release: (input, signal) => request<EditorReleaseResult>("/api/release", signal, "POST", input),
  components
};

function App() {
  return <PageEditor adapter={adapter} blocks={atelierBlocks} builder={atelierBuilderDefinition} insertableBlocks={["WorkshopNote"]} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("root element is missing");
createRoot(root).render(<App />);
