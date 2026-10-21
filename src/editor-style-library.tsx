"use client";

import { useState, type ReactNode } from "react";
import { ColorField, Field, FontField, SelectField, Toggle, UnitField, fontChoices, weightChoices, type Choice, type Pending } from "./editor-fields.js";
import { nodeAt, type EditorOperation, type NodePath } from "./editor-model.js";
import type { EditorBreakpoint } from "./editor-types.js";
import { colorParts, defaultBreakpoints, editorTiers, formatColor, nextName, resolveValue, textStyleUsage, tierName, tokenUsage, type TierKey } from "./style-model.js";
import type { DesignToken, PageDocument, PageNode, StyleProperty, StyleValue, TextStyle, TextStyleDeclarations, TextStyleProperty, TokenKind } from "./types.js";

export type StyleLibraryProps = {
  document: PageDocument;
  scopeLabel?: string;
  origins?: Readonly<Record<string, string>> | undefined;
  onPromote?: ((kind: "token" | "textStyle", name: string) => void) | undefined;
  canPromote?: ((kind: "token" | "textStyle", name: string) => boolean) | undefined;
  /** ここでは定義を変更・削除できない共通の値（token）と、その理由。要素への適用はできる。 */
  readOnlyToken?: ((name: string) => string | undefined) | undefined;
  /** 新しく作る値の名前に使わない、文書の外の名前。 */
  reservedNames?: readonly string[] | undefined;
  selection: NodePath | null;
  apply: (operation: EditorOperation) => string | undefined;
  select: (path: NodePath) => void;
  disabled: boolean;
  breakpoints?: readonly EditorBreakpoint[] | undefined;
  /** 「選択中の要素に適用」で色を書き込む段。省略時は基本。 */
  breakpoint?: TierKey | undefined;
  /** 「〜だけ」の編集中は次の段の開始幅。広い幅の見た目を保つ styleRange で書き込む。 */
  until?: number | undefined;
  preview?: ((operation: EditorOperation | null) => void) | undefined;
  pending?: Pending | undefined;
  fieldKey?: string | undefined;
  nodeLabel?: ((node: PageNode) => string) | undefined;
};
type Tab = "color" | "text" | "other";
const noop: Pending = () => undefined;
const kinds: Choice[] = [["length", "長さ"], ["fontFamily", "フォント"], ["number", "数値"]];
const tabs = [["color", "カラー", "カラー", "カラーを追加"], ["text", "テキスト", "テキストスタイル", "テキストスタイルを追加"], ["other", "その他", "その他の共通値", "共通の値を追加"]] as const;
const defaultLabel = (node: PageNode) => node.type === "text" ? "テキスト" : node.type === "component" ? `${node.block} · ${node.id}` : node.type === "instance" ? `${node.component} · ${node.id}` : `${node.tag} · ${node.id}`;
const sizeText = (value: StyleValue | undefined, document: PageDocument) => { const resolved = resolveValue(document, value); return resolved === undefined ? "—" : typeof resolved === "number" ? `${resolved}px` : resolved; };

/** 左レールの「スタイル」。共通カラー・テキストスタイル・その他の共通の値を props だけで編集する独立部品。 */
export function StyleLibrary({ document, selection, apply, select, disabled, breakpoints = defaultBreakpoints, breakpoint = "base", until, preview, pending = noop, fieldKey = "library", nodeLabel = defaultLabel, scopeLabel, origins, onPromote, canPromote, readOnlyToken, reservedNames = [] }: StyleLibraryProps) {
  const [tab, setTab] = useState<Tab>("color"), [open, setOpen] = useState<string | null>(null), [confirm, setConfirm] = useState(false), [problem, setProblem] = useState("");
  const selected = selection ? (() => { try { const node = nodeAt(document, selection); return node.type === "text" ? undefined : node; } catch { return undefined; } })() : undefined;
  const run = (operation: EditorOperation) => { const inheritedRemoval = (operation.type === "token" && !operation.token || operation.type === "textStyle" && !operation.style) && origins?.[`${operation.type}:${operation.name}`] === "サイト共通"; const error = inheritedRemoval ? "サイト共通の定義は「サイト共通」で削除してください。" : apply(operation); setProblem(error ?? ""); return error; };
  const paint = (property: StyleProperty, name: string): EditorOperation => until === undefined ? { type: "styles", path: selection!, breakpoint, values: { [property]: { token: name } } }
    : { type: "styleRange", path: selection!, breakpoint, until, values: { [property]: { token: name } } };
  const tokens = Object.entries(document.tokens), styles = Object.entries(document.textStyles ?? {});
  const colors = tokens.filter(([, token]) => token.type === "color"), others = tokens.filter(([, token]) => token.type !== "color");
  function choose(next: Tab) { setTab(next); setOpen(null); setConfirm(false); setProblem(""); }
  function toggle(name: string) { setOpen(open === name ? null : name); setConfirm(false); setProblem(""); }
  function create() {
    let name: string, operation: EditorOperation;
    if (tab === "text") {
      name = nextName(styles.map(([key]) => key), "text");
      operation = { type: "textStyle", name, style: { label: `テキスト ${name.slice(5)}`, base: { fontSize: 16, fontWeight: 400, lineHeight: 1.6 } } };
    } else if (tab === "color") {
      name = nextName([...tokens.map(([key]) => key), ...reservedNames], "color");
      const current = resolveValue(document, selected?.style?.base?.color);
      operation = { type: "token", name, token: { type: "color", value: typeof current === "string" ? current : "#195640", label: `カラー ${name.slice(6)}` } };
    } else {
      name = nextName([...tokens.map(([key]) => key), ...reservedNames], "size");
      operation = { type: "token", name, token: { type: "length", value: 16, label: `サイズ ${name.slice(5)}` } };
    }
    if (!run(operation)) { setOpen(name); setConfirm(false); }
  }
  const usageList = (items: { path: NodePath; nodeId: string }[], extra: string[] = []) => <div className="e-usage"><small className="e-help">使用箇所</small>
    {items.length || extra.length ? <ul>{[...new Map(items.map((item) => [item.nodeId, item])).values()].map((item) => {
      let text = item.nodeId; try { text = nodeLabel(nodeAt(document, item.path)); } catch { /* 文書の変更中 */ }
      return <li key={item.nodeId}><button type="button" className="e-small" disabled={disabled} onClick={() => select(item.path)}>{text}</button></li>;
    })}{extra.map((text) => <li key={text}><small>{text}</small></li>)}</ul> : <p className="e-help">まだ使われていません。</p>}</div>;
  const removal = (count: number, what: string, operation: EditorOperation) => confirm
    ? <div className="e-confirm" role="group" aria-label="削除の確認"><p>{count ? `使用中の ${count} か所は今の見た目のまま個別の指定に変わります。` : `この${what}を削除します。`}</p>
      <div className="e-actions"><button type="button" className="e-danger" disabled={disabled} onClick={() => { if (!run(operation)) { setOpen(null); setConfirm(false); } }}>削除する</button><button type="button" onClick={() => setConfirm(false)}>やめる</button></div></div>
    : <button type="button" className="e-danger e-small" disabled={disabled} onClick={() => setConfirm(true)}>この{what}を削除</button>;
  const nameField = (name: string, label: string | undefined, save: (label: string | undefined) => EditorOperation, off = disabled) =>
    <Field key={`${fieldKey}-${name}-label`} name="名前" value={label ?? ""} placeholder={name} fieldKey={`${fieldKey}-${name}-label`} pending={pending} disabled={off}
      apply={(value) => value.trim().length > 60 ? "名前は 60 文字以内で入力してください。" : apply(save(value.trim() ? value.trim() : undefined))} />;
  const tokenChoices = (kind: TokenKind): Choice[] => tokens.filter(([, token]) => token.type === kind).map(([key, token]) => [key, token.label ?? key]);

  function tokenEditor(name: string, token: DesignToken): ReactNode {
    const usage = tokenUsage(document, name), count = usage.nodes.length + usage.textStyles.length;
    const reason = readOnlyToken?.(name), fixed = disabled || !!reason;
    const update = (next: Partial<DesignToken>): EditorOperation => ({ type: "token", name, token: { ...token, ...next } as DesignToken });
    const label = (value: string | undefined): EditorOperation => { const { label: _label, ...rest } = token; return { type: "token", name, token: value ? { ...rest, label: value } : rest }; };
    return <div className="e-lib-edit">
      {reason && <p className="e-help">{reason}</p>}
      {nameField(name, token.label, label, fixed)}
      {token.type === "color" ? <ColorField key={`${fieldKey}-${name}-value`} caption="色" value={token.value} tokens={[]} fieldKey={`${fieldKey}-${name}-value`} pending={pending} disabled={fixed}
        apply={(value) => typeof value === "string" ? apply(update({ value })) : "色を入力してください。"} preview={preview && ((value) => preview(typeof value === "string" ? update({ value }) : null))} />
        : <>
          <SelectField caption="種類" value={token.type} options={kinds} disabled={fixed || count > 0} apply={(value) => typeof value === "string" ? apply(update({ type: value as TokenKind, value: value === "fontFamily" ? "sans-serif" : value === "number" ? 1 : 16 })) : undefined} />
          {count > 0 && !reason && <small className="e-help">使用中は種類を変えられません。</small>}
          <Field key={`${fieldKey}-${name}-value-${token.type}`} name="値" value={String(token.value)} fieldKey={`${fieldKey}-${name}-value`} pending={pending} disabled={fixed}
            apply={(value) => { const trimmed = value.trim(); return apply(update({ value: token.type !== "fontFamily" && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed) ? Number(trimmed) : trimmed })); }} />
        </>}
      {count > 0 && !reason && <p className="e-help e-reach">{count} か所に反映されます</p>}
      {usageList(usage.nodes, [...new Set(usage.textStyles.map((entry) => `テキストスタイル『${document.textStyles?.[entry.name]?.label ?? entry.name}』`))])}
      {selected && token.type === "color" && <div className="e-actions">
        <button type="button" className="e-small" disabled={disabled} onClick={() => run(paint("color", name))}>選択中の要素の文字色に適用</button>
        <button type="button" className="e-small" disabled={disabled} onClick={() => run(paint("backgroundColor", name))}>背景色に適用</button></div>}
      {!reason && removal(count, token.type === "color" ? "カラー" : "値", { type: "token", name, token: undefined })}
    </div>;
  }

  function textEditor(name: string, style: TextStyle): ReactNode {
    const users = textStyleUsage(document, name), tiers = editorTiers(document, breakpoints).filter((tier) => tier.key !== "base");
    const save = (mutate: (draft: TextStyle) => void): EditorOperation => {
      const draft = structuredClone(style); mutate(draft);
      if (draft.responsive) { draft.responsive = draft.responsive.filter((entry) => Object.keys(entry.declarations).length); if (!draft.responsive.length) delete draft.responsive; }
      return { type: "textStyle", name, style: draft };
    };
    const setBase = (property: TextStyleProperty, value: StyleValue | undefined) => save((draft) => { if (value === undefined) delete draft.base[property]; else draft.base[property] = value; });
    const setAt = (minWidth: number, property: TextStyleProperty, value: StyleValue | undefined) => save((draft) => {
      const responsive = draft.responsive ??= [];
      let entry = responsive.find((item) => item.minWidth === minWidth);
      if (!entry) { entry = { minWidth, declarations: {} }; responsive.push(entry); responsive.sort((a, b) => a.minWidth - b.minWidth); }
      const declarations: TextStyleDeclarations = entry.declarations;
      if (value === undefined) delete declarations[property]; else declarations[property] = value;
    });
    const unit = (property: TextStyleProperty, caption: string, options: { units: readonly string[]; numberUnit?: string; numberLabel?: string; keywords?: readonly Choice[]; kind: TokenKind }) =>
      <UnitField key={`${fieldKey}-${name}-${property}`} caption={caption} value={style.base[property]} units={options.units} numberUnit={options.numberUnit ?? "px"} numberLabel={options.numberLabel ?? "数値"} keywords={options.keywords ?? []}
        tokens={tokenChoices(options.kind)} fieldKey={`${fieldKey}-${name}-${property}`} pending={pending} disabled={disabled} apply={(value) => apply(setBase(property, value))}
        preview={preview && ((value) => preview(value === null ? null : setBase(property, value)))} />;
    const flag = (property: "fontStyle" | "textDecorationLine", text: string, on: string) =>
      <Toggle text={text} pressed={style.base[property] === on} disabled={disabled} onChange={(pressed) => run(setBase(property, pressed ? on : undefined))} />;
    const weight = style.base.fontWeight;
    return <div className="e-lib-edit">
      {nameField(name, style.label, (label) => save((draft) => { if (label) draft.label = label; else delete draft.label; }))}
      <FontField key={`${fieldKey}-${name}-fontFamily`} caption="フォント" value={style.base.fontFamily} fonts={fontChoices} tokens={tokenChoices("fontFamily")} fieldKey={`${fieldKey}-${name}-fontFamily`} pending={pending} disabled={disabled}
        apply={(value) => apply(setBase("fontFamily", value))} preview={preview && ((value) => preview(value === null ? null : setBase("fontFamily", value)))} />
      <div className="e-grid2">{unit("fontSize", "サイズ", { units: ["px", "rem", "em", "%", "vw"], kind: "length" })}
        <SelectField caption="太さ" value={weight === undefined ? undefined : typeof weight === "object" ? `@${weight.token}` : String(weight)} options={[...weightChoices, ...tokenChoices("number").map(([key, label]): Choice => [`@${key}`, `共通: ${label}`])]} disabled={disabled}
          parse={(value) => value.startsWith("@") ? { token: value.slice(1) } : /^\d+$/.test(value) ? Number(value) : value} apply={(value) => apply(setBase("fontWeight", value))} /></div>
      <div className="e-grid2">{unit("lineHeight", "行間", { units: ["", "px", "%", "rem", "em"], numberUnit: "", numberLabel: "倍", keywords: [["normal", "標準"]], kind: "number" })}
        {unit("letterSpacing", "字間", { units: ["px", "em", "rem"], kind: "length" })}</div>
      <div className="e-actions">{flag("fontStyle", "斜体", "italic")}{flag("textDecorationLine", "下線", "underline")}</div>
      {tiers.map((tier) => { const minWidth = tier.key as number, value = style.responsive?.find((entry) => entry.minWidth === minWidth)?.declarations.fontSize;
        return <UnitField key={`${fieldKey}-${name}-size-${minWidth}`} caption={`${tierName(tier)} のサイズ`} value={value} units={["px", "rem", "em", "%", "vw"]} tokens={tokenChoices("length")}
          placeholder={sizeText(style.base.fontSize, document)} fieldKey={`${fieldKey}-${name}-size-${minWidth}`} pending={pending} disabled={disabled}
          apply={(next) => apply(setAt(minWidth, "fontSize", next))} preview={preview && ((next) => preview(next === null ? null : setAt(minWidth, "fontSize", next)))} />; })}
      {users.length > 0 && <p className="e-help e-reach">{users.length} か所に反映されます</p>}
      {usageList(users)}
      {selected && <div className="e-actions"><button type="button" className="e-small" disabled={disabled || selected.style?.textStyle === name} onClick={() => run({ type: "nodeTextStyle", path: selection!, name })}>選択中の要素に適用</button></div>}
      {removal(users.length, "テキストスタイル", { type: "textStyle", name, style: undefined })}
    </div>;
  }

  const count = (name: string) => { const usage = tokenUsage(document, name); return usage.nodes.length + usage.textStyles.length; };
  const rows: [name: string, icon: ReactNode, title: string, detail: string, editor: () => ReactNode][] = tab === "color"
    ? colors.map(([name, token]) => [name, <i className="e-swatch-dot e-lib-swatch" style={{ background: String(token.value) }} aria-hidden="true" />, token.label ?? name,
      `${colorParts(String(token.value)) ? formatColor(token.value) : String(token.value)} · ${count(name)} か所`, () => tokenEditor(name, token)])
    : tab === "text" ? styles.map(([name, style]) => { const weight = resolveValue(document, style.base.fontWeight), family = resolveValue(document, style.base.fontFamily);
      return [name, <b className="e-aa" style={{ ...(weight === undefined ? {} : { fontWeight: weight }), ...(typeof family === "string" ? { fontFamily: family } : {}) }} aria-hidden="true">Aa</b>, style.label ?? name,
        `${sizeText(style.base.fontSize, document)} · ${textStyleUsage(document, name).length} か所`, () => textEditor(name, style)]; })
    : others.map(([name, token]) => [name, <b className="e-aa" aria-hidden="true">{token.type === "length" ? "↔" : token.type === "fontFamily" ? "F" : "#"}</b>, token.label ?? name,
      `${typeof token.value === "number" && token.type === "length" ? `${token.value}px` : String(token.value)} · ${count(name)} か所`, () => tokenEditor(name, token)]);
  const [, , heading, add] = tabs.find(([value]) => value === tab)!;
  return <div className="e-library">
    <div className="e-seg e-tabs" role="group" aria-label="スタイルの種類">{tabs.map(([value, text]) =>
      <button type="button" key={value} aria-pressed={tab === value} onClick={() => choose(value)}>{text}</button>)}</div>
    <div className="e-lib-title"><h3>{heading}</h3><button type="button" className="e-add" aria-label={add} title={add} disabled={disabled} onClick={create}>＋</button></div>
    {problem && <p className="e-help e-problem" role="alert">{problem}</p>}
    {rows.length ? <ul className="e-lib-list">{rows.map(([name, icon, title, detail, editor]) => <li key={name}>
      <button type="button" className="e-lib-row" aria-expanded={open === name} onClick={() => toggle(name)}>{icon}<span className="e-lib-text"><span className="e-lib-name">{title}</span><small>{scopeLabel ?? origins?.[`${tab === "text" ? "textStyle" : "token"}:${name}`]}{(scopeLabel || origins) && " · "}{detail}</small></span></button>
      {open === name && <>{editor()}{onPromote && canPromote?.(tab === "text" ? "textStyle" : "token", name) && <button type="button" className="e-small" disabled={disabled} onClick={() => onPromote(tab === "text" ? "textStyle" : "token", name)}>サイト共通へ移す</button>}</>}
    </li>)}</ul> : <p className="e-help">{tab === "color" ? "共通カラーはまだありません。＋で追加すると、複数の要素で同じ色を使えます。" : tab === "text" ? "テキストスタイルはまだありません。＋で追加すると、見出しや本文の文字の見た目をそろえられます。" : "共通の長さ・フォント・数値はまだありません。"}</p>}
  </div>;
}
