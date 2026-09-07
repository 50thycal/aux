import { NextResponse } from 'next/server'
import { SPOTIFY_ACCOUNTS, SCOPE_STRING, clientId, redirectUri } from '@/lib/spotify/config'
import { challengeFor, createState, createVerifier } from '@/lib/spotify/pkce'
import { cookieSecure, PKCE_COOKIE } from '@/lib/spotify/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const verifier = createVerifier()
  const state = createState()
  const redirect = redirectUri(req)

  const authorize = new URL(`${SPOTIFY_ACCOUNTS}/authorize`)
  authorize.searchParams.set('client_id', clientId())
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('redirect_uri', redirect)
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('code_challenge', challengeFor(verifier))
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('scope', SCOPE_STRING)
  // Force the consent screen so we can re-test the grant without revoking by hand.
  if (new URL(req.url).searchParams.get('force') === '1') {
    authorize.searchParams.set('show_dialog', 'true')
  }

  const res = NextResponse.redirect(authorize.toString())
  res.cookies.set(PKCE_COOKIE, JSON.stringify({ verifier, state, redirect }), {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  })
  return res
}
