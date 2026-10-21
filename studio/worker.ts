type D1Result<T> = { readonly results?: readonly T[]; readonly success: boolean };
type D1Statement = {
  bind(...values: readonly unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
};
type D1Database = { prepare(query: string): D1Statement };
type AssetBinding = { fetch(request: Request): Promise<Response> };

export interface Env {
  readonly DB: D1Database;
  readonly ASSETS: AssetBinding;
  /** Cloudflare Access application JWTのissと完全一致するHTTPS origin。 */
  readonly ACCESS_ISSUER: string;
  /** Cloudflare Access applicationのAUD tag。 */
  readonly ACCESS_AUDIENCE: string;
}

type AccessIdentity = { readonly subject: string };
type JwtHeader = { readonly alg?: unknown; readonly kid?: unknown; readonly typ?: unknown };
type JwtClaims = {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly sub?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly nbf?: unknown;
};
type JwksDocument = { readonly keys?: unknown };
type SigningJwk = JsonWebKey & { readonly kid?: string; readonly alg?: string; readonly use?: string };
type ProjectRow = {
  readonly project_id: string;
  readonly project_name: string;
  readonly site_id: string;
  readonly site_name: string;
  readonly public_origin: string | null;
  readonly display_name: string;
};

const MAX_MUTATION_BODY_BYTES = 16 * 1024;
const JWKS_CACHE_MILLISECONDS = 5 * 60 * 1000;
let jwksCache: { readonly url: string; readonly expiresAt: number; readonly keys: readonly SigningJwk[] } | undefined;
let lastForcedJwksRefreshAt = 0;

class AuthenticationError extends Error {}
class ConfigurationError extends Error {}
class SigningKeysUnavailableError extends Error {}

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: securityHeaders("application/json; charset=utf-8") });
}

function htmlError(message: string, status: number): Response {
  const body = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NIHO Studio</title><body><main><h1>NIHO Studio</h1><p>${message}</p></main></body></html>`;
  const headers = securityHeaders("text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  return new Response(body, { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function decodeBase64Url(value: string, maximumLength: number): Uint8Array {
  if (!value || value.length > maximumLength || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new AuthenticationError("invalid token encoding");
  const padding = (4 - value.length % 4) % 4;
  let decoded: string;
  try { decoded = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat(padding)); }
  catch { throw new AuthenticationError("invalid token encoding"); }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodeJwtObject<T>(segment: string, maximumLength: number): T {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(segment, maximumLength));
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("invalid token JSON");
  }
  if (!isRecord(value)) throw new AuthenticationError("invalid token object");
  return value as T;
}

function accessConfiguration(env: Env): { readonly issuer: string; readonly audience: string; readonly jwksUrl: string } {
  let issuerUrl: URL;
  try { issuerUrl = new URL(env.ACCESS_ISSUER); }
  catch { throw new ConfigurationError("invalid Access issuer"); }
  if (issuerUrl.protocol !== "https:" || issuerUrl.username || issuerUrl.password || issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash || issuerUrl.origin !== env.ACCESS_ISSUER) {
    throw new ConfigurationError("Access issuer must be an exact HTTPS origin");
  }
  if (!env.ACCESS_AUDIENCE || env.ACCESS_AUDIENCE.length > 256 || /\s/u.test(env.ACCESS_AUDIENCE)) throw new ConfigurationError("invalid Access audience");
  return { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE, jwksUrl: `${env.ACCESS_ISSUER}/cdn-cgi/access/certs` };
}

async function loadJwks(url: string, force = false): Promise<readonly SigningJwk[]> {
  const now = Date.now();
  if (!force && jwksCache?.url === url && jwksCache.expiresAt > now) return jwksCache.keys;
  const response = await fetch(url, { redirect: "error", headers: { Accept: "application/json" } });
  if (!response.ok) throw new SigningKeysUnavailableError("unable to load signing keys");
  const text = await response.text();
  if (text.length > 256 * 1024) throw new SigningKeysUnavailableError("signing keys response too large");
  let document: unknown;
  try { document = JSON.parse(text) as unknown; }
  catch { throw new SigningKeysUnavailableError("invalid signing keys"); }
  if (!isRecord(document) || !Array.isArray((document as JwksDocument).keys)) throw new SigningKeysUnavailableError("invalid signing keys");
  const keys = (document as { keys: readonly unknown[] }).keys.filter((key): key is SigningJwk => isRecord(key) && key.kty === "RSA");
  if (keys.length === 0 || keys.length > 20) throw new SigningKeysUnavailableError("invalid signing keys");
  jwksCache = { url, expiresAt: now + JWKS_CACHE_MILLISECONDS, keys };
  return keys;
}

function selectSigningKey(keys: readonly SigningJwk[], kid: string): SigningJwk | undefined {
  return keys.find((key) => key.kid === kid && key.kty === "RSA" && (key.alg === undefined || key.alg === "RS256") && (key.use === undefined || key.use === "sig") && (key.key_ops === undefined || key.key_ops.includes("verify")));
}

async function verifySignature(signingInput: string, signature: Uint8Array, key: SigningJwk): Promise<boolean> {
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature.slice().buffer, new TextEncoder().encode(signingInput));
  } catch { return false; }
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

async function authenticate(request: Request, env: Env): Promise<AccessIdentity> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 64 * 1024) throw new AuthenticationError("missing Access assertion");
  const segments = token.split(".");
  if (segments.length !== 3) throw new AuthenticationError("invalid Access assertion");
  const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
  const header = decodeJwtObject<JwtHeader>(encodedHeader, 4096);
  const claims = decodeJwtObject<JwtClaims>(encodedClaims, 32 * 1024);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 256 || (header.typ !== undefined && header.typ !== "JWT")) {
    throw new AuthenticationError("unsupported Access assertion");
  }
  const configuration = accessConfiguration(env);
  let keys = await loadJwks(configuration.jwksUrl);
  let key = selectSigningKey(keys, header.kid);
  if (!key && Date.now() - lastForcedJwksRefreshAt >= 30_000) {
    lastForcedJwksRefreshAt = Date.now();
    keys = await loadJwks(configuration.jwksUrl, true);
    key = selectSigningKey(keys, header.kid);
  }
  if (!key || !await verifySignature(`${encodedHeader}.${encodedClaims}`, decodeBase64Url(encodedSignature, 8192), key)) throw new AuthenticationError("invalid Access signature");

  const now = Math.floor(Date.now() / 1000);
  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) && claims.aud.every((entry) => typeof entry === "string") ? claims.aud : [];
  if (claims.iss !== configuration.issuer || !audiences.includes(configuration.audience)) throw new AuthenticationError("invalid Access claims");
  if (!finiteInteger(claims.exp) || !finiteInteger(claims.iat) || claims.exp <= now || claims.iat > now + 60 || claims.exp <= claims.iat) throw new AuthenticationError("expired Access assertion");
  if (claims.nbf !== undefined && (!finiteInteger(claims.nbf) || claims.nbf > now + 60)) throw new AuthenticationError("inactive Access assertion");
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 128 || claims.sub.trim() !== claims.sub || /[\u0000-\u001f\u007f]/u.test(claims.sub)) throw new AuthenticationError("invalid Access subject");
  return { subject: claims.sub };
}

function validIdentifier(value: string): boolean { return /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value); }
function validName(value: string): boolean { return value.length > 0 && value.length <= 120 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }

function domainsFor(origin: string | null): readonly string[] {
  if (origin === null) return [];
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error("invalid stored site origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== origin || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid stored site origin");
  return [origin];
}

function projectFromRow(row: ProjectRow, subject: string) {
  if (!validIdentifier(row.project_id) || !validIdentifier(row.site_id) || !validName(row.project_name) || !validName(row.site_name) || !validName(row.display_name)) throw new Error("invalid stored project");
  return {
    id: row.project_id,
    name: row.project_name,
    site: { id: row.site_id, name: row.site_name, domains: domainsFor(row.public_origin) },
    members: [{ userId: subject, displayName: row.display_name }]
  };
}

async function directory(env: Env, identity: AccessIdentity): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT p.id AS project_id, p.name AS project_name,
           s.id AS site_id, s.name AS site_name, s.public_origin,
           m.display_name
      FROM project_members AS m
      JOIN projects AS p ON p.id = m.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE m.access_subject = ?1
     ORDER BY p.name COLLATE NOCASE, p.id
     LIMIT 100
  `).bind(identity.subject).all<ProjectRow>();
  if (!result.success) throw new Error("directory query failed");
  const entries = (result.results ?? []).map((row) => {
    const project = projectFromRow(row, identity.subject);
    return {
      project,
      summary: {
        projectId: project.id,
        siteId: project.site.id,
        publicationStatus: "unknown",
        publishedUrl: null,
        thumbnail: null,
        updatedAt: null,
        lastAccessedAt: null
      }
    };
  });
  return json({ status: "ready", entries });
}

async function dashboard(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT p.id AS project_id, p.name AS project_name,
           s.id AS site_id, s.name AS site_name, s.public_origin,
           m.display_name
      FROM project_members AS m
      JOIN projects AS p ON p.id = m.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE m.access_subject = ?1 AND p.id = ?2 AND s.id = ?3
     LIMIT 1
  `).bind(identity.subject, projectId, siteId).first<ProjectRow>();
  if (row === null) return json({ status: "forbidden", projectId, siteId });
  projectFromRow(row, identity.subject);
  return json({
    status: "ready",
    projectId,
    siteId,
    fetchedAt: new Date().toISOString(),
    overview: { status: "unavailable" },
    analytics: { status: "disconnected" }
  });
}

async function enforceMutationBoundary(request: Request): Promise<void> {
  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin) throw new AuthenticationError("invalid request origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin") throw new AuthenticationError("invalid request site");
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw new AuthenticationError("JSON required");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_MUTATION_BODY_BYTES)) throw new AuthenticationError("request body too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_MUTATION_BODY_BYTES) {
        await reader.cancel("request body too large");
        throw new AuthenticationError("request body too large");
      }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
  catch { throw new AuthenticationError("invalid JSON"); }
  if (!isRecord(parsed)) throw new AuthenticationError("invalid JSON input");
}

function withStaticSecurity(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  let identity: AccessIdentity;
  try { identity = await authenticate(request, env); }
  catch (error) {
    if (!(error instanceof AuthenticationError)) throw error;
    return isApi ? json({ error: "session_expired" }, 401) : htmlError("セッションを確認できません。Cloudflare Access から再度ログインしてください。", 401);
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    try { await enforceMutationBoundary(request); }
    catch { return isApi ? json({ error: "invalid_request" }, 400) : htmlError("リクエストを処理できません。", 400); }
    return isApi ? json({ error: "method_not_allowed" }, 405) : htmlError("この操作は利用できません。", 405);
  }

  if (isApi) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/api/session") return json({ status: "authenticated", subject: identity.subject });
    if (url.pathname === "/api/projects") return directory(env, identity);
    const match = /^\/api\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})\/dashboard$/u.exec(url.pathname);
    if (match) return dashboard(env, identity, match[1]!, match[2]!);
    return json({ error: "not_found" }, 404);
  }

  if (url.pathname === "/" || /^\/projects\/[A-Za-z][A-Za-z0-9_-]{0,79}\/sites\/[A-Za-z][A-Za-z0-9_-]{0,79}\/?$/u.test(url.pathname)) {
    const indexUrl = new URL("/index.html", url);
    return withStaticSecurity(await env.ASSETS.fetch(new Request(indexUrl, { method: request.method, headers: request.headers })));
  }
  return withStaticSecurity(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handle(request, env); }
    catch (error) {
      console.error("NIHO Studio request failed", error instanceof Error ? error.name : "UnknownError");
      return new URL(request.url).pathname.startsWith("/api/") ? json({ error: "service_unavailable" }, 503) : htmlError("一時的に利用できません。時間をおいて再度お試しください。", 503);
    }
  }
};
