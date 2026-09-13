'use client'

import { useState } from 'react'
import { api, mark } from '@/lib/client/store'
import { humanError, type LogEntry } from '@/lib/log'
import { artistsOf, type Track } from '@/lib/client/types'

/**
 * Deliberate failure injection. Every button here is designed to make Spotify
 * say no, so that the failure mode is on the record with its real status code
 * and reason instead of being guessed at from documentation.
 */
export default function StressPanel({
  deviceId,
  onRefresh,
  onSessionChange,
}: {
  deviceId: string
  onRefresh: () => Promise<void>
  onSessionChange: () => Promise<void>
}) {
  const [out, setOut] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [burstQuery, setBurstQuery] = useState('')
  const [burstTracks, setBurstTracks] = useState<Track[]>([])

  const report = (lines: string[]) => setOut(lines.join('\n'))

  const describe = (label: string, entries: LogEntry[]): string[] =>
    entries.map(
      (e) =>
        `${label} → ${e.method} ${e.endpoint}\n  HTTP ${e.status} ${e.error_class}` +
        `${e.reason ? ` (${e.reason})` : ''} in ${e.duration_ms}ms` +
        `${e.status >= 300 || e.status === 0 ? `\n  ${humanError(e)}` : ''}` +
        `${e.error_body ? `\n  body: ${JSON.stringify(e.error_body)}` : ''}` +
        `${e.observed ? `\n  observed after: ${e.observed.empty ? 'nothing playing (204)' : `${e.observed.track_name} ${e.observed.is_playing ? 'playing' : 'paused'} on ${e.observed.device_name}`}` : ''}`,
    )

  const run = async (label: string, fn: () => Promise<string[]>) => {
    setBusy(true)
    mark(`stress: ${label}`)
    try {
      report(await fn())
    } finally {
      setBusy(false)
      await onRefresh()
    }
  }

  const tokenTest = (mode: 'soft' | 'hard' | 'break') =>
    run(`token ${mode}`, async () => {
      const res = await fetch(`/api/auth/force-expire?mode=${mode}`, { method: 'POST' })
      const lines = [`forced token state "${mode}" (HTTP ${res.status})`, 'now issuing a real API call…']
      const probe = await api('devices')
      lines.push(...describe('probe devices', probe.entries))
      lines.push(
        mode === 'break'
          ? probe.ok
            ? 'UNEXPECTED: call succeeded with a corrupted refresh token.'
            : 'Expected: the call fails and the UI should tell you to reconnect.'
          : probe.ok
            ? 'Expected: the refresh path recovered transparently (see the "refreshed" tag in the log).'
            : 'UNEXPECTED: recovery failed — this is an OAuth defect, not a Spotify limitation.',
      )
      await onSessionChange()
      return lines
    })

  const loadBurstTracks = async () => {
    const res = await api<{ tracks: { items: Track[] } }>('search', { q: burstQuery, limit: 3 })
    if (res.ok && res.data) setBurstTracks(res.data.tracks.items)
  }

  return (
    <div className="panel">
      <h2>Stress / failure injection</h2>

      <div className="row">
        <b className="dim">TOKEN</b>
        <button disabled={busy} onClick={() => void tokenTest('soft')}>
          expire token (proactive refresh)
        </button>
        <button disabled={busy} onClick={() => void tokenTest('hard')}>
          corrupt token (401 → refresh → retry)
        </button>
        <button disabled={busy} className="danger" onClick={() => void tokenTest('break')}>
          corrupt refresh token (unrecoverable)
        </button>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <b className="dim">DEVICE</b>
        <button
          disabled={busy}
          onClick={() =>
            void run('no active device probe', async () => {
              const lines = ['Close Spotify everywhere first for a true reading.']
              for (const action of ['playback', 'next', 'pause'] as const) {
                const r = await api(action, deviceId ? { device_id: deviceId } : {})
                lines.push(...describe(action, r.entries))
              }
              const q = await api('queue.add', { uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqQ' })
              lines.push(...describe('queue.add with no active device', q.entries))
              return lines
            })
          }
        >
          probe with no active device
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run('unknown device id', async () => {
              const r = await api('transfer', { device_id: 'auxcordfakedeviceid0000000000000000000000', play: false })
              return describe('transfer to fabricated device id', r.entries)
            })
          }
        >
          transfer to a fake device id
        </button>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <b className="dim">BAD INPUT</b>
        <button
          disabled={busy}
          onClick={() =>
            void run('invalid uri', async () => {
              const lines: string[] = []
              for (const uri of ['not-a-uri', 'spotify:track:0000000000000000000000', 'spotify:album:4m2880jivSbbyEGAKfITCa']) {
                const r = await api('queue.add', { uri, observe: false })
                lines.push(...describe(`queue.add ${uri}`, r.entries))
              }
              return lines
            })
          }
        >
          queue invalid / wrong-type URIs
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run('seek beyond end', async () => {
              const r = await api('seek', { position_ms: 99_999_999, ...(deviceId ? { device_id: deviceId } : {}) })
              return describe('seek past end of track', r.entries)
            })
          }
        >
          seek past the end
        </button>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <b className="dim">RATE LIMIT</b>
        <button
          disabled={busy}
          onClick={() =>
            void run('rate limit probe', async () => {
              if (!confirm('Fires 60 reads of /me/player as fast as possible. A 429 can lock the app out for minutes. Continue?'))
                return ['cancelled']
              const started = Date.now()
              const results = await Promise.all(Array.from({ length: 60 }, () => api('playback', { quiet: true })))
              const limited = results.flatMap((r) => r.entries).filter((e) => e.status === 429)
              return [
                `60 reads issued in ${Date.now() - started}ms`,
                `429s: ${limited.length}`,
                ...(limited.length
                  ? describe('first 429', limited.slice(0, 1))
                  : ['No 429 observed at this volume — note the rate actually reached above.']),
              ]
            })
          }
        >
          60 rapid reads (may trigger 429)
        </button>
      </div>

      <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <div className="row">
          <b className="dim">ORDERING</b>
          <input
            type="text"
            placeholder="query to pull 3 tracks from"
            size={30}
            value={burstQuery}
            onChange={(e) => setBurstQuery(e.target.value)}
          />
          <button disabled={busy || !burstQuery} onClick={() => void loadBurstTracks()}>
            LOAD 3 TRACKS
          </button>
          <span className="dim">{burstTracks.map((t) => t.name).join(' · ')}</span>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button
            disabled={busy || burstTracks.length < 3}
            onClick={() =>
              void run('rapid add/add/skip/add', async () => {
                const [a, b, c] = burstTracks
                const r = await api('burst', {
                  settle_ms: 2000,
                  steps: [
                    { action: 'queue.add', params: { uri: a.uri, device_id: deviceId || undefined } },
                    { action: 'queue.add', params: { uri: b.uri, device_id: deviceId || undefined } },
                    { action: 'next', params: { device_id: deviceId || undefined } },
                    { action: 'queue.add', params: { uri: c.uri, device_id: deviceId || undefined } },
                  ],
                })
                const queue = r.data as { queue?: Track[] } | null
                return [
                  `sent: add "${a.name}", add "${b.name}", NEXT, add "${c.name}" with no waiting in between`,
                  ...describe('burst', r.entries),
                  '',
                  'queue read 2s after the burst:',
                  ...(queue?.queue ?? [])
                    .slice(0, 10)
                    .map((t, i) => `  ${i + 1}. ${t.name} — ${artistsOf(t)}`),
                  '',
                  'Compare this ordering against the order the commands were sent. Spotify does not',
                  'guarantee ordering between Player commands, so a mismatch here is a Spotify',
                  'behaviour to design around, not necessarily an AuxCord bug.',
                ]
              })
            }
          >
            RUN add → add → skip → add
          </button>
        </div>
      </div>

      {out && <pre className="mono-block" style={{ marginTop: 8 }}>{out}</pre>}
    </div>
  )
}
