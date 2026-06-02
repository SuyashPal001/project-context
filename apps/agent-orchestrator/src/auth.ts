import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

const region = process.env.COGNITO_REGION ?? 'ap-south-1'
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? ''

const JWKS_URL = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`
const ISSUER = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`

// jose caches the JWKS response internally — one fetch per key rotation
const JWKS = createRemoteJWKSet(new URL(JWKS_URL))

export interface AuthPayload extends JWTPayload {
  sub: string
  email?: string
  'cognito:username'?: string
  'custom:tenantId'?: string
}

export async function validateToken(token: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: ISSUER,
  })
  if (!payload.sub) {
    throw new Error('Token missing sub claim')
  }
  return payload as AuthPayload
}
