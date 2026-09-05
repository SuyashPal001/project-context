import type { Metadata } from "next";
import { MarketingNav } from "./MarketingNav";
import { MarketingFooter } from "./MarketingFooter";
import "./marketing.css";

const BASE_URL = "https://projectcontext.co";
const TITLE = "Indie Mates — your AI engineering team";
const DESCRIPTION =
  "Indie Mates is an AI-powered engineering workspace with a built-in team of AI specialists — Product Manager, Analyst, Project Manager, Tech Lead, and Architect — that turns ideas into PRDs, roadmaps, and task boards. Free to start.";
const OG_IMAGE = `${BASE_URL}/og?title=project+context&subtitle=your+AI+engineering+team`;

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
    siteName: "Indie Mates",
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "Indie Mates — your AI engineering team",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@projectcontext",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE],
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
    "AI workspace",
    "multi-agent AI",
    "AI task management",
    "AI sprint planning",
    "AI product requirements document",
    "agentic project management",
    "AI engineering workspace",
    "MCP tool integrations",
    "AI team for developers",
  ],
  authors: [{ name: "Indie Mates", url: BASE_URL }],
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
      <MarketingNav />
      <main className="pt-16">{children}</main>
      <MarketingFooter />
    </div>
  );
}
