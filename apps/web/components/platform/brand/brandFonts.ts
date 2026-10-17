import { Figtree, Inter, JetBrains_Mono, Playfair_Display, Poppins, Space_Grotesk } from 'next/font/google';

// The six curated font choices on the brand Look tab's Typography cards.
// Loaded once here (next/font/google calls must sit at module scope) and
// reused for both the card's big "Aa" sample and the live preview headline.
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const figtree = Figtree({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const poppins = Poppins({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const inter = Inter({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const playfairDisplay = Playfair_Display({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });
const jetBrainsMono = JetBrains_Mono({ subsets: ['latin'], weight: ['500', '600'], display: 'swap' });

/** Font family name -> the next/font className that renders it. */
export const BRAND_FONT_CLASS: Record<string, string> = {
    'Space Grotesk': spaceGrotesk.className,
    Figtree: figtree.className,
    Poppins: poppins.className,
    Inter: inter.className,
    'Playfair Display': playfairDisplay.className,
    'JetBrains Mono': jetBrainsMono.className,
};

/** The font cards, in display order, each with a short subtitle. */
export const BRAND_FONT_CARDS: ReadonlyArray<{ name: string; subtitle: string }> = [
    { name: 'Space Grotesk', subtitle: 'Bold grotesk' },
    { name: 'Figtree', subtitle: 'Friendly sans' },
    { name: 'Poppins', subtitle: 'Geometric sans' },
    { name: 'Inter', subtitle: 'Clean sans' },
    { name: 'Playfair Display', subtitle: 'Elegant serif' },
    { name: 'JetBrains Mono', subtitle: 'Monospace' },
];
