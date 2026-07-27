import { Hero } from "./Hero";
import { AgentFlow } from "./AgentFlow";
import { Features } from "./Features";
import { Collaboration } from "./Collaboration";
import { Wedge } from "./Wedge";
import { CTA } from "./CTA";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "project context",
  url: "https://projectcontext.co",
  description:
    "A coordinated team of AI specialists — PM, analyst, project manager, tech lead, and architect — that plan, write, and execute alongside your engineering team.",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free to start",
  },
  creator: {
    "@type": "Organization",
    name: "project context",
    url: "https://projectcontext.co",
  },
};

export default function LandingPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <Hero />
      <AgentFlow />
      <Features />
      <Collaboration />
      <Wedge />
      <CTA />
    </>
  );
}
