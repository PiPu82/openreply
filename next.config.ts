import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Emits .next/standalone with a minimal server.js and only the traced
  // node_modules. Needed for the self-hosted Docker image: much smaller than
  // shipping the full dependency tree, and it boots with `node server.js`
  // instead of `next start`. Harmless on Vercel, which ignores it.
  output: "standalone",
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
