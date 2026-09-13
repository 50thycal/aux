'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, mark, push } from './store'
import type { Playback } from './types'

export type Transition = {
  at: number
  from: string | null
  to: string | null
  from_name: string | null
  to_name: string | null
  /** ms since the operator pressed "I just changed it in Spotify", if they did. */
  since_manual_mark_ms: number | null
}

/**
 * Polls Spotify for playback state and reports *transitions*, not just state.
 *
 * The architecture principle for the whole spike lives here: Spotify is the
 * authority and AuxCord is an observer that reconciles. We never write local
 * assumptions into this state — every field comes from the last successful read.
 */
export function usePlayback(enabled: boolean, intervalMs = 1000) {
  const [playback, setPlayback] = useState<Playback | null>(null)
  const [empty, setEmpty] = useState(false)
  const [lastPollAt, setLastPollAt] = useState<number | null>(null)
  const [lastPollOk, setLastPollOk] = useState<boolean | null>(null)
  const [transitions, setTransitions] = useState<Transition[]>([])
  const lastUri = useRef<string | null>(null)
  const lastName = useRef<string | null>(null)
  const manualMarkAt = useRef<number | null>(null)
  const inFlight = useRef(false)

  const poll = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await api<Playback>('playback', { quiet: true }, { quiet: true })
      setLastPollAt(Date.now())
      setLastPollOk(res.ok)
      if (!res.ok) return
      // 204: Spotify has nothing to report — no active device, or playback ended.
      const isEmpty = res.data === null || res.data === undefined || (res.data as unknown) === ''
      setEmpty(isEmpty)
      const pb = isEmpty ? null : (res.data as Playback)
      setPlayback(pb)

      const uri = pb?.item?.uri ?? null
      if (uri !== lastUri.current) {
        const t: Transition = {
          at: Date.now(),
          from: lastUri.current,
          to: uri,
          from_name: lastName.current,
          to_name: pb?.item?.name ?? null,
          since_manual_mark_ms: manualMarkAt.current ? Date.now() - manualMarkAt.current : null,
        }
        manualMarkAt.current = null
        lastUri.current = uri
        lastName.current = pb?.item?.name ?? null
        setTransitions((prev) => [t, ...prev].slice(0, 50))
        push({
          id: `t-${t.at}`,
          ts: t.at,
          iso: new Date(t.at).toISOString(),
          action: 'observed.transition',
          method: 'POLL',
          endpoint: '/me/player',
          track_uri: uri,
          status: 200,
          duration_ms: 0,
          error_class: 'ok',
          reason: null,
          diagnosis: 'none',
          note:
            `track changed: ${t.from_name ?? '(none)'} -> ${t.to_name ?? '(none)'}` +
            (t.since_manual_mark_ms !== null
              ? `; detected ${t.since_manual_mark_ms}ms after operator marked a manual Spotify change`
              : ''),
        })
      }
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void poll()
    const id = setInterval(() => void poll(), intervalMs)
    return () => clearInterval(id)
  }, [enabled, intervalMs, poll])

  /** Operator says "I just did something in the Spotify app" — starts a stopwatch. */
  const markManualChange = useCallback((label: string) => {
    manualMarkAt.current = Date.now()
    mark(`operator: ${label}`)
  }, [])

  return { playback, empty, transitions, lastPollAt, lastPollOk, poll, markManualChange }
}
