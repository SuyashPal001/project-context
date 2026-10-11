import { describe, it, expect } from 'vitest'
import { CLAIM_STATUSES, claimKey, findClaims, mergeClaims, reviewClaims, parseClaimAnswers, type ClaimEntry, type ClaimAnswer } from './claims.js'
import { tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

type Over = { vo?: string[]; text?: string; line?: string; tagline?: string; category?: string; market?: string; brandName?: string; price?: { amount: string; mrp?: string; note?: string }; jingle?: { line: string; style: string; lyrics?: string[] } }
const plan = (o: Over = {}): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Fizz that wakes you up', category: o.category ?? 'beverage', tier: 'mass', objective: 'brand', market: o.market ?? 'india', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod', voiceId: 'v1', ...(o.brandName ? { brandName: o.brandName } : {}), ...(o.jingle ? { jingle: o.jingle } : {}) },
  look: 'bright', locations: ['kitchen'],
  shots: [
    { n: 1, type: 'hook', size: 'wide', action: 'a girl opens the fridge', durationSeconds: 2, brandVisible: true, productVisible: true, audio: o.line ? 'line' : 'voiceover', ...(o.line ? { line: o.line } : {}), ...(o.text ? { text: o.text } : {}), ...(o.price ? { price: o.price } : {}) },
    { n: 2, type: 'superpower', size: 'close_up', action: 'icy wind swirls around the bottle in the kitchen', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover' },
    { n: 3, type: 'packshot', size: 'medium', action: 'bottle on the counter', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'silent' },
  ],
  voiceover: (o.vo ?? []).map((text, i) => ({ text, startSeconds: 0.2 + i * 1.5 })),
  packshot: { kind: 'product', ...(o.tagline ? { tagline: o.tagline } : {}) },
})
const live = (p: TvcPlan) => findClaims(p).filter((f) => !f.informational)
const kinds = (vo: string, o: Over = {}) => live(plan({ ...o, vo: [vo] })).map((f) => f.kind)

describe('claimKey', () => {
  it('normalises case, quotes, spaces and trailing punctuation', () => {
    expect(claimKey('  India’s   No.1 fizz! ')).toBe("india's no.1 fizz")
    expect(claimKey('“Doctor recommended.”')).toBe('doctor recommended')
  })
  it('NFC-normalises Devanagari with a nukta typed either way', () => {
    expect(claimKey('सबसे ज़्यादा')).toBe(claimKey('सबसे ज़्यादा'))
  })
  it('F2: folds "No. 1"/"No.1", "# 1"/"#1" and "99 %"/"99%" to the same key', () => {
    expect(claimKey('No. 1 fizz')).toBe(claimKey('No.1 fizz'))
    expect(claimKey('# 1 in India')).toBe(claimKey('#1 in India'))
    expect(claimKey('Kills 99 % of germs')).toBe(claimKey('Kills 99% of germs'))
  })
})

describe('findClaims: positives', () => {
  it.each([
    ["India's No.1 fizz", 'superlative'],
    ['#1 in India', 'superlative'],
    ['The best coffee in town', 'superlative'],
    ['Most trusted by mothers', 'superlative'],
    ['Sabse best chai', 'superlative'],
    ['भारत का नंबर 1 पेय', 'superlative'],
    ['सबसे अच्छा स्वाद', 'superlative'],
    ['सबसे ज़्यादा बिकने वाला', 'superlative'],
    ['Kills 99.9% of germs', 'number'],
    ['2x more fizz', 'number'],
    ['Results in 7 days', 'number'],
    ['9 out of 10 dentists agree', 'number'],
    ['Clinically proven formula', 'proven'],
    ['Clinically-proven formula', 'proven'],
    ['Lab-proven results', 'proven'],
    ['4 in 5 doctors recommend it', 'number'],
    ['1 in 3 Indians choose Bubbli', 'number'],
    ['Lab-tested for purity', 'proven'],
    ['Doctor recommended toothpaste', 'endorsement'],
    ['Approved by experts', 'endorsement'],
    ['100% natural', 'absolute'],
    ['Zero sugar', 'absolute'],
    ['Guaranteed freshness', 'absolute'],
    ['Never fades', 'absolute'],
    ['Boosts immunity', 'health'],
    ['Relief from acidity', 'health'],
  ])('%s -> %s', (vo, kind) => {
    expect(kinds(vo)).toEqual([kind])
  })
  it('"pure" is a claim only for food, beverage and health', () => {
    expect(kinds('Pure mountain water')).toEqual(['absolute'])
    expect(kinds('Pure comfort', { category: 'fashion' })).toEqual([])
  })
  it('a bare "treat" is a claim only in a health ad', () => {
    expect(kinds('Treats cough fast')).toEqual(['health'])
    expect(kinds('Treats everyday tiredness', { category: 'health' })).toEqual(['health'])
    expect(kinds('Treats everyday tiredness')).toEqual([])
  })
})

describe('findClaims: everyday lines are not claims (Review Focus 1, E13)', () => {
  it.each([
    'Treat yourself', 'A sweet treat', 'Never miss a moment', 'Always there for you', 'Be your best self',
    'Best friends forever', 'All the best', 'The best of both worlds', 'Taste-tested by moms', 'Time-tested recipe',
    'Bestow a smile', 'Leading the way', 'Completely yours', 'Recommended for you', 'Two friends, one fizz',
    'Ready in a flash', 'Fizz that wakes you up',
    // F4 (final review): everyday lines added after the whole-branch review.
    'Open 24 x 7', 'Pack of 6 x 200 ml', 'Incl. 18% GST', 'Fizz, 18% tax extra',
    'The best part of my day', 'The best time of the year', 'Time-proven recipe',
    'Instant relief from the summer heat',
  ])('%s', (vo) => {
    expect(kinds(vo)).toEqual([])
  })
  it('"2 in 1 shampoo" is not a claim (F4; only "N in 1" is excluded)', () => {
    expect(kinds('2 in 1 shampoo', { category: 'beauty' })).toEqual([])
  })
  it('keeps "2x" and "3 times" as claims although a bare space before "x" is not (F4)', () => {
    expect(kinds('2x more fizz')).toEqual(['number'])
    expect(kinds('Works 3 times as fast')).toEqual(['number'])
  })
  it('keeps "9 out of 10 dentists" and a disease relief claim as claims (F4)', () => {
    expect(kinds('9 out of 10 dentists agree')).toEqual(['number'])
    expect(kinds('Relief from acidity')).toEqual(['health'])
  })
})

describe('findClaims: building a finding', () => {
  it('cuts the clause around the match, keeping "No.1", "₹4.99" and "99.9%" whole', () => {
    const f = live(plan({ vo: ['Cold and crisp, India’s No.1 fizz for ₹4.99 only. Grab one'] }))
    expect(f).toHaveLength(1)
    expect(f[0].text).toBe('India’s No.1 fizz for ₹4.99 only')
  })
  it('keeps at most 12 words, nearest the match', () => {
    const vo = 'one two three four five six seven eight clinically proven nine ten eleven twelve thirteen fourteen fifteen'
    const f = live(plan({ vo: [vo] }))
    expect(f[0].text.split(' ')).toHaveLength(12)
    expect(f[0].text).toContain('clinically proven')
  })
  it('two matches in one clause are one finding of the first kind in table order', () => {
    expect(kinds('Guaranteed results in 7 days')).toEqual(['number'])
  })
  it('masks the brand name, so a brand word is never a claim (E5)', () => {
    expect(live(plan({ brandName: 'BestSeller', vo: ['BestSeller chips, crunchy'] }))).toEqual([])
  })
  it('merges the same phrase in the voiceover and on screen (E3)', () => {
    const f = live(plan({ vo: ['No.1 fizz.'], text: 'No.1 fizz' }))
    expect(f).toHaveLength(1)
    expect(f[0].where.map((w) => w.place).sort()).toEqual(['shot_text', 'voiceover'])
  })
  it('scans on-camera lines, the tagline, the price note and the jingle (E6)', () => {
    const p = plan({ line: 'Doctor recommended!', tagline: 'India’s most loved fizz', price: { amount: '₹49', note: '50% off today' }, jingle: { line: 'Bubbli, sabse best', style: 'pop' } })
    const places = live(p).flatMap((f) => f.where.map((w) => w.place)).sort()
    expect(places).toEqual(['jingle', 'line', 'price_note', 'tagline'])
  })
  it('lists an MRP offer and a superpower shot as informational (D10)', () => {
    const info = findClaims(plan({ price: { amount: '₹499', mrp: '₹699' } })).filter((f) => f.informational)
    expect(info.map((f) => [f.kind, f.text])).toEqual([
      ['offer', '₹499 (MRP ₹699)'],
      ['visual', 'icy wind swirls around the bottle in the kitchen'],
    ])
  })
  it('marks a disease claim likely banned in India in any category, never elsewhere (M1, E10)', () => {
    expect(live(plan({ vo: ['Karela juice controls diabetes'] }))[0].likelyBanned).toBe(true)
    expect(live(plan({ vo: ['Karela juice controls diabetes'], market: 'generic' }))[0].likelyBanned).toBeUndefined()
  })
})

const entry = (text: string, status: ClaimEntry['status'], proof?: string): ClaimEntry => ({ text, status, ...(proof ? { proof } : {}) })
const ans = (key: string, answer: ClaimAnswer['answer'], extra: Partial<ClaimAnswer> = {}): ClaimAnswer => ({ key, answer, ...extra })
const answerMap = (...entries: ClaimAnswer[]) => new Map(entries.map((a) => [a.key, a]))

describe('mergeClaims', () => {
  it('a new user answer wins over an unchanged re-sent entry (re-review minor 4)', () => {
    const out = mergeClaims({ inherited: [], previous: [entry('No.1 fizz', 'no_proof')], incoming: [entry('No.1 fizz', 'no_proof')], answers: answerMap(ans('no.1 fizz', 'proof', { proof: 'Nielsen 2026' })), auto: false })
    expect(out.entries).toEqual([entry('No.1 fizz', 'proof', 'Nielsen 2026')])
  })
  it('a partial incoming list keeps the earlier answers; the incoming entry wins', () => {
    const out = mergeClaims({ inherited: [], previous: [entry('No.1 fizz', 'no_proof'), entry('Zero sugar', 'proof', 'Lab report')], incoming: [entry('no.1 fizz', 'proof', 'made up text')], answers: answerMap(ans('no.1 fizz', 'proof', { proof: 'Nielsen 2026' })), auto: false })
    expect(out.entries).toEqual([entry('no.1 fizz', 'proof', 'Nielsen 2026'), entry('Zero sugar', 'proof', 'Lab report')])
    expect(out.warnings).toEqual([])
  })
  it('Ask mode ignores a new or changed entry the user never answered (D9, E14)', () => {
    const out = mergeClaims({ inherited: [], previous: [], incoming: [entry('No.1 fizz', 'proof', 'made up')], answers: answerMap(), auto: false })
    expect(out.entries).toEqual([])
    expect(out.warnings).toEqual(['CLAIM_NOT_FROM_USER: "No.1 fizz" was not answered by the user; ask them'])
  })
  it('an unchanged entry passes without an answer', () => {
    const out = mergeClaims({ inherited: [], previous: [entry('No.1 fizz', 'no_proof')], incoming: [entry('No.1 fizz', 'no_proof')], answers: answerMap(), auto: false })
    expect(out.entries).toEqual([entry('No.1 fizz', 'no_proof')])
  })
  it('Auto mode accepts only no_proof from Director (D4)', () => {
    const out = mergeClaims({ inherited: [], previous: [], incoming: [entry('No.1 fizz', 'no_proof'), entry('Zero sugar', 'proof', 'x')], answers: answerMap(), auto: true })
    expect(out.entries).toEqual([entry('No.1 fizz', 'no_proof')])
    expect(out.warnings).toHaveLength(1)
  })
  it('with no answers set at all (callers outside the tool), every entry is accepted', () => {
    const out = mergeClaims({ inherited: [], previous: [], incoming: [entry('No.1 fizz', 'proof', 'x')], auto: false })
    expect(out.entries).toHaveLength(1)
  })
  it('inherited (a cutdown\'s original) comes first and previous overrides it', () => {
    const out = mergeClaims({ inherited: [entry('No.1 fizz', 'no_proof')], previous: [entry('No.1 fizz', 'proof', 'Nielsen')], incoming: [], auto: false })
    expect(out.entries).toEqual([entry('No.1 fizz', 'proof', 'Nielsen')])
    expect([...out.fromPrevious]).toEqual(['no.1 fizz'])
  })

  describe('F1: the stored entry comes from the user\'s own answer, not Director\'s', () => {
    it('"I have proof" with real proof text stores the user\'s proof, even if Director wrote something else', () => {
      const out = mergeClaims({ inherited: [], previous: [], incoming: [entry('No.1 fizz', 'proof', 'Director made this up')], answers: answerMap(ans('no.1 fizz', 'proof', { proof: 'Nielsen MAT 2026' })), auto: false })
      expect(out.entries).toEqual([entry('No.1 fizz', 'proof', 'Nielsen MAT 2026')])
      expect(out.warnings).toEqual([])
    })
    it('"I have proof" with an empty proof is stored as no_proof with CLAIM_PROOF_MISSING, never a made-up proof', () => {
      const out = mergeClaims({ inherited: [], previous: [], incoming: [entry('No.1 fizz', 'proof', 'invented proof')], answers: answerMap(ans('no.1 fizz', 'no_proof', { proofMissing: true })), auto: false })
      expect(out.entries).toEqual([entry('No.1 fizz', 'no_proof')])
      expect(out.warnings).toEqual(['CLAIM_PROOF_MISSING: "No.1 fizz" was answered "I have proof" with no proof given; kept as no proof — ask the user what the proof is'])
    })
    it('a status proof for a key the user answered no_proof is stored as no_proof, ignoring Director\'s invented proof', () => {
      const out = mergeClaims({ inherited: [], previous: [], incoming: [entry('No.1 fizz', 'proof', 'invented')], answers: answerMap(ans('no.1 fizz', 'no_proof')), auto: false })
      expect(out.entries).toEqual([entry('No.1 fizz', 'no_proof')])
    })
    it('a soften answer accepts no entry; one that arrives anyway is dropped, naming soften', () => {
      const out = mergeClaims({ inherited: [], previous: [], incoming: [entry('No.1 fizz', 'no_proof')], answers: answerMap(ans('no.1 fizz', 'soften')), auto: false })
      expect(out.entries).toEqual([])
      expect(out.warnings[0]).toContain('soften')
    })
    it('re-sending an already-answered key with a different proof and no new answer keeps the stored one, with CLAIM_KEPT', () => {
      const out = mergeClaims({ inherited: [], previous: [entry('No.1 fizz', 'proof', 'Nielsen 2026')], incoming: [entry('No.1 fizz', 'proof', 'a different made-up number')], answers: answerMap(), auto: false })
      expect(out.entries).toEqual([entry('No.1 fizz', 'proof', 'Nielsen 2026')])
      expect(out.warnings).toEqual(['CLAIM_KEPT: "No.1 fizz" already has the user\'s answer; it was kept'])
    })
  })
})

describe('reviewClaims', () => {
  it('lists findings with no entry, warns on no_proof and drops stale entries it owned', () => {
    const p = plan({ vo: ['India’s No.1 fizz', 'Zero sugar'] })
    const out = reviewClaims(p, [entry('Zero sugar', 'no_proof'), entry('Old claim', 'no_proof'), entry('Master only', 'no_proof')], new Set(['old claim']))
    expect(out.toReview.map((f) => f.text)).toEqual(['India’s No.1 fizz'])
    expect(out.claims).toEqual([entry('Zero sugar', 'no_proof')])
    expect(out.warnings).toEqual([
      'CLAIM_DROPPED: "Old claim" is no longer in the ad',
      'CLAIM_NO_PROOF: "Zero sugar" is kept without proof; the claims summary lists it under Needs proof before airing',
    ])
  })
  it('warns on a likely-banned claim even when it is answered', () => {
    const p = plan({ vo: ['Karela juice controls diabetes'] })
    const out = reviewClaims(p, [entry('Karela juice controls diabetes', 'proof', 'study')], new Set())
    expect(out.warnings).toEqual(['CLAIM_LIKELY_BANNED: "Karela juice controls diabetes" may not be allowed (Drugs and Magic Remedies Act 1954); check with a lawyer before airing'])
  })
  it('never asks about informational findings', () => {
    expect(reviewClaims(plan({ price: { amount: '₹499', mrp: '₹699' } }), [], new Set()).toReview).toEqual([])
  })
  it('F2: an entry from this check\'s incoming that matches no finding gets CLAIM_NO_MATCH, not CLAIM_DROPPED', () => {
    const p = plan({ vo: ['India’s No.1 fizz'] })
    const out = reviewClaims(p, [entry('Indias No1 fizz', 'no_proof')], new Set(), new Set(['indias no1 fizz']))
    expect(out.warnings).toEqual(['CLAIM_NO_MATCH: "Indias No1 fizz" matches no flagged phrase; use the phrase exactly as plan_tvc returned it: "India’s No.1 fizz"'])
  })
})

describe('parseClaimAnswers', () => {
  it('the first keyword in the answer wins (re-review minor 3)', () => {
    expect(parseClaimAnswers('Claims: "No.1 fizz" = not a claim, do not soften')).toEqual([{ key: 'no.1 fizz', answer: 'not_a_claim' }])
    expect(parseClaimAnswers('Claims: "No.1 fizz" = Not a claim (no proof needed)')).toEqual([{ key: 'no.1 fizz', answer: 'not_a_claim' }])
  })
  it('reads every Claims: line as a ClaimAnswer, straight or curly quotes', () => {
    const prompt = 'flow: tvc ad\nstep: plan\nTVC plan: abc\nClaims: "India’s No.1 fizz" = proof: Nielsen 2026\nClaims: “Zero sugar” = no_proof'
    expect(parseClaimAnswers(prompt)).toEqual([
      { key: "india's no.1 fizz", answer: 'proof', proof: 'Nielsen 2026' },
      { key: 'zero sugar', answer: 'no_proof' },
    ])
  })
  it('is undefined with no Claims: lines', () => {
    expect(parseClaimAnswers('flow: tvc ad\nstep: plan')).toBeUndefined()
  })
  it('parses soften and not_a_claim answers', () => {
    const prompt = 'Claims: "No.1 fizz" = soften\nClaims: "Fizz that wakes you up" = not_a_claim'
    expect(parseClaimAnswers(prompt)).toEqual([
      { key: 'no.1 fizz', answer: 'soften' },
      { key: 'fizz that wakes you up', answer: 'not_a_claim' },
    ])
  })
  it('F1: an empty or placeholder proof is parsed as no_proof with proofMissing', () => {
    for (const rhs of ['proof:', 'proof: ', 'proof: none', 'proof: N/A', 'proof: -', 'proof: (not given)', 'proof: nothing', 'proof: tbd']) {
      expect(parseClaimAnswers(`Claims: "No.1 fizz" = ${rhs}`)).toEqual([{ key: 'no.1 fizz', answer: 'no_proof', proofMissing: true }])
    }
  })
  it('F2: tolerates a bullet, a numbered list marker and a bold "Claims:" prefix', () => {
    for (const prefix of ['- ', '* ', '• ', '1. ', '1) ', '']) {
      expect(parseClaimAnswers(`${prefix}Claims: "No.1 fizz" = no_proof`)).toEqual([{ key: 'no.1 fizz', answer: 'no_proof' }])
    }
    expect(parseClaimAnswers('**Claims:** "No.1 fizz" = no_proof')).toEqual([{ key: 'no.1 fizz', answer: 'no_proof' }])
  })
  it('F2: tolerates straight single quotes around the phrase', () => {
    expect(parseClaimAnswers("Claims: 'No.1 fizz' = no_proof")).toEqual([{ key: 'no.1 fizz', answer: 'no_proof' }])
  })
  it('tolerates "keep it, no proof" and "not a claim" phrasing from the card options', () => {
    expect(parseClaimAnswers('Claims: "No.1 fizz" = keep it, no proof')).toEqual([{ key: 'no.1 fizz', answer: 'no_proof' }])
    expect(parseClaimAnswers('Claims: "No.1 fizz" = not a claim')).toEqual([{ key: 'no.1 fizz', answer: 'not_a_claim' }])
  })
})

describe('schema guard', () => {
  it('the schema status list matches CLAIM_STATUSES', () => {
    const parsed = tvcPlanSchema.shape.claims.safeParse([{ text: 'x', status: 'bogus' }])
    expect(parsed.success).toBe(false)
    for (const status of CLAIM_STATUSES) expect(tvcPlanSchema.shape.claims.safeParse([{ text: 'x', status, proof: 'p' }]).success).toBe(true)
  })
})
