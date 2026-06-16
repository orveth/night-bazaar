/**
 * Build the client into dist/: bundle src/main.ts (+ three, cashu-ts) and
 * copy index.html. `bun run build`.
 */

import { mkdir, cp } from "node:fs/promises";

await mkdir("dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  target: "browser",
  format: "esm",
  // Phase 1a pulls in three/webgpu (the node system is big) — minify keeps
  // the bundle inside the asset budget.
  minify: true,
  sourcemap: "linked",
  naming: "[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await cp("index.html", "dist/index.html");
console.log(
  "built:",
  result.outputs.map((o) => `${o.path} (${(o.size / 1024).toFixed(0)}kB)`).join(", "),
);
