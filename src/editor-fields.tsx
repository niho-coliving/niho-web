"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { colorParts, splitLength, withAlpha } from "./style-model.js";
import type { StyleValue } from "./types.js";

/** 編集 UI の共通部品。値は確定時だけ apply し、無効なら入力を残して理由を表示する。 */
export type Pending = (key: string, value: boolean) => void;
export type Choice = readonly [value: string, label: string];
type Apply = (value: StyleValue | undefined) => string | undefined;
type Draft = ((value: StyleValue | undefined | null) => void) | undefined;
const noop: Pending = () => undefined;
const keep = (event: React.MouseEvent) => event.preventDefault();
const enter = (commit: () => void) => (event: React.KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); commit(); } };
const numeric = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
export const fontChoices: readonly Choice[] = [["sans-serif", "ゴシック体"], ["serif", "明朝体"], ["monospace", "等幅"]];
export const weightChoices: readonly Choice[] = [["300", "細い"], ["400", "標準"], ["500", "やや太い"], ["700", "太い"], ["900", "最も太い"]];

export function useBuffer(value: string, apply: (value: string) => string | undefined, pending: Pending, fieldKey: string, disabled: boolean, draft?: (value: string | null) => void, settle = false) {
  const [buffer, setBuffer] = useState(value), [error, setError] = useState(""), [settled, setSettled] = useState(0);
  // settle: 確定後は保存された値の表示（例: 16px → 16）へそろえる。
  useEffect(() => { setBuffer(value); setError(""); pending(fieldKey, false); }, [value, fieldKey, pending, settled]);
  useEffect(() => () => pending(fieldKey, false), [fieldKey, pending]);
  return {
    buffer, error, setError, dirty: buffer !== value,
    change(next: string) { setBuffer(next); setError(""); pending(fieldKey, next !== value); draft?.(next === value ? null : next); },
    commit() {
      if (buffer === value || disabled) return;
      const problem = apply(buffer); setError(problem ?? ""); pending(fieldKey, !!problem);
      if (!problem && settle) setSettled((count) => count + 1);
    },
    cancel() { setBuffer(value); setError(""); pending(fieldKey, false); draft?.(null); }
  };
}
type Buffer = ReturnType<typeof useBuffer>;
function Problems({ states, problem = "" }: { states: readonly Buffer[]; problem?: string }) {
  const error = states.find((state) => state.error)?.error || problem, dirty = states.filter((state) => state.dirty);
  return <>{error && <small className="e-help e-problem" role="alert">{error}</small>}
    {dirty.length > 0 && <button className="e-small" type="button" onMouseDown={keep} onClick={() => dirty.forEach((state) => state.cancel())}>入力を取り消す</button>}</>;
}
function inputProps(state: Buffer, id: string | undefined, disabled: boolean, placeholder: string | undefined, describedBy?: string) {
  return { id, value: state.buffer, disabled, placeholder, "aria-invalid": !!state.error, "aria-describedby": describedBy, spellCheck: false,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => state.change(event.target.value), onBlur: state.commit, onKeyDown: enter(state.commit) };
}
/** 入力と単位などを 1 つの枠にまとめる。入力途中は破線、無効値は赤の枠。 */
function Frame({ states, className = "", children }: { states: readonly Buffer[]; className?: string; children: ReactNode }) {
  return <span className={`e-frame ${className}`} data-pending={states.some((state) => state.dirty) || undefined} data-invalid={states.some((state) => state.error) || undefined}>{children}</span>;
}

export function Field({ name, value, apply, pending, fieldKey, disabled = false, reason, multiline = false, placeholder, hint }: {
  name: string; value: string; apply: (value: string) => string | undefined; pending: Pending; fieldKey: string;
  disabled?: boolean; reason?: string | undefined; multiline?: boolean; placeholder?: string | undefined; hint?: ((value: string) => ReactNode) | undefined;
}) {
  const inputId = useId(), state = useBuffer(value, apply, pending, fieldKey, disabled || !!reason);
  const props = { id: inputId, value: state.buffer, disabled: disabled || !!reason, placeholder, "aria-invalid": !!state.error,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => state.change(event.target.value), onBlur: state.commit };
  return <label className="e-field" htmlFor={inputId}><span>{name}</span>
    {multiline ? <textarea {...props} /> : <input {...props} onKeyDown={enter(state.commit)} />}
    {hint && <small className="e-help">{hint(state.buffer)}</small>}
    {reason && <small className="e-help">ロック: {reason}</small>}
    <Problems states={[state]} />
  </label>;
}

/** 段の状態（この段で指定・継承・上の段で上書き・保存前）。ヒントは 1 行の短文、詳しい文は title と読み上げ用。 */
export type RowStatus = {
  own?: boolean; reset?: (() => void) | undefined; unsaved?: boolean; lock?: string | undefined;
  inherited?: string | undefined; inheritedTitle?: string | undefined; overridden?: string | undefined; overriddenTitle?: string | undefined;
};
export const hasHint = (status: RowStatus | undefined) => !!status && (!!status.inherited || !!status.overridden);
/** 最初の span が項目名。主入力は htmlFor で指し、ヒントは hintId を aria-describedby で参照する。 */
export function Row({ caption, htmlFor, hintId, status, group = false, extra, children }: {
  caption: string; htmlFor?: string | undefined; hintId?: string | undefined; status?: RowStatus | undefined; group?: boolean; extra?: ReactNode; children: ReactNode;
}) {
  const captionId = useId(), ownHint = useId(), hint = hintId ?? ownHint;
  const short = [status?.inherited, status?.overridden].filter(Boolean).join(" · ");
  const long = [status?.inheritedTitle ?? status?.inherited, status?.overriddenTitle ?? status?.overridden].filter(Boolean).join("。");
  const body = <>
    <span className="e-cap" id={captionId} title={caption}>{caption}</span>
    {status?.unsaved && <><i className="e-dot" title="保存前の変更" aria-hidden="true" /><em className="e-vh">保存前</em></>}
    {status?.own && status.reset && !status.lock && <button type="button" className="e-reset" aria-label={`${caption}のこの幅の指定を解除`} title="この幅の指定を解除" onMouseDown={keep} onClick={status.reset}>↺</button>}
    {extra}
    <span className="e-control">{children}</span>
    {status?.lock && <small className="e-help">ロック: {status.lock}</small>}
    {short && <small className="e-hint" id={hint} title={long}><em aria-hidden="true">{short}</em><em className="e-vh">{long}</em></small>}
  </>;
  const className = `e-field e-row${status?.own ? " e-own" : ""}`;
  return group ? <div className={className} role="group" aria-labelledby={captionId} aria-describedby={short ? hint : undefined}>{body}</div>
    : <label className={className} htmlFor={htmlFor}>{body}</label>;
}

type Common = { caption: string; apply: Apply; preview?: Draft; pending?: Pending; fieldKey: string; disabled?: boolean; status?: RowStatus | undefined; placeholder?: string | undefined; extra?: ReactNode };
const parseText = (input: string): StyleValue | undefined => {
  const value = input.trim();
  return !value ? undefined : value.startsWith("@") ? { token: value.slice(1) } : value;
};

export type ColorChoice = { name: string; label: string; value: string };
/** 見本・HEX・不透明度を 1 つの枠に。見本から共通カラーと色の選択を開く。token 参照中は名前と「切り離す」。 */
export function ColorField({ caption, value, tokens, apply, preview, pending = noop, fieldKey, disabled = false, status, placeholder, extra, none, inherited }: Common & {
  value: StyleValue | undefined; tokens: readonly ColorChoice[]; none?: { value: StyleValue | undefined } | undefined;
  /** 継承している色（CSS の色）。指定が無いときに見本を薄く表示する。 */
  inherited?: string | undefined;
}) {
  const id = useId(), hintId = useId(), [open, setOpen] = useState(false), picker = useRef<HTMLInputElement>(null), live = useRef<string | null>(null);
  const token = typeof value === "object" ? tokens.find((choice) => choice.name === value.token) : undefined;
  const text = value === undefined ? "" : typeof value === "object" ? token?.value ?? `@${value.token}` : String(value);
  const parts = colorParts(text), base = parts ?? (value === undefined && inherited ? colorParts(inherited) : undefined);
  const hex = useBuffer(text, (input) => apply(parseText(input)), pending, `${fieldKey}-hex`, disabled, preview && ((input) => preview(input === null ? null : parseText(input))), true);
  const percent = (input: string) => Number(input.trim());
  const alpha = useBuffer(parts ? String(parts.alpha) : "", (input) => {
    const amount = percent(input);
    if (!parts || !input.trim() || !Number.isFinite(amount) || amount < 0 || amount > 100) return "不透明度は 0〜100 の数値で入力してください。";
    return apply(withAlpha(parts.hex, Math.round(amount)));
  }, pending, `${fieldKey}-alpha`, disabled || !parts || !!token, preview && ((input) => {
    const amount = input === null ? NaN : percent(input);
    preview(parts && Number.isFinite(amount) && amount >= 0 && amount <= 100 ? withAlpha(parts.hex, Math.round(amount)) : null);
  }), true);
  const [problem, setProblem] = useState("");
  const report = (error: string | undefined) => { setProblem(error ?? ""); return error; };
  function close() {
    setOpen(false);
    if (live.current && live.current !== parts?.hex) report(apply(withAlpha(live.current, parts?.alpha ?? 100)));
    else preview?.(null);
    live.current = null;
  }
  useEffect(() => {
    const input = picker.current;
    if (!input) return;
    const commit = () => { live.current = null; report(apply(withAlpha(input.value, parts?.alpha ?? 100))); };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  });
  const swatch = value !== undefined ? text : inherited;
  return <Row caption={caption} htmlFor={id} hintId={hintId} status={status} extra={extra}>
    <Frame states={[hex, alpha]} className="e-color">
      <button type="button" className={`e-swatch${swatch ? value === undefined ? " e-inherited" : "" : " e-none"}`} style={swatch ? { background: swatch } : undefined}
        aria-label={`${caption}の候補を開く`} aria-expanded={open} disabled={disabled} onClick={() => open ? close() : setOpen(true)} />
      <input {...inputProps(hex, id, disabled, placeholder, hasHint(status) ? hintId : undefined)} />
      <input {...inputProps(alpha, undefined, disabled || !parts || !!token, parts ? undefined : value === undefined && inherited ? String(colorParts(inherited)?.alpha ?? "") : "—")} className="e-alpha" inputMode="numeric" aria-label={`${caption}の不透明度（%）`} />
      <small aria-hidden="true">%</small>
    </Frame>
    {typeof value === "object" && <span className="e-chip"><i className="e-swatch-dot" style={token ? { background: token.value } : undefined} aria-hidden="true" />{token?.label ?? value.token}
      <button type="button" className="e-small" disabled={disabled || !token} onClick={() => token && report(apply(token.value))}>切り離す</button></span>}
    {open && <span className="e-pop" role="group" aria-label={`${caption}の候補`}>
      {tokens.length > 0 && <><small className="e-help">共通カラー</small><span className="e-pop-tokens">{tokens.map((choice) =>
        <button type="button" key={choice.name} className="e-token" aria-pressed={token?.name === choice.name} onClick={() => { setOpen(false); report(apply({ token: choice.name })); }}>
          <i className="e-swatch-dot" style={{ background: choice.value }} aria-hidden="true" />{choice.label}</button>)}</span></>}
      <span className="e-pop-row">
        <input ref={picker} key={base?.hex ?? "none"} type="color" defaultValue={base?.hex ?? "#000000"} aria-label={`${caption}を選ぶ`}
          onInput={(event) => { live.current = event.currentTarget.value; preview?.(withAlpha(event.currentTarget.value, parts?.alpha ?? 100)); }} />
        {none && <button type="button" className="e-small" onClick={() => { setOpen(false); report(apply(none.value)); }}>なし</button>}
        <button type="button" className="e-small" onClick={close}>閉じる</button>
      </span>
    </span>}
    <Problems states={[hex, alpha]} problem={problem} />
  </Row>;
}

/** 数値＋単位、キーワード（日本語名）、共通の値を 1 つの枠で扱う。px のプロパティの数値は数値のまま保存する。 */
export function UnitField({ caption, value, units, numberUnit = "px", numberLabel = "数値", keywords = [], tokens = [], apply, preview, pending = noop, fieldKey, disabled = false, status, placeholder, extra }: Common & {
  value: StyleValue | undefined; units: readonly string[]; numberUnit?: string; numberLabel?: string; keywords?: readonly Choice[]; tokens?: readonly Choice[];
}) {
  const id = useId(), hintId = useId(), [chosen, setChosen] = useState<string>(), [problem, setProblem] = useState("");
  const valueKey = JSON.stringify(value ?? null);
  useEffect(() => { setChosen(undefined); setProblem(""); }, [valueKey]);
  const parts = value === undefined ? undefined : splitLength(value, numberUnit);
  const keyword = parts && "keyword" in parts && keywords.some(([name]) => name === parts.keyword) ? parts.keyword : undefined;
  const text = !parts || "token" in parts || keyword ? "" : "number" in parts && units.length ? String(parts.number) : String(value);
  const selected = chosen !== undefined && !(parts && "number" in parts) ? `u:${chosen}` : parts && "token" in parts ? `t:${parts.token}` : keyword ? `k:${keyword}` : parts && "number" in parts && units.length ? `u:${parts.unit}` : parts ? "raw" : `u:${chosen ?? numberUnit}`;
  const unit = chosen ?? (selected.startsWith("u:") ? selected.slice(2) : numberUnit);
  function parse(input: string): StyleValue | undefined {
    const trimmed = input.trim();
    if (units.length && numeric.test(trimmed)) return unit === numberUnit ? Number(trimmed) : `${trimmed}${unit}`;
    const px = numberUnit === "px" && units.length ? /^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/.exec(trimmed) : null;
    return px ? Number(px[1]) : parseText(trimmed);
  }
  const state = useBuffer(text, (input) => apply(parse(input)), pending, fieldKey, disabled, preview && ((input) => preview(input === null ? null : parse(input))), true);
  function choose(next: string) {
    setProblem("");
    if (next.startsWith("k:")) setProblem(apply(next.slice(2)) ?? "");
    else if (next.startsWith("t:")) setProblem(apply({ token: next.slice(2) }) ?? "");
    else if (next.startsWith("u:")) {
      const nextUnit = next.slice(2), number = parts && "number" in parts ? parts.number : numeric.test(state.buffer.trim()) ? Number(state.buffer.trim()) : undefined;
      setChosen(nextUnit);
      if (number !== undefined) setProblem(apply(nextUnit === numberUnit ? number : `${number}${nextUnit}`) ?? "");
    }
  }
  const unitOptions = [...units, ...(parts && "number" in parts && units.length && !units.includes(parts.unit) ? [parts.unit] : [])];
  const showSelect = unitOptions.length > 1 || keywords.length > 0 || tokens.length > 0;
  const keywordLabel = keyword && keywords.find(([name]) => name === keyword)?.[1];
  return <Row caption={caption} htmlFor={id} hintId={hintId} status={status} extra={extra}>
    <Frame states={[state]} className="e-unit">
      <input {...inputProps(state, id, disabled, keywordLabel || (parts && "token" in parts ? tokens.find(([name]) => name === parts.token)?.[1] ?? parts.token : placeholder), hasHint(status) ? hintId : undefined)} />
      {showSelect && <select aria-label={`${caption}の単位`} value={selected} disabled={disabled} onChange={(event) => choose(event.target.value)}>
        {selected === "raw" && <option value="raw">—</option>}
        {unitOptions.map((name) => <option key={name} value={`u:${name}`}>{name || numberLabel}</option>)}
        {keywords.map(([name, label]) => <option key={name} value={`k:${name}`}>{label}</option>)}
        {tokens.map(([name, label]) => <option key={name} value={`t:${name}`}>共通: {label}</option>)}
        {parts && "token" in parts && !tokens.some(([name]) => name === parts.token) && <option value={selected}>共通: {parts.token}</option>}
      </select>}
    </Frame>
    <Problems states={[state]} problem={problem} />
  </Row>;
}

/** 選択肢から選ぶ値。value は CSS の値か `@名前`、表示名は日本語。継承値はヒントに出す。 */
export function SelectField({ caption, value, options, apply, disabled = false, status, parse = parseText, extra }: Omit<Common, "fieldKey" | "preview" | "pending"> & {
  value: string | undefined; options: readonly Choice[]; parse?: (value: string) => StyleValue | undefined;
}) {
  const id = useId(), hintId = useId(), [problem, setProblem] = useState("");
  return <Row caption={caption} htmlFor={id} hintId={hintId} status={status} extra={extra}>
    <select id={id} aria-label={caption} aria-describedby={hasHint(status) ? hintId : undefined} value={value ?? ""} disabled={disabled} onChange={(event) => setProblem(apply(event.target.value ? parse(event.target.value) : undefined) ?? "")}>
      <option value="">指定なし</option>
      {options.map(([name, label]) => <option key={name} value={name}>{label}</option>)}
      {value && !options.some(([name]) => name === value) && <option value={value}>{value}</option>}
    </select>
    {problem && <small className="e-help e-problem" role="alert">{problem}</small>}
  </Row>;
}

/** フォント: 指定なし・よく使う書体・共通のフォント・その他（文字で入力）を 1 つの select で選ぶ。 */
export function FontField({ caption, value, fonts, tokens, apply, preview, pending = noop, fieldKey, disabled = false, status, placeholder }: Common & {
  value: StyleValue | undefined; fonts: readonly Choice[]; tokens: readonly Choice[];
}) {
  const id = useId(), hintId = useId(), [other, setOther] = useState(false), [problem, setProblem] = useState("");
  const known = typeof value === "object" ? `t:${value.token}` : value !== undefined && fonts.some(([name]) => name === String(value)) ? `k:${value}` : undefined;
  const custom = value !== undefined && !known, selected = known ?? (custom || other ? "other" : "");
  useEffect(() => setOther(false), [JSON.stringify(value ?? null)]);
  const state = useBuffer(custom ? String(value) : "", (input) => apply(parseText(input)), pending, fieldKey, disabled, preview && ((input) => preview(input === null ? null : parseText(input))), true);
  function choose(next: string) {
    setProblem(""); setOther(next === "other");
    if (next === "") setProblem(apply(undefined) ?? "");
    else if (next.startsWith("k:")) setProblem(apply(next.slice(2)) ?? "");
    else if (next.startsWith("t:")) setProblem(apply({ token: next.slice(2) }) ?? "");
  }
  return <Row caption={caption} htmlFor={id} hintId={hintId} status={status}>
    <select id={id} aria-label={caption} aria-describedby={hasHint(status) ? hintId : undefined} value={selected} disabled={disabled} onChange={(event) => choose(event.target.value)}>
      <option value="">指定なし</option>
      {fonts.map(([name, label]) => <option key={name} value={`k:${name}`}>{label}</option>)}
      {tokens.map(([name, label]) => <option key={name} value={`t:${name}`}>共通: {label}</option>)}
      {typeof value === "object" && !tokens.some(([name]) => name === value.token) && <option value={`t:${value.token}`}>共通: {value.token}</option>}
      <option value="other">その他…</option>
    </select>
    {selected === "other" && <Frame states={[state]} className="e-unit"><input {...inputProps(state, undefined, disabled, placeholder ?? "例: Noto Sans JP, sans-serif")} aria-label={`${caption}の名前`} /></Frame>}
    <Problems states={[state]} problem={problem} />
  </Row>;
}

/** 0〜1 の値を % の数値とスライダーで編集する。スライダーは操作中にプレビューし、離したときに確定する。 */
export function PercentField({ caption, value, apply, preview, pending = noop, fieldKey, disabled = false, status, placeholder }: Common & { value: StyleValue | undefined }) {
  const id = useId(), hintId = useId(), [range, setRange] = useState<number | null>(null);
  const text = typeof value === "number" ? String(Math.round(value * 100)) : typeof value === "object" ? `@${value.token}` : value ?? "";
  const parse = (input: string): StyleValue | undefined | string => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.startsWith("@")) return parseText(trimmed);
    const amount = Number(trimmed);
    return numeric.test(trimmed) && amount >= 0 && amount <= 100 ? Math.round(amount) / 100 : "invalid";
  };
  const state = useBuffer(text, (input) => { const next = parse(input); return next === "invalid" ? "0〜100 の数値で入力してください。" : apply(next); }, pending, fieldKey, disabled,
    preview && ((input) => { const next = input === null ? null : parse(input); preview(next === "invalid" ? null : next); }), true);
  function release() { if (range === null) return; const next = range / 100; setRange(null); state.setError(apply(next) ?? ""); }
  return <Row caption={caption} htmlFor={id} hintId={hintId} status={status}>
    <span className="e-percent">
      <Frame states={[state]} className="e-unit e-narrow"><input {...inputProps(state, id, disabled, placeholder, hasHint(status) ? hintId : undefined)} inputMode="numeric" /><small aria-hidden="true">%</small></Frame>
      <input type="range" min={0} max={100} step={1} aria-label={`${caption}のスライダー`} disabled={disabled} value={range ?? (typeof value === "number" ? Math.round(value * 100) : Number(placeholder) || 100)}
        onChange={(event) => { const next = Number(event.target.value); setRange(next); preview?.(next / 100); }} onPointerUp={release} onKeyUp={release} onBlur={release} />
    </span>
    <Problems states={[state]} />
  </Row>;
}

/** − 入力 + の数値。 */
export function Stepper({ caption, value, apply, preview, pending = noop, fieldKey, disabled = false, status, placeholder }: Common & { value: StyleValue | undefined }) {
  const id = useId(), hintId = useId(), [problem, setProblem] = useState("");
  const text = value === undefined ? "" : typeof value === "object" ? `@${value.token}` : String(value);
  const parse = (input: string) => numeric.test(input.trim()) ? Number(input.trim()) : parseText(input);
  const state = useBuffer(text, (input) => apply(parse(input)), pending, fieldKey, disabled, preview && ((input) => preview(input === null ? null : parse(input))), true);
  const current = typeof value === "number" ? value : Number(placeholder) || 0;
  const step = (delta: number) => setProblem(apply(current + delta) ?? "");
  return <Row caption={caption} htmlFor={id} hintId={hintId} status={status}>
    <Frame states={[state]} className="e-stepper">
      <button type="button" aria-label={`${caption}を 1 下げる`} disabled={disabled} onClick={() => step(-1)}>−</button>
      <input {...inputProps(state, id, disabled, placeholder, hasHint(status) ? hintId : undefined)} inputMode="numeric" />
      <button type="button" aria-label={`${caption}を 1 上げる`} disabled={disabled} onClick={() => step(1)}>＋</button>
    </Frame>
    <Problems states={[state]} problem={problem} />
  </Row>;
}

export type SegmentOption<T extends string> = { value: T; text: string; icon?: string };
export function Segmented<T extends string>({ label, options, value, onChange, disabled = false, className = "" }: {
  label: string; options: readonly SegmentOption<T>[]; value: T | undefined; onChange: (value: T) => void; disabled?: boolean; className?: string;
}) {
  return <div className={`e-seg ${className}`} role="group" aria-label={label}>{options.map((option) => <button type="button" key={option.value} aria-pressed={value === option.value} disabled={disabled}
    onClick={() => onChange(option.value)} title={option.text} {...(option.icon ? { "aria-label": option.text } : {})}>{option.icon ?? option.text}</button>)}</div>;
}

export type Align = "start" | "center" | "end";
const alignNames: Record<string, string> = { "start start": "左上", "center start": "上中央", "end start": "右上", "start center": "左中央", "center center": "中央", "end center": "右中央", "start end": "左下", "center end": "下中央", "end end": "右下" };
/** 3×3 の揃え。x は左→右、y は上→下。 */
export function AlignGrid({ label, value, onChange, disabled = false }: { label: string; value: readonly [Align | undefined, Align | undefined] | undefined; onChange: (x: Align, y: Align) => void; disabled?: boolean }) {
  const axis: Align[] = ["start", "center", "end"];
  return <div className="e-align" role="group" aria-label={label}>{axis.flatMap((y) => axis.map((x) => <button type="button" key={`${x}-${y}`} aria-label={`${alignNames[`${x} ${y}`]}に揃える`} title={`${alignNames[`${x} ${y}`]}に揃える`}
    aria-pressed={value?.[0] === x && value[1] === y} disabled={disabled} onClick={() => onChange(x, y)}><i aria-hidden="true" /></button>))}</div>;
}

export function Toggle({ text, pressed, onChange, disabled = false, icon }: { text: string; pressed: boolean; onChange: (pressed: boolean) => void; disabled?: boolean; icon?: string }) {
  return <button type="button" className="e-toggle" aria-pressed={pressed} disabled={disabled} onClick={() => onChange(!pressed)}>{icon && <b aria-hidden="true">{icon}</b>}{text}</button>;
}

/** 折りたたみ。中身は閉じていても DOM に残す（入力途中の値を失わない）。 */
export function Collapse({ title, initial = false, children }: { title: string; initial?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return <details className="e-more" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{title}</summary>{children}</details>;
}
