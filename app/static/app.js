// ── Device identity ────────────────────────────────────────────────────────────
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function getDeviceId() {
  let id = localStorage.getItem('podcatch_device_id');
  if (!id) {
    id = generateUUID();
    localStorage.setItem('podcatch_device_id', id);
  }
  return id;
}

function getDeviceName() {
  let name = localStorage.getItem('podcatch_device_name');
  if (!name) {
    const ua = navigator.userAgent;
    name = /android|iphone|ipad|mobile/i.test(ua) ? 'Phone' : 'Desktop';
    localStorage.setItem('podcatch_device_name', name);
  }
  return name;
}

const DEVICE_ID = getDeviceId();
const DEVICE_NAME = getDeviceName();

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  feeds: [],
  episodes: [],
  currentFeedId: 'all',
  sort: 'newest',
  episodeQuery: '',
  playing: null,        // { episode, preferVideo }
  offset: 0,
  hasMore: true,
  loading: false,
  loadSeq: 0,           // incremented on every new load; stale responses are dropped
  activeFeedMenuId: null,
  otherDevices: [],     // [{ id, name }]
  refreshingFeedId: null,
  remote: null,         // { deviceId, deviceName } — non-null when controlling a remote device
  remoteState: {},      // deviceId → { episode_id, episode, position, duration, playing, speed, prefer_video }
};

const PAGE_SIZE = 50;

// ── API helpers ────────────────────────────────────────────────────────────────
let _sessionExpiredShown = false;
let _lastNetworkErrorToast = 0;
const NETWORK_RETRY_DELAYS = [1000, 2000]; // two retries after the initial attempt

function _handleSessionExpired() {
  if (_sessionExpiredShown) return;
  _sessionExpiredShown = true;
  $('dialog-session-expired').showModal();
}

async function api(method, path, body) {
  const opts = { method, headers: {}, redirect: 'manual' };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(path, opts);
      break;
    } catch (_) {
      // Genuine network failure (offline, DNS, connection refused, etc.) —
      // retry a couple times with backoff before surfacing it, since most of
      // these are transient blips rather than a real outage.
      if (attempt < NETWORK_RETRY_DELAYS.length) {
        await new Promise(r => setTimeout(r, NETWORK_RETRY_DELAYS[attempt]));
        continue;
      }
      const now = Date.now();
      if (now - _lastNetworkErrorToast > 30000) {
        _lastNetworkErrorToast = now;
        showToast('Connection lost — retrying in the background.', 'error');
      }
      throw new Error('Network error');
    }
  }
  // An opaque redirect means the auth gate (Pangolin) intercepted the request
  // and redirected to its login page — the session cookie expired.
  if (res.type === 'opaqueredirect') {
    _handleSessionExpired();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

const API = {
  feeds: {
    list: () => api('GET', '/api/feeds'),
    add: (url, preferVideo, customName) => api('POST', '/api/feeds', { url, prefer_video: preferVideo, custom_name: customName || null }),
    update: (id, data) => api('PATCH', `/api/feeds/${id}`, data),
    delete: (id) => api('DELETE', `/api/feeds/${id}`),
    refresh: (id) => api('POST', `/api/feeds/${id}/refresh`),
    markAllRead: (id) => api('POST', `/api/feeds/${id}/mark-all-read`),
  },
  episodes: {
    list: (feedId, offset, sort, q) => {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset, sort });
      if (feedId !== 'all') params.set('feed_id', feedId);
      if (q) params.set('q', q);
      return api('GET', `/api/episodes?${params}`);
    },
    continueListening: () => api('GET', '/api/episodes/continue'),
    get: (id) => api('GET', `/api/episodes/${id}`),
    update: (id, data) => api('PATCH', `/api/episodes/${id}`, data),
  },
  settings: {
    get: () => api('GET', '/api/settings'),
    update: (data) => api('PATCH', '/api/settings', data),
  },
};

// ── Element refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const media = $('media');

// Keeps --player-h in sync with the player's real rendered height (0 when
// hidden, taller on the stacked mobile layout, taller again with video open)
// so the sidebar and episode list reserve exactly enough room to never end
// up hidden behind the fixed player bar.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--player-h', `${Math.round(entry.contentRect.height)}px`);
}).observe($('player'));

// ── Icon helpers ───────────────────────────────────────────────────────────────
const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
const ICON_PAUSE = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
const ICON_LOADING = '<circle cx="6" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18" cy="12" r="1.8"/>';

let _playIconState = 'play'; // 'play' | 'pause' | 'loading' — mirrors what's currently drawn
function setPlayPauseIcon(iconState) {
  _playIconState = iconState;
  $('icon-play-pause').innerHTML = iconState === 'loading' ? ICON_LOADING : iconState === 'pause' ? ICON_PAUSE : ICON_PLAY;
}

function markReadIconSvg(isRead) {
  return isRead
    ? '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8" fill="currentColor" stroke="none"/></svg>';
}

// ── Feed list ──────────────────────────────────────────────────────────────────
async function loadFeeds() {
  state.feeds = await API.feeds.list();
  renderFeeds();
}

function adjustFeedUnread(feedId, delta) {
  const feed = state.feeds.find(f => f.id === feedId);
  if (feed) {
    feed.unread_count = Math.max(0, (feed.unread_count || 0) + delta);
    renderFeeds();
  }
}

function renderFeeds() {
  const list = $('feed-list');
  list.innerHTML = '';

  let totalUnread = 0;
  for (const feed of state.feeds) {
    totalUnread += feed.unread_count || 0;
    const div = document.createElement('div');
    div.className = 'nav-item' + (state.currentFeedId === feed.id ? ' active' : '');
    div.dataset.feedId = feed.id;
    const refreshing = state.refreshingFeedId === feed.id;
    div.innerHTML = `
      ${feedIcon(feed.feed_type, refreshing)}
      <span class="feed-name">${esc(feed.name)}</span>
      <span class="unread-badge">${feed.unread_count || ''}</span>
    `;
    div.addEventListener('click', () => { closeMobileSidebar(); selectFeed(feed.id); });
    div.addEventListener('contextmenu', (e) => showFeedMenu(e, feed));
    list.appendChild(div);
  }

  const allBadge = $('badge-all');
  allBadge.textContent = totalUnread || '';
  document.querySelector('.nav-item[data-feed-id="all"]').className =
    'nav-item' + (state.currentFeedId === 'all' ? ' active' : '');
  document.querySelector('.nav-item[data-feed-id="continue"]').className =
    'nav-item' + (state.currentFeedId === 'continue' ? ' active' : '');
  // Decorative fill on the "All Episodes" ring — scales with how much is unread,
  // capped at 100%; not tied to a precise denominator, just a glanceable signal.
  $('all-reel-icon').style.setProperty('--fill', Math.min(100, totalUnread * 12));
}

function feedIcon(type, spinning) {
  const cls = 'feed-icon' + (spinning ? ' spinning' : '');
  const inner = {
    youtube: '<rect x="2" y="6" width="20" height="12" rx="3"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor" stroke="none"/>',
    substack: '<path d="M4 5h16M4 10h16M4 15l8 6 8-6"/>',
  }[type] || '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/>';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

async function selectFeed(feedId) {
  state.currentFeedId = feedId;
  state.offset = 0;
  state.episodes = [];
  state.hasMore = true;
  renderFeeds();
  renderEpisodes(true); // clear stale content immediately before API responds
  await loadEpisodes(true);
}

// ── Episode list ───────────────────────────────────────────────────────────────
async function loadEpisodes(replace = false) {
  if (state.loading && !replace) return;
  state.loading = true;
  const seq = ++state.loadSeq;
  const isContinue = state.currentFeedId === 'continue';
  $('sort-select').style.visibility = isContinue ? 'hidden' : '';
  $('input-episode-search').style.visibility = isContinue ? 'hidden' : '';
  $('input-episode-search-mobile').style.visibility = isContinue ? 'hidden' : '';
  try {
    const batch = isContinue
      ? await API.episodes.continueListening()
      : await API.episodes.list(state.currentFeedId, state.offset, state.sort, state.episodeQuery);
    if (seq !== state.loadSeq) return; // superseded by a newer load
    if (replace) {
      state.episodes = batch;
    } else {
      state.episodes = state.episodes.concat(batch);
    }
    state.offset = state.episodes.length;
    state.hasMore = isContinue ? false : batch.length === PAGE_SIZE;
    renderEpisodes(replace);

    // Pre-warm stream URLs for the first few YouTube episodes in the batch
    const ytIds = batch
      .filter(ep => ep.youtube_id)
      .slice(0, 5)
      .map(ep => ep.id);
    if (ytIds.length) {
      api('POST', '/api/prewarm', ytIds).catch(() => {});
    }
  } finally {
    if (seq === state.loadSeq) state.loading = false;
  }
}

function updateListHeader() {
  const label = state.currentFeedId === 'continue' ? 'Continue Listening'
    : state.currentFeedId === 'all' ? 'All Episodes'
    : state.feeds.find(f => f.id === state.currentFeedId)?.name || '';
  $('list-title').textContent = label;
  if (state.currentFeedId === 'continue') {
    $('list-sub').textContent = `${state.episodes.length} in progress`;
  } else {
    const unread = state.currentFeedId === 'all'
      ? state.feeds.reduce((s, f) => s + (f.unread_count || 0), 0)
      : (state.feeds.find(f => f.id === state.currentFeedId)?.unread_count || 0);
    $('list-sub').textContent = `${unread} unread`;
  }
}

function renderEpisodes(replace = true) {
  updateListHeader();
  const container = $('episode-items');
  if (replace) container.innerHTML = '';

  const fragment = document.createDocumentFragment();
  const start = replace ? 0 : container.children.length;

  for (let i = start; i < state.episodes.length; i++) {
    fragment.appendChild(buildEpisodeEl(state.episodes[i]));
  }
  container.appendChild(fragment);

  $('btn-load-more').style.display = state.hasMore ? '' : 'none';
  $('load-more-wrap').style.display = state.hasMore ? '' : 'none';
}

// A read/unread change made on another device only broadcasts 'feeds_changed'
// (sidebar counts) — the currently-visible rows stay stale otherwise, which is
// what made episodes not show as played until a hard refresh. Patch read-state
// into whatever's already loaded rather than a full reload, so scroll position
// and pagination survive it.
async function refreshEpisodeReadStates() {
  if (!state.episodes.length) return;
  let fresh;
  try {
    fresh = state.currentFeedId === 'continue'
      ? await API.episodes.continueListening()
      : await API.episodes.list(state.currentFeedId, 0, state.sort, state.episodeQuery);
  } catch (_) { return; }

  const byId = new Map(fresh.map(e => [e.id, e]));
  let changed = false;
  for (const ep of state.episodes) {
    const upd = byId.get(ep.id);
    if (upd && (upd.is_read !== ep.is_read || upd.playback_position !== ep.playback_position)) {
      ep.is_read = upd.is_read;
      ep.playback_position = upd.playback_position;
      changed = true;
    }
  }
  if (changed) renderEpisodes(true);
}

async function prependNewEpisodes() {
  const batch = await API.episodes.list(state.currentFeedId, 0, state.sort);

  if (state.sort !== 'newest') {
    // For non-newest sorts new items don't belong at the top — do a plain reload
    state.episodes = batch;
    state.offset = batch.length;
    state.hasMore = batch.length === PAGE_SIZE;
    renderEpisodes(true);
    return;
  }

  const existingIds = new Set(state.episodes.map(e => e.id));
  const newEps = batch.filter(ep => !existingIds.has(ep.id));
  if (!newEps.length) return;

  state.episodes = [...newEps, ...state.episodes];
  state.offset = state.episodes.length;

  const container = $('episode-items');
  const fragment = document.createDocumentFragment();
  for (const ep of newEps) {
    const el = buildEpisodeEl(ep);
    el.classList.add('episode-slide-in');
    fragment.appendChild(el);
  }
  container.insertBefore(fragment, container.firstChild);
}

function tapeMeter(pct) {
  let cells = '';
  for (let i = 0; i < 10; i++) cells += `<i class="${i < Math.round(pct / 10) ? 'filled' : ''}"></i>`;
  return cells;
}

function buildEpisodeEl(ep) {
  const isPlaying = state.playing && state.playing.episode.id === ep.id;
  const div = document.createElement('div');
  div.className = 'episode-item' +
    (isPlaying ? ' playing' : '') +
    (ep.is_read && !isPlaying ? ' read' : '');
  div.dataset.epId = ep.id;

  const thumb = ep.thumbnail_url
    ? `<img class="ep-thumb" src="${esc(ep.thumbnail_url)}" loading="lazy" alt="">`
    : `<div class="ep-thumb"></div>`;

  // A read episode's progress isn't useful information any more — hide the
  // meter for it the same as "never started", rather than showing whatever
  // position happened to be on record (often a stale full bar).
  const progressPct = (!ep.is_read && ep.duration > 0) ? Math.min(100, (ep.playback_position / ep.duration) * 100) : 0;

  div.innerHTML = `
    ${thumb}
    <div class="ep-body">
      <div class="ep-feed">${esc(ep.feed_name)}</div>
      <div class="ep-title">${esc(ep.title)}</div>
      <div class="ep-meta">
        <span>${relativeDate(ep.published_at)}</span>
        ${ep.duration ? `<span>${formatDuration(ep.duration)}</span>` : ''}
        ${ep.has_video ? '<span>video</span>' : ''}
      </div>
      <div class="ep-progress" data-progress-for="${ep.id}"${progressPct > 0 ? '' : ' style="visibility:hidden"'}>${tapeMeter(progressPct)}</div>
    </div>
    <div class="ep-actions">
      <button class="ep-btn btn-mark-read${ep.is_read ? '' : ' active'}" title="${ep.is_read ? 'Mark unread' : 'Mark played'}">
        ${markReadIconSvg(ep.is_read)}
      </button>
    </div>
  `;

  div.querySelector('.ep-body').addEventListener('click', () => playEpisode(ep, ep.feed_prefer_video));
  div.querySelector('.btn-mark-read')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRead(ep);
  });

  return div;
}

async function toggleRead(ep) {
  const newVal = !ep.is_read;
  const isActivelyPlaying = !!(state.playing && state.playing.episode.id === ep.id);
  // Marking the actively-loaded episode as played doubles as "skip to the
  // end" — handy for jumping past a trailing ad block without losing the
  // played state — so it resets the resume position the same way the old
  // "end & mark played" control did.
  const body = { is_read: newVal };
  if (newVal && isActivelyPlaying) body.playback_position = 0;
  await API.episodes.update(ep.id, body);
  ep.is_read = newVal;
  if (newVal && isActivelyPlaying) ep.playback_position = 0;

  const el = document.querySelector(`[data-ep-id="${ep.id}"]`);
  if (el) {
    el.classList.toggle('read', newVal);
    const btn = el.querySelector('.btn-mark-read');
    if (btn) {
      btn.classList.toggle('active', !newVal);
      btn.title = newVal ? 'Mark unread' : 'Mark played';
      btn.innerHTML = markReadIconSvg(newVal);
    }
    // A read episode's progress is no longer useful info — hide the meter
    // the same way "no progress yet" does, rather than showing a stale or
    // suddenly-empty bar. Unmarking restores whatever position is on record.
    updateRowProgress(ep.id, newVal ? 0 : (ep.duration > 0 ? Math.min(100, (ep.playback_position / ep.duration) * 100) : 0));
  }
  adjustFeedUnread(ep.feed_id, newVal ? -1 : 1);
  loadFeeds();

  if (newVal && isActivelyPlaying) endPlaybackNow();
  updateMarkPlayedButtons();
}

// ── Player ─────────────────────────────────────────────────────────────────────
let positionInterval = null;
// True while a media.src reassignment is in flight (episode switch or error
// recovery). The reassignment fires a synthetic `pause` as a macrotask, whose
// currentTime is meaningless — this suppresses the position save it would do.
let _switchingEpisode = false;
let _pendingSeekListener = null;

// ── Media error recovery ───────────────────────────────────────────────────────
// A retry counts as successful only once playback has advanced RECOVERY_CONFIRM_S
// past the point it resumed from. Clearing the retry guard on the first `playing`
// event instead meant a decode error that killed playback half a second in
// rearmed the retry every time, looping forever on the same frame.
const RECOVERY_CONFIRM_S = 5;
// Seconds to jump past a frame the decoder rejects, widening per attempt. Retrying
// at the same offset just re-reads the same bad frame; stepping over it is what
// actually recovers (it's what skipping forward by hand does).
const RECOVERY_SKIPS = [2, 5, 10];
const RECOVERY_WINDOW_MS = 60000;
const RECOVERY_MAX = 3;

let _recovery = null;     // { resumeFrom, attempt } while a retry is unconfirmed
let _retryTimes = [];     // recent retry timestamps, for the rolling cap
let _lastPlayedTime = 0;  // last position seen by timeupdate; survives a src swap

function resetRecovery() {
  _recovery = null;
  _retryTimes = [];
  _lastPlayedTime = 0;
}

// Rolling cap so a stream that fails in a way skipping can't fix surfaces an
// error instead of retrying forever.
function retryBudgetOk() {
  const now = Date.now();
  _retryTimes = _retryTimes.filter(t => now - t < RECOVERY_WINDOW_MS);
  if (_retryTimes.length >= RECOVERY_MAX) return false;
  _retryTimes.push(now);
  return true;
}

// Reload the stream and resume at `position`. Seeks after metadata rather than
// racing play() against a mid-stream seek.
function loadAndResume(src, position) {
  clearPendingSeek();
  _switchingEpisode = true;
  media.src = src;
  if (position > 5) {
    _pendingSeekListener = () => {
      _pendingSeekListener = null;
      media.currentTime = position;
      media.play().catch(() => {});
    };
    media.addEventListener('loadedmetadata', _pendingSeekListener, { once: true });
  } else {
    media.play().catch(() => {});
  }
}

function clearPendingSeek() {
  if (_pendingSeekListener) {
    media.removeEventListener('loadedmetadata', _pendingSeekListener);
    _pendingSeekListener = null;
  }
}

async function playEpisode(ep, preferVideo, skipFetch = false) {
  if (state.remote) exitRemoteMode();
  resetRecovery();
  clearPendingSeek();

  // Save the outgoing episode's position before state changes. The pause event
  // fired by media.src reassignment runs as a macrotask (after all sync code), so
  // state.playing already points to the new episode by the time it fires — causing
  // the old currentTime to be written to the wrong episode record.
  if (state.playing && media.currentTime > 0) {
    const prev = state.playing.episode;
    prev.playback_position = Math.floor(media.currentTime);
    API.episodes.update(prev.id, { playback_position: prev.playback_position });
  }
  _switchingEpisode = true;
  state.playing = { episode: ep, preferVideo };
  updateMediaSession(ep);

  const src = `/api/stream/${ep.id}${preferVideo ? '?video=true' : '?video=false'}`;

  // Update UI immediately — before any awaits so there's instant feedback
  $('player').classList.remove('hidden');
  setPlayerTitle(ep.title, ep.page_url);
  $('player-feed').textContent = ep.feed_name || '';
  $('player-thumb').src = ep.thumbnail_url || '';
  $('player-thumb').style.display = ep.thumbnail_url ? '' : 'none';
  setPlayPauseIcon('loading');
  setVideoMode(preferVideo && (ep.has_video || ep.youtube_id));
  updateTransferButton();
  updateMarkPlayedButtons();
  document.querySelectorAll('.episode-item').forEach(el => el.classList.remove('playing', 'loading'));
  document.querySelector(`[data-ep-id="${ep.id}"]`)?.classList.add('playing', 'loading');

  // Start stream loading immediately — this kicks off yt-dlp resolution on the server
  // in parallel with the position fetch below, reducing perceived latency.
  media.src = src;

  // Fetch fresh position in parallel with stream resolving
  if (!skipFetch) {
    try {
      const fresh = await API.episodes.get(ep.id);
      ep.playback_position = fresh.playback_position;
    } catch (_) {}
  }

  restoreSpeed();

  const handleAutoplayBlocked = err => {
    if (err.name === 'NotAllowedError') setPlayPauseIcon('play');
  };

  if (ep.playback_position > 5) {
    // Seek to saved position first, then play — avoids a race where play() and
    // a mid-stream seek fire concurrently and leave media paused at the seek point.
    _pendingSeekListener = () => {
      _pendingSeekListener = null;
      media.currentTime = ep.playback_position;
      media.play().catch(handleAutoplayBlocked);
    };
    media.addEventListener('loadedmetadata', _pendingSeekListener, { once: true });
  } else {
    media.play().catch(handleAutoplayBlocked);
  }

  // Position saving — also nudges this episode's row in the list so its
  // progress meter advances live instead of only updating after a reload.
  clearInterval(positionInterval);
  positionInterval = setInterval(() => {
    if (!media.paused && media.currentTime > 0) {
      const pos = Math.floor(media.currentTime);
      API.episodes.update(ep.id, { playback_position: pos });
      ep.playback_position = pos;
      broadcastState();
      if (media.duration) updateRowProgress(ep.id, Math.min(100, (pos / media.duration) * 100));
    }
  }, 10000);
}

function updateRowProgress(epId, pct) {
  const meter = document.querySelector(`[data-progress-for="${epId}"]`);
  if (!meter) return;
  meter.innerHTML = tapeMeter(pct);
  meter.style.visibility = pct > 0 ? '' : 'hidden';
}

// ── Media Session (lock-screen / hardware controls) ─────────────────────────────
function updateMediaSession(ep) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ep.title,
    artist: ep.feed_name || 'podcatch',
    artwork: ep.thumbnail_url ? [{ src: ep.thumbnail_url }] : [],
  });
}

function initMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => media.play(),
    pause: () => media.pause(),
    seekbackward: () => { media.currentTime -= 10; },
    seekforward: () => { media.currentTime += 30; },
    seekto: (details) => { if (details.seekTime != null) media.currentTime = details.seekTime; },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (_) {}
  }
}

function setVideoMode(show) {
  $('player').classList.toggle('show-video', show);
  $('btn-toggle-video').classList.toggle('active', show);
  const hasVideo = !!(state.playing?.episode?.has_video || state.playing?.episode?.youtube_id);
  $('btn-toggle-video').style.display = hasVideo ? '' : 'none';
}

// ── Video resize handle ────────────────────────────────────────────────────────
const VIDEO_H_KEY = 'podcatch_video_h';
const VIDEO_H_MIN = 80;

function getVideoHeight() {
  const saved = parseInt(localStorage.getItem(VIDEO_H_KEY), 10);
  return saved > VIDEO_H_MIN ? saved : 240;
}

function applyVideoHeight(h) {
  $('player').style.setProperty('--video-h', h + 'px');
}

applyVideoHeight(getVideoHeight());

(function initResizeHandle() {
  const handle = $('player-resize-handle');
  let startY = 0;
  let startH = 0;

  function onMove(clientY) {
    const delta = startY - clientY; // drag up = positive delta = taller
    const maxH = window.innerHeight - 48 - 80; // header + player bar
    const newH = Math.min(Math.max(startH + delta, VIDEO_H_MIN), maxH);
    applyVideoHeight(newH);
  }

  function onEnd(clientY) {
    const delta = startY - clientY;
    const maxH = window.innerHeight - 48 - 80;
    const newH = Math.min(Math.max(startH + delta, VIDEO_H_MIN), maxH);
    applyVideoHeight(newH);
    localStorage.setItem(VIDEO_H_KEY, newH);
    $('player').classList.remove('resizing');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
  }

  function onMouseMove(e) { onMove(e.clientY); }
  function onMouseUp(e) { onEnd(e.clientY); }
  function onTouchMove(e) { e.preventDefault(); onMove(e.touches[0].clientY); }
  function onTouchEnd(e) { onEnd(e.changedTouches[0].clientY); }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = getVideoHeight();
    $('player').classList.add('resizing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  handle.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startY = e.touches[0].clientY;
    startH = getVideoHeight();
    $('player').classList.add('resizing');
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }, { passive: false });
})();

// Player event listeners
media.addEventListener('click', () => { media.paused ? media.play() : media.pause(); });
media.addEventListener('play', () => { setPlayPauseIcon('loading'); });
media.addEventListener('playing', () => {
  setPlayPauseIcon('pause');
  _switchingEpisode = false;
  document.querySelectorAll('.episode-item.loading').forEach(el => el.classList.remove('loading'));
  broadcastState();
});
media.addEventListener('waiting', () => { setPlayPauseIcon('loading'); });
media.addEventListener('error', async () => {
  const err = media.error;
  console.warn(`podcatch: media error ${err?.code}`, err?.message || '');
  setPlayPauseIcon('play');
  document.querySelectorAll('.episode-item.loading').forEach(el => el.classList.remove('loading'));
  if (!state.playing) return;

  const ep = state.playing.episode;
  const pv = state.playing.preferVideo;
  // The stream bytes are intact but one frame won't decode — typically the splice
  // where a podcast host stitched in an ad. Refetching lands on the same frame, so
  // step over it instead, and leave the server's cached copy alone (no_cache would
  // delete a perfectly good download and force a full re-fetch).
  const decodeError = err?.code === (window.MediaError?.MEDIA_ERR_DECODE ?? 3);
  const failedAt = _lastPlayedTime || ep.playback_position || 0;
  const knownDuration = media.duration || ep.duration || 0;

  if (retryBudgetOk()) {
    const attempt = _recovery ? _recovery.attempt + 1 : 0;
    const skip = decodeError ? RECOVERY_SKIPS[Math.min(attempt, RECOVERY_SKIPS.length - 1)] : 0;
    const resumeFrom = failedAt + skip;

    // Skipping past the end isn't recovery — treat it as reaching the end instead.
    if (!(knownDuration && resumeFrom >= knownDuration - 1)) {
      _recovery = { resumeFrom, attempt };
      ep.playback_position = Math.floor(resumeFrom);
      setPlayPauseIcon('loading');
      // Bypass the server's cached copy only when the source itself looks wrong
      // (a stale YouTube stream URL, or an RSS media_url changed by a refresh).
      const bust = decodeError ? '' : '&no_cache=1';
      loadAndResume(`/api/stream/${ep.id}?video=${pv}${bust}`, resumeFrom);
      return;
    }
  }
  // Out of retries, or the failure is past the end of the episode. Give up, and
  // release the src-swap flag so a later pause saves position normally again.
  _recovery = null;
  _switchingEpisode = false;

  let msg = `Couldn't load "${ep.title}"`;
  try {
    const resp = await fetch(`/api/stream/${ep.id}?video=${pv}`, { redirect: 'manual' });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      if (body?.detail) msg = body.detail;
    }
  } catch (_) {}
  showToast(msg, 'error');
});
media.addEventListener('pause', () => {
  // Don't overwrite the loading indicator if we're switching tracks
  if (_playIconState !== 'loading') setPlayPauseIcon('play');
  // Skip the save while a src swap is in flight. On a track switch the outgoing
  // position was already saved in playEpisode; on an error retry currentTime is
  // still the offset that just failed, and writing it back is what pinned the
  // saved position to the bad frame and kept the retry looping on it.
  if (!_switchingEpisode && state.playing && media.currentTime > 0) {
    const pos = Math.floor(media.currentTime);
    API.episodes.update(state.playing.episode.id, { playback_position: pos });
    state.playing.episode.playback_position = pos;
  }
  broadcastState();
});
media.addEventListener('timeupdate', () => {
  _lastPlayedTime = media.currentTime;
  // Only sustained progress past the resume point counts as a recovered stream —
  // half a second of playback before the same frame fails again does not.
  if (_recovery && media.currentTime >= _recovery.resumeFrom + RECOVERY_CONFIRM_S) {
    _recovery = null;
    _retryTimes = [];
  }
  if (!media.duration) return;
  const pct = (media.currentTime / media.duration) * 100;
  $('seek-bar').value = pct;
  $('time-current').textContent = formatDuration(Math.floor(media.currentTime));
  $('time-total').textContent = formatDuration(Math.floor(media.duration));
});
media.addEventListener('ended', () => {
  setPlayPauseIcon('play');
  if (state.playing) {
    const ep = state.playing.episode;
    API.episodes.update(ep.id, { is_read: true, playback_position: 0 });
    if (!ep.is_read) adjustFeedUnread(ep.feed_id, -1);
    ep.is_read = true;
    ep.playback_position = 0;
    const el = document.querySelector(`[data-ep-id="${ep.id}"]`);
    if (el) {
      el.classList.add('read');
      const markBtn = el.querySelector('.btn-mark-read');
      if (markBtn) {
        markBtn.classList.remove('active');
        markBtn.title = 'Mark unread';
        markBtn.innerHTML = markReadIconSvg(true);
      }
      updateRowProgress(ep.id, 0);
    }
  }
  clearInterval(positionInterval);
  state.playing = null;
  $('player').classList.add('hidden');
  setVideoMode(false);
  document.querySelectorAll('.episode-item').forEach(el => el.classList.remove('playing', 'loading'));
  broadcastState();
  prependNewEpisodes();
});

$('btn-play-pause').addEventListener('click', () => {
  if (state.remote) {
    const rs = state.remoteState[state.remote.deviceId];
    api('POST', '/api/remote', { to_device_id: state.remote.deviceId, command: 'play_pause', from_device_id: DEVICE_ID }).catch(() => {});
    // Optimistic update
    if (rs) {
      rs.playing = !rs.playing;
      setPlayPauseIcon(rs.playing ? 'pause' : 'play');
      rs.playing ? startRemoteTicker() : stopRemoteTicker();
    }
    return;
  }
  media.paused ? media.play() : media.pause();
});
$('btn-seek-back10').addEventListener('click', () => {
  if (state.remote) {
    sendRemoteSeek(-10);
    return;
  }
  media.currentTime -= 10;
});
$('btn-seek-back').addEventListener('click', () => {
  if (state.remote) {
    sendRemoteSeek(-30);
    return;
  }
  media.currentTime -= 30;
});
$('btn-seek-fwd').addEventListener('click', () => {
  if (state.remote) {
    sendRemoteSeek(30);
    return;
  }
  media.currentTime += 30;
});
// ── Mark played (player) ─────────────────────────────────────────────────────
// A single toggle, mirrored on desktop (inline with the progress bar) and on
// mobile (in the transport row) — clicking either marks the actively-loaded
// episode played/unplayed via toggleRead(), which also ends playback now when
// marking (not unmarking) the episode that's currently loaded.
function endPlaybackNow() {
  // Mirrors the media 'ended' handler: marking the loaded episode played is
  // meant to behave exactly like actually reaching the end, so state.playing
  // has to be cleared here too — leaving it set was what caused the row to
  // stay un-dimmed and, on the next SSE-triggered refresh, its progress meter
  // to disappear instead of updating (both read off the stale isPlaying flag).
  _switchingEpisode = true; // suppress the pause handler's own position autosave
  media.pause();
  clearInterval(positionInterval);
  state.playing = null;
  $('player').classList.add('hidden');
  setVideoMode(false);
  document.querySelectorAll('.episode-item').forEach(el => el.classList.remove('playing', 'loading'));
  broadcastState();
  prependNewEpisodes();
  setTimeout(() => { _switchingEpisode = false; }, 50);
}

function updateMarkPlayedButtons() {
  const ep = state.playing?.episode;
  for (const id of ['btn-mark-played', 'btn-mark-played-mobile']) {
    const btn = $(id);
    if (!ep) { btn.classList.remove('active'); continue; }
    btn.classList.toggle('active', !ep.is_read);
    btn.title = ep.is_read ? 'Mark unplayed' : 'Mark played';
    btn.innerHTML = markReadIconSvg(ep.is_read);
  }
}

function markPlayedClick() {
  if (!state.playing || state.remote) return;
  toggleRead(state.playing.episode);
}
$('btn-mark-played').addEventListener('click', markPlayedClick);
$('btn-mark-played-mobile').addEventListener('click', markPlayedClick);
$('seek-bar').addEventListener('input', (e) => {
  if (state.remote) {
    const rs = state.remoteState[state.remote.deviceId];
    if (!rs?.duration) return;
    const pos = (e.target.value / 100) * rs.duration;
    api('POST', '/api/remote', { to_device_id: state.remote.deviceId, command: 'seek_absolute', position: pos, from_device_id: DEVICE_ID }).catch(() => {});
    rs.position = pos;
    $('time-current').textContent = formatDuration(Math.floor(pos));
    return;
  }
  media.currentTime = (e.target.value / 100) * (media.duration || 0);
});
$('btn-toggle-video').addEventListener('click', () => {
  if (!state.playing) return;
  const newPref = !state.playing.preferVideo;
  playEpisode(state.playing.episode, newPref);
});

$('btn-add-feed').addEventListener('click', () => {
  // Reset to search tab
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('hidden', i !== 0));
  $('input-search-query').value = '';
  $('search-results').innerHTML = '';
  $('search-options').classList.add('hidden');
  $('input-feed-url').value = '';
  $('input-feed-name').value = '';
  $('input-prefer-video').checked = false;
  $('input-mark-read').checked = false;
  $('add-feed-error').classList.add('hidden');
  $('btn-submit-feed').disabled = false;
  dialog.showModal();
});
$('btn-cancel-feed').addEventListener('click', () => dialog.close());

$('form-add-feed').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('input-feed-url').value.trim();
  const customName = $('input-feed-name').value.trim();
  const preferVideo = $('input-prefer-video').checked;
  const btn = $('btn-submit-feed');
  const errEl = $('add-feed-error');

  btn.disabled = true;
  btn.textContent = 'Adding…';
  errEl.classList.add('hidden');

  try {
    const feed = await API.feeds.add(url, preferVideo, customName);
    if ($('input-mark-read').checked) {
      await API.feeds.markAllRead(feed.id);
    }
    dialog.close();
    await loadFeeds();
    await selectFeed('all');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

// ── Feed context menu ──────────────────────────────────────────────────────────
const feedMenu = $('feed-menu');

function showFeedMenu(e, feed) {
  e.preventDefault();
  state.activeFeedMenuId = feed.id;
  feedMenu.style.left = e.clientX + 'px';
  feedMenu.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
  feedMenu.classList.remove('hidden');
}

feedMenu.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  const id = state.activeFeedMenuId;
  feedMenu.classList.add('hidden');
  if (!action || !id) return;

  if (action === 'rename') {
    const feed = state.feeds.find(f => f.id === id);
    if (!feed) return;
    openRenameDialog(feed);
  } else if (action === 'mark-all-read') {
    await API.feeds.markAllRead(id);
    await loadFeeds();
    await loadEpisodes(true);
  } else if (action === 'refresh') {
    state.refreshingFeedId = id;
    renderFeeds();
    try {
      await API.feeds.refresh(id);
    } finally {
      state.refreshingFeedId = null;
    }
    await loadFeeds();
    if (state.currentFeedId === id || state.currentFeedId === 'all') {
      await selectFeed(state.currentFeedId);
    }
  } else if (action === 'toggle-video') {
    const feed = state.feeds.find(f => f.id === id);
    if (feed) {
      await API.feeds.update(id, { prefer_video: !feed.prefer_video });
      await loadFeeds();
    }
  } else if (action === 'toggle-auto-download') {
    const feed = state.feeds.find(f => f.id === id);
    if (feed) {
      const newVal = !feed.auto_download;
      await API.feeds.update(id, { auto_download: newVal });
      showToast(`Auto-download ${newVal ? 'enabled' : 'disabled'} for ${feed.name}`, 'info');
      await loadFeeds();
    }
  } else if (action === 'delete') {
    if (!confirm('Remove this feed and all its episodes?')) return;
    await API.feeds.delete(id);
    if (state.currentFeedId === id) state.currentFeedId = 'all';
    await loadFeeds();
    await selectFeed(state.currentFeedId);
  }
});

document.addEventListener('click', (e) => {
  if (!feedMenu.contains(e.target)) feedMenu.classList.add('hidden');
});

// ── Refresh all ────────────────────────────────────────────────────────────────
$('btn-refresh-all').addEventListener('click', async () => {
  const btn = $('btn-refresh-all');
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    const results = await Promise.allSettled(state.feeds.map(f => API.feeds.refresh(f.id)));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) showToast(`${failed} feed${failed > 1 ? 's' : ''} failed to refresh`, 'error');
    await loadFeeds();
    await loadEpisodes(true);
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
});

// ── Sort ───────────────────────────────────────────────────────────────────────
$('sort-select').addEventListener('change', (e) => {
  state.sort = e.target.value;
  state.offset = 0;
  state.episodes = [];
  loadEpisodes(true);
});

// ── Episode search (header box on desktop, sidebar drawer on mobile) ────────────
let _episodeSearchDebounce = null;
function onEpisodeSearchInput(e) {
  clearTimeout(_episodeSearchDebounce);
  const value = e.target.value.trim();
  // Keep both boxes in sync so switching layout mid-search doesn't lose it
  $('input-episode-search').value = e.target.value;
  $('input-episode-search-mobile').value = e.target.value;
  _episodeSearchDebounce = setTimeout(() => {
    state.episodeQuery = value;
    state.offset = 0;
    state.episodes = [];
    loadEpisodes(true);
  }, 300);
}
$('input-episode-search').addEventListener('input', onEpisodeSearchInput);
$('input-episode-search-mobile').addEventListener('input', onEpisodeSearchInput);

// ── Load more ──────────────────────────────────────────────────────────────────
$('btn-load-more').addEventListener('click', () => loadEpisodes(false));

// ── "All Episodes" nav item ────────────────────────────────────────────────────
document.querySelector('.nav-item[data-feed-id="all"]').addEventListener('click', () => {
  closeMobileSidebar();
  selectFeed('all');
});

// ── "Continue Listening" nav item ──────────────────────────────────────────────
document.querySelector('.nav-item[data-feed-id="continue"]').addEventListener('click', () => {
  closeMobileSidebar();
  selectFeed('continue');
});

// ── Utilities ──────────────────────────────────────────────────────────────────
function setPlayerTitle(title, pageUrl) {
  const el = $('player-title');
  // Only render as a link for http(s) URLs — feed-supplied links are untrusted,
  // and esc() alone doesn't stop a javascript: URI from executing on click.
  if (pageUrl && /^https?:\/\//i.test(pageUrl)) {
    el.innerHTML = `<a href="${esc(pageUrl)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>`;
  } else {
    el.textContent = title;
  }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function relativeDate(iso) {
  if (!iso) return '';
  // Stored timestamps are UTC; append Z if no timezone suffix so JS doesn't treat as local time
  const str = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const ms = new Date(str).getTime();
  if (isNaN(ms)) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(str).toLocaleDateString();
}

// ── Toast notifications ────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const text = document.createElement('span');
  text.textContent = msg;
  toast.appendChild(text);

  const close = document.createElement('button');
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(toast));
  toast.appendChild(close);

  container.appendChild(toast);
  setTimeout(() => dismissToast(toast), 6000);
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-out');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

// ── Playback speed ─────────────────────────────────────────────────────────────
const speedPopup = $('speed-popup');
const speedBtn = $('btn-speed');

// Build preset list: 0.5 to 3.0 in 0.05 steps
const SPEED_PRESETS = [];
for (let s = 0.5; s <= 3.005; s += 0.05) {
  SPEED_PRESETS.push(Math.round(s * 100) / 100);
}

function buildSpeedPopup(currentSpeed) {
  speedPopup.innerHTML = '';
  for (const s of SPEED_PRESETS) {
    const btn = document.createElement('button');
    btn.textContent = s === 1 ? '1×' : `${s}×`;
    if (s === currentSpeed) btn.classList.add('active');
    btn.addEventListener('click', () => setSpeed(s));
    speedPopup.appendChild(btn);
  }
  // Custom entry row
  const row = document.createElement('div');
  row.className = 'speed-custom';
  row.innerHTML = `<input type="number" id="input-custom-speed" min="0.1" max="5" step="0.05" placeholder="custom">
                   <button id="btn-custom-speed-set">Set</button>`;
  speedPopup.appendChild(row);
  row.querySelector('#btn-custom-speed-set').addEventListener('click', () => {
    const val = parseFloat(row.querySelector('#input-custom-speed').value);
    if (val >= 0.1 && val <= 5) setSpeed(Math.round(val * 100) / 100);
  });
  row.querySelector('#input-custom-speed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = parseFloat(e.target.value);
      if (val >= 0.1 && val <= 5) setSpeed(Math.round(val * 100) / 100);
    }
  });
}

function setSpeed(s) {
  if (state.remote) {
    api('POST', '/api/remote', { to_device_id: state.remote.deviceId, command: 'set_speed', speed: s, from_device_id: DEVICE_ID }).catch(() => {});
    speedPopup.classList.add('hidden');
    speedBtn.textContent = s === 1 ? '1×' : `${s}×`;
    const rs = state.remoteState[state.remote.deviceId];
    if (rs) rs.speed = s;
    return;
  }
  media.playbackRate = s;
  speedBtn.textContent = s === 1 ? '1×' : `${s}×`;
  speedPopup.classList.add('hidden');
  localStorage.setItem('podcatch_speed', s);
  broadcastState();
}

speedBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const currentSpeed = state.remote
    ? (state.remoteState[state.remote.deviceId]?.speed || 1)
    : (media.playbackRate || 1);
  buildSpeedPopup(currentSpeed);
  speedPopup.classList.toggle('hidden');
  // Scroll active preset into view
  requestAnimationFrame(() => {
    speedPopup.querySelector('.active')?.scrollIntoView({ block: 'center' });
  });
});

document.addEventListener('click', (e) => {
  if (!speedPopup.contains(e.target) && e.target !== speedBtn) {
    speedPopup.classList.add('hidden');
  }
});

// Restore saved speed on play
function restoreSpeed() {
  const saved = parseFloat(localStorage.getItem('podcatch_speed') || '1');
  if (saved !== 1) {
    media.playbackRate = saved;
    speedBtn.textContent = `${saved}×`;
  }
}

// ── Add feed dialog ────────────────────────────────────────────────────────────
const dialog = $('dialog-add-feed');
let _selectedSearchResult = null;


// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// Search
async function runSearch() {
  const q = $('input-search-query').value.trim();
  if (!q) return;
  const resultsEl = $('search-results');
  resultsEl.innerHTML = '<div class="search-msg">Searching…</div>';
  $('search-options').classList.add('hidden');
  _selectedSearchResult = null;

  try {
    const results = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    if (!results.length) {
      resultsEl.innerHTML = '<div class="search-msg">No results found.</div>';
      return;
    }
    resultsEl.innerHTML = '';
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.innerHTML = `
        <img src="${esc(r.artwork)}" alt="" loading="lazy">
        <div class="search-result-body">
          <div class="search-result-name">${esc(r.name)}</div>
          <div class="search-result-meta">${esc(r.author)}${r.genre ? ` · ${esc(r.genre)}` : ''}</div>
        </div>
      `;
      div.addEventListener('click', () => selectSearchResult(r));
      resultsEl.appendChild(div);
    }
  } catch (e) {
    resultsEl.innerHTML = `<div class="search-msg" style="color:var(--danger)">${esc(e.message)}</div>`;
  }
}

function selectSearchResult(r) {
  _selectedSearchResult = r;
  $('search-results').innerHTML = '';
  $('search-custom-name').value = '';
  $('search-prefer-video').checked = false;
  $('search-mark-read').checked = false;
  $('search-add-error').classList.add('hidden');
  $('search-selected-info').innerHTML = `
    <img src="${esc(r.artwork)}" alt="">
    <span id="search-selected-name">${esc(r.name)}</span>
  `;
  $('search-options').classList.remove('hidden');
}

$('input-search-query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
});
$('btn-do-search').addEventListener('click', runSearch);
$('btn-search-back').addEventListener('click', () => {
  $('search-options').classList.add('hidden');
  _selectedSearchResult = null;
});

$('btn-search-add').addEventListener('click', async () => {
  if (!_selectedSearchResult) return;
  const btn = $('btn-search-add');
  const errEl = $('search-add-error');
  const customName = $('search-custom-name').value.trim();
  const preferVideo = $('search-prefer-video').checked;
  const markRead = $('search-mark-read').checked;

  btn.disabled = true;
  btn.textContent = 'Adding…';
  errEl.classList.add('hidden');

  try {
    const feed = await API.feeds.add(_selectedSearchResult.feed_url, preferVideo, customName);
    if (markRead) await API.feeds.markAllRead(feed.id);
    dialog.close();
    await loadFeeds();
    await selectFeed('all');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

// ── Rename dialog ──────────────────────────────────────────────────────────────
const renameDialog = $('dialog-rename-feed');

function openRenameDialog(feed) {
  $('input-rename-value').value = feed.name;
  renameDialog._feedId = feed.id;
  renameDialog.showModal();
}

$('btn-cancel-rename').addEventListener('click', () => renameDialog.close());

$('form-rename-feed').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('input-rename-value').value.trim();
  const id = renameDialog._feedId;
  if (!name || !id) return;
  await API.feeds.update(id, { name });
  renameDialog.close();
  await loadFeeds();
});

// ── Settings dialog ────────────────────────────────────────────────────────────
const settingsDialog = $('dialog-settings');

$('btn-settings').addEventListener('click', async () => {
  $('settings-error').classList.add('hidden');
  try {
    const settings = await API.settings.get();
    $('input-cleanup-days').value = settings.cleanup_days;
    settingsDialog.showModal();
  } catch (e) {
    showToast(e.message, 'error');
  }
});

$('btn-cancel-settings').addEventListener('click', () => settingsDialog.close());

$('btn-save-settings').addEventListener('click', async () => {
  const errEl = $('settings-error');
  errEl.classList.add('hidden');
  const days = parseInt($('input-cleanup-days').value, 10);
  if (!days || days < 1) {
    errEl.textContent = 'Enter a number of days (1 or more).';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    await API.settings.update({ cleanup_days: days });
    settingsDialog.close();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

// ── Session expired recovery ────────────────────────────────────────────────────
const sessionExpiredDialog = $('dialog-session-expired');

$('btn-session-login').addEventListener('click', () => {
  window.open(window.location.href, '_blank');
});

$('btn-session-retry').addEventListener('click', async () => {
  $('session-retry-error').classList.add('hidden');
  try {
    await api('GET', '/api/version');
    sessionExpiredDialog.close();
    _sessionExpiredShown = false;
    connectSSE();
    await loadFeeds();
    await loadEpisodes(true);
  } catch (_) {
    $('session-retry-error').classList.remove('hidden');
  }
});

// ── Mobile sidebar toggle ───────────────────────────────────────────────────────
$('btn-menu-toggle').addEventListener('click', () => {
  $('sidebar').classList.toggle('mobile-open');
  $('sidebar-scrim').classList.toggle('open');
});
$('sidebar-scrim').addEventListener('click', closeMobileSidebar);

function closeMobileSidebar() {
  $('sidebar').classList.remove('mobile-open');
  $('sidebar-scrim').classList.remove('open');
}

// ── SSE / device presence ──────────────────────────────────────────────────────
let _sseGen = 0;
let _sseSource = null;

function connectSSE(failCount = 0) {
  const gen = ++_sseGen;
  if (_sseSource) { _sseSource.close(); _sseSource = null; }

  const url = `/api/events?device_id=${encodeURIComponent(DEVICE_ID)}&name=${encodeURIComponent(DEVICE_NAME)}`;
  const es = new EventSource(url);
  _sseSource = es;

  es.onmessage = async (e) => {
    if (gen !== _sseGen) return;
    failCount = 0;
    let event;
    try { event = JSON.parse(e.data); } catch (_) { return; }

    if (event.type === 'connected' || event.type === 'devices_changed') {
      const devices = await api('GET', '/api/devices');
      state.otherDevices = devices.filter(d => d.id !== DEVICE_ID);
      // Drop remoteState for devices that are no longer connected, so a stale
      // "playing" doesn't linger in the ambient indicator after they vanish.
      const onlineIds = new Set(state.otherDevices.map(d => d.id));
      for (const did of Object.keys(state.remoteState)) {
        if (!onlineIds.has(did)) delete state.remoteState[did];
      }
      // If the device we're controlling just disconnected, exit remote mode
      if (state.remote && !state.otherDevices.find(d => d.id === state.remote.deviceId)) {
        const remoteName = state.remote.deviceName;
        exitRemoteMode();
        showToast(`${remoteName} disconnected`, 'info');
      }
      updateTransferButton();
    }

    if (event.type === 'feeds_changed') {
      await loadFeeds();
      await refreshEpisodeReadStates();
    }

    if (event.type === 'new_episodes') {
      await loadFeeds();
      await prependNewEpisodes();
    }

    if (event.type === 'handoff') {
      // Another device is handing playback to us
      const ep = await API.episodes.get(event.episode_id);
      ep.playback_position = event.position;
      await playEpisode(ep, event.prefer_video, /* skipFetch */ true);
    }

    if (event.type === 'remote_command') {
      // We are being controlled by another device
      if (event.command === 'play_pause') {
        media.paused ? media.play() : media.pause();
      } else if (event.command === 'seek_relative' && event.delta != null) {
        media.currentTime = Math.max(0, media.currentTime + event.delta);
      } else if (event.command === 'seek_absolute' && event.position != null) {
        media.currentTime = event.position;
      } else if (event.command === 'set_speed' && event.speed != null) {
        setSpeed(event.speed);
      } else if (event.command === 'request_state') {
        broadcastState();
      } else if (event.command === 'reclaim' && event.from_device_id && state.playing) {
        const pos = Math.floor(media.currentTime);
        await API.episodes.update(state.playing.episode.id, { playback_position: pos });
        await api('POST', '/api/handoff', {
          to_device_id: event.from_device_id,
          episode_id: state.playing.episode.id,
          position: pos,
          prefer_video: state.playing.preferVideo,
        });
        media.pause();
      }
    }

    if (event.type === 'player_state') {
      // Track state broadcast from another device
      const existing = state.remoteState[event.device_id] || {};
      const episodeChanged = event.episode_id !== existing.episode_id;
      state.remoteState[event.device_id] = {
        ...existing,
        episode_id: event.episode_id,
        position: event.position,
        duration: event.duration,
        playing: event.playing,
        speed: event.speed,
        prefer_video: event.prefer_video,
        deviceName: event.device_name,
        episode: episodeChanged ? null : existing.episode,
      };
      updateTransferButton();
      if (episodeChanged && event.episode_id) {
        API.episodes.get(event.episode_id).then(ep => {
          if (state.remoteState[event.device_id]) {
            state.remoteState[event.device_id].episode = ep;
            if (state.remote?.deviceId === event.device_id) updateRemotePlayerUI(state.remoteState[event.device_id]);
          }
        }).catch(() => {});
      }
      if (state.remote?.deviceId === event.device_id) {
        updateRemotePlayerUI(state.remoteState[event.device_id]);
        // Sync the ticker to the authoritative playing state
        event.playing ? startRemoteTicker() : stopRemoteTicker();
      }
    }
  };

  es.onerror = () => {
    if (gen !== _sseGen) return;
    es.close();
    _sseSource = null;
    failCount++;
    if (failCount === 6) {
      showToast('Connection lost — will keep retrying in the background.', 'error');
    }
    const delay = Math.min(5000 * Math.pow(2, Math.min(failCount - 1, 6)), 60000);
    setTimeout(() => { if (gen === _sseGen) connectSSE(failCount); }, delay);
  };
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!_sseSource || _sseSource.readyState === EventSource.CLOSED)) {
    connectSSE();
  }
});
window.addEventListener('online', () => connectSSE());

function updateTransferButton() {
  const anyoneElsePlaying = Object.values(state.remoteState).some(rs => rs.playing);
  $('btn-transfer').classList.toggle('has-active-playback', anyoneElsePlaying);
}

const devicePopup = $('device-popup');

$('btn-transfer').addEventListener('click', () => {
  devicePopup.innerHTML = '';

  if (state.remote) {
    // In remote mode — show exit/reclaim options
    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'Exit remote';
    exitBtn.addEventListener('click', exitRemoteMode);
    devicePopup.appendChild(exitBtn);

    const reclaimBtn = document.createElement('button');
    reclaimBtn.textContent = `Reclaim from ${esc(state.remote.deviceName)}`;
    reclaimBtn.addEventListener('click', () => reclaimFromRemote(state.remote.deviceId));
    devicePopup.appendChild(reclaimBtn);
  } else if (state.otherDevices.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'popup-msg';
    msg.textContent = 'No other devices online';
    devicePopup.appendChild(msg);
  } else {
    for (const dev of state.otherDevices) {
      if (state.playing) {
        const sendBtn = document.createElement('button');
        sendBtn.textContent = `Send to ${esc(dev.name)}`;
        sendBtn.addEventListener('click', () => transferTo(dev.id));
        devicePopup.appendChild(sendBtn);
      }

      const remoteBtn = document.createElement('button');
      remoteBtn.textContent = `Remote ${esc(dev.name)}`;
      remoteBtn.addEventListener('click', () => enterRemoteMode(dev.id, dev.name));
      devicePopup.appendChild(remoteBtn);
    }
  }

  devicePopup.classList.toggle('hidden');
  // Position below the header button
  requestAnimationFrame(() => {
    const rect = $('btn-transfer').getBoundingClientRect();
    const popW = devicePopup.offsetWidth;
    const top = rect.bottom + 8;
    const left = Math.min(rect.left, window.innerWidth - popW - 8);
    devicePopup.style.top = Math.max(8, top) + 'px';
    devicePopup.style.left = Math.max(8, left) + 'px';
  });
});

document.addEventListener('click', (e) => {
  if (!devicePopup.contains(e.target) && e.target !== $('btn-transfer')) {
    devicePopup.classList.add('hidden');
  }
});

async function transferTo(targetDeviceId) {
  devicePopup.classList.add('hidden');
  if (!state.playing) return;

  // Save current position before handing off
  const pos = Math.floor(media.currentTime);
  await API.episodes.update(state.playing.episode.id, { playback_position: pos });

  await api('POST', '/api/handoff', {
    to_device_id: targetDeviceId,
    episode_id: state.playing.episode.id,
    position: pos,
    prefer_video: state.playing.preferVideo,
  });

  // Pause locally
  media.pause();
}

// ── Remote control ─────────────────────────────────────────────────────────────

let _broadcastThrottle = null;
function broadcastState() {
  if (!state.otherDevices.length || state.remote) return;
  clearTimeout(_broadcastThrottle);
  _broadcastThrottle = setTimeout(() => {
    api('POST', '/api/state', {
      from_device_id: DEVICE_ID,
      episode_id: state.playing?.episode?.id ?? null,
      position: media.currentTime || 0,
      duration: isFinite(media.duration) ? media.duration : 0,
      playing: !media.paused,
      speed: media.playbackRate || 1,
      prefer_video: state.playing?.preferVideo ?? false,
    }).catch(() => {});
  }, 200);
}

let _remotePositionTicker = null;
function startRemoteTicker() {
  stopRemoteTicker();
  _remotePositionTicker = setInterval(() => {
    if (!state.remote) return;
    const rs = state.remoteState[state.remote.deviceId];
    if (!rs?.playing) return;
    rs.position = (rs.position || 0) + 1;
    if (rs.duration) $('seek-bar').value = (rs.position / rs.duration) * 100;
    $('time-current').textContent = formatDuration(Math.floor(rs.position));
  }, 1000);
}

function stopRemoteTicker() {
  clearInterval(_remotePositionTicker);
  _remotePositionTicker = null;
}

function updateRemotePlayerUI(rs) {
  if (!state.remote) return;
  setPlayerTitle(rs.episode?.title || `Playing on ${state.remote.deviceName}`, rs.episode?.page_url);
  $('player-feed').textContent = rs.episode?.feed_name || '';
  $('player-thumb').src = rs.episode?.thumbnail_url || '';
  $('player-thumb').style.display = rs.episode?.thumbnail_url ? '' : 'none';
  setPlayPauseIcon(rs.playing ? 'pause' : 'play');
  const spd = rs.speed || 1;
  speedBtn.textContent = spd === 1 ? '1×' : `${spd}×`;
  if (rs.duration && rs.position !== undefined) {
    $('seek-bar').value = (rs.position / rs.duration) * 100;
    $('time-current').textContent = formatDuration(Math.floor(rs.position));
    $('time-total').textContent = formatDuration(Math.floor(rs.duration));
  }
}

async function enterRemoteMode(deviceId, deviceName) {
  devicePopup.classList.add('hidden');
  if (!media.paused) media.pause();
  state.remote = { deviceId, deviceName };
  $('player').classList.remove('hidden');
  $('player').classList.add('remote-mode');
  $('remote-indicator').textContent = `Remote: ${deviceName}`;
  updateTransferButton();
  updateMarkPlayedButtons();

  // Show what we already know while waiting for the state refresh
  const rs = state.remoteState[deviceId];
  if (rs) {
    updateRemotePlayerUI(rs);
    if (rs.playing) startRemoteTicker();
  } else {
    setPlayerTitle(`Connecting to ${deviceName}…`, null);
    $('player-feed').textContent = '';
    setPlayPauseIcon('loading');
  }

  // Ask the remote device to push its current state immediately
  api('POST', '/api/remote', { to_device_id: deviceId, command: 'request_state', from_device_id: DEVICE_ID }).catch(() => {});
}

function exitRemoteMode() {
  devicePopup.classList.add('hidden');
  stopRemoteTicker();
  state.remote = null;
  $('player').classList.remove('remote-mode');
  $('remote-indicator').textContent = '';

  if (state.playing) {
    $('player').classList.remove('hidden');
    setPlayerTitle(state.playing.episode.title, state.playing.episode.page_url);
    $('player-feed').textContent = state.playing.episode.feed_name || '';
    $('player-thumb').src = state.playing.episode.thumbnail_url || '';
    $('player-thumb').style.display = state.playing.episode.thumbnail_url ? '' : 'none';
    setPlayPauseIcon(media.paused ? 'play' : 'pause');
    const spd = media.playbackRate || 1;
    speedBtn.textContent = spd === 1 ? '1×' : `${spd}×`;
    if (isFinite(media.duration) && media.duration) {
      $('seek-bar').value = (media.currentTime / media.duration) * 100;
      $('time-current').textContent = formatDuration(Math.floor(media.currentTime));
      $('time-total').textContent = formatDuration(Math.floor(media.duration));
    }
  } else {
    $('player').classList.add('hidden');
  }
  updateTransferButton();
  updateMarkPlayedButtons();
}

async function reclaimFromRemote(deviceId) {
  devicePopup.classList.add('hidden');
  // Tell the remote device to hand off back to us; exitRemoteMode clears state
  // so that the incoming handoff SSE event plays cleanly via playEpisode.
  exitRemoteMode();
  await api('POST', '/api/remote', {
    to_device_id: deviceId,
    command: 'reclaim',
    from_device_id: DEVICE_ID,
  }).catch(() => {});
}

function sendRemoteSeek(delta) {
  const rs = state.remoteState[state.remote.deviceId];
  api('POST', '/api/remote', { to_device_id: state.remote.deviceId, command: 'seek_relative', delta, from_device_id: DEVICE_ID }).catch(() => {});
  if (rs) {
    rs.position = Math.max(0, Math.min(rs.duration || Infinity, (rs.position || 0) + delta));
    updateRemotePlayerUI(rs);
  }
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (!state.playing) return;
  if (e.target.closest('input, textarea, select, dialog')) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (state.remote) {
      $('btn-play-pause').click();
    } else {
      media.paused ? media.play() : media.pause();
    }
  } else if (e.code === 'ArrowLeft') {
    if (state.remote) {
      sendRemoteSeek(-10);
    } else {
      media.currentTime -= 10;
    }
  } else if (e.code === 'ArrowRight') {
    if (state.remote) {
      sendRemoteSeek(30);
    } else {
      media.currentTime += 30;
    }
  }
});

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  initMediaSessionHandlers();
  connectSSE();
  await loadFeeds();
  await loadEpisodes(true);
  api('GET', '/api/version').then(v => {
    $('sidebar-version').textContent = `v${v.version}`;
  }).catch(() => {});
})();
