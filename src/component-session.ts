import type { SiteStyles } from "./site-styles.js";
import { expandDocument, instancesOf, ownElements, type ResolvedOrigin } from "./component-expand.js";
import { componentDocument, detachInstance, setComponentProp } from "./component-model.js";
import { componentUsage, parseComponentLibrary, resolvePageDocument } from "./components.js";
import { parsePageDocument } from "./document.js";
import { parseTokens } from "./style-values.js";
import { nodeAt, sameTarget, walkNodes, type EditorHistory, type NodePath } from "./editor-model.js";
import type { ComponentLibrarySnapshot, ComponentUsageEntry, EditorBlockRegistry, EditorPage, EditorReleaseAffected, EditorTarget, PageKind } from "./editor-types.js";
import type { ComponentDefinition, ComponentKind, ComponentLibrary, ComponentPropField, DesignToken, PageDocument, PageNode } from "./types.js";
import { DocumentValidationError, identifier } from "./validation-utils.js";

// エディターの共通部品セッション。履歴はページと同じく最大50操作で、保存済みの基準と内容を比較する。
export type LibraryHistory = { past: ComponentLibrary[]; present: ComponentLibrary; future: ComponentLibrary[] };
export type LibrarySession = { siteId: string; history: LibraryHistory; version: string; saved: string; savedLibrary: ComponentLibrary };
export const libraryFingerprint = (library: ComponentLibrary): string => JSON.stringify(library);
export function librarySessionFrom(snapshot: ComponentLibrarySnapshot, siteId: string, blocks: EditorBlockRegistry): LibrarySession {
  const library = parseComponentLibrary(snapshot.library, blocks);
  if (library.siteId !== siteId || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("部品ライブラリの対象が一致しません。");
  return { siteId, history: { past: [], present: library, future: [] }, version: snapshot.version, saved: libraryFingerprint(library), savedLibrary: library };
}
export function commitLibrary(history: LibraryHistory, library: ComponentLibrary): LibraryHistory {
  if (libraryFingerprint(library) === libraryFingerprint(history.present)) return history;
  return { past: [...history.past.slice(-49), history.present], present: library, future: [] };
}
export function travelLibrary(history: LibraryHistory, direction: "undo" | "redo"): LibraryHistory {
  const target = direction === "undo" ? history.past.at(-1) : history.future[0];
  if (!target) return history;
  return direction === "undo" ? { past: history.past.slice(0, -1), present: target, future: [history.present, ...history.future] }
    : { past: [...history.past, history.present], present: target, future: history.future.slice(1) };
}
/**
 * 送信したライブラリ（version 更新済み）を、保存先が採番した revision で新しい基準にする。
 * base は送信時の作業コピー。保存中に作業コピーが変わっていれば、内容を保ったまま revision だけ揃える。
 */
export function acceptSavedLibrary(session: LibrarySession, base: ComponentLibrary, submitted: ComponentLibrary, result: { version: string; revision: number }): LibrarySession {
  if (!Number.isSafeInteger(result.revision) || result.revision <= submitted.revision) throw new Error("保存後の revision が一致しません。編集内容は保持されています。");
  const rebase = (library: ComponentLibrary): ComponentLibrary => ({ ...library, revision: result.revision }), saved = rebase(submitted);
  const present = libraryFingerprint(session.history.present) === libraryFingerprint(base) ? saved : rebase(session.history.present);
  return { ...session, version: result.version, saved: libraryFingerprint(saved), savedLibrary: saved,
    history: { past: session.history.past.map(rebase), present, future: session.history.future.map(rebase) } };
}
/** 文書がライブラリで展開・検証できるか。 */
export function fitsLibrary(document: PageDocument, library: ComponentLibrary, blocks: EditorBlockRegistry, siteStyles?: SiteStyles): boolean {
  try { parsePageDocument(document, blocks, { components: library, ...(siteStyles ? { siteStyles } : {}) }); return true; } catch { return false; }
}
/** 部品の検証で返る理由のうち、スタッフ向けの文言があるもの。 */
export function componentProblem(error: unknown): string | undefined {
  if (!(error instanceof DocumentValidationError)) return undefined;
  if (error.reason === "circular component reference") return "部品の中に同じ部品を置くことはできません。";
  if (error.reason === "component nesting too deep") return "部品の入れ子は4段までです。";
  return undefined;
}

/** 部品ごとの変更。base は変更前（保存済み）の version、手元で追加した部品は null。 */
export type LibraryChange = { id: string; name: string; change: "added" | "changed" | "removed"; base: number | null };
export const changeLabels: Readonly<Record<LibraryChange["change"], string>> = { added: "追加", changed: "変更", removed: "削除" };
// 内容は bumpChangedComponentVersions と同じく version を除いて比べる（version は保存時に採番するため）。
const contentOf = (component: ComponentDefinition) => JSON.stringify({ ...component, version: 0 });
const byId = (library: ComponentLibrary) => new Map(library.components.map((component) => [component.id, component] as const));
/** 保存済み（before）から作業コピー（after）への部品ごとの変更。after の順に追加・変更、続いて after に無い部品の削除。 */
export function libraryChanges(before: ComponentLibrary, after: ComponentLibrary): LibraryChange[] {
  const previous = byId(before), next = byId(after), changes: LibraryChange[] = [];
  for (const component of after.components) {
    const base = previous.get(component.id);
    if (!base) changes.push({ id: component.id, name: component.name, change: "added", base: null });
    else if (contentOf(component) !== contentOf(base)) changes.push({ id: component.id, name: component.name, change: "changed", base: base.version });
  }
  for (const component of before.components) if (!next.has(component.id)) changes.push({ id: component.id, name: component.name, change: "removed", base: component.version });
  return changes;
}
export type LibraryReloadPlan = {
  /** 破棄する手元の部品の変更。 */
  discarded: LibraryChange[];
  /** 破棄する手元のスタイル定義。 */
  discardedTokens: string[];
  /** 部品を解除して通常の要素にする、編集中のページの部品の名前（手元の名前・出現順・重複なし）。 */
  detached: string[];
  /** 解除を適用したページの文書。解除が無ければ undefined。 */
  page?: PageDocument;
  /** 読み直せない理由。あれば何も適用しない。 */
  problem?: string;
};
/**
 * 最新の部品ライブラリ（latest）へ読み直す計画。手元の部品の変更は破棄する。編集中のページのインスタンスのうち、最新では同じ部品として
 * 表示できないものは手元の定義で解除し、文字と見た目を残す。まず最新に無い部品と、手元で追加した ID が最新では別の部品になっているものだけを
 * 解除し、それでも最新で展開できなければ、手元で変えた部品のうち最新と内容が違うものも解除する。
 */
export function planLibraryReload(input: { local: ComponentLibrary; saved: ComponentLibrary; latest: ComponentLibrary; page: PageDocument | undefined; editable: boolean; blocks: EditorBlockRegistry }): LibraryReloadPlan {
  const { local, saved, latest, page, editable, blocks } = input, discarded = libraryChanges(saved, local);
  const discardedTokens = [...new Set([...Object.keys(saved.tokens), ...Object.keys(local.tokens)])]
    .filter((name) => JSON.stringify(saved.tokens[name]) !== JSON.stringify(local.tokens[name]));
  if (!page) return { discarded, discardedTokens, detached: [] };
  const own = byId(local), other = byId(latest), base = byId(saved), changed = new Set(discarded.map((change) => change.id));
  const differs = (id: string) => { const mine = own.get(id), theirs = other.get(id); return !mine || !theirs || contentOf(mine) !== contentOf(theirs); };
  const phase1 = (id: string) => !other.has(id) || !base.has(id) && differs(id), phase2 = (id: string) => phase1(id) || changed.has(id) && differs(id);
  const nameOf = (id: string) => own.get(id)?.name ?? other.get(id)?.name ?? "共通部品";
  // 解除で現れた入れ子のインスタンスも次の走査で拾う。200 回解除しても残る、または解除できなければ失敗。
  const detachWhere = (pick: (id: string) => boolean): { document: PageDocument; names: string[] } | null => {
    const next = (document: PageDocument) => walkNodes(document).find(({ node }) => node.type === "instance" && pick(node.component));
    let document = page; const names: string[] = [];
    try {
      for (let count = 0; count < 200; count++) {
        const found = next(document);
        if (!found || found.node.type !== "instance") return { document, names };
        const name = nameOf(found.node.component); if (!names.includes(name)) names.push(name);
        document = detachInstance(document, found.path, local, blocks);
      }
      return next(document) ? null : { document, names };
    } catch { return null; }
  };
  let chosen = detachWhere(phase1);
  if (!chosen || !fitsLibrary(chosen.document, latest, blocks)) { chosen = detachWhere(phase2); if (chosen && !fitsLibrary(chosen.document, latest, blocks)) chosen = null; }
  if (chosen && !chosen.names.length) return { discarded, discardedTokens, detached: [] };
  if (!editable) return { discarded, discardedTokens, detached: [], problem: "このページは読み取り専用のため、最新の共通部品に合わせて部品を解除できません。別のページを開いてから、もう一度読み直してください。" };
  if (chosen) return { discarded, discardedTokens, detached: chosen.names, page: chosen.document };
  const suspects = [...new Set(walkNodes(page).flatMap(({ node }) => node.type === "instance" && differs(node.component) ? [nameOf(node.component)] : []))];
  return { discarded, discardedTokens, detached: [], problem: `最新の共通部品では、編集中のページを表示できないため読み直せません。${suspects.length ? `ページの「${suspects.join("」「")}」を` : "ページの共通部品を"}「部品を解除」で通常の要素にするか削除してから、もう一度読み直してください。` };
}
/**
 * 部品を読み直した後のページの履歴。最新に無い部品と、手元で追加した ID が最新では別の部品になっている部品を参照する版へは
 * 元に戻す・やり直すで移らない（移ると別の人の部品が黙って表示されるため）。その版より遠い履歴も捨てる。変わらなければ同じ履歴を返す。
 */
export function trimReloadedHistory(history: EditorHistory, input: { local: ComponentLibrary; saved: ComponentLibrary; latest: ComponentLibrary }): EditorHistory {
  const own = byId(input.local), other = byId(input.latest), base = byId(input.saved);
  const stale = (id: string) => { const mine = own.get(id), theirs = other.get(id); return !theirs || !base.has(id) && (!mine || contentOf(mine) !== contentOf(theirs)); };
  const unsafe = (document: PageDocument) => walkNodes(document).some(({ node }) => node.type === "instance" && stale(node.component));
  let cut = -1; history.past.forEach((document, index) => { if (unsafe(document)) cut = index; });
  const end = history.future.findIndex(unsafe);
  return cut < 0 && end < 0 ? history : { past: history.past.slice(cut + 1), present: history.present, future: end < 0 ? history.future : history.future.slice(0, end) };
}

export type RecoveredLibrary = { siteId: string; baseVersion: string; changed: Readonly<Record<string, number | null>>; baseTokens?: Readonly<Record<string, DesignToken>>; library: ComponentLibrary; updatedAt: string };
/** 端末から読んだ部品の退避内容を検証する。対象のサイトと違う・形が合わないものは null（別サイトへは復元しない）。 */
export function parseRecoveredLibrary(stored: unknown, siteId: string, blocks: EditorBlockRegistry): RecoveredLibrary | null {
  if (!stored || typeof stored !== "object") return null;
  const { siteId: place, baseVersion, changed, baseTokens, library, updatedAt } = stored as Record<string, unknown>;
  if (place !== siteId || typeof baseVersion !== "string" || !baseVersion || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) || !changed || typeof changed !== "object" || Array.isArray(changed)) return null;
  const entries = Object.entries(changed);
  if (!entries.every(([, base]) => base === null || typeof base === "number" && Number.isSafeInteger(base) && base > 0)) return null;
  try {
    for (const [id] of entries) identifier(id, "$.changed");
    const parsed = parseComponentLibrary(library, blocks);
    const previousTokens = baseTokens === undefined ? undefined : parseTokens(baseTokens, "$.baseTokens");
    return parsed.siteId === siteId ? { siteId, baseVersion, changed: Object.fromEntries(entries) as Record<string, number | null>,
      ...(previousTokens === undefined ? {} : { baseTokens: previousTokens }), library: parsed, updatedAt } : null;
  } catch { return null; }
}
export type LibraryMerge = { library: ComponentLibrary | null; restored: LibraryChange[]; restoredTokens: string[]; conflicts: string[]; tokenConflicts: string[] };
/**
 * 退避内容のうち、保存先（latest）でその後に変わっていない部品だけを latest に重ねる。
 * 変更前の version と latest の version が違う部品（追加した ID が latest で別の部品になっている場合を含む）は latest を残し、conflicts に名前を返す。
 * 重ねた結果を検証できなければ library は null。
 */
export function mergeRecoveredLibrary(recovered: RecoveredLibrary, latest: ComponentLibrary, blocks: EditorBlockRegistry): LibraryMerge {
  const own = byId(recovered.library), other = byId(latest), adopted = new Map<string, ComponentDefinition | null>(), restored: LibraryChange[] = [], restoredTokens: string[] = [], conflicts: string[] = [], tokenConflicts: string[] = [];
  for (const [id, base] of Object.entries(recovered.changed)) {
    const mine = own.get(id), theirs = other.get(id), named = mine ?? theirs;
    // どちらにも無い、または同じ内容なら重ねる必要が無い。
    if (!named || mine && theirs && contentOf(mine) === contentOf(theirs)) continue;
    const moved = base === null ? theirs !== undefined : theirs === undefined || theirs.version !== base;
    if (moved) { conflicts.push(named.name); continue; }
    adopted.set(id, mine ? { ...structuredClone(mine), version: theirs?.version ?? mine.version } : null);
    restored.push({ id, name: named.name, change: !theirs ? "added" : !mine ? "removed" : "changed", base });
  }
  const components = latest.components.flatMap((component) => { const next = adopted.get(component.id); return next === undefined ? [component] : next ? [next] : []; });
  for (const [id, next] of adopted) if (next && !other.has(id)) components.push(next);
  const tokens = { ...latest.tokens };
  const sameToken = (left: DesignToken | undefined, right: DesignToken | undefined) => JSON.stringify(left) === JSON.stringify(right);
  if (recovered.baseTokens) {
    for (const name of new Set([...Object.keys(recovered.baseTokens), ...Object.keys(recovered.library.tokens)])) {
      const before = recovered.baseTokens[name], mine = recovered.library.tokens[name], theirs = latest.tokens[name];
      if (sameToken(before, mine) || sameToken(theirs, mine)) continue;
      if (!sameToken(theirs, before)) { tokenConflicts.push(name); continue; }
      if (mine === undefined) delete tokens[name]; else tokens[name] = structuredClone(mine);
      restoredTokens.push(name);
    }
  } else if (restored.length) {
    // 旧形式の退避では変更前を判定できないため、既存 token は上書きしない。
    for (const [name, token] of Object.entries(recovered.library.tokens)) if (!Object.hasOwn(tokens, name)) tokens[name] = token;
  }
  let library: ComponentLibrary | null = null;
  try { library = parseComponentLibrary({ ...latest, tokens, components }, blocks); } catch { /* 重ねた結果が検証できない */ }
  return { library, restored, restoredTokens, conflicts, tokenConflicts };
}
/** 提案する価値があるか。重ねられない・競合だけ・内容が変わる、のいずれか。 */
export function hasRecoveredChanges(merge: LibraryMerge, latest: ComponentLibrary): boolean {
  return !merge.library || merge.conflicts.length > 0 || merge.tokenConflicts.length > 0 || libraryFingerprint(merge.library) !== libraryFingerprint(latest);
}

const noOrigins: ReadonlyMap<string, ResolvedOrigin> = new Map();
/** キャンバスに描く文書。インスタンスがなければそのまま使い、展開できなければ元の文書（描画側で表示不可になる）を返す。 */
export function resolveCanvas(document: PageDocument, library: ComponentLibrary | undefined, blocks: EditorBlockRegistry, siteStyles?: SiteStyles): { document: PageDocument; origins: ReadonlyMap<string, ResolvedOrigin> } {
  if (!library || !instancesOf(document.body).length) return { document, origins: noOrigins };
  try { return resolvePageDocument(document, library, blocks, siteStyles); } catch { return { document, origins: noOrigins }; }
}
/** path の要素と子孫のうち、文書の文字スタイルを参照するノードの path。部品は文書の文字スタイルを持てない。 */
export function textStylePaths(document: PageDocument, path: NodePath): NodePath[] {
  return walkNodes({ ...document, body: [nodeAt(document, path)] }).flatMap(({ node, path: inner }) => node.type !== "text" && node.style?.textStyle ? [[...path, ...inner.slice(1)]] : []);
}
/** 一覧の縮小表示に描く、展開済みの部品。ライブラリは検証済みのため、部品の数だけ再検証しない。 */
export function componentPreview(library: ComponentLibrary, componentId: string, blocks: EditorBlockRegistry): PageDocument {
  return parsePageDocument(expandDocument(componentDocument(library, componentId, "ja"), library).document, blocks);
}

export const componentKinds: readonly (readonly [ComponentKind, string])[] = [["header", "ヘッダー"], ["navigation", "ナビゲーション"], ["section", "セクション"], ["part", "パーツ"], ["footer", "フッター"]];
export const kindLabel = (kind: ComponentKind): string => componentKinds.find(([value]) => value === kind)?.[1] ?? "部品";
export const fieldCaptions: Readonly<Record<ComponentPropField, string>> = { text: "文字", href: "リンク先", src: "画像", alt: "画像の説明" };
export const roleLabels: Readonly<Record<PageKind, string>> = { page: "ページ", template: "テンプレート", shared: "共通枠" };
/** 種類の順（ヘッダー・ナビゲーション・セクション・パーツ・フッター）、同じ種類は名前順。名前の部分一致で絞り込む。 */
export function sortedComponents(library: ComponentLibrary, query: string): ComponentDefinition[] {
  const order = new Map(componentKinds.map(([kind], index) => [kind, index] as const)), needle = query.trim().toLowerCase();
  return library.components.filter((component) => component.name.toLowerCase().includes(needle))
    .sort((a, b) => (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.name.localeCompare(b.name, "ja"));
}
/** 部品が入れ子の部品経由で含む業務ブロックと部品（自身は含まない）。 */
export function componentDependencies(library: ComponentLibrary, componentId: string): { blocks: Set<string>; components: Set<string> } {
  const definitions = new Map(library.components.map((component) => [component.id, component] as const)), result = { blocks: new Set<string>(), components: new Set<string>() };
  const visit = (node: PageNode): void => {
    if (node.type === "component") result.blocks.add(node.block);
    else if (node.type === "element") node.children.forEach(visit);
    else if (node.type === "instance" && !result.components.has(node.component)) {
      result.components.add(node.component);
      const definition = definitions.get(node.component); if (definition) visit(definition.root);
    }
  };
  const root = definitions.get(componentId)?.root; if (root) visit(root);
  return result;
}
/** 配置できない理由。編集中の部品の中への循環と、追加を許可していない業務ブロック。 */
export function placementProblem(library: ComponentLibrary, componentId: string, insertableBlocks: readonly string[] | undefined, editing: string | null): string | undefined {
  const dependencies = componentDependencies(library, componentId);
  if (editing && (componentId === editing || dependencies.components.has(editing))) return "編集中の部品の中には配置できません";
  if (insertableBlocks && [...dependencies.blocks].some((block) => !insertableBlocks.includes(block))) return "追加が許可されていない業務ブロックを含むため配置できません";
  return undefined;
}

export type UsageRow = { title: string; role: PageKind; current: boolean };
/** rows は部品を使う文書。savedHere は編集中の文書の保存済み下書きが使っているか。 */
export type ComponentUsageSummary = { rows: UsageRow[]; savedHere: boolean };
export type CurrentUsage = { target: EditorTarget; title: string; counts: Readonly<Record<string, number>> };
const roles: readonly unknown[] = ["page", "template", "shared", undefined];
/** ホストの使用状況を確かめた複製。形が合わなければ null（不明）。 */
export function parseUsage(entries: unknown, siteId: string): ComponentUsageEntry[] | null {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const valid = Array.isArray(entries) && entries.every((entry) => object(entry) && object(entry.target) && entry.target.siteId === siteId &&
    typeof entry.target.pageId === "string" && typeof entry.target.locale === "string" && typeof entry.title === "string" && roles.includes(entry.role) &&
    object(entry.components) && Object.values(entry.components).every((count) => typeof count === "number" && Number.isFinite(count) && count >= 0));
  return valid ? structuredClone(entries) as ComponentUsageEntry[] : null;
}
/**
 * 保存済みの下書きの使用状況のうち、編集中の文書だけを手元の集計に置き換える。entries が無ければ不明。
 * role の無い項目は、ページ一覧の同じ文書の kind（無ければ page）として扱う。
 */
export function summarizeUsage(entries: readonly ComponentUsageEntry[] | null | undefined, current: CurrentUsage | undefined, library: ComponentLibrary, pages: readonly EditorPage[] = []): ReadonlyMap<string, ComponentUsageSummary> | undefined {
  if (!entries) return undefined;
  const role = (entry: ComponentUsageEntry): PageKind => entry.role ?? pages.find((page) => sameTarget(page, entry.target))?.kind ?? "page";
  const here = (entry: ComponentUsageEntry) => !!current && sameTarget(entry.target, current.target), saved = entries.filter(here);
  const rows = [...entries.filter((entry) => !here(entry)).map((entry) => ({ entry, current: false })),
    ...(current ? [{ entry: { target: current.target, title: saved[0]?.title ?? current.title, ...(saved[0]?.role ? { role: saved[0].role } : {}), components: current.counts }, current: true }] : [])];
  return new Map(library.components.map((component) => [component.id, {
    rows: rows.filter(({ entry }) => (entry.components[component.id] ?? 0) > 0).map(({ entry, current }) => ({ title: entry.title, role: role(entry), current })),
    savedHere: saved.some((entry) => (entry.components[component.id] ?? 0) > 0)
  }] as const));
}
export function usageText(summary: ComponentUsageSummary | undefined, loading: boolean): string {
  if (!summary) return loading ? "使用状況を確認中" : "使用状況を取得できません";
  return summary.rows.length ? `${summary.rows.length}文書で使用${summary.rows.some((row) => row.role === "shared") ? "・共通枠" : ""}` : "未使用";
}
/** 公開確認の「影響する共通部品」。ホストが返した影響範囲に、このページが使う部品（入れ子を含む）を同じ名前が無ければ加える。 */
export function releaseAffected(hosted: readonly EditorReleaseAffected[] | undefined, document: PageDocument | undefined, library: ComponentLibrary | undefined): readonly EditorReleaseAffected[] | undefined {
  const counts = document && library ? componentUsage(document, library) : {};
  const own = (library?.components ?? []).filter((component) => (counts[component.id] ?? 0) > 0)
    .map((component): EditorReleaseAffected => ({ kind: "shared", name: component.name, detail: `このページで${counts[component.id]}か所に配置` }));
  const merged = [...(hosted ?? []), ...own.filter((item) => !hosted?.some((entry) => entry.kind === item.kind && entry.name === item.name))];
  return merged.length ? merged : hosted;
}
/** 削除できない理由。他の部品・文書が使っている間と、使用状況が分からない間は削除させない。 */
export function removalProblem(library: ComponentLibrary, componentId: string, summary: ComponentUsageSummary | undefined): string | undefined {
  if (library.components.some((component) => component.id !== componentId && instancesOf([component.root]).some((instance) => instance.component === componentId))) return "使用中のため削除できません";
  if (!summary) return "使用状況を確認できないため削除できません";
  if (summary.rows.length) return "使用中のため削除できません";
  // 部品はページより先に保存するため、保存済みの下書きが参照している間は削除を保存できない。
  if (summary.savedHere) return "保存済みの下書きで使用中のため削除できません。先に下書きを保存してください。";
  return undefined;
}

/** 公開 props の部品側の値（対象ノードの文字または属性）。 */
export function masterValue(definition: ComponentDefinition, name: string): string {
  const prop = Object.hasOwn(definition.props ?? {}, name) ? definition.props![name] : undefined, target = prop && ownElements(definition.root).get(prop.node);
  if (!prop || !target) return "";
  if (prop.field === "text") return target.children[0]?.type === "text" ? target.children[0].text : "";
  return String(target.attrs?.[prop.field] ?? "");
}
/** 部品の element の field を公開する・やめる。名前は <ノードID>_<field>、表示名は field の名前（重複時は末尾に 2, 3…）。 */
export function exposeComponentProp(library: ComponentLibrary, componentId: string, nodeId: string, field: ComponentPropField, exposed: boolean, blocks: EditorBlockRegistry): ComponentLibrary {
  const definition = library.components.find((component) => component.id === componentId);
  if (!definition) throw new Error("部品が見つかりません。");
  const props = definition.props ?? {}, existing = Object.entries(props).find(([, prop]) => prop.node === nodeId && prop.field === field)?.[0];
  if (!exposed) return existing ? setComponentProp(library, componentId, existing, undefined, blocks) : library;
  if (existing) return library;
  const labels = new Set(Object.values(props).map((prop) => prop.label)), caption = fieldCaptions[field];
  let label = caption, index = 1, name = `${nodeId}_${field}`;
  while (labels.has(label)) label = `${caption} ${++index}`;
  if (name.length > 80 || Object.hasOwn(props, name)) { index = 1; while (Object.hasOwn(props, `prop_${index}`)) index++; name = `prop_${index}`; }
  return setComponentProp(library, componentId, name, { label, node: nodeId, field }, blocks);
}
export function relabelComponentProp(library: ComponentLibrary, componentId: string, name: string, label: string, blocks: EditorBlockRegistry): ComponentLibrary {
  const prop = library.components.find((component) => component.id === componentId)?.props?.[name];
  if (!prop) throw new Error("ページごとの値が見つかりません。");
  if (!label.trim()) throw new Error("値の名前を入力してください。");
  if (label.trim().length > 40) throw new Error("値の名前は40文字以内で入力してください。");
  return setComponentProp(library, componentId, name, { ...prop, label: label.trim() }, blocks);
}
