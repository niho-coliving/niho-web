import type { Appear, AppearEffect, BackgroundImageValue, DesignToken, HiddenRange, MotionEasing, NodeStyle, StateDeclarations, StateName, StateProperty, StyleDeclarations, StyleProperty, StyleValue, TextStyle, TextStyleDeclarations, TextStyleProperty, TokenKind } from "./types.js";
import { fail, identifier, keys, parseAssetReference, record } from "./validation-utils.js";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100000;
// 表示を壊す過大値を拒否する。上限は単位ごと（負値は絶対値）。
const lengthLimits: Record<string, number> = { px: 10000, rem: 1000, em: 1000, ch: 1000, "%": 1000, vh: 1000, vw: 1000, vmin: 1000, vmax: 1000 };
const length = (v: string) => {
  const match = /^(?:0|-?(\d+(?:\.\d+)?|\.\d+)(px|rem|em|%|vh|vw|vmin|vmax|ch))$/.exec(v);
  return !!match && (v === "0" || Number(match[1]) <= lengthLimits[match[2]!]!);
};
// 固定値の percent - px だけを dimension の calc として許可する。任意の CSS
// 関数や変数は通さず、STUDIO の安全な幅変換で必要な式だけを保持する。
const calculatedDimension = (v: string) => {
  const match = /^calc\(\s*(\d+(?:\.\d+)?|\.\d+)%\s+([+-])\s+(\d+(?:\.\d+)?|\.\d+)px\s*\)$/.exec(v);
  return !!match && Number(match[1]) <= 1000 && Number(match[3]) <= lengthLimits.px!;
};
const positiveLength = (v: string) => length(v) && !v.startsWith("-");
const color = (v: string) => /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|transparent|currentColor|black|white|red|green|blue|gray|grey|navy|teal|orange|purple|yellow|rebeccapurple)$/i.test(v);
const fontFamily = (v: string) => /^[A-Za-z][A-Za-z0-9 -]*(?:,\s*[A-Za-z][A-Za-z0-9 -]*)*$/.test(v);
const oneOf = (...values: string[]) => (v: string) => values.includes(v);
const shorthand = (v: string, negative = false, auto = false) => {
  const parts = v.split(/\s+/);
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => (auto && p === "auto") || (negative ? length(p) : positiveLength(p)));
};

// 限定した Grid 文法。関数・文字列・任意 CSS を通さない。
function splitOutside(value: string, delimiter: "space" | "comma"): string[] {
  let depth = 0, start = 0;
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (depth < 0 || depth > 4) return [];
    if (depth === 0 && (delimiter === "comma" ? value[i] === "," : value[i] === " ")) {
      if (value.slice(start, i).trim()) parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth) return [];
  if (value.slice(start).trim()) parts.push(value.slice(start).trim());
  return parts;
}
function track(value: string, depth = 0): boolean {
  if (depth > 3) return false;
  if (positiveLength(value) || /^(?:\d+(?:\.\d+)?)fr$/.test(value) || ["auto", "min-content", "max-content"].includes(value)) return true;
  if (value.startsWith("minmax(") && value.endsWith(")")) {
    const args = splitOutside(value.slice(7, -1), "comma");
    return args.length === 2 && args.every((v) => track(v, depth + 1));
  }
  return false;
}
function grid(value: string): boolean {
  if (value === "none") return true;
  const parts = splitOutside(value, "space");
  return parts.length > 0 && parts.length <= 12 && parts.every((part) => {
    if (track(part)) return true;
    if (!part.startsWith("repeat(") || !part.endsWith(")")) return false;
    const args = splitOutside(part.slice(7, -1), "comma");
    return args.length === 2 && /^(?:[1-9]|[1-9]\d|auto-fit|auto-fill)$/.test(args[0]!) && track(args[1]!);
  });
}

// 変形・遷移。関数や任意の文字列は通さない。
const translateLimits: Record<string, number> = { px: 1000, rem: 64, em: 64, ch: 64, "%": 100, vh: 100, vw: 100, vmin: 100, vmax: 100 };
const translatePart = (v: string) => {
  const match = /^(?:0|-?(\d+(?:\.\d+)?|\.\d+)(px|rem|em|%|vh|vw|vmin|vmax|ch))$/.exec(v);
  return !!match && (v === "0" || Number(match[1]) <= translateLimits[match[2]!]!);
};
const pair = (v: string, part: (value: string) => boolean) => { const parts = v.split(" "); return parts.length <= 2 && parts.every(part); };
const scalePart = (v: string) => /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(v) && Number(v) <= 5;
const skewPart = (v: string) => { const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))deg$/.exec(v); return !!match && Math.abs(Number(match[1])) <= 180; };
const time = (v: string) => { const match = /^(\d+(?:\.\d+)?|\.\d+)(s|ms)$/.exec(v); return !!match && Number(match[1]) * (match[2] === "s" ? 1000 : 1) <= 5000; };
const shadow = (v: string) => {
  if (v === "none") return true;
  const colorValue = String.raw`(?:#[\da-fA-F]{3,8}|(?:rgb|rgba)\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?\)|black|white|transparent|currentColor)`;
  const distance = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)`;
  const match = new RegExp(`^${colorValue} (${distance})(?: (${distance})){1,3}(?: inset)?$`).exec(v);
  if (!match) return false;
  return [...v.matchAll(new RegExp(distance, "g"))].every((part) => Math.abs(Number.parseFloat(part[0])) <= 10000);
};
const backgroundFilter = (value: string) => {
  if (value === "none") return true;
  const parts = value.match(/(?:grayscale|sepia|saturate|brightness)\((?:\d+(?:\.\d+)?|\.\d+)%?\)/g);
  if (!parts || parts.join(" ") !== value || parts.length > 3) return false;
  const names = new Set<string>();
  return parts.every((part) => {
    const match = /^(grayscale|sepia|saturate|brightness)\((\d+(?:\.\d+)?|\.\d+)(%)?\)$/.exec(part)!;
    if (names.has(match[1]!)) return false;
    names.add(match[1]!);
    const number = Number(match[2]), normalized = match[3] ? number / 100 : number;
    return normalized <= (match[1] === "saturate" || match[1] === "brightness" ? 2 : 1);
  });
};
export const easings: readonly MotionEasing[] = ["ease", "ease-in", "ease-out", "ease-in-out", "linear"];
export const origins = ["left top", "center top", "right top", "left center", "center", "right center", "left bottom", "center bottom", "right bottom"] as const;

/** unit: 数値だけの指定に付ける単位（px は px フラグ）。 */
type PropertySpec = { kind?: TokenKind; px?: boolean; unit?: "deg" | "ms"; valid: (value: string) => boolean };
const dimension: PropertySpec = { kind: "length", px: true, valid: (v) => positiveLength(v) || ["auto", "min-content", "max-content", "fit-content", "none"].includes(v) };
const dimensionWithCalc: PropertySpec = { ...dimension, valid: (v) => dimension.valid(v) || calculatedDimension(v) };
const offset: PropertySpec = { kind: "length", px: true, valid: (v) => length(v) || v === "auto" };
const nonnegative: PropertySpec = { kind: "length", px: true, valid: positiveLength };
const margin: PropertySpec = { kind: "length", px: true, valid: (v) => shorthand(v, true, true) };
const padding: PropertySpec = { kind: "length", px: true, valid: (v) => shorthand(v) };
const unitNumber = (v: string) => /^\d+(?:\.\d+)?$/.test(v) && Number(v) <= 1000;
const specs: Record<StyleProperty, PropertySpec> = {
  color: { kind: "color", valid: color }, backgroundColor: { kind: "color", valid: color }, borderColor: { kind: "color", valid: color },
  fontFamily: { kind: "fontFamily", valid: fontFamily }, fontSize: nonnegative,
  fontWeight: { kind: "number", valid: (v) => ["normal", "bold"].includes(v) || /^\d+$/.test(v) && +v >= 1 && +v <= 1000 },
  lineHeight: { kind: "number", valid: (v) => v === "normal" || positiveLength(v) || unitNumber(v) },
  letterSpacing: { kind: "length", px: true, valid: (v) => length(v) || v === "normal" },
  wordSpacing: { kind: "length", px: true, valid: (v) => length(v) || v === "normal" },
  fontVariantEastAsian: { valid: oneOf("normal", "proportional-width") }, textAlign: { valid: oneOf("left", "right", "center", "start", "end", "justify") },
  width: dimensionWithCalc, height: dimensionWithCalc, minWidth: dimensionWithCalc, maxWidth: dimensionWithCalc, minHeight: dimension, maxHeight: dimension,
  margin, marginTop: offset, marginRight: offset, marginBottom: offset, marginLeft: offset,
  padding, paddingTop: nonnegative, paddingRight: nonnegative, paddingBottom: nonnegative, paddingLeft: nonnegative,
  display: { valid: oneOf("block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "none") },
  flexDirection: { valid: oneOf("row", "row-reverse", "column", "column-reverse") },
  flexWrap: { valid: oneOf("nowrap", "wrap", "wrap-reverse") },
  justifyContent: { valid: oneOf("start", "end", "center", "flex-start", "flex-end", "space-between", "space-around", "space-evenly") },
  alignItems: { valid: oneOf("start", "end", "center", "stretch", "baseline", "flex-start", "flex-end") },
  alignSelf: { valid: oneOf("auto", "start", "end", "center", "stretch", "baseline", "flex-start", "flex-end") },
  alignContent: { valid: oneOf("normal", "start", "end", "center", "stretch", "flex-start", "flex-end", "space-between", "space-around", "space-evenly") },
  flexGrow: { kind: "number", valid: unitNumber }, flexShrink: { kind: "number", valid: unitNumber }, flexBasis: dimension,
  gap: nonnegative, rowGap: nonnegative, columnGap: nonnegative,
  gridTemplateColumns: { valid: grid }, gridTemplateRows: { valid: grid },
  gridColumn: { valid: (v) => /^(?:auto|[1-9]\d?(?:\s*\/\s*[1-9]\d?)?|span [1-9]\d?)$/.test(v) },
  gridRow: { valid: (v) => /^(?:auto|[1-9]\d?(?:\s*\/\s*[1-9]\d?)?|span [1-9]\d?)$/.test(v) },
  position: { valid: oneOf("static", "relative", "absolute", "fixed", "sticky") },
  top: offset, right: offset, bottom: offset, left: offset,
  zIndex: { kind: "number", valid: (v) => v === "auto" || /^-?\d+$/.test(v) && Math.abs(+v) <= 9999 },
  borderWidth: nonnegative, borderTopWidth: nonnegative, borderRightWidth: nonnegative, borderBottomWidth: nonnegative, borderLeftWidth: nonnegative,
  borderStyle: { valid: oneOf("none", "solid", "dashed", "dotted", "double") },
  borderTopStyle: { valid: oneOf("none", "solid", "dashed", "dotted", "double") }, borderRightStyle: { valid: oneOf("none", "solid", "dashed", "dotted", "double") },
  borderBottomStyle: { valid: oneOf("none", "solid", "dashed", "dotted", "double") }, borderLeftStyle: { valid: oneOf("none", "solid", "dashed", "dotted", "double") },
  borderTopColor: { kind: "color", valid: color }, borderRightColor: { kind: "color", valid: color }, borderBottomColor: { kind: "color", valid: color }, borderLeftColor: { kind: "color", valid: color },
  borderRadius: padding, overflow: { valid: oneOf("visible", "hidden", "clip", "auto", "scroll") },
  overflowWrap: { valid: oneOf("normal", "break-word", "anywhere") }, wordBreak: { valid: oneOf("normal", "break-all", "keep-all", "break-word") },
  objectFit: { valid: oneOf("fill", "contain", "cover", "none", "scale-down") },
  opacity: { kind: "number", valid: (v) => /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(v) },
  backgroundSize: { valid: oneOf("auto", "cover", "contain") },
  backgroundPosition: { valid: (v) => {
    const parts = v.split(" ");
    if (parts.length < 1 || parts.length > 2) return false;
    const position = (part: string) => ["left", "center", "right", "top", "bottom"].includes(part) || /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(part) && Number.parseFloat(part) <= 100;
    return parts.every(position);
  } },
  backgroundRepeat: { valid: oneOf("no-repeat", "repeat", "repeat-x", "repeat-y") },
  backgroundFilter: { valid: backgroundFilter },
  fontStyle: { valid: oneOf("normal", "italic") }, textDecorationLine: { valid: oneOf("none", "underline", "line-through") },
  writingMode: { valid: oneOf("horizontal-tb", "vertical-rl", "vertical-lr") }, boxShadow: { valid: shadow }, textShadow: { valid: shadow },
  outlineOffset: offset,
  translate: { kind: "length", px: true, valid: (v) => pair(v, translatePart) },
  rotate: { unit: "deg", valid: (v) => { const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))deg$/.exec(v); return !!match && Math.abs(Number(match[1])) <= 360; } },
  scale: { kind: "number", valid: (v) => pair(v, scalePart) }, skew: { unit: "deg", valid: (v) => pair(v, skewPart) },
  transformOrigin: { valid: oneOf(...origins) },
  transitionDuration: { unit: "ms", valid: time }, transitionDelay: { unit: "ms", valid: time }, transitionTimingFunction: { valid: oneOf(...easings) },
  overflowX: { valid: oneOf("visible", "hidden", "auto", "scroll") },
  scrollSnapType: { valid: oneOf("none", "x mandatory", "x proximity") }, scrollSnapAlign: { valid: oneOf("none", "start", "center", "end") }
};
/** 状態スタイルで使えるプロパティ。 */
export const stateProperties: readonly StateProperty[] = ["color", "backgroundColor", "borderColor", "opacity", "textDecorationLine", "translate", "rotate", "scale", "skew"];
export const stateNames: readonly StateName[] = ["hover", "focus", "active"];
export const appearEffects: readonly AppearEffect[] = ["fade", "fade-up", "fade-down", "fade-left", "fade-right", "zoom"];
/** 遷移の指定。通常の規則には出さず、状態スタイルを持つノードの動きの規則だけに出す。 */
export const motionProperties: readonly StyleProperty[] = ["transitionDuration", "transitionDelay", "transitionTimingFunction"];
export const isStyleProperty = (value: unknown): value is StyleProperty => typeof value === "string" && Object.hasOwn(specs, value);
export const textStyleProperties: readonly TextStyleProperty[] = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing", "fontVariantEastAsian", "fontStyle", "textDecorationLine"];
/** token を参照できるプロパティの型。参照できなければ undefined。 */
export const styleTokenKind = (property: StyleProperty): TokenKind | undefined => specs[property].kind;
/** 数値だけの指定を px として扱うプロパティ。 */
export const stylePxNumber = (property: StyleProperty): boolean => !!specs[property].px;
function label(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 60 || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid label");
  return value;
}
function tokenName(name: string, path: string): void {
  identifier(name, path);
  if (!/^[a-z][A-Za-z0-9-]*$/.test(name)) fail(path, "invalid name");
}
export function tokenCssValue(token: DesignToken): string {
  return typeof token.value === "number" && token.type === "length" ? `${token.value}px` : String(token.value);
}
/** CSS family names containing numeric words require a quoted string (e.g. Font Awesome 6 Brands). */
export function fontFamilyCss(value: string): string {
  return value.split(",").map((family) => {
    const name = family.trim();
    return name.split(/\s+/).some((word) => /^-?\d/.test(word)) ? JSON.stringify(name) : name;
  }).join(", ");
}
export function parseTokens(value: unknown, path: string): Record<string, DesignToken> {
  const source = record(value, path), result: Record<string, DesignToken> = {};
  if (Object.keys(source).length > 128) fail(path, "too many tokens");
  for (const [name, raw] of Object.entries(source)) {
    tokenName(name, path);
    const token = record(raw, `${path}.${name}`);
    keys(token, ["type", "value", "label"], `${path}.${name}`);
    const type = token.type;
    if (typeof type !== "string" || !["color", "length", "fontFamily", "number"].includes(type)) fail(path, "unknown token type");
    if (!(typeof token.value === "string" && token.value.length <= 256 || finite(token.value))) fail(path, "invalid token value");
    const parsed = { type, value: token.value } as DesignToken;
    const text = tokenCssValue(parsed);
    const valid = type === "color" ? color(text) : type === "length" ? length(text) : type === "fontFamily" ? fontFamily(text) : finite(token.value);
    if (!valid) fail(`${path}.${name}`, "invalid token value");
    if (token.label !== undefined) parsed.label = label(token.label, `${path}.${name}.label`);
    result[name] = parsed;
  }
  return result;
}
function literal(property: StyleProperty, value: unknown, path: string): string {
  const spec = specs[property];
  if (!(typeof value === "string" && value.length > 0 && value.length <= 256 || finite(value))) fail(path, "invalid style value");
  const text = typeof value === "number" && spec.px ? `${value}px` : typeof value === "number" && spec.unit ? `${value}${spec.unit}` : String(value);
  if (!spec.valid(text)) fail(path, "unsupported style value");
  return text;
}
/** URL・token・数値は受け付けず、素材参照だけを通す。 */
function backgroundImage(value: unknown, path: string): BackgroundImageValue | "none" {
  if (value === "none") return value;
  const source = record(value, path);
  keys(source, ["asset"], path);
  return { asset: parseAssetReference(source.asset, `${path}.asset`) };
}
function declarations(value: unknown, tokens: Record<string, DesignToken>, path: string, allowed?: readonly string[]): StyleDeclarations {
  const source = record(value, path), result: StyleDeclarations = {};
  for (const [name, raw] of Object.entries(source)) {
    // 背景画像は素材参照だけ。文字スタイル（allowed あり）では受け付けない。
    if (name === "backgroundImage" && !allowed) { result.backgroundImage = backgroundImage(raw, `${path}.${name}`); continue; }
    if (!Object.hasOwn(specs, name) || allowed && !allowed.includes(name)) fail(path, "unknown style property");
    const property = name as StyleProperty;
    if (raw !== null && typeof raw === "object") {
      const reference = record(raw, `${path}.${name}`);
      keys(reference, ["token"], `${path}.${name}`);
      if (typeof reference.token !== "string" || !Object.hasOwn(tokens, reference.token)) fail(path, "unknown token");
      const token = tokens[reference.token]!;
      if (token.type !== specs[property].kind) fail(path, "incompatible token type");
      literal(property, tokenCssValue(token), path);
      result[property] = { token: reference.token };
    } else {
      literal(property, raw, `${path}.${name}`);
      result[property] = raw as string | number;
    }
  }
  return result;
}
function responsive(value: unknown, tokens: Record<string, DesignToken>, path: string, allowed?: readonly string[]): { minWidth: number; declarations: StyleDeclarations }[] {
  if (!Array.isArray(value) || value.length > 12) fail(path, "invalid responsive styles");
  let previous = 0;
  return value.map((raw, index) => {
    const at = `${path}.responsive[${index}]`, entry = record(raw, at);
    keys(entry, ["minWidth", "declarations"], at);
    if (typeof entry.minWidth !== "number" || !Number.isInteger(entry.minWidth) || entry.minWidth < 320 || entry.minWidth > 3840 || entry.minWidth <= previous) fail(at, "minWidth must increase within 320–3840");
    previous = entry.minWidth;
    return { minWidth: entry.minWidth, declarations: declarations(entry.declarations, tokens, `${at}.declarations`, allowed) };
  });
}
function parseStates(value: unknown, tokens: Record<string, DesignToken>, path: string): NonNullable<NodeStyle["states"]> {
  const source = record(value, path), result: NonNullable<NodeStyle["states"]> = {};
  keys(source, stateNames, path);
  for (const name of stateNames) if (source[name] !== undefined) result[name] = declarations(source[name], tokens, `${path}.${name}`, stateProperties) as StateDeclarations;
  return result;
}
function milliseconds(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(path, `expected an integer from ${min} to ${max}`);
  return value;
}
function parseAppear(value: unknown, path: string): Appear {
  const source = record(value, path);
  keys(source, ["effect", "trigger", "duration", "delay", "easing"], path);
  if (typeof source.effect !== "string" || !(appearEffects as readonly string[]).includes(source.effect)) fail(`${path}.effect`, "unsupported effect");
  if (source.trigger !== "load" && source.trigger !== "view") fail(`${path}.trigger`, "unsupported trigger");
  const result: Appear = { effect: source.effect as AppearEffect, trigger: source.trigger, duration: milliseconds(source.duration, 100, 3000, `${path}.duration`), delay: milliseconds(source.delay, 0, 3000, `${path}.delay`) };
  if (source.easing !== undefined) {
    if (typeof source.easing !== "string" || !(easings as readonly string[]).includes(source.easing)) fail(`${path}.easing`, "unsupported easing");
    result.easing = source.easing as MotionEasing;
  }
  return result;
}
/** 昇順・重なりなし。maxWidth の無い範囲は最後だけ。 */
function parseHidden(value: unknown, path: string): HiddenRange[] {
  if (!Array.isArray(value) || value.length > 12) fail(path, "invalid hidden ranges");
  let previous = -1, open = false;
  return value.map((raw, index) => {
    const at = `${path}[${index}]`, entry = record(raw, at), min = entry.minWidth;
    keys(entry, ["minWidth", "maxWidth"], at);
    if (open || typeof min !== "number" || !Number.isInteger(min) || !(min === 0 || min >= 320 && min <= 3840) || min <= previous) fail(at, "hidden ranges must increase without overlap");
    if (entry.maxWidth === undefined) { open = true; return { minWidth: min }; }
    const max = entry.maxWidth;
    if (typeof max !== "number" || !Number.isInteger(max) || max <= min || max > 3840) fail(`${at}.maxWidth`, "maxWidth must be greater than minWidth");
    previous = max;
    return { minWidth: min, maxWidth: max };
  });
}
/** extras: 状態・登場・幅別の非表示・文字スタイル。業務ブロックの表示領域では受け付けない。 */
export function parseStyle(value: unknown, tokens: Record<string, DesignToken>, path: string, textStyles: Readonly<Record<string, TextStyle>> = {}, extras = true): NodeStyle {
  const source = record(value, path), result: NodeStyle = {};
  keys(source, extras ? ["textStyle", "base", "responsive", "states", "appear", "hidden"] : ["base", "responsive"], path);
  if (source.textStyle !== undefined) {
    if (typeof source.textStyle !== "string" || !Object.hasOwn(textStyles, source.textStyle)) fail(`${path}.textStyle`, "unknown text style");
    result.textStyle = source.textStyle;
  }
  if (source.base !== undefined) result.base = declarations(source.base, tokens, `${path}.base`);
  if (source.responsive !== undefined) result.responsive = responsive(source.responsive, tokens, path);
  if (source.states !== undefined) result.states = parseStates(source.states, tokens, `${path}.states`);
  if (source.appear !== undefined) result.appear = parseAppear(source.appear, `${path}.appear`);
  if (source.hidden !== undefined) result.hidden = parseHidden(source.hidden, `${path}.hidden`);
  return result;
}
export function parseTextStyles(value: unknown, tokens: Record<string, DesignToken>, path: string): Record<string, TextStyle> {
  const source = record(value, path), result: Record<string, TextStyle> = {};
  if (Object.keys(source).length > 64) fail(path, "too many text styles");
  for (const [name, raw] of Object.entries(source)) {
    tokenName(name, path);
    const at = `${path}.${name}`, entry = record(raw, at);
    keys(entry, ["label", "base", "responsive"], at);
    const style: TextStyle = { ...(entry.label === undefined ? {} : { label: label(entry.label, `${at}.label`) }), base: declarations(entry.base, tokens, `${at}.base`, textStyleProperties) as TextStyleDeclarations };
    if (entry.responsive !== undefined) style.responsive = responsive(entry.responsive, tokens, at, textStyleProperties) as NonNullable<TextStyle["responsive"]>;
    result[name] = style;
  }
  return result;
}
export function declarationCss(property: StyleProperty, value: StyleValue): string {
  if (property === "skew") {
    const cssValue = typeof value === "object" ? `var(--nw-${value.token})` : literal(property, value, property);
    return `transform:skew(${cssValue.split(" ").join(",")});`;
  }
  const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  let cssValue = typeof value === "object" ? `var(--nw-${value.token})` : literal(property, value, property);
  if (property === "fontFamily" && typeof value !== "object") cssValue = fontFamilyCss(cssValue);
  return `${cssName}:${cssValue};`;
}
