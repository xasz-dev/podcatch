# Changelog

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
