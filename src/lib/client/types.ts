export type Device = {
  id: string | null
  name: string
  type: string
  is_active: boolean
  is_restricted: boolean
  is_private_session?: boolean
  volume_percent: number | null
  supports_volume?: boolean
}

export type Track = {
  uri: string
  id: string
  name: string
  duration_ms: number
  artists: { name: string }[]
  album: { name: string }
  is_playable?: boolean
}

export type Playback = {
  is_playing: boolean
  progress_ms: number | null
  timestamp?: number
  shuffle_state?: boolean
  repeat_state?: string
  device: Device | null
  item: Track | null
  context: { type: string; uri: string } | null
  currently_playing_type?: string
}

export type QueueState = {
  currently_playing: Track | null
  queue: Track[]
}

export function artistsOf(t: { artists?: { name: string }[] } | null | undefined): string {
  return t?.artists?.map((a) => a.name).join(', ') ?? ''
}

export function mmss(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '--:--'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
