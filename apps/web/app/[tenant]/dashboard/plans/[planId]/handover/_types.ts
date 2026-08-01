export type SectionKind = 'delivered' | 'credentials' | 'training' | 'support' | 'signoff';

export interface Pack {
  id: string;
  title: string;
  scopeSummary: string | null;
  deliveryDate: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  status: 'draft' | 'sent' | 'signed' | 'revoked';
  sentAt: string | null;
  signedAt: string | null;
  signedByName: string | null;
}

export interface Section {
  id: string;
  kind: SectionKind;
  title: string;
  subtitle: string | null;
  eyebrow: string | null;
  sortOrder: number;
  isVisible: boolean;
}

export interface Item {
  id: string;
  sectionId: string;
  title: string;
  description: string | null;
  statusLabel: string | null;
  categoryLabel: string | null;
  url: string | null;
  sortOrder: number;
}

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
