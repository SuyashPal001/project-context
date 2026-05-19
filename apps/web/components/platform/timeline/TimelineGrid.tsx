'use client';
import { differenceInDays } from 'date-fns';

interface Scale {
    months: { label: string; days: number }[];
    markers: { date: Date; label: string; marginLeft: number }[];
}

interface Props {
    scale: Scale;
    dayWidth: number;
    chartStart: Date;
    totalWidth: number;
    height: number;
}

export function TimelineGrid({ scale, dayWidth, chartStart, totalWidth, height }: Props) {
    const today = new Date();
    const todayLeft = differenceInDays(today, chartStart) * dayWidth;
    const showToday = todayLeft >= 0 && todayLeft <= totalWidth;

    // Compute alternating month band positions
    let bandLeft = 0;
    const bands: { left: number; width: number; shaded: boolean }[] = [];
    scale.months.forEach((seg, i) => {
        const w = seg.days * dayWidth;
        bands.push({ left: bandLeft, width: w, shaded: i % 2 !== 0 });
        bandLeft += w;
    });

    return (
        <div
            className="absolute inset-0 pointer-events-none overflow-hidden"
            style={{ width: totalWidth, height }}
        >
            {/* Alternating month bands */}
            {bands.filter(b => b.shaded).map((b, i) => (
                <div
                    key={i}
                    className="absolute top-0 bottom-0 bg-muted/20"
                    style={{ left: b.left, width: b.width }}
                />
            ))}

            {/* Vertical month boundary lines */}
            {bands.slice(1).map((b, i) => (
                <div
                    key={i}
                    className="absolute top-0 bottom-0 w-px bg-border/25"
                    style={{ left: b.left }}
                />
            ))}

            {/* Marker tick lines (weeks in week-zoom) */}
            {scale.markers.map((m, i) => (
                <div
                    key={i}
                    className="absolute top-0 bottom-0 w-px bg-border/10"
                    style={{ left: m.marginLeft }}
                />
            ))}

            {/* Today column highlight */}
            {showToday && (
                <>
                    <div
                        className="absolute top-0 bottom-0 bg-red-500/5"
                        style={{ left: Math.max(0, todayLeft - dayWidth / 2), width: dayWidth }}
                    />
                    <div
                        className="absolute top-0 bottom-0 w-px bg-red-500/50"
                        style={{ left: todayLeft }}
                    />
                </>
            )}
        </div>
    );
}
