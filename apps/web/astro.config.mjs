// @ts-check
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

// Static output for the scaffold. Deployment adapters (Netlify, Vercel,
// Cloudflare Workers) are selected in chunk 9 behind the runtime gate.
export default defineConfig({
  output: "static",
  integrations: [react()],
});
