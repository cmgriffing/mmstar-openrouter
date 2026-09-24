/**
 * Cloudflare post-build step.
 *
 * Workerd refuses to compile WASM from bytes during a request, so the reader
 * must load the sql.js WASM binary as a `CompiledWasm` module. This script
 * copies `sql-wasm.wasm` next to the server chunks (the reader imports it with
 * a runtime specifier) and adds the module rule to the generated
 * `dist/server/wrangler.json`.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(webDir, "dist", "server");
const chunksDir = join(serverDir, "chunks");
const wasmSource = join(webDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
const wranglerPath = join(serverDir, "wrangler.json");

if (!existsSync(wranglerPath)) {
  console.error("[cloudflare] dist/server/wrangler.json not found; run the Cloudflare build first");
  process.exit(1);
}

for (const dir of [serverDir, chunksDir]) {
  if (existsSync(dir)) copyFileSync(wasmSource, join(dir, "sql-wasm.wasm"));
}

const config = JSON.parse(readFileSync(wranglerPath, "utf8"));
const rules = Array.isArray(config.rules) ? config.rules : [];
if (!rules.some((rule) => rule?.type === "CompiledWasm")) {
  rules.push({ type: "CompiledWasm", globs: ["**/*.wasm"] });
}
config.rules = rules;
writeFileSync(wranglerPath, JSON.stringify(config));

console.log(
  `[cloudflare] copied sql-wasm.wasm into dist/server and dist/server/chunks; ` +
    `CompiledWasm rule = ${JSON.stringify(config.rules)}`,
);
