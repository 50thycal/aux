import { randomUUID } from 'node:crypto'
import { SPOTIFY_API } from './config'
import { refresh } from './tokens'
import type { Session } from './session'
import { classify, redact, type LogEntry, type ObservedState } from '@/lib/log'

/** Refresh this far ahead of expiry rather than waiting for the 401. */
const REFRESH_MARGIN_MS = 30_000

export type CallOptions = {
  /** Logical action name that shows up in the transcript, e.g. "queue.add". */
  action: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path under /v1, query string included. */
  path: string
  body?: unknown
  deviceId?: string | null
  deviceName?: string | null
  trackUri?: string | null
  /**
   * Read /me/player back after the command and attach it to the log entry.
   * Pass a number to control the delay in ms. Leave off for timing-sensitive
   * tests (rapid-fire bursts) where an extra read would distort the result.
   */
  observe?: boolean | number
  note?: string
  /** Skip the proactive pre-expiry refresh, so we can exercise the 401 path. */
  noPreRefresh?: boolean
  /** Successful calls are not echoed to the server console (used by the 1s poll). */
  quiet?: boolean
}

export type CallResult<T = unknown> = {
  ok: boolean
  status: number
  data: T | null
  entry: LogEntry
  /** Possibly-refreshed session; the caller must persist it. */
  session: Session
}

async function rawFetch(session: Session, opts: CallOptions) {
  const started = Date.now()
  try {
    const res = await fetch(`${SPOTIFY_API}${opts.path}`, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
    })
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }
    return {
      status: res.status,
      body: parsed,
      duration_ms: Date.now() - started,
      retryAfter: res.headers.get('retry-after'),
      transportError: null as string | null,
    }
  } catch (err) {
    return {
      status: 0,
      body: { error: { message: err instanceof Error ? err.message : String(err) } },
      duration_ms: Date.now() - started,
      retryAfter: null,
      transportError: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * The single choke point for every Spotify API call the app makes. One code
 * path means one place that handles refresh, one place that classifies errors,
 * and one place that emits evidence — so a gap in the transcript is a bug in
 * this function rather than a call site someone forgot to instrument.
 */
export async function call<T = unknown>(session: Session, opts: CallOptions): Promise<CallResult<T>> {
  let current = session
  let afterRefresh = false

  if (!opts.noPreRefresh && Date.now() >= current.expires_at - REFRESH_MARGIN_MS) {
    try {
      current = await refresh(current)
      afterRefresh = true
    } catch {
      // Fall through and let the call 401; the entry then records the real failure.
    }
  }

  let result = await rawFetch(current, opts)

  // Reactive path: the token was rejected even though we thought it was live
  // (clock skew, revoked token, Spotify-side invalidation). Refresh once, retry once.
  if (result.status === 401) {
    try {
      current = await refresh(current)
      afterRefresh = true
      result = await rawFetch(current, opts)
    } catch {
      // Keep the original 401; the transcript will show the refresh did not save us.
    }
  }

  const { error_class, reason, diagnosis } = classify(result.status, result.body)
  const ok = result.status >= 200 && result.status < 300

  const entry: LogEntry = {
    id: randomUUID(),
    ts: Date.now() - result.duration_ms,
    iso: new Date(Date.now() - result.duration_ms).toISOString(),
    action: opts.action,
    method: opts.method,
    endpoint: opts.path,
    device_id: opts.deviceId ?? null,
    device_name: opts.deviceName ?? null,
    track_uri: opts.trackUri ?? null,
    request: opts.body === undefined ? undefined : redact(opts.body),
    status: result.status,
    duration_ms: result.duration_ms,
    error_body: ok ? undefined : redact(result.body),
    error_class,
    reason,
    diagnosis,
    after_refresh: afterRefresh || undefined,
    retry_after_s: result.retryAfter ? Number(result.retryAfter) : null,
    note: opts.note,
  }

  if (opts.observe) {
    entry.observed = await observe(current, typeof opts.observe === 'number' ? opts.observe : 400)
  }

  // Also lands in the Vercel runtime log, which survives a browser refresh.
  // The playback poll runs once a second, so its successes stay out of the log.
  if (!opts.quiet || !ok) console.log('[auxcord]', JSON.stringify(entry))

  return { ok, status: result.status, data: ok ? (result.body as T) : null, entry, session: current }
}

/**
 * Read back what Spotify actually believes is happening. This is the half of
 * the loop that matters: a 204 from a command proves only that the command was
 * accepted, never that the world changed.
 */
export async function observe(session: Session, delayMs: number): Promise<ObservedState> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  const res = await rawFetch(session, { action: 'observe', method: 'GET', path: '/me/player' })
  const at = Date.now()
  if (res.status === 204 || !res.body) {
    return {
      at,
      delay_ms: delayMs,
      is_playing: null,
      progress_ms: null,
      track_uri: null,
      track_name: null,
      artist: null,
      device_id: null,
      device_name: null,
      empty: true,
    }
  }
  const b = res.body as {
    is_playing?: boolean
    progress_ms?: number
    item?: { uri?: string; name?: string; artists?: { name: string }[] } | null
    device?: { id?: string | null; name?: string } | null
  }
  return {
    at,
    delay_ms: delayMs,
    is_playing: b.is_playing ?? null,
    progress_ms: b.progress_ms ?? null,
    track_uri: b.item?.uri ?? null,
    track_name: b.item?.name ?? null,
    artist: b.item?.artists?.map((a) => a.name).join(', ') ?? null,
    device_id: b.device?.id ?? null,
    device_name: b.device?.name ?? null,
    empty: false,
  }
}
