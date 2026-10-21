type D1Meta = { readonly changes?: number };
type D1Result<T> = { readonly results?: readonly T[]; readonly success: boolean; readonly meta?: D1Meta };
type D1Statement = {
  bind(...values: readonly unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
};
type D1Database = {
  prepare(query: string): D1Statement;
  batch<T>(statements: readonly D1Statement[]): Promise<readonly D1Result<T>[]>;
};
type AssetBinding = { fetch(request: Request): Promise<Response> };

export interface Env {
  readonly DB: D1Database;
  readonly ASSETS: AssetBinding;
  /** 同一 Cloudflare account の kamakura-site Worker。 */
  readonly KAMAKURA_SITE: AssetBinding;
  /** Cloudflare Access application JWTのissと完全一致するHTTPS origin。 */
  readonly ACCESS_ISSUER: string;
  /** Cloudflare Access applicationのAUD tag。 */
  readonly ACCESS_AUDIENCE: string;
  /** NIHO internal Studio bridgeと共有するbase64url HMAC key。 */
  readonly NIHO_STUDIO_BRIDGE_SECRET?: string;
  /** kamakura-site Studio bridgeと共有するbase64url HMAC key。 */
  readonly KAMAKURA_STUDIO_BRIDGE_SECRET?: string;
}

type Role = "owner" | "editor";
type AccessIdentity = { readonly subject: string; readonly email: string };
type JwtHeader = { readonly alg?: unknown; readonly kid?: unknown; readonly typ?: unknown };
type JwtClaims = {
  readonly iss?: unknown;
  readonly aud?: unknown;
  readonly sub?: unknown;
  readonly email?: unknown;
  readonly type?: unknown;
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
type AdminContextRow = { readonly project_name: string; readonly site_name: string };
type MemberRow = {
  readonly access_subject: string;
  readonly email: string | null;
  readonly role: Role;
  readonly display_name: string;
  readonly created_at: string;
};
type InvitationRow = {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly created_at: number;
  readonly expires_at: number;
  readonly status: "pending" | "expired" | "accepted" | "revoked";
};
type InvitationPreviewRow = {
  readonly project_name: string;
  readonly site_name: string;
  readonly role: Role;
  readonly expires_at: number;
};

const MAX_MUTATION_BODY_BYTES = 16 * 1024;
const MAX_EDITOR_SAVE_BODY_BYTES = 600 * 1024;
const MAX_EDITOR_RESPONSE_BYTES = 2 * 1024 * 1024;
const EDITOR_UPSTREAM_ORIGIN = "https://api.niho.life";
const EDITOR_UPSTREAM_PREFIX = "/api/internal/studio/experience";
const EDITOR_PROJECT_ID = "project-experience";
const EDITOR_SITE_ID = "experience";
const EDITOR_TIMEOUT_MILLISECONDS = 12_000;
const KAMAKURA_EDITOR_UPSTREAM_ORIGIN = "https://next-kamakura.niho.life";
const KAMAKURA_EDITOR_UPSTREAM_PREFIX = "/internal/studio/web-content";
const KAMAKURA_EDITOR_PROJECT_ID = "project-kamakura";
const KAMAKURA_EDITOR_SITE_ID = "kamakura";
const KAMAKURA_EDITOR_SITE_NAME = "鎌倉サイト（新サイト確認用）";
const KAMAKURA_EDITOR_DOMAIN = "https://next-kamakura.niho.life";
const COMMON_PAGE_ID = /^(?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59}$/u;
const MAX_PENDING_INVITATIONS = 100;
const MAX_PROJECT_MEMBERS = 500;
const JWKS_CACHE_MILLISECONDS = 5 * 60 * 1000;
let jwksCache: { readonly url: string; readonly expiresAt: number; readonly keys: readonly SigningJwk[] } | undefined;
let lastForcedJwksRefreshAt = 0;

class AuthenticationError extends Error {}
class ConfigurationError extends Error {}
class SigningKeysUnavailableError extends Error {}
class InvalidInputError extends Error {}
class BridgeUnavailableError extends Error {}

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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new InvalidInputError("unexpected input fields");
}

function decodeBase64Url(value: string, maximumLength: number): Uint8Array {
  if (!value || value.length > maximumLength || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new AuthenticationError("invalid token encoding");
  const padding = (4 - value.length % 4) % 4;
  let decoded: string;
  try { decoded = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat(padding)); }
  catch { throw new AuthenticationError("invalid token encoding"); }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function bridgeSecret(encoded: string | undefined): Uint8Array {
  if (typeof encoded !== "string" || !encoded || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new ConfigurationError("invalid Studio bridge secret");
  let decoded: Uint8Array;
  try { decoded = decodeBase64Url(encoded, 1024); }
  catch { throw new ConfigurationError("invalid Studio bridge secret"); }
  if (decoded.byteLength < 32 || encodeBase64Url(decoded) !== encoded) throw new ConfigurationError("invalid Studio bridge secret");
  return decoded;
}

function hexadecimal(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const response = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" } });
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
  return keys.find((key) => key.kid === kid && key.kty === "RSA" && (key.alg === undefined || key.alg === "RS256") && (key.use === undefined || key.use === "sig") && (key.key_ops === undefined || Array.isArray(key.key_ops) && key.key_ops.includes("verify")));
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

function validSubject(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/\p{Cc}/u.test(value);
}

function normalizeEmail(value: unknown, ErrorType: typeof AuthenticationError | typeof InvalidInputError): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 254 || value.trim() !== value || !/^[\x21-\x7e]+$/u.test(value)) throw new ErrorType("invalid email");
  const email = value.toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) throw new ErrorType("invalid email");
  const [local, domain] = parts as [string, string];
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) throw new ErrorType("invalid email");
  if (!domain || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".")) throw new ErrorType("invalid email");
  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[a-z0-9-]+$/u.test(label))) throw new ErrorType("invalid email");
  return email;
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
  if (claims.iss !== configuration.issuer || !audiences.includes(configuration.audience) || claims.type !== "app") throw new AuthenticationError("invalid Access claims");
  if (!finiteInteger(claims.exp) || !finiteInteger(claims.iat) || claims.exp <= now || claims.iat > now + 60 || claims.exp <= claims.iat) throw new AuthenticationError("expired Access assertion");
  if (claims.nbf !== undefined && (!finiteInteger(claims.nbf) || claims.nbf > now + 60)) throw new AuthenticationError("inactive Access assertion");
  if (!validSubject(claims.sub)) throw new AuthenticationError("invalid Access subject");
  return { subject: claims.sub, email: normalizeEmail(claims.email, AuthenticationError) };
}

function validIdentifier(value: string): boolean { return /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value); }
function validName(value: string): boolean { return value.length > 0 && value.length <= 120 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }
function validRole(value: unknown): value is Role { return value === "owner" || value === "editor"; }
function validInvitationId(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value); }
function validInvitationToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value); }

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

function ownerContextStatement(env: Env, identity: AccessIdentity, projectId: string, siteId: string): D1Statement {
  return env.DB.prepare(`
    SELECT p.name AS project_name, s.name AS site_name
      FROM project_members AS actor
      JOIN projects AS p ON p.id = actor.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE actor.access_subject = ?1 AND actor.role = 'owner'
       AND p.id = ?2 AND s.id = ?3
     LIMIT 1
  `).bind(identity.subject, projectId, siteId);
}

function firstRow<T>(result: D1Result<unknown> | undefined): T | undefined {
  return result?.results?.[0] as T | undefined;
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return result?.success === true && result.meta?.changes === 1;
}

function unixTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid stored timestamp");
  return new Date(value * 1000).toISOString();
}

async function membershipAdministration(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<Response> {
  const results = await env.DB.batch<unknown>([
    ownerContextStatement(env, identity, projectId, siteId),
    env.DB.prepare(`
      SELECT m.access_subject, m.email, m.role, m.display_name, m.created_at
        FROM project_members AS m
       WHERE m.project_id = ?2
         AND EXISTS (
           SELECT 1 FROM project_members AS actor
           JOIN sites AS s ON s.project_id = actor.project_id
            WHERE actor.access_subject = ?1 AND actor.role = 'owner'
              AND actor.project_id = ?2 AND s.id = ?3
         )
       ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.display_name COLLATE NOCASE, m.access_subject
       LIMIT 500
    `).bind(identity.subject, projectId, siteId),
    env.DB.prepare(`
      SELECT i.id, i.email, i.role, i.created_at, i.expires_at,
             CASE
               WHEN i.used_at IS NOT NULL THEN 'accepted'
               WHEN i.revoked_at IS NOT NULL THEN 'revoked'
               WHEN i.expires_at <= unixepoch() THEN 'expired'
               ELSE 'pending'
             END AS status
        FROM project_invitations AS i
       WHERE i.project_id = ?2
         AND EXISTS (
           SELECT 1 FROM project_members AS actor
           JOIN sites AS s ON s.project_id = actor.project_id
            WHERE actor.access_subject = ?1 AND actor.role = 'owner'
              AND actor.project_id = ?2 AND s.id = ?3
         )
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT 100
    `).bind(identity.subject, projectId, siteId)
  ]);
  const context = firstRow<AdminContextRow>(results[0]);
  if (!context) return json({ error: "forbidden" }, 403);
  if (!validName(context.project_name) || !validName(context.site_name)) throw new Error("invalid stored project");
  const members = ((results[1]?.results ?? []) as readonly MemberRow[]).map((member) => ({
    subject: member.access_subject,
    email: member.email,
    role: member.role,
    displayName: member.display_name,
    createdAt: member.created_at,
    isCurrent: member.access_subject === identity.subject
  }));
  const invitations = ((results[2]?.results ?? []) as readonly InvitationRow[]).map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    createdAt: unixTimestamp(invitation.created_at),
    expiresAt: unixTimestamp(invitation.expires_at),
    status: invitation.status
  }));
  return json({ status: "ready", projectName: context.project_name, siteName: context.site_name, members, invitations });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function tokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function auditActionForInvite(prefix: "invitation.created" | "invitation.accepted", role: Role): string {
  return `${prefix}.${role}`;
}

async function createInvitation(request: Request, env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["email", "role", "expiresInDays"]);
  const email = normalizeEmail(body.email, InvalidInputError);
  if (!validRole(body.role)) throw new InvalidInputError("invalid role");
  if (!Number.isSafeInteger(body.expiresInDays) || (body.expiresInDays as number) < 1 || (body.expiresInDays as number) > 7) throw new InvalidInputError("invalid expiry");
  const role = body.role;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (body.expiresInDays as number) * 86_400;
  const token = randomToken();
  const hash = await tokenHash(token);
  const invitationId = crypto.randomUUID();
  const results = await env.DB.batch<unknown>([
    ownerContextStatement(env, identity, projectId, siteId),
    env.DB.prepare(`
      INSERT INTO project_invitations
        (id, project_id, email, role, token_hash, invited_by_subject, created_at, expires_at)
      SELECT ?4, ?2, ?5, ?6, ?7, ?1, ?8, ?9
       WHERE EXISTS (
         SELECT 1 FROM project_members AS actor
         JOIN sites AS s ON s.project_id = actor.project_id
          WHERE actor.access_subject = ?1 AND actor.role = 'owner'
            AND actor.project_id = ?2 AND s.id = ?3
       )
         AND (SELECT count(*) FROM project_invitations
               WHERE project_id = ?2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()) < ?10
         AND NOT EXISTS (
           SELECT 1 FROM project_members
            WHERE project_id = ?2 AND email = ?5
         )
         AND NOT EXISTS (
           SELECT 1 FROM project_invitations
            WHERE project_id = ?2 AND email = ?5
              AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()
         )
    `).bind(identity.subject, projectId, siteId, invitationId, email, role, hash, now, expiresAt, MAX_PENDING_INVITATIONS),
    env.DB.prepare(`
      INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
      SELECT ?2, ?1, ?3, ?4 WHERE changes() = 1
    `).bind(identity.subject, projectId, auditActionForInvite("invitation.created", role), email)
  ]);
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  const invitationUrl = new URL(`/projects/${encodeURIComponent(projectId)}/sites/${encodeURIComponent(siteId)}/invite`, request.url);
  invitationUrl.searchParams.set("token", token);
  return json({
    status: "created",
    invitation: { id: invitationId, email, role, expiresAt: unixTimestamp(expiresAt) },
    invitationUrl: invitationUrl.href
  }, 201);
}

async function invitationPreview(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["token"]);
  if (!validInvitationToken(body.token)) throw new InvalidInputError("invalid invitation token");
  const hash = await tokenHash(body.token);
  const row = await env.DB.prepare(`
    SELECT p.name AS project_name, s.name AS site_name, i.role, i.expires_at
      FROM project_invitations AS i
      JOIN projects AS p ON p.id = i.project_id
      JOIN sites AS s ON s.project_id = p.id
     WHERE i.token_hash = ?1 AND i.email = ?2
       AND i.project_id = ?3 AND s.id = ?4
       AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > unixepoch()
     LIMIT 1
  `).bind(hash, identity.email, projectId, siteId).first<InvitationPreviewRow>();
  if (!row) return json({ error: "invitation_unavailable" }, 404);
  if (!validName(row.project_name) || !validName(row.site_name) || !validRole(row.role)) throw new Error("invalid stored invitation");
  return json({
    status: "ready",
    invitation: { projectName: row.project_name, siteName: row.site_name, role: row.role, expiresAt: unixTimestamp(row.expires_at) }
  });
}

async function acceptInvitation(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["token"]);
  if (!validInvitationToken(body.token)) throw new InvalidInputError("invalid invitation token");
  const hash = await tokenHash(body.token);
  const results = await env.DB.batch<unknown>([
    env.DB.prepare(`
      INSERT INTO project_members (project_id, access_subject, role, display_name, email)
      SELECT i.project_id, ?1, i.role, ?2, ?2
        FROM project_invitations AS i
        JOIN sites AS s ON s.project_id = i.project_id
       WHERE i.token_hash = ?3 AND i.email = ?2
         AND i.project_id = ?4 AND s.id = ?5
         AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > unixepoch()
         AND (SELECT count(*) FROM project_members WHERE project_id = i.project_id) < ?6
      ON CONFLICT DO NOTHING
    `).bind(identity.subject, identity.email, hash, projectId, siteId, MAX_PROJECT_MEMBERS),
    env.DB.prepare(`
      UPDATE project_invitations
         SET used_at = unixepoch(), accepted_subject = ?1
       WHERE token_hash = ?2 AND email = ?3 AND project_id = ?4
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()
         AND changes() = 1
    `).bind(identity.subject, hash, identity.email, projectId),
    env.DB.prepare(`
      INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
      SELECT i.project_id, ?1,
             CASE i.role WHEN 'owner' THEN 'invitation.accepted.owner' ELSE 'invitation.accepted.editor' END,
             i.id
        FROM project_invitations AS i
       WHERE i.token_hash = ?2 AND i.accepted_subject = ?1 AND changes() = 1
    `).bind(identity.subject, hash)
  ]);
  if (!changed(results[0]) || !changed(results[1])) return json({ error: "invitation_unavailable" }, 409);
  return json({ status: "accepted" });
}

async function revokeInvitation(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["invitationId"]);
  if (!validInvitationId(body.invitationId)) throw new InvalidInputError("invalid invitation id");
  const results = await env.DB.batch<unknown>([
    ownerContextStatement(env, identity, projectId, siteId),
    env.DB.prepare(`
      UPDATE project_invitations
         SET revoked_at = unixepoch(), revoked_by_subject = ?1
       WHERE id = ?4 AND project_id = ?2
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > unixepoch()
         AND EXISTS (
           SELECT 1 FROM project_members AS actor
           JOIN sites AS s ON s.project_id = actor.project_id
            WHERE actor.access_subject = ?1 AND actor.role = 'owner'
              AND actor.project_id = ?2 AND s.id = ?3
         )
    `).bind(identity.subject, projectId, siteId, body.invitationId),
    env.DB.prepare(`
      INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
      SELECT ?2, ?1, 'invitation.revoked', ?3 WHERE changes() = 1
    `).bind(identity.subject, projectId, body.invitationId)
  ]);
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  return json({ status: "revoked" });
}

async function changeMemberRole(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["subject", "role"]);
  if (!validSubject(body.subject) || !validRole(body.role)) throw new InvalidInputError("invalid member role input");
  const action = body.role === "owner" ? "member.promoted" : "member.demoted";
  let results: readonly D1Result<unknown>[];
  try {
    results = await env.DB.batch<unknown>([
      ownerContextStatement(env, identity, projectId, siteId),
      env.DB.prepare(`
        UPDATE project_members
           SET role = ?5
         WHERE project_id = ?2 AND access_subject = ?4 AND role <> ?5
           AND EXISTS (
             SELECT 1 FROM project_members AS actor
             JOIN sites AS s ON s.project_id = actor.project_id
              WHERE actor.access_subject = ?1 AND actor.role = 'owner'
                AND actor.project_id = ?2 AND s.id = ?3
           )
      `).bind(identity.subject, projectId, siteId, body.subject, body.role),
      env.DB.prepare(`
        INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
        SELECT ?2, ?1, ?3, ?4 WHERE changes() = 1
      `).bind(identity.subject, projectId, action, body.subject)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("cannot demote the final owner")) return json({ error: "final_owner_required" }, 409);
    throw error;
  }
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  return json({ status: "changed" });
}

async function removeMember(env: Env, identity: AccessIdentity, projectId: string, siteId: string, body: Record<string, unknown>): Promise<Response> {
  exactKeys(body, ["subject"]);
  if (!validSubject(body.subject)) throw new InvalidInputError("invalid member input");
  let results: readonly D1Result<unknown>[];
  try {
    results = await env.DB.batch<unknown>([
      ownerContextStatement(env, identity, projectId, siteId),
      env.DB.prepare(`
        DELETE FROM project_members
         WHERE project_id = ?2 AND access_subject = ?4
           AND EXISTS (
             SELECT 1 FROM project_members AS actor
             JOIN sites AS s ON s.project_id = actor.project_id
              WHERE actor.access_subject = ?1 AND actor.role = 'owner'
                AND actor.project_id = ?2 AND s.id = ?3
           )
      `).bind(identity.subject, projectId, siteId, body.subject),
      env.DB.prepare(`
        INSERT INTO studio_audit_records (project_id, actor_subject, action, target)
        SELECT ?2, ?1, 'member.removed', ?3 WHERE changes() = 1
      `).bind(identity.subject, projectId, body.subject)
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("cannot remove the final owner")) return json({ error: "final_owner_required" }, 409);
    throw error;
  }
  if (!firstRow<AdminContextRow>(results[0])) return json({ error: "forbidden" }, 403);
  if (!changed(results[1])) return json({ error: "operation_rejected" }, 409);
  return json({ status: "removed" });
}

async function enforceMutationBoundary(request: Request): Promise<Record<string, unknown>> {
  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin) throw new AuthenticationError("invalid request origin");
  if (request.headers.get("Sec-Fetch-Site") !== "same-origin") throw new AuthenticationError("invalid request site");
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
  return parsed;
}

type EditorRoute = { readonly upstreamPath: string; readonly bodyLimit: number };

function experienceEditorRoute(action: string, method: string): EditorRoute | "method_not_allowed" | null {
  const fixed = new Map<string, "GET">([
    ["/editor/sites", "GET"],
    ["/editor/sites/experience/pages", "GET"]
  ]);
  const page = /^\/editor\/sites\/experience\/pages\/(home|experiences|experience-detail|booking|host|chrome)\/en(\/draft|\/release-plan|\/release)?$/u.exec(action);
  if (page) {
    const suffix = page[2] ?? "";
    const expected = suffix === "/draft" ? "PUT" : suffix === "/release-plan" || suffix === "/release" ? "POST" : "GET";
    if (method !== expected) return "method_not_allowed";
    return { upstreamPath: `${EDITOR_UPSTREAM_PREFIX}${action.slice("/editor".length)}`, bodyLimit: suffix === "/draft" ? MAX_EDITOR_SAVE_BODY_BYTES : MAX_MUTATION_BODY_BYTES };
  }
  const expected = fixed.get(action);
  if (!expected) return null;
  if (method !== expected) return "method_not_allowed";
  return { upstreamPath: `${EDITOR_UPSTREAM_PREFIX}${action.slice("/editor".length)}`, bodyLimit: MAX_MUTATION_BODY_BYTES };
}

function kamakuraEditorRoute(action: string, method: string): EditorRoute | "method_not_allowed" | null {
  if (action === "/editor/catalog") {
    if (method !== "GET") return "method_not_allowed";
    return { upstreamPath: `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/catalog`, bodyLimit: MAX_MUTATION_BODY_BYTES };
  }
  const page = /^\/editor\/((?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59})(\/draft|\/release-plan|\/release)?$/u.exec(action);
  if (!page || !COMMON_PAGE_ID.test(page[1]!)) return null;
  const suffix = page[2] ?? "";
  const expected = suffix === "/draft" ? "PUT" : suffix === "/release-plan" || suffix === "/release" ? "POST" : "GET";
  if (method !== expected) return "method_not_allowed";
  return { upstreamPath: `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/${page[1]}${suffix}`, bodyLimit: suffix === "/draft" ? MAX_EDITOR_SAVE_BODY_BYTES : MAX_MUTATION_BODY_BYTES };
}

async function editorMember(env: Env, identity: AccessIdentity, projectId: string, siteId: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT 1 AS allowed
      FROM project_members AS m
      JOIN sites AS s ON s.project_id = m.project_id
     WHERE m.access_subject = ?1 AND m.project_id = ?2 AND s.id = ?3
       AND m.role IN ('owner', 'editor')
     LIMIT 1
  `).bind(identity.subject, projectId, siteId).first<{ readonly allowed: number }>();
  return row?.allowed === 1;
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin || request.headers.get("Sec-Fetch-Site") !== "same-origin") throw new AuthenticationError("invalid editor request origin");
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new AuthenticationError("editor JSON required");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) throw new AuthenticationError("editor request body too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) { await reader.cancel("editor request body too large"); throw new AuthenticationError("editor request body too large"); }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    if (!isRecord(parsed)) throw new Error("object required");
  } catch { throw new AuthenticationError("invalid editor JSON"); }
  return body;
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new BridgeUnavailableError("invalid bridge response media type");
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_EDITOR_RESPONSE_BYTES)) throw new BridgeUnavailableError("bridge response too large");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_EDITOR_RESPONSE_BYTES) { await reader.cancel("bridge response too large"); throw new BridgeUnavailableError("bridge response too large"); }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
  catch { throw new BridgeUnavailableError("invalid bridge JSON"); }
  if (!isRecord(parsed)) throw new BridgeUnavailableError("invalid bridge response");
  return parsed;
}

async function signedEditorRequest(request: Request, env: Env, identity: AccessIdentity, route: EditorRoute): Promise<Response> {
  const body = request.method === "GET" ? new Uint8Array() : await readBoundedBody(request, route.bodyLimit);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyBytes = body.slice().buffer;
  const bodyHash = hexadecimal(await crypto.subtle.digest("SHA-256", bodyBytes));
  const message = `v1\n${timestamp}\n${request.method}\n${route.upstreamPath}\n${bodyHash}\n${EDITOR_PROJECT_ID}\n${identity.subject}`;
  const key = await crypto.subtle.importKey("raw", bridgeSecret(env.NIHO_STUDIO_BRIDGE_SECRET).slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hexadecimal(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, EDITOR_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetch(`${EDITOR_UPSTREAM_ORIGIN}${route.upstreamPath}`, {
      method: request.method,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(request.method === "GET" ? {} : { "Content-Type": "application/json" }),
        "X-NIHO-Studio-Project": EDITOR_PROJECT_ID,
        "X-NIHO-Studio-Subject": identity.subject,
        "X-NIHO-Studio-Timestamp": timestamp,
        "X-NIHO-Studio-Signature": `v1=${signature}`
      },
      ...(request.method === "GET" ? {} : { body: bodyBytes })
    });
    if (response.status >= 300 && response.status < 400) throw new BridgeUnavailableError("bridge redirect rejected");
    const value = await readBoundedResponse(response);
    if (response.status === 409) return json({ error: "conflict" }, 409);
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500) throw new BridgeUnavailableError("bridge service unavailable");
    if (!response.ok) return json({ error: "invalid_request" }, response.status === 400 || response.status === 422 ? 400 : 503);
    return json(value, response.status);
  } catch { throw new BridgeUnavailableError("bridge request failed"); }
  finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); }
}

function catalogLine(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new BridgeUnavailableError("invalid catalog response");
  return value;
}

function sanitizeKamakuraCatalog(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new BridgeUnavailableError("invalid catalog response");
  const siteValue = (candidate: unknown): { readonly id: "kamakura"; readonly name: string; readonly domains: readonly string[] } => {
    if (!isRecord(candidate) || candidate.id !== KAMAKURA_EDITOR_SITE_ID || candidate.name !== KAMAKURA_EDITOR_SITE_NAME || !Array.isArray(candidate.domains) || candidate.domains.length !== 1 || candidate.domains[0] !== KAMAKURA_EDITOR_DOMAIN) {
      throw new BridgeUnavailableError("invalid catalog site");
    }
    return { id: "kamakura", name: KAMAKURA_EDITOR_SITE_NAME, domains: [KAMAKURA_EDITOR_DOMAIN] };
  };
  if (!isRecord(value.project) || value.project.id !== "kamakura-site" || value.project.name !== "NIHO kamakura") throw new BridgeUnavailableError("invalid catalog project");
  const projectSite = siteValue(value.project.site);
  if (!Array.isArray(value.sites) || value.sites.length !== 1) throw new BridgeUnavailableError("invalid catalog sites");
  const site = siteValue(value.sites[0]);
  if (!Array.isArray(value.pages) || value.pages.length > 500 || !Array.isArray(value.legacy) || value.legacy.length > 5_000) throw new BridgeUnavailableError("invalid catalog entries");
  const pages = value.pages.map((candidate) => {
    if (!isRecord(candidate) || candidate.siteId !== KAMAKURA_EDITOR_SITE_ID || candidate.locale !== "ja" || typeof candidate.pageId !== "string" || !COMMON_PAGE_ID.test(candidate.pageId)) throw new BridgeUnavailableError("invalid catalog page");
    return { siteId: "kamakura", pageId: candidate.pageId, locale: "ja", title: catalogLine(candidate.title, 120) };
  });
  if (new Set(pages.map(({ pageId }) => pageId)).size !== pages.length) throw new BridgeUnavailableError("duplicate catalog page");
  const legacyPath = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u;
  const legacy = value.legacy.map((candidate) => {
    if (!isRecord(candidate)) throw new BridgeUnavailableError("invalid legacy page");
    const name = catalogLine(candidate.name, 200);
    const path = catalogLine(candidate.path, 2_048);
    if (!legacyPath.test(path)) throw new BridgeUnavailableError("invalid legacy path");
    return { name, path };
  });
  if (new Set(legacy.map(({ name }) => name)).size !== legacy.length || new Set(legacy.map(({ path }) => path)).size !== legacy.length) throw new BridgeUnavailableError("duplicate legacy page");
  return { project: { id: "kamakura-site", name: "NIHO kamakura", site: projectSite }, sites: [site], pages, legacy };
}

async function signedKamakuraEditorRequest(request: Request, env: Env, identity: AccessIdentity, route: EditorRoute): Promise<Response> {
  if (request.method === "GET" && (request.body !== null || ![null, "0"].includes(request.headers.get("Content-Length")))) throw new AuthenticationError("GET body rejected");
  const body = request.method === "GET" ? new Uint8Array() : await readBoundedBody(request, route.bodyLimit);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyBytes = body.slice().buffer;
  const bodyHash = hexadecimal(await crypto.subtle.digest("SHA-256", bodyBytes));
  const message = `v1\n${timestamp}\n${request.method}\n${route.upstreamPath}\n${bodyHash}\n${KAMAKURA_EDITOR_PROJECT_ID}\n${identity.subject}`;
  const key = await crypto.subtle.importKey("raw", bridgeSecret(env.KAMAKURA_STUDIO_BRIDGE_SECRET).slice().buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hexadecimal(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, EDITOR_TIMEOUT_MILLISECONDS);
  try {
    const upstream = new Request(`${KAMAKURA_EDITOR_UPSTREAM_ORIGIN}${route.upstreamPath}`, {
      method: request.method,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        ...(request.method === "GET" ? {} : { "Content-Type": "application/json" }),
        "X-NIHO-Studio-Project": KAMAKURA_EDITOR_PROJECT_ID,
        "X-NIHO-Studio-Subject": identity.subject,
        "X-NIHO-Studio-Timestamp": timestamp,
        "X-NIHO-Studio-Signature": `v1=${signature}`
      },
      ...(request.method === "GET" ? {} : { body: bodyBytes })
    });
    const response = await env.KAMAKURA_SITE.fetch(upstream);
    if (response.status >= 300 && response.status < 400) throw new BridgeUnavailableError("bridge redirect rejected");
    const value = await readBoundedResponse(response);
    if (response.status === 409) return json({ error: "conflict" }, 409);
    if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) throw new BridgeUnavailableError("bridge service unavailable");
    if (response.status === 404) return json({ error: "not_found" }, 404);
    if (!response.ok) return json({ error: "invalid_request" }, response.status === 400 || response.status === 413 || response.status === 422 ? 400 : 503);
    return json(route.upstreamPath === `${KAMAKURA_EDITOR_UPSTREAM_PREFIX}/catalog` ? sanitizeKamakuraCatalog(value) : value, response.status);
  } catch { throw new BridgeUnavailableError("bridge request failed"); }
  finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); }
}

async function editorApi(request: Request, env: Env, identity: AccessIdentity, url: URL, projectId: string, siteId: string, action: string): Promise<Response> {
  if (url.href.includes("?")) return json({ error: "invalid_request" }, 400);
  const experience = projectId === EDITOR_PROJECT_ID && siteId === EDITOR_SITE_ID;
  const kamakura = projectId === KAMAKURA_EDITOR_PROJECT_ID && siteId === KAMAKURA_EDITOR_SITE_ID;
  if (!experience && !kamakura) return json({ error: "not_found" }, 404);
  const route = experience ? experienceEditorRoute(action, request.method) : kamakuraEditorRoute(action, request.method);
  if (route === null) return json({ error: "not_found" }, 404);
  if (route === "method_not_allowed") return json({ error: "method_not_allowed" }, 405);
  if (!await editorMember(env, identity, projectId, siteId)) return json({ error: "forbidden" }, 403);
  try { return experience ? await signedEditorRequest(request, env, identity, route) : await signedKamakuraEditorRequest(request, env, identity, route); }
  catch (error) {
    if (error instanceof AuthenticationError) return json({ error: "invalid_request" }, 400);
    throw error;
  }
}

function withStaticSecurity(response: Response, editor = false): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'${editor ? " 'unsafe-inline'" : ""}; img-src 'self' https:; connect-src 'self'; font-src 'self';${editor ? " frame-src 'self';" : ""} frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function scopedApi(request: Request, env: Env, identity: AccessIdentity, url: URL): Promise<Response | null> {
  const match = /^\/api\/projects\/([A-Za-z][A-Za-z0-9_-]{0,79})\/sites\/([A-Za-z][A-Za-z0-9_-]{0,79})(\/[^?]*)?$/u.exec(url.pathname);
  if (!match) return null;
  const projectId = match[1]!;
  const siteId = match[2]!;
  const action = match[3] ?? "";
  if (action === "/editor" || action.startsWith("/editor/")) return editorApi(request, env, identity, url, projectId, siteId, action);
  if (request.method === "GET") {
    if (action === "/dashboard") return dashboard(env, identity, projectId, siteId);
    if (action === "/membership") return membershipAdministration(env, identity, projectId, siteId);
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await enforceMutationBoundary(request); }
  catch { return json({ error: "invalid_request" }, 400); }
  try {
    if (action === "/invitations") return await createInvitation(request, env, identity, projectId, siteId, body);
    if (action === "/invitations/preview") return await invitationPreview(env, identity, projectId, siteId, body);
    if (action === "/invitations/accept") return await acceptInvitation(env, identity, projectId, siteId, body);
    if (action === "/invitations/revoke") return await revokeInvitation(env, identity, projectId, siteId, body);
    if (action === "/members/role") return await changeMemberRole(env, identity, projectId, siteId, body);
    if (action === "/members/remove") return await removeMember(env, identity, projectId, siteId, body);
  } catch (error) {
    if (error instanceof InvalidInputError) return json({ error: "invalid_request" }, 400);
    throw error;
  }
  return json({ error: "not_found" }, 404);
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

  if (isApi) {
    if (request.method === "GET" && url.pathname === "/api/session") return json({ status: "authenticated", subject: identity.subject, email: identity.email });
    if (request.method === "GET" && url.pathname === "/api/projects") return directory(env, identity);
    const scoped = await scopedApi(request, env, identity, url);
    if (scoped) return scoped;
    return json({ error: request.method === "GET" ? "not_found" : "method_not_allowed" }, request.method === "GET" ? 404 : 405);
  }

  if (request.method !== "GET" && request.method !== "HEAD") return htmlError("この操作は利用できません。", 405);
  const isEditor = /^\/projects\/(?:project-experience\/sites\/experience|project-kamakura\/sites\/kamakura)\/editor\/?$/u.test(url.pathname);
  if (url.pathname === "/" || /^\/projects\/[A-Za-z][A-Za-z0-9_-]{0,79}\/sites\/[A-Za-z][A-Za-z0-9_-]{0,79}\/?$/u.test(url.pathname) || /^\/projects\/[A-Za-z][A-Za-z0-9_-]{0,79}\/sites\/[A-Za-z][A-Za-z0-9_-]{0,79}\/invite\/?$/u.test(url.pathname) || isEditor) {
    const indexUrl = new URL("/index.html", url);
    return withStaticSecurity(await env.ASSETS.fetch(new Request(indexUrl, { method: request.method, headers: request.headers })), isEditor);
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
