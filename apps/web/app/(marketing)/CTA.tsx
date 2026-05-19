import Link from "next/link";
import { Button } from "@/components/ui/button";

export function CTA() {
  return (
    <section className="marketing-section mx-auto max-w-6xl px-6">
      <div className="marketing-rule mb-16" />
      <div className="relative border border-[var(--mk-accent)]/40 bg-[var(--mk-bg-elev)] p-12 sm:p-20">
        <span className="eyebrow">begin</span>
        <h2 className="mt-6 font-display text-5xl leading-[0.95] tracking-tight sm:text-8xl">
          Stop briefing.
          <br />
          <em className="italic text-[var(--mk-accent)]">Start shipping.</em>
        </h2>
        <p className="mt-8 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          Open a workspace. Drop in a goal. Walk away. Come back to a PRD, a
          roadmap, and a board full of tasks — grounded in your context, scored
          for quality, ready for review.
        </p>
        <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Button asChild size="lg" className="h-12 rounded-none border border-[var(--mk-accent)] bg-[var(--mk-accent)] px-8 text-base font-medium text-black hover:bg-[var(--mk-accent)]/90">
            <Link href="/auth/signup">Bring the team online →</Link>
          </Button>
          <Link href="/auth/login" className="font-mono-mk text-sm uppercase tracking-[0.2em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">
            i have an account
          </Link>
        </div>
      </div>
    </section>
  );
}
