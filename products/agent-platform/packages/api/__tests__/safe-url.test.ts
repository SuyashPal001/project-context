import { describe, it, expect } from 'vitest'
import { isSafeHttpUrl } from '../lib/safe-url'
import { assertEditable } from '../lib/pack-status'

describe('isSafeHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeHttpUrl('http://example.com')).toBe(true)
    expect(isSafeHttpUrl('https://example.com/a/b?c=d#e')).toBe(true)
  })

  it('rejects the javascript scheme, which zod .url() accepts', () => {
    expect(isSafeHttpUrl('javascript:alert(document.domain)')).toBe(false)
  })

  it('rejects data URLs', () => {
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
  })

  it('rejects other schemes that parse as valid URLs', () => {
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeHttpUrl('ftp://example.com')).toBe(false)
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false)
  })

  it('is case-insensitive about the scheme', () => {
    expect(isSafeHttpUrl('JavaScript:alert(1)')).toBe(false)
    expect(isSafeHttpUrl('HTTPS://example.com')).toBe(true)
  })

  it('is not fooled by a scheme that merely starts with http', () => {
    expect(isSafeHttpUrl('httpevil://example.com')).toBe(false)
  })

  it('rejects a string that is not a URL at all', () => {
    expect(isSafeHttpUrl('not a url')).toBe(false)
    expect(isSafeHttpUrl('')).toBe(false)
  })

  it('treats null and undefined as absent rather than invalid', () => {
    // The field is optional/nullable; absence is the caller clearing it.
    expect(isSafeHttpUrl(null)).toBe(true)
    expect(isSafeHttpUrl(undefined)).toBe(true)
  })
})

describe('assertEditable', () => {
  it('allows a draft pack', () => {
    expect(assertEditable({ status: 'draft' })).toBeNull()
  })

  it('allows a sent pack, so it can be re-sent with a fresh token', () => {
    expect(assertEditable({ status: 'sent' })).toBeNull()
  })

  it('blocks a signed pack', () => {
    expect(assertEditable({ status: 'signed' })).toMatch(/signed/i)
  })

  it('blocks a revoked pack', () => {
    expect(assertEditable({ status: 'revoked' })).toMatch(/revoked/i)
  })
})
