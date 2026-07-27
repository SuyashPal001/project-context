import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/auth/login", "/auth/signup", "/privacy", "/terms"],
        disallow: [
          "/api/",
          "/_next/",
          "/ops/",
          "/*/dashboard/",
          "/*/agents/",
          "/*/kb/",
        ],
      },
    ],
    sitemap: "https://projectcontext.co/sitemap.xml",
  };
}
