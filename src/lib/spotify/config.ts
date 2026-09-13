/**
 * Environment-derived configuration. Nothing secret is ever sent to the browser:
 * every value in here is read only inside route handlers (Node runtime).
 */

/**
 * Overridable only so the integration test can point the whole app at a mock
 * Spotify. Unset in every real environment, which yields the real hosts.
 */
export const SPOTIFY_ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_BASE ?? 'https://accounts.spotify.com'
export const SPOTIFY_API = process.env.SPOTIFY_API_BASE ?? 'https://api.spotify.com/v1'

/**
 * Minimal scope set for the spike.
 *
 *   user-read-playback-state    -> GET /me/player, /me/player/devices, /me/player/queue
 *   user-read-currently-playing -> GET /me/player/currently-playing
 *   user-modify-playback-state  -> play/pause/next/previous/seek/queue/transfer
 *
 * Deliberately NOT requested: playlist scopes, library scopes, user-read-email,
 * streaming. If a call fails with 403 we want to know it is a *scope* problem,
 * not have it masked by an over-broad grant.
 */
export const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
] as const

export const SCOPE_STRING = SCOPES.join(' ')

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `Missing environment variable ${name}. See docs/RUNBOOK.md — copy .env.example to .env.local (local) or set it in Vercel project settings (deployed).`,
    )
  }
  return v
}

export function clientId(): string {
  return required('SPOTIFY_CLIENT_ID')
}

export function sessionSecret(): string {
  const s = required('SESSION_SECRET')
  if (s.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters.')
  }
  return s
}

/**
 * The redirect URI must match, byte for byte, one of the entries registered in the
 * Spotify developer dashboard. We derive it from an explicit env var when present
 * so that preview deployments (whose hostname changes per deploy) fail loudly
 * rather than silently redirecting somewhere unregistered.
 */
export function redirectUri(req: Request): string {
  const explicit = process.env.SPOTIFY_REDIRECT_URI
  if (explicit) return explicit
  const url = new URL(req.url)
  return `${url.origin}/api/auth/callback`
}
