import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const output = await build({ entryPoints: [fileURLToPath(new URL("./localization-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = output.outputFiles[0].text;
const picture = (accent, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 700"><rect width="1200" height="700" fill="#e9efe9"/><circle cx="900" cy="260" r="210" fill="${accent}"/><path d="M0 510 Q300 420 600 520 T1200 500 V700 H0Z" fill="#78a8a4"/><text x="55" y="90" font-family="sans-serif" font-size="38" fill="#17382d">${label}</text></svg>`;
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web 多言語エディターデモ</title></head><body style="margin:0;background:#eef1ed"><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer((request, response) => {
  if (request.url === "/media/main.svg" || request.url === "/media/localized.svg") { response.setHeader("Content-Type", "image/svg+xml; charset=utf-8"); response.end(picture(request.url.includes("localized") ? "#d79e67" : "#91b899", request.url.includes("localized") ? "Localized demo asset" : "Source demo asset")); return; }
  if (!["/", "/app.js"].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(request.url === "/app.js" ? script : html);
}).listen(4176, "127.0.0.1", () => console.log("Localization demo: http://127.0.0.1:4176"));
