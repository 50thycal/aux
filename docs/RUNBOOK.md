# Runbook — running the AuxCord Spotify spike

Everything here needs about 15 minutes and one Spotify **Premium** account.

## 1. Spotify application

1. https://developer.spotify.com/dashboard → **Create app**.
2. Redirect URIs — add both:
   - `http://127.0.0.1:3000/api/auth/callback`
   - `https://<your-project>.vercel.app/api/auth/callback`
   Spotify rejects `http://localhost/...`; loopback must be the literal IP `127.0.0.1`.
   Deployed URIs must be `https`.
3. Which APIs: **Web API**.
4. Copy the **Client ID**. Do not copy the client secret — the app never uses one.
5. The app starts in **Development Mode**: only users you add under
   *Settings → User Management* (name + the email on the Spotify account) can authorise it.
   Add yourself there or the callback will fail with an authorisation error.

## 2. Local

```bash
npm install
cp .env.example .env.local
# fill SPOTIFY_CLIENT_ID and SESSION_SECRET
npm run dev
```

Open **http://127.0.0.1:3000** (not `localhost` — the redirect URI must match exactly)
and press *CONNECT SPOTIFY*.

## 3. Vercel

```bash
npx vercel link
npx vercel env add SPOTIFY_CLIENT_ID       # production + preview
npx vercel env add SESSION_SECRET
npx vercel env add SPOTIFY_REDIRECT_URI    # https://<project>.vercel.app/api/auth/callback
npx vercel --prod
```

Preview deployments get a new hostname per deploy, so `SPOTIFY_REDIRECT_URI` pinned to the
production hostname will make previews fail at the callback. Either test on production or
register the preview hostname too. There is no database; the session lives entirely in an
encrypted `httpOnly` cookie, which also means clearing cookies is the same as logging out.

## 4. Offline test suite

```bash
npm test
```

Boots the real Next server with its Spotify base URLs pointed at `test/mock-spotify.mjs`
and drives it over HTTP. It proves the parts that do not need an account: PKCE flow shape,
scope set, session sealing, proactive refresh, `401 → refresh → retry`, unrecoverable-token
behaviour, error classification for every Spotify failure mode the spike cares about,
command ordering inside a burst, and that no token ever reaches a log entry or the browser.

It proves **nothing** about real playback. That is what the rest of this runbook is for.

## 5. The manual protocol

Do these in order and fill in `SPOTIFY_SPIKE_RESULTS.md` as you go. Press
**DOWNLOAD .jsonl** in the evidence panel at the end of each session and keep the file.

### 5.1 Devices
Open Spotify on every device you own — phone, desktop, speaker, TV, car, console, web
player. Press **READ DEVICES**. Record which appear and which do not, their `type`,
`is_restricted`, and whether `id` is `null`. Then close one app and read again: note how
long a device lingers in the list after it goes away. Read devices again the next day and
compare the ids for the same physical devices — that answers the stability question.

### 5.2 Observation latency
With the 1s poll running, change the track inside the Spotify app and press
**MARK: I just changed the track in Spotify** at the same moment. The transitions table
stamps the elapsed time. Repeat five or six times, on Wi-Fi and on cellular, and record
the spread, not just the best case.

### 5.3 Queue behaviour
Run the search → **ADD** → **READ QUEUE** loop under each of these conditions, and after
each one check the Spotify client's own queue view against what the API reported:

- nothing playing at all
- a single track playing with an empty queue
- a playlist playing (Spotify has generated its own upcoming list)
- an album playing
- a queue you built by hand in the Spotify app
- two AuxCord adds back to back

Record the **position** each added track lands at, and whether Spotify's reported queue
matches the client's display.

### 5.4 The critical experiment
Fill in Song A and Song B, then walk the *Critical AuxCord experiment* panel top to bottom.
**JUMP TO 8s BEFORE END** saves you waiting out a track. Press **FINISH RUN & RECORD** at
the end, then **COPY MARKDOWN** and paste the table into the results doc.

Run it at least three times. One success is an anecdote.

### 5.5 Stress
Each button in the *Stress / failure injection* panel writes its raw result into the box
below it; copy anything surprising into the results doc.

Plus the things no button can do for you:

- **Spotify app closed** — quit Spotify everywhere, then press *probe with no active device*.
- **Paused for several minutes** — pause, wait 10+ minutes, then try PLAY from AuxCord.
  Note whether the device is still listed and whether the command still lands.
- **Network switch** — put the phone on cellular mid-session and keep controlling it.
- **Manual interference** — change tracks and edit the queue inside Spotify while AuxCord
  is open, and confirm AuxCord reconciles rather than showing stale state.

## 6. Reading the evidence

Every log line carries a `diagnosis` so failures can be attributed rather than argued about:

| diagnosis | means |
| --- | --- |
| `auxcord_bug` | we sent something malformed |
| `oauth` | token, refresh, scope, or allowlist |
| `spotify_connect` | device availability, restriction, or targeting |
| `rate_limit` | 429, with `Retry-After` captured |
| `spotify_api_behaviour` | Spotify accepted or refused on its own terms |
| `transport` | the request never reached Spotify |

Server-side, the same JSON goes to `stdout`, so Vercel's runtime logs hold a copy that
survives closing the tab.

Downloaded transcripts belong in [`../evidence/`](../evidence/) — they are gitignored, but
they are the backing evidence for every verdict written into the results document.
