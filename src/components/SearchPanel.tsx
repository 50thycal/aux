'use client'

import { useState } from 'react'
import { api, mark } from '@/lib/client/store'
import { humanError } from '@/lib/log'
import { artistsOf, mmss, type Track } from '@/lib/client/types'

export default function SearchPanel({
  deviceId,
  onQueued,
}: {
  deviceId: string
  onQueued: () => Promise<void>
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Track[]>([])
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const search = async () => {
    if (!q.trim()) return
    setBusy(true)
    mark(`operator: search "${q}"`)
    const res = await api<{ tracks: { items: Track[] } }>('search', { q, limit: 8 })
    if (res.ok && res.data) {
      setResults(res.data.tracks.items)
      setStatus(`${res.data.tracks.items.length} results`)
    } else {
      setResults([])
      setStatus(res.entries[0] ? humanError(res.entries[0]) : `search failed (${res.status})`)
    }
    setBusy(false)
  }

  const add = async (t: Track) => {
    setBusy(true)
    mark(`operator: queue "${t.name}"`)
    const res = await api('queue.add', {
      uri: t.uri,
      ...(deviceId ? { device_id: deviceId } : {}),
      note: `queued "${t.name}" by ${artistsOf(t)}`,
    })
    const entry = res.entries[0]
    setStatus(
      res.ok
        ? `queued ${t.name} (HTTP ${res.status}) — read the queue below to confirm Spotify agrees`
        : `FAILED ${res.status}: ${entry ? humanError(entry) : ''}`,
    )
    await onQueued()
    setBusy(false)
  }

  return (
    <div className="panel">
      <h2>Search</h2>
      <div className="row">
        <input
          type="text"
          value={q}
          placeholder="Like Him Tyler the Creator"
          size={40}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
        />
        <button disabled={busy} onClick={() => void search()}>
          SEARCH
        </button>
        <span className="dim">{status}</span>
      </div>
      <table style={{ marginTop: 8 }}>
        <tbody>
          {results.map((t) => (
            <tr key={t.id}>
              <td style={{ width: '30%' }}>
                {t.name}
                {t.is_playable === false && <span className="tag bad"> unplayable in market</span>}
              </td>
              <td style={{ width: '25%' }} className="dim">
                {artistsOf(t)}
              </td>
              <td style={{ width: '25%' }} className="dim">
                {t.album?.name}
              </td>
              <td className="dim">{mmss(t.duration_ms)}</td>
              <td className="dim" style={{ fontSize: 11 }}>
                {t.uri}
              </td>
              <td>
                <button disabled={busy} onClick={() => void add(t)}>
                  ADD
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
