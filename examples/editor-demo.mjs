import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

// 素材はメモリ内だけに保持する。種類と上限はブラウザの事前確認とは別にここでも検査する。
const assetTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "application/pdf"]), maxBytes = 5 * 1024 * 1024;
const assets = new Map();
function png(width, height, paint) {
  const stride = width * 3 + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x / width, y / height), offset = y * stride + 1 + x * 3;
    raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1"); tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((value, index) => Math.round(value + (b[index] - value) * t));
const inCircle = (x, y, cx, cy, r) => Math.hypot((x - cx) * 1.5, y - cy) < r;
const scenes = {
  sea: (x, y) => inCircle(x, y, 0.7, 0.4, 0.09) ? [255, 214, 130] : y < 0.55 ? mix([150, 205, 238], [248, 218, 178], y / 0.55) : y < 0.85 ? mix([52, 132, 170], [26, 88, 122], (y - 0.55) / 0.3) : [232, 212, 168],
  living: (x, y) => x > 0.62 && x < 0.88 && y > 0.14 && y < 0.44 ? [206, 231, 244] : x > 0.18 && x < 0.66 && y > 0.5 && y < 0.76 ? (y < 0.58 ? [93, 128, 108] : [107, 143, 122])
    : inCircle(x, y, 0.82, 0.62, 0.05) ? [246, 214, 140] : y > 0.74 ? mix([190, 146, 102], [160, 118, 80], (y - 0.74) / 0.26) : [240, 232, 218],
  garden: (x, y) => y > 0.6 && Math.abs(x - 0.5 - (y - 1) * 0.2) < 0.06 + (y - 0.6) * 0.15 ? [222, 205, 170] : inCircle(x, y, 0.22, 0.52, 0.16) || inCircle(x, y, 0.78, 0.48, 0.18) ? [48, 104, 64]
    : y < 0.42 ? mix([196, 226, 240], [222, 238, 226], y / 0.42) : mix([128, 186, 116], [62, 122, 74], (y - 0.42) / 0.58)
};
function pdf(text) {
  const content = `BT /F1 28 Tf 72 740 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
/** PNG・JPEG・WebP・GIF のヘッダーから寸法を読む。読めなければ寸法なし。 */
function dimensions(type, body) {
  let size;
  try {
    if (type === "image/png" && body.toString("latin1", 12, 16) === "IHDR") size = { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
    else if (type === "image/gif" && body.toString("latin1", 0, 3) === "GIF") size = { width: body.readUInt16LE(6), height: body.readUInt16LE(8) };
    else if (type === "image/webp" && body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", 8, 12) === "WEBP") {
      const format = body.toString("latin1", 12, 16);
      if (format === "VP8X") size = { width: 1 + body.readUIntLE(24, 3), height: 1 + body.readUIntLE(27, 3) };
      else if (format === "VP8 ") size = { width: body.readUInt16LE(26) & 0x3fff, height: body.readUInt16LE(28) & 0x3fff };
      else if (format === "VP8L") { const bits = body.readUInt32LE(21); size = { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    } else if (type === "image/jpeg" && body[0] === 0xff && body[1] === 0xd8) {
      for (let offset = 2; offset + 9 < body.length;) {
        if (body[offset] !== 0xff) { offset++; continue; }
        const marker = body[offset + 1];
        if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += marker === 0xff ? 1 : 2; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { size = { height: body.readUInt16BE(offset + 5), width: body.readUInt16BE(offset + 7) }; break; }
        offset += 2 + body.readUInt16BE(offset + 2);
      }
    }
  } catch { size = undefined; }
  return size && [size.width, size.height].every((value) => Number.isInteger(value) && value >= 1 && value <= 100000) ? size : {};
}
const seed = [];
function addSeed(id, name, type, body, extra) {
  const src = `/demo-assets/${id}`;
  assets.set(id, { type, body });
  seed.push({ id, name, mimeType: type, bytes: body.length, ...dimensions(type, body), src, ...(type.startsWith("image/") ? { thumbnailUrl: src } : {}), ...extra });
}
addSeed("seed-sea", "海辺の朝.png", "image/png", png(600, 400, scenes.sea), { alt: "朝の海辺の景色", folderId: "photos" });
addSeed("seed-living", "リビング.png", "image/png", png(600, 400, scenes.living), { alt: "明るいリビング", folderId: "photos" });
addSeed("seed-garden", "庭の緑.png", "image/png", png(600, 400, scenes.garden), { alt: "庭の緑", folderId: "photos" });
addSeed("seed-guide", "利用案内.pdf", "application/pdf", pdf("NIHO guide"), { folderId: "documents" });
seed.push({ id: "seed-movie", name: "紹介動画.mp4", mimeType: "video/mp4", bytes: 18_400_000 });

const output = await build({ entryPoints: [fileURLToPath(new URL("./editor-demo.tsx", import.meta.url))], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"', DEMO_ASSET_SEED: JSON.stringify(seed) } });
const script = output.outputFiles[0].text;
const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>niho-web 共通エディター</title></head><body style="margin:0;padding:20px;background:#eef1ed"><p style="font:13px sans-serif">公開用の動作例です。変更と公開はメモリ内だけに反映し、再起動するとリセットします。</p><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
async function receive(request, response) {
  const type = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  let name = "";
  try { name = decodeURIComponent(String(request.headers["x-file-name"] ?? "")); } catch { name = ""; }
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size <= maxBytes) chunks.push(chunk); }
  if (!name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) { response.writeHead(400).end(); return; }
  if (!assetTypes.has(type)) { response.writeHead(415).end(); return; }
  if (size > maxBytes) { response.writeHead(413).end(); return; }
  const body = Buffer.concat(chunks), id = `upload-${randomUUID()}`, src = `/demo-assets/${id}`;
  assets.set(id, { type, body });
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ src, ...(type.startsWith("image/") ? { thumbnailUrl: src } : {}), ...dimensions(type, body) }));
}
createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "POST" && path === "/demo-assets") { receive(request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end(); }); return; }
  if (request.method === "GET" && path.startsWith("/demo-assets/")) {
    const asset = assets.get(path.slice("/demo-assets/".length));
    if (!asset) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.body.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }).end(asset.body);
    return;
  }
  if (!["/", "/app.js"].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(request.url === "/app.js" ? script : html);
}).listen(4173, "127.0.0.1", () => console.log("Editor demo: http://127.0.0.1:4173"));
