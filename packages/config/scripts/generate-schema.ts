/**
 * Regenerate the committed editor schema under `apps/runner` (where the runner
 * config lives). Run with: `pnpm schema` (workspace root) or
 * `pnpm --filter @mmstar/config schema`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateConfigSchemaJson } from "../src/schema";

const target = new URL("../../../apps/runner/mmstar.config.schema.json", import.meta.url);
writeFileSync(target, generateConfigSchemaJson(), "utf8");
console.log(`generated ${fileURLToPath(target)}`);
