import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'
import { sessionSecret } from './config'

export const SESSION_COOKIE = 'auxcord_session'
export const PKCE_COOKIE = 'auxcord_pkce'

export type SpotifyUser = {
  id: string
  display_name: string | null
  product: string | null
  country: string | null
}

export type Session = {
  access_token: string
  refresh_token: string
  /** Epoch ms at which the access token stops being accepted. */
  expires_at: number
  /** Scopes Spotify actually granted, which is not necessarily what we asked for. */
  scope: string
  user?: SpotifyUser
  /** Epoch ms of the most recent successful token refresh, for the log panel. */
  refreshed_at?: number
  /** How many refreshes this session has performed. Evidence for the token test. */
  refresh_count?: number
}

/**
 * Cookies are Secure in production. The escape hatch exists for running a
 * production build against plain http on a loopback address, where a Secure
 * cookie would simply be dropped and the session would never stick.
 */
export function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.AUXCORD_INSECURE_COOKIES !== '1'
}

function key(): Buffer {
  return createHash('sha256').update(sessionSecret()).digest()
}

/**
 * AES-256-GCM. The session cookie holds live OAuth tokens, so it is encrypted
 * (not merely signed) and httpOnly — the browser bundle never receives a token.
 */
export function seal(session: Session): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, body]).toString('base64url')
}

export function unseal(raw: string): Session | null {
  try {
    const buf = Buffer.from(raw, 'base64url')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const body = buf.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAuthTag(tag)
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    return JSON.parse(json) as Session
  } catch {
    // Wrong/rotated SESSION_SECRET, tampering, or a truncated cookie. Treat all
    // of them as "not logged in" rather than throwing a 500 at the user.
    return null
  }
}

export async function readSession(): Promise<Session | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value
  return raw ? unseal(raw) : null
}

export async function writeSession(session: Session): Promise<void> {
  const jar = await cookies()
  jar.set(SESSION_COOKIE, seal(session), {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
}

export async function clearSession(): Promise<void> {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  jar.delete(PKCE_COOKIE)
}
