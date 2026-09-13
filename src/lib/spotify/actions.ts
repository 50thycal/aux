import { call, type CallResult } from './client'
import type { Session } from './session'
import type { LogEntry } from '@/lib/log'

export type ActionRequest = {
  action: string
  params?: Record<string, unknown>
}

export type ActionResponse = {
  ok: boolean
  status: number
  data: unknown
  /** One entry per HTTP call made while servicing this action. */
  entries: LogEntry[]
  session: Session
}

function str(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = params?.[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = params?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Observation reads are on by default for mutating commands, but a caller can
 * switch them off — the burst test must not insert an extra request between
 * commands whose relative ordering is the thing under test.
 */
function observeOpt(params: Record<string, unknown> | undefined, defaultDelayMs: number): number | false {
  return params?.observe === false ? false : defaultDelayMs
}

function deviceQuery(deviceId?: string): string {
  return deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
}

function single(r: CallResult): ActionResponse {
  return { ok: r.ok, status: r.status, data: r.data, entries: [r.entry], session: r.session }
}

/**
 * Every Spotify endpoint the spike is allowed to touch, named. Anything not in
 * here cannot be reached from the browser, so the proxy is not an open relay,
 * and the set of endpoints under test is legible at a glance.
 */
export async function runAction(session: Session, req: ActionRequest): Promise<ActionResponse> {
  const p = req.params
  const deviceId = str(p, 'device_id')
  const deviceName = str(p, 'device_name') ?? null

  switch (req.action) {
    case 'me':
      return single(await call(session, { action: 'me', method: 'GET', path: '/me' }))

    case 'devices':
      return single(
        await call(session, { action: 'devices', method: 'GET', path: '/me/player/devices' }),
      )

    case 'playback':
      return single(
        await call(session, {
          action: 'playback',
          method: 'GET',
          // additional_types=episode so a podcast does not read as "nothing playing".
          path: '/me/player?additional_types=track,episode',
          quiet: p?.quiet === true,
        }),
      )

    case 'queue':
      return single(await call(session, { action: 'queue.get', method: 'GET', path: '/me/player/queue' }))

    case 'search': {
      const q = str(p, 'q')
      if (!q) return badRequest(session, 'search requires a non-empty q')
      const limit = num(p, 'limit') ?? 8
      return single(
        await call(session, {
          action: 'search',
          method: 'GET',
          path: `/search?q=${encodeURIComponent(q)}&type=track&limit=${limit}`,
        }),
      )
    }

    case 'queue.add': {
      const uri = str(p, 'uri')
      if (!uri) return badRequest(session, 'queue.add requires uri')
      return single(
        await call(session, {
          action: 'queue.add',
          method: 'POST',
          path: `/me/player/queue?uri=${encodeURIComponent(uri)}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`,
          trackUri: uri,
          deviceId,
          deviceName,
          observe: observeOpt(p, 600),
          note: str(p, 'note'),
        }),
      )
    }

    case 'play': {
      const uris = Array.isArray(p?.uris) ? (p!.uris as string[]) : undefined
      const contextUri = str(p, 'context_uri')
      const body =
        uris && uris.length > 0
          ? { uris }
          : contextUri
            ? { context_uri: contextUri }
            : undefined
      return single(
        await call(session, {
          action: 'play',
          method: 'PUT',
          path: `/me/player/play${deviceQuery(deviceId)}`,
          body,
          deviceId,
          deviceName,
          trackUri: uris?.[0] ?? null,
          observe: observeOpt(p, 600),
        }),
      )
    }

    case 'pause':
      return single(
        await call(session, {
          action: 'pause',
          method: 'PUT',
          path: `/me/player/pause${deviceQuery(deviceId)}`,
          deviceId,
          deviceName,
          observe: observeOpt(p, 600),
        }),
      )

    case 'next':
    case 'previous':
      return single(
        await call(session, {
          action: req.action,
          method: 'POST',
          path: `/me/player/${req.action}${deviceQuery(deviceId)}`,
          deviceId,
          deviceName,
          // Track changes propagate slower than play/pause; give Connect a moment.
          observe: observeOpt(p, 1200),
        }),
      )

    case 'seek': {
      const ms = num(p, 'position_ms')
      if (ms === undefined) return badRequest(session, 'seek requires position_ms')
      return single(
        await call(session, {
          action: 'seek',
          method: 'PUT',
          path: `/me/player/seek?position_ms=${ms}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`,
          deviceId,
          deviceName,
          observe: observeOpt(p, 600),
        }),
      )
    }

    case 'transfer': {
      if (!deviceId) return badRequest(session, 'transfer requires device_id')
      return single(
        await call(session, {
          action: 'transfer',
          method: 'PUT',
          path: '/me/player',
          // Spotify documents device_ids as an array but accepts exactly one entry.
          body: { device_ids: [deviceId], play: p?.play === true },
          deviceId,
          deviceName,
          observe: observeOpt(p, 1500),
        }),
      )
    }

    /**
     * Fire several commands back to back with no observation reads in between,
     * to test Spotify's warning that ordering between Player commands is not
     * guaranteed. Timing is recorded per command; state is read once at the end.
     */
    case 'burst': {
      const steps = Array.isArray(p?.steps) ? (p!.steps as ActionRequest[]) : []
      if (steps.length === 0) return badRequest(session, 'burst requires steps[]')
      const entries: LogEntry[] = []
      let current = session
      let allOk = true
      for (const step of steps) {
        const res = await runAction(current, {
          action: step.action,
          params: { ...step.params, observe: false },
        })
        current = res.session
        entries.push(...res.entries)
        allOk = allOk && res.ok
      }
      // One queue read after the dust settles tells us what order actually stuck.
      const settle = num(p, 'settle_ms') ?? 1500
      await new Promise((r) => setTimeout(r, settle))
      const after = await runAction(current, { action: 'queue' })
      entries.push(...after.entries.map((e) => ({ ...e, note: 'post-burst queue read' })))
      return { ok: allOk, status: allOk ? 200 : 207, data: after.data, entries, session: after.session }
    }

    default:
      return badRequest(session, `unknown action "${req.action}"`)
  }
}

function badRequest(session: Session, message: string): ActionResponse {
  return {
    ok: false,
    status: 400,
    data: { error: { message } },
    entries: [
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ts: Date.now(),
        iso: new Date().toISOString(),
        action: 'auxcord.reject',
        method: 'LOCAL',
        endpoint: '-',
        status: 400,
        duration_ms: 0,
        error_body: { message },
        error_class: 'invalid_request',
        reason: null,
        diagnosis: 'auxcord_bug',
      },
    ],
    session,
  }
}
