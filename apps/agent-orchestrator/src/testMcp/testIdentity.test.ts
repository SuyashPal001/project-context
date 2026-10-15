import { describe, it, expect, vi } from 'vitest'
import { TestIdentity, TestIdentityError } from './testIdentity.js'

const cfg = { port: 3007, tenantId: 't1', agentId: 'a1', email: 'x@y.z', password: 'pw', cognitoClientId: 'cid', cognitoRegion: 'ap-south-1', selfBaseUrl: 'http://127.0.0.1:3001', apiBaseUrl: 'https://api.example' }
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

function fakeFetch(tenant = 't1', expSec = 3600) {
  let n = 0
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('cognito-idp')) {
      n++
      const target = (init!.headers as Record<string, string>)['X-Amz-Target']
      expect(target).toBe('AWSCognitoIdentityProviderService.InitiateAuth')
      return new Response(JSON.stringify({ AuthenticationResult: {
        IdToken: jwt({ sub: 'sub1', 'custom:tenantId': tenant, exp: Math.floor(Date.now() / 1000) + expSec, n }),
        RefreshToken: 'r1', ExpiresIn: expSec,
      } }))
    }
    if (String(url).endsWith('/api/v1/auth/me')) return new Response(JSON.stringify({ userId: 'u-internal' }))
    throw new Error('unexpected ' + url)
  })
}

describe('TestIdentity', () => {
  it('signs in and resolves the internal user id', async () => {
    const f = fakeFetch()
    const id = new TestIdentity(cfg, f as any)
    await id.init()
    expect(id.internalUserId).toBe('u-internal')
    expect(await id.idToken()).toMatch(/^h\./)
  })
  it('refuses a token whose tenant is not the configured test tenant', async () => {
    const id = new TestIdentity(cfg, fakeFetch('other') as any)
    await expect(id.init()).rejects.toBeInstanceOf(TestIdentityError)
  })
  it('refreshes before expiry', async () => {
    let t = Date.now()
    const f = fakeFetch('t1', 600)
    const id = new TestIdentity(cfg, f as any, () => t)
    await id.init()
    const first = await id.idToken()
    t += 6 * 60 * 1000 // past expiry minus 5-minute margin
    const second = await id.idToken()
    expect(second).not.toBe(first)
    const authCalls = f.mock.calls.filter(([u]) => String(u).includes('cognito-idp'))
    expect(JSON.parse(String(authCalls[1][1]!.body)).AuthFlow).toBe('REFRESH_TOKEN_AUTH')
  })
})
