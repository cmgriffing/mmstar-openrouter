/**
 * @mmstar/config — runtime-neutral configuration and evaluation-plan contracts.
 *
 * Implementation lands in chunk 2 (dataset, configuration, and contracts).
 * This package must never import Bun, Node, OpenTUI, or Astro APIs: the same
 * source is loaded by the Bun runner and bundled into the website.
 */
export const CONFIG_PACKAGE = "@mmstar/config" as const;
