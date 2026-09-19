import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

const typeScript = spawnSync(
  process.execPath,
  ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);

if (typeScript.status !== 0) {
  process.exit(typeScript.status ?? 1);
}

await mkdir("dist/apps/local-web/web", { recursive: true });
await build({
  entryPoints: ["apps/local-web/web/app.ts"],
  outfile: "dist/apps/local-web/web/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
});
await cp("apps/local-web/web/index.html", "dist/apps/local-web/web/index.html");
await cp("apps/local-web/web/styles.css", "dist/apps/local-web/web/styles.css");
await cp("apps/local-web/web/behavior-profiles.css", "dist/apps/local-web/web/behavior-profiles.css");
await cp("apps/local-web/web/filter-documentation.css", "dist/apps/local-web/web/filter-documentation.css");
await cp("assets", "dist/apps/local-web/web/assets", { recursive: true });

console.log("Build complete: dist/");
