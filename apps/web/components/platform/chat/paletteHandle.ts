/**
 * Shared keyboard contract for every composer trigger palette ("/", "@", "#").
 * Lives here rather than on one of the palettes so the other two don't have to
 * import from a sibling they otherwise have nothing to do with.
 */
export interface PaletteHandle {
    moveActive: (delta: number) => void;
    selectActive: () => boolean;
}
