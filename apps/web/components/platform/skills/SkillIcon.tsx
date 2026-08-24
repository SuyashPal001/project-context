// Deterministic pixel-art identicon, seeded by the skill's id — same skill
// always renders the same icon, no images or external assets involved.

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

export function SkillIcon({ seed, className }: { seed: string; className?: string }) {
    const hash = hashSeed(seed);
    const hue = 200 + (hash % 100); // blue-to-purple range, matching the reference style

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

    return (
        <svg
            viewBox={`0 0 ${GRID} ${GRID}`}
            className={className}
            style={{ backgroundColor: `hsl(${hue} 70% 95%)` }}
        >
            {cells.map((row, r) =>
                row.map((filled, c) =>
                    filled ? (
                        <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} fill={`hsl(${hue} 65% 55%)`} />
                    ) : null
                )
            )}
        </svg>
    );
}
