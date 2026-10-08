// The page buttons Drive shows: the first, the last, and the pages around the
// current one, with a gap marker between. 541 files drew 55 buttons in one row
// and pushed the total off the page (2026-10-09).
export type PageItem = number | 'gap';

export function pageWindow(current: number, total: number, around = 1): PageItem[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set<number>([1, total]);
    for (let p = current - around; p <= current + around; p++) if (p >= 1 && p <= total) pages.add(p);
    // Near either end, keep five in a row so the list does not jump in width.
    if (current <= 3) for (let p = 2; p <= 5; p++) pages.add(p);
    if (current >= total - 2) for (let p = total - 4; p < total; p++) pages.add(p);
    const sorted = [...pages].sort((a, b) => a - b);
    const items: PageItem[] = [];
    for (let i = 0; i < sorted.length; i++) {
        if (i > 0) {
            const gap = sorted[i] - sorted[i - 1];
            // A gap of one page is shown as that page, not as "…".
            if (gap === 2) items.push(sorted[i] - 1);
            else if (gap > 2) items.push('gap');
        }
        items.push(sorted[i]);
    }
    return items;
}
