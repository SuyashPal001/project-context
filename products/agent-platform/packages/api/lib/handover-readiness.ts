export interface ReadinessCheck {
  key: string;
  label: string;
  complete: boolean;
}

export interface Readiness {
  checks: ReadinessCheck[];
  complete: number;
  total: number;
  pct: number;
}

interface ReadinessPack {
  scopeSummary?: string | null;
  deliveryDate?: Date | string | null;
  recipientEmail?: string | null;
}

interface ReadinessSection {
  id: string;
  title: string;
  isVisible: boolean;
}

interface ReadinessItem {
  sectionId: string;
}

function isPresent(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Readiness is derived, never stored. A stored checklist drifts the moment an
 * item is deleted, and reconciling it would be permanent work for no gain.
 *
 * Hidden sections are excluded: an agency that turns a section off should not
 * be blocked by it.
 */
export function computeReadiness(
  pack: ReadinessPack,
  sections: ReadinessSection[],
  items: ReadinessItem[],
): Readiness {
  const populated = new Set(items.map((item) => item.sectionId));

  const checks: ReadinessCheck[] = [
    {
      key: 'scopeSummary',
      label: 'Scope summary written',
      complete: isPresent(pack.scopeSummary),
    },
    {
      key: 'deliveryDate',
      label: 'Delivery date set',
      complete: pack.deliveryDate !== null && pack.deliveryDate !== undefined,
    },
    {
      key: 'recipientEmail',
      label: 'Client email confirmed',
      complete: isPresent(pack.recipientEmail),
    },
    ...sections
      .filter((section) => section.isVisible)
      .map((section) => ({
        key: `section:${section.id}`,
        label: `${section.title} has at least one record`,
        complete: populated.has(section.id),
      })),
  ];

  const total = checks.length;
  const complete = checks.filter((check) => check.complete).length;

  return {
    checks,
    complete,
    total,
    pct: total === 0 ? 0 : Math.round((complete / total) * 100),
  };
}
