import type { Metadata } from "next";
import { MarketingNav } from "./MarketingNav";
import { MarketingFooter } from "./MarketingFooter";
import "./marketing.css";

const BASE_URL = "https://projectcontext.co";
const TITLE = "project context — your AI engineering team";
const DESCRIPTION =
  "A coordinated team of AI specialists — PM, analyst, project manager, tech lead, and architect — that plan, write, and execute alongside your engineering team.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  metadataBase: new URL(BASE_URL),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: BASE_URL,
    siteName: "project context",
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "project context — your AI engineering team",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@projectcontext",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og-image.png"],
  },
  keywords: [
    "AI engineering team",
    "AI product manager",
    "AI project manager",
    "AI tech lead",
    "AI software architect",
    "AI analyst",
    "agentic AI",
    "AI SaaS",
    "software development AI",
    "AI roadmap",
    "PRD generator",
  ],
  authors: [{ name: "project context", url: BASE_URL }],
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="marketing-root relative min-h-screen">
      <div className="marketing-bg" />
      <div className="marketing-dots" />
      <div className="marketing-grain" />
      <MarketingNav />
      <main className="pt-16">{children}</main>
      <MarketingFooter />
    </div>
  );
}
