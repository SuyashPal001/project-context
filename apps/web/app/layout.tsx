import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/providers";
import { PostHogPageView } from "@/components/posthog-pageview";
import { Suspense } from "react";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export const metadata: Metadata = {
  title: {
    default: "project context — your AI engineering team",
    template: "%s | project context",
  },
  description:
    "project context gives your team a coordinated AI engineering team — PM, Analyst, Project Manager, Tech Lead, and Architect — that turns ideas into PRDs, roadmaps, and task boards. Free to start.",
  metadataBase: new URL("https://projectcontext.co"),
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} ${jetBrainsMono.variable} antialiased`}
      >
        <Providers>
          <Suspense fallback={null}>
            <PostHogPageView />
          </Suspense>
          {children}
        </Providers>
      </body>
    </html>
  );
}
