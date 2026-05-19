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
}

export function TimelineHeader({ scale, dayWidth, chartStart, totalWidth }: Props) {
    const today = new Date();
    const todayLeft = differenceInDays(today, chartStart) * dayWidth;
    const showToday = todayLeft >= 0 && todayLeft <= totalWidth;

    return (
        <div className="relative bg-background" style={{ width: totalWidth, height: 56 }}>
            {/* Month segments */}
            <div className="flex h-7 border-b border-border/40">
                {scale.months.map((seg, i) => (
                    <div
                        key={i}
                        className="flex-none border-r border-border/30 px-2 flex items-center overflow-hidden"
                        style={{ width: seg.days * dayWidth }}
                    >
                        <span className="text-[11px] font-medium text-muted-foreground truncate">
                            {seg.label}
                        </span>
                    </div>
                ))}
            </div>

            {/* Marker ticks */}
            <div className="relative h-7">
                {scale.markers.map((m, i) => (
                    <div
                        key={i}
                        className="absolute top-0 bottom-0 border-l border-border/20 flex items-center pl-1"
                        style={{ left: m.marginLeft }}
                    >
                        <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">
                            {m.label}
                        </span>
                    </div>
                ))}
            </div>

            {/* Today marker line */}
            {showToday && (
                <div
                    className="absolute top-0 bottom-0 w-px bg-red-500/80 pointer-events-none"
                    style={{ left: todayLeft }}
                />
            )}
        </div>
    );
}
