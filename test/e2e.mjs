/**
 * Integration test: runs the real Next server with its Spotify base URLs pointed
 * at a mock, and drives it over HTTP exactly as the browser would.
 *
 * Scope, stated honestly: this proves AuxCord's OAuth handling, refresh paths,
 * error classification and evidence log. It proves NOTHING about real Spotify
 * playback — that requires a Premium account and real devices, and is what
 * docs/SPOTIFY_SPIKE_RESULTS.md is for.
 *
 *   node test/e2e.mjs        (requires `npm run build` first)
 */
import { spawn } from 'node:child_process'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { startMock, VALID_ACCESS, VALID_REFRESH, ROTATED_ACCESS, ROTATED_REFRESH } from './mock-spotify.mjs'

const MOCK_PORT = 4010
const APP_PORT = 3010
const SECRET = 'test-session-secret-0123456789abcdef'

let failures = 0
let passes = 0

function check(name, cond, detail) {
  if (cond) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? `\n        ${JSON.stringify(detail)}` : ''}`)
  }
}

/** Mirrors src/lib/spotify/session.ts so the test can forge a session cookie. */
function seal(session) {
  const key = createHash('sha256').update(SECRET).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

function cookieFor(overrides = {}) {
  return `auxcord_session=${seal({
    access_token: VALID_ACCESS,
    refresh_token: VALID_REFRESH,
    expires_at: Date.now() + 3_600_000,
    scope: 'user-read-playback-state user-read-currently-playing user-modify-playback-state',
    refresh_count: 0,
    ...overrides,
  })}`
}

async function callApi(cookie, action, params) {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/spotify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ action, params }),
  })
  return { status: res.status, setCookie: res.headers.getSetCookie?.() ?? [], json: await res.json() }
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`server never came up: ${url}`)
}

// A stale server on the app port would silently answer every assertion while
// pointing at a mock that no longer exists, so refuse to run in that state.
for (const port of [MOCK_PORT, APP_PORT]) {
  const reachable = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then(
    () => true,
    () => false,
  )
  if (reachable) {
    console.error(`port ${port} is already in use — kill the stale process and re-run`)
    process.exit(2)
  }
}

const mock = await startMock(MOCK_PORT)

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT), '-H', '127.0.0.1'], {
  detached: true,
  env: {
    ...process.env,
    SPOTIFY_CLIENT_ID: 'test-client-id',
    SESSION_SECRET: SECRET,
    SPOTIFY_ACCOUNTS_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    SPOTIFY_API_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`,
    SPOTIFY_REDIRECT_URI: `http://127.0.0.1:${APP_PORT}/api/auth/callback`,
    AUXCORD_INSECURE_COOKIES: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
app.stdout.on('data', () => {})
app.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d))

try {
  await waitForServer(`http://127.0.0.1:${APP_PORT}/api/auth/session`)

  console.log('\nauth')
  {
    const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/session`)
    check('no cookie -> not connected', (await res.json()).connected === false)

    const unauth = await fetch(`http://127.0.0.1:${APP_PORT}/api/spotify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'devices' }),
    })
    check('no cookie -> /api/spotify 401', unauth.status === 401)

    const login = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/login`, { redirect: 'manual' })
    const loc = new URL(login.headers.get('location'))
    check('authorize uses PKCE S256', loc.searchParams.get('code_challenge_method') === 'S256')
    check('authorize sends no client secret', !loc.search.includes('client_secret'))
    check(
      'authorize requests exactly the three player scopes',
      loc.searchParams.get('scope') === 'user-read-playback-state user-read-currently-playing user-modify-playback-state',
      loc.searchParams.get('scope'),
    )

    const tampered = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/session`, {
      headers: { cookie: 'auxcord_session=not-a-real-sealed-cookie' },
    })
    check('tampered cookie -> not connected (no 500)', (await tampered.json()).connected === false)

    const sess = await fetch(`http://127.0.0.1:${APP_PORT}/api/auth/session`, { headers: { cookie: cookieFor() } })
    const body = await sess.json()
    check('session endpoint leaks no token', !JSON.stringify(body).includes(VALID_ACCESS), body)
  }

  console.log('\nhappy path')
  {
    const r = await callApi(cookieFor(), 'devices')
    check('devices 200', r.json.ok && r.json.status === 200)
    check('one log entry per call', r.json.entries.length === 1)
    const e = r.json.entries[0]
    check('entry carries endpoint + class + diagnosis', e.endpoint === '/me/player/devices' && e.error_class === 'ok' && e.diagnosis === 'none', e)
    check('entry carries a duration', typeof e.duration_ms === 'number')
    check('no refresh on a live token', !e.after_refresh)

    const q = await callApi(cookieFor(), 'queue.add', { uri: 'spotify:track:aaa', device_id: 'dev-phone', device_name: "Calvin's iPhone" })
    const qe = q.json.entries[0]
    check('queue.add puts the uri in the query string', qe.endpoint.includes('uri=spotify%3Atrack%3Aaaa'), qe.endpoint)
    check('queue.add records the target device', qe.device_id === 'dev-phone' && qe.device_name === "Calvin's iPhone")
    check('queue.add records the track uri', qe.track_uri === 'spotify:track:aaa')
    check('mutating command reads playback back', qe.observed && qe.observed.track_name === 'Like Him', qe.observed)

    const s = await callApi(cookieFor(), 'search', { q: 'like him tyler' })
    check('search returns tracks', s.json.ok && s.json.data.tracks.items.length === 1)

    const bad = await callApi(cookieFor(), 'no-such-action')
    check('unknown action rejected locally as an AuxCord bug', bad.json.status === 400 && bad.json.entries[0].diagnosis === 'auxcord_bug')

    const noUri = await callApi(cookieFor(), 'queue.add', {})
    check('queue.add without uri never reaches Spotify', noUri.json.status === 400 && noUri.json.entries[0].method === 'LOCAL')
  }

  console.log('\ntoken lifecycle')
  {
    const r = await callApi(cookieFor({ expires_at: Date.now() - 1000 }), 'devices')
    check('expired timestamp -> proactive refresh, call still succeeds', r.json.ok, r.json.entries[0])
    check('proactive refresh is on the record', r.json.entries[0].after_refresh === true)
    check('rotated session is written back to the cookie', r.setCookie.some((c) => c.startsWith('auxcord_session=')))

    const hard = await callApi(cookieFor({ access_token: 'corrupted' }), 'devices')
    check('401 -> refresh -> retry recovers transparently', hard.json.ok, hard.json.entries[0])
    check('reactive refresh is on the record', hard.json.entries[0].after_refresh === true)

    const dead = await callApi(cookieFor({ access_token: 'corrupted', refresh_token: 'revoked' }), 'devices')
    const de = dead.json.entries[0]
    check('unrecoverable token fails loudly as an OAuth problem', de.status === 401 && de.error_class === 'token_expired' && de.diagnosis === 'oauth', de)

    const rotated = await callApi(cookieFor({ access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH }), 'devices')
    check('a rotated refresh token keeps working', rotated.json.ok)
  }

  console.log('\nerror classification')
  {
    const cases = [
      ['/me/player/next', 404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }, {}, 'next', 'no_active_device', 'spotify_connect'],
      ['/me/player/next', 403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }, {}, 'next', 'premium_required', 'spotify_api_behaviour'],
      ['/me/player', 403, { error: { status: 403, message: 'Device not controllable', reason: 'DEVICE_NOT_CONTROLLABLE' } }, {}, 'transfer', 'restricted_device', 'spotify_connect'],
      ['/me/player/next', 403, { error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'NO_NEXT_TRACK' } }, {}, 'next', 'nothing_to_skip', 'spotify_api_behaviour'],
      ['/me/player/devices', 429, { error: { status: 429, message: 'API rate limit exceeded' } }, { 'retry-after': '13' }, 'devices', 'rate_limited', 'rate_limit'],
      ['/me/player/queue', 400, { error: { status: 400, message: 'Invalid track uri: not-a-uri' } }, {}, 'queue.add', 'invalid_request', 'auxcord_bug'],
      ['/me/player/devices', 502, { error: { status: 502, message: 'Bad gateway' } }, {}, 'devices', 'server_error', 'spotify_api_behaviour'],
    ]
    for (const [path, status, body, headers, action, expectClass, expectDiag] of cases) {
      mock.scriptOnce(path, status, body, headers)
      const r = await callApi(cookieFor(), action, { device_id: 'dev-phone', uri: 'not-a-uri', observe: false })
      const e = r.json.entries[0]
      check(`${status}${body.error.reason ? ` ${body.error.reason}` : ''} -> ${expectClass}/${expectDiag}`, e.error_class === expectClass && e.diagnosis === expectDiag, e)
      if (status === 429) check('Retry-After is captured', e.retry_after_s === 13, e.retry_after_s)
      check(`${status} keeps Spotify's verbatim error body`, JSON.stringify(e.error_body) === JSON.stringify(body), e.error_body)
    }
  }

  console.log('\nordering / burst')
  {
    const before = mock.calls.length
    const r = await callApi(cookieFor(), 'burst', {
      settle_ms: 50,
      steps: [
        { action: 'queue.add', params: { uri: 'spotify:track:a1' } },
        { action: 'queue.add', params: { uri: 'spotify:track:a2' } },
        { action: 'next', params: {} },
        { action: 'queue.add', params: { uri: 'spotify:track:a3' } },
      ],
    })
    const entries = r.json.entries
    check('burst emits one entry per command plus the settling queue read', entries.length === 5, entries.map((e) => e.action))
    check('burst preserves the order commands were sent', entries.slice(0, 4).map((e) => e.action).join(',') === 'queue.add,queue.add,next,queue.add', entries.map((e) => e.action))
    check('burst does no observation reads between commands', entries.slice(0, 4).every((e) => !e.observed))
    const sent = mock.calls.slice(before).map((c) => `${c.method} ${c.path.split('?')[0]}`)
    check('burst hits Spotify in order', sent.join(' | ').includes('POST /v1/me/player/queue | POST /v1/me/player/queue | POST /v1/me/player/next | POST /v1/me/player/queue'), sent)
  }

  console.log('\nsecret hygiene')
  {
    const r = await callApi(cookieFor(), 'devices')
    const dump = JSON.stringify(r.json)
    check('no access token anywhere in the response', !dump.includes(VALID_ACCESS))
    check('no refresh token anywhere in the response', !dump.includes(VALID_REFRESH))
    check('no bearer header echoed into the log', !dump.toLowerCase().includes('bearer'))
    check('session cookie is httpOnly', r.setCookie.every((c) => !c.startsWith('auxcord_session=') || /HttpOnly/i.test(c)))
  }

} finally {
  // `npx` spawns a shell that spawns next-server; kill the whole group or the
  // server outlives the test and poisons the next run.
  try {
    process.kill(-app.pid, 'SIGKILL')
  } catch {
    app.kill('SIGKILL')
  }
  await mock.close()
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
