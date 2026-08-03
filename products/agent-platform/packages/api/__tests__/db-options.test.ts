import { describe, it, expect } from 'vitest'
import { resolveDbOptions } from '../lib/db-options'

const BASE = 'postgresql://u:p@host.example.com:5432/db'

describe('resolveDbOptions', () => {
  it('defaults to the strict, direct-connection behaviour', () => {
    expect(resolveDbOptions(BASE, {})).toEqual({
      sslNoVerify: false,
      disablePrepare: false,
    })
  })

  it('does not relax TLS for sslmode=require', () => {
    // require means "encrypt", not "skip verification" — a deployment that
    // needs the chain skipped must say no-verify.
    expect(resolveDbOptions(`${BASE}?sslmode=require`, {}).sslNoVerify).toBe(false)
  })

  it('skips chain verification for sslmode=no-verify', () => {
    expect(resolveDbOptions(`${BASE}?sslmode=no-verify`, {}).sslNoVerify).toBe(true)
  })

  it('disables prepared statements for pgbouncer=true', () => {
    expect(resolveDbOptions(`${BASE}?pgbouncer=true`, {}).disablePrepare).toBe(true)
  })

  it('reads both flags from the same url', () => {
    expect(resolveDbOptions(`${BASE}?sslmode=no-verify&pgbouncer=true`, {})).toEqual({
      sslNoVerify: true,
      disablePrepare: true,
    })
  })

  it('lets env vars turn either on without touching the url', () => {
    expect(resolveDbOptions(BASE, { DATABASE_SSL_NO_VERIFY: 'true' }).sslNoVerify).toBe(true)
    expect(resolveDbOptions(BASE, { DATABASE_DISABLE_PREPARE: 'true' }).disablePrepare).toBe(true)
  })

  it('accepts 1 as well as true', () => {
    expect(resolveDbOptions(BASE, { DATABASE_SSL_NO_VERIFY: '1' }).sslNoVerify).toBe(true)
    expect(resolveDbOptions(`${BASE}?pgbouncer=1`, {}).disablePrepare).toBe(true)
  })

  it('ignores values that are not an affirmative flag', () => {
    expect(resolveDbOptions(BASE, { DATABASE_SSL_NO_VERIFY: 'false' }).sslNoVerify).toBe(false)
    expect(resolveDbOptions(BASE, { DATABASE_SSL_NO_VERIFY: '' }).sslNoVerify).toBe(false)
    expect(resolveDbOptions(`${BASE}?pgbouncer=no`, {}).disablePrepare).toBe(false)
  })

  it('never infers behaviour from the host or the port', () => {
    // The whole point: a hostname or port must not change how we connect.
    const pooler = 'postgresql://u:p@aws-0-x.pooler.supabase.com:6543/postgres'
    const neon = 'postgresql://u:p@ep-x.neon.tech:5432/neondb'
    expect(resolveDbOptions(pooler, {})).toEqual({ sslNoVerify: false, disablePrepare: false })
    expect(resolveDbOptions(neon, {})).toEqual({ sslNoVerify: false, disablePrepare: false })
  })

  it('falls back to defaults when the connection string is unparseable', () => {
    expect(resolveDbOptions('not a url', {})).toEqual({
      sslNoVerify: false,
      disablePrepare: false,
    })
  })
})
