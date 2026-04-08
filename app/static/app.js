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
  playing: null,        // { episode, preferVideo }
  offset: 0,
  hasMore: true,
  loading: false,
  loadSeq: 0,           // incremented on every new load; stale responses are dropped
  activeFeedMenuId: null,
  otherDevices: [],     // [{ id, name }]
  refreshingFeedId: null,
};

const PAGE_SIZE = 50;

// ── API helpers ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
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
    list: (feedId, offset, sort) => {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset, sort });
      if (feedId !== 'all') params.set('feed_id', feedId);
      return api('GET', `/api/episodes?${params}`);
    },
    get: (id) => api('GET', `/api/episodes/${id}`),
    update: (id, data) => api('PATCH', `/api/episodes/${id}`, data),
  },
};

// ── Element refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const media = $('media');

// ── Feed list ──────────────────────────────────────────────────────────────────
async function loadFeeds() {
  state.feeds = await API.feeds.list();
  renderFeeds();
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
      <span class="feed-icon${refreshing ? ' spinning' : ''}">${feedIcon(feed.feed_type)}</span>
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
}

function feedIcon(type) {
  return type === 'youtube' ? '▶' : type === 'substack' ? 'S' : '◎';
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
  try {
    const batch = await API.episodes.list(state.currentFeedId, state.offset, state.sort);
    if (seq !== state.loadSeq) return; // superseded by a newer load
    if (replace) {
      state.episodes = batch;
    } else {
      state.episodes = state.episodes.concat(batch);
    }
    state.offset = state.episodes.length;
    state.hasMore = batch.length === PAGE_SIZE;
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

function renderEpisodes(replace = true) {
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
    </div>
    <div class="ep-actions">
      <button class="small-btn btn-play-audio" title="Play audio">♫</button>
      ${ep.has_video || ep.youtube_id
        ? `<button class="small-btn btn-play-video" title="Play video">▶</button>`
        : ''}
      <button class="small-btn btn-mark-read" title="${ep.is_read ? 'Mark unread' : 'Mark read'}">
        ${ep.is_read ? '○' : '●'}
      </button>
    </div>
  `;

  div.querySelector('.ep-body').addEventListener('click', () => playEpisode(ep, ep.feed_prefer_video));
  div.querySelector('.btn-play-audio')?.addEventListener('click', (e) => {
    e.stopPropagation();
    playEpisode(ep, false);
  });
  div.querySelector('.btn-play-video')?.addEventListener('click', (e) => {
    e.stopPropagation();
    playEpisode(ep, true);
  });
  div.querySelector('.btn-mark-read')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRead(ep);
  });

  return div;
}

async function toggleRead(ep) {
  const newVal = !ep.is_read;
  await API.episodes.update(ep.id, { is_read: newVal });
  ep.is_read = newVal;
  const el = document.querySelector(`[data-ep-id="${ep.id}"]`);
  if (el) {
    el.classList.toggle('read', newVal);
    el.querySelector('.btn-mark-read').textContent = newVal ? '○' : '●';
  }
  loadFeeds(); // refresh unread counts
}

// ── Player ─────────────────────────────────────────────────────────────────────
let positionInterval = null;

async function playEpisode(ep, preferVideo, skipFetch = false) {
  // Fetch fresh position from DB in case another device has been playing
  if (!skipFetch) {
    try {
      const fresh = await API.episodes.get(ep.id);
      ep.playback_position = fresh.playback_position;
    } catch (_) {}
  }

  state.playing = { episode: ep, preferVideo };

  const src = `/api/stream/${ep.id}${preferVideo ? '?video=true' : '?video=false'}`;
  media.src = src;

  if (ep.playback_position > 5) {
    // Seek to saved position first, then play — avoids a race where play() and
    // a mid-stream seek fire concurrently and leave media paused at the seek point.
    media.addEventListener('loadedmetadata', () => {
      media.currentTime = ep.playback_position;
      media.play().catch(() => {});
    }, { once: true });
  } else {
    media.play().catch(() => {});
  }
  restoreSpeed();

  // Update UI
  $('player').classList.remove('hidden');
  $('player-title').textContent = ep.title;
  $('player-thumb').src = ep.thumbnail_url || '';
  $('player-thumb').style.display = ep.thumbnail_url ? '' : 'none';

  setVideoMode(preferVideo && (ep.has_video || ep.youtube_id));

  updateTransferButton();

  // Highlight in list
  document.querySelectorAll('.episode-item').forEach(el => el.classList.remove('playing'));
  document.querySelector(`[data-ep-id="${ep.id}"]`)?.classList.add('playing');

  // Position saving
  clearInterval(positionInterval);
  positionInterval = setInterval(() => {
    if (!media.paused && media.currentTime > 0) {
      API.episodes.update(ep.id, { playback_position: Math.floor(media.currentTime) });
      ep.playback_position = Math.floor(media.currentTime);
    }
  }, 10000);
}

function setVideoMode(show) {
  $('player').classList.toggle('show-video', show);
  $('btn-toggle-video').classList.toggle('active', show);
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
media.addEventListener('play', () => { $('btn-play-pause').textContent = '⏸'; });
media.addEventListener('pause', () => {
  $('btn-play-pause').textContent = '▶';
  if (state.playing && media.currentTime > 0) {
    const pos = Math.floor(media.currentTime);
    API.episodes.update(state.playing.episode.id, { playback_position: pos });
    state.playing.episode.playback_position = pos;
  }
});
media.addEventListener('timeupdate', () => {
  if (!media.duration) return;
  const pct = (media.currentTime / media.duration) * 100;
  $('seek-bar').value = pct;
  $('time-current').textContent = formatDuration(Math.floor(media.currentTime));
  $('time-total').textContent = formatDuration(Math.floor(media.duration));
});
media.addEventListener('ended', () => {
  $('btn-play-pause').textContent = '▶';
  if (state.playing) {
    const ep = state.playing.episode;
    API.episodes.update(ep.id, { is_read: true, playback_position: 0 });
    ep.is_read = true;
    const el = document.querySelector(`[data-ep-id="${ep.id}"]`);
    if (el) el.classList.add('read');
  }
});

$('btn-play-pause').addEventListener('click', () => {
  media.paused ? media.play() : media.pause();
});
$('btn-seek-back10').addEventListener('click', () => { media.currentTime -= 10; });
$('btn-seek-back').addEventListener('click', () => { media.currentTime -= 30; });
$('btn-seek-fwd').addEventListener('click', () => { media.currentTime += 30; });
$('btn-end-played').addEventListener('click', () => {
  if (!state.playing) return;
  const ep = state.playing.episode;
  media.pause();
  API.episodes.update(ep.id, { is_read: true, playback_position: 0 });
  ep.is_read = true;
  const el = document.querySelector(`[data-ep-id="${ep.id}"]`);
  if (el) {
    el.classList.add('read');
    const markBtn = el.querySelector('.btn-mark-read');
    if (markBtn) { markBtn.title = 'Mark unread'; markBtn.textContent = '○'; }
  }
  loadFeeds();
});
$('seek-bar').addEventListener('input', (e) => {
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
    await Promise.all(state.feeds.map(f => API.feeds.refresh(f.id)));
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

// ── Load more ──────────────────────────────────────────────────────────────────
$('btn-load-more').addEventListener('click', () => loadEpisodes(false));

// ── "All Episodes" nav item ────────────────────────────────────────────────────
document.querySelector('.nav-item[data-feed-id="all"]').addEventListener('click', () => {
  closeMobileSidebar();
  selectFeed('all');
});

// ── Utilities ──────────────────────────────────────────────────────────────────
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
  media.playbackRate = s;
  speedBtn.textContent = s === 1 ? '1×' : `${s}×`;
  speedPopup.classList.add('hidden');
  localStorage.setItem('podcatch_speed', s);
}

speedBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  buildSpeedPopup(media.playbackRate || 1);
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

// ── Mobile sidebar toggle ───────────────────────────────────────────────────────
$('btn-menu-toggle').addEventListener('click', () => {
  $('sidebar').classList.toggle('mobile-open');
});

function closeMobileSidebar() {
  $('sidebar').classList.remove('mobile-open');
}

// ── SSE / device presence ──────────────────────────────────────────────────────
function connectSSE() {
  const url = `/api/events?device_id=${encodeURIComponent(DEVICE_ID)}&name=${encodeURIComponent(DEVICE_NAME)}`;
  const es = new EventSource(url);

  es.onmessage = async (e) => {
    const event = JSON.parse(e.data);

    if (event.type === 'connected' || event.type === 'devices_changed') {
      const devices = await api('GET', '/api/devices');
      state.otherDevices = devices.filter(d => d.id !== DEVICE_ID);
      updateTransferButton();
    }

    if (event.type === 'feeds_changed') {
      await loadFeeds();
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
  };

  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 5000); // reconnect after 5s
  };
}

function updateTransferButton() {
  const btn = $('btn-transfer');
  btn.style.display = state.otherDevices.length > 0 && state.playing ? '' : 'none';
}

const devicePopup = $('device-popup');

$('btn-transfer').addEventListener('click', () => {
  if (!state.playing) return;
  devicePopup.innerHTML = '';
  for (const dev of state.otherDevices) {
    const btn = document.createElement('button');
    btn.textContent = `Send to ${esc(dev.name)}`;
    btn.addEventListener('click', () => transferTo(dev.id));
    devicePopup.appendChild(btn);
  }
  devicePopup.classList.toggle('hidden');
  // Position after paint so offsetWidth/Height are known
  requestAnimationFrame(() => {
    const rect = $('btn-transfer').getBoundingClientRect();
    const popW = devicePopup.offsetWidth;
    const popH = devicePopup.offsetHeight;
    const top = rect.top - popH - 8;
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

// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  connectSSE();
  await loadFeeds();
  await loadEpisodes(true);
  api('GET', '/api/version').then(v => {
    $('sidebar-version').textContent = `v${v.version}`;
  }).catch(() => {});
})();
