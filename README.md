# AuxCord — Spotify control-plane spike

One question: **can a small external app authenticate with Spotify and reliably observe
and control real Spotify playback?**

This repository is the instrument for answering it, not a product. One ugly page, one
instrumented request path, and an evidence log you can download.

- Setup and how to run each test: [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
- The answer, as it gets filled in: [`docs/SPOTIFY_SPIKE_RESULTS.md`](docs/SPOTIFY_SPIKE_RESULTS.md)

```
npm install
cp .env.example .env.local     # fill in SPOTIFY_CLIENT_ID and SESSION_SECRET
npm run dev                    # then open http://127.0.0.1:3000
npm test                       # offline integration suite against a mock Spotify
```

## Architecture in one line

Spotify is the authority; AuxCord is an observer that issues intents and reconciles.

```
AuxCord intent -> Spotify command -> Spotify actual state -> AuxCord reads/reconciles
```

Nothing in the UI is rendered from AuxCord's assumption of what a command did. Every
mutating command is followed by a read of `/me/player`, and that read is what gets
displayed and logged. A `2xx` is treated as "accepted", never as "it happened".
