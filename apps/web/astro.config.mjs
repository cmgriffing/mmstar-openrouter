// @ts-check
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// One codebase, four build targets. Server output requires an adapter; the
// target is selected at build time so each platform bundles only its own
// runtime code. `node` is the local default for dev/preview and smoke checks.
const adapterName = process.env.MMSTAR_ADAPTER ?? "node";

async function loadAdapter() {
  switch (adapterName) {
    case "node": {
      const { default: node } = await import("@astrojs/node");
      return node({ mode: "standalone" });
    }
    case "netlify": {
      const { default: netlify } = await import("@astrojs/netlify");
      return netlify();
    }
    case "vercel": {
      const { default: vercel } = await import("@astrojs/vercel");
      return vercel();
    }
    case "cloudflare": {
      const { default: cloudflare } = await import("@astrojs/cloudflare");
      // Images are pre-generated immutable assets, so the Cloudflare Images
      // binding is unnecessary and stays unconfigured.
      return cloudflare({ imageService: "passthrough" });
    }
    default:
      throw new Error(
        `unknown MMSTAR_ADAPTER "${adapterName}" (expected node, netlify, vercel, or cloudflare)`,
      );
  }
}

export default defineConfig({
  output: "server",
  adapter: await loadAdapter(),
  integrations: [react()],
});
