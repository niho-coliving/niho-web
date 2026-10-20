import { detachInstance } from "./component-model.js";
import { parsePageDocument } from "./document.js";
import type { EditorBlockRegistry, EditorLock, EditorPage, EditorPageChange, EditorPageChangePlan, EditorPageImpact, EditorReleasePlan, EditorReleaseRequest, EditorSite, EditorTarget } from "./editor-types.js";
import { findPathConflict, validatePagePath } from "./pages.js";
import { copyId, nodeAt, siblingsAt, walkNodes, type NodePath } from "./node-tree.js";
import type { AssetReference, ComponentLibrary, ComponentNode, ElementNode, InstanceNode, PageDocument, PageMeta, PageNode, PublicPropValue, StyleDeclarations, StyleProperty, StyleValue } from "./types.js";
import { isSafeHttpsOrigin } from "./validation-utils.js";

export { nodeAt, walkNodes, type NodePath };
export type EditorOperation =
  | { type: "text"; path: NodePath; value: string }
  | { type: "attribute"; path: NodePath; name: string; value: string }
  | { type: "tag"; path: NodePath; value: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }
  | { type: "prop"; path: NodePath; name: string; value: PublicPropValue | undefined }
  | { type: "style"; path: NodePath; breakpoint: number | "base"; property: StyleProperty; value: StyleValue | undefined }
  | { type: "resize"; path: NodePath; breakpoint: number | "base"; width: number; height: number }
  | { type: "title"; value: string }
  | { type: "add"; parentId: string | null; node: PageNode; index?: number }
  | { type: "replaceChildren"; path: NodePath; children: PageNode[] }
  | { type: "image"; path: NodePath; source: { asset: AssetReference } | { src: string }; alt?: string }
  | { type: "background"; path: NodePath; breakpoint: number | "base"; asset: AssetReference | undefined }
  | { type: "replaceAsset"; from: AssetReference; to: AssetReference }
  | { type: "duplicate" | "remove"; path: NodePath }
  | { type: "move"; path: NodePath; parentId: string | null; index: number }
  /** インスタンスのページごとの値。undefined で解除する。 */
  | { type: "instanceProp"; path: NodePath; name: string; value: string | undefined }
  /** インスタンスを展開した element に置き換え、以後は部品の更新を受けない。 */
  | { type: "detach"; path: NodePath }
  /** 業務ブロックの表示領域の見た目。registry が許可したプロパティだけを通す。 */
  | { type: "slotStyle"; path: NodePath; slot: string; breakpoint: number | "base"; property: StyleProperty; value: StyleValue | undefined }
  | MetaOperation;
/** undefined・空文字・false・空配列はその項目を削除する。 */
export type MetaOperation = { [K in keyof PageMeta]-?: { type: "meta"; field: K; value: PageMeta[K] | undefined } }[keyof PageMeta];
export type EditorHistory = { past: PageDocument[]; present: PageDocument; future: PageDocument[] };
export const fingerprint = (document: PageDocument): string => JSON.stringify(document);
export function effectiveLocks(document: PageDocument, locks: readonly EditorLock[], blocks: EditorBlockRegistry): EditorLock[] {
  return [...locks, ...walkNodes(document).flatMap(({ node }) => node.type === "component"
    ? Object.entries(blocks[node.block]?.lockedProps ?? {}).map(([name, reason]) => ({ nodeId: node.id, fields: [`props.${name}`], reason })) : [])];
}
function fieldValue(node: PageNode, field: string): unknown {
  if (field === "*") return node;
  let value: unknown = node;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function assertLocks(before: PageDocument, after: PageDocument, locks: readonly EditorLock[]): void {
  const index = (document: PageDocument) => new Map(walkNodes(document).flatMap(({ node }) => node.type === "text" ? [] : [[node.id, node] as const]));
  const previous = index(before), next = index(after);
  for (const lock of locks) {
    const oldNode = previous.get(lock.nodeId), newNode = next.get(lock.nodeId);
    if (!oldNode) continue;
    if (!newNode || lock.fields.some((field) => JSON.stringify(fieldValue(oldNode, field)) !== JSON.stringify(fieldValue(newNode, field)))) throw new Error(`データ連動値は変更できません。${lock.reason}`);
  }
}
export function lockReason(document: PageDocument, path: NodePath, field: string, locks: readonly EditorLock[]): string | undefined {
  for (let depth = 1; depth <= path.length; depth++) {
    const node = nodeAt(document, path.slice(0, depth));
    if (node.type === "text") continue;
    const inherited = depth < path.length;
    const lock = locks.find((lock) => lock.nodeId === node.id && lock.fields.some((locked) => locked === "*" ||
      (inherited ? locked === "children" : field === locked || field.startsWith(`${locked}.`))));
    if (lock) return lock.reason;
  }
  return undefined;
}
/** components はインスタンスを含む文書の検証に使う、同じサイトの検証済みライブラリ。 */
export function editDocument(document: PageDocument, operation: EditorOperation, blocks: EditorBlockRegistry = {}, locks: readonly EditorLock[] = [], components?: ComponentLibrary): PageDocument {
  const draft = structuredClone(document), allLocks = effectiveLocks(document, locks, blocks);
  const parentChildren = (path: NodePath): PageNode[] => siblingsAt(draft, path);
  const targetChildren = (id: string | null): PageNode[] => {
    if (id === null) return draft.body;
    const found = walkNodes(draft).find(({ node }) => node.type !== "text" && node.id === id)?.node;
    if (!found || found.type !== "element") throw new Error("追加・移動先が見つかりません。");
    return found.children;
  };
  const declarationsAt = (node: ElementNode | ComponentNode | InstanceNode, breakpoint: number | "base"): StyleDeclarations => {
    node.style ??= {};
    if (breakpoint === "base") return node.style.base ??= {};
    node.style.responsive ??= [];
    let entry = node.style.responsive.find((entry) => entry.minWidth === breakpoint);
    if (!entry) { entry = { minWidth: breakpoint, declarations: {} }; node.style.responsive.push(entry); }
    node.style.responsive.sort((a, b) => a.minWidth - b.minWidth);
    return entry.declarations;
  };
  const pruneResponsive = (node: ElementNode | ComponentNode | InstanceNode) => { if (node.style?.responsive) node.style.responsive = node.style.responsive.filter((entry) => Object.keys(entry.declarations).length); };
  if (operation.type === "title") draft.title = operation.value;
  else if (operation.type === "meta") {
    const meta: Record<string, unknown> = { ...draft.meta }, value = operation.value;
    if (value === undefined || value === "" || value === false || Array.isArray(value) && !value.length) delete meta[operation.field];
    else meta[operation.field] = structuredClone(value);
    if (Object.keys(meta).length) draft.meta = meta as PageMeta; else delete draft.meta;
  }
  else if (operation.type === "add") {
    const destination = targetChildren(operation.parentId), index = operation.index ?? destination.length;
    if (!Number.isInteger(index) || index < 0 || index > destination.length) throw new Error("追加先の位置が不正です。");
    destination.splice(index, 0, structuredClone(operation.node));
  } else if (operation.type === "replaceAsset") {
    const { from, to } = operation, same = (reference: AssetReference) => reference.provider === from.provider && reference.id === from.id;
    let count = 0;
    for (const { node } of walkNodes(draft)) {
      if (node.type === "text") continue;
      if (node.type === "element" && node.asset && same(node.asset)) { node.asset = structuredClone(to); count++; }
      for (const declarations of [node.style?.base, ...(node.style?.responsive ?? []).map((entry) => entry.declarations)]) {
        if (declarations?.backgroundImage && same(declarations.backgroundImage.asset)) { declarations.backgroundImage = { asset: structuredClone(to) }; count++; }
      }
    }
    if (!count) throw new Error("置き換える素材がこのページにありません。");
  } else {
    const node = nodeAt(draft, operation.path);
    if (operation.type === "text") {
      if (node.type !== "text") throw new Error("テキストを選択してください。");
      node.text = operation.value;
    } else if (operation.type === "replaceChildren") {
      if (node.type !== "element") throw new Error("文字を編集できる要素を選択してください。");
      node.children = structuredClone(operation.children);
    } else if (operation.type === "tag") {
      if (node.type !== "element" || !["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(node.tag)) throw new Error("見出し・段落を選択してください。");
      node.tag = operation.value;
    } else if (operation.type === "attribute") {
      if (node.type !== "element") throw new Error("要素を選択してください。");
      node.attrs ??= {};
      if (operation.value === "" && !(node.tag === "img" && operation.name === "alt")) delete node.attrs[operation.name];
      else node.attrs[operation.name] = operation.value;
    } else if (operation.type === "prop") {
      if (node.type !== "component") throw new Error("ブロックを選択してください。");
      if (operation.value === undefined) delete node.props[operation.name]; else node.props[operation.name] = operation.value;
    } else if (operation.type === "instanceProp") {
      if (node.type !== "instance") throw new Error("部品のインスタンスを選択してください。");
      const props = { ...node.props };
      if (operation.value === undefined) delete props[operation.name]; else props[operation.name] = operation.value;
      if (Object.keys(props).length) node.props = props; else delete node.props;
    } else if (operation.type === "detach") {
      if (!components) throw new Error("部品ライブラリを読み込めていません。");
      draft.body = detachInstance(draft, operation.path, components, blocks).body;
    } else if (operation.type === "slotStyle") {
      if (node.type !== "component") throw new Error("ブロックを選択してください。");
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(operation.slot)) throw new Error("表示領域が見つかりません。");
      // 空になった指定は残さない。許可されたプロパティかどうかは最後の文書検証で確かめる。
      const slots = structuredClone(node.slots ?? {}), current = slots[operation.slot] ?? {}, base = { ...current.base };
      const widths = (current.responsive ?? []).map((entry) => ({ minWidth: entry.minWidth, declarations: { ...entry.declarations } }));
      let declarations = base;
      if (operation.breakpoint !== "base") {
        let entry = widths.find((entry) => entry.minWidth === operation.breakpoint);
        if (!entry) { entry = { minWidth: operation.breakpoint, declarations: {} }; widths.push(entry); widths.sort((a, b) => a.minWidth - b.minWidth); }
        declarations = entry.declarations;
      }
      if (operation.value === undefined) delete declarations[operation.property]; else declarations[operation.property] = operation.value;
      const responsive = widths.filter((entry) => Object.keys(entry.declarations).length);
      const next = { ...(Object.keys(base).length ? { base } : {}), ...(responsive.length ? { responsive } : {}) };
      if (Object.keys(next).length) slots[operation.slot] = next; else delete slots[operation.slot];
      if (Object.keys(slots).length) node.slots = slots; else delete node.slots;
    } else if (operation.type === "style" || operation.type === "resize") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      const declarations = declarationsAt(node, operation.breakpoint);
      if (operation.type === "resize") {
        if (![operation.width, operation.height].every((value) => Number.isFinite(value) && value >= 1 && value <= 10000)) throw new Error("幅と高さは1〜10000pxで指定してください。");
        declarations.width = Math.round(operation.width); declarations.height = Math.round(operation.height);
      } else if (operation.value === undefined) delete declarations[operation.property]; else declarations[operation.property] = operation.value;
      pruneResponsive(node);
    } else if (operation.type === "image") {
      if (node.type !== "element" || node.tag !== "img") throw new Error("画像を選択してください。");
      node.attrs ??= {};
      if ("asset" in operation.source) { node.asset = structuredClone(operation.source.asset); delete node.attrs.src; }
      else { node.attrs.src = operation.source.src; delete node.asset; }
      if (operation.alt !== undefined) node.attrs.alt = operation.alt;
    } else if (operation.type === "background") {
      if (node.type === "text") throw new Error("親要素の見た目を編集してください。");
      const declarations = declarationsAt(node, operation.breakpoint);
      if (operation.asset === undefined) delete declarations.backgroundImage; else declarations.backgroundImage = { asset: structuredClone(operation.asset) };
      pruneResponsive(node);
    } else if (operation.type === "remove") parentChildren(operation.path).splice(operation.path.at(-1)!, 1);
    else if (operation.type === "duplicate") {
      const subtree = node.type === "text" ? [] : walkNodes({ ...draft, body: [node] });
      if (subtree.some(({ node }) => node.type !== "text" && allLocks.some((lock) => lock.nodeId === node.id))) throw new Error("データ連動値を含む要素は複製できません。");
      const copy = structuredClone(node), used = new Set(walkNodes(draft).flatMap(({ node }) => node.type === "text" ? [] : [node.id]));
      const usedHtmlIds = new Set(walkNodes(draft).flatMap(({ node }) => node.type === "element" && typeof node.attrs?.id === "string" ? [node.attrs.id] : []));
      const remap = new Map<string, string>();
      function rename(current: PageNode): void {
        if (current.type === "text") return;
        current.id = copyId(current.id, used);
        if (current.type === "element") {
          if (typeof current.attrs?.id === "string") { const previous = current.attrs.id; current.attrs.id = copyId(previous, usedHtmlIds); remap.set(previous, current.attrs.id); }
          current.children.forEach(rename);
        }
      }
      rename(copy);
      function links(current: PageNode): void {
        if (current.type !== "element") return;
        if (typeof current.attrs?.href === "string" && current.attrs.href.startsWith("#") && remap.has(current.attrs.href.slice(1))) current.attrs.href = `#${remap.get(current.attrs.href.slice(1))}`;
        for (const key of ["aria-labelledby", "aria-describedby"]) if (typeof current.attrs?.[key] === "string") current.attrs[key] = current.attrs[key].split(" ").map((id) => remap.get(id) ?? id).join(" ");
        current.children.forEach(links);
      }
      links(copy); parentChildren(operation.path).splice(operation.path.at(-1)! + 1, 0, copy);
    } else if (operation.type === "move") {
      if (operation.parentId && walkNodes({ ...draft, body: [node] }).some(({ node }) => node.type !== "text" && node.id === operation.parentId)) throw new Error("要素を自分の内側へ移動できません。");
      parentChildren(operation.path).splice(operation.path.at(-1)!, 1);
      const destination = targetChildren(operation.parentId);
      if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > destination.length) throw new Error("移動先の位置が不正です。");
      destination.splice(operation.index, 0, node);
    }
  }
  const result = parsePageDocument(draft, blocks, components ? { components } : {});
  assertLocks(document, result, allLocks);
  return result;
}
export function commitHistory(history: EditorHistory, document: PageDocument): EditorHistory {
  if (fingerprint(document) === fingerprint(history.present)) return history;
  return { past: [...history.past.slice(-49), history.present], present: document, future: [] };
}
/** 内容と履歴の順序を保ち、保存先が採番した revision を編集の新しい基準にする。 */
export function acceptSavedRevision(history: EditorHistory, submitted: PageDocument, revision: number): { history: EditorHistory; saved: string } {
  if (!Number.isSafeInteger(revision) || revision <= submitted.revision || history.present.revision !== submitted.revision) throw new Error("保存後の revision が一致しません。編集内容は保持されています。");
  const rebase = (document: PageDocument): PageDocument => ({ ...document, revision });
  return {
    history: { past: history.past.map(rebase), present: rebase(history.present), future: history.future.map(rebase) },
    saved: fingerprint(rebase(submitted))
  };
}
export function travelHistory(history: EditorHistory, direction: "undo" | "redo", blocks: EditorBlockRegistry, locks: readonly EditorLock[]): EditorHistory {
  const target = direction === "undo" ? history.past.at(-1) : history.future[0];
  if (!target) return history;
  assertLocks(history.present, target, effectiveLocks(history.present, locks, blocks));
  return direction === "undo" ? { past: history.past.slice(0, -1), present: target, future: [history.present, ...history.future] }
    : { past: [...history.past, history.present], present: target, future: history.future.slice(1) };
}
export function sameTarget(left: EditorTarget, right: EditorTarget): boolean {
  return left.siteId === right.siteId && left.pageId === right.pageId && left.locale === right.locale;
}
export function validateReleasePlan(plan: EditorReleasePlan, request: EditorReleaseRequest, site: EditorSite): void {
  if (!isSafeHttpsOrigin(plan.domain) || !site.domains.includes(plan.domain) || !sameTarget(plan.target, request.target) || plan.expectedVersion !== request.expectedVersion || plan.action !== request.action || plan.revision !== request.revision ||
    plan.componentsVersion !== request.componentsVersion ||
    typeof plan.confirmationToken !== "string" || !plan.confirmationToken || !Array.isArray(plan.changes) ||
    plan.changes.some((change) => !change || typeof change.path !== "string" || typeof change.before !== "string" || typeof change.after !== "string") ||
    (request.action === "rollback" && (!Number.isSafeInteger(request.revision) || request.revision! < 1))) throw new Error("公開対象または差分確認の情報が一致しません。再取得してください。");
}
const changeTarget = (change: EditorPageChange): EditorTarget | undefined => change.action === "create" ? undefined : change.action === "duplicate" ? change.source : change.target;
type PageChangeProblem = { field: "title" | "path" | "change"; message: string };
/** 入力欄ごとに表示するための問題。対象・権限の問題は change として1件だけ返す。 */
export function pageChangeProblems(change: EditorPageChange, pages: readonly EditorPage[], site: EditorSite): PageChangeProblem[] {
  const target = changeTarget(change), siteId = target ? target.siteId : change.action === "create" ? change.siteId : undefined;
  if (siteId !== site.id) return [{ field: "change", message: "別のサイトのページは操作できません。" }];
  const page = target && pages.find((page) => sameTarget(page, target));
  if (target && !page) return [{ field: "change", message: "対象のページが見つかりません。ページ一覧を再読込してください。" }];
  if (page && (page.kind ?? "page") !== "page") return [{ field: "change", message: "テンプレートと共通枠はホストが管理します。" }];
  if (change.action === "visibility") {
    if (change.visibility !== "public" && change.visibility !== "private") return [{ field: "change", message: "公開状態を選択してください。" }];
    if ((page?.visibility ?? "public") === change.visibility) return [{ field: "change", message: change.visibility === "private" ? "このページはすでに非公開です。" : "このページはすでに公開状態です。" }];
    return [];
  }
  const locale = page ? page.locale : change.action === "create" ? change.locale : "";
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(locale)) return [{ field: "change", message: "ページの言語を確認できません。" }];
  const problems: PageChangeProblem[] = [];
  if (typeof change.title !== "string" || !change.title.trim()) problems.push({ field: "title", message: "ページ名を入力してください。" });
  else if (change.title.length > 120) problems.push({ field: "title", message: "ページ名は120文字以内にしてください。" });
  else if (/[\u0000-\u001f\u007f]/u.test(change.title)) problems.push({ field: "title", message: "ページ名に改行や制御文字は使えません。" });
  const pathProblem = validatePagePath(change.path);
  const conflict = pathProblem ? undefined : findPathConflict(pages, { siteId: site.id, locale, path: change.path, ...(change.action === "update" && page ? { exceptPageId: page.pageId } : {}) });
  if (pathProblem) problems.push({ field: "path", message: pathProblem });
  else if (conflict) problems.push({ field: "path", message: conflict.kind === "template" ? `テンプレート「${conflict.title}」の URL と重なります。` : `「${conflict.title}」と同じ URL です。` });
  if (!problems.length && change.action === "update" && page && page.title === change.title && page.path === change.path) problems.push({ field: "change", message: "ページ名か URL パスを変更してください。" });
  return problems;
}
/** UI 補助の事前確認。ホストは applyPageChange でも同じ規則と予約パスを検査する。 */
export function checkPageChange(change: EditorPageChange, pages: readonly EditorPage[], site: EditorSite): string | undefined {
  return pageChangeProblems(change, pages, site)[0]?.message;
}
const planText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
function normalizedTarget(value: unknown): EditorTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { siteId, pageId, locale } = value as Record<string, unknown>;
  return typeof siteId === "string" && typeof pageId === "string" && typeof locale === "string" ? { siteId, pageId, locale } : undefined;
}
/** 既知の項目だけを持つ変更要求。形が合わなければ undefined。 */
export function normalizePageChange(value: unknown): EditorPageChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const change = value as Record<string, unknown>, { title, path } = change;
  if (change.action === "visibility") {
    const target = normalizedTarget(change.target);
    return target && (change.visibility === "public" || change.visibility === "private") ? { action: "visibility", target, visibility: change.visibility } : undefined;
  }
  if (typeof title !== "string" || typeof path !== "string") return undefined;
  if (change.action === "create") return typeof change.siteId === "string" && typeof change.locale === "string" ? { action: "create", siteId: change.siteId, locale: change.locale, title, path } : undefined;
  if (change.action === "duplicate") { const source = normalizedTarget(change.source); return source && { action: "duplicate", source, title, path }; }
  if (change.action === "update") { const target = normalizedTarget(change.target); return target && { action: "update", target, title, path }; }
  return undefined;
}
/** 要求と一致し、許可済みドメインの影響だけを持つ plan の複製を返す。 */
export function validatePageChangePlan(plan: unknown, change: EditorPageChange, site: EditorSite): EditorPageChangePlan {
  const invalid = (): never => { throw new Error("ページ変更の対象または影響の情報が一致しません。再取得してください。"); };
  if (!plan || typeof plan !== "object") return invalid();
  const source = plan as Record<string, unknown>, domain = source.domain, requested = normalizePageChange(change), returned = normalizePageChange(source.change);
  if (!isSafeHttpsOrigin(domain) || !site.domains.includes(domain) || !requested || !returned || JSON.stringify(requested) !== JSON.stringify(returned)) return invalid();
  const target = changeTarget(requested);
  if ((target ? target.siteId : requested.action === "create" ? requested.siteId : "") !== site.id) return invalid();
  if (typeof source.confirmationToken !== "string" || !source.confirmationToken || source.confirmationToken.length > 4096) return invalid();
  const impact = source.impact as Record<string, unknown> | null | undefined;
  if (!impact || typeof impact !== "object") return invalid();
  const pageUrl = (value: unknown): string => planText(value, 2048) && value.startsWith(`${domain}/`) ? value : invalid();
  const texts = (value: unknown): string[] => Array.isArray(value) && value.length <= 100 && value.every((item) => planText(item, 300)) ? [...value] : invalid();
  const redirect = impact.redirect as Record<string, unknown> | null | undefined;
  if (redirect !== undefined && (!redirect || typeof redirect !== "object" || !planText(redirect.from, 2048) || !planText(redirect.to, 2048))) return invalid();
  if (!Array.isArray(impact.linkedFrom) || impact.linkedFrom.length > 500) return invalid();
  const linkedFrom = (impact.linkedFrom as unknown[]).map((entry) => {
    const { pageId, locale, title, count } = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (typeof pageId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(pageId) || !planText(locale, 40) || !planText(title, 300) ||
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return invalid();
    return { pageId, locale, title, count };
  });
  const result: EditorPageImpact = {
    ...(impact.before === undefined ? {} : { before: pageUrl(impact.before) }),
    ...(impact.after === undefined ? {} : { after: pageUrl(impact.after) }),
    ...(redirect ? { redirect: { from: redirect.from as string, to: redirect.to as string } } : {}),
    linkedFrom, navigation: texts(impact.navigation), notes: texts(impact.notes)
  };
  return { change: requested, confirmationToken: source.confirmationToken, domain, impact: result };
}
export function newElement(tag: ElementNode["tag"], id: string): ElementNode {
  return tag === "img" ? { type: "element", id, tag, attrs: { src: "/placeholder.webp", alt: "画像の説明" }, children: [] }
    : { type: "element", id, tag, ...(tag === "a" ? { attrs: { href: "/" } } : {}), children: tag === "section" ? [] : [{ type: "text", text: tag === "a" ? "リンク" : "新しいテキスト" }] };
}
