// 凍結前の上流接続テスト。現在のCIでは実行せず、再接続時の資料として保持する。
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

async function loadKamakuraCatalogContract() {
  const result = await build({
    entryPoints: [new URL("../../studio/kamakura-catalog.ts", import.meta.url).pathname],
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
    entryPoints: [new URL("../../studio/worker.ts", import.meta.url).pathname],
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
    legacy: [{ name: "home", path: "/" }],
    blockContracts: {
      KamakuraLegacyForm: {
        props: { formId: { type: "enum", values: ["community-dinner", "parenting", "remotework"] } },
        slots: {
          form: { label: "体験予約フォーム", style: ["backgroundColor", "color", "padding", "borderRadius"], data: { reason: "Kamakuraサイトの既存フォームが管理します。", source: "Kamakuraサイト" } },
          field: { label: "フォーム入力欄", style: ["backgroundColor", "color", "borderColor", "borderRadius", "padding"] },
          submit: { label: "送信ボタン", style: ["color", "backgroundColor", "borderRadius", "padding"] }
        }
      }
    }
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
  assert.equal(result.blockContracts.KamakuraLegacyForm.props.formId.values[0], "community-dinner");

  for (const invalid of [
    { ...catalog(), project: { id: "other-project", name: "NIHO kamakura", site: catalog().project.site } },
    catalog("unsafe\nname"),
    { ...catalog(), pages: [catalog().pages[0], catalog().pages[0]] },
    { ...catalog(), legacy: [{ name: "home", path: "/../admin" }] },
    { ...catalog(), blockContracts: {} },
    { ...catalog(), blockContracts: { constructor: { props: {} } } },
    { ...catalog(), blockContracts: { unsafe: { props: { field: { type: "unknown" } } } } },
    { ...catalog(), blockContracts: { unsafe: { props: {}, slots: { item: { label: "Unsafe", style: ["backgroundImage"] } } } } },
    { ...catalog(), blockContracts: { unsafe: { props: {}, slots: { item: { label: "Unsafe", data: { reason: "missing source" } } } } } }
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
  let bindingFailure = false;
  let bindingResponseFactory = null;
  const boundRequestIds = [];
  const bridgeLogs = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
    jwksReads += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", (...args) => { bridgeLogs.push(args); });

  const env = {
    DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ allowed: 1 }) }) },
    ASSETS: { fetch: async () => new Response("not expected", { status: 500 }) },
    KAMAKURA_SITE: { fetch: async (request) => {
      if (bindingFailure) throw new Error("binding failure detail must not be logged");
      boundRequestIds.push(request.headers.get("X-NIHO-Studio-Request-ID"));
      if (bindingResponseFactory) return bindingResponseFactory(request);
      return upstreamResponse;
    } },
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: audience,
    KAMAKURA_STUDIO_BRIDGE_SECRET: Buffer.alloc(32, 9).toString("base64url")
  };

  const callCatalog = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/catalog", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  }), env);
  const callPage = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/kamakura-community-dinner", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  }), env);
  const callAssetList = () => workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/assets/list", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json", Origin: "https://studio.niho.life", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ siteId: "kamakura", search: "", kind: "all", folderId: null, limit: 60 })
  }), env);

  const accepted = await callCatalog();
  assert.equal(accepted.status, 200);
  const acceptedCatalog = await accepted.json();
  assert.equal(acceptedCatalog.pages[0].title, communityDinnerTitle);
  assert.deepEqual(acceptedCatalog.blockContracts, catalog().blockContracts);
  assert.match(boundRequestIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);

  const assertFailure = async (response, { status, code, category, upstreamStatus, operation = "catalog" }) => {
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(body.error, code);
    assert.equal(JSON.stringify(body).includes(env.KAMAKURA_STUDIO_BRIDGE_SECRET), false);
    assert.equal(JSON.stringify(body).includes("catalog-contract-test"), false);
    assert.match(body.supportId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    const log = bridgeLogs.findLast(([, fields]) => fields.supportId === body.supportId);
    assert.ok(log, "the returned support ID must be present in Worker logs");
    assert.deepEqual(log[1], {
      supportId: body.supportId,
      operation,
      category,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus })
    });
    return body.supportId;
  };

  upstreamResponse = new Response(JSON.stringify(catalog("invalid\u0000title")), { headers: { "Content-Type": "application/json" } });
  const incompatible = await callCatalog();
  const incompatibleId = await assertFailure(incompatible, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200 });

  upstreamResponse = new Response("not-json", { headers: { "Content-Type": "text/plain" } });
  const malformed = await callCatalog();
  await assertFailure(malformed, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200 });

  upstreamResponse = new Response("{invalid json", { headers: { "Content-Type": "application/json" } });
  const invalidJson = await callCatalog();
  await assertFailure(invalidJson, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 200 });

  upstreamResponse = new Response(JSON.stringify({ error: "conflict" }), { status: 409, headers: { "Content-Type": "application/json" } });
  const unexpectedConflict = await callCatalog();
  await assertFailure(unexpectedConflict, { status: 502, code: contract.KAMAKURA_CATALOG_CONTRACT_ERROR_CODE, category: "upstream_contract_invalid", upstreamStatus: 409 });

  upstreamResponse = new Response("SENSITIVE_UPSTREAM_BODY", { status: 500 });
  const unavailable = await callCatalog();
  await assertFailure(unavailable, { status: 503, code: "service_unavailable", category: "upstream_server_error", upstreamStatus: 500 });

  upstreamResponse = new Response("ignored", { status: 401 });
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "upstream_auth_rejected", upstreamStatus: 401 });

  upstreamResponse = new Response("ignored", { status: 404 });
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "catalog_endpoint_missing", upstreamStatus: 404 });

  upstreamResponse = new Response("ignored", { status: 429 });
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "upstream_rate_limited", upstreamStatus: 429 });

  upstreamResponse = new Response("unexpected method", { status: 405 });
  await assertFailure(await callPage(), { status: 503, code: "service_unavailable", category: "upstream_unexpected_4xx", upstreamStatus: 405, operation: "page_read" });

  upstreamResponse = new Response("asset failure", { status: 500 });
  await assertFailure(await callAssetList(), { status: 503, code: "service_unavailable", category: "upstream_server_error", upstreamStatus: 500, operation: "asset_list" });

  bindingFailure = true;
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "service_binding_failed" });
  bindingFailure = false;

  t.mock.method(globalThis, "setTimeout", (callback) => { queueMicrotask(callback); return 1; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  bindingResponseFactory = (request) => new Response(new ReadableStream({
    start(controller) { request.signal.addEventListener("abort", () => controller.error(new Error("response body aborted")), { once: true }); }
  }), { headers: { "Content-Type": "application/json" } });
  await assertFailure(await callCatalog(), { status: 503, code: "service_unavailable", category: "service_binding_timeout" });
  bindingResponseFactory = null;

  const missingSecret = await workerModule.default.fetch(new Request("https://studio.niho.life/api/projects/project-kamakura/sites/kamakura/editor/catalog", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  }), { ...env, KAMAKURA_STUDIO_BRIDGE_SECRET: undefined });
  await assertFailure(missingSecret, { status: 503, code: "service_unavailable", category: "bridge_secret_missing_or_invalid" });

  const serializedLogs = JSON.stringify(bridgeLogs);
  assert.equal(serializedLogs.includes(env.KAMAKURA_STUDIO_BRIDGE_SECRET), false);
  assert.equal(serializedLogs.includes("catalog-contract-test"), false);
  assert.equal(serializedLogs.includes("SENSITIVE_UPSTREAM_BODY"), false);
  assert.equal(serializedLogs.includes("binding failure detail must not be logged"), false);
  assert.equal(serializedLogs.includes("response body aborted"), false);
  assert.equal(boundRequestIds.includes(incompatibleId), true, "the same support ID must cross the service binding");
  assert.equal(jwksReads, 1);
});
