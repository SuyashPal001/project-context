import type { MetadataRoute } from "next";

const BASE_URL = "https://projectcontext.co";

// Private areas no crawler should index. `/_next/` is blocked broadly, but
// `/_next/static/` is re-allowed: Googlebot renders pages to assess layout and
// Core Web Vitals, and blocking JS/CSS bundles degrades that assessment.
// Google resolves the conflict by longest-match, so the Allow wins.
const DISALLOW = ["/api/", "/_next/", "/ops/", "/*/dashboard/", "/*/agents/", "/*/kb/"];
const ALLOW = ["/", "/_next/static/"];

// Crawlers that scrape for model training only — no referral traffic in return.
// Blocking these has no effect on Google Search ranking (Google-Extended governs
// Gemini training, not Search). Answer engines that do send referrals
// (PerplexityBot, ClaudeBot) are intentionally left under the default rule.
const AI_TRAINING_CRAWLERS = ["GPTBot", "CCBot", "Google-Extended", "Bytespider"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ALLOW,
        disallow: DISALLOW,
      },
      ...AI_TRAINING_CRAWLERS.map((userAgent) => ({
        userAgent,
        disallow: "/",
      })),
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
