"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { AlignGrid, Collapse, ColorField, FontField, PercentField, Row, Segmented, SelectField, Stepper, Toggle, UnitField, fontChoices, weightChoices, type Align, type Choice, type Pending, type RowStatus } from "./editor-fields.js";
import { walkNodes, type EditorOperation, type NodePath } from "./editor-model.js";
import type { EditorBlockRegistry } from "./editor-types.js";
import { declarationsAt, expandBox, fieldState, resolveValue, tierForWidth, tierName, type EditorTier, type FieldState, type TierKey } from "./style-model.js";
import { MotionFields, type StyleState } from "./editor-style-motion.js";
import { styleTokenKind, textStyleProperties } from "./style-values.js";
import type { ComponentNode, ElementNode, InstanceNode, PageDocument, PageNode, StyleProperty, StyleValue } from "./types.js";

type Values = Partial<Record<StyleProperty, StyleValue | undefined>>;
/** wide: 選んだ段から上の幅すべて（mobile first の通常の指定）。only: 次の段の手前まで。 */
export type StyleRange = "wide" | "only";
export type StyleInspectorProps = {
  document: PageDocument;
  /** 「外観」の背景色の直後に差し込むホスト側の欄（素材の背景画像など）。 */
  appearanceExtra?: ReactNode;
  /** 保存済み文書の fingerprint（JSON）。保存前の項目に印を付ける。 */
  saved?: string | undefined;
  node: ElementNode | ComponentNode | InstanceNode;
  path: NodePath;
  blocks: EditorBlockRegistry;
  tiers: readonly EditorTier[];
  tier: TierKey;
  setTier: (tier: TierKey) => void;
  range: StyleRange;
  setRange: (range: StyleRange) => void;
  width: number;
  setWidth: (width: number) => void;
  apply: (operation: EditorOperation) => string | undefined;
  preview: (operation: EditorOperation | null) => void;
  pending: Pending;
  fieldKey: string;
  disabled: boolean;
  /** 入力途中の値がある間は段を切り替えない。 */
  tierLocked: boolean;
  reason: (field: string) => string | undefined;
  notify: (message: string) => void;
  /** 編集中の状態。通常以外では状態に使える見た目だけを表示し、キャンバスに強制表示する。 */
  styleState?: StyleState;
  setStyleState?: (state: StyleState) => void;
};

const textTags = new Set("h1 h2 h3 h4 h5 h6 p span a li strong em small blockquote figcaption time".split(" "));
const lengths = ["px", "%", "rem", "vw", "vh"];
const auto: Choice[] = [["auto", "自動"]];
const sizes: Choice[] = [["auto", "自動"], ["fit-content", "内容に合わせる"], ["min-content", "内容の最小幅"], ["max-content", "内容の最大幅"]];
const displays: Choice[] = [["block", "通常"], ["flex", "横並び・縦並び"], ["grid", "グリッド"], ["inline", "文中に並べる"], ["inline-block", "文中に並べる（サイズ指定可）"], ["inline-flex", "文中で横並び・縦並び"], ["inline-grid", "文中のグリッド"], ["none", "非表示"]];
const directions = [{ value: "column", text: "縦", icon: "↓" }, { value: "row", text: "横", icon: "→" }, { value: "wrap", text: "横（折り返し）", icon: "↩" }, { value: "row-reverse", text: "横（逆順）", icon: "←" }, { value: "column-reverse", text: "縦（逆順）", icon: "↑" }] as const;
const aligns = [{ value: "left", text: "左" }, { value: "center", text: "中央" }, { value: "right", text: "右" }, { value: "justify", text: "両端" }] as const;
const columns = [1, 2, 3, 4].map((count) => ({ value: `repeat(${count}, minmax(0, 1fr))`, text: `${count} 列` }));
const positions: Choice[] = [["static", "通常"], ["relative", "相対"], ["absolute", "絶対"], ["fixed", "固定"], ["sticky", "追従"]];
const overflows: Choice[] = [["visible", "表示"], ["hidden", "隠す"], ["auto", "スクロール"], ["clip", "切り取る"], ["scroll", "常にスクロール"]];
const borders: Choice[] = [["none", "なし"], ["solid", "実線"], ["dashed", "破線"], ["dotted", "点線"], ["double", "二重線"]];
const selfAligns: Choice[] = [["auto", "親に合わせる"], ["flex-start", "先頭"], ["center", "中央"], ["flex-end", "末尾"], ["stretch", "引き伸ばす"], ["baseline", "文字の基準線"]];
const fits: Choice[] = [["fill", "引き伸ばす"], ["contain", "全体を収める"], ["cover", "全体を覆う"], ["none", "元のサイズ"], ["scale-down", "縮小のみ"]];
const hasText = (node: PageNode): boolean => node.type === "text" ? !!node.text.trim() : node.type === "element" && node.children.some(hasText);
const norm = (value: unknown): Align | undefined => value === "flex-start" || value === "start" ? "start" : value === "flex-end" || value === "end" ? "end" : value === "center" ? "center" : undefined;
const flip = (value: Align | undefined): Align | undefined => value === "start" ? "end" : value === "end" ? "start" : value;
const flexValue = (value: Align) => value === "center" ? "center" : `flex-${value}`;

type UnitOptions = { units?: readonly string[]; numberUnit?: string; numberLabel?: string; keywords?: readonly Choice[]; extra?: ReactNode; value?: StyleValue | undefined; apply?: (value: StyleValue | undefined) => string | undefined; status?: RowStatus; key?: string };
type Ui = {
  document: PageDocument; tier: TierKey; disabled: boolean; uid: string;
  can: (property: StyleProperty) => boolean;
  state: (property: StyleProperty) => FieldState;
  effective: (property: StyleProperty) => string | number | undefined;
  set: (values: Values) => string | undefined;
  report: (error: string | undefined) => void;
  status: (properties: StyleProperty[], valueLabel?: string) => RowStatus;
  unit: (property: StyleProperty, caption: string, options?: UnitOptions) => ReactNode;
  select: (property: StyleProperty, caption: string, choices: readonly Choice[], number?: boolean) => ReactNode;
};

/** 右パネルの見た目の編集。段（幅）と反映する範囲を明示して選び、指定・継承・上書き・保存前を表示する。 */
export function StyleInspector(props: StyleInspectorProps) {
  const { document, node, path, blocks, tiers, tier, apply, preview, pending, fieldKey, disabled, reason, notify } = props;
  const uid = useId();
  const allowed = node.type === "component" ? blocks[node.block]?.styleProperties : undefined;
  const can = (property: StyleProperty | "textStyle" | "states" | "appear" | "hidden") => !allowed || allowed.includes(property);
  const styleState = props.styleState ?? "normal", normal = styleState === "normal";
  const index = Math.max(0, tiers.findIndex((entry) => entry.key === tier)), current = tiers[index] ?? { key: "base" as const, start: 0, end: null, label: "基本" };
  const tone = index === 0 ? 0 : (index - 1) % 2 + 1, higher = tiers.slice(index + 1), next = higher[0];
  const only = props.range === "only" && !!next, shown = tierForWidth(tiers, props.width);
  const saved = useMemo(() => {
    if (!props.saved) return undefined;
    try { return walkNodes(JSON.parse(props.saved) as PageDocument).find(({ node: entry }) => entry.type !== "text" && entry.id === node.id)?.node as ElementNode | ComponentNode | undefined; } catch { return undefined; }
  }, [props.saved, node.id]);
  const tierOf = (key: TierKey) => tiers.find((entry) => entry.key === key);
  const styleLabel = (name: string | undefined) => name ? document.textStyles?.[name]?.label ?? name : "";
  // 「〜だけ」は次の段の responsive にも書くため、responsive のロックも確認する。
  const lock = (property: StyleProperty) => reason(tier === "base" ? `style.base.${property}` : "style.responsive") ?? (only ? reason("style.responsive") : undefined);
  const key = (property: string) => `${fieldKey}-${tier}-${property}`;
  const operation = (values: Values): EditorOperation => only ? { type: "styleRange", path, breakpoint: tier, until: next!.start, values } : { type: "styles", path, breakpoint: tier, values };
  const set = (values: Values) => apply(operation(values));
  const report = (error: string | undefined) => { if (error) notify(error); };
  const draft = (property: StyleProperty) => (value: StyleValue | undefined | null) => preview(value === null ? null : operation({ [property]: value }));
  const state = (property: StyleProperty) => fieldState(document, node, property, tier);
  const effective = (property: StyleProperty) => { const value = state(property); return resolveValue(document, value.own ?? value.inherited?.value); };
  const text = (value: StyleValue | undefined) => value === undefined ? undefined : typeof value === "object" ? document.tokens[value.token]?.label ?? value.token : String(value);
  function status(properties: StyleProperty[], valueLabel?: string): RowStatus {
    const states = properties.map(state), from = states[0]!.inherited;
    const source = from && (from.via === "textStyle" ? styleLabel(from.textStyle) : tierOf(from.from)?.label ?? `${from.from}px〜`);
    const sourceLong = from && (from.via === "textStyle" ? `テキストスタイル『${styleLabel(from.textStyle)}』から継承` : `${tierOf(from.from) ? tierName(tierOf(from.from)!) : `${from.from}px〜`}から継承`);
    const over = [...new Set(states.flatMap((entry) => entry.overriddenAt))].sort((a, b) => a - b).map((width) => tierOf(width));
    const inheritedOnly = states.every((entry) => entry.own === undefined) && !!from;
    return {
      own: states.some((entry) => entry.own !== undefined), lock: properties.map(lock).find(Boolean),
      reset: () => report(set(Object.fromEntries(properties.map((property) => [property, undefined])))),
      inherited: inheritedOnly ? `継承: ${source}${valueLabel ? ` · ${valueLabel}` : ""}` : undefined,
      inheritedTitle: inheritedOnly ? `${sourceLong}${valueLabel ? `（${valueLabel}）` : ""}` : undefined,
      overridden: over.length ? `別の値: ${over.map((entry) => entry?.label).join("・")}` : undefined,
      overriddenTitle: over.length ? `${over.map((entry) => entry ? tierName(entry) : "").join("・")} では別の値` : undefined,
      unsaved: properties.some((property, at) => JSON.stringify(declarationsAt(saved?.style, tier)?.[property]) !== JSON.stringify(states[at]!.own))
    };
  }
  const tokenChoices = (property: StyleProperty): Choice[] => Object.entries(document.tokens).filter(([, token]) => token.type === styleTokenKind(property)).map(([name, token]) => [name, token.label ?? name]);
  const colorTokens = Object.entries(document.tokens).filter(([, token]) => token.type === "color").map(([name, token]) => ({ name, label: token.label ?? name, value: String(token.value) }));
  const ui: Ui = {
    document, tier, disabled, uid, state, effective, set, report, status,
    can: (property) => can(property),
    unit: (property, caption, options = {}) => can(property) && <UnitField key={options.key ?? key(property)} caption={caption} value={"value" in options ? options.value : state(property).own}
      units={options.units ?? lengths} numberUnit={options.numberUnit ?? "px"} numberLabel={options.numberLabel ?? "数値"} keywords={options.keywords ?? []} tokens={tokenChoices(property)}
      apply={options.apply ?? ((value) => set({ [property]: value }))} preview={options.apply ? undefined : draft(property)} pending={pending} fieldKey={options.key ?? key(property)}
      disabled={disabled || !!lock(property)} status={options.status ?? status([property])} placeholder={text(state(property).inherited?.value)} extra={options.extra} />,
    select: (property, caption, choices, number = false) => {
      const inherited = state(property).inherited?.value, own = state(property).own;
      const tokens = tokenChoices(property).map(([name, title]): Choice => [`@${name}`, `共通: ${title}`]), all = [...choices, ...tokens];
      const inheritedKey = inherited === undefined ? undefined : typeof inherited === "object" ? `@${inherited.token}` : String(inherited);
      return can(property) && <SelectField key={key(property)} caption={caption} value={own === undefined ? undefined : typeof own === "object" ? `@${own.token}` : String(own)} options={all}
        parse={(value) => value.startsWith("@") ? { token: value.slice(1) } : number && /^\d+$/.test(value) ? Number(value) : value}
        apply={(value) => set({ [property]: value })} disabled={disabled || !!lock(property)} status={status([property], inheritedKey && (all.find(([name]) => name === inheritedKey)?.[1] ?? inheritedKey))} />;
    }
  };
  const color = (property: StyleProperty, caption: string, none = false) => {
    if (!can(property)) return null;
    const value = state(property), inherited = resolveValue(document, value.inherited?.value);
    return <ColorField key={key(property)} caption={caption} value={value.own} tokens={colorTokens} inherited={typeof inherited === "string" ? inherited : undefined}
      apply={(next) => set({ [property]: next })} preview={draft(property)} pending={pending} fieldKey={key(property)} disabled={disabled || !!lock(property)} status={status([property])}
      placeholder={text(value.inherited?.value)} none={none ? { value: value.inherited ? "transparent" : undefined } : undefined} />;
  };
  const toggle = (property: StyleProperty, caption: string, on: string, off: string, icon: string) => {
    if (!can(property)) return null;
    const value = state(property), pressed = effective(property) === on;
    return <Toggle key={key(property)} text={caption} icon={icon} pressed={pressed} disabled={disabled || !!lock(property)}
      onChange={() => report(set({ [property]: !pressed ? on : value.own === on && resolveValue(document, value.inherited?.value) !== on ? undefined : off }))} />;
  };
  const segment = (properties: StyleProperty[], caption: string, control: ReactNode) => properties.some(can) && <Row key={key(properties.join("+"))} caption={caption} group status={status(properties)}>{control}</Row>;
  const chooseTier = (value: TierKey) => { props.setTier(value); props.setRange("wide"); };
  const fontHint = (() => { const value = state("fontFamily").inherited?.value; return value === undefined ? undefined : typeof value === "object" ? text(value) : fontChoices.find(([name]) => name === String(value))?.[1] ?? String(value); })();

  const element = node.type === "element" ? node : undefined;
  // 業務ブロックと部品のインスタンスは中身を判定できないため、文字の見た目も編集できるようにする。
  const textual = node.type === "component" || node.type === "instance" || !!element && (textTags.has(element.tag) || hasText(element)) || textStyleProperties.some((property) => state(property).own !== undefined);
  const display = String(effective("display") ?? ""), flex = display === "flex" || display === "inline-flex", grid = display === "grid" || display === "inline-grid";
  const position = String(effective("position") ?? "static");
  const textStyles = Object.entries(document.textStyles ?? {});
  const span = only ? current.key === "base" ? `〜${next!.start - 1}px` : `${current.start}〜${next!.start - 1}px` : current.key === "base" ? "すべての幅" : `${current.start}px 以上`;
  const description = only ? `${span}だけに適用。${next!.start}px 以上の見た目は変えません。`
    : `${span}に適用。${higher.length ? current.key === "base" ? "上の幅で上書きした項目を除きます。" : `${higher.map(tierName).join("・")} で上書きした項目を除きます。` : ""}`;
  const outside = props.width < current.start || only && props.width >= next!.start;
  const target = props.width < current.start ? current.start : current.start === 0 ? Math.min(375, next!.start - 1) : current.start;
  const motionVisible = (["states", "appear", "hidden", "translate", "rotate", "scale", "transformOrigin", "transitionDuration"] as const).some(can);
  return <div className="e-inspector" data-tone={tone}>
    {normal && <div className="e-tierbar">
      <Segmented label="編集する幅" value={String(tier)} options={tiers.map((entry) => ({ value: String(entry.key), text: tierName(entry) }))} disabled={disabled || props.tierLocked}
        onChange={(value) => chooseTier(value === "base" ? "base" : Number(value))} />
      {next && <Segmented label="反映する範囲" className="e-range" value={only ? "only" : "wide"} disabled={disabled || props.tierLocked} onChange={props.setRange}
        options={[{ value: "wide", text: current.key === "base" ? "すべての幅" : `${current.start}px 以上` }, { value: "only", text: current.key === "base" ? `〜${next.start - 1}px だけ` : `${current.start}〜${next.start - 1}px だけ` }]} />}
      <p className="e-help">{description}</p>
      {outside && <p className="e-tier-out" role="status">表示中の {props.width}px にはこの指定は反映されません
        <button type="button" className="e-small" onClick={() => props.setWidth(target)}>{target}px で表示</button></p>}
      {shown.key !== current.key && <button type="button" className="e-small e-follow" disabled={disabled || props.tierLocked} onClick={() => chooseTier(shown.key)}>表示中の幅（{tierName(shown)}）の段を編集</button>}
    </div>}
    {normal && allowed && <p className="e-help">このブロックで変更できる見た目だけを表示しています。</p>}
    {normal && textual && (can("textStyle") || textStyleProperties.some(can) || can("color") || can("textAlign")) && <section className="e-sec"><h3>テキスト</h3>
      {can("textStyle") && <Row caption="テキストスタイル" htmlFor={`${uid}-ts`} status={{ unsaved: (saved?.style?.textStyle ?? "") !== (node.style?.textStyle ?? ""), lock: reason("style.textStyle") }}>
        <span className="e-inline"><select id={`${uid}-ts`} aria-label="テキストスタイル" value={node.style?.textStyle ?? ""} disabled={disabled || !!reason("style.textStyle")}
          onChange={(event) => report(apply({ type: "nodeTextStyle", path, name: event.target.value || undefined }))}>
          <option value="">なし</option>{textStyles.map(([name, style]) => <option key={name} value={name}>{style.label ?? name}</option>)}
        </select>
        {node.style?.textStyle && <button type="button" className="e-small" title="今の見た目のまま、この要素だけの指定に変えます" disabled={disabled || !!reason("style.textStyle")} onClick={() => report(apply({ type: "nodeTextStyle", path, name: undefined, detach: true }))}>切り離す</button>}</span>
      </Row>}
      {color("color", "文字色")}
      {can("fontFamily") && <FontField key={key("fontFamily")} caption="フォント" value={state("fontFamily").own} fonts={fontChoices} tokens={tokenChoices("fontFamily")} apply={(value) => set({ fontFamily: value })}
        preview={draft("fontFamily")} pending={pending} fieldKey={key("fontFamily")} disabled={disabled || !!lock("fontFamily")} status={status(["fontFamily"], fontHint)} />}
      <div className="e-grid2">{ui.unit("fontSize", "文字サイズ", { units: ["px", "rem", "em", "%", "vw"] })}{ui.select("fontWeight", "文字の太さ", weightChoices, true)}</div>
      <div className="e-grid2">{ui.unit("lineHeight", "行間", { units: ["", "px", "%", "rem", "em"], numberUnit: "", numberLabel: "倍", keywords: [["normal", "標準"]] })}{ui.unit("letterSpacing", "字間", { units: ["px", "em", "rem"] })}</div>
      {segment(["textAlign"], "文字揃え", <Segmented label="文字揃え" value={String(effective("textAlign") ?? "")} options={aligns} disabled={disabled || !!lock("textAlign")} onChange={(value) => report(set({ textAlign: value }))} />)}
      {(can("fontStyle") || can("textDecorationLine")) && <div className="e-actions">{toggle("fontStyle", "斜体", "italic", "normal", "I")}{toggle("textDecorationLine", "下線", "underline", "none", "U")}</div>}
    </section>}
    {normal && <Layout ui={ui} />}
    {normal && element && <Flow ui={ui} flex={flex} grid={grid} />}
    {normal && (!!props.appearanceExtra || (["backgroundColor", "borderRadius", "borderWidth", "borderStyle", "borderColor", "opacity"] as const).some(can)) && <section className="e-sec"><h3>外観</h3>
      {color("backgroundColor", "背景色", true)}
      {props.appearanceExtra}
      {can("borderRadius") && <Corners key={key("radius")} ui={ui} />}
      <div className="e-grid2">{ui.unit("borderWidth", "枠線の太さ", { units: ["px", "rem", "em"] })}{ui.select("borderStyle", "枠線の種類", borders)}</div>
      {color("borderColor", "枠線の色")}
      {can("opacity") && <PercentField key={key("opacity")} caption="不透明度" value={state("opacity").own} apply={(value) => set({ opacity: value })} preview={draft("opacity")} pending={pending} fieldKey={key("opacity")}
        disabled={disabled || !!lock("opacity")} status={status(["opacity"])} placeholder={typeof effective("opacity") === "number" ? String(Math.round(Number(effective("opacity")) * 100)) : "100"} />}
    </section>}
    {normal && (["position", "top", "right", "bottom", "left", "zIndex", "overflow"] as const).some(can) && <Collapse key={key("position-section")} title="位置">
      {ui.select("position", "配置の基準", positions)}
      {position !== "static" && <div className="e-grid2">{ui.unit("top", "上から", { keywords: auto })}{ui.unit("right", "右から", { keywords: auto })}{ui.unit("bottom", "下から", { keywords: auto })}{ui.unit("left", "左から", { keywords: auto })}</div>}
      {can("zIndex") && <Stepper key={key("zIndex")} caption="重ね順" value={state("zIndex").own} apply={(value) => set({ zIndex: value })} preview={draft("zIndex")} pending={pending} fieldKey={key("zIndex")}
        disabled={disabled || !!lock("zIndex")} status={status(["zIndex"])} placeholder={text(state("zIndex").inherited?.value)} />}
      {ui.select("overflow", "はみ出し", overflows)}
    </Collapse>}
    {normal && (["flexGrow", "flexShrink", "flexBasis", "gridColumn", "gridRow", "alignSelf", "objectFit"] as const).some(can) && <Collapse key={key("detail-section")} title="詳細">
      <div className="e-grid2">{ui.unit("flexGrow", "伸びる比率", { units: [""], numberUnit: "" })}{ui.unit("flexShrink", "縮む比率", { units: [""], numberUnit: "" })}</div>
      {ui.unit("flexBasis", "基準サイズ", { keywords: sizes })}
      <div className="e-grid2">{ui.unit("gridColumn", "グリッドの列位置", { units: [] })}{ui.unit("gridRow", "グリッドの行位置", { units: [] })}</div>
      {ui.select("alignSelf", "自身の揃え", selfAligns)}
      {element?.tag === "img" && ui.select("objectFit", "画像の収まり", fits)}
    </Collapse>}
    {motionVisible && <Collapse key={`${fieldKey}-motion`} title="演出" initial={!normal}>
      <MotionFields document={document} node={node} saved={saved} path={path} tiers={tiers} state={styleState} setState={props.setStyleState ?? (() => undefined)} apply={apply} preview={preview} pending={pending}
        fieldKey={fieldKey} disabled={disabled} reason={reason} notify={notify} can={can} colorTokens={colorTokens}
        tier={{ key: String(tier), get: (property) => state(property).own, set, preview: (values) => preview(values === null ? null : operation(values)), status: (property) => status([property]), lock, effective }} />
    </Collapse>}
  </div>;
}

function Layout({ ui }: { ui: Ui }) {
  const limits = (["minWidth", "maxWidth", "minHeight", "maxHeight"] as const);
  if (!(["width", "height", "margin", "padding", ...limits] as StyleProperty[]).some(ui.can) && !(["marginTop", "paddingTop"] as StyleProperty[]).some(ui.can)) return null;
  return <section className="e-sec"><h3>レイアウト</h3>
    <div className="e-grid2">{ui.unit("width", "幅", { keywords: sizes })}{ui.unit("height", "高さ", { keywords: sizes })}</div>
    {limits.some(ui.can) && <Collapse title="最小・最大サイズ" initial={limits.some((property) => ui.state(property).own !== undefined)}>
      <div className="e-grid2">{ui.unit("minWidth", "最小幅", { keywords: auto })}{ui.unit("maxWidth", "最大幅", { keywords: [["none", "制限なし"]] })}
        {ui.unit("minHeight", "最小高さ", { keywords: auto })}{ui.unit("maxHeight", "最大高さ", { keywords: [["none", "制限なし"]] })}</div>
    </Collapse>}
    <Box key={`${ui.tier}-margin`} ui={ui} kind="margin" />
    <Box key={`${ui.tier}-padding`} ui={ui} kind="padding" />
  </section>;
}

/** 一括 1 欄 ⇔ 上右下左 4 欄。切替は 1 回の操作（1 回の undo で戻る）。 */
function Box({ ui, kind }: { ui: Ui; kind: "margin" | "padding" }) {
  const caption = kind === "margin" ? "外側の余白" : "内側の余白", short = kind === "margin" ? "外余白" : "内余白";
  const sides = (["Top", "Right", "Bottom", "Left"] as const).map((side) => `${kind}${side}` as StyleProperty);
  const own = sides.map((property) => ui.state(property).own), [choice, setChoice] = useState(false);
  if (![kind, ...sides].some(ui.can)) return null;
  const split = choice || own.some((value) => value !== undefined) || !ui.can(kind);
  function toggle() {
    if (split) {
      const defined = own.filter((value): value is StyleValue => value !== undefined);
      setChoice(false);
      if (!defined.length) return;
      const same = defined.length === 4 && defined.every((value) => JSON.stringify(value) === JSON.stringify(defined[0]));
      ui.report(ui.set({ [kind]: same ? defined[0] : own[0] ?? defined[0], ...Object.fromEntries(sides.map((property) => [property, undefined])) }));
    } else {
      setChoice(true);
      const shorthand = ui.state(kind).own;
      if (shorthand === undefined) return;
      const parts = typeof shorthand === "object" ? [shorthand, shorthand, shorthand, shorthand] : expandBox(shorthand);
      ui.report(ui.set({ [kind]: undefined, ...Object.fromEntries(sides.map((property, at) => [property, own[at] ?? parts[at]])) }));
    }
  }
  const mode = ui.can(kind) && sides.every(ui.can) && <button type="button" className="e-mode e-small" aria-pressed={split} aria-label={`${caption}を上下左右で個別に指定`} title="上下左右で個別に指定" disabled={ui.disabled} onClick={toggle}>上下左右</button>;
  const keywords = kind === "margin" ? auto : [];
  if (!split) return <>{ui.unit(kind, caption, { keywords, extra: mode })}</>;
  return <div className="e-box"><div className="e-box-head"><span className="e-cap-text">{caption}</span>{mode}</div>
    <div className="e-grid2">{sides.map((property, at) => ui.unit(property, `${["上", "右", "下", "左"][at]}の${short}`, { keywords }))}</div></div>;
}

/** 角丸は 1 つの値の 1〜4 個の並び（左上・右上・右下・左下）。 */
function Corners({ ui }: { ui: Ui }) {
  const own = ui.state("borderRadius").own, resolved = resolveValue(ui.document, own), [choice, setChoice] = useState(false);
  const parts = resolved === undefined ? undefined : expandBox(resolved);
  const split = choice || !!parts && new Set(parts.map(String)).size > 1;
  const css = (value: string | number) => typeof value === "number" ? `${value}px` : value;
  function toggle() {
    setChoice(!split);
    if (split && parts && new Set(parts.map(String)).size > 1) ui.report(ui.set({ borderRadius: parts[0] }));
  }
  const mode = <button type="button" className="e-mode e-small" aria-pressed={split} aria-label="角丸を四隅で個別に指定" title="四隅で個別に指定" disabled={ui.disabled} onClick={toggle}>四隅</button>;
  if (!split) return <>{ui.unit("borderRadius", "角丸", { units: ["px", "%", "rem"], extra: mode })}</>;
  return <div className="e-box"><div className="e-box-head"><span className="e-cap-text">角丸</span>{mode}</div>
    <div className="e-grid2">{["左上", "右上", "右下", "左下"].map((corner, at) => ui.unit("borderRadius", `${corner}の角丸`, {
      units: ["px", "%", "rem"], key: `${ui.uid}-${ui.tier}-radius-${at}`, value: parts?.[at], status: at === 0 ? ui.status(["borderRadius"]) : {},
      apply: (value) => {
        const next = (parts ?? [0, 0, 0, 0]).map(css); next[at] = value === undefined ? "0" : typeof value === "object" ? css(resolveValue(ui.document, value) ?? 0) : css(value);
        return ui.set({ borderRadius: new Set(next).size === 1 ? (value ?? 0) : next.join(" ") });
      }
    }))}</div></div>;
}

function Flow({ ui, flex, grid }: { ui: Ui; flex: boolean; grid: boolean }) {
  const properties: StyleProperty[] = ["display", "flexDirection", "flexWrap", "justifyContent", "alignItems", "gap", "gridTemplateColumns", "gridTemplateRows"];
  if (!properties.some(ui.can)) return null;
  const direction = String(ui.effective("flexDirection") ?? "row"), column = direction.startsWith("column"), reverse = direction.endsWith("reverse");
  const wrap = ui.effective("flexWrap");
  const main = reverse ? flip(norm(ui.effective("justifyContent"))) : norm(ui.effective("justifyContent")), cross = norm(ui.effective("alignItems"));
  const x = column ? cross : main, y = column ? main : cross;
  const spread = ui.effective("justifyContent") === "space-between";
  const lock = (property: StyleProperty) => !!ui.status([property]).lock;
  const row = (properties: StyleProperty[], caption: string, control: ReactNode) => properties.some(ui.can) && <Row caption={caption} group status={ui.status(properties)}>{control}</Row>;
  return <section className="e-sec"><h3>並び</h3>
    {ui.select("display", "配置方式", displays)}
    {flex && <>
      {row(["flexDirection", "flexWrap"], "並ぶ向き", <Segmented label="並ぶ向き" options={directions} value={direction === "row" && wrap === "wrap" ? "wrap" : direction as typeof directions[number]["value"]}
        disabled={ui.disabled || lock("flexDirection") || lock("flexWrap")} onChange={(value) => {
          const inherited = resolveValue(ui.document, ui.state("flexWrap").inherited?.value);
          ui.report(ui.set({ flexDirection: value === "wrap" ? "row" : value, flexWrap: value === "wrap" ? "wrap" : inherited === "wrap" || inherited === "wrap-reverse" ? "nowrap" : undefined }));
        }} />)}
      {ui.unit("gap", "要素間の余白")}
      {row(["justifyContent", "alignItems"], "配置", <><AlignGrid label="配置" value={spread ? undefined : [x, y]} disabled={ui.disabled || lock("justifyContent") || lock("alignItems")} onChange={(nx, ny) => {
        const mainAxis = column ? ny : nx, crossAxis = column ? nx : ny;
        ui.report(ui.set({ justifyContent: flexValue((reverse ? flip(mainAxis) : mainAxis)!), alignItems: flexValue(crossAxis) }));
      }} /><Toggle text="均等に配置" pressed={spread} disabled={ui.disabled || lock("justifyContent")} onChange={() => {
        const own = ui.state("justifyContent");
        ui.report(ui.set({ justifyContent: !spread ? "space-between" : own.own === "space-between" && resolveValue(ui.document, own.inherited?.value) !== "space-between" ? undefined : "flex-start" }));
      }} /></>)}
    </>}
    {grid && <>
      {row(["gridTemplateColumns"], "列の数", <Segmented label="列の数" options={columns} value={String(ui.effective("gridTemplateColumns") ?? "")} disabled={ui.disabled || lock("gridTemplateColumns")} onChange={(value) => ui.report(ui.set({ gridTemplateColumns: value }))} />)}
      {ui.unit("gridTemplateColumns", "列の構成", { units: [], key: `${ui.uid}-${ui.tier}-columns` })}
      {ui.unit("gridTemplateRows", "行の構成", { units: [] })}
      {ui.unit("gap", "要素間の余白")}
    </>}
  </section>;
}
