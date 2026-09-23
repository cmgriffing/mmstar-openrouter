/**
 * Minimal Node builtin declarations for tests only.
 *
 * Shared-package source stays runtime-neutral (`tsconfig` sets `"types": []`).
 * Tests execute under Vitest in Node and need file access to validate the
 * committed dataset, so this file declares exactly the builtins they use. It is
 * not imported by runtime source and is never bundled.
 */
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

declare const Buffer: {
  from(data: readonly number[] | string): { toString(encoding: "base64"): string };
};
