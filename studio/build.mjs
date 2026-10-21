import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studioDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(studioDirectory, "dist");
const publicOutput = join(outputDirectory, "public");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(publicOutput, "assets"), { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(studioDirectory, "client.tsx")],
    outfile: join(publicOutput, "assets", "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none"
  }),
  build({
    entryPoints: [join(studioDirectory, "worker.ts")],
    outfile: join(outputDirectory, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none"
  }),
  copyFile(join(studioDirectory, "public", "index.html"), join(publicOutput, "index.html")),
  copyFile(join(studioDirectory, "public", "studio.css"), join(publicOutput, "assets", "studio.css")),
  (async () => {
    const result = await build({
      entryPoints: [join(studioDirectory, "..", "src", "project-view-style.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false
    });
    const source = result.outputFiles[0]?.text;
    if (!source) throw new Error("Project view style build produced no output");
    const { projectViewCss } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    await writeFile(join(publicOutput, "assets", "project-view.css"), projectViewCss);
  })()
]);

