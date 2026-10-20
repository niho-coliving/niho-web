export class DocumentValidationError extends Error {
  constructor(public readonly path: string, reason: string) {
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
export function identifier(value: unknown, path: string): string {
  const result = string(value, path, 80);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result)) fail(path, "invalid identifier");
  return result;
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
