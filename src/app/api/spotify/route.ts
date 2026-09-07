import { NextResponse } from 'next/server'
import { runAction, type ActionRequest } from '@/lib/spotify/actions'
import { readSession, writeSession } from '@/lib/spotify/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// The burst test and observation reads can exceed the default budget.
export const maxDuration = 60

export async function POST(req: Request) {
  const session = await readSession()
  if (!session) {
    return NextResponse.json(
      { ok: false, status: 401, data: { error: { message: 'Not connected to Spotify' } }, entries: [] },
      { status: 401 },
    )
  }

  let body: ActionRequest
  try {
    body = (await req.json()) as ActionRequest
  } catch {
    return NextResponse.json({ ok: false, status: 400, data: null, entries: [] }, { status: 400 })
  }

  const result = await runAction(session, body)

  // Persist the session whenever a refresh rotated the tokens underneath us.
  if (
    result.session.access_token !== session.access_token ||
    result.session.refresh_token !== session.refresh_token
  ) {
    await writeSession(result.session)
  }

  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    data: result.data,
    entries: result.entries,
  })
}
