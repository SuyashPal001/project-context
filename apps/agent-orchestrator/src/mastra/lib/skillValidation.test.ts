import { describe, it, expect } from 'vitest'
import { validateSkillBody, validateVerbatimTokens } from './skillValidation.js'

const VALID_BODY = '---\nname: bid-writer\ndescription: Use when writing bids for prospective clients\n---\n\nOpen with the client name.'

describe('validateSkillBody', () => {
  it('accepts a well-formed draft', () => {
    expect(validateSkillBody(VALID_BODY, 'Bid Writer')).toBeNull()
  })

  it('rejects a frontmatter name that is not kebab-case', () => {
    const body = '---\nname: Bid_Writer\ndescription: Use when writing bids for prospective clients\n---\n\nBody.'
    expect(validateSkillBody(body, 'Bid Writer')).toMatch(/kebab-case/)
  })

  it('rejects a reserved word in the frontmatter name', () => {
    const body = '---\nname: claude-bid-writer\ndescription: Use when writing bids for prospective clients\n---\n\nBody.'
    expect(validateSkillBody(body, 'Bid Writer')).toMatch(/reserved word/)
  })

  it('rejects a description over 1024 characters', () => {
    const longDesc = `Use when ${'x'.repeat(1020)}`
    const body = `---\nname: bid-writer\ndescription: ${longDesc}\n---\n\nBody.`
    expect(validateSkillBody(body, 'Bid Writer')).toMatch(/too long/)
  })

  it('rejects a first-person description', () => {
    const body = '---\nname: bid-writer\ndescription: I can help you write bids when needed\n---\n\nBody.'
    expect(validateSkillBody(body, 'Bid Writer')).toMatch(/third person/)
  })

  it('rejects a second-person description', () => {
    const body = '---\nname: bid-writer\ndescription: You can use this when writing bids\n---\n\nBody.'
    expect(validateSkillBody(body, 'Bid Writer')).toMatch(/third person/)
  })

  it('rejects a body over the 500-line cap', () => {
    const body = `---\nname: bid-writer\ndescription: Use when writing bids for prospective clients\n---\n\n${'line\n'.repeat(500)}`
    expect(validateSkillBody(body, 'Bid Writer')).toMatch(/500-line cap/)
  })

  it('rejects allowed-tools present but empty', () => {
    const body = '---\nname: bid-writer\ndescription: Use when writing bids for prospective clients\nallowed-tools: \n---\n\nBody.'
    expect(validateSkillBody(body, 'Bid Writer')).toMatch(/allowed-tools/)
  })

  it('accepts allowed-tools with a value', () => {
    const body = '---\nname: bid-writer\ndescription: Use when writing bids for prospective clients\nallowed-tools: Bash\n---\n\nBody.'
    expect(validateSkillBody(body, 'Bid Writer')).toBeNull()
  })
})

describe('validateVerbatimTokens', () => {
  // Regression case: a real draft transposed one digit in one partner ID
  // and cross-contaminated a fragment of a different ID into another,
  // despite skillDraftAgent.ts's explicit "preserve verbatim" instruction.
  it('catches a single transposed character in a UUID', () => {
    const brief = 'Podglomerate: 96e6a49a-98bb-4a08-aebe-aa167a9c9c75'
    const draft = 'Podglomerate: 96e6a49a-98bb-4a08-aebe-aa167a9c7c75' // 9c9c75 -> 9c7c75
    expect(validateVerbatimTokens(brief, draft)).toMatch(/missing or altered/)
  })

  it('catches an ID cross-contaminated with a fragment of a different ID', () => {
    const brief = [
      'Invercorp: 2e782ff2-108c-4caf-abe1-5aa0e3d600b1',
      'Liquid Life: 687ff683-f60a-4b45-9dfa-1ba39a083f29',
    ].join('\n')
    const draft = 'Invercorp: 2e782ff2-108c-4caf-abe1-5aa0a083f29eb1' // Liquid Life's "a083f29" bled in
    expect(validateVerbatimTokens(brief, draft)).toMatch(/missing or altered/)
  })

  it('catches a corrupted URL even when its embedded ID happens to survive', () => {
    const brief = 'See https://example.com/assets/2e782ff2-108c-4caf-abe1-5aa0e3d600b1.webp'
    const draft = 'See https://example.com/assets/2e782ff2-108c-4caf-abe1-5aa0e3d600b1.png' // extension changed
    expect(validateVerbatimTokens(brief, draft)).toMatch(/URL from the brief/)
  })

  it('accepts a draft that preserves every ID and URL from the brief, even reformatted with backticks', () => {
    const brief = 'Milk: https://example.com/x/187ab6ad-d141-43b7-b29b-ab3bac46bd3c.png (ID: 187ab6ad-d141-43b7-b29b-ab3bac46bd3c)'
    const draft = '- **Milk**: `https://example.com/x/187ab6ad-d141-43b7-b29b-ab3bac46bd3c.png` (ID: `187ab6ad-d141-43b7-b29b-ab3bac46bd3c`)'
    expect(validateVerbatimTokens(brief, draft)).toBeNull()
  })

  it('does not false-positive on trailing punctuation after a URL', () => {
    const brief = 'Repository: https://github.com/example/repo.'
    const draft = 'See https://github.com/example/repo for details.'
    expect(validateVerbatimTokens(brief, draft)).toBeNull()
  })

  it('is a no-op when the brief has no IDs or URLs', () => {
    const brief = 'Always open with the client name and lead with delivery track record.'
    const draft = 'Anything at all, even unrelated text.'
    expect(validateVerbatimTokens(brief, draft)).toBeNull()
  })

  // Regression: a UUID appearing in both a "verified" summary line and the
  // per-logo catalog (N=2) must appear N times correctly in the draft. The old
  // Set+includes check passed as long as one correct occurrence existed — the
  // corrupted second occurrence was invisible to it.
  it('catches a corrupted second occurrence when the same UUID appears twice in the brief', () => {
    const uuid = '96e6a49a-98bb-4a08-aebe-aa167a9c9c75'
    const corrupted = '96e6a49a-98bb-4a08-aebe-aa167a9c7c75' // 9c75 -> 7c75
    const brief = [
      `Verified partner IDs: Podglomerate ${uuid}`,
      `| Podglomerate | ${uuid} | https://cdn.example.com/logo.png |`,
    ].join('\n')
    // Draft is correct in the summary, corrupted in the table
    const draft = [
      `- Podglomerate: \`${uuid}\``,
      `| Podglomerate | \`${corrupted}\` |`,
    ].join('\n')
    expect(validateVerbatimTokens(brief, draft)).toMatch(/missing or altered/)
  })

  it('accepts a draft where a UUID appearing twice in the brief also appears twice correctly', () => {
    const uuid = '96e6a49a-98bb-4a08-aebe-aa167a9c9c75'
    const brief = [
      `Verified: Podglomerate ${uuid}`,
      `| Podglomerate | ${uuid} |`,
    ].join('\n')
    const draft = [
      `- Podglomerate: \`${uuid}\``,
      `| Podglomerate | \`${uuid}\` |`,
    ].join('\n')
    expect(validateVerbatimTokens(brief, draft)).toBeNull()
  })
})
