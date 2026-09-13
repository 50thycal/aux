'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, hydrate, mark } from '@/lib/client/store'
import { usePlayback } from '@/lib/client/hooks'
import { artistsOf, mmss, type Device, type Playback, type QueueState } from '@/lib/client/types'
import SearchPanel from './SearchPanel'
import QueuePanel from './QueuePanel'
import ExperimentPanel from './ExperimentPanel'
import StressPanel from './StressPanel'
import LogPanel from './LogPanel'

export type SessionInfo = {
  connected: boolean
  user?: { id: string; display_name: string | null; product: string | null; country: string | null } | null
  granted_scopes?: string[]
  missing_scopes?: string[]
  expires_in_s?: number
  refresh_count?: number
  refreshed_at?: number | null
}

export default function Console() {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [polling, setPolling] = useState(true)
  const [authError, setAuthError] = useState<{ message: string; detail?: string } | null>(null)

  const { playback, empty, transitions, lastPollAt, lastPollOk, poll, markManualChange } = usePlayback(
    polling && session?.connected === true,
  )

  useEffect(() => {
    hydrate()
    const params = new URLSearchParams(window.location.search)
    const err = params.get('auth_error')
    if (err) {
      setAuthError({ message: err, detail: params.get('auth_detail') ?? undefined })
      mark(`auth error: ${err}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  const loadSession = useCallback(async () => {
    const res = await fetch('/api/auth/session', { cache: 'no-store' })
    setSession((await res.json()) as SessionInfo)
  }, [])

  useEffect(() => {
    void loadSession()
    const id = setInterval(() => void loadSession(), 15_000)
    return () => clearInterval(id)
  }, [loadSession])

  const loadDevices = useCallback(async () => {
    const res = await api<{ devices: Device[] }>('devices')
    if (res.ok && res.data) setDevices(res.data.devices)
  }, [])

  const loadQueue = useCallback(async () => {
    const res = await api<QueueState>('queue')
    if (res.ok && res.data) setQueue(res.data)
  }, [])

  useEffect(() => {
    if (session?.connected) {
      void loadDevices()
      void loadQueue()
    }
  }, [session?.connected, loadDevices, loadQueue])

  const refreshAll = useCallback(async () => {
    await Promise.all([poll(), loadDevices(), loadQueue(), loadSession()])
  }, [poll, loadDevices, loadQueue, loadSession])

  if (!session) return <div className="panel">loading session…</div>

  if (!session.connected) {
    return (
      <>
        {authError && (
          <div className="panel">
            <h2>Auth error</h2>
            <div className="bad">{authError.message}</div>
            {authError.detail && <pre className="mono-block">{authError.detail}</pre>}
          </div>
        )}
        <div className="panel">
          <h2>Spotify</h2>
          <p className="dim">
            Not connected. Authorization Code + PKCE; the token exchange runs server-side and tokens live
            only in an encrypted httpOnly cookie.
          </p>
          <a href="/api/auth/login">
            <button className="primary">CONNECT SPOTIFY</button>
          </a>
        </div>
      </>
    )
  }

  const active = devices.find((d) => d.is_active)

  return (
    <>
      {authError && (
        <div className="panel">
          <h2>Auth error</h2>
          <div className="bad">{authError.message}</div>
          {authError.detail && <pre className="mono-block">{authError.detail}</pre>}
        </div>
      )}

      <div className="panel">
        <h2>Spotify</h2>
        <div className="row">
          <span>
            Connected as <b>{session.user?.display_name ?? session.user?.id ?? 'unknown'}</b>
          </span>
          <span className={session.user?.product === 'premium' ? 'tag ok' : 'tag bad'}>
            product: {session.user?.product ?? 'unknown'}
          </span>
          <span className="tag">country: {session.user?.country ?? '—'}</span>
          <span className="tag">token expires in {session.expires_in_s}s</span>
          <span className="tag">refreshes: {session.refresh_count ?? 0}</span>
        </div>
        {session.user?.product !== 'premium' && (
          <p className="bad">
            This account is not Premium. Every /me/player write will fail with 403 PREMIUM_REQUIRED —
            that is a Spotify constraint, not an AuxCord bug.
          </p>
        )}
        {(session.missing_scopes?.length ?? 0) > 0 && (
          <p className="bad">Missing granted scopes: {session.missing_scopes!.join(', ')}</p>
        )}
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={() => void refreshAll()}>REFRESH ALL</button>
          <a href="/api/auth/login?force=1">
            <button>RE-AUTHORIZE</button>
          </a>
          <button
            className="danger"
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' })
              mark('operator: disconnected Spotify')
              void loadSession()
            }}
          >
            DISCONNECT
          </button>
          <label className="dim">
            <input type="checkbox" checked={polling} onChange={(e) => setPolling(e.target.checked)} /> poll
            /me/player every 1s
          </label>
          <span className="dim">
            last poll{' '}
            {lastPollAt ? `${((Date.now() - lastPollAt) / 1000).toFixed(0)}s ago` : 'never'}{' '}
            {lastPollOk === false && <span className="bad">FAILED</span>}
          </span>
        </div>
      </div>

      <NowPlaying playback={playback} empty={empty} deviceId={deviceId} onRefresh={() => void poll()} />

      <div className="panel">
        <h2>Observed transitions</h2>
        <p className="dim" style={{ marginTop: 0 }}>
          Press the mark button the instant you change something inside the Spotify app; the next detected
          transition is stamped with the elapsed time, which bounds AuxCord&apos;s observation latency.
        </p>
        <div className="row">
          <button onClick={() => markManualChange('changed track manually in Spotify')}>
            MARK: I just changed the track in Spotify
          </button>
          <button onClick={() => markManualChange('edited the queue manually in Spotify')}>
            MARK: I just edited the queue in Spotify
          </button>
        </div>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>at</th>
              <th>from</th>
              <th>to</th>
              <th>latency after manual mark</th>
            </tr>
          </thead>
          <tbody>
            {transitions.slice(0, 8).map((t) => (
              <tr key={t.at}>
                <td>{new Date(t.at).toLocaleTimeString()}</td>
                <td>{t.from_name ?? '(none)'}</td>
                <td>{t.to_name ?? '(none)'}</td>
                <td className={t.since_manual_mark_ms === null ? 'dim' : 'ok'}>
                  {t.since_manual_mark_ms === null ? '—' : `${t.since_manual_mark_ms} ms`}
                </td>
              </tr>
            ))}
            {transitions.length === 0 && (
              <tr>
                <td colSpan={4} className="dim">
                  none observed yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Controls deviceId={deviceId} onDone={refreshAll} />

      <SearchPanel deviceId={deviceId} onQueued={loadQueue} />

      <QueuePanel queue={queue} onRefresh={loadQueue} />

      <DevicesPanel
        devices={devices}
        deviceId={deviceId}
        setDeviceId={setDeviceId}
        active={active}
        onRefresh={loadDevices}
        onTransferred={refreshAll}
      />

      <ExperimentPanel
        deviceId={deviceId}
        devices={devices}
        playback={playback}
        onRefresh={refreshAll}
        markManualChange={markManualChange}
      />

      <StressPanel deviceId={deviceId} onRefresh={refreshAll} onSessionChange={loadSession} />

      <LogPanel />
    </>
  )
}

function NowPlaying({
  playback,
  empty,
  deviceId,
  onRefresh,
}: {
  playback: Playback | null
  empty: boolean
  deviceId: string
  onRefresh: () => void
}) {
  return (
    <div className="panel">
      <h2>Now playing (Spotify is the authority)</h2>
      {empty || !playback ? (
        <div>
          <span className="warn">/me/player returned 204 — no active device or nothing playing.</span>
          <p className="dim">
            Player commands will fail with 404 NO_ACTIVE_DEVICE until something is playing or you transfer
            playback to a device below.
          </p>
        </div>
      ) : (
        <table>
          <tbody>
            <tr>
              <td className="dim">Track</td>
              <td>{playback.item?.name ?? '—'}</td>
            </tr>
            <tr>
              <td className="dim">Artist</td>
              <td>{artistsOf(playback.item)}</td>
            </tr>
            <tr>
              <td className="dim">Album</td>
              <td>{playback.item?.album?.name ?? '—'}</td>
            </tr>
            <tr>
              <td className="dim">URI</td>
              <td>{playback.item?.uri ?? '—'}</td>
            </tr>
            <tr>
              <td className="dim">Position</td>
              <td>
                {mmss(playback.progress_ms)} / {mmss(playback.item?.duration_ms)}
              </td>
            </tr>
            <tr>
              <td className="dim">State</td>
              <td className={playback.is_playing ? 'ok' : 'warn'}>
                {playback.is_playing ? 'PLAYING' : 'PAUSED'}
              </td>
            </tr>
            <tr>
              <td className="dim">Device</td>
              <td>
                {playback.device?.name ?? '—'} <span className="dim">({playback.device?.type})</span>
                {playback.device?.is_restricted && <span className="tag bad"> restricted</span>}
              </td>
            </tr>
            <tr>
              <td className="dim">Context</td>
              <td>
                {playback.context ? `${playback.context.type} ${playback.context.uri}` : '(none — ad-hoc)'}
              </td>
            </tr>
            <tr>
              <td className="dim">Command target</td>
              <td>{deviceId ? deviceId : '(none selected — Spotify picks the active device)'}</td>
            </tr>
          </tbody>
        </table>
      )}
      <button style={{ marginTop: 6 }} onClick={onRefresh}>
        READ NOW
      </button>
    </div>
  )
}

function Controls({ deviceId, onDone }: { deviceId: string; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (action: string) => {
    setBusy(action)
    mark(`operator: pressed ${action.toUpperCase()}`)
    await api(action, deviceId ? { device_id: deviceId } : {})
    await onDone()
    setBusy(null)
  }
  return (
    <div className="panel">
      <h2>Playback controls</h2>
      <div className="row">
        {['play', 'pause', 'previous', 'next'].map((a) => (
          <button key={a} disabled={busy !== null} onClick={() => void run(a)}>
            {a.toUpperCase()}
          </button>
        ))}
        <span className="dim">
          each command logs its HTTP status and a playback read taken shortly afterwards
        </span>
      </div>
    </div>
  )
}

function DevicesPanel({
  devices,
  deviceId,
  setDeviceId,
  active,
  onRefresh,
  onTransferred,
}: {
  devices: Device[]
  deviceId: string
  setDeviceId: (id: string) => void
  active: Device | undefined
  onRefresh: () => Promise<void>
  onTransferred: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const transfer = async (d: Device, play: boolean) => {
    if (!d.id) return
    setBusy(true)
    mark(`operator: transfer playback -> ${d.name}${play ? ' (play=true)' : ''}`)
    await api('transfer', { device_id: d.id, device_name: d.name, play })
    await onTransferred()
    setBusy(false)
  }
  return (
    <div className="panel">
      <h2>Available devices</h2>
      <table>
        <thead>
          <tr>
            <th>target</th>
            <th>name</th>
            <th>type</th>
            <th>active</th>
            <th>restricted</th>
            <th>volume</th>
            <th>id</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id ?? d.name}>
              <td>
                <input
                  type="radio"
                  name="device"
                  checked={deviceId === d.id}
                  disabled={!d.id}
                  onChange={() => setDeviceId(d.id ?? '')}
                />
              </td>
              <td>{d.name}</td>
              <td className="dim">{d.type}</td>
              <td className={d.is_active ? 'ok' : 'dim'}>{String(d.is_active)}</td>
              <td className={d.is_restricted ? 'bad' : 'dim'}>{String(d.is_restricted)}</td>
              <td className="dim">{d.volume_percent ?? '—'}</td>
              <td className="dim" style={{ fontSize: 11 }}>
                {d.id ?? '(null — cannot be targeted)'}
              </td>
              <td>
                <button disabled={busy || !d.id || d.is_active} onClick={() => void transfer(d, true)}>
                  TRANSFER
                </button>
              </td>
            </tr>
          ))}
          {devices.length === 0 && (
            <tr>
              <td colSpan={8} className="warn">
                No devices returned. Spotify only lists devices that are awake and recently active — open
                Spotify on a device and read again.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 6 }}>
        <button onClick={() => void onRefresh()}>READ DEVICES</button>
        <button onClick={() => setDeviceId('')}>CLEAR TARGET</button>
        <span className="dim">
          active: {active?.name ?? 'none'} · commands target{' '}
          {deviceId ? 'the selected device' : "Spotify's own active device"}
        </span>
      </div>
    </div>
  )
}
