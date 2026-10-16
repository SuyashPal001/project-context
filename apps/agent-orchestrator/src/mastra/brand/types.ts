// Shapes shared with the API (products/agent-platform/packages/api/lib/brandPageExtract.ts,
// brandSchema.ts). Kept in sync by hand: the two packages can't import each other.
export interface WebsiteFacts {
  url: string; siteName: string | null; title: string | null; description: string | null
  headings: string[]; ctas: string[]; bodyText: string
  logoCandidates: string[]; iconUrls: string[]
  themeColor: string | null; cssColors: string[]; fonts: string[]
  stylesheetUrl: string | null
}

export interface InstagramFacts {
  handle: string; fullName: string | null; bio: string | null; externalUrl: string | null
  profilePicUrl: string | null; captions: string[]
}

export interface BrandFill {
  name: string; oneLiner: string; audience: string; region: string; toneWords: string[]
  emojiPolicy: string; signaturePhrases: string[]; ctaExamples: string[]; voiceNotes: string
  colors: Record<string, string>; headlineFont: string
}

export interface TenantBrand {
  name: string | null; oneLiner: string | null; audience: string | null; region: string
  toneWords: string[]; emojiPolicy: string; signaturePhrases: string[]; bannedPhrases: string[]
  ctaExamples: string[]; voiceNotes: string | null; colors: Record<string, string>
  headlineFont: string | null; logoFileId: string | null
}
