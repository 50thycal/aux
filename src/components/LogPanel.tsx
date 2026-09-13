'use client'

import { useMemo, useState } from 'react'
import { clear, downloadTranscript, isMarker, useLog, type Record_ } from '@/lib/client/store'
import { humanError, type LogEntry } from '@/lib/log'

export default function LogPanel() {
  const records = useLog()
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const shown = useMemo(() => {
    const list = errorsOnly
      ? records.filter((r) => !isMarker(r) && ((r as LogEntry).status < 200 || (r as LogEntry).status >= 300))
      : records
    return [...list].reverse().slice(0, 300)
  }, [records, errorsOnly])

  const summary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of records) {
      if (isMarker(r)) continue
      const e = r as LogEntry
      const key = `${e.error_class}/${e.diagnosis}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [records])

  return (
    <div className="panel">
      <h2>Evidence log ({records.length} records)</h2>
      <div className="row">
        <button onClick={downloadTranscript}>DOWNLOAD .jsonl</button>
        <button onClick={() => void navigator.clipboard.writeText(markdownSummary(records))}>
          COPY MARKDOWN SUMMARY
        </button>
        <button className="danger" onClick={clear}>
          CLEAR
        </button>
        <label className="dim">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />{' '}
          errors only
        </label>
      </div>
      <div className="row dim" style={{ marginTop: 6 }}>
        {summary.map(([k, n]) => (
          <span key={k} className="tag">
            {k}: {n}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 8, maxHeight: 420, overflow: 'auto' }}>
        {shown.map((r) => {
          if (isMarker(r)) {
            return (
              <div key={r.id} className="log-line marker">
                {new Date(r.ts).toLocaleTimeString()} ▸ {r.label}
              </div>
            )
          }
          const e = r as LogEntry
          const bad = e.status < 200 || e.status >= 300
          return (
            <div key={e.id} className={`log-line${bad ? ' err' : ''}`}>
              <span onClick={() => setExpanded(expanded === e.id ? null : e.id)} style={{ cursor: 'pointer' }}>
                {new Date(e.ts).toLocaleTimeString()} <b>{e.action}</b>{' '}
                <span className="dim">
                  {e.method} {e.endpoint}
                </span>{' '}
                <span className={bad ? 'bad' : 'ok'}>{e.status}</span>{' '}
                <span className="dim">{e.duration_ms}ms</span>
                {e.after_refresh && <span className="tag warn"> refreshed</span>}
                {e.reason && <span className="tag"> {e.reason}</span>}
                {e.observed && !e.observed.empty && (
                  <span className="dim">
                    {' '}
                    → observed: {e.observed.track_name ?? '—'} {e.observed.is_playing ? '▶' : '⏸'} on{' '}
                    {e.observed.device_name ?? '—'}
                  </span>
                )}
                {e.observed?.empty && <span className="warn"> → observed: nothing playing (204)</span>}
              </span>
              {bad && <div className="bad">{humanError(e)}</div>}
              {expanded === e.id && <pre className="mono-block">{JSON.stringify(e, null, 2)}</pre>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A paste-ready block for docs/SPOTIFY_SPIKE_RESULTS.md. */
function markdownSummary(records: Record_[]): string {
  const entries = records.filter((r) => !isMarker(r)) as LogEntry[]
  const byAction = new Map<string, { n: number; ok: number; codes: Map<number, number>; reasons: Set<string> }>()
  for (const e of entries) {
    const cur = byAction.get(e.action) ?? { n: 0, ok: 0, codes: new Map(), reasons: new Set<string>() }
    cur.n++
    if (e.status >= 200 && e.status < 300) cur.ok++
    cur.codes.set(e.status, (cur.codes.get(e.status) ?? 0) + 1)
    if (e.reason) cur.reasons.add(e.reason)
    byAction.set(e.action, cur)
  }
  const rows = [...byAction.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([action, s]) => {
      const codes = [...s.codes.entries()].map(([c, n]) => `${c}×${n}`).join(' ')
      return `| ${action} | ${s.n} | ${s.ok} | ${codes} | ${[...s.reasons].join(', ') || '—'} |`
    })
  const durations = entries.filter((e) => e.duration_ms > 0).map((e) => e.duration_ms).sort((a, b) => a - b)
  const p = (q: number) => (durations.length ? durations[Math.floor((durations.length - 1) * q)] : 0)
  return [
    `<!-- generated from the AuxCord evidence log, ${new Date().toISOString()} -->`,
    '',
    '| action | calls | 2xx | status codes | spotify reasons |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Round-trip latency across ${durations.length} calls: p50 ${p(0.5)}ms · p90 ${p(0.9)}ms · max ${p(1)}ms.`,
  ].join('\n')
}
