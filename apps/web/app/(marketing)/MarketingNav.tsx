import Link from "next/link";
import { Brain } from "lucide-react";

export function MarketingNav() {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-[var(--mk-line)] bg-[var(--mk-bg)]/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--mk-accent)]">
            <Brain className="h-3.5 w-3.5 text-black" strokeWidth={2} />
          </span>
          <span className="font-display text-lg leading-none">Saarthi Workflow</span>
        </Link>
        <div className="hidden items-center gap-8 sm:flex">
          <Link href="#agents" className="font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">agents</Link>
          <Link href="#how" className="font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">how it works</Link>
          <Link href="#capabilities" className="font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">capabilities</Link>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/auth/login" className="font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">sign in</Link>
          <Link href="/auth/signup" className="border border-[var(--mk-accent)] bg-[var(--mk-accent)] px-4 py-2 font-mono-mk text-[11px] uppercase tracking-[0.22em] text-black transition-opacity hover:opacity-90">
            get started
          </Link>
        </div>
      </nav>
    </header>
  );
}
