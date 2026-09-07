import { SPOTIFY_ACCOUNTS, clientId } from './config'
import type { Session } from './session'

type TokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
  }
}

async function postToken(params: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    cache: 'no-store',
  })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) {
    const desc =
      (body as { error_description?: string; error?: string })?.error_description ??
      (body as { error?: string })?.error ??
      `HTTP ${res.status}`
    throw new TokenError(desc, res.status, body)
  }
  return body as TokenResponse
}

export async function exchangeCode(code: string, verifier: string, redirect: string): Promise<Session> {
  const token = await postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId(),
      code_verifier: verifier,
    }),
  )
  if (!token.refresh_token) {
    // PKCE should always return one; if it does not, refresh testing is impossible
    // and we want that surfaced immediately rather than an hour later.
    throw new TokenError('Spotify did not return a refresh_token', 200, { scope: token.scope })
  }
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + token.expires_in * 1000,
    scope: token.scope ?? '',
    refresh_count: 0,
  }
}

/**
 * Spotify rotates refresh tokens on the PKCE flow: the response *may* carry a
 * new refresh_token, and when it does the old one stops working. Always prefer
 * the returned one, fall back to the stored one.
 */
export async function refresh(session: Session): Promise<Session> {
  const token = await postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token,
      client_id: clientId(),
    }),
  )
  return {
    ...session,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? session.refresh_token,
    expires_at: Date.now() + token.expires_in * 1000,
    scope: token.scope ?? session.scope,
    refreshed_at: Date.now(),
    refresh_count: (session.refresh_count ?? 0) + 1,
  }
}
