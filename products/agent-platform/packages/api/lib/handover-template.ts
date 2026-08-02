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
 * The credentials section is an ACCESS RECORD, not a secret store. It documents
 * what accounts exist, who owns each one after handover, and how access was
 * transferred — never the passwords themselves. That is a deliberate product
 * decision, not a missing feature: the portal is reachable by anyone holding
 * the link, so a forwarded URL must never expose live credentials. Secrets stay
 * in the agency's password manager. Nothing here is encrypted because nothing
 * here is a secret.
 *
 * An agency with no accounts to hand over hides this section via
 * PATCH /handover/packs/:id/sections/:id, which also drops it from the
 * readiness checklist.
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
    title: 'Access handover',
    subtitle: 'Every account, who owns it now, and how access was transferred.',
    eyebrow: 'ACCOUNT OWNERSHIP',
    sortOrder: 1,
    isVisible: true,
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
