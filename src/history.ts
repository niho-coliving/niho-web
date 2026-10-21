import type { EditorTarget } from "./editor-types.js";
import type { ComponentLibrary, ComponentNode, DesignToken, ElementNode, InstanceNode, NodeStyle, PageDocument, PageImage, PageNode } from "./types.js";

/** 人が読む差分。path は日本語の箇所名、before / after は表示用の文字列。 */
export type DocumentChange = { path: string; before: string; after: string };
const none = "（なし）", maxValue = 200;
const clip = (value: string) => value.length > maxValue ? `${value.slice(0, maxValue - 1)}…` : value;
function show(value: unknown): string {
  if (value === undefined || value === null) return none;
  if (typeof value === "object" && "token" in value) return clip(`@${String((value as { token: unknown }).token)}`);
  if (Array.isArray(value)) return value.length ? clip(value.map(String).join(", ")) : none;
  if (typeof value === "object") return clip(JSON.stringify(value));
  const text = String(value);
  return text === "" ? "（空）" : clip(text);
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
type Owned = ElementNode | ComponentNode | InstanceNode;
type Placed = { node: Owned; parent: string | null };
const nodeLabel = (node: Owned) => `${node.type === "element" ? node.tag : node.type === "component" ? node.block : `部品 ${node.component}`}#${node.id}`;
function placed(document: PageDocument): Map<string, Placed> {
  const result = new Map<string, Placed>();
  const visit = (nodes: readonly PageNode[], parent: string | null) => {
    for (const node of nodes) {
      if (node.type === "text") continue;
      result.set(node.id, { node, parent });
      if (node.type === "element") visit(node.children, node.id);
    }
  };
  visit(document.body, null); return result;
}
const textOf = (nodes: readonly PageNode[]): string => nodes.map((node) => node.type === "text" ? node.text : node.type === "element" ? textOf(node.children) : "").join("");
const directText = (nodes: readonly PageNode[]) => nodes.flatMap((node) => node.type === "text" ? [node.text] : []).join("");
function summary(node: Owned): string {
  if (node.type !== "element") return show(Object.entries(node.props ?? {}).map(([name, value]) => `${name}: ${String(value)}`).join(", ") || nodeLabel(node));
  const text = textOf(node.children).replace(/\s+/g, " ").trim(), source = node.attrs?.src ?? node.attrs?.href;
  return show(text || (typeof source === "string" ? source : nodeLabel(node)));
}
/** before と after に共通する同じ親の子の並び。前後の追加・削除では位置の変更にしない。 */
function siblingOrder(document: Map<string, Placed>, other: Map<string, Placed>): Map<string, number> {
  const counts = new Map<string | null, number>(), order = new Map<string, number>();
  for (const [id, { parent }] of document) {
    if (other.get(id)?.parent !== parent) continue;
    const index = counts.get(parent) ?? 0; counts.set(parent, index + 1); order.set(id, index);
  }
  return order;
}
function position(document: PageDocument, entries: Map<string, Placed>, id: string): string {
  const parent = entries.get(id)?.parent ?? null, owner = parent === null ? undefined : entries.get(parent)?.node;
  const siblings = parent === null ? document.body : owner?.type === "element" ? owner.children : [];
  const index = siblings.filter((node) => node.type !== "text").findIndex((node) => node.id === id);
  return `${owner ? `${nodeLabel(owner)} の` : "ページ直下の"} ${index + 1} 番目`;
}
function flatStyle(style: NodeStyle | undefined): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [property, value] of Object.entries(style?.base ?? {})) result.set(`共通\u0000${property}`, value);
  for (const entry of style?.responsive ?? []) for (const [property, value] of Object.entries(entry.declarations)) result.set(`${entry.minWidth}\u0000${property}`, value);
  return result;
}
const unionKeys = <T>(after: Iterable<T>, before: Iterable<T>): T[] => [...new Set([...after, ...before])];
function compareFields(changes: DocumentChange[], prefix: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const name of unionKeys(Object.keys(after), Object.keys(before))) if (!same(before[name], after[name])) changes.push({ path: `${prefix}${name}`, before: show(before[name]), after: show(after[name]) });
}
function compareNodes(changes: DocumentChange[], before: Owned, after: Owned): void {
  const label = nodeLabel(after);
  if (before.type === "element" && after.type === "element") {
    if (before.tag !== after.tag) changes.push({ path: `${label} の種類`, before: before.tag, after: after.tag });
    const oldText = directText(before.children), newText = directText(after.children);
    if (oldText !== newText) changes.push({ path: `${label} のテキスト`, before: oldText ? show(oldText) : none, after: newText ? show(newText) : none });
    compareFields(changes, `${label} の `, before.attrs ?? {}, after.attrs ?? {});
    if (!same(before.asset, after.asset)) changes.push({ path: `${label} の素材`, before: show(before.asset), after: show(after.asset) });
  } else if (before.type === "component" && after.type === "component") {
    compareFields(changes, `${label} の `, before.props, after.props);
    for (const slot of unionKeys(Object.keys(after.slots ?? {}), Object.keys(before.slots ?? {}))) compareStyle(changes, `${label} の領域 ${slot}`, before.slots?.[slot], after.slots?.[slot]);
  } else if (before.type === "instance" && after.type === "instance") {
    if (before.component !== after.component) changes.push({ path: `${label} の部品`, before: before.component, after: after.component });
    compareFields(changes, `${label} の `, before.props ?? {}, after.props ?? {});
  }
  compareStyle(changes, label, before.style, after.style);
}
function compareStyle(changes: DocumentChange[], label: string, before: NodeStyle | undefined, after: NodeStyle | undefined): void {
  if (!same(before?.textStyle, after?.textStyle)) changes.push({ path: `${label} の文字スタイル`, before: show(before?.textStyle), after: show(after?.textStyle) });
  const oldStyle = flatStyle(before), newStyle = flatStyle(after);
  const keys = unionKeys(newStyle.keys(), oldStyle.keys()).sort((left, right) => {
    const scope = (key: string) => { const head = key.split("\u0000")[0]!; return head === "共通" ? -1 : Number(head); };
    return scope(left) - scope(right);
  });
  for (const key of keys) {
    if (same(oldStyle.get(key), newStyle.get(key))) continue;
    const [scope, property] = key.split("\u0000") as [string, string];
    changes.push({ path: `${label} の見た目（${scope === "共通" ? "共通" : `${scope}px以上`}）: ${property}`, before: show(oldStyle.get(key)), after: show(newStyle.get(key)) });
  }
}

/** 2つの文書の差分を、決まった順序の人が読める一覧にする。入力は変更しない。 */
export function diffDocuments(before: PageDocument, after: PageDocument, options: { limit?: number } = {}): DocumentChange[] {
  const changes: DocumentChange[] = [];
  const push = (path: string, left: unknown, right: unknown, format: (value: unknown) => string = show) => { if (!same(left, right)) changes.push({ path, before: format(left), after: format(right) }); };
  push("ページタイトル", before.title, after.title);
  const oldMeta = before.meta ?? {}, newMeta = after.meta ?? {};
  push("説明文", oldMeta.description, newMeta.description);
  push("ソーシャルカバー", oldMeta.ogImage, newMeta.ogImage, (value) => {
    if (!value || typeof value !== "object") return none;
    const image = value as PageImage;
    return show(`${"asset" in image ? `素材 ${image.asset.provider}:${image.asset.id}` : image.src}（${image.alt}）`);
  });
  push("ファビコン", oldMeta.favicon, newMeta.favicon);
  push("検索エンジンに表示しない", !!oldMeta.noindex, !!newMeta.noindex, (value) => value ? "表示しない" : "表示する");
  push("構造化データ", oldMeta.structuredData ?? [], newMeta.structuredData ?? []);
  for (const name of unionKeys(Object.keys(after.tokens), Object.keys(before.tokens))) {
    const oldToken = before.tokens[name], newToken = after.tokens[name], typed = oldToken && newToken && oldToken.type !== newToken.type;
    push(`トークン @${name}`, oldToken, newToken, (value) => value && typeof value === "object" ? show(typed ? `${String((value as { value: unknown }).value)}（${(value as { type: string }).type}）` : (value as { value: unknown }).value) : none);
  }
  const oldStyles = before.textStyles ?? {}, newStyles = after.textStyles ?? {};
  for (const name of unionKeys(Object.keys(newStyles), Object.keys(oldStyles))) push(`文字スタイル ${newStyles[name]?.label ?? oldStyles[name]?.label ?? name}`, oldStyles[name], newStyles[name], (value) => value && typeof value === "object" ? show(JSON.stringify(value)) : none);
  const oldText = directText(before.body), newText = directText(after.body);
  if (oldText !== newText) changes.push({ path: "ページ直下のテキスト", before: oldText ? show(oldText) : none, after: newText ? show(newText) : none });
  const oldNodes = placed(before), newNodes = placed(after), oldOrder = siblingOrder(oldNodes, newNodes), newOrder = siblingOrder(newNodes, oldNodes);
  const added = new Set<string>();
  for (const [id, { node, parent }] of newNodes) {
    const previous = oldNodes.get(id)?.node;
    if (!previous || previous.type !== node.type) {
      added.add(id);
      if (parent === null || !added.has(parent)) changes.push({ path: `${nodeLabel(node)} を追加`, before: none, after: summary(node) });
      continue;
    }
    if (oldNodes.get(id)!.parent !== parent || oldOrder.get(id) !== newOrder.get(id)) changes.push({ path: `${nodeLabel(node)} の位置`, before: position(before, oldNodes, id), after: position(after, newNodes, id) });
    compareNodes(changes, previous, node);
  }
  const removed = new Set<string>();
  for (const [id, { node, parent }] of oldNodes) {
    const next = newNodes.get(id)?.node;
    if (next && next.type === node.type) continue;
    removed.add(id);
    if (parent === null || !removed.has(parent)) changes.push({ path: `${nodeLabel(node)} を削除`, before: summary(node), after: none });
  }
  const requested = options.limit ?? 300, limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 300;
  return changes.length > limit ? [...changes.slice(0, limit), { path: "ほかの変更", before: "", after: `${changes.length - limit} 件` }] : changes;
}

export type EditorRevisionKind = "draft" | "autosave" | "snapshot" | "publish" | "rollback";
/** 版履歴の1件。id は opaque、actor は表示名だけ。 */
export type EditorRevisionEntry = { id: string; revision: number; kind: EditorRevisionKind; createdAt: string; actor?: string; label?: string };
export type EditorRevisionPage = { entries: readonly EditorRevisionEntry[]; next?: string };
const revisionKinds: readonly string[] = ["draft", "autosave", "snapshot", "publish", "rollback"];
const control = /[\u0000-\u001f\u007f]/u;
const plain = (value: unknown, max: number, min = 0): value is string => typeof value === "string" && value.length >= min && value.length <= max && !control.test(value);
function closed(input: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).some((key) => !allowed.includes(key))) throw new Error(`${what}の形式が正しくありません。`);
  return input as Record<string, unknown>;
}
/** ホストが返した履歴項目を検証し、既知の項目だけの複製を返す。 */
export function parseRevisionEntry(input: unknown): EditorRevisionEntry {
  const { id, revision, kind, createdAt, actor, label } = closed(input, ["id", "revision", "kind", "createdAt", "actor", "label"], "版履歴の項目");
  if (!plain(id, 200, 1) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || typeof kind !== "string" || !revisionKinds.includes(kind) ||
    !plain(createdAt, 40, 1) || !Number.isFinite(Date.parse(createdAt)) || (actor !== undefined && !plain(actor, 120)) || (label !== undefined && !plain(label, 120))) throw new Error("版履歴の項目が正しくありません。");
  return { id, revision, kind: kind as EditorRevisionKind, createdAt, ...(actor === undefined ? {} : { actor }), ...(label === undefined ? {} : { label }) };
}
export function parseRevisionPage(input: unknown): EditorRevisionPage {
  const { entries, next } = closed(input, ["entries", "next"], "版履歴");
  if (!Array.isArray(entries) || entries.length > 100 || (next !== undefined && !plain(next, 500))) throw new Error("版履歴が正しくありません。");
  return { entries: entries.map(parseRevisionEntry), ...(next === undefined ? {} : { next }) };
}

/** 端末内の退避。入力途中の値・token・ロックは含めない。 */
export type EditorRecoveryEntry = { target: EditorTarget; baseVersion: string; baseRevision: number; document: PageDocument; updatedAt: string };
/** 読み出した退避内容。document はエディターが検証するまで信頼しない。 */
export type StoredRecoveryEntry = Omit<EditorRecoveryEntry, "document"> & { document: unknown };
/** 端末内の共通部品ライブラリの退避（サイト単位）。changed は手元で変えた部品 ID ごとの変更前（保存済み）の version。手元で追加した部品は null。 */
export type EditorLibraryRecoveryEntry = { siteId: string; baseVersion: string; changed: Readonly<Record<string, number | null>>; /** token の変更前。競合時に別の保存を上書きしないため保持する。 */ baseTokens?: Readonly<Record<string, DesignToken>>; library: ComponentLibrary; updatedAt: string };
/** 読み出した部品の退避内容。library はエディターが検証するまで信頼しない。 */
export type StoredLibraryRecoveryEntry = Omit<EditorLibraryRecoveryEntry, "library"> & { library: unknown };
export interface EditorRecoveryStore {
  read(target: EditorTarget): StoredRecoveryEntry | null | Promise<StoredRecoveryEntry | null>;
  write(entry: EditorRecoveryEntry): void | Promise<void>;
  remove(target: EditorTarget): void | Promise<void>;
  /** 共通部品ライブラリの退避（サイト単位）。3つとも実装した場合だけ、エディターは部品の変更を退避する。 */
  readLibrary?(siteId: string): StoredLibraryRecoveryEntry | null | Promise<StoredLibraryRecoveryEntry | null>;
  writeLibrary?(entry: EditorLibraryRecoveryEntry): void | Promise<void>;
  removeLibrary?(siteId: string): void | Promise<void>;
}
export type RecoveryStorage = { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export class RecoveryTooLargeError extends Error {
  constructor() { super("recovery entry is too large"); this.name = "RecoveryTooLargeError"; }
}
const prefixOf = (scope: string) => `niho-web:recovery:v1:${encodeURIComponent(scope)}:`;
const targetKey = (target: EditorTarget) => `${encodeURIComponent(target.siteId)}/${encodeURIComponent(target.pageId)}/${encodeURIComponent(target.locale)}`;
function storedEntry(raw: string | null): (StoredRecoveryEntry & { time: number }) | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, target, baseVersion, baseRevision, document, updatedAt } = value as Record<string, unknown>;
  const place = target && typeof target === "object" ? target as Record<string, unknown> : {};
  const time = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  if (v !== 1 || typeof place.siteId !== "string" || typeof place.pageId !== "string" || typeof place.locale !== "string" || typeof baseVersion !== "string" ||
    typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || !Number.isFinite(time) || document === undefined) return null;
  return { target: { siteId: place.siteId, pageId: place.pageId, locale: place.locale }, baseVersion, baseRevision, document, updatedAt: updatedAt as string, time };
}
// 部品ライブラリの鍵は "/" を1つだけ含む。ページの鍵は "/" を2つ含むため、サイト ID が library のページとも区別できる。
const libraryKey = (siteId: string) => `library/${encodeURIComponent(siteId)}`;
const isLibraryKey = (rest: string) => /^library\/[^/]*$/u.test(rest);
function storedLibraryEntry(raw: string | null): (StoredLibraryRecoveryEntry & { time: number }) | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, siteId, baseVersion, changed, baseTokens, library, updatedAt } = value as Record<string, unknown>;
  const time = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  if (v !== 1 || typeof siteId !== "string" || typeof baseVersion !== "string" || !changed || typeof changed !== "object" || Array.isArray(changed) ||
    baseTokens !== undefined && (!baseTokens || typeof baseTokens !== "object" || Array.isArray(baseTokens)) ||
    !Object.values(changed).every((base) => base === null || typeof base === "number" && Number.isSafeInteger(base) && base > 0) || library === undefined || !Number.isFinite(time)) return null;
  return { siteId, baseVersion, changed: changed as Record<string, number | null>, ...(baseTokens === undefined ? {} : { baseTokens: baseTokens as Record<string, DesignToken> }), library, updatedAt: updatedAt as string, time };
}
/**
 * localStorage 等へ作業コピーを退避する。ページは文書ごと、部品ライブラリはサイトごとに1件。scope はログイン中のスタッフごとの opaque な値にし、
 * ホストはログアウト時に clear() を呼ぶ。他の scope の内容は読まず、消さない。
 */
export function createBrowserRecoveryStore(options: { scope: string; storage?: RecoveryStorage; maxAgeMs?: number; maxBytes?: number; now?: () => number }): EditorRecoveryStore & Required<Pick<EditorRecoveryStore, "readLibrary" | "writeLibrary" | "removeLibrary">> & { clear(): void } {
  const { scope, maxAgeMs = 72 * 60 * 60 * 1000, maxBytes = 2_000_000, now = Date.now } = options;
  if (!plain(scope, 128, 1)) throw new Error("recovery scope must be 1-128 characters without control characters");
  if (![maxAgeMs, maxBytes].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) throw new Error("invalid recovery limits");
  const prefix = prefixOf(scope);
  const storage = (): RecoveryStorage | null => {
    if (options.storage) return options.storage;
    try { return (globalThis as { localStorage?: RecoveryStorage }).localStorage ?? null; } catch { return null; }
  };
  const scopedKeys = (target: RecoveryStorage) => {
    const result: string[] = [];
    for (let index = 0; index < target.length; index++) { const key = target.key(index); if (key?.startsWith(prefix)) result.push(key); }
    return result;
  };
  const expired = (time: number) => now() - time > maxAgeMs;
  try {
    const target = storage();
    if (target) for (const key of scopedKeys(target)) { const raw = target.getItem(key), entry = isLibraryKey(key.slice(prefix.length)) ? storedLibraryEntry(raw) : storedEntry(raw); if (!entry || expired(entry.time)) target.removeItem(key); }
  } catch { /* 退避先が使えない場合は何もしない */ }
  return {
    read(target) {
      let place: RecoveryStorage | null;
      try { place = storage(); } catch { return null; }
      if (!place) return null;
      const key = prefix + targetKey(target);
      try {
        const raw = place.getItem(key);
        if (raw === null) return null;
        const entry = storedEntry(raw);
        if (!entry || entry.target.siteId !== target.siteId || entry.target.pageId !== target.pageId || entry.target.locale !== target.locale || expired(entry.time)) { place.removeItem(key); return null; }
        return { target: entry.target, baseVersion: entry.baseVersion, baseRevision: entry.baseRevision, document: entry.document, updatedAt: entry.updatedAt };
      } catch { return null; }
    },
    write(entry) {
      const place = storage();
      if (!place) throw new Error("recovery storage unavailable");
      const target = { siteId: entry.target.siteId, pageId: entry.target.pageId, locale: entry.target.locale };
      const serialized = JSON.stringify({ v: 1, target, baseVersion: entry.baseVersion, baseRevision: entry.baseRevision, document: entry.document, updatedAt: entry.updatedAt });
      if (serialized.length * 2 > maxBytes) throw new RecoveryTooLargeError();
      place.setItem(prefix + targetKey(target), serialized);
    },
    remove(target) {
      try { storage()?.removeItem(prefix + targetKey(target)); } catch { /* 退避先が使えない */ }
    },
    readLibrary(siteId) {
      let place: RecoveryStorage | null;
      try { place = storage(); } catch { return null; }
      if (!place) return null;
      const key = prefix + libraryKey(siteId);
      try {
        const raw = place.getItem(key);
        if (raw === null) return null;
        const entry = storedLibraryEntry(raw);
        if (!entry || entry.siteId !== siteId || expired(entry.time)) { place.removeItem(key); return null; }
        return { siteId: entry.siteId, baseVersion: entry.baseVersion, changed: entry.changed, ...(entry.baseTokens === undefined ? {} : { baseTokens: entry.baseTokens }), library: entry.library, updatedAt: entry.updatedAt };
      } catch { return null; }
    },
    writeLibrary(entry) {
      const place = storage();
      if (!place) throw new Error("recovery storage unavailable");
      // changed は自身のキーだけの新しい object にし、指定した退避情報だけを書く。
      const changed = Object.fromEntries(Object.entries(entry.changed));
      const serialized = JSON.stringify({ v: 1, siteId: entry.siteId, baseVersion: entry.baseVersion, changed,
        ...(entry.baseTokens === undefined ? {} : { baseTokens: entry.baseTokens }), library: entry.library, updatedAt: entry.updatedAt });
      if (serialized.length * 2 > maxBytes) throw new RecoveryTooLargeError();
      place.setItem(prefix + libraryKey(entry.siteId), serialized);
    },
    removeLibrary(siteId) {
      try { storage()?.removeItem(prefix + libraryKey(siteId)); } catch { /* 退避先が使えない */ }
    },
    clear() {
      try { const place = storage(); if (place) for (const key of scopedKeys(place)) place.removeItem(key); } catch { /* 退避先が使えない */ }
    }
  };
}
