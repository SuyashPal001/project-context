import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  productionBrowserSourceMaps: false,
  // Zero-downtime deploys build into a timestamped dist dir passed via
  // WEB_DIST_NAME; PM2 always serves the .next-live symlink. Unset => ".next".
  distDir: process.env.WEB_DIST_NAME || ".next",
};

export default nextConfig;