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
    // Pixel video camera: viewfinder bump on top, a 4x4 body, lens sticking
    // out to the left at mid-height.
    "talking-head": [
        [false, false, true, false, false],
        [false, true, true, true, true],
        [true, true, true, true, true],
        [false, true, true, true, true],
        [false, true, true, true, true],
    ],
    // Pixel head-and-shoulders bust with a small "+" badge at the top right.
    "avatar-creator": [
        [true, true, false, true, false],
        [true, true, true, true, true],
        [false, false, false, true, false],
        [true, true, true, true, true],
        [true, true, true, true, true],
    ],
};

export function SkillIcon({
    seed,
    className,
    pattern,
}: {
    seed: string;
    className?: string;
    pattern?: SkillIconPattern;
}) {
    const cells = pattern ?? randomCells(seed);

    return (
        <svg
            viewBox={`0 0 ${GRID} ${GRID}`}
            className={className}
            style={{ backgroundColor: "color-mix(in oklab, var(--primary) 18%, var(--card))" }}
        >
            {cells.map((row, r) =>
                row.map((filled, c) =>
                    filled ? (
                        <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} fill="var(--primary)" />
                    ) : null
                )
            )}
        </svg>
    );
}
