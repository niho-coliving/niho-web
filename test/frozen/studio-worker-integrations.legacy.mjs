// Frozen editor integration coverage retained outside the active test glob.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createTrustedIntegrationRegistry, isTrustedEditorAction } from "../../studio/integration-registry.mjs";

test("the scoped API entrance follows registered prefixes, including a new integration namespace", () => {
  const registry = createTrustedIntegrationRegistry([{
    projectId: "project-atelier", siteId: "atelier", aliases: [],
    environments: { production: { editorPathSuffix: "", apiPrefix: "/design" } }
  }]);
  assert.equal(registry.isEditorAction("/design"), true);
  assert.equal(registry.isEditorAction("/design/document"), true);
  assert.equal(registry.isEditorAction("/designer/document"), false);
  assert.equal(registry.resolveApi("project-atelier", "atelier", "/design/document")?.registration.siteId, "atelier");
  assert.equal(isTrustedEditorAction("/editor/sites"), true);
  assert.equal(isTrustedEditorAction("/editor-staging/sites"), true);
  assert.equal(isTrustedEditorAction("/unregistered/sites"), false);
});

test("registered Worker integrations retain JWT, membership, staging owner, signing and CSP boundaries", async (t) => {
  const issuer = "https://builder-worker-test.example", audience = "builder-worker-test";
  const subject = "builder-regression-subject", kid = "builder-worker-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "builder-regression@example.test", type: "app", exp: now + 300, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  const jwt = `${input}.${Buffer.from(signature).toString("base64url")}`;
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" };
  const bundled = await build({ entryPoints: [new URL("../../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
  const roles = new Map(), calls = [], assetCalls = [], bindings = [];
  let redirect = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    assert.ok(["https://api.niho.life", "https://api-stg.niho.life"].includes(new URL(url).origin));
    calls.push({ url: String(url), options });
    return redirect ? new Response(null, { status: 302, headers: { Location: "https://untrusted.example/" } }) : Response.json({ accepted: true });
  });
  t.mock.method(console, "error", () => {});
  const productionSecret = Buffer.alloc(32, 11), stagingSecret = Buffer.alloc(32, 19);
  const env = {
    ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: audience,
    NIHO_STUDIO_BRIDGE_SECRET: productionSecret.toString("base64url"),
    NIHO_STUDIO_BRIDGE_SECRET_STG: stagingSecret.toString("base64url"),
    KAMAKURA_STUDIO_BRIDGE_SECRET: Buffer.alloc(32, 23).toString("base64url"),
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() {
      assert.match(query, /FROM project_members/u);
      assert.equal(this.values[0], subject);
      bindings.push(this.values);
      const role = roles.get(`${this.values[1]}/${this.values[2]}`), ownerOnly = /m\.role = 'owner'/u.test(query);
      return role && (!ownerOnly || role === "owner") ? { allowed: 1 } : null;
    } }; } },
    ASSETS: { async fetch(request) { assetCalls.push(request.url); return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
    KAMAKURA_SITE: { async fetch(request) { calls.push({ url: request.url, options: { headers: Object.fromEntries(request.headers), method: request.method } }); return Response.json({ accepted: true }); } }
  };
  const call = (path, options = {}) => worker.fetch(new Request(`https://studio.niho.life${path}`, { ...options, headers: { "Cf-Access-Jwt-Assertion": jwt, ...options.headers } }), env);
  const experience = "/api/projects/project-experience/sites/experience";
  const kamakura = "/api/projects/project-kamakura/sites/kamakura";

  const unauthenticated = await worker.fetch(new Request(`https://studio.niho.life${experience}/editor/sites`), env);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await call(`${experience}/editor/sites`)).status, 403);
  assert.equal(calls.length, 0);
  roles.set("project-experience/experience", "editor");
  assert.equal((await call(`${experience}/editor/sites`)).status, 200);
  assert.equal(calls[0].url, "https://api.niho.life/api/internal/studio/experience/sites");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.headers["X-NIHO-Studio-Project"], "project-experience");
  assert.equal(calls[0].options.headers["X-NIHO-Studio-Subject"], subject);
  const verify = async (entry, secret) => {
    const headers = entry.options.headers, path = new URL(entry.url).pathname;
    const body = entry.options.body ?? new Uint8Array();
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
    const message = `v1\n${headers["X-NIHO-Studio-Timestamp"]}\n${entry.options.method}\n${path}\n${digest}\nproject-experience\n${subject}`;
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))).toString("hex");
    assert.equal(headers["X-NIHO-Studio-Signature"], `v1=${expected}`);
  };
  await verify(calls[0], productionSecret);
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 403);
  for (const path of ["/projects/project-experience/sites/experience/editor/staging", "/projects/niho-experience/admin/editor/staging"]) assert.equal((await call(path)).status, 403);
  assert.equal(calls.length, 1);
  assert.equal(assetCalls.length, 0);
  roles.set("project-experience/experience", "owner");
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 200);
  assert.equal(calls[1].url, "https://api-stg.niho.life/api/internal/studio/experience/sites");
  await verify(calls[1], stagingSecret);
  const stagingPage = await call("/projects/niho-experience/admin/editor/staging");
  assert.equal(stagingPage.status, 200);
  assert.match(stagingPage.headers.get("Content-Security-Policy"), /connect-src 'self';/u);
  assert.match(stagingPage.headers.get("Content-Security-Policy"), /frame-src 'self';/u);
  assert.doesNotMatch(stagingPage.headers.get("Content-Security-Policy"), /next-kamakura/u);
  assert.doesNotMatch(stagingPage.headers.get("Content-Security-Policy"), /kamakura-media/u);

  assert.equal((await call(`${kamakura}/editor/kamakura-home`)).status, 403);
  assert.equal((await call(`${kamakura}/editor/assets/00000000-0000-4000-8000-000000000001/preview`)).status, 403);
  roles.set("project-kamakura/kamakura", "editor");
  assert.equal((await call(`${kamakura}/editor/kamakura-home`)).status, 200);
  assert.equal(calls[2].url, "https://next-kamakura.niho.life/internal/studio/web-content/kamakura-home");
  const kamakuraPage = await call("/projects/kamakura-site/admin/editor");
  assert.equal(kamakuraPage.status, 200);
  assert.match(kamakuraPage.headers.get("Content-Security-Policy"), /connect-src 'self' https:\/\/next-kamakura\.niho\.life;/u);
  assert.match(kamakuraPage.headers.get("Content-Security-Policy"), /font-src 'self' https:\/\/kamakura-media\.niho\.life\/niho-web\/fonts\/v1\//u);
  assert.match(kamakuraPage.headers.get("Content-Security-Policy"), /frame-src 'self' https:\/\/kamakura-media\.niho\.life\/niho-web\/embeds\/v1\/ https:\/\/www\.google\.com\/maps\/embed;/u);
  assert.ok(bindings.some((values) => values[1] === "project-kamakura" && values[2] === "kamakura"));

  const before = calls.length;
  assert.equal((await call("/api/projects/project-experience/sites/kamakura/editor/sites")).status, 404);
  assert.equal((await call(`${kamakura}/editor-staging/catalog`)).status, 404);
  assert.equal((await call(`${experience}/editor/sites?upstream=https://untrusted.example`)).status, 400);
  assert.equal((await call(`${experience}/editor/sites`, { method: "POST" })).status, 405);
  assert.equal((await call(`${experience}/editor/sites/experience/pages/home/en/draft`, { method: "PUT", headers: { Origin: "https://untrusted.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, body: "{}" })).status, 400);
  assert.equal(calls.length, before);
  const unknownPage = await call("/projects/project-unknown/sites/unknown/editor");
  assert.doesNotMatch(unknownPage.headers.get("Content-Security-Policy"), /frame-src|'unsafe-inline'/u);
  redirect = true;
  assert.equal((await call(`${experience}/editor/sites`)).status, 503);
});
