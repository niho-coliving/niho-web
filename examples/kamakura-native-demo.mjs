import { build } from "esbuild";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePageDocument, parseSitePresentation, presentationAssetDocument } from "../dist/core.js";
import { uniqueAssetReferences } from "../dist/assets.js";
import { renderSitePageToHtml } from "../dist/server.js";

const libraryRoot = resolve(new URL("..", import.meta.url).pathname);
if (!process.env.KAMAKURA_SITE_FIXTURE) throw new Error("KAMAKURA_SITE_FIXTURE must point to the Kamakura site checkout");
const siteRoot = resolve(process.env.KAMAKURA_SITE_FIXTURE);
const json = (path) => JSON.parse(readFileSync(resolve(siteRoot, path), "utf8"));
const document = parsePageDocument(json("src/site/niho-web/business-plan.json"));
const { nativePageIds: _nativePageIds, ...config } = json("src/site/niho-web-presentation.json"), fonts = json("src/site/niho-web-fonts.json");
const presentation = parseSitePresentation({ ...config, version: `${config.version}:local-fixture`, fonts, shared: {
  header: json("src/site/niho-web/shared-header.json"), footer: json("src/site/niho-web/shared-footer.json"),
}, overlays: config.overlays.map(({ pageId, ...overlay }) => ({ ...overlay, document: json(`src/site/niho-web/${pageId}.json`) })) }, document);
const decode = (id) => Buffer.from(id.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - id.length % 4) % 4), "base64").toString("utf8");
const assets = Object.fromEntries(uniqueAssetReferences(presentationAssetDocument(document, presentation)).map((reference) => {
  if (reference.provider !== "kamakura-studio") throw new Error(`fixture asset provider is not supported: ${reference.provider}`);
  const key = decode(reference.id);
  if (!/^[A-Za-z0-9._~-]{1,300}$/.test(key)) throw new Error("fixture asset ID is invalid");
  const width = Math.min(2048, Number(/^s-(\d+)x/.exec(key)?.[1] ?? 2048));
  return [`${reference.provider}:${reference.id}`, { src: `https://kamakura-media.niho.life/cdn-cgi/image/width=${width},format=auto/studio/design-asset-files/${encodeURIComponent(key)}` }];
}));
const output = await build({ entryPoints: [fileURLToPath(new URL("./kamakura-native-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', KAMAKURA_DEMO_DOCUMENT: JSON.stringify(document), KAMAKURA_DEMO_PRESENTATION: JSON.stringify(presentation), KAMAKURA_DEMO_ASSETS: JSON.stringify(assets) } });
const script = output.outputFiles[0].text, port = Number(process.env.PORT) || 4177;
const runtime = (await build({ stdin: { contents: 'import { initializeSitePresentation } from "./src/presentation-runtime.js"; initializeSitePresentation(document);', resolveDir: libraryRoot }, bundle: true, write: false, format: "iife" })).outputFiles[0].text;
if (process.argv.includes("--check")) {
  const ssr = renderSitePageToHtml(document, presentation, {}, { assets });
  if (!ssr.includes("法人・団体向け") || !ssr.includes("data-nw-presentation-header") || !ssr.includes("background-image:url") || !ssr.includes('data-nw-overlay="niho-site-menu"') || !ssr.includes("遊びに行ってみる")) throw new Error("native fixture build check failed");
  console.log(`Kamakura native fixture build ok: ${Math.round(script.length / 1024)} KiB / ${ssr.length} SSR chars / ${Object.keys(assets).length} assets`);
  process.exit(0);
}
const shell = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kamakura business-plan native fixture</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  if (url.pathname === "/app.js") { response.setHeader("Content-Type", "text/javascript; charset=utf-8"); response.end(script); return; }
  if (url.pathname === "/studio-placeholder.svg") { response.setHeader("Content-Type", "image/svg+xml"); response.end(readFileSync(resolve(siteRoot, "public/studio-placeholder.svg"))); return; }
  if (url.pathname === "/ssr") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">${renderSitePageToHtml(document, presentation, {}, { assets })}<script>${runtime}</script></body></html>`); return;
  }
  if (url.pathname !== "/") { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(shell);
}).listen(port, "127.0.0.1", () => console.log(`Kamakura native fixture: http://127.0.0.1:${port}`));
