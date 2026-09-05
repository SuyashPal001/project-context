import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — OlmoWorks",
  description: "How OlmoWorks collects, uses, and protects your data.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="font-display text-4xl mb-2">Privacy Policy</h1>
      <p className="text-[var(--mk-muted)] font-mono-mk text-xs uppercase tracking-widest mb-12">
        Last updated: July 2026
      </p>

      <div className="prose prose-invert prose-sm max-w-none space-y-8 text-[var(--mk-muted)] leading-relaxed">
        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">1. What we collect</h2>
          <p>
            We collect information you provide directly — your name, email address, and workspace
            data — as well as usage data (pages visited, features used) via PostHog analytics to
            improve the product.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">2. How we use it</h2>
          <p>
            Your data is used solely to provide and improve OlmoWorks. We do not sell your
            data to third parties. Usage analytics help us understand which features are most
            valuable and where users get stuck.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">3. Data storage</h2>
          <p>
            Data is stored on Neon PostgreSQL (US East) and AWS S3. Authentication is managed by
            AWS Cognito. All data is encrypted at rest and in transit.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">4. Third-party services</h2>
          <p>
            We use AWS (auth, storage, compute), Neon (database), Upstash Redis (caching), PostHog
            (analytics), and Google (OAuth login). Each of these services has their own privacy
            policy governing their data handling.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">5. Your rights</h2>
          <p>
            You may request access to, correction of, or deletion of your personal data at any
            time by contacting us at{" "}
            <a href="mailto:hello@projectcontext.co" className="text-[var(--mk-accent)] hover:underline">
              hello@projectcontext.co
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">6. Contact</h2>
          <p>
            Questions about this policy? Email us at{" "}
            <a href="mailto:hello@projectcontext.co" className="text-[var(--mk-accent)] hover:underline">
              hello@projectcontext.co
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
