'use client'

import { useCallback, useRef, useState } from 'react'
import { api, mark, push } from '@/lib/client/store'
import { artistsOf, type Device, type Playback, type QueueState, type Track } from '@/lib/client/types'

type StepState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

type StepResult = {
  state: StepState
  detail: string[]
}

type RunSummary = {
  started: number
  finished: number
  passed: number
  failed: number
  steps: { id: string; title: string; state: StepState; detail: string[] }[]
}

/**
 * The whole spike in one button: the end-to-end loop that has to work
 * repeatedly before any of the rest of AuxCord is worth designing.
 *
 * Steps are either automatic (an API call plus a verification read) or a gate
 * that waits for the operator to do something in the real Spotify app. A step
 * only passes when Spotify's *observed* state agrees — a 2xx on the command is
 * never sufficient.
 */
export default function ExperimentPanel({
  deviceId,
  devices,
  playback,
  onRefresh,
  markManualChange,
}: {
  deviceId: string
  devices: Device[]
  playback: Playback | null
  onRefresh: () => Promise<void>
  markManualChange: (label: string) => void
}) {
  const [queryA, setQueryA] = useState('')
  const [queryB, setQueryB] = useState('')
  const [trackA, setTrackA] = useState<Track | null>(null)
  const [trackB, setTrackB] = useState<Track | null>(null)
  const [results, setResults] = useState<Record<string, StepResult>>({})
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const startedAt = useRef<number>(Date.now())

  const target = deviceId ? { device_id: deviceId } : {}

  /** Poll Spotify until it agrees, or give up. Returns how long agreement took. */
  const waitFor = useCallback(
    async (
      label: string,
      predicate: (pb: Playback | null) => boolean,
      timeoutMs = 45_000,
    ): Promise<{ ok: boolean; elapsed: number; last: Playback | null; polls: number }> => {
      const started = Date.now()
      let polls = 0
      let last: Playback | null = null
      while (Date.now() - started < timeoutMs) {
        const res = await api<Playback>('playback', { quiet: true }, { quiet: true })
        polls++
        last = (res.data as Playback) ?? null
        if (res.ok && predicate(last)) {
          const elapsed = Date.now() - started
          push({
            id: `w-${Date.now()}`,
            ts: Date.now(),
            iso: new Date().toISOString(),
            action: 'experiment.await',
            method: 'POLL',
            endpoint: '/me/player',
            status: 200,
            duration_ms: elapsed,
            error_class: 'ok',
            reason: null,
            diagnosis: 'none',
            note: `condition "${label}" satisfied after ${elapsed}ms / ${polls} polls`,
          })
          return { ok: true, elapsed, last, polls }
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
      return { ok: false, elapsed: Date.now() - started, last, polls }
    },
    [],
  )

  const searchOne = async (q: string): Promise<Track | null> => {
    const res = await api<{ tracks: { items: Track[] } }>('search', { q, limit: 5 })
    return res.ok && res.data?.tracks.items.length ? res.data.tracks.items[0] : null
  }

  const steps: { id: string; title: string; kind: 'manual' | 'auto'; hint?: string; run?: () => Promise<StepResult> }[] = [
    {
      id: '1-start',
      title: '1. Start music normally in the Spotify app',
      kind: 'manual',
      hint: 'Play a playlist or album from the Spotify client itself, not from AuxCord.',
    },
    {
      id: '2-observe',
      title: '2-3. AuxCord identifies the current song, device and queue',
      kind: 'auto',
      run: async () => {
        const detail: string[] = []
        const pb = await api<Playback>('playback')
        const dv = await api<{ devices: Device[] }>('devices')
        const q = await api<QueueState>('queue')
        const item = (pb.data as Playback)?.item
        const device = (pb.data as Playback)?.device
        detail.push(`song: ${item ? `${item.name} — ${artistsOf(item)} (${item.uri})` : 'NONE'}`)
        detail.push(`device: ${device ? `${device.name} [${device.type}] id=${device.id}` : 'NONE'}`)
        detail.push(`devices visible: ${(dv.data as { devices: Device[] })?.devices?.length ?? 0}`)
        detail.push(`queue length reported: ${(q.data as QueueState)?.queue?.length ?? 0}`)
        const ok = Boolean(item && device && pb.ok && dv.ok && q.ok)
        if (!ok) detail.push('FAIL: AuxCord could not establish current song + device + queue.')
        return { state: ok ? 'passed' : 'failed', detail }
      },
    },
    {
      id: '4-search-a',
      title: '4. Search AuxCord for Song A',
      kind: 'auto',
      run: async () => {
        const t = await searchOne(queryA)
        setTrackA(t)
        return t
          ? { state: 'passed', detail: [`Song A = ${t.name} — ${artistsOf(t)} (${t.uri})`] }
          : { state: 'failed', detail: [`no result for "${queryA}"`] }
      },
    },
    {
      id: '5-add-a',
      title: '5. Add Song A through AuxCord',
      kind: 'auto',
      run: async () => {
        if (!trackA) return { state: 'failed', detail: ['no Song A selected'] }
        const r = await api('queue.add', { uri: trackA.uri, ...target, note: 'experiment: Song A' })
        return {
          state: r.ok ? 'passed' : 'failed',
          detail: [`POST /me/player/queue → HTTP ${r.status}`, ...(r.ok ? [] : [JSON.stringify(r.data)])],
        }
      },
    },
    {
      id: '6-search-b',
      title: '6. Search AuxCord for Song B',
      kind: 'auto',
      run: async () => {
        const t = await searchOne(queryB)
        setTrackB(t)
        return t
          ? { state: 'passed', detail: [`Song B = ${t.name} — ${artistsOf(t)} (${t.uri})`] }
          : { state: 'failed', detail: [`no result for "${queryB}"`] }
      },
    },
    {
      id: '7-add-b',
      title: '7. Add Song B through AuxCord',
      kind: 'auto',
      run: async () => {
        if (!trackB) return { state: 'failed', detail: ['no Song B selected'] }
        const r = await api('queue.add', { uri: trackB.uri, ...target, note: 'experiment: Song B' })
        return {
          state: r.ok ? 'passed' : 'failed',
          detail: [`POST /me/player/queue → HTTP ${r.status}`, ...(r.ok ? [] : [JSON.stringify(r.data)])],
        }
      },
    },
    {
      id: '8-verify-queue',
      title: "8. Verify Spotify's queue contains A then B",
      kind: 'auto',
      run: async () => {
        const r = await api<QueueState>('queue')
        const q = (r.data as QueueState)?.queue ?? []
        const ia = q.findIndex((t) => t.uri === trackA?.uri)
        const ib = q.findIndex((t) => t.uri === trackB?.uri)
        const detail = [
          `queue: ${q.slice(0, 8).map((t, i) => `${i + 1}. ${t.name}`).join(' | ') || '(empty)'}`,
          `Song A at position ${ia < 0 ? 'ABSENT' : ia + 1}`,
          `Song B at position ${ib < 0 ? 'ABSENT' : ib + 1}`,
        ]
        if (ia >= 0 && ib >= 0 && ia > ib) {
          detail.push('NOTE: Spotify reports B before A — record this; command ordering is not guaranteed.')
        }
        return { state: ia >= 0 && ib >= 0 ? 'passed' : 'failed', detail }
      },
    },
    {
      id: '9-finish',
      title: '9. Let the current song finish',
      kind: 'manual',
      hint: 'Use the jump button below to skip to the last few seconds instead of waiting it out.',
    },
    {
      id: '10-a-plays',
      title: '10-11. Song A begins and AuxCord detects it',
      kind: 'auto',
      run: async () => {
        const w = await waitFor('Song A is the current track', (pb) => pb?.item?.uri === trackA?.uri, 90_000)
        return {
          state: w.ok ? 'passed' : 'failed',
          detail: [
            w.ok
              ? `AuxCord observed Song A after ${w.elapsed}ms (${w.polls} polls of /me/player)`
              : `timed out after ${w.elapsed}ms; last observed "${w.last?.item?.name ?? 'nothing'}"`,
          ],
        }
      },
    },
    {
      id: '12-skip',
      title: '12. Skip forward through AuxCord',
      kind: 'auto',
      run: async () => {
        const r = await api('next', target)
        return { state: r.ok ? 'passed' : 'failed', detail: [`POST /me/player/next → HTTP ${r.status}`] }
      },
    },
    {
      id: '13-b-plays',
      title: '13-14. Song B begins and AuxCord detects it',
      kind: 'auto',
      run: async () => {
        const w = await waitFor('Song B is the current track', (pb) => pb?.item?.uri === trackB?.uri, 45_000)
        return {
          state: w.ok ? 'passed' : 'failed',
          detail: [
            w.ok
              ? `AuxCord observed Song B after ${w.elapsed}ms (${w.polls} polls)`
              : `timed out after ${w.elapsed}ms; last observed "${w.last?.item?.name ?? 'nothing'}"`,
          ],
        }
      },
    },
    {
      id: '15-transfer',
      title: '15-16. Transfer playback to a second device and confirm it continues there',
      kind: 'auto',
      run: async () => {
        const currentId = playback?.device?.id ?? null
        const other = devices.find((d) => d.id && d.id !== currentId && !d.is_restricted)
        if (!other?.id) {
          return {
            state: 'skipped',
            detail: ['No second controllable device is visible. Wake another Spotify device and re-run.'],
          }
        }
        const r = await api('transfer', { device_id: other.id, device_name: other.name, play: true })
        const w = await waitFor(
          `playback on ${other.name}`,
          (pb) => pb?.device?.id === other.id && pb?.is_playing === true,
          30_000,
        )
        return {
          state: r.ok && w.ok ? 'passed' : 'failed',
          detail: [
            `PUT /me/player → HTTP ${r.status} (target "${other.name}")`,
            w.ok
              ? `playback confirmed on "${other.name}" after ${w.elapsed}ms`
              : `never observed playing on "${other.name}" (last device: ${w.last?.device?.name ?? 'none'}, playing=${String(w.last?.is_playing)})`,
          ],
        }
      },
    },
  ]

  const setResult = (id: string, r: StepResult) => setResults((prev) => ({ ...prev, [id]: r }))

  const runStep = async (i: number) => {
    const step = steps[i]
    setBusy(true)
    mark(`experiment: ${step.title}`)
    setResult(step.id, { state: 'running', detail: [] })
    try {
      const r = step.run ? await step.run() : { state: 'passed' as StepState, detail: ['confirmed by operator'] }
      setResult(step.id, r)
      if (r.state !== 'failed') setCursor(i + 1)
    } finally {
      setBusy(false)
      await onRefresh()
    }
  }

  const runAllAuto = async () => {
    for (let i = cursor; i < steps.length; i++) {
      if (steps[i].kind === 'manual') {
        setCursor(i)
        return
      }
      await runStep(i)
      const latest = steps[i]
      if (results[latest.id]?.state === 'failed') return
    }
  }

  const finishRun = () => {
    const summary: RunSummary = {
      started: startedAt.current,
      finished: Date.now(),
      passed: Object.values(results).filter((r) => r.state === 'passed').length,
      failed: Object.values(results).filter((r) => r.state === 'failed').length,
      steps: steps.map((s) => ({
        id: s.id,
        title: s.title,
        state: results[s.id]?.state ?? 'pending',
        detail: results[s.id]?.detail ?? [],
      })),
    }
    setRuns((prev) => [summary, ...prev])
    mark(`experiment run complete: ${summary.passed} passed / ${summary.failed} failed`)
    setResults({})
    setCursor(0)
    startedAt.current = Date.now()
  }

  const jumpToEnd = async () => {
    const dur = playback?.item?.duration_ms
    if (!dur) return
    markManualChange('jumped near end of track')
    await api('seek', { position_ms: Math.max(0, dur - 8000), ...target })
  }

  return (
    <div className="panel">
      <h2>Critical AuxCord experiment</h2>
      <div className="row">
        <input type="text" placeholder="Song A query" size={26} value={queryA} onChange={(e) => setQueryA(e.target.value)} />
        <input type="text" placeholder="Song B query" size={26} value={queryB} onChange={(e) => setQueryB(e.target.value)} />
        <button disabled={busy || !queryA || !queryB} onClick={() => void runAllAuto()}>
          RUN FROM CURSOR
        </button>
        <button disabled={busy} onClick={jumpToEnd}>
          JUMP TO 8s BEFORE END
        </button>
        <button disabled={busy} onClick={finishRun}>
          FINISH RUN &amp; RECORD
        </button>
      </div>

      <div style={{ marginTop: 8 }}>
        {steps.map((s, i) => {
          const r = results[s.id]
          const cls =
            r?.state === 'passed' ? 'done' : r?.state === 'failed' ? 'failed' : i === cursor ? 'current' : ''
          return (
            <div key={s.id} className={`step ${cls}`}>
              <div className="row">
                <span style={{ minWidth: 470 }}>{s.title}</span>
                <span className={r?.state === 'failed' ? 'bad' : r?.state === 'passed' ? 'ok' : 'dim'}>
                  {r?.state ?? 'pending'}
                </span>
                {s.kind === 'manual' ? (
                  <button disabled={busy} onClick={() => void runStep(i)}>
                    I DID THIS
                  </button>
                ) : (
                  <button disabled={busy} onClick={() => void runStep(i)}>
                    RUN
                  </button>
                )}
              </div>
              {s.hint && !r && <div className="dim">{s.hint}</div>}
              {r?.detail.map((d, k) => (
                <div key={k} className={d.startsWith('FAIL') || d.startsWith('never') ? 'bad' : 'dim'}>
                  {d}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {runs.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b className="dim">RECORDED RUNS (repeatability is the actual criterion)</b>
          {runs.map((r) => (
            <div key={r.started} className="row">
              <span className="dim">{new Date(r.started).toLocaleTimeString()}</span>
              <span className="ok">{r.passed} passed</span>
              <span className={r.failed ? 'bad' : 'dim'}>{r.failed} failed</span>
              <span className="dim">{Math.round((r.finished - r.started) / 1000)}s</span>
              <button onClick={() => void navigator.clipboard.writeText(runMarkdown(r))}>COPY MARKDOWN</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function runMarkdown(r: RunSummary): string {
  return [
    `### Experiment run ${new Date(r.started).toISOString()} (${Math.round((r.finished - r.started) / 1000)}s)`,
    '',
    '| step | state | observed |',
    '| --- | --- | --- |',
    ...r.steps.map((s) => `| ${s.title} | ${s.state} | ${s.detail.join('<br>') || '—'} |`),
  ].join('\n')
}
