import Link from "next/link";
import { Button } from "@/components/ui/button";

export function CTA() {
  return (
    <section className="marketing-section mx-auto max-w-6xl px-6">
      <div className="relative rounded-2xl border border-[var(--mk-accent)]/30 bg-[var(--mk-bg-elev)] p-12 sm:p-20">
        <span className="eyebrow">Begin</span>
        <h2 className="mt-4 font-display text-4xl leading-[1.05] tracking-tight sm:text-7xl">
          Stop briefing.
          <br />
          <span className="font-semibold text-[var(--mk-accent)]">Start shipping.</span>
        </h2>
        <p className="mt-8 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          Open a workspace. Drop in a goal. Walk away. Come back to a PRD, a
          roadmap, and a board full of tasks, grounded in your context, scored
          for quality, ready for review.
        </p>
        <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Button asChild size="lg" className="h-12 rounded-full bg-[var(--mk-accent)] px-8 text-base font-medium text-[var(--mk-accent-fg)] hover:opacity-90">
            <Link href="/auth/signup">Bring the team online →</Link>
          </Button>
          <Link href="/auth/login" className="text-sm font-medium text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">
            I have an account
          </Link>
        </div>
      </div>
    </section>
  );
}
