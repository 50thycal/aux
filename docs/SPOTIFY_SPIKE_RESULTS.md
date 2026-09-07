# Spotify spike — results

**Question:** can Spotify act as a sufficiently reliable external playback engine for AuxCord?

**Status: NOT YET ANSWERED.** The instrument is built and its offline half is proven. The
half that requires a real Premium account, real Spotify Connect devices and real audible
playback has not been run, because this session had no Spotify credentials, no Premium
account and no devices to play on. Every row below that depends on real playback is marked
`UNKNOWN` on purpose. **Do not read an UNKNOWN as a pass.**

Filling this in is a ~30 minute job for whoever has the account: follow
[`RUNBOOK.md`](RUNBOOK.md) §5 and replace the `UNKNOWN` rows with what you actually observe.

---

## Capability table

`Verdict` values: `PASS` (observed working), `FAIL` (observed broken), `UNKNOWN` (not yet run).
`Actual` must be filled from observation — never from documentation.

| Capability | Expected | Actual | Verdict |
| --- | --- | --- | --- |
| Authenticate (PKCE, real account) | Consent screen → callback → connected as the account, `product: premium` | | UNKNOWN |
| Token refresh after ~1h | Refresh happens silently; no user-visible interruption | | UNKNOWN |
| Recover from an expired/revoked token | 401 → refresh → retry succeeds; unrecoverable case says "reconnect" | | UNKNOWN |
| Detect device | Real devices appear in `/me/player/devices` with usable ids | | UNKNOWN |
| Current track | `/me/player` reports the track playing on the real device | | UNKNOWN |
| Observe a manual change | AuxCord sees a track changed in the Spotify app, within ~1 poll | | UNKNOWN |
| Search | Query returns tracks with URIs that are then playable | | UNKNOWN |
| Add queue item | `POST /me/player/queue` → track appears in the Spotify client's queue | | UNKNOWN |
| Read queue | `GET /me/player/queue` matches what the Spotify client shows | | UNKNOWN |
| Play / pause | Real audio starts and stops | | UNKNOWN |
| Skip (next / previous) | Real track changes | | UNKNOWN |
| Transfer playback | Audio moves to the chosen device and continues | | UNKNOWN |
| Recover after manual Spotify changes | AuxCord reconciles to Spotify rather than showing stale state | | UNKNOWN |
| Full critical loop, repeated 3× | Same result each time | | UNKNOWN |

### Proven offline (`npm test`, 49 assertions against a mock Spotify)

These are properties of AuxCord's own code and do not depend on an account. They are
**not** claims about Spotify's behaviour.

| Property | Verdict |
| --- | --- |
| Authorization request uses PKCE `S256` and carries no client secret | PASS |
| Exactly three scopes requested, no more | PASS |
| Session cookie is encrypted, `httpOnly`; a tampered cookie degrades to "not connected" | PASS |
| No access or refresh token ever reaches the browser or a log entry | PASS |
| Expired-by-timestamp token → proactive refresh → call still succeeds | PASS |
| `401` → refresh → retry recovers transparently; rotated refresh token is persisted | PASS |
| Revoked refresh token fails loudly, classified `oauth` | PASS |
| `404 NO_ACTIVE_DEVICE` → `spotify_connect`; `403 PREMIUM_REQUIRED`, `403 DEVICE_NOT_CONTROLLABLE`, `403 NO_NEXT_TRACK`, `429` + `Retry-After`, `400`, `502` each classified and kept verbatim | PASS |
| A malformed request is rejected before it reaches Spotify, classified `auxcord_bug` | PASS |
| Burst mode issues commands in order with no observation reads injected between them | PASS |

---

## PROVEN

*Capabilities directly demonstrated against real Spotify. Empty until §5 of the runbook is run.*

- _(nothing yet)_

## LIMITED

*Works, but with a constraint worth designing around.*

- _(nothing yet)_

## BLOCKED

*Spotify does not permit it, or it could not be made reliable.*

- _(nothing yet)_

## UNKNOWN

Everything in the capability table above, plus the specific open questions below. Each one
has an experiment attached; none is answerable from documentation.

### Devices
1. Which of your physical devices actually appear in `/me/player/devices`? Which never do?
2. How long does a device linger in the list after its app is closed?
3. Are device ids stable across a day? Across an app restart? Across a reboot?
   *(If they are not, AuxCord can never store a device id as a durable reference.)*
4. What exactly happens on a device with `is_restricted: true` — which commands fail, with
   what status and `reason`?
5. Do any devices come back with `id: null`, and are they therefore untargetable?

### Queue
6. Where does an added track land when a playlist is playing versus when a single track is?
7. Does `GET /me/player/queue` agree with the Spotify client's own queue view?
8. Two adds back to back — do they land in the order sent?
9. `add, add, skip, add` with no waiting — what order survives? *(Spotify explicitly does
   not guarantee ordering between Player commands; the burst test measures the real answer.)*
10. Does an added track survive the user skipping past it, or shuffling?

### State and latency
11. What is the p50/p90 delay between a change in Spotify and AuxCord observing it?
12. Does that change on cellular versus Wi-Fi?
13. After a long pause (10+ min), is the device still listed and still controllable?

### Limits
14. At what request rate does a 429 appear, and what `Retry-After` does Spotify send?
    *(A 1s poll per user is fine for one account; it is worth knowing where the wall is,
    because a multi-user AuxCord multiplies it.)*
15. Does Development Mode's 25-user allowlist bite in any way beyond authorisation?

---

## Constraints known going in

Documented by Spotify and **not yet verified here** — treat each as a hypothesis the run
should confirm or contradict, and move it into PROVEN / LIMITED / BLOCKED when it does.

- Player endpoints (play, pause, next, previous, seek, queue, transfer) require Premium.
- Transfer accepts a `device_ids` **array** but only one destination is supported.
- Ordering between Player API commands is not guaranteed.
- Development Mode limits the app to a small allowlist of authorised users, which is a
  hard ceiling on anything beyond personal testing.
- Only devices Spotify considers awake and recently active are listed.

## Limitations discovered while building

Observed while implementing, without an account:

- **There is no push channel.** The Web API offers no webhook or subscription for playback
  state, so observation is polling, and polling cost scales linearly with concurrent hosts.
  This is the single biggest architectural constraint for a multi-user AuxCord and it is
  visible from the API surface alone.
- **`2xx` means "accepted", not "happened".** Every mutating player endpoint answers `204`
  with no body, so the command result carries no information about the resulting state.
  That is why every mutating command in this app is followed by a read of `/me/player`, and
  why the UI renders the read rather than the intent.
- **The queue is not addressable.** There is no remove, no reorder, and no stable identifier
  for a queued item — only append. AuxCord's future fairness/credits model cannot be built
  on top of Spotify's queue; it will have to hold its own ordered list and append one track
  at a time, late.
