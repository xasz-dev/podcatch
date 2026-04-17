# Changelog

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
