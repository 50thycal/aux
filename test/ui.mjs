/**
 * Drives the real page in a real browser against the mock Spotify, with a
 * forged session cookie. Catches the class of defect the HTTP-level test
 * cannot: a client component that throws, a panel that never renders, a button
 * that does not wire up to the action it claims to.
 *
 *   node test/ui.mjs        (requires `npm run build` first)
 */
import { spawn } from 'node:child_process'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { chromium } from 'playwright'
import { startMock, VALID_ACCESS, VALID_REFRESH } from './mock-spotify.mjs'

const MOCK_PORT = 4020
const APP_PORT = 3020
const SECRET = 'test-session-secret-0123456789abcdef'

let failures = 0
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : `\n        ${detail}`}`)
  if (!cond) failures++
}

function seal(session) {
  const key = createHash('sha256').update(SECRET).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

for (const port of [MOCK_PORT, APP_PORT]) {
  if (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)) {
    console.error(`port ${port} already in use`)
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
    AUXCORD_INSECURE_COOKIES: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
app.stdout.on('data', () => {})
app.stderr.on('data', () => {})

const base = `http://127.0.0.1:${APP_PORT}`
for (let i = 0; i < 60; i++) {
  if (await fetch(`${base}/api/auth/session`).then(() => true, () => false)) break
  await new Promise((r) => setTimeout(r, 500))
}

// PLAYWRIGHT_BROWSERS_PATH points at the preinstalled browsers; fall back to the
// pinned build directory if this playwright version expects a different revision.
const browser = await chromium
  .launch()
  .catch(() => chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }))
const ctx = await browser.newContext()
const errors = []
try {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  // A missing favicon is not a defect in the page under test.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.text()) && !/status of 404/.test(m.text())) errors.push(m.text())
  })
  page.on('requestfailed', (r) => !/favicon/i.test(r.url()) && errors.push(`request failed: ${r.url()}`))

  console.log('\ndisconnected state')
  await page.goto(base)
  check('connect button rendered', await page.getByRole('button', { name: 'CONNECT SPOTIFY' }).isVisible())

  console.log('\nconnected state')
  await ctx.addCookies([
    {
      name: 'auxcord_session',
      value: seal({
        access_token: VALID_ACCESS,
        refresh_token: VALID_REFRESH,
        expires_at: Date.now() + 3_600_000,
        scope: 'user-read-playback-state user-read-currently-playing user-modify-playback-state',
        user: { id: 'calvin', display_name: 'Calvin', product: 'premium', country: 'CA' },
      }),
      domain: '127.0.0.1',
      path: '/',
    },
  ])
  await page.goto(base)
  await page.waitForSelector('text=Connected as')
  // The three initial reads (playback, devices, queue) are async; wait for the
  // last one to land rather than asserting into a race.
  await page.waitForSelector('text=CHROMAKOPIA')
  await page.waitForSelector('text=Living Room')

  const body = () => page.locator('body').innerText()
  const text = await body()
  check('shows the connected account and product', text.includes('Calvin') && text.includes('product: premium'))
  check('now playing shows the real track from /me/player', text.includes('Like Him') && text.includes('Tyler, The Creator'))
  check('now playing shows the track uri', text.includes('spotify:track:aaa'))
  check('devices table lists both mock devices', text.includes("Calvin's iPhone") && text.includes('Living Room'))
  check('restricted device is surfaced as restricted', /Living Room[\s\S]{0,80}true/.test(text), text.match(/Living Room[\s\S]{0,120}/)?.[0])
  check(
    'queue panel reports the currently playing track from GET /me/player/queue',
    (await page.locator('.panel', { hasText: 'Spotify queue' }).innerText()).includes('Song B'),
  )

  console.log('\ninteraction')
  await page.getByRole('button', { name: 'PAUSE' }).click()
  await page.waitForTimeout(1500)
  check('PAUSE produced a log entry for /me/player/pause', (await body()).includes('/me/player/pause'))

  await page.locator('input[placeholder="Like Him Tyler the Creator"]').fill('like him')
  await page.getByRole('button', { name: 'SEARCH' }).click()
  await page.waitForSelector('text=1 results')
  check('search rendered a result row with an ADD button', await page.getByRole('button', { name: 'ADD' }).first().isVisible())

  await page.getByRole('button', { name: 'ADD' }).first().click()
  await page.waitForTimeout(1500)
  check('ADD reports the queue POST succeeded', (await body()).includes('queued Like Him'))

  console.log('\nfailure surfacing')
  mock.scriptOnce('/me/player/next', 404, {
    error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' },
  })
  await page.getByRole('button', { name: 'NEXT' }).click()
  await page.waitForTimeout(1500)
  const afterFail = await body()
  check('a 404 is shown, not swallowed', afterFail.includes('NO_ACTIVE_DEVICE'))
  check('the failure gets a human diagnosis', afterFail.includes('No active Spotify Connect device'))

  await page.screenshot({ path: 'docs/screenshot.png', fullPage: true })
  check('no uncaught client errors during the whole run', errors.length === 0, errors.join('\n        '))
} finally {
  await browser.close()
  try {
    process.kill(-app.pid, 'SIGKILL')
  } catch {
    app.kill('SIGKILL')
  }
  await mock.close()
}

console.log(`\n${failures === 0 ? 'ui suite passed' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
