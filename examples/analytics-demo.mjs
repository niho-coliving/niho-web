import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const output = await build({ entryPoints: [fileURLToPath(new URL("./analytics-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = output.outputFiles[0].text;
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web サイト分析デモ</title></head><body style="margin:0;padding:16px;background:#eef1ed"><p style="font:13px sans-serif">固定の合成データによるデモです。実サイト、認証情報、GA4 / Search Console API には接続しません。</p><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer((request, response) => {
  if (!["/", "/app.js"].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(request.url === "/app.js" ? script : html);
}).listen(4175, "127.0.0.1", () => console.log("Analytics demo: http://127.0.0.1:4175"));
