# Changelog

## 0.3.2 — 2026-09-20

### Bug fixes
- Fix the mobile player's transport row (skip/play/mark-played) and progress bar being squeezed onto one line instead of stacking into their own rows — the progress bar is a child of the transport row, not a sibling of it, so it needed that row to actually wrap, and an order lower than the buttons' to land above rather than after them
- Fix the player never showing which feed the playing episode is from — `#player-feed` existed in the markup but nothing ever set its text

### Docs
- Replace the outdated Cloudflare Tunnel section with a note that public access goes through Pangolin now

## 0.3.1 — 2026-09-20

### Bug fixes
- Fix the mobile menu button being permanently invisible — a leftover `#btn-menu-toggle{display:none}` rule outranked the `.mobile-only` class meant to reveal it at narrow widths, since an ID selector always beats a class one regardless of the media query. With no way to open it, the sidebar (feeds, search, Continue Listening) was completely unreachable on a phone
- Fix marking the actively-playing episode played leaving it undimmed and, on the next refresh, its progress meter blank instead of updated — `endPlaybackNow()` now clears playback state the same way the player naturally reaching the end already did, instead of leaving it half-cleaned-up
- A read episode's progress bar is now hidden outright rather than sometimes showing a stale position
- Fix the sidebar (and, on mobile, the taller stacked player) having no reserved space for the fixed player bar, so the last feed and the version line ended up hidden behind it — `--player-h` now tracks the player's real rendered height

## 0.3.0 — 2026-09-19

### Redesign
- Full visual redesign: a cooler, dark color system (deep blue-black with a cyan/orange accent pair), IBM Plex Sans/Mono throughout, and a rebuilt icon set (feed types, transport controls, header actions) — replacing the old grey/blue palette and single-character glyph icons
- Feed list: "All Episodes" gets a ring that fills with how much is unread instead of a plain badge; each feed keeps its type icon (RSS/YouTube/Substack) next to an unread count in the new accent color
- Episode rows: the −10/−30/+30 skip buttons now show their seconds directly in the icon instead of being visually identical; the two-button "play audio / play video" row action is gone in favor of a single larger mark-played toggle that only appears on hover on desktop and stays visible on mobile (as a proper touch target, not a hover affordance)
- Mobile: header actions (transfer, refresh, settings) no longer disappear at narrow widths; episode search moves into the sidebar drawer instead of vanishing; the player reflows into a Spotify-style stacked layout (art + title, then progress, then a five-button transport row including a mobile mark-played toggle) instead of the old cramped two-row wrap
- The old "⏹ end & mark played" button is replaced by a proper mark-played/unplayed toggle, available inline on desktop and in the mobile transport row; marking the *currently playing* episode played now also jumps playback to the end immediately — handy for cutting off a trailing ad block without losing the played state

### Bug fixes
- Episode rows no longer go stale until a hard refresh: marking an episode read/unread on one device now updates the read state of that episode everywhere it's visible on other connected devices, not just the sidebar unread counts (the SSE `feeds_changed` event only ever refreshed feeds, never the episode list itself)
- An episode's progress meter now advances during playback instead of only reflecting whatever it was when the list last loaded

## 0.2.14 — 2026-09-19

### Bug fixes
- Fix playback getting stuck in a loop that replayed the same half-second of audio, most often at the point a podcast host splices in an ad. A media error triggered a retry that reloaded the stream and seeked back to the saved position — the exact frame that had just failed — so it failed again immediately. Three things kept the loop alive, all now fixed: the "retry once" guard was cleared by the `playing` event, which the half-second of playback before each failure was enough to fire; the synthetic `pause` from reloading the stream wrote the failing offset back as the saved position, pinning it there; and the retry always resumed at that same offset instead of stepping past the bad frame
- Retries now resume past the failure (2s, then 5s, then 10s) rather than landing on it, and give up with an error after 3 attempts in a minute instead of retrying indefinitely; a retry only counts as successful once playback has advanced 5s past where it resumed
- Stop the retry sending `no_cache=1` for decode errors, which deleted the locally downloaded copy and forced a full re-download on every attempt — in the stall loop this fired several times a minute and meant the 0.2.13 download cache could never establish for an affected episode
- Log the `MediaError` code to the console on playback failure. The failure this fixes is `PIPELINE_ERROR_DECODE` / `mpa: part2_3_length is not valid` — a malformed MP3 frame at the ad splice, which no decoder can play, so skipping past it is the only recovery
- Fix the PWA manifest failing to load behind the auth proxy. Manifest requests are uncredentialed by default, so the proxy bounced them to a cross-origin login URL with no CORS headers and the browser blocked it; the link now requests it with credentials
- Fix `/api/prewarm` raising `TypeError` on every call and resolving nothing — `asyncio.gather()` returns a future, not a coroutine, so wrapping it in `create_task()` failed before any of the work started. YouTube stream-URL prewarming has been dead since 0.2.2 and now actually runs

### Improvements
- Never switch an episode's byte source mid-playback. A background download completing partway through an episode used to divert the next range request to the local file — a separately fetched copy that need not be byte-identical — which breaks the browser's range bookkeeping. A playback that starts against the origin now stays there until it stops, and only a later play uses the cached copy
- Record which variant a downloaded file is, so a cached YouTube video isn't served to an audio playback or vice versa; downloads also now follow the requested variant rather than always the feed default
- Write downloads to disk off the event loop. They ran as synchronous writes on the single uvicorn worker that also proxies live playback and holds the SSE connections, stalling both for the duration of each write
- Don't let the cleanup job delete a file out from under an episode played in the last 24 hours — the reader's open handle survives, but clearing the row sent the next range request back to the origin, swapping the byte source mid-episode
- Pin `starlette>=0.45`, the first release whose `FileResponse` answers `Range` requests with `206`. Seeking within a downloaded episode depends on it, and an unpinned rebuild resolving older would have broken playback silently

## 0.2.13 — 2026-07-08

### New features
- Downloaded episodes now cache locally on first play, so replays are faster and immune to the original source going away (e.g. a YouTube video or RSS media URL disappearing); a bad cached copy auto-invalidates and re-downloads if playback fails
- Add a per-feed "auto-download new episodes" toggle (feed context menu, default off) — new episodes on that feed download automatically instead of waiting for you to press play
- Add a cleanup job that clears downloaded files for episodes marked as listened, after a configurable number of days (Settings dialog, default 7); downloaded episodes you never finish or mark as listened are also cleared after 30 days regardless
- Add a "Continue Listening" view showing in-progress episodes across all feeds, most-recently-played first
- Add a search box to the episode list for filtering by title within the current feed
- Add a small indicator on the transfer button when another device is currently playing

### Security fixes
- Fix a stored XSS vector: episode links from feed data were rendered as clickable `<a>` hrefs without checking the URL scheme, so a `javascript:` link in a feed could execute on click — now only http(s) links render as clickable
- Reject feed URLs that don't start with `http://` or `https://`, since `feedparser` will otherwise treat a bare path as a local file to parse

### Improvements
- Add a connect timeout to the stream proxy so a dead/unreachable upstream fails fast instead of hanging the request indefinitely

## 0.2.12 — 2026-07-08

### Improvements
- Replace the hard `window.location.reload()` on session expiry with an in-place recovery dialog — log in again in a new tab, click Retry, and the app resumes without losing playback position or scroll state
- Network requests now retry twice with backoff before failing, so transient blips no longer surface as errors
- Public access migrated from Cloudflare Tunnel to a self-hosted Pangolin instance; auth is now a PIN gate instead of Cloudflare Access email OTP

## 0.2.11 — 2026-07-02

### Bug fixes
- Fix track-switch position saves being written to the wrong episode: outgoing position is now saved before `state.playing` changes, and the switch-in-progress pause handler no longer overwrites it with the new episode's stale `currentTime`
- Fix stale `loadedmetadata` seek listeners surviving an episode switch and seeking the new episode to the previous one's saved position
- Fix `_mediaRetrying` never resetting after a successful retry, so a second stale-stream-URL failure on a long listening session showed an error instead of retrying
- Fix SSE reconnect race where a superseded connection's cleanup could delete a newly-registered device, making it vanish from the device list despite being live
- Avoid unnecessary SSE reconnects on every tab focus; only reconnect if the connection is actually closed
- Fix fire-and-forget prewarm background task being eligible for garbage collection mid-run
- Enforce the real `check_interval` floor (900s, matching the scheduler's 15-minute poll cadence) instead of the unenforceable 60s the API accepted
- Fix `published_at` backfill rewriting every episode row on every feed poll instead of only rows missing a date
- Cap `limit`/`offset` on episode listing to prevent unbounded queries
- Replace deprecated `datetime.utcfromtimestamp` with a timezone-aware equivalent
- Cap playlist date-enrichment work per fetch so adding a large custom YouTube playlist no longer risks timing out; the backlog now drains over subsequent scheduled refreshes

### Improvements
- Add Media Session API support: lock-screen artwork/title and headphone/hardware playback controls
- Add keyboard shortcuts (Space to play/pause, ←/→ to seek) that stay out of the way while typing in dialogs
- "Refresh all" now reports how many feeds failed instead of silently aborting on the first error
- Replace backend `print()` calls with structured logging
- Document the single-worker constraint in the Dockerfile
- Exclude `.git`, `.env`, and other non-deployable files from the NAS rsync

## 0.2.0 — 2026-04-17

### Remote control
- Phone can now control desktop playback without handing off the stream
- New **Remote** option in the ⇄ menu: takes over the phone's player bar to show what's playing on the desktop, with full transport controls (play/pause, −30s/−10s/+30s, seek bar, speed)
- Desktop broadcasts player state to other connected devices on play, pause, speed change, and every 10 s while playing; phone reflects position in real time with a 1 s ticker between broadcasts
- **Reclaim** option pulls playback back to the phone from wherever the desktop left off
- Remote mode exits automatically if the desktop disconnects, with a toast notification
- Clicking any episode on the phone while in remote mode exits remote and plays locally

### Transfer button
- ⇄ button moved to the header so it is always accessible, even when nothing is playing locally
- Tapping ⇄ with no other devices online shows "No other devices online" instead of an empty popup

### Bug fixes
- Fix CORS error in browser console when a stream fails to load and the diagnostic fetch follows a redirect to an external CDN (`redirect: 'manual'`)

### Infrastructure
- Static asset cache busting: `app.js` and `style.css` now include `?v=` query strings so browser and CDN caches are invalidated on each release

---

## 0.1.5 — 2026-04-15

- Hide video toggle button for non-video (RSS/Substack) episodes
- Auto-retry stream once with cache bypass on media error, handling stale YouTube stream URLs and updated RSS `media_url` after a feed refresh
- Mobile player: two-row layout (progress bar on top, controls below), hide −10s button, larger tap targets for controls and episode actions

## 0.1.4 — 2026-04-10

- Filter upcoming/post-live YouTube streams from playlist feeds at parse time
- Improve yt-dlp error messages for scheduled premieres and livestreams
- Reduce play latency: stream resolution starts in parallel with position fetch
- Show loading indicator (⋯ on play button, pulsing episode item) while stream is buffering
- Show error toast on stream failure with the actual server error detail

## 0.1.3 — 2026-04-08

- Add −10s seek button alongside existing −30s in player controls
- Remove auto-mark-as-read on play start; episodes now only marked played on natural completion or via the ⏹ end button
- New episodes slide into the top of the list instead of triggering a full reload (newest sort)

## 0.1.2 — 2026-04-07

- Fix episode timestamps: stored UTC datetimes now parsed correctly as UTC in JS
- Add refresh indicator: feed icon spins while Refresh Now is in progress
- Fix Docker build warnings

## 0.1.1 — 2026-04-07

- Fix feed navigation: stale episode list clears immediately on sidebar click
- Fix refresh: new episodes SSE event refreshes the episode list, not just the sidebar
- Fix handoff playback: seek-then-play sequence prevents race that left media paused
- Fix playlist timestamps: prefer `release_timestamp` over `upload_date`
- Add version endpoint and sidebar version display
