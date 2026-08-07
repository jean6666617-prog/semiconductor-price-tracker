import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the long-running dev server isolated from production builds.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
