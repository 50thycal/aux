import { createServer } from 'node:http'

/**
 * A deliberately hostile stand-in for Spotify. It exists to prove the parts of
 * AuxCord that do not need a real account: the PKCE token exchange, proactive
 * and reactive refresh, error classification, redaction, and the shape of the
 * evidence log. It is NOT a claim about how real Spotify behaves — every
 * response here is one AuxCord must survive, taken from Spotify's documented
 * error envelope.
 */

export const VALID_ACCESS = 'valid-access-token-1'
export const ROTATED_ACCESS = 'valid-access-token-2'
export const VALID_REFRESH = 'valid-refresh-token-1'
export const ROTATED_REFRESH = 'valid-refresh-token-2'

export function startMock(port) {
  const calls = []
  /** Endpoints can be told to fail once, so we can script 401/429/403 paths. */
  const scripted = new Map()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`)
    const body = await readBody(req)
    calls.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.authorization ?? null, body })

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(payload === undefined ? '' : JSON.stringify(payload))
    }

    // ---- accounts.spotify.com ----
    if (url.pathname === '/api/token') {
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'authorization_code') {
        if (!params.get('code_verifier')) return send(400, { error: 'invalid_grant', error_description: 'missing code_verifier' })
        return send(200, {
          access_token: VALID_ACCESS,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: VALID_REFRESH,
          scope: 'user-read-playback-state user-read-currently-playing user-modify-playback-state',
        })
      }
      if (params.get('grant_type') === 'refresh_token') {
        const rt = params.get('refresh_token')
        if (rt !== VALID_REFRESH && rt !== ROTATED_REFRESH) {
          return send(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' })
        }
        // Spotify rotates the refresh token on PKCE; make sure we cope with that.
        return send(200, {
          access_token: ROTATED_ACCESS,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: ROTATED_REFRESH,
          scope: 'user-read-playback-state user-read-currently-playing user-modify-playback-state',
        })
      }
      return send(400, { error: 'unsupported_grant_type' })
    }

    // ---- api.spotify.com/v1 ----
    const path = url.pathname.replace(/^\/v1/, '')
    const token = (req.headers.authorization ?? '').replace('Bearer ', '')

    const script = scripted.get(path) ?? scripted.get('*')
    if (script) {
      scripted.delete(scripted.has(path) ? path : '*')
      return send(script.status, script.body, script.headers ?? {})
    }

    if (token !== VALID_ACCESS && token !== ROTATED_ACCESS) {
      return send(401, { error: { status: 401, message: 'The access token expired' } })
    }

    if (path === '/me') return send(200, { id: 'calvin', display_name: 'Calvin', product: 'premium', country: 'CA' })
    if (path === '/me/player/devices')
      return send(200, {
        devices: [
          { id: 'dev-phone', name: "Calvin's iPhone", type: 'Smartphone', is_active: true, is_restricted: false, volume_percent: 70 },
          { id: 'dev-speaker', name: 'Living Room', type: 'Speaker', is_active: false, is_restricted: true, volume_percent: null },
        ],
      })
    if (path === '/me/player' && req.method === 'GET')
      return send(200, {
        is_playing: true,
        progress_ms: 42_000,
        device: { id: 'dev-phone', name: "Calvin's iPhone", type: 'Smartphone', is_active: true, is_restricted: false, volume_percent: 70 },
        item: { uri: 'spotify:track:aaa', id: 'aaa', name: 'Like Him', duration_ms: 240_000, artists: [{ name: 'Tyler, The Creator' }], album: { name: 'CHROMAKOPIA' } },
        context: { type: 'playlist', uri: 'spotify:playlist:zzz' },
      })
    if (path === '/me/player/queue' && req.method === 'GET')
      return send(200, {
        currently_playing: { uri: 'spotify:track:aaa', id: 'aaa', name: 'Like Him', duration_ms: 240_000, artists: [{ name: 'Tyler, The Creator' }], album: { name: 'CHROMAKOPIA' } },
        queue: [{ uri: 'spotify:track:bbb', id: 'bbb', name: 'Song B', duration_ms: 200_000, artists: [{ name: 'B' }], album: { name: 'B' } }],
      })
    if (path === '/search')
      return send(200, {
        tracks: { items: [{ uri: 'spotify:track:aaa', id: 'aaa', name: 'Like Him', duration_ms: 240_000, artists: [{ name: 'Tyler, The Creator' }], album: { name: 'CHROMAKOPIA' } }] },
      })
    // Every mutating player command answers 204 with no body, exactly like Spotify.
    if (
      ['/me/player/queue', '/me/player/play', '/me/player/pause', '/me/player/next', '/me/player/previous', '/me/player/seek', '/me/player'].includes(
        path,
      )
    ) {
      return send(204)
    }

    return send(404, { error: { status: 404, message: 'Service not found' } })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        calls,
        /** Queue a one-shot response for the next request to `path` ('*' = any). */
        scriptOnce(path, status, body, headers) {
          scripted.set(path, { status, body, headers })
        },
        close: () => new Promise((r) => server.close(r)),
      }),
    )
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}
