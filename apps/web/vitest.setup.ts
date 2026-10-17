import { vi } from 'vitest';

// next/font/google calls Google Fonts at build time; under vitest (no
// Next.js bundler in the loop) that would be a real network fetch. Stub it
// with a stable className so brandFonts.ts (and anything else that loads a
// Google font) stays importable offline.
vi.mock('next/font/google', () => {
    const stub = () => ({ className: 'font-mock', style: {}, variable: '--font-mock' });
    return {
        Space_Grotesk: stub, Figtree: stub, Poppins: stub, Inter: stub,
        Playfair_Display: stub, JetBrains_Mono: stub,
    };
});
