import { parsePageDocument } from "./document.js";
import { walkNodes, type NodePath } from "./node-tree.js";
import { carouselPreset, togglePreset } from "./interaction-presets.js";
import { stateNames, stateProperties } from "./style-values.js";
import type { SiteStyles } from "./site-styles.js";
import type {
  Appear, BlockContracts, ComponentLibrary, ElementNode, NodeStyle, PageDocument, PageNode, StateDeclarations, StateName, StyleProperty, StyleValue
} from "./types.js";

/** プリセットが作る全ノード ID の採番口。呼ぶたびに文書内で未使用の ID を返す。 */
export type BuilderIdFactory = () => string;
export type InsertionContext = {
  id: BuilderIdFactory;
  target: Readonly<Pick<PageDocument, "siteId" | "pageId" | "locale">>;
};
/** trusted host が通常の PageNode 部分木を返す。関数自体は文書へ保存されない。 */
export type InsertionPreset = {
  id: string;
  label: string;
  description?: string;
  group: string;
  glyph?: string;
  create(context: InsertionContext): PageNode;
};

export type MotionBaseProperty = Extract<StyleProperty,
  "translate" | "rotate" | "scale" | "skew" | "transformOrigin" |
  "transitionDuration" | "transitionDelay" | "transitionTimingFunction">;
/** NodeStyle のうち動きに関係する閉じた領域だけ。responsive・hidden・任意 CSS は受け取らない。 */
export type MotionStylePatch = {
  base?: Partial<Record<MotionBaseProperty, StyleValue>>;
  states?: Partial<Record<StateName, StateDeclarations>>;
  appear?: Appear;
};
export type MotionPreset = { id: string; label: string; description?: string; style: MotionStylePatch };
export type BuilderDefinition = {
  insertions?: readonly InsertionPreset[];
  motions?: readonly MotionPreset[];
};

export type InsertionBuildOptions = {
  document: PageDocument;
  blocks?: BlockContracts;
  components?: ComponentLibrary;
  siteStyles?: SiteStyles;
  /** undefined は全登録ブロック、空配列は新規ブロック禁止。 */
  insertableBlocks?: readonly string[];
  /** 共通部品の編集中など、ホスト固有の配置制約を追加する。 */
  canInsertInstance?: (componentId: string) => boolean;
  /** PageEditor の既存 ID 形式を維持するための接頭辞。 */
  idPrefix?: string;
};

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const motionBaseProperties: readonly MotionBaseProperty[] = [
  "translate", "rotate", "scale", "skew", "transformOrigin", "transitionDuration", "transitionDelay", "transitionTimingFunction"
];
export const MOTION_BASE_PROPERTIES: readonly MotionBaseProperty[] = motionBaseProperties;
const appearFields = ["effect", "trigger", "duration", "delay", "easing"] as const;

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function closed(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(message);
  return value;
}
/** TypeScriptを経由しないhost定義も、NodeStyleのモーション用closed領域だけに制限する。値は文書validatorが別途検査する。 */
export function assertMotionStylePatch(value: unknown): asserts value is MotionStylePatch {
  const source = closed(value, ["base", "states", "appear"], "モーションプリセットのstyleが正しくありません。");
  if (source.base !== undefined) closed(source.base, motionBaseProperties, "モーションプリセットのbaseに未対応の見た目があります。");
  if (source.states !== undefined) {
    const entries = closed(source.states, stateNames, "モーションプリセットの状態が正しくありません。");
    for (const declarations of Object.values(entries)) closed(declarations, stateProperties, "モーションプリセットの状態に未対応の見た目があります。");
  }
  if (source.appear !== undefined) closed(source.appear, appearFields, "モーションプリセットの登場設定が正しくありません。");
  const hasBase = source.base !== undefined && Object.keys(source.base as Record<string, unknown>).length > 0;
  const hasStates = source.states !== undefined && Object.keys(source.states as Record<string, unknown>).length > 0;
  if (!hasBase && !hasStates && source.appear === undefined) throw new Error("モーションプリセットのstyleが空です。");
}

const element = (id: BuilderIdFactory, tag: ElementNode["tag"], text?: string): ElementNode => ({
  type: "element", id: id(), tag,
  ...(tag === "a" ? { attrs: { href: "/" } } : tag === "img" ? { attrs: { src: "/placeholder.webp", alt: "画像の説明" } } : {}),
  children: tag === "img" ? [] : text === undefined ? [] : [{ type: "text", text }]
});
const richText = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "div", attrs: { role: "group", "aria-label": "リッチテキスト" }, children: [element(id, "p", "新しいテキスト")]
});
const list = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "ul", children: ["項目 1", "項目 2", "項目 3"].map((value) => element(id, "li", value))
});
const stack = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "div", style: { base: { display: "flex", gap: 16, alignItems: "center" } },
  children: [element(id, "div"), element(id, "div")]
});
const grid = (id: BuilderIdFactory): ElementNode => ({
  type: "element", id: id(), tag: "div", style: { base: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 } },
  children: [element(id, "div"), element(id, "div")]
});
/** hostが明示的に挿入カタログへ加えられる構成例。標準画面には自動追加しない。 */
export const layoutInsertionPresets: readonly InsertionPreset[] = [
  { id: "hstack", label: "横並び", group: "構造", glyph: "↔", create: ({ id }) => stack(id) },
  { id: "grid", label: "グリッド", group: "構造", glyph: "▦", create: ({ id }) => grid(id) },
  { id: "list", label: "リスト", group: "文字", glyph: "☷", create: ({ id }) => list(id) }
];

/** 画面上の標準挿入項目。表示と生成の両方がこの定義だけを参照する。 */
export const standardBuilderDefinition: BuilderDefinition = {
  insertions: [
    { id: "section", label: "セクション", group: "構造", glyph: "▤", create: ({ id }) => element(id, "section") },
    { id: "box", label: "ボックス", group: "構造", glyph: "□", create: ({ id }) => element(id, "div") },
    { id: "text", label: "テキスト", group: "文字", glyph: "T", create: ({ id }) => element(id, "p", "新しいテキスト") },
    { id: "h2", label: "見出し", group: "文字", glyph: "H", create: ({ id }) => element(id, "h2", "新しいテキスト") },
    { id: "richtext", label: "リッチテキスト", group: "文字", glyph: "¶", create: ({ id }) => richText(id) },
    { id: "a", label: "リンク", group: "文字", glyph: "↗", create: ({ id }) => element(id, "a", "リンク") },
    { id: "img", label: "画像", group: "メディア", glyph: "▧", create: ({ id }) => element(id, "img") },
    { id: "carousel", label: "カルーセル", group: "インタラクション", glyph: "⇆", create: ({ id }) => carouselPreset(id) },
    { id: "toggle", label: "トグル（開閉）", group: "インタラクション", glyph: "▾", create: ({ id }) => togglePreset(id) }
  ],
  motions: []
};

function validText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** 定義の UI メタデータと ID を検査する。style 値は対象文書の token と合わせて適用時にも検査する。 */
export function defineBuilder(definition: BuilderDefinition): BuilderDefinition {
  const ids = new Set<string>();
  for (const entry of definition.insertions ?? []) {
    if (!identifier.test(entry.id) || ids.has(entry.id) || !validText(entry.label) || entry.description !== undefined && !validText(entry.description) ||
        !validText(entry.group) || entry.glyph !== undefined && (!validText(entry.glyph) || [...entry.glyph].length > 4) || typeof entry.create !== "function") throw new Error("挿入プリセットの定義が正しくありません。");
    ids.add(entry.id);
  }
  ids.clear();
  for (const entry of definition.motions ?? []) {
    if (!identifier.test(entry.id) || ids.has(entry.id) || !validText(entry.label) || entry.description !== undefined && !validText(entry.description)) throw new Error("モーションプリセットの定義が正しくありません。");
    assertMotionStylePatch(entry.style);
    ids.add(entry.id);
  }
  return definition;
}

function merged<T extends { id: string }>(base: readonly T[], custom: readonly T[]): T[] {
  const result = [...base], indexes = new Map(result.map((entry, index) => [entry.id, index] as const));
  for (const entry of custom) {
    const index = indexes.get(entry.id);
    if (index === undefined) { indexes.set(entry.id, result.length); result.push(entry); } else result[index] = entry;
  }
  return result;
}
/** custom は同じ ID の標準項目を置換し、新しい ID は末尾へ追加する。 */
export function resolveBuilderDefinition(custom?: BuilderDefinition): Required<BuilderDefinition> {
  defineBuilder(custom ?? {});
  return {
    insertions: merged(standardBuilderDefinition.insertions ?? [], custom?.insertions ?? []),
    motions: merged(standardBuilderDefinition.motions ?? [], custom?.motions ?? [])
  };
}

function descendants(root: PageNode): PageNode[] {
  const result: PageNode[] = [];
  const visit = (node: PageNode): void => { result.push(node); if (node.type === "element") node.children.forEach(visit); };
  visit(root); return result;
}

/** preset を実体化し、採番・ブロック許可・共通部品制約・文書 validator を通した部分木だけを返す。 */
export function createInsertionNode(preset: InsertionPreset, options: InsertionBuildOptions): PageNode {
  const { document, blocks = {}, components, siteStyles, insertableBlocks, canInsertInstance, idPrefix = "node_" } = options;
  const used = new Set(walkNodes(document).flatMap(({ node }) => node.type === "text" ? [] : [node.id])), issued = new Set<string>();
  let counter = 1;
  const id = (): string => {
    let next = "";
    do next = `${idPrefix}${counter++}`; while (used.has(next));
    used.add(next); issued.add(next); return next;
  };
  const node = preset.create({ id, target: { siteId: document.siteId, pageId: document.pageId, locale: document.locale } });
  // raw treeを先に再帰せず、depth・node数・循環を既存validatorで制限した後のコピーだけを走査する。
  const candidate = parsePageDocument({ ...document, body: [...document.body, node] }, blocks, { ...(components ? { components } : {}), ...(siteStyles ? { siteStyles } : {}) });
  const inserted = candidate.body.at(-1)!, nodes = descendants(inserted);
  for (const entry of nodes) {
    if (entry.type === "text") continue;
    if (!issued.has(entry.id)) throw new Error("挿入プリセットは id factory で全ノード ID を採番してください。");
    if (entry.type === "component" && insertableBlocks !== undefined && !insertableBlocks.includes(entry.block)) throw new Error("このブロックは新しく配置できません。");
    if (entry.type === "instance" && canInsertInstance && !canInsertInstance(entry.component)) throw new Error("このコンポーネントはここへ配置できません。");
  }
  if (insertableBlocks !== undefined && components) {
    const definitions = new Map(components.components.map((component) => [component.id, component] as const)), checked = new Set<string>();
    const inspect = (componentId: string): void => {
      if (checked.has(componentId)) return;
      checked.add(componentId);
      const component = definitions.get(componentId);
      if (!component) throw new Error("このコンポーネントはここへ配置できません。");
      for (const entry of descendants(component.root)) {
        if (entry.type === "component" && !insertableBlocks.includes(entry.block)) throw new Error("追加が許可されていない業務ブロックを含むコンポーネントは配置できません。");
        if (entry.type === "instance") inspect(entry.component);
      }
    };
    for (const entry of nodes) if (entry.type === "instance") inspect(entry.component);
  }
  return structuredClone(inserted);
}

export function motionStylePatch(style: NodeStyle | undefined): MotionStylePatch {
  const base = Object.fromEntries(motionBaseProperties.flatMap((property) => style?.base?.[property] === undefined ? [] : [[property, style.base[property]]])) as MotionStylePatch["base"];
  return {
    ...(base && Object.keys(base).length ? { base } : {}),
    ...(style?.states && Object.keys(style.states).length ? { states: structuredClone(style.states) } : {}),
    ...(style?.appear ? { appear: structuredClone(style.appear) } : {})
  };
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equal(value, right[index]));
  if (!plain(left) || !plain(right)) return false;
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]));
}
/** presetが宣言したpathだけをsubset照合する。手動の状態色や別の変形が共存してもactiveになる。 */
export function matchesMotionPreset(style: NodeStyle | undefined, preset: MotionPreset): boolean {
  assertMotionStylePatch(preset.style);
  if (preset.style.appear && !equal(style?.appear, preset.style.appear)) return false;
  for (const [property, value] of Object.entries(preset.style.base ?? {})) if (!equal(style?.base?.[property as MotionBaseProperty], value)) return false;
  for (const [state, declarations] of Object.entries(preset.style.states ?? {})) {
    for (const [property, value] of Object.entries(declarations ?? {})) if (!equal(style?.states?.[state as StateName]?.[property as keyof StateDeclarations], value)) return false;
  }
  return true;
}

export function sameMotionValue(left: unknown, right: unknown): boolean { return equal(left, right); }

/** MotionPreset 操作が参照する path 型を builder entry からも利用できるよう公開する。 */
export type MotionTargetPath = NodePath;
