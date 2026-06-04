import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
