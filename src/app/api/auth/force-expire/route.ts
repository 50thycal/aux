import { NextResponse } from 'next/server'
import { readSession, writeSession } from '@/lib/spotify/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Test hook for the token lifecycle. Waiting an hour for natural expiry is not
 * a practical test, so we break the token deliberately:
 *
 *   mode=soft  expiry timestamp moved into the past -> exercises the *proactive*
 *              refresh that runs before the request goes out.
 *   mode=hard  access token corrupted while the timestamp still looks live ->
 *              exercises the *reactive* 401 -> refresh -> retry path, which is
 *              what actually happens when Spotify invalidates a token early.
 *   mode=break refresh token corrupted too -> proves we fail loudly and the UI
 *              tells the user to reconnect instead of hanging.
 */
export async function POST(req: Request) {
  const session = await readSession()
  if (!session) return NextResponse.json({ ok: false, error: 'not connected' }, { status: 401 })

  const mode = new URL(req.url).searchParams.get('mode') ?? 'soft'
  const next = { ...session }
  if (mode === 'soft') {
    next.expires_at = Date.now() - 1000
  } else if (mode === 'hard') {
    next.access_token = `${session.access_token.slice(0, 12)}-corrupted-by-auxcord-test`
    next.expires_at = Date.now() + 30 * 60 * 1000
  } else if (mode === 'break') {
    next.access_token = `${session.access_token.slice(0, 12)}-corrupted-by-auxcord-test`
    next.refresh_token = 'corrupted-by-auxcord-test'
    next.expires_at = Date.now() + 30 * 60 * 1000
  } else {
    return NextResponse.json({ ok: false, error: `unknown mode "${mode}"` }, { status: 400 })
  }

  await writeSession(next)
  return NextResponse.json({ ok: true, mode })
}
