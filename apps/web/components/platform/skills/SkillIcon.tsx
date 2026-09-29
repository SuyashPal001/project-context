// Deterministic pixel-art identicon, seeded by the skill's id — same skill
// always renders the same icon, no images or external assets involved.
//
// Official skills can instead supply a hand-designed `pattern` (see
// OFFICIAL_SKILL_PATTERNS below) so their icon reads as a recognisable glyph
// instead of random noise. Passing no pattern keeps the original seeded
// random behaviour, used by the Community card.

export type SkillIconPattern = boolean[][];

function hashSeed(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash << 5) - hash + seed.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

const GRID = 5;
const HALF = Math.ceil(GRID / 2);

function randomCells(seed: string): boolean[][] {
    const hash = hashSeed(seed);

    const cells: boolean[][] = [];
    let bits = hash;
    for (let row = 0; row < GRID; row++) {
        const rowCells: boolean[] = [];
        for (let col = 0; col < HALF; col++) {
            rowCells.push((bits & 1) === 1);
            bits >>= 1;
            if (bits === 0) bits = hashSeed(`${seed}:${row}:${col}`);
        }
        // Mirror the left half onto the right half for a symmetric identicon.
        const mirrored = [...rowCells, ...rowCells.slice(0, GRID - HALF).reverse()];
        cells.push(mirrored);
    }
    return cells;
}

// Hand-designed 5x5 glyphs for Official skills, keyed by slug. An unknown
// official slug falls back to the seeded random pattern below.
export const OFFICIAL_SKILL_PATTERNS: Record<string, SkillIconPattern> = {
    // Video camera: a 3x3 body with a lens wedge on the right — the standard
    // "video" glyph, readable at 5x5.
    //   · · · · ·
    //   ■ ■ ■ · ■
    //   ■ ■ ■ ■ ■
    //   ■ ■ ■ · ■
    //   · · · · ·
    "talking-head": [
        [false, false, false, false, false],
        [true, true, true, false, true],
        [true, true, true, true, true],
        [true, true, true, false, true],
        [false, false, false, false, false],
    ],
    // Person: a head block, a one-row gap, then shoulders — the standard
    // "user" glyph. (A "+" badge doesn't fit legibly in 5x5.)
    //   · ■ ■ ■ ·
    //   · ■ ■ ■ ·
    //   · · · · ·
    //   ■ ■ ■ ■ ■
    //   ■ ■ ■ ■ ■
    "avatar-creator": [
        [false, true, true, true, false],
        [false, true, true, true, false],
        [false, false, false, false, false],
        [true, true, true, true, true],
        [true, true, true, true, true],
    ],
};

export function SkillIcon({
    seed,
    className,
    pattern,
    inverted = false,
}: {
    seed: string;
    className?: string;
    pattern?: SkillIconPattern;
    /** Official skills: solid brand background with light pixels (and a
     *  little padding so the glyph doesn't touch the edge), instead of
     *  brand pixels on a pale tint. Same hue, stronger form. */
    inverted?: boolean;
}) {
    const cells = pattern ?? randomCells(seed);
    const pad = inverted ? 0.6 : 0;

    return (
        <svg
            viewBox={`${-pad} ${-pad} ${GRID + pad * 2} ${GRID + pad * 2}`}
            className={className}
            style={{ backgroundColor: inverted ? "var(--primary)" : "color-mix(in oklab, var(--primary) 18%, var(--card))" }}
        >
            {cells.map((row, r) =>
                row.map((filled, c) =>
                    filled ? (
                        <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} fill={inverted ? "var(--primary-foreground)" : "var(--primary)"} />
                    ) : null
                )
            )}
        </svg>
    );
}
