import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Indie Mates",
  description: "Terms and conditions for using Indie Mates.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="font-display text-4xl mb-2">Terms of Service</h1>
      <p className="text-[var(--mk-muted)] font-mono-mk text-xs uppercase tracking-widest mb-12">
        Last updated: July 2026
      </p>

      <div className="prose prose-invert prose-sm max-w-none space-y-8 text-[var(--mk-muted)] leading-relaxed">
        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">1. Acceptance</h2>
          <p>
            By accessing or using Indie Mates ("the Service"), you agree to be bound by these
            Terms. If you do not agree, do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">2. Use of the service</h2>
          <p>
            You may use Indie Mates for lawful purposes only. You are responsible for all
            activity that occurs under your account. Do not use the Service to generate harmful,
            illegal, or deceptive content.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">3. Your content</h2>
          <p>
            You retain ownership of all content you submit to the Service. By submitting content,
            you grant us a limited license to process it solely for the purpose of providing the
            Service. We do not use your content to train AI models.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">4. Availability</h2>
          <p>
            We aim for high availability but do not guarantee uninterrupted access. We may modify
            or discontinue features with reasonable notice.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">5. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, Indie Mates is provided "as is" without
            warranties of any kind. We are not liable for indirect, incidental, or consequential
            damages arising from your use of the Service.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">6. Changes</h2>
          <p>
            We may update these Terms from time to time. Continued use of the Service after changes
            constitutes acceptance of the updated Terms.
          </p>
        </section>

        <section>
          <h2 className="text-[var(--mk-fg)] text-lg font-semibold mb-3">7. Contact</h2>
          <p>
            Questions?{" "}
            <a href="mailto:hello@projectcontext.co" className="text-[var(--mk-accent)] hover:underline">
              hello@projectcontext.co
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}
