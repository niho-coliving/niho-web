"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { parseComponentLibrary } from "./components.js";
import { parsePageDocument } from "./document.js";
import { nodeAt, sameTarget, type EditorOperation, type NodePath } from "./editor-model.js";
import { readEditableChildren } from "./editor-rich-text.js";
import type {
  EditorAdapter, EditorBlockRegistry, EditorLocalizationCommand, EditorLocalizedPage, EditorLocalizationPageSnapshot,
  EditorLocalizationSiteSnapshot, EditorTarget, EditorTranslationJob
} from "./editor-types.js";
import {
  collectLocalizationUnits, localizationLocaleFor, localizationStatus, localizedValuesForDocument, materializeLocalizedPage, parseLocalizationOverlay,
  parseSiteLocalizationConfig, type LocalizationCollection, type LocalizationDraftEntry, type LocalizationExtractionOptions,
  type LocalizationLocale, type LocalizationOverlay, type LocalizationUnit, type LocalizationValue, type SiteLocalizationConfig
} from "./localization.js";
import type { ComponentLibrary, ElementNode, PageDocument, PageNode } from "./types.js";

export type EditorLocalizationSite = {
  config: SiteLocalizationConfig;
  pages: readonly EditorLocalizedPage[];
  version: string;
  job?: EditorTranslationJob;
};
export type EditorLocalizationContext = {
  target: EditorTarget;
  targetLocale: LocalizationLocale;
  config: SiteLocalizationConfig;
  sourceDocument: PageDocument;
  sourceVersion: string;
  overlay: LocalizationOverlay;
  version: string;
  collection: LocalizationCollection;
  options: LocalizationExtractionOptions;
  /** Source definitions stay authoritative; this library is a detached target-language materialization for rendering only. */
  localizedComponents?: ComponentLibrary;
  previousSourceValues: Readonly<Record<string, LocalizationValue>>;
  job?: EditorTranslationJob;
};
export type EditorLocalizationLoadState = "idle" | "loading" | "ready" | "error";
export type EditorLocalizationCommandOutcome = "applied" | "conflict" | "failed";
export type EditorLocalizationManualBuffer = {
  target: EditorTarget;
  unitId: string;
  value: LocalizationValue;
  pending: boolean;
  invalid?: boolean;
};

function version(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}
function job(value: EditorTranslationJob | undefined): EditorTranslationJob | undefined {
  if (!value) return undefined;
  if (!["idle", "queued", "running", "failed"].includes(value.state) || value.message !== undefined && (typeof value.message !== "string" || value.message.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.message))) throw new Error("invalid translation job");
  return { state: value.state, ...(value.message === undefined ? {} : { message: value.message }) };
}
function siteSnapshot(input: EditorLocalizationSiteSnapshot, siteId: string): EditorLocalizationSite {
  const config = parseSiteLocalizationConfig(input.config);
  if (config.siteId !== siteId) throw new Error("localization site mismatch");
  if (!Array.isArray(input.pages) || input.pages.length > 10_000) throw new Error("invalid localized page list");
  const states = new Set(["source", "missing", "translating", "review-needed", "reviewed", "failed"]), pages = input.pages.map((page) => {
    if (!page || typeof page !== "object" || page.siteId !== siteId || typeof page.pageId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(page.pageId) ||
      typeof page.title !== "string" || !page.title.trim() || page.title.length > 300 || !page.locales || typeof page.locales !== "object" || Array.isArray(page.locales)) throw new Error("invalid localized page list");
    if (page.path !== undefined && (typeof page.path !== "string" || page.path.length > 160 || /[\u0000-\u001f\u007f]/u.test(page.path)) ||
      page.kind !== undefined && !["page", "template", "shared"].includes(page.kind) || page.visibility !== undefined && !["public", "private"].includes(page.visibility) ||
      page.published !== undefined && typeof page.published !== "boolean") throw new Error("invalid localized page metadata");
    const localeKeys = Object.keys(page.locales);
    if (localeKeys.some((locale) => locale !== "ja" && locale !== "en")) throw new Error("invalid localized page status");
    const locales: EditorLocalizedPage["locales"] = {};
    for (const locale of ["ja", "en"] as const) {
      const entry = page.locales[locale]; if (!entry) continue;
      if (!states.has(entry.state) || entry.changed !== undefined && (!Number.isSafeInteger(entry.changed) || entry.changed < 0) || entry.published !== undefined && typeof entry.published !== "boolean") throw new Error("invalid localized page status");
      locales[locale] = { state: entry.state, ...(entry.changed === undefined ? {} : { changed: entry.changed }), ...(entry.published === undefined ? {} : { published: entry.published }) };
    }
    for (const locale of ["ja", "en"] as const) {
      const entry = locales[locale], enabled = config.enabledLocales.includes(locale);
      if (enabled !== !!entry || entry && (locale === config.sourceLocale ? entry.state !== "source" : entry.state === "source")) throw new Error("localized page status does not match locale mapping");
    }
    return { siteId, pageId: page.pageId, title: page.title, locales,
      ...(page.path === undefined ? {} : { path: page.path }), ...(page.kind === undefined ? {} : { kind: page.kind }),
      ...(page.visibility === undefined ? {} : { visibility: page.visibility }), ...(page.published === undefined ? {} : { published: page.published }) };
  });
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length) {
    throw new Error("invalid localized page list");
  }
  return { config, pages, version: version(input.version, "site localization version"), ...(input.job ? { job: job(input.job)! } : {}) };
}
function previousValues(value: EditorLocalizationPageSnapshot["previousSourceValues"], units: readonly LocalizationUnit[]): Readonly<Record<string, LocalizationValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const known = new Set(units.map((unit) => unit.unitId));
  const entries = Object.entries(value).filter(([key]) => known.has(key)).map(([unitId, draftValue]) => ({ unitId, kind: units.find((unit) => unit.unitId === unitId)!.kind, version: 1, draftValue, editOrigin: "MANUAL" as const }));
  if (!entries.length) return {};
  const parsed = parseLocalizationOverlay({ schemaVersion: 1, siteId: "history", pageId: "history", sourceLocale: "ja", targetLocale: "en", version: 1, entries });
  return Object.fromEntries(parsed.entries.map((entry) => [entry.unitId, entry.draftValue!]));
}

export function useEditorLocalization(adapter: EditorAdapter, siteId: string, target: EditorTarget | undefined, blocks: EditorBlockRegistry,
  canonicalComponents: ComponentLibrary | undefined, epoch: number, report: (message: string) => void) {
  const supported = !!adapter.localization;
  const [site, setSite] = useState<EditorLocalizationSite | null>(null), [context, setContext] = useState<EditorLocalizationContext | null>(null);
  const [siteState, setSiteState] = useState<EditorLocalizationLoadState>(supported ? "loading" : "idle"), [pageState, setPageState] = useState<EditorLocalizationLoadState>("idle");
  const [siteEpoch, setSiteEpoch] = useState(0), [pageEpoch, setPageEpoch] = useState(0);
  useEffect(() => {
    setSite((current) => current?.config.siteId === siteId ? current : null);
    setContext((current) => current?.target.siteId === siteId ? current : null);
    if (!adapter.localization || !siteId) { setSiteState("idle"); setPageState("idle"); return; }
    const controller = new AbortController(); setSiteState("loading");
    adapter.localization.readSite(siteId, controller.signal).then((snapshot) => {
      if (!controller.signal.aborted) { setSite(siteSnapshot(snapshot, siteId)); setSiteState("ready"); }
    }).catch(() => { if (!controller.signal.aborted) { setSiteState("error"); report("言語設定と翻訳状況を読み込めませんでした。再試行してください。"); } });
    return () => controller.abort();
  }, [adapter, siteId, siteEpoch, report]);
  useEffect(() => {
    if (!adapter.localization || siteState !== "ready" || !site || !target || target.siteId !== site.config.siteId) {
      if (!target || context?.target.siteId !== target.siteId || context?.target.pageId !== target.pageId || context?.target.locale !== target.locale) setContext(null);
      setPageState("idle"); return;
    }
    let locale: LocalizationLocale;
    try { locale = localizationLocaleFor(site.config, target.locale); } catch { setContext(null); setPageState("error"); report("文書の言語がサイトの明示設定にありません。編集と保存を停止しました。"); return; }
    if (!site.config.enabledLocales.includes(locale)) { setContext(null); setPageState("error"); report("無効な言語の文書です。編集と保存を停止しました。"); return; }
    if (locale === site.config.sourceLocale) { setContext(null); setPageState("ready"); return; }
    const controller = new AbortController(); setPageState("loading");
    adapter.localization.readPage(target, controller.signal).then(async (snapshot) => {
      // adapter.components があるホストでは LibrarySession が唯一の正本。readPage.components は旧ホスト用のfallbackに限る。
      const fallbackComponents = snapshot.components === undefined ? undefined : parseComponentLibrary(snapshot.components, blocks);
      const components = canonicalComponents ?? fallbackComponents;
      if (components && components.siteId !== target.siteId) throw new Error("component library scope mismatch");
      const options: LocalizationExtractionOptions = { blocks, ...(components ? { components } : {}), ...(snapshot.blockLocalization ? { blockLocalization: snapshot.blockLocalization } : {}) };
      const sourceDocument = parsePageDocument(snapshot.sourceDocument, blocks, components ? { components } : {});
      if (sourceDocument.siteId !== target.siteId || sourceDocument.pageId !== target.pageId || sourceDocument.locale !== site.config.documentLocales[site.config.sourceLocale]) throw new Error("source scope mismatch");
      const collection = await collectLocalizationUnits(site.config, sourceDocument, locale, options), overlay = parseLocalizationOverlay(snapshot.overlay);
      localizationStatus(overlay, collection);
      const materialized = await materializeLocalizedPage(site.config, sourceDocument, collection, overlay, options);
      if (controller.signal.aborted) return;
      setContext({ target: { ...target }, targetLocale: locale, config: site.config, sourceDocument, sourceVersion: version(snapshot.sourceVersion, "source version"),
        overlay, version: version(snapshot.version, "localization version"), collection, options, previousSourceValues: previousValues(snapshot.previousSourceValues, collection.units),
        ...(materialized.components ? { localizedComponents: materialized.components } : {}),
        ...(snapshot.job ? { job: job(snapshot.job)! } : {}) });
      setPageState("ready");
    }).catch(() => { if (!controller.signal.aborted) { setPageState("error"); report("この言語の原文・訳文状態を読み込めませんでした。編集内容は保持されています。再試行してください。"); } });
    return () => controller.abort();
  }, [adapter, site, siteState, target?.siteId, target?.pageId, target?.locale, blocks, canonicalComponents, epoch, pageEpoch, report]);
  const reloadSite = () => setSiteEpoch((value) => value + 1), reloadPage = () => setPageEpoch((value) => value + 1);
  return { supported, site, context, siteState, pageState, siteBusy: siteState === "loading", pageBusy: pageState === "loading", reloadSite, reloadPage,
    reloadAll: () => { reloadSite(); reloadPage(); } };
}

const unitForField = (collection: LocalizationCollection, field: string) => collection.units.find((unit) => unit.scope === "page" && unit.field === field);
function anchorUnit(document: PageDocument, path: NodePath, collection: LocalizationCollection): LocalizationUnit | undefined {
  for (let depth = path.length; depth > 0; depth--) {
    const node = nodeAt(document, path.slice(0, depth));
    if (node.type === "text") continue;
    const unit = unitForField(collection, `node.${node.id}.text`) ?? unitForField(collection, `node.${node.id}.richText`);
    if (unit) return unit;
  }
  return undefined;
}
function protectedShape(nodes: readonly PageNode[]): string {
  const entries: unknown[] = [];
  const visit = (node: PageNode, parent: string): void => {
    if (node.type === "text") return;
    if (node.type !== "element") { entries.push({ parent, node }); return; }
    const { children: _children, ...common } = node;
    entries.push({ parent, ...common }); node.children.forEach((child) => visit(child, node.id));
  };
  nodes.forEach((node) => visit(node, "$root"));
  return JSON.stringify(entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

/** Immediate UI gate. Hosts must also await validateLocalizedDocumentSave at their save boundary. */
export function localizedOperationProblem(document: PageDocument, operation: EditorOperation, collection: LocalizationCollection): string | undefined {
  const denied = "共通デザインは原文側で編集してください。";
  if (collection.issues.length) return "原文に未対応の内容があるため、訳文を編集できません。";
  if (operation.type === "title") return unitForField(collection, "title") ? undefined : denied;
  if (operation.type === "meta") {
    if (operation.field === "description") return unitForField(collection, "meta.description") ? undefined : denied;
    if (operation.field === "ogImage" && operation.value && document.meta?.ogImage && operation.value.src === document.meta.ogImage.src && unitForField(collection, "meta.ogImage.alt")) return undefined;
    return denied;
  }
  if (!("path" in operation)) return denied;
  const node = nodeAt(document, operation.path);
  if (operation.type === "text") return anchorUnit(document, operation.path, collection) ? undefined : denied;
  if (operation.type === "replaceChildren") {
    const unit = anchorUnit(document, operation.path, collection);
    if (!unit || node.type !== "element") return "リンクや装飾の構造は訳文側で変更できません。文字だけを編集してください。";
    if (unit.kind === "text") return operation.children.length === 1 && operation.children[0]?.type === "text" ? undefined : "文字の構造は訳文側で変更できません。";
    return protectedShape(node.children) === protectedShape(operation.children) ? undefined : "リンクや装飾の構造は訳文側で変更できません。文字だけを編集してください。";
  }
  if (node.type === "text") return denied;
  if (operation.type === "attribute") return unitForField(collection, `node.${node.id}.attr.${operation.name}`) ? undefined : denied;
  if (operation.type === "image") {
    if (!("asset" in operation.source) || !unitForField(collection, `node.${node.id}.asset`)) return denied;
    if (operation.alt !== undefined && !unitForField(collection, `node.${node.id}.attr.alt`)) return denied;
    return undefined;
  }
  if (operation.type === "prop" && node.type === "component") return unitForField(collection, `block.${node.id}.prop.${operation.name}`) ? undefined : denied;
  if (operation.type === "instanceProp" && node.type === "instance") return unitForField(collection, `instance.${node.id}.prop.${operation.name}`) ? undefined : denied;
  return denied;
}

export const localizationStateLabel = (state: string) => ({ source: "原文", missing: "未翻訳", translating: "翻訳中", draft: "下書き", "review-needed": "更新あり", reviewed: "確認済み", failed: "失敗" }[state] ?? state);
const textOf = (value: LocalizationValue | undefined): string => value === undefined ? "（なし）" : typeof value === "string" ? value : value.kind === "asset" ? `${value.asset.provider} / ${value.asset.id}` : value.children.map(function flatten(node): string { return node.type === "text" ? node.text : node.children.map(flatten).join(""); }).join("");
const sameValue = (left: LocalizationValue, right: LocalizationValue): boolean => JSON.stringify(left) === JSON.stringify(right);
function unitLabel(unit: LocalizationUnit, context: EditorLocalizationContext): string {
  const owner = unit.scope === "page" ? "このページ" : `共通部品「${(context.options.components as ComponentLibrary | undefined)?.components.find((component) => component.id === unit.ownerId)?.name ?? unit.ownerId}」`;
  if (unit.field === "title") return "ページタイトル";
  if (unit.field === "meta.description") return "ページの説明文";
  if (unit.field === "meta.ogImage.alt") return "ソーシャル画像の説明";
  const parts = unit.field.split("."), detail = parts[2] === "text" ? "テキスト" : parts[2] === "richText" ? "リッチテキスト" : parts[2] === "asset" ? "画像" : parts[2] === "attr"
    ? ({ alt: "画像の説明", "aria-label": "読み上げ用ラベル", title: "補足タイトル" } as Record<string, string>)[parts[3]!] ?? parts[3]! : parts[0] === "instance" ? `配置別の ${parts[3]}` : parts[0] === "block" ? `ブロックの ${parts[3]}` : unit.context;
  const source = unit.kind === "asset" ? "" : textOf(unit.sourceValue).replace(/\s+/gu, " ").trim();
  const excerpt = source ? ` · 「${source.slice(0, 28)}${source.length > 28 ? "…" : ""}」` : "";
  return `${owner} · ${detail}${excerpt}`;
}

function richPageNodes(value: Extract<LocalizationValue, { kind: "rich-text" }>["children"]): PageNode[] {
  return value.map((node): PageNode => node.type === "text" ? { type: "text", text: node.text } : { type: "element", id: node.id, tag: node.tag,
    ...(node.tag === "a" ? { attrs: { href: "/" } } : {}), children: richPageNodes(node.children) });
}
function localizedRichNodes(nodes: readonly PageNode[]): Extract<LocalizationValue, { kind: "rich-text" }>["children"] {
  return nodes.map((node) => {
    if (node.type === "text") return { type: "text" as const, text: node.text };
    if (node.type !== "element" || !["a", "strong", "em", "b", "i", "small", "span", "br"].includes(node.tag)) throw new Error("リンクや装飾は変更せず、文字だけを編集してください。");
    return { type: "element" as const, id: node.id, tag: node.tag as "a" | "strong" | "em" | "b" | "i" | "small" | "span" | "br", children: localizedRichNodes(node.children) };
  });
}
const richShape = (nodes: Extract<LocalizationValue, { kind: "rich-text" }>["children"]): string => JSON.stringify(nodes.flatMap(function visit(node): unknown[] { return node.type === "text" ? [] : [{ id: node.id, tag: node.tag }, ...node.children.flatMap(visit)]; }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function RichManualEditor({ value, accepted, disabled, pending, invalid, save, change, cancel }: {
  value: Extract<LocalizationValue, { kind: "rich-text" }>; accepted: Extract<LocalizationValue, { kind: "rich-text" }>;
  disabled: boolean; pending: boolean; invalid: boolean;
  save: (value: LocalizationValue) => Promise<EditorLocalizationCommandOutcome>;
  change: (value: LocalizationValue, invalid?: boolean) => void; cancel: () => void;
}) {
  const root = useRef<HTMLDivElement>(null), [error, setError] = useState(""), [reset, setReset] = useState(0);
  const original: ElementNode = { type: "element", id: "localized_rich_editor", tag: "p", children: richPageNodes(value.children) };
  const render = (node: PageNode, index: number): ReactNode => node.type === "text" ? node.text : node.type !== "element" ? null : (() => {
    const Tag = node.tag;
    if (node.tag === "br") return <br key={`${node.id}-${index}`} data-nw-node={node.id} />;
    return <Tag key={`${node.id}-${index}`} data-nw-node={node.id} {...(node.tag === "a" ? { href: "/", onClick: (event: MouseEvent) => event.preventDefault() } : {})}>{node.children.map(render)}</Tag>;
  })();
  const read = (): Extract<LocalizationValue, { kind: "rich-text" }> => {
    if (!root.current) throw new Error("訳文を確認できませんでした。");
    const acceptedRoot: ElementNode = { type: "element", id: "localized_rich_editor", tag: "p", children: richPageNodes(accepted.children) };
    const children = localizedRichNodes(readEditableChildren(root.current, acceptedRoot));
    if (richShape(children) !== richShape(accepted.children)) throw new Error("リンクや装飾は変更せず、文字だけを編集してください。");
    return { kind: "rich-text", children };
  };
  const changed = () => {
    try {
      const next = read(); setError(""); change(next);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "訳文を確認できませんでした。"); change(value, true); }
  };
  const submit = async () => {
    try { const next = read(); setError(""); change(next); await save(next); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "訳文を確認できませんでした。"); change(value, true); }
  };
  const cancelInput = () => { setError(""); setReset((current) => current + 1); cancel(); };
  return <div className="e-localization-manual"><div key={reset} ref={root} className="e-localization-rich" contentEditable={!disabled} suppressContentEditableWarning
      role="textbox" aria-label="訳文を手修正" aria-multiline="true" onInput={changed}>{original.children.map(render)}</div>
    {(error || invalid) && <small className="e-help e-problem" role="alert">{error || "入力内容を確認してください。"}</small>}
    {pending && <small className="e-help" role="status">未保存の手修正があります。保存するか入力を取り消してください。</small>}
    <div className="e-actions"><button type="button" className="e-small" disabled={disabled || !pending} onClick={() => void submit()}>手修正を保存</button>
      <button type="button" className="e-small" disabled={disabled || !pending} onClick={cancelInput}>入力を取り消す</button></div></div>;
}
function ManualValueEditor({ unit, value, accepted, disabled, pending, invalid, save, change, cancel, pickAsset }: {
  unit: LocalizationUnit; value: LocalizationValue; accepted: LocalizationValue; disabled: boolean; pending: boolean; invalid: boolean;
  save: (value: LocalizationValue) => Promise<EditorLocalizationCommandOutcome>; change: (value: LocalizationValue, invalid?: boolean) => void; cancel: () => void; pickAsset?: () => void;
}) {
  if (unit.kind === "asset") return <div className="e-localization-manual"><small className="e-help">現在の素材: {textOf(value)}</small><button type="button" className="e-small" disabled={disabled || !pickAsset} onClick={pickAsset}>素材を選ぶ</button></div>;
  if (unit.kind === "rich-text" && typeof value !== "string" && value.kind === "rich-text" && typeof accepted !== "string" && accepted.kind === "rich-text") {
    return <RichManualEditor value={value} accepted={accepted} disabled={disabled} pending={pending} invalid={invalid} save={save} change={change} cancel={cancel} />;
  }
  const text = typeof value === "string" ? value : "";
  const Input = unit.singleLine ? "input" : "textarea";
  return <div className="e-localization-manual"><label className="e-field"><span>訳文を手修正</span><Input value={text} disabled={disabled} onChange={(event) => change(event.target.value)} /></label>
    {pending && <small className="e-help" role="status">未保存の手修正があります。保存するか入力を取り消してください。</small>}
    <div className="e-actions"><button type="button" className="e-small" disabled={disabled || invalid || !unit.allowEmpty && !text.trim()} onClick={() => void save(text)}>手修正を保存</button>
      <button type="button" className="e-small" disabled={disabled || !pending} onClick={cancel}>入力を取り消す</button></div></div>;
}

export function LocalizationPanel({ context, document, disabled, selectedUnit, run, refresh, pickAsset, manualBuffer, setManualBuffer }: {
  context: EditorLocalizationContext; document: PageDocument; disabled: boolean;
  selectedUnit?: string | null; run: (request: EditorLocalizationCommand) => Promise<EditorLocalizationCommandOutcome>; refresh: () => void; pickAsset?: (unit: LocalizationUnit) => void;
  manualBuffer: EditorLocalizationManualBuffer | null; setManualBuffer: (buffer: EditorLocalizationManualBuffer | null) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedUnit) return;
    const selected = Array.from(panel.current?.querySelectorAll<HTMLElement>("[data-unit-id]") ?? [])
      .find((element) => element.dataset.unitId === selectedUnit);
    const rail = panel.current?.closest<HTMLElement>(".e-right");
    if (!selected || !rail) return;
    const tabsHeight = rail.querySelector<HTMLElement>(".e-inspector-tabs")?.getBoundingClientRect().height ?? 0;
    // Keep the language toolbar and canvas in place; scroll only the comparison rail.
    rail.scrollTop = Math.max(0, rail.scrollTop + selected.getBoundingClientRect().top - rail.getBoundingClientRect().top - tabsHeight - 12);
  }, [selectedUnit, context.collection]);
  let current: Readonly<Record<string, LocalizationValue>> = {};
  try { current = localizedValuesForDocument(document, context.collection, context.options); } catch { /* save validation reports the precise problem */ }
  const entries = new Map(context.overlay.entries.map((entry) => [entry.unitId, entry])), states = new Map(localizationStatus(context.overlay, context.collection).details.map((entry) => [entry.unitId, entry]));
  const bufferedUnit = manualBuffer && sameTarget(manualBuffer.target, context.target) ? context.collection.units.find((unit) => unit.unitId === manualBuffer.unitId) : undefined;
  const bufferedEntry = bufferedUnit ? entries.get(bufferedUnit.unitId) : undefined;
  const bufferedAccepted = bufferedUnit ? bufferedEntry?.draftValue ?? current[bufferedUnit.unitId] ?? bufferedUnit.sourceValue : undefined;
  const bufferedAcceptedKey = bufferedAccepted === undefined ? "" : JSON.stringify(bufferedAccepted);
  useEffect(() => {
    if (manualBuffer && !manualBuffer.pending && bufferedAccepted !== undefined && sameValue(manualBuffer.value, bufferedAccepted)) setManualBuffer(null);
  }, [bufferedAcceptedKey, manualBuffer, setManualBuffer]);
  const request = (action: "request-translation") => run({ action, target: context.target, expectedSourceVersion: context.sourceVersion, expectedVersion: context.version, expectedOverlayVersion: context.overlay.version });
  const command = (action: "adopt-candidate" | "review-current", unit: LocalizationUnit, entry: LocalizationDraftEntry) => run({ action, target: context.target, unitId: unit.unitId,
    ...(action === "adopt-candidate" ? { candidateVersion: entry.candidate!.version } : {}), expectedSourceVersion: context.sourceVersion, expectedVersion: context.version, expectedOverlayVersion: context.overlay.version } as EditorLocalizationCommand);
  const manual = async (unit: LocalizationUnit, entry: LocalizationDraftEntry | undefined, value: LocalizationValue) => {
    const outcome = await run({ action: "set-value", target: context.target, unitId: unit.unitId, value,
      sourceFingerprint: unit.sourceFingerprint, expectedEntryVersion: entry?.version ?? 0, expectedSourceVersion: context.sourceVersion, expectedVersion: context.version, expectedOverlayVersion: context.overlay.version });
    if (outcome === "applied") setManualBuffer({ target: { ...context.target }, unitId: unit.unitId, value, pending: false });
    return outcome;
  };
  const bufferFor = (unit: LocalizationUnit) => manualBuffer && sameTarget(manualBuffer.target, context.target) && manualBuffer.unitId === unit.unitId ? manualBuffer : null;
  const manualPending = !!manualBuffer?.pending && sameTarget(manualBuffer.target, context.target);
  return <div ref={panel} className="e-localization-panel"><section className="e-section"><h3>翻訳の比較</h3>
    <p className="e-help">原文の現在値・現在の訳・翻訳案を比較します。訳文は中央キャンバスか要素欄で編集できます。</p>
    {manualPending && <p className="e-help e-problem" role="status">手修正の入力中です。保存するか「入力を取り消す」で戻すまで、ほかの翻訳操作と画面移動はできません。</p>}
    {manualPending && !bufferedUnit && <button type="button" className="e-small" disabled={disabled} onClick={() => setManualBuffer(null)}>入力を取り消す</button>}
    {context.job?.state === "failed" && <p className="e-help e-problem" role="alert">翻訳に失敗しました。{context.job.message ? ` ${context.job.message}` : ""}</p>}
    {context.job && ["queued", "running"].includes(context.job.state) && <p className="e-help" role="status">{context.job.state === "queued" ? "翻訳を待機中です。" : "翻訳中です。"}</p>}
    <button type="button" className="e-small" disabled={disabled || manualPending || context.job?.state === "queued" || context.job?.state === "running"} onClick={() => void request("request-translation")}>{context.job?.state === "failed" ? "翻訳を再試行" : "このページを翻訳"}</button>
    {context.job && ["queued", "running", "failed"].includes(context.job.state) && <button type="button" className="e-small" disabled={disabled || manualPending} onClick={refresh}>翻訳状況を更新</button>}
  </section>{context.collection.issues.length > 0 && <p className="e-help e-problem" role="alert">原文に未対応またはIDのない内容が {context.collection.issues.length} 件あります。公開可能な訳文にはできません。</p>}
  {context.collection.units.map((unit) => {
    const entry = entries.get(unit.unitId), state = states.get(unit.unitId), currentCandidate = entry?.candidate?.sourceFingerprint === unit.sourceFingerprint;
    const currentValue = entry?.draftValue ?? current[unit.unitId] ?? unit.sourceValue, buffer = bufferFor(unit), displayedValue = buffer?.value ?? currentValue;
    return <section className={`e-section e-localization-unit${selectedUnit === unit.unitId ? " is-selected" : ""}`} data-unit-id={unit.unitId} key={unit.unitId}><div className="e-section-head"><h3>{unitLabel(unit, context)}</h3><span className="e-badge">{unit.scope === "shared-component" ? "共通部品" : "ページ"}</span><span className="e-badge">{localizationStateLabel(state?.state ?? "missing")}</span></div>
      <dl className="e-rows"><div><dt>現在の原文</dt><dd>{textOf(unit.sourceValue)}</dd></div>
        {context.previousSourceValues[unit.unitId] !== undefined && <div><dt>以前の原文</dt><dd>{textOf(context.previousSourceValues[unit.unitId])}</dd></div>}
        <div><dt>現在の訳</dt><dd>{textOf(currentValue)}</dd></div>
        {entry?.candidate && <div><dt>{currentCandidate ? "新しい翻訳案" : "以前の原文への翻訳案"}</dt><dd>{textOf(entry.candidate.value)}</dd></div>}</dl>
      <ManualValueEditor unit={unit} value={displayedValue} accepted={currentValue} disabled={disabled || manualPending && !buffer?.pending} pending={!!buffer?.pending} invalid={!!buffer?.invalid}
        change={(value, invalid = false) => setManualBuffer(!invalid && sameValue(value, currentValue) ? null : { target: { ...context.target }, unitId: unit.unitId, value, pending: true, ...(invalid ? { invalid: true } : {}) })}
        cancel={() => setManualBuffer(null)} save={(value) => manual(unit, entry, value)} {...(unit.kind === "asset" && pickAsset ? { pickAsset: () => pickAsset(unit) } : {})} />
      <div className="e-actions">{entry?.candidate && currentCandidate && <button type="button" disabled={disabled || manualPending} onClick={() => void command("adopt-candidate", unit, entry)}>翻訳案を採用</button>}
        {entry?.draftValue !== undefined && <button type="button" disabled={disabled || manualPending} onClick={() => void command("review-current", unit, entry)}>現在の訳を確認済みにする</button>}</div>
    </section>;
  })}</div>;
}

export function LanguageSelector({ config, locale, disabled, select }: { config: SiteLocalizationConfig; locale: LocalizationLocale; disabled: boolean; select: (locale: LocalizationLocale) => void }) {
  return <div className="e-language-selector" role="group" aria-label="編集する言語">{config.enabledLocales.map((value) => <button type="button" key={value} aria-pressed={value === locale} disabled={disabled || value === locale} onClick={() => select(value)}>{value === "ja" ? "日本語" : "English"}{value === config.sourceLocale ? "（原文）" : "（訳文）"}</button>)}</div>;
}

export const localizationEditorCss = `
.e-language-selector{display:flex;gap:4px;align-items:center}.e-language-selector button[aria-pressed=true]{background:var(--e-green);color:var(--e-soft)}
.e-localization-gate{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 18px;border-bottom:1px solid var(--e-border);background:var(--e-soft);color:var(--e-green)}
.e-localization-panel .e-localization-unit{border-top:1px solid var(--e-border);padding:10px}.e-localization-panel .e-localization-unit.is-selected{outline:2px solid var(--e-green);outline-offset:-2px}.e-localization-unit dd{white-space:pre-wrap;overflow-wrap:anywhere}
.e-localization-unit .e-section-head{justify-content:flex-start}.e-localization-unit .e-section-head h3{margin-right:auto}.e-localization-manual{margin:10px 0}.e-localization-rich{min-height:64px;padding:8px;border:1px solid var(--e-border);border-radius:7px;background:inherit}.e-localization-rich:focus{outline:2px solid var(--e-green);outline-offset:1px}
.e-locale-states{display:flex;gap:4px;margin-left:auto}.e-locale-states .e-badge{font-size:10px}
`;
