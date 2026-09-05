import Link from "next/link";

export function MarketingNav() {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-[var(--mk-line)] bg-[var(--mk-bg)]/85 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/olmoworks-mark.svg" alt="" className="shrink-0 object-contain" style={{ height: 28, width: "auto" }} />
          <span className="font-display text-lg leading-none">OlmoWorks</span>
        </Link>
        <div className="hidden items-center gap-8 sm:flex">
          <Link href="#agents" className="text-sm font-medium text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">Agents</Link>
          <Link href="#how" className="text-sm font-medium text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">How it works</Link>
          <Link href="#capabilities" className="text-sm font-medium text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">Capabilities</Link>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/auth/login" className="text-sm font-medium text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">Sign in</Link>
          <Link href="/auth/signup" className="rounded-full bg-[var(--mk-accent)] px-4 py-2 text-sm font-medium text-[var(--mk-accent-fg)] transition-transform hover:scale-[1.03] active:scale-[0.98]">
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}
