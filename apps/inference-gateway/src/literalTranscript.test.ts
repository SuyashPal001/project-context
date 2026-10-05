import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('google-auth-library', () => ({
  GoogleAuth: class { async getClient() { return { getAccessToken: async () => ({ token: 'tok' }) } } },
}))
import { literalTranscript } from './literalTranscript.js'

describe('literalTranscript', () => {
  const orig = process.env.VERTEX_PROJECT
  afterEach(() => { if (orig === undefined) delete process.env.VERTEX_PROJECT; else process.env.VERTEX_PROJECT = orig; vi.restoreAllMocks() })

  it('asks Chirp 2 with no script and joins its results', async () => {
    process.env.VERTEX_PROJECT = 'proj'
    const f = vi.fn(async () => new Response(JSON.stringify({ results: [{ alternatives: [{ transcript: 'my skin has never looked this briny' }] }, { alternatives: [{ transcript: ' i started' }] }] })))
    global.fetch = f as unknown as typeof fetch
    expect(await literalTranscript({ audioBase64: 'AAAA' })).toEqual({ text: 'my skin has never looked this briny i started' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://us-central1-speech.googleapis.com/v2/projects/proj/locations/us-central1/recognizers/_:recognize')
    expect(JSON.parse(init.body as string).config.model).toBe('chirp_2')
  })

  it('refuses without a project', async () => {
    delete process.env.VERTEX_PROJECT; delete process.env.GCLOUD_PROJECT
    expect(await literalTranscript({ audioBase64: 'AAAA' })).toMatchObject({ refused: true })
  })
})
