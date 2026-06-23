import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Desk-wide security headers (clickjacking backstop + companions). Policy and
  // rationale live in src/lib/security-headers.ts (unit-tested there).
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
