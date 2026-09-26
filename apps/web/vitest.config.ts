/// <reference types="vitest/config" />
import { getViteConfig } from "astro/config";

// Astro's own toolchain compiles the `.tsx` islands, so let Vitest reuse the
// site's Vite config (React integration included) instead of raw esbuild.
// `astro/tsconfigs/strict` sets `jsx: preserve`, which breaks a bare Vitest
// transform when tests import the components directly.
export default getViteConfig({
  test: {
    environment: "node",
  },
});
