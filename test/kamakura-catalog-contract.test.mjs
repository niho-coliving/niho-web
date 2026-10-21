import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function loadKamakuraCatalogContract() {
  const result = await build({
    entryPoints: [new URL("../studio/kamakura-catalog.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}

const contract = await loadKamakuraCatalogContract();
const communityDinnerTitle = "Kamakura: Community Dinner with Locals  | NIHO kamakura -- Shared living-room in Kamakura, where tourists and locals can get together";

async function loadStudioWorker() {
  const result = await build({
    entryPoints: [new URL("../studio/worker.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}

function base64url(value) {
  return Buffer.from(typeof value === "string" ? value : value).toString("base64url");
}

async function accessToken(pair, issuer, audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "catalog-contract-test", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: issuer, aud: audience, sub: "catalog-contract-test", email: "catalog-test@niho.life", type: "app", exp: now + 300, iat: now }));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${base64url(signature)}`;
}

function catalog(pageTitle = "NIHO Kamakura") {
  const site = { id: "kamakura", name: "鎌倉サイト（新サイト確認用）", domains: ["https://next-kamakura.niho.life"] };
  return {
    project: { id: "kamakura-site", name: "NIHO kamakura", site },
    sites: [site],
    pages: [{ siteId: "kamakura", pageId: "kamakura-community-dinner", locale: "ja", title: pageTitle }],
    legacy: [{ name: "home", path: "/" }]
  };
}

test("shared catalog contract accepts the current 133-character page title", () => {
  assert.equal(communityDinnerTitle.length, 133);
  const result = contract.parseKamakuraCatalog(catalog(communityDinnerTitle));
  assert.equal(result.pages[0].title, communityDinnerTitle);
  assert.deepEqual(result.pages[0], {
    siteId: "kamakura",
    pageId: "kamakura-community-dinner",
    locale: "ja",
    title: communityDinnerTitle
  });
});

test("shared catalog contract normalizes known fields and rejects unsafe or mismatched data", () => {
  const extended = catalog();
  extended.unexpected = "ignored";
  extended.pages[0].untrusted = "ignored";
  const result = contract.parseKamakuraCatalog(extended);
  assert.equal("unexpected" in result, false);
  assert.equal("untrusted" in result.pages[0], false);

  for (const invalid of [
    { ...catalog(), project: { id: "other-project", name: "NIHO kamakura", site: catalog().project.site } },
    catalog("unsafe\nname"),
    { ...catalog(), pages: [catalog().pages[0], catalog().pages[0]] },
    { ...catalog(), legacy: [{ name: "home", path: "/../admin" }] }
  ]) {
    assert.throws(
      () => contract.parseKamakuraCatalog(invalid),
      (error) => error instanceof contract.KamakuraCatalogContractError && error.code === contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE
    );
  }
  assert.equal(contract.KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS, 502);
});

test("shared catalog contract keeps collection limits at the bridge boundary", () => {
  const tooManyPages = { ...catalog(), pages: Array.from({ length: 501 }, (_, index) => ({ siteId: "kamakura", pageId: `page-${index}`, locale: "ja", title: "Page" })) };
  assert.throws(
    () => contract.parseKamakuraCatalog(tooManyPages),
    (error) => error instanceof contract.KamakuraCatalogContractError
  );
});

test("Kamakura Worker accepts valid long titles and separates contract errors from unavailable upstream", async (t) => {
  const issuer = "https://catalog-contract-test.example";
  const audience = "catalog-contract-test-audience";
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "catalog-contract-test", alg: "RS256", use: "sig" };
  const token = await accessToken(pair, issuer, audience);
  const workerModule = await loadStudioWorker();
  let upstreamResponse = new Response(JSON.stringify(catalog(communityDinnerTitle)), { headers: { "Content-Type": "application/json" } });
  let jwksReads = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
    jwksReads += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
  });
  t.mock.method(console, "error", () => {});

  const env = {
    DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ allowed: 1 }) }) },
    ASSETS: { fetch: async () => new Response("not expected", { status: 500 }) },
    KAMAKURA_SITE: { fetch: async () => upstreamResponse },
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: Buffer.alloc(32, 9).toString("base64url")
  };

  const callCatalog = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/catalog", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  }), env);

  const accepted = await callCatalog();
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).pages[0].title, communityDinnerTitle);

  upstreamResponse = new Response(JSON.stringify(catalog("invalid\u0000title")), { headers: { "Content-Type": "application/json" } });
  const incompatible = await callCatalog();
  assert.equal(incompatible.status, contract.KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS);
  assert.deepEqual(await incompatible.json(), { error: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE });

  upstreamResponse = new Response("not-json", { headers: { "Content-Type": "text/plain" } });
  const malformed = await callCatalog();
  assert.equal(malformed.status, contract.KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS);
  assert.deepEqual(await malformed.json(), { error: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE });

  upstreamResponse = new Response("{invalid json", { headers: { "Content-Type": "application/json" } });
  const invalidJson = await callCatalog();
  assert.equal(invalidJson.status, contract.KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS);
  assert.deepEqual(await invalidJson.json(), { error: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE });

  upstreamResponse = new Response(JSON.stringify({ error: "conflict" }), { status: 409, headers: { "Content-Type": "application/json" } });
  const unexpectedConflict = await callCatalog();
  assert.equal(unexpectedConflict.status, contract.KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS);
  assert.deepEqual(await unexpectedConflict.json(), { error: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE });

  upstreamResponse = new Response("upstream failure", { status: 500 });
  const unavailable = await callCatalog();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "service_unavailable" });
  assert.equal(jwksReads, 1);
});
