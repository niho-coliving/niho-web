import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
const output = await build({ entryPoints: [fileURLToPath(new URL("./projects-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const script = output.outputFiles[0].text;
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web プロジェクト一覧・ダッシュボード</title></head><body style="margin:0;padding:12px;background:#eef1ed"><details style="font:13px sans-serif;margin:0 0 12px"><summary>合成データのデモについて</summary><p>変更はメモリ内だけに反映され、再起動でリセットします。表示日時・解析値・画像は合成値です。実サイトには接続しません。開いたエディターは一覧へ戻っても保持します。</p><p>メンバー照合の入力例: <code>demo-shared</code> / <code>demo-editor</code></p></details><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const preview = (draft) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="${draft ? "#ecdfce" : "#dce9de"}"/><rect width="640" height="40" fill="#fff"/><rect x="28" y="16" width="65" height="8" rx="4" fill="#195640"/><rect x="430" y="16" width="160" height="8" rx="4" fill="#dce2dd"/><circle cx="470" cy="190" r="100" fill="${draft ? "#cbb792" : "#9cbaa2"}"/><rect x="42" y="130" width="230" height="24" rx="8" fill="#195640"/><rect x="42" y="172" width="190" height="10" rx="5" fill="#5b6d61"/><rect x="42" y="194" width="150" height="10" rx="5" fill="#5b6d61"/><rect x="42" y="232" width="105" height="30" rx="6" fill="#195640"/></svg>`;
createServer((request, response) => {
  if (["/preview-public.svg", "/preview-draft.svg"].includes(request.url)) { response.setHeader("Content-Type", "image/svg+xml; charset=utf-8"); response.end(preview(request.url.includes("draft"))); return; }
  if (!["/", "/app.js"].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(request.url === "/app.js" ? script : html);
}).listen(4174, "127.0.0.1", () => console.log("Projects demo: http://127.0.0.1:4174"));
