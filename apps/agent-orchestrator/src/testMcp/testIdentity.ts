// The test MCP acts as one real user of one capped test tenant. It signs in with
// Cognito's public InitiateAuth JSON API (the web client allows
// USER_PASSWORD_AUTH, infra/terraform/foundation/main.tf), so every chat turn,
// file upload and charge runs exactly as it does for a person in the web app.
import type { TestMcpConfig } from './config.js'

export class TestIdentityError extends Error {
  constructor(public code: 'tenant_mismatch' | 'auth_failed' | 'me_failed', msg?: string) { super(msg ?? code) }
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

export class TestIdentity {
  private token = ''
  private refresh = ''
  private expiresAt = 0
  private sub = ''
  private internalId = ''

  constructor(private cfg: TestMcpConfig, private fetchImpl: typeof fetch = fetch, private now: () => number = Date.now) {}

  get userSub(): string { return this.sub }
  get internalUserId(): string { return this.internalId }

  async init(): Promise<void> {
    await this.auth('USER_PASSWORD_AUTH', { USERNAME: this.cfg.email, PASSWORD: this.cfg.password })
    const res = await this.fetchImpl(`${this.cfg.apiBaseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${this.token}` } })
    if (!res.ok) throw new TestIdentityError('me_failed', `auth/me ${res.status}`)
    const me = await res.json() as { userId?: string }
    if (!me.userId) throw new TestIdentityError('me_failed', 'auth/me returned no userId')
    this.internalId = me.userId
  }

  async idToken(): Promise<string> {
    if (this.now() >= this.expiresAt - REFRESH_MARGIN_MS) {
      await this.auth('REFRESH_TOKEN_AUTH', { REFRESH_TOKEN: this.refresh })
    }
    return this.token
  }

  private async auth(flow: 'USER_PASSWORD_AUTH' | 'REFRESH_TOKEN_AUTH', params: Record<string, string>): Promise<void> {
    const res = await this.fetchImpl(`https://cognito-idp.${this.cfg.cognitoRegion}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({ AuthFlow: flow, ClientId: this.cfg.cognitoClientId, AuthParameters: params }),
    })
    if (!res.ok) throw new TestIdentityError('auth_failed', `cognito ${res.status}`)
    const out = await res.json() as { AuthenticationResult?: { IdToken: string; RefreshToken?: string; ExpiresIn: number } }
    const r = out.AuthenticationResult
    if (!r?.IdToken) throw new TestIdentityError('auth_failed', 'no IdToken (challenge pending? set a permanent password)')
    const c = claims(r.IdToken)
    if (c['custom:tenantId'] !== this.cfg.tenantId) throw new TestIdentityError('tenant_mismatch', `token tenant ${String(c['custom:tenantId'])} != TEST_MCP_TENANT_ID`)
    this.token = r.IdToken
    if (r.RefreshToken) this.refresh = r.RefreshToken
    this.expiresAt = this.now() + r.ExpiresIn * 1000
    this.sub = String(c.sub ?? '')
  }
}
