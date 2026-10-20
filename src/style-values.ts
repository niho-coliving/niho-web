import type { BackgroundImageValue, DesignToken, NodeStyle, StyleDeclarations, StyleProperty, StyleValue, TokenKind } from "./types.js";
import { fail, identifier, keys, parseAssetReference, record } from "./validation-utils.js";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100000;
const length = (v: string) => /^(?:0|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch))$/.test(v) && Math.abs(parseFloat(v)) <= 100000;
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

type PropertySpec = { kind?: TokenKind; px?: boolean; valid: (value: string) => boolean };
const dimension: PropertySpec = { kind: "length", px: true, valid: (v) => positiveLength(v) || ["auto", "min-content", "max-content", "fit-content", "none"].includes(v) };
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
  letterSpacing: { kind: "length", px: true, valid: length }, textAlign: { valid: oneOf("left", "right", "center", "start", "end", "justify") },
  width: dimension, height: dimension, minWidth: dimension, maxWidth: dimension, minHeight: dimension, maxHeight: dimension,
  margin, marginTop: offset, marginRight: offset, marginBottom: offset, marginLeft: offset,
  padding, paddingTop: nonnegative, paddingRight: nonnegative, paddingBottom: nonnegative, paddingLeft: nonnegative,
  display: { valid: oneOf("block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none") },
  flexDirection: { valid: oneOf("row", "row-reverse", "column", "column-reverse") },
  flexWrap: { valid: oneOf("nowrap", "wrap", "wrap-reverse") },
  justifyContent: { valid: oneOf("start", "end", "center", "flex-start", "flex-end", "space-between", "space-around", "space-evenly") },
  alignItems: { valid: oneOf("start", "end", "center", "stretch", "baseline", "flex-start", "flex-end") },
  alignSelf: { valid: oneOf("auto", "start", "end", "center", "stretch", "baseline", "flex-start", "flex-end") },
  flexGrow: { kind: "number", valid: unitNumber }, flexShrink: { kind: "number", valid: unitNumber }, flexBasis: dimension,
  gap: nonnegative, rowGap: nonnegative, columnGap: nonnegative,
  gridTemplateColumns: { valid: grid }, gridTemplateRows: { valid: grid },
  gridColumn: { valid: (v) => /^(?:auto|[1-9]\d?(?:\s*\/\s*[1-9]\d?)?|span [1-9]\d?)$/.test(v) },
  gridRow: { valid: (v) => /^(?:auto|[1-9]\d?(?:\s*\/\s*[1-9]\d?)?|span [1-9]\d?)$/.test(v) },
  position: { valid: oneOf("static", "relative", "absolute", "fixed", "sticky") },
  top: offset, right: offset, bottom: offset, left: offset,
  zIndex: { kind: "number", valid: (v) => v === "auto" || /^-?\d+$/.test(v) && Math.abs(+v) <= 100000 },
  borderWidth: nonnegative, borderStyle: { valid: oneOf("none", "solid", "dashed", "dotted", "double") },
  borderRadius: padding, overflow: { valid: oneOf("visible", "hidden", "clip", "auto", "scroll") },
  objectFit: { valid: oneOf("fill", "contain", "cover", "none", "scale-down") },
  opacity: { kind: "number", valid: (v) => /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(v) },
  backgroundSize: { valid: oneOf("auto", "cover", "contain") },
  backgroundPosition: { valid: oneOf("center", "top", "bottom", "left", "right", "top left", "top right", "bottom left", "bottom right") },
  backgroundRepeat: { valid: oneOf("no-repeat", "repeat", "repeat-x", "repeat-y") }
};
export function tokenCssValue(token: DesignToken): string {
  return typeof token.value === "number" && token.type === "length" ? `${token.value}px` : String(token.value);
}
export function parseTokens(value: unknown, path: string): Record<string, DesignToken> {
  const source = record(value, path), result: Record<string, DesignToken> = {};
  if (Object.keys(source).length > 128) fail(path, "too many tokens");
  for (const [name, raw] of Object.entries(source)) {
    identifier(name, path);
    if (!/^[a-z][A-Za-z0-9-]*$/.test(name)) fail(path, "invalid token name");
    const token = record(raw, `${path}.${name}`);
    keys(token, ["type", "value"], `${path}.${name}`);
    const type = token.type;
    if (typeof type !== "string" || !["color", "length", "fontFamily", "number"].includes(type)) fail(path, "unknown token type");
    if (!(typeof token.value === "string" && token.value.length <= 256 || finite(token.value))) fail(path, "invalid token value");
    const parsed = { type, value: token.value } as DesignToken;
    const text = tokenCssValue(parsed);
    const valid = type === "color" ? color(text) : type === "length" ? length(text) : type === "fontFamily" ? fontFamily(text) : finite(token.value);
    if (!valid) fail(`${path}.${name}`, "invalid token value");
    result[name] = parsed;
  }
  return result;
}
function literal(property: StyleProperty, value: unknown, path: string): string {
  const spec = specs[property];
  if (!(typeof value === "string" && value.length > 0 && value.length <= 256 || finite(value))) fail(path, "invalid style value");
  const text = typeof value === "number" && spec.px ? `${value}px` : String(value);
  if (!spec.valid(text)) fail(path, "unsupported style value");
  return text;
}
/** URL・token・数値は受け付けず、素材参照だけを通す。 */
function backgroundImage(value: unknown, path: string): BackgroundImageValue {
  const source = record(value, path);
  keys(source, ["asset"], path);
  return { asset: parseAssetReference(source.asset, `${path}.asset`) };
}
function declarations(value: unknown, tokens: Record<string, DesignToken>, path: string): StyleDeclarations {
  const source = record(value, path), result: StyleDeclarations = {};
  for (const [name, raw] of Object.entries(source)) {
    if (name === "backgroundImage") { result.backgroundImage = backgroundImage(raw, `${path}.${name}`); continue; }
    if (!Object.hasOwn(specs, name)) fail(path, "unknown style property");
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
export function parseStyle(value: unknown, tokens: Record<string, DesignToken>, path: string): NodeStyle {
  const source = record(value, path), result: NodeStyle = {};
  keys(source, ["base", "responsive"], path);
  if (source.base !== undefined) result.base = declarations(source.base, tokens, `${path}.base`);
  if (source.responsive !== undefined) {
    if (!Array.isArray(source.responsive) || source.responsive.length > 12) fail(path, "invalid responsive styles");
    let previous = 0;
    result.responsive = source.responsive.map((raw, index) => {
      const at = `${path}.responsive[${index}]`, entry = record(raw, at);
      keys(entry, ["minWidth", "declarations"], at);
      if (typeof entry.minWidth !== "number" || !Number.isInteger(entry.minWidth) || entry.minWidth < 320 || entry.minWidth > 3840 || entry.minWidth <= previous) fail(at, "minWidth must increase within 320–3840");
      previous = entry.minWidth;
      return { minWidth: entry.minWidth, declarations: declarations(entry.declarations, tokens, `${at}.declarations`) };
    });
  }
  return result;
}
export function declarationCss(property: StyleProperty, value: StyleValue): string {
  const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const cssValue = typeof value === "object" ? `var(--nw-${value.token})` : literal(property, value, property);
  return `${cssName}:${cssValue};`;
}
