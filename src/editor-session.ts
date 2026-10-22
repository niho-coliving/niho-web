import { parsePageDocument } from "./document.js";
import { parseSiteSettings } from "./pages.js";
import { fingerprint, parseEditorReadOnly, sameTarget, type EditorHistory } from "./editor-model.js";
import type { ComponentLibrary } from "./types.js";
import type { EditorAdapter, EditorBlockRegistry, EditorLock, EditorReadOnly, EditorSnapshot, EditorTarget } from "./editor-types.js";
import type { SiteStyles } from "./site-styles.js";
import { parseSitePresentation } from "./presentation.js";
import type { SitePresentation } from "./types.js";

export type EditorSession = { target: EditorTarget; history: EditorHistory; version: string; saved: string; hasSavedDraft?: boolean | undefined; locks: readonly EditorLock[]; releases: NonNullable<EditorSnapshot["releases"]>; readOnly?: EditorReadOnly; siteStyles?: SiteStyles; presentation?: SitePresentation; selfContained: boolean };
export type EditorSessionLoad = { session: EditorSession; warning?: string };

export class EditorSessionLoadError extends Error {
  constructor(readonly reason: "document" | "site-settings-required", message: string, options?: ErrorOptions) { super(message, options); this.name = "EditorSessionLoadError"; }
}

export function editorSessionFrom(snapshot: EditorSnapshot, target: EditorTarget, blocks: EditorBlockRegistry, components?: ComponentLibrary, siteStyles?: SiteStyles, selfContained = false): EditorSession {
  const document = parsePageDocument(snapshot.document, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
  if (!sameTarget(document, target) || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("読込対象が一致しません。");
  if (snapshot.hasSavedDraft !== undefined && typeof snapshot.hasSavedDraft !== "boolean") throw new Error("公開状態が正しくありません。");
  const readOnly = parseEditorReadOnly(snapshot.readOnly);
  const presentation = snapshot.presentation === undefined ? undefined : parseSitePresentation(snapshot.presentation, document, blocks);
  return { ...(siteStyles ? { siteStyles } : {}), ...(presentation ? { presentation } : {}), target, history: { past: [], present: document, future: [] }, version: snapshot.version, saved: fingerprint(document), locks: snapshot.locks ?? [], releases: snapshot.releases ?? [], selfContained,
    ...(snapshot.hasSavedDraft === undefined ? {} : { hasSavedDraft: snapshot.hasSavedDraft }), ...(readOnly ? { readOnly } : {}) };
}

/** 文書と任意のサイト設定を独立取得し、設定が無くても単体検証できる文書だけ編集開始する。 */
export async function readEditorSession(adapter: Pick<EditorAdapter, "readDocument" | "readSiteSettings">, target: EditorTarget, signal: AbortSignal, blocks: EditorBlockRegistry = {}, components?: ComponentLibrary): Promise<EditorSessionLoad> {
  const documentRead = adapter.readDocument(target, signal);
  const settingsRead = adapter.readSiteSettings ? adapter.readSiteSettings(target.siteId, signal).then((snapshot) => {
    if (!snapshot || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("site settings version is required");
    return parseSiteSettings(snapshot.settings);
  }) : Promise.resolve(undefined);
  const [documentResult, settingsResult] = await Promise.allSettled([documentRead, settingsRead]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (documentResult.status === "rejected") throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: documentResult.reason });
  if (settingsResult.status === "fulfilled") {
    try {
      return { session: editorSessionFrom(documentResult.value, target, blocks, components, settingsResult.value, !settingsResult.value) };
    } catch (error) {
      throw new EditorSessionLoadError("document", "文書を読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
    }
  }
  try {
    return { session: editorSessionFrom(documentResult.value, target, blocks, components, undefined, true), warning: "サイト設定を読み込めませんでした。文書単体で編集を開始しました。" };
  } catch (error) {
    throw new EditorSessionLoadError("site-settings-required", "この文書に必要なサイト共通スタイルを読み込めませんでした。現在の編集内容は保持されています。", { cause: error });
  }
}
