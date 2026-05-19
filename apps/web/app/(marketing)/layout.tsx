import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { MarketingNav } from "./MarketingNav";
import { MarketingFooter } from "./MarketingFooter";
import "./marketing.css";

const instrumentSerif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "project context — your AI engineering team",
  description:
    "A coordinated team of AI specialists — PM, analyst, project manager, tech lead, and architect — that plan, write, and execute alongside your engineering team.",
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`marketing-root relative min-h-screen ${instrumentSerif.variable} ${jetBrainsMono.variable}`}
    >
      <div className="marketing-bg" />
      <div className="marketing-dots" />
      <div className="marketing-grain" />
      <MarketingNav />
      <main className="pt-16">{children}</main>
      <MarketingFooter />
    </div>
  );
}
