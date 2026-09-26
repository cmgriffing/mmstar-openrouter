/**
 * Copy the immutable publication and the sql.js WASM binary into the website's
 * static asset root. Generated assets stay Git-ignored; `MMStar.tsv` remains the
 * single committed image source.
 *
 * Runs before `astro dev` and `astro build`. Without a publication the script
 * warns and exits 0 so type checks and CI builds still work; the query endpoints
 * then answer 503 until an export exists. Set `MMSTAR_REQUIRE_PUBLICATION=1` to
 * require one instead.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(webDir));
const publicationDir = process.env.MMSTAR_PUBLICATION_DIR ?? join(repoRoot, "publication");
const publicDir = join(webDir, "public");

const databaseSource = join(publicationDir, "benchmark.sqlite");
const imagesSource = join(publicationDir, "benchmark-images");
const manifestSource = join(publicationDir, "manifest.json");
const wasmSource = join(webDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm");

if (!existsSync(databaseSource) || !existsSync(imagesSource)) {
  const message = `[sync-publication] no publication at ${publicationDir}; run \`mmstar export\` first`;
  if (process.env.MMSTAR_REQUIRE_PUBLICATION === "1") {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} (serving without a publication)`);
  process.exit(0);
}

mkdirSync(join(publicDir, "publication"), { recursive: true });
cpSync(databaseSource, join(publicDir, "publication", "benchmark.sqlite"));
const manifestTarget = join(publicDir, "publication", "manifest.json");
if (!existsSync(manifestSource)) {
  // The repository guard reads the database, so the site still refuses v1
  // artifacts; the manifest is carried for operators and CI. Seed/UI fixtures
  // are explicitly not validated exports and stay usable when not required.
  if (process.env.MMSTAR_REQUIRE_PUBLICATION === "1") {
    console.error(
      `[sync-publication] publication at ${publicationDir} has no manifest.json; run \`pnpm export\` first`,
    );
    process.exit(1);
  }
  rmSync(manifestTarget, { force: true });
} else {
  cpSync(manifestSource, manifestTarget);
}
rmSync(join(publicDir, "benchmark-images"), { recursive: true, force: true });
cpSync(imagesSource, join(publicDir, "benchmark-images"), { recursive: true });
cpSync(wasmSource, join(publicDir, "sql-wasm.wasm"));

const size = (path) => `${(statSync(path).size / 1024 / 1024).toFixed(1)} MiB`;
console.log(
  `[sync-publication] ${publicationDir} -> ${publicDir} (db ${size(
    join(publicDir, "publication", "benchmark.sqlite"),
  )}, wasm ${size(join(publicDir, "sql-wasm.wasm"))})`,
);
