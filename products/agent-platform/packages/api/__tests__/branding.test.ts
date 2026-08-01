import { describe, it, expect } from 'vitest'
import { resolveBranding } from '../lib/branding'

const tenantBrand = {
  brandName: 'Acme Agency',
  logoUrl: 'https://cdn.example.com/acme.png',
  brandColor: '#111111',
}

describe('resolveBranding', () => {
  it('falls back to tenant branding when there is no client', () => {
    expect(resolveBranding(null, tenantBrand)).toEqual(tenantBrand)
  })

  it('falls back to tenant branding when every client field is null', () => {
    const client = { brandName: null, logoUrl: null, brandColor: null }
    expect(resolveBranding(client, tenantBrand)).toEqual(tenantBrand)
  })

  it('lets a client field override the tenant field', () => {
    const client = { brandName: 'Globex', logoUrl: null, brandColor: null }
    expect(resolveBranding(client, tenantBrand)).toEqual({
      brandName: 'Globex',
      logoUrl: 'https://cdn.example.com/acme.png',
      brandColor: '#111111',
    })
  })

  it('overrides every field when the client sets all of them', () => {
    const client = {
      brandName: 'Globex',
      logoUrl: 'https://cdn.example.com/globex.png',
      brandColor: '#00FF00',
    }
    expect(resolveBranding(client, tenantBrand)).toEqual(client)
  })

  it('treats an empty string as an intentional override, not a fallback', () => {
    const client = { brandName: '', logoUrl: null, brandColor: null }
    expect(resolveBranding(client, tenantBrand).brandName).toBe('')
  })

  it('does not mutate its arguments', () => {
    const client = { brandName: 'Globex', logoUrl: null, brandColor: null }
    const tenant = { ...tenantBrand }
    resolveBranding(client, tenant)
    expect(client).toEqual({ brandName: 'Globex', logoUrl: null, brandColor: null })
    expect(tenant).toEqual(tenantBrand)
  })
})
