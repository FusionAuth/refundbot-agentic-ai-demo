import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mailpit's UI lives at "/mail/" and its relative asset URLs need the trailing slash.
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
