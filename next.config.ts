import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: process.env.APP_BASE_URL ? [new URL(process.env.APP_BASE_URL).hostname] : [],
  devIndicators: false,
  distDir: process.env.NEXT_TEST_DIST_DIR ?? ".next",
};

export default config;
