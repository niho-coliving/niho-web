import type { AssetReference } from "./types.js";

export class DocumentValidationError extends Error {
  /** reason は入力値を含まない。展開後の検証エラーを位置だけ付け替えて投げ直すために保持する。 */
  constructor(public readonly path: string, public readonly reason: string) {
    super(`${path}: ${reason}`);
    this.name = "DocumentValidationError";
  }
}
export function fail(path: string, reason: string): never {
  throw new DocumentValidationError(path, reason);
}
export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, "expected a JSON object");
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(path, "unknown field");
}
export function string(value: unknown, path: string, max = 4096): string {
  if (typeof value !== "string" || value.length > max || /[\u0000\u000b\u000c]/u.test(value)) fail(path, "invalid string");
  return value;
}
/** 改行・制御文字を含まない1行の文字列。 */
export function line(value: unknown, path: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || (!allowEmpty && !value.trim())) fail(path, "invalid text");
  return value;
}
export function localeCode(value: unknown, path: string): string {
  const locale = string(value, path, 40);
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(locale)) fail(path, "invalid locale");
  return locale;
}
export function identifier(value: unknown, path: string): string {
  const result = string(value, path, 80);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result)) fail(path, "invalid identifier");
  return result;
}
/** 素材 ID。URL・パス区切り・空白を含まない。 */
export function assetId(value: unknown, path: string): string {
  const result = string(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(result)) fail(path, "invalid asset ID");
  return result;
}
export function parseAssetReference(value: unknown, path: string): AssetReference {
  const source = record(value, path);
  keys(source, ["provider", "id"], path);
  return { provider: identifier(source.provider, `${path}.provider`), id: assetId(source.id, `${path}.id`) };
}
/** HTTP、data、javascript、protocol relative、資格情報付き URL は許可しない。 */
export function isSafePublicUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  if (/[\s\u0000-\u001f\u007f\\<>"']/u.test(value + decoded)) return false;
  if (value.startsWith("#")) return /^#[A-Za-z][A-Za-z0-9_-]*$/.test(value);
  if (value.startsWith("/")) return !decoded.startsWith("//") && !value.startsWith("//");
  if (!/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/** パス・query・fragment・資格情報・末尾 / を含まない HTTPS origin。 */
export function isSafeHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && url.origin === value;
  } catch {
    return false;
  }
}
