export type SectionKind = 'delivered' | 'credentials' | 'training' | 'support' | 'signoff';

export interface SeedSection {
  kind: SectionKind;
  title: string;
  subtitle: string;
  eyebrow: string;
  sortOrder: number;
  isVisible: boolean;
}

/**
 * The one built-in closeout template. There is deliberately no template
 * picker — a selector with a single option is worse than no selector. When a
 * template library arrives, it replaces this constant and seedSections() takes
 * a template id; nothing else has to change.
 *
 * credentials ships hidden: the section exists so it needs no migration later,
 * but no credential storage or reveal path is built yet.
 */
export const SECTION_TEMPLATE: readonly SeedSection[] = [
  {
    kind: 'delivered',
    title: 'Delivered items',
    subtitle: 'Everything delivered, grouped by outcome.',
    eyebrow: 'PROJECT CLOSEOUT',
    sortOrder: 0,
    isVisible: true,
  },
  {
    kind: 'credentials',
    title: 'Credentials',
    subtitle: 'Access details stay inside the signed portal.',
    eyebrow: 'SECURE DELIVERY',
    sortOrder: 1,
    isVisible: false,
  },
  {
    kind: 'training',
    title: 'Training materials',
    subtitle: 'Training notes answer the follow-up questions.',
    eyebrow: 'CLIENT SELF-SERVE',
    sortOrder: 2,
    isVisible: true,
  },
  {
    kind: 'support',
    title: 'Support boundary',
    subtitle: 'Support terms are agreed before the project closes.',
    eyebrow: 'SCOPE PROTECTION',
    sortOrder: 3,
    isVisible: true,
  },
  {
    kind: 'signoff',
    title: 'Client sign-off',
    subtitle: 'A signed closeout record both sides can keep.',
    eyebrow: 'FINAL ACCEPTANCE',
    sortOrder: 4,
    isVisible: true,
  },
] as const;

/** Fresh, independently mutable copies of the template rows. */
export function seedSections(): SeedSection[] {
  return SECTION_TEMPLATE.map((section) => ({ ...section }));
}
