import { NextResponse } from 'next/server'
import { exchangeCode } from '@/lib/spotify/tokens'
import { cookieSecure, PKCE_COOKIE, seal, SESSION_COOKIE, type SpotifyUser } from '@/lib/spotify/session'
import { call } from '@/lib/spotify/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function fail(req: Request, message: string, detail?: unknown) {
  const url = new URL('/', req.url)
  url.searchParams.set('auth_error', message)
  if (detail !== undefined) {
    url.searchParams.set('auth_detail', JSON.stringify(detail).slice(0, 800))
  }
  return NextResponse.redirect(url)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')

  if (denied) return fail(req, `Spotify returned "${denied}"`)
  if (!code || !state) return fail(req, 'Callback missing code or state')

  const raw = req.headers.get('cookie')?.match(/auxcord_pkce=([^;]+)/)?.[1]
  if (!raw) return fail(req, 'PKCE cookie missing or expired — restart the connect flow')

  let stored: { verifier: string; state: string; redirect: string }
  try {
    stored = JSON.parse(decodeURIComponent(raw))
  } catch {
    return fail(req, 'PKCE cookie unreadable')
  }
  if (stored.state !== state) return fail(req, 'State mismatch — possible CSRF, aborting')

  try {
    let session = await exchangeCode(code, stored.verifier, stored.redirect)

    // Fetch the profile immediately: `product` tells us whether player commands
    // can work at all, and it is the cheapest possible check of the fresh token.
    const me = await call<SpotifyUser & { product?: string; country?: string }>(session, {
      action: 'me',
      method: 'GET',
      path: '/me',
      note: 'post-auth profile fetch',
    })
    session = me.session
    if (me.ok && me.data) {
      session.user = {
        id: me.data.id,
        display_name: me.data.display_name ?? null,
        product: me.data.product ?? null,
        country: me.data.country ?? null,
      }
    }

    const res = NextResponse.redirect(new URL('/', req.url))
    res.cookies.set(SESSION_COOKIE, seal(session), {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    res.cookies.delete(PKCE_COOKIE)
    return res
  } catch (err) {
    const e = err as { message?: string; status?: number; body?: unknown }
    return fail(req, e.message ?? 'Token exchange failed', { status: e.status, body: e.body })
  }
}
