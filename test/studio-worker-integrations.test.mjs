import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function accessFixture() {
  const issuer = "https://frozen-editor-test.example", audience = "frozen-editor-test", subject = "frozen-editor-subject", kid = "frozen-editor-key";
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encode = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: subject, email: "editor@example.test", type: "app", exp: now + 300, iat: now })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return { issuer, audience, subject, jwt: `${input}.${Buffer.from(signature).toString("base64url")}`, jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" } };
}

test("known editor HTML and APIs stay authenticated but frozen without upstream calls", async (t) => {
  const auth = await accessFixture();
  const bundled = await build({ entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  const workerSource = bundled.outputFiles[0].text;
  for (const forbidden of ["https://api.niho.life", "https://api-stg.niho.life", "/internal/studio/web-content"]) assert.equal(workerSource.includes(forbidden), false, forbidden);
  const worker = (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`)).default;
  const roles = new Map(), upstream = [], assets = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === `${auth.issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [auth.jwk] });
    upstream.push(String(url));
    return Response.json({ shouldNotBeCalled: true });
  });
  const env = {
    ACCESS_ISSUER: auth.issuer,
    ACCESS_AUDIENCE: auth.audience,
    DB: { prepare(query) { return { bind(...values) { this.values = values; return this; }, async first() { const role = roles.get(`${this.values[1]}/${this.values[2]}`); return role && (!/m\.role = 'owner'/u.test(query) || role === "owner") ? { allowed: 1 } : null; } }; } },
    ASSETS: { async fetch(request) { assets.push(request.url); return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html" } }); } },
    KAMAKURA_SITE: { async fetch(request) { upstream.push(request.url); return Response.json({ shouldNotBeCalled: true }); } },
  };
  const call = (path, options = {}) => worker.fetch(new Request(`https://studio.niho.life${path}`, { ...options, headers: { "Cf-Access-Jwt-Assertion": auth.jwt, ...options.headers } }), env);
  const experience = "/api/projects/project-experience/sites/experience";
  const kamakura = "/api/projects/project-kamakura/sites/kamakura";

  assert.equal((await worker.fetch(new Request(`https://studio.niho.life${experience}/editor/sites`), env)).status, 401);
  assert.equal((await call(`${experience}/editor/sites`)).status, 403);
  roles.set("project-experience/experience", "editor");
  roles.set("project-kamakura/kamakura", "editor");
  for (const path of [`${experience}/editor/sites`, `${experience}/editor/sites/experience/pages/home/en`, `${kamakura}/editor/catalog`, `${kamakura}/editor/kamakura-home`]) {
    const response = await call(path);
    assert.equal(response.status, 409, path);
    assert.equal((await response.json()).error, "visual_editor_frozen");
  }
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 403);
  roles.set("project-experience/experience", "owner");
  assert.equal((await call(`${experience}/editor-staging/sites`)).status, 409);
  for (const path of [
    "/projects/project-experience/sites/experience/editor",
    "/projects/niho-experience/admin/editor",
    "/projects/project-experience/sites/experience/editor/staging",
    "/projects/niho-experience/admin/editor/staging",
    "/projects/project-kamakura/sites/kamakura/editor",
    "/projects/kamakura-site/admin/editor",
  ]) assert.equal((await call(path)).status, 200, path);
  assert.equal((await call("/api/session")).status, 200);
  assert.equal(upstream.length, 0);
  assert.ok(assets.length >= 6);
});

test("Studio client bundle excludes active editor implementations", async () => {
  const result = await build({ entryPoints: [new URL("../studio/client.tsx", import.meta.url).pathname], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, define: { "process.env.NODE_ENV": '"production"' } });
  const inputs = Object.keys(result.metafile.inputs);
  for (const pattern of [/studio\/integration-entry\.tsx$/u, /studio\/experience-editor\.tsx$/u, /studio\/kamakura-editor\.tsx$/u, /src\/editor\.tsx$/u]) {
    assert.equal(inputs.some((input) => pattern.test(input)), false, pattern.source);
  }
});
