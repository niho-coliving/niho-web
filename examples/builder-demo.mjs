import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { ATELIER_TARGET, createAtelierHost } from "./atelier-builder-host.mjs";

const output = await build({
  entryPoints: [fileURLToPath(new URL("./builder-demo.tsx", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' }
});
const script = output.outputFiles[0]?.text;
if (!script) throw new Error("builder demo build produced no output");
const host = createAtelierHost();
const port = Number(process.env.PORT) || 4177;
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atelier Moku — 汎用ビルダー demo</title><style>html,body,#root{margin:0;min-height:100%;background:#ece9e5}body{font-family:Inter,"Noto Sans JP",sans-serif}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" role="img" aria-label="木の道具と器が並ぶアトリエ"><rect width="1200" height="675" fill="#e9ddcf"/><rect y="430" width="1200" height="245" fill="#a77b59"/><circle cx="260" cy="360" r="145" fill="#c98c64"/><circle cx="260" cy="360" r="92" fill="#f3e6d6"/><path d="M650 150h55v350h-55zM740 100h42v400h-42zM830 190h68v310h-68z" fill="#694b38"/><path d="M585 500h380l-60 92H640z" fill="#d9b58e"/></svg>';

function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declared) || declared > 1_000_000 || String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new Error("invalid JSON request");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request too large");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
  return value;
}

function queryTarget(url) {
  if ([...url.searchParams.keys()].some((key) => !["siteId", "pageId", "locale"].includes(key))) throw new Error("invalid query");
  return { siteId: url.searchParams.get("siteId"), pageId: url.searchParams.get("pageId"), locale: url.searchParams.get("locale") };
}

createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); return; }
    if (request.method === "GET" && url.pathname === "/app.js") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }); response.end(script); return; }
    if (request.method === "GET" && url.pathname === "/atelier-image.svg") { response.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(svg); return; }
    if (request.method === "GET" && url.pathname === "/preview") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Atelier preview</title></head><body>${host.renderDraft()}</body></html>`); return; }
    if (request.method === "GET" && url.pathname === "/api/sites" && !url.search) { json(response, host.listSites()); return; }
    if (request.method === "GET" && url.pathname === "/api/pages" && [...url.searchParams.keys()].every((key) => key === "siteId")) { json(response, host.listPages(url.searchParams.get("siteId"))); return; }
    if (request.method === "GET" && url.pathname === "/api/document") { json(response, host.readDocument(queryTarget(url))); return; }
    if (request.method === "PUT" && url.pathname === "/api/document" && !url.search) { json(response, host.saveDraft(await body(request))); return; }
    if (request.method === "GET" && url.pathname === "/api/components" && [...url.searchParams.keys()].every((key) => key === "siteId")) { json(response, host.readLibrary(url.searchParams.get("siteId"))); return; }
    if (request.method === "PUT" && url.pathname === "/api/components" && !url.search) { json(response, host.saveLibrary(await body(request))); return; }
    if (request.method === "GET" && url.pathname === "/api/components/usage" && [...url.searchParams.keys()].every((key) => key === "siteId")) { json(response, host.listUsage(url.searchParams.get("siteId"))); return; }
    if (request.method === "POST" && url.pathname === "/api/release-plan" && !url.search) { json(response, host.prepareRelease(await body(request))); return; }
    if (request.method === "POST" && url.pathname === "/api/release" && !url.search) { json(response, host.release(await body(request))); return; }
    json(response, { error: "not_found" }, 404);
  })().catch((error) => json(response, { error: error instanceof Error ? error.message : "invalid_request" }, 400));
}).listen(port, "127.0.0.1", () => console.log(`Builder demo: http://127.0.0.1:${port} (${ATELIER_TARGET.siteId})`));
