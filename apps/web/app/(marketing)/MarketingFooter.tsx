export function MarketingFooter() {
  return (
    <footer className="border-t border-[var(--mk-line)]">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-12 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[var(--mk-accent)]" />
          <span className="font-display text-lg">project context</span>
        </div>
        <div className="flex flex-wrap gap-6 font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)]">
          <span>© {new Date().getFullYear()}</span>
          <a href="/privacy" className="transition-colors hover:text-[var(--mk-fg)]">privacy</a>
          <a href="/terms" className="transition-colors hover:text-[var(--mk-fg)]">terms</a>
          <a href="mailto:hello@projectcontext.co" className="transition-colors hover:text-[var(--mk-fg)]">contact</a>
        </div>
      </div>
    </footer>
  );
}
