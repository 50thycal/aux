import { NextResponse } from 'next/server'
import { SCOPE_STRING } from '@/lib/spotify/config'
import { readSession } from '@/lib/spotify/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Session metadata for the UI. Deliberately never includes a token. */
export async function GET() {
  const session = await readSession()
  if (!session) return NextResponse.json({ connected: false })

  const granted = session.scope.split(' ').filter(Boolean)
  const requested = SCOPE_STRING.split(' ')
  return NextResponse.json({
    connected: true,
    user: session.user ?? null,
    granted_scopes: granted,
    missing_scopes: requested.filter((s) => !granted.includes(s)),
    expires_at: session.expires_at,
    expires_in_s: Math.round((session.expires_at - Date.now()) / 1000),
    refreshed_at: session.refreshed_at ?? null,
    refresh_count: session.refresh_count ?? 0,
  })
}
