export const VALID_USER_TRANSITIONS: Record<string, string[]> = {
    backlog:           ['todo', 'cancelled'],
    todo:              ['backlog', 'cancelled'],
    planning:          [],
    awaiting_approval: [],
    in_progress:       [],
    blocked:           ['cancelled'],
    review:            ['done', 'cancelled'],
    done:              [],
    cancelled:         [],
};
