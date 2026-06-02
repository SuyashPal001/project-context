import { Hero } from "./Hero";
import { AgentFlow } from "./AgentFlow";
import { Features } from "./Features";
import { Collaboration } from "./Collaboration";
import { Wedge } from "./Wedge";
import { CTA } from "./CTA";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <AgentFlow />
      <Features />
      <Collaboration />
      <Wedge />
      <CTA />
    </>
  );
}
