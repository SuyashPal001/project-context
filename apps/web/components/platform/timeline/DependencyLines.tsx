'use client';
import { useMemo } from 'react';
import type { TimelineBlock, TimelineRow } from './types';
import { ROW_HEIGHT } from './TaskBar';

interface Props {
    blocksMap: Map<string, TimelineBlock>;
    rows: TimelineRow[];
    totalWidth: number;
    totalHeight: number;
}

interface Line {
    key: string;
    d: string;
    isBlocking: boolean;
}

export function DependencyLines({ blocksMap, rows, totalWidth, totalHeight }: Props) {
    const lines = useMemo<Line[]>(() => {
        // 1. Build rowIndexMap: block id → Y centre pixel
        const rowIndexMap = new Map<string, number>();
        rows.forEach((row, i) => {
            rowIndexMap.set(row.id, i * ROW_HEIGHT + ROW_HEIGHT / 2);
        });

        // 2. Collect valid pairs — deduplicate by dep.id
        const seen = new Set<string>();
        const result: Line[] = [];

        for (const block of blocksMap.values()) {
            for (const dep of block.dependencies) {
                if (dep.relationType !== 'blocks' && dep.relationType !== 'blocked_by') continue;
                if (seen.has(dep.id)) continue;
                seen.add(dep.id);

                const sourceBlock = blocksMap.get(dep.fromTaskId);
                const targetBlock = blocksMap.get(dep.toTaskId);

                if (!sourceBlock || !targetBlock) continue;
                if (sourceBlock.isPoint || targetBlock.isPoint) continue;
                if (!rowIndexMap.has(sourceBlock.id) || !rowIndexMap.has(targetBlock.id)) continue;

                // 3. Calculate bezier path
                const sourceX = sourceBlock.marginLeft + sourceBlock.width;
                const sourceY = rowIndexMap.get(sourceBlock.id)!;
                const targetX = targetBlock.marginLeft;
                const targetY = rowIndexMap.get(targetBlock.id)!;

                const d = [
                    `M ${sourceX},${sourceY}`,
                    `C ${sourceX + 24},${sourceY}`,
                    `  ${targetX - 24},${targetY}`,
                    `  ${targetX},${targetY}`,
                ].join(' ');

                result.push({
                    key: dep.id,
                    d,
                    isBlocking: dep.relationType === 'blocks' || dep.relationType === 'blocked_by',
                });
            }
        }

        return result;
    }, [blocksMap, rows]);

    // Always return an SVG — never null
    return (
        <svg
            className="absolute top-0 left-0 z-10"
            width={totalWidth}
            height={totalHeight}
            style={{ pointerEvents: 'none' }}
        >
            {/* 4. Arrowhead marker definitions */}
            <defs>
                <marker
                    id="arrow-red"
                    markerUnits="strokeWidth"
                    refX="6"
                    refY="3"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                >
                    <polygon points="0 0, 6 3, 0 6" fill="#f87171" />
                </marker>
                <marker
                    id="arrow-slate"
                    markerUnits="strokeWidth"
                    refX="6"
                    refY="3"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                >
                    <polygon points="0 0, 6 3, 0 6" fill="#94a3b8" />
                </marker>
            </defs>

            {/* 5. Render paths */}
            {lines.map(line => (
                <path
                    key={line.key}
                    d={line.d}
                    stroke={line.isBlocking ? '#f87171' : '#94a3b8'}
                    strokeWidth={1.5}
                    fill="none"
                    opacity={0.7}
                    markerEnd={line.isBlocking ? 'url(#arrow-red)' : 'url(#arrow-slate)'}
                />
            ))}
        </svg>
    );
}
