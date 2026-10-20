import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
const output = await build({ entryPoints: [fileURLToPath(new URL("./projects-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = output.outputFiles[0].text;
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web プロジェクト管理</title></head><body style="margin:0;padding:20px;background:#eef1ed"><p style="font:13px sans-serif">合成データによる公開用デモです。変更はメモリ内だけに反映され、再起動するとリセットします。本番には認証済みstorage adapterが別途必要です。</p><p style="font:13px sans-serif">メンバー照合の入力例: <code>demo-shared</code> / <code>demo-editor</code></p><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
createServer((request, response) => {
  if (!["/", "/app.js"].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(request.url === "/app.js" ? script : html);
}).listen(4174, "127.0.0.1", () => console.log("Projects demo: http://127.0.0.1:4174"));
