'use client'

import { useSyncExternalStore } from 'react'
import type { LogEntry } from '@/lib/log'

/**
 * The evidence store. Serverless functions do not share memory, so the browser
 * is the only place that can hold a coherent transcript across a session — the
 * server returns its log entries with every response and we accumulate them
 * here, mirrored into localStorage so a refresh does not destroy a run.
 */

const KEY = 'auxcord.log.v1'
const MAX = 2000

export type Marker = {
  id: string
  ts: number
  kind: 'marker'
  label: string
}

export type Record_ = LogEntry | Marker

let entries: Record_[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX)))
  } catch {
    // Quota exceeded or storage disabled — the in-memory transcript still works.
  }
}

export function hydrate() {
  if (entries.length > 0) return
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      entries = JSON.parse(raw) as Record_[]
      emit()
    }
  } catch {
    // ignore
  }
}

export function push(...items: Record_[]) {
  if (items.length === 0) return
  entries = [...entries, ...items].slice(-MAX)
  emit()
}

export function mark(label: string) {
  push({ id: `m-${Date.now()}-${Math.random().toString(36).slice(2)}`, ts: Date.now(), kind: 'marker', label })
}

export function clear() {
  entries = []
  emit()
}

export function snapshot(): Record_[] {
  return entries
}

export function isMarker(r: Record_): r is Marker {
  return (r as Marker).kind === 'marker'
}

export function useLog(): Record_[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    snapshot,
    () => [],
  )
}

export type ApiResult<T = unknown> = {
  ok: boolean
  status: number
  data: T | null
  entries: LogEntry[]
}

/**
 * Single entry point for talking to our own server. Records every returned log
 * entry, so no call site can accidentally produce an untraced Spotify request.
 * `quiet` keeps the once-a-second playback poll out of the transcript unless it
 * fails — a failing poll is exactly the kind of thing we want on the record.
 */
export async function api<T = unknown>(
  action: string,
  params?: Record<string, unknown>,
  opts?: { quiet?: boolean },
): Promise<ApiResult<T>> {
  const started = Date.now()
  try {
    const res = await fetch('/api/spotify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params }),
    })
    const json = (await res.json()) as ApiResult<T>
    const keep = opts?.quiet ? json.entries.filter((e) => e.status < 200 || e.status >= 300) : json.entries
    push(...keep)
    return json
  } catch (err) {
    const entry: LogEntry = {
      id: `net-${Date.now()}`,
      ts: started,
      iso: new Date(started).toISOString(),
      action,
      method: 'POST',
      endpoint: '/api/spotify',
      status: 0,
      duration_ms: Date.now() - started,
      error_body: { message: err instanceof Error ? err.message : String(err) },
      error_class: 'network_error',
      reason: null,
      diagnosis: 'transport',
      note: 'browser -> AuxCord server call failed (not a Spotify error)',
    }
    push(entry)
    return { ok: false, status: 0, data: null, entries: [entry] }
  }
}

export function downloadTranscript() {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n')
  const blob = new Blob([lines], { type: 'application/x-ndjson' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `auxcord-transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  a.click()
  URL.revokeObjectURL(url)
}
