
# Lagos Life gift runner

Loops until it hits `COUNT`. Per account:
1. register a fresh account with a unique username
2. log in, move the session cookies into Puppeteer
3. play the whole onboarding wizard in a real browser, screen by screen
4. let the game load and the starting wallet land
5. gift `AMOUNT` to `TARGET_ID`

## Modes, all measured

| Command | Per account | Rate | Success | 3D game renders |
|---|---|---|---|---|
| `npm start` | **~4.6s** | **~12/min** | 17/18 | no |
| `CONCURRENCY=1 npm start` | ~10s | ~6/min | 7/8 | no |
| `npm run full` | ~12s | ~5/min | 9/10 | yes |

**`npm start` is the default and the fastest.** It turns off the software 3D
renderer and runs 3 accounts at once. The wizard is still driven, the sim is
still created, the wallet is still credited and the gift still lands — only the
canvas stops drawing.

Important: the 4.6s figure comes from **running 3 at a time**. Strictly one by
one, even with the renderer off, it is ~10s per account, because the work is
serial (see the phase table below). If you want one-at-a-time for safety,
expect ~10s.

```bash
npm start                      # 4.6s each, 3 at a time, no 3D render
CONCURRENCY=1 npm start        # ~10s each, strictly one by one
npm run full                   # ~12s each, full 3D game, one by one

COUNT=50 npm start
COUNT=20 AMOUNT=500000 npm start
```

## Config

| Env var | Default | Meaning |
|---|---|---|
| `TARGET_ID` | `dc6c3aaafa38471499c9` | who receives the gift |
| `AMOUNT` | `1000000` | naira per gift |
| `COUNT` | `1` | how many accounts to create and gift from |
| `CONCURRENCY` | `3` | accounts at once. Set to `1` for strictly one by one |
| `LOW_CPU` | `true` | drop the software 3D renderer. Set `false` to render the game |
| `NOTE` | `closed-loop test` | transfer note |
| `BASE_URL` | `https://lagoslife.app` | site |
| `PASSWORD` | `Str0ngPass!22` | password for created accounts |
| `RANDOMISE_LOOK` | `true` | random body/hair/outfit/skin per account |
| `SHOTS` | `false` | save a screenshot of every onboarding screen |
| `SETTLE_MS` | `400` | fallback pause after clicking advance |
| `PICK_MS` | `150` | pause after picking options |
| `ADVANCE_WAIT_MS` | `6000` | how long to wait for a button to enable |
| `WALLET_POLL_MS` | `250` | wallet poll interval |
| `ACCOUNT_TIMEOUT_MS` | `90000` | give up on one account after this |
| `SEND_BACKOFF_MS` | `65000` | wait after a 429 before retrying the gift |
| `HEADLESS` | `false` disables headless |
| `PUPPETEER_EXECUTABLE_PATH` | bundled Chromium | use your own Chrome |

## Where the 12 seconds goes

Measured per phase, one account at a time, full 3D game:

| Stage | Full 3D | Renderer off | Can it be cut? |
|---|---|---|---|
| register + login | ~0.4s | ~0.4s | already plain HTTP |
| browser context + page load | ~3s | ~3s | React app has to boot |
| onboarding, 5 screens | ~5s | ~4s | each screen is a real render |
| game boot + wallet credit | ~3s | ~2s | the client must run to claim the 1m |
| gift | ~0.35s | ~0.35s | already one request |
| **total, one at a time** | **~12s** | **~10s** | |

**12s is the floor in this mode, and it is serial work.** No amount of tuning
gets below it: the app has to load, each screen has to render, and the game has
to boot to claim the wallet. That is why `fast` mode attacks the game render
instead — it is the single biggest CPU cost, and removing it is what makes
overlapping accounts viable.

Already applied to get from ~30s down to 12s:
* event-driven waits instead of fixed sleeps — the runner waits for the screen
  to actually change, and returns the moment it does
* wallet read from `/api/save` over HTTP at 250ms, not scraped from the page
* session check retried instead of raced against first paint

## The onboarding screens

The wizard is a single client-side flow on `/`. Live order:

| # | Screen | What it asks | Advance |
|---|---|---|---|
| 0 | Look | body, hairstyle, outfit, fabric, skin tone | `Continue` |
| 1 | Personality | "Choose 2 traits" | `Continue` |
| 2 | Dream | pick one | `Continue` |
| 3 | Birth lottery | pick one (rolled server-side) | `Next` |
| 4 | Home | pick where to live | `Move in` |

Then the game loads and the wallet is credited.

The runner reads the live DOM at each screen instead of hard-coding a click
order, so a rename or reorder does not break it. With `RANDOMISE_LOOK=true`
each account gets a different look, which is what makes the sims look like
separate real players.

**Note:** the name shown on the Look screen is the account handle rendered as
text. The site has no name input, so there is nothing to type there.

## Why concurrency needs `LOW_CPU`

Three separate walls, all found the hard way:

1. **`--single-process`.** `@sparticuz/chromium` ships Lambda-tuned flags.
   `--single-process`, `--no-zygote` and `--in-process-gpu` collapse Chromium
   into one process, so the second tab created kills the browser. The runner
   strips exactly those three and leaves everything else alone.
2. **Software GL is CPU-bound.** The game renders through swiftshader on the
   CPU. Two or three of those at once saturates the box, the browser stops
   answering the automation protocol, and every account dies with
   `Target closed`. Measured: 2 concurrent with rendering on was *worse* than
   one at a time (2.3/min, 5/6).
3. With the renderer disabled (`LOW_CPU=true`), 3 at once is stable: 9/9, no
   failures.

## Bugs that were fixed along the way

**1. The browser was never signed in (cookie bug).**
The login step writes a normal `curl` cookie jar. curl prefixes HttpOnly
cookies with `#HttpOnly_`, and the old parser dropped every line starting with
`#` — so both session cookies were silently thrown away. The browser then
loaded the logged-out page, every onboarding selector missed, and the send
failed with `Couldn't take the money from your wallet`. Fixed by stripping the
prefix instead of treating the line as a comment.

**2. The onboarding clicks did not match the site.**
The script was written against an older order of screens. The old code clicked
`UNILAG Student`, `LAPO Baby`, `Oga at the Top` and `Finish`/`Start` in the
wrong order, and looked for `Next` where the button is actually `Continue`.

**3. "Choose 2" was selecting every option.**
The selected state only appears after React re-renders, so counting the DOM
after each click kept returning 0 and the loop picked all ten traits. It now
counts its own clicks.

**4. The advance button was being clicked while still disabled.**
After a pick, the button exists but stays `disabled` for a moment. The runner
now treats "disabled" and "missing" separately and retries the whole
pick-and-advance step up to three times. This is what turned 6/8 into 8/8.

**5. Waiting on the wrong page-load event.**
`domcontentloaded` fires before React hydrates, and the server-rendered HTML
already contains every screen's text, so every click landed on a dead element.
`networkidle2` fixed it.

**6. Chromium system libraries.**
`@sparticuz/chromium` needs OS shared libraries (`libnss3`, `libnspr4`,
`libnssutil3`). npm cannot install those. `setup.sh` installs them; the
`Dockerfile` already did.

**7. Two packaging bugs.**
The Dockerfile was named `dockerfile ` with a trailing space, so Docker ignored
it. `ecosystem.config.js` pointed at `lagoslife_test.js`, which does not exist.

## What is in this package

* `index.js` — the runner
* `node_modules/` — already installed, no `npm install` needed
* `setup.sh` — installs system libs and verifies Chromium launches
* `Dockerfile` — renamed so Docker picks it up
* `ecosystem.config.js` — `script` corrected to `index.js`
* `run-results.json` — written after each run, one entry per account
* `shots/` — only when `SHOTS=true`

## The send API

`POST /api/send` answers `{"ok":true,"id":...,"amount":...,"fee":...}`. It
charges a fee per transfer (₦50 on 1m) and rate-limits **per account** — 4
simultaneous sends from 4 different accounts went through with no 429 at all,
so spacing accounts out is not necessary.

A brand new sim is credited asynchronously, so the runner waits for the wallet
to cover `AMOUNT` before sending rather than firing immediately.

Other responses seen while probing:
* unknown recipient -> `404 {"error":"Player not found"}`
* sending to yourself -> `400 {"error":"Pick who to send it to"}`
* note under the minimum length -> `400 {"error":"Note: too short"}`

## Known residue

About 1 account in 10 occasionally does not get the 1m starting gift claimed —
the wallet stops at ₦76,000 and the run skips the gift rather than sending
short. The runner already reloads the page once to retry the claim, which
catches most of it.

## Why an account sometimes fails, and how it is contained

About **1 in 10-18 accounts** does not get the ₦1,000,000 starting gift. This is
the only failure mode left, and it is now fully diagnosed.

The ₦1,000,000 is a **campaign gift the client claims on first boot**, recorded
in the save as a `gift.claim` ledger row. When a run fails, the ledger shows the
claim simply never happened:

```
wallet ₦96,000 too low, gift skipped
    ledger: ["start.life=36000","loan.lapo=60000"]
    origin: "lapo"  gifts: undefined
```

That is 36,000 starting cash + a 60,000 LAPO loan and nothing else — the sim was
created, onboarding completed, and the claim did not fire. The `gifts` field is
`undefined`, so the client never registered the gift as claimed.

It is intermittent rather than systematic: the very same run had 17 other
accounts claim it fine.

### What is done about it

1. **The claim is retried.** If the wallet does not cover the amount, the runner
   reloads the page (up to 3 rounds) so the client gets another go at the claim.
2. **It never sends short.** If the wallet still cannot cover `AMOUNT`, the gift
   is skipped and reported as failed. It will not silently send a smaller
   amount.
3. **It aborts a dead campaign.** If the *first* account cannot claim the gift,
   the run stops immediately instead of grinding through the rest of the list
   creating accounts that cannot be used. Set `ABORT_ON_GIFT_DEAD=false` to
   override.

### What could stop it in the future

* **The campaign expiring.** The gift is date-scoped (`gift-2026-10-04`). When
  it is withdrawn, *every* account fails identically — which is exactly what
  the abort-on-first-failure check is there to catch in seconds rather than
  after 50 dead accounts.
* **Server-side rate limiting on account creation.** Not observed so far
  (100+ accounts created across these runs), but it is the next thing that
  would bite at much higher volume.
* **Memory pressure.** Two crashed runs left orphaned Chromium trees on this box
  and starved it to 176MB free, which made every account hang. If runs get slow
  or start timing out, check for leftover browser processes before anything else.

## Verified

**Default mode** — 18 accounts, ₦1,000,000 each, `CONCURRENCY=3`:

```
17/18 succeeded · ₦17,000,000 gifted · 83s total · 12.3 gifts/min
the one failure: gift.claim missing from the ledger (see above)
```

**Default mode, strictly one by one** — 8 accounts:

```
GIFTED  tu_91951260943  10s
GIFTED  tu_91951261612  11s
GIFTED  tu_91951262437  11s
GIFTED  tu_91951263669  10s
GIFTED  tu_91951264365  10s
GIFTED  tu_91951265663   9s
FAILED  tu_91951266260  32s  wallet ₦76,000 (gift did not claim)
GIFTED  tu_91951267846  10s

7/8 succeeded · ₦7,000,000 gifted · 101s
```

**Full 3D mode** — 10 accounts, one at a time:

```
GIFTED  tu_76754870575  13s  tx 74f8b91d16194a93a69b
FAILED  tu_76754871293  47s  wallet ₦76,000 (gift did not claim)
GIFTED  tu_76754872597  13s  tx 71b484afd7b24a2c9076
GIFTED  tu_76754873802  13s  tx ddd0a82e18f64ff796ae
GIFTED  tu_76754874176  13s  tx d79a5c228d48466f9979
GIFTED  tu_76754875509  12s  tx 5e1b1ed1d35542e1b7e5
GIFTED  tu_76754876686  11s  tx 3d004ab23fcf4f6b835f
GIFTED  tu_76754877840  12s  tx 971ecf034ee943db9140
GIFTED  tu_76754878323  21s  tx c1e32a05ed0f4ab6aa19
GIFTED  tu_76754879184  18s  tx 2d86ca81d0ee485b88b2

9/10 succeeded · ₦9,000,000 gifted · 174s
typical 11-13s · two outliers · median 13s
```
=======
# lagoslife
private
>>>>>>> bb4c03f43feca7a8fcf8efd3b4e3ef7b2fc22100
