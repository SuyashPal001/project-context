export interface PiiDetection {
  type: string
  count: number
}

export interface PiiFilterResult {
  sanitized: string
  map: Record<string, string>       // placeholder → original value, for optional de-masking
  detections: PiiDetection[]        // type + count only — never contains actual values
}

interface Rule {
  type: string
  label: string   // base label, e.g. "EMAIL" → placeholders become [EMAIL_1], [EMAIL_2] ...
  pattern: RegExp
}

// Rules applied in this exact order — more specific / higher-priority patterns first.
// AADHAAR must come before CARD and BANK_ACCOUNT to prevent 12-digit Aadhaar
// being swallowed by the generic numeric patterns.
const RULES: Rule[] = [
  {
    // Standard email addresses — requires TLD, so won't match bare UPI IDs (no TLD)
    type: 'EMAIL',
    label: 'EMAIL',
    pattern: /\b[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}\b/g,
  },
  {
    // Indian phone: 10-digit starting 6-9, optionally prefixed +91, 91, or 0
    type: 'PHONE',
    label: 'PHONE',
    pattern: /(?:\+91|91|0)[\s\-]?[6-9]\d{9}\b|\b[6-9]\d{9}\b/g,
  },
  {
    // Aadhaar: 12 digits, optionally space/hyphen separated every 4
    // Must come before CARD (16-digit) and BANK_ACCOUNT (9-18 digit) to avoid overlap
    type: 'AADHAAR',
    label: 'AADHAAR',
    pattern: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}\b|\b\d{12}\b/g,
  },
  {
    // PAN before Aadhaar/card — distinct alpha-numeric pattern
    type: 'PAN',
    label: 'PAN',
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
  },
  {
    // Passport: one letter + 7 digits
    type: 'PASSPORT',
    label: 'PASSPORT',
    pattern: /\b[A-Z]\d{7}\b/g,
  },
  {
    // Voter ID: 3 letters + 7 digits
    type: 'VOTER_ID',
    label: 'VOTER_ID',
    pattern: /\b[A-Z]{3}\d{7}\b/g,
  },
  {
    // Driving licence: state code (2 letters) + 2 digits + year (4 digits) + 7 digits
    // e.g. MH12 20150012345 or MH1220150012345
    type: 'DL',
    label: 'DL',
    pattern: /\b[A-Z]{2}\d{2}[\s\-]?\d{4}[\s\-]?\d{7}\b/g,
  },
  {
    // Credit/debit card: exactly 16 digits, optionally separated every 4
    type: 'CARD',
    label: 'CARD',
    pattern: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b|\b\d{16}\b/g,
  },
  {
    // IFSC: 4 letters + 0 + 6 alphanumeric
    type: 'IFSC',
    label: 'IFSC',
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  },
  {
    // Bank account: 9–18 standalone digits (after Aadhaar/Card/Phone are already masked)
    type: 'BANK_ACCOUNT',
    label: 'BANK_ACCOUNT',
    pattern: /\b\d{9,18}\b/g,
  },
  {
    // UPI IDs: xxx@yyy (no TLD required — covers VPA formats like name@okicici)
    type: 'UPI',
    label: 'UPI',
    pattern: /\b[\w.\-]+@[\w.\-]+\b/g,
  },
  {
    // Blood group: A/B/AB/O followed by + or - (with optional space)
    type: 'HEALTH',
    label: 'HEALTH',
    pattern: /\b(?:A|B|AB|O)[\s]?[+\-]\b/g,
  },
  {
    // Title-prefixed names
    type: 'NAME',
    label: 'NAME',
    pattern: /\b(?:Mr|Mrs|Ms|Dr|Prof|Shri|Smt)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
  },
  {
    // Indian pincode: exactly 6 digits starting with 1-9
    type: 'PINCODE',
    label: 'PINCODE',
    pattern: /\b[1-9]\d{5}\b/g,
  },
  {
    // Address patterns: flat/plot/house/door/no followed by a number
    type: 'ADDRESS',
    label: 'ADDRESS',
    pattern: /\b(?:flat|plot|house|door|h\.?no|d\.?no|apartment|apt|block)[\s.\-#]*\w+[\w\s,.\-]*/gi,
  },
]

export function filterPII(text: string): PiiFilterResult {
  // counters[type] tracks how many distinct values of this type have been seen
  const counters: Record<string, number> = {}
  // map: placeholder token → original matched value
  const map: Record<string, string> = {}
  // reverse map: original value → placeholder (so the same value always gets the same token)
  const seen: Record<string, string> = {}

  let working = text

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    working = working.replace(rule.pattern, (match) => {
      // Normalise whitespace/hyphens for dedup key (e.g. "1234 5678 9012" and "1234-5678-9012")
      const dedup = match.replace(/[\s\-]/g, '')
      if (seen[dedup]) return seen[dedup]

      counters[rule.type] = (counters[rule.type] ?? 0) + 1
      const placeholder = `[${rule.label}_${counters[rule.type]}]`
      map[placeholder] = match
      seen[dedup] = placeholder
      return placeholder
    })
  }

  const detections: PiiDetection[] = Object.entries(counters).map(([type, count]) => ({ type, count }))

  return { sanitized: working, map, detections }
}

/** Restore original values in a string using the map returned by filterPII.
 *  Only call this if you explicitly want to de-mask for display. */
export function restorePII(text: string, map: Record<string, string>): string {
  let result = text
  for (const [placeholder, original] of Object.entries(map)) {
    result = result.replaceAll(placeholder, original)
  }
  return result
}
