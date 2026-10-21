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

function isSafeMailAddress(value: string): boolean {
  const [local, domain, ...extra] = value.split("@");
  if (!local || !domain || extra.length || local.length > 64 || value.length > 254 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=_~-]+$/.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.at(-1)!.length >= 2 && labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function isSafeMailto(value: string, decoded: string): boolean {
  const payload = value.slice(value.indexOf(":") + 1), decodedPayload = decoded.slice(decoded.indexOf(":") + 1);
  if (payload.includes("#") || decodedPayload.includes("#")) return false;
  const queryIndex = payload.indexOf("?"), decodedQueryIndex = decodedPayload.indexOf("?");
  const decodedAddress = decodedQueryIndex < 0 ? decodedPayload : decodedPayload.slice(0, decodedQueryIndex);
  if (/\s/u.test(decodedAddress) || !isSafeMailAddress(decodedAddress)) return false;
  if (queryIndex < 0) return decodedQueryIndex < 0;
  if (decodedQueryIndex < 0) return false;
  const query = payload.slice(queryIndex + 1);
  if (!query) return false;
  const params = new URLSearchParams(query), seen = new Set<string>(), allowed = new Set(["subject", "body"]);
  let valid = true;
  params.forEach((content, name) => {
    if (!allowed.has(name) || seen.has(name) || /[\u0000-\u001f\u007f\\<>"']/u.test(content)) valid = false;
    seen.add(name);
  });
  return valid && seen.size > 0;
}

function isSafeTelephone(value: string): boolean {
  const number = value.slice(value.indexOf(":") + 1);
  if (!/^\+?[0-9][0-9().-]{0,38}$/.test(number) || !/[0-9)]$/.test(number) || (number.match(/[0-9]/g)?.length ?? 0) > 20) return false;
  let depth = 0;
  for (const character of number) {
    if (character === "(") depth++;
    if (character === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** PageDocument のリンク用。一般 URL 制約は維持し、a.href だけ安全な mailto/tel を追加する。 */
export function isSafePublicLink(value: unknown): value is string {
  if (isSafePublicUrl(value)) return true;
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /\s/u.test(value)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  if (/[\u0000-\u001f\u007f\\<>"']/u.test(value + decoded)) return false;
  if (/^mailto:/i.test(value)) return isSafeMailto(value, decoded);
  if (/^tel:/i.test(value)) return isSafeTelephone(value);
  return false;
}

/** 画像 source 用。fragment は画像参照として扱わず、既存の公開 URL 制約をそのまま使う。 */
export function publicImageUrl(value: unknown, path: string): string {
  if (!isSafePublicUrl(value) || value.startsWith("#")) fail(path, "unsafe image URL");
  return value;
}

/** 現行文書契約の responsive source は単一 URL。候補列の独自解釈はしない。 */
export function publicImageSrcSet(value: unknown, path: string): string {
  const result = publicImageUrl(value, path);
  if (/[,\s]/u.test(result)) fail(path, "srcSet supports one URL only");
  return result;
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
