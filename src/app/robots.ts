import type { MetadataRoute } from "next";

// Nothing in Desk is indexable — partner share links are capability URLs
// and operator surfaces are private (spec §15). Disallow all crawlers app-wide.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
