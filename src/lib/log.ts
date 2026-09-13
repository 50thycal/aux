/**
 * The evidence format. Every Spotify call the app makes produces exactly one
 * of these, on the server, and it is returned to the browser alongside the
 * payload so the UI can build a durable transcript without a database.
 *
 * The point of this shape is to let us tell apart, after the fact:
 *   - an AuxCord bug            (our request was wrong: bad body, bad URI, missing param)
 *   - a Spotify API behaviour   (2xx but the world did not change the way we assumed)
 *   - an OAuth problem          (401 / refresh path / scope)
 *   - Spotify Connect behaviour (404 NO_ACTIVE_DEVICE, 403 restricted device)
 *   - a rate/quota limitation   (429 + Retry-After)
 */

export type ErrorClass =
  | 'ok'
  | 'token_expired'
  | 'unauthorized'
  | 'premium_required'
  | 'forbidden'
  | 'restricted_device'
  | 'no_active_device'
  | 'device_not_found'
  | 'nothing_to_skip'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'unknown'

export type Diagnosis =
  | 'auxcord_bug'
  | 'spotify_api_behaviour'
  | 'oauth'
  | 'spotify_connect'
  | 'rate_limit'
  | 'transport'
  | 'none'

export type LogEntry = {
  id: string
  /** Epoch ms, taken immediately before the request leaves the server. */
  ts: number
  iso: string
  /** Logical AuxCord action, e.g. "queue.add". */
  action: string
  method: string
  /** Path only, query included; never the token endpoint. */
  endpoint: string
  device_id?: string | null
  device_name?: string | null
  track_uri?: string | null
  /** Request body as sent, with any credential-shaped field redacted. */
  request?: unknown
  status: number
  /** Wall-clock ms for the HTTP round trip only (excludes observation reads). */
  duration_ms: number
  /** Verbatim Spotify error envelope when the call failed. */
  error_body?: unknown
  error_class: ErrorClass
  /** Spotify's own `error.reason` for Player endpoints, when present. */
  reason?: string | null
  diagnosis: Diagnosis
  /** True when this call was retried after an automatic token refresh. */
  after_refresh?: boolean
  retry_after_s?: number | null
  /** Playback state read back a moment after a mutating command, when requested. */
  observed?: ObservedState | null
  note?: string
}

export type ObservedState = {
  /** Epoch ms at which the observation read completed. */
  at: number
  /** ms between the command returning and this observation. */
  delay_ms: number
  is_playing: boolean | null
  progress_ms: number | null
  track_uri: string | null
  track_name: string | null
  artist: string | null
  device_id: string | null
  device_name: string | null
  /** 204 from /me/player means "no active device / nothing to report". */
  empty: boolean
}

const REDACT = /(token|secret|verifier|code|authorization|password)/i

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? '[redacted]' : redact(v)
    }
    return out
  }
  return value
}

export function classify(status: number, body: unknown): { error_class: ErrorClass; reason: string | null; diagnosis: Diagnosis } {
  const reason = extractReason(body)

  if (status >= 200 && status < 300) return { error_class: 'ok', reason, diagnosis: 'none' }
  if (status === 0) return { error_class: 'network_error', reason, diagnosis: 'transport' }
  if (status === 429) return { error_class: 'rate_limited', reason, diagnosis: 'rate_limit' }
  if (status >= 500) return { error_class: 'server_error', reason, diagnosis: 'spotify_api_behaviour' }

  // Player endpoints carry a machine-readable `reason` that is far more useful
  // than the status code alone: 404 means "no active device" as often as it
  // means "route does not exist".
  switch (reason) {
    case 'NO_ACTIVE_DEVICE':
      return { error_class: 'no_active_device', reason, diagnosis: 'spotify_connect' }
    case 'PREMIUM_REQUIRED':
      return { error_class: 'premium_required', reason, diagnosis: 'spotify_api_behaviour' }
    case 'DEVICE_NOT_CONTROLLABLE':
    case 'REMOTE_CONTROL_DISALLOW':
    case 'VOLUME_CONTROL_DISALLOW':
      return { error_class: 'restricted_device', reason, diagnosis: 'spotify_connect' }
    case 'NO_PREV_TRACK':
    case 'NO_NEXT_TRACK':
    case 'NO_SPECIFIC_TRACK':
    case 'NOT_PLAYING_TRACK':
    case 'NOT_PLAYING_CONTEXT':
    case 'ENDLESS_CONTEXT':
    case 'CONTEXT_DISALLOW':
      return { error_class: 'nothing_to_skip', reason, diagnosis: 'spotify_api_behaviour' }
    case 'ALREADY_PAUSED':
    case 'NOT_PAUSED':
    case 'ALREADY_PLAYING':
      return { error_class: 'invalid_request', reason, diagnosis: 'spotify_api_behaviour' }
    case 'RATE_LIMITED':
      return { error_class: 'rate_limited', reason, diagnosis: 'rate_limit' }
  }

  if (status === 401) return { error_class: 'token_expired', reason, diagnosis: 'oauth' }
  if (status === 403) return { error_class: 'forbidden', reason, diagnosis: 'oauth' }
  if (status === 404) return { error_class: 'not_found', reason, diagnosis: 'spotify_api_behaviour' }
  if (status === 400) return { error_class: 'invalid_request', reason, diagnosis: 'auxcord_bug' }
  return { error_class: 'unknown', reason, diagnosis: 'spotify_api_behaviour' }
}

function extractReason(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error: unknown }).error
    if (err && typeof err === 'object' && 'reason' in err) {
      const r = (err as { reason?: unknown }).reason
      if (typeof r === 'string') return r
    }
  }
  return null
}

export function humanError(entry: LogEntry): string {
  switch (entry.error_class) {
    case 'no_active_device':
      return 'No active Spotify Connect device. Open Spotify on a device and start playing something (or transfer playback below), then retry.'
    case 'premium_required':
      return 'Spotify Premium is required for this Web API player command.'
    case 'restricted_device':
      return 'This device refuses remote control from the Web API (restricted / not controllable).'
    case 'device_not_found':
      return 'Spotify does not recognise that device id any more — device ids are not permanently stable. Re-read the device list.'
    case 'token_expired':
      return 'Access token rejected (401). A refresh was attempted; if you see this, the refresh also failed — reconnect Spotify.'
    case 'rate_limited':
      return `Rate limited by Spotify (429)${entry.retry_after_s ? `; Retry-After ${entry.retry_after_s}s` : ''}.`
    case 'nothing_to_skip':
      return `Spotify refused the transport command: ${entry.reason}.`
    case 'invalid_request':
      return `Spotify rejected the request (${entry.status})${entry.reason ? `: ${entry.reason}` : ''} — likely a malformed URI or parameter from AuxCord.`
    case 'forbidden':
      return 'Forbidden (403). Usually a missing scope, a non-Premium account, or a user not on the Development Mode allowlist.'
    case 'server_error':
      return `Spotify server error (${entry.status}).`
    case 'network_error':
      return 'Network error reaching Spotify.'
    default:
      return entry.error_class === 'ok' ? '' : `Unexpected ${entry.status}.`
  }
}
