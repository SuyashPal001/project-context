import type { MetadataRoute } from "next";

const PUBLIC_ALLOW = ["/", "/auth/login", "/auth/signup", "/privacy", "/terms"];
const PRIVATE_DISALLOW = ["/api/", "/_next/", "/ops/", "/*/dashboard/", "/*/agents/", "/*/kb/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Default: allow public pages, block private ones
      {
        userAgent: "*",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      // Explicitly allow major AI crawlers on the same public pages
      {
        userAgent: "GPTBot",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      {
        userAgent: "anthropic-ai",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      {
        userAgent: "ClaudeBot",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      {
        userAgent: "PerplexityBot",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      {
        userAgent: "Google-Extended",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      {
        userAgent: "Amazonbot",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      {
        userAgent: "CCBot",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
      {
        userAgent: "cohere-ai",
        allow: PUBLIC_ALLOW,
        disallow: PRIVATE_DISALLOW,
      },
    ],
    sitemap: "https://projectcontext.co/sitemap.xml",
  };
}
