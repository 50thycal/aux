import { createHash, randomBytes } from 'node:crypto'

/**
 * Authorization Code with PKCE. The code_verifier is generated and kept
 * server-side in an httpOnly cookie; the token exchange also happens
 * server-side. That gives us PKCE's "no client secret" property while still
 * keeping tokens out of the browser — the browser only ever holds a session
 * cookie it cannot read.
 */
export function createVerifier(): string {
  return randomBytes(64).toString('base64url')
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createState(): string {
  return randomBytes(16).toString('base64url')
}
