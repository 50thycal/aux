'use client'

import { artistsOf, type QueueState } from '@/lib/client/types'

export default function QueuePanel({
  queue,
  onRefresh,
}: {
  queue: QueueState | null
  onRefresh: () => Promise<void>
}) {
  return (
    <div className="panel">
      <h2>Spotify queue (as Spotify reports it)</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        This is a read of <code>GET /me/player/queue</code>, not AuxCord&apos;s idea of the queue. When a
        context (playlist/album) is playing, Spotify blends user-added items with its own upcoming tracks —
        compare positions here against what the Spotify client shows.
      </p>
      <div>
        <b>currently_playing:</b>{' '}
        {queue?.currently_playing ? (
          <>
            {queue.currently_playing.name} <span className="dim">— {artistsOf(queue.currently_playing)}</span>
          </>
        ) : (
          <span className="dim">none</span>
        )}
      </div>
      <ol style={{ margin: '6px 0', paddingLeft: 22 }}>
        {(queue?.queue ?? []).slice(0, 20).map((t, i) => (
          <li key={`${t.uri}-${i}`}>
            {t.name} <span className="dim">— {artistsOf(t)}</span>{' '}
            <span className="dim" style={{ fontSize: 11 }}>
              {t.uri}
            </span>
          </li>
        ))}
      </ol>
      {(queue?.queue?.length ?? 0) === 0 && <div className="dim">queue empty or unavailable</div>}
      <button onClick={() => void onRefresh()}>READ QUEUE</button>
    </div>
  )
}
