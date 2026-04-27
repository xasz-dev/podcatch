import asyncio
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import get_db, init_db
from feeds import detect_feed_type, fetch_feed_episodes, get_youtube_stream_url, resolve_feed
from scheduler import start_scheduler

__version__ = '0.2.2'

# In-memory device registry: device_id -> {'name': str, 'queue': asyncio.Queue}
_devices: dict[str, dict] = {}

# Stream URL cache: (youtube_id, prefer_video) -> (url, content_type, expires_at)
_stream_cache: dict[tuple, tuple] = {}
_CACHE_TTL = 4 * 3600  # 4 hours


def _get_cached_stream(youtube_id: str, prefer_video: bool) -> tuple[str, str] | None:
    entry = _stream_cache.get((youtube_id, prefer_video))
    if entry and time.monotonic() < entry[2]:
        return entry[0], entry[1]
    return None


def _set_cached_stream(youtube_id: str, prefer_video: bool, url: str, content_type: str):
    _stream_cache[(youtube_id, prefer_video)] = (url, content_type, time.monotonic() + _CACHE_TTL)
    # Purge all expired entries on every write to keep memory bounded
    now = time.monotonic()
    expired = [k for k, v in _stream_cache.items() if v[2] < now]
    for k in expired:
        del _stream_cache[k]


async def _push(device_id: str, event: dict):
    if device_id in _devices:
        await _devices[device_id]['queue'].put(event)


async def _broadcast(event: dict, exclude: str | None = None):
    for did in list(_devices):
        if did != exclude:
            await _push(did, event)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    start_scheduler(_broadcast)
    yield


app = FastAPI(lifespan=lifespan)


# ── Pydantic models ────────────────────────────────────────────────────────────

class AddFeedRequest(BaseModel):
    url: str
    prefer_video: bool = False
    custom_name: Optional[str] = None


class UpdateFeedRequest(BaseModel):
    name: Optional[str] = None
    prefer_video: Optional[bool] = None
    check_interval: Optional[int] = None


class UpdateEpisodeRequest(BaseModel):
    is_read: Optional[bool] = None
    playback_position: Optional[int] = None


# ── Feed endpoints ─────────────────────────────────────────────────────────────

@app.get('/api/feeds')
def list_feeds():
    with get_db() as db:
        rows = db.execute(
            '''SELECT f.*, COUNT(e.id) as episode_count,
                      SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) as unread_count
               FROM feeds f LEFT JOIN episodes e ON e.feed_id = f.id
               GROUP BY f.id ORDER BY f.name'''
        ).fetchall()
    return [dict(r) for r in rows]


@app.post('/api/feeds', status_code=201)
async def add_feed(req: AddFeedRequest):
    feed_type = detect_feed_type(req.url)
    loop = asyncio.get_running_loop()
    try:
        canonical_url, name = await loop.run_in_executor(None, resolve_feed, req.url, feed_type)
    except Exception as e:
        raise HTTPException(400, str(e))

    display_name = req.custom_name.strip() if req.custom_name and req.custom_name.strip() else name
    with get_db() as db:
        try:
            db.execute(
                'INSERT INTO feeds (name, url, feed_type, prefer_video) VALUES (?, ?, ?, ?)',
                (display_name, canonical_url, feed_type, 1 if req.prefer_video else 0),
            )
            feed_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
        except sqlite3.IntegrityError:
            raise HTTPException(409, 'Feed already exists')

    try:
        await loop.run_in_executor(None, fetch_feed_episodes, feed_id, canonical_url, feed_type)
    except Exception as e:
        print(f'Initial fetch error for feed {feed_id}: {e}')

    with get_db() as db:
        feed = db.execute('SELECT * FROM feeds WHERE id = ?', (feed_id,)).fetchone()
    return dict(feed)


@app.patch('/api/feeds/{feed_id}')
def update_feed(feed_id: int, req: UpdateFeedRequest):
    with get_db() as db:
        if req.name is not None and req.name.strip():
            db.execute('UPDATE feeds SET name = ? WHERE id = ?', (req.name.strip(), feed_id))
        if req.prefer_video is not None:
            db.execute(
                'UPDATE feeds SET prefer_video = ? WHERE id = ?',
                (1 if req.prefer_video else 0, feed_id),
            )
        if req.check_interval is not None:
            if not (60 <= req.check_interval <= 86400):
                raise HTTPException(400, 'check_interval must be between 60 and 86400 seconds')
            db.execute(
                'UPDATE feeds SET check_interval = ? WHERE id = ?',
                (req.check_interval, feed_id),
            )
        feed = db.execute('SELECT * FROM feeds WHERE id = ?', (feed_id,)).fetchone()
    if not feed:
        raise HTTPException(404)
    return dict(feed)


@app.delete('/api/feeds/{feed_id}', status_code=204)
def delete_feed(feed_id: int):
    with get_db() as db:
        db.execute('DELETE FROM feeds WHERE id = ?', (feed_id,))


@app.post('/api/feeds/{feed_id}/mark-all-read', status_code=204)
async def mark_all_read(feed_id: int):
    with get_db() as db:
        db.execute('UPDATE episodes SET is_read = 1 WHERE feed_id = ?', (feed_id,))
    await _broadcast({'type': 'feeds_changed'})


@app.post('/api/feeds/{feed_id}/refresh')
async def refresh_feed(feed_id: int):
    with get_db() as db:
        feed = db.execute('SELECT * FROM feeds WHERE id = ?', (feed_id,)).fetchone()
    if not feed:
        raise HTTPException(404)
    try:
        loop = asyncio.get_running_loop()
        count = await loop.run_in_executor(
            None, fetch_feed_episodes, feed['id'], feed['url'], feed['feed_type']
        )
    except Exception as e:
        raise HTTPException(500, str(e))
    if count > 0:
        await _broadcast({'type': 'new_episodes'})
    return {'new_episodes': count}


# ── Episode endpoints ──────────────────────────────────────────────────────────

@app.get('/api/episodes')
def list_episodes(
    feed_id: Optional[int] = None,
    unread: bool = False,
    sort: str = 'newest',
    limit: int = 50,
    offset: int = 0,
):
    sort_clause = {
        'newest': 'e.published_at DESC NULLS LAST, e.created_at DESC',
        'oldest': 'e.published_at ASC NULLS LAST, e.created_at ASC',
        'unread':  'e.is_read ASC, e.published_at DESC NULLS LAST',
    }.get(sort, 'e.published_at DESC NULLS LAST, e.created_at DESC')

    query = '''SELECT e.*, f.name as feed_name, f.prefer_video as feed_prefer_video
               FROM episodes e JOIN feeds f ON e.feed_id = f.id'''
    params: list = []
    conditions: list[str] = []

    if feed_id is not None:
        conditions.append('e.feed_id = ?')
        params.append(feed_id)
    if unread:
        conditions.append('e.is_read = 0')
    if conditions:
        query += ' WHERE ' + ' AND '.join(conditions)
    query += f' ORDER BY {sort_clause} LIMIT ? OFFSET ?'
    params.extend([limit, offset])

    with get_db() as db:
        rows = db.execute(query, params).fetchall()
    return [dict(r) for r in rows]


@app.get('/api/episodes/{episode_id}')
def get_episode(episode_id: int):
    with get_db() as db:
        ep = db.execute(
            '''SELECT e.*, f.name as feed_name, f.prefer_video as feed_prefer_video
               FROM episodes e JOIN feeds f ON e.feed_id = f.id
               WHERE e.id = ?''',
            (episode_id,),
        ).fetchone()
    if not ep:
        raise HTTPException(404)
    return dict(ep)


@app.patch('/api/episodes/{episode_id}')
async def update_episode(episode_id: int, req: UpdateEpisodeRequest):
    with get_db() as db:
        if req.is_read is not None:
            db.execute(
                'UPDATE episodes SET is_read = ? WHERE id = ?',
                (1 if req.is_read else 0, episode_id),
            )
        if req.playback_position is not None:
            db.execute(
                'UPDATE episodes SET playback_position = ? WHERE id = ?',
                (req.playback_position, episode_id),
            )
        ep = db.execute('SELECT * FROM episodes WHERE id = ?', (episode_id,)).fetchone()
    if not ep:
        raise HTTPException(404)
    # Only broadcast when read state changes — position saves are too frequent
    if req.is_read is not None:
        await _broadcast({'type': 'feeds_changed'})
    return dict(ep)


# ── Device presence & handoff ─────────────────────────────────────────────────

@app.get('/api/events')
async def sse_stream(device_id: str, name: str):
    queue: asyncio.Queue = asyncio.Queue()
    _devices[device_id] = {'name': name, 'queue': queue}

    async def generate():
        try:
            yield f"data: {json.dumps({'type': 'connected'})}\n\n"
            await _broadcast({'type': 'devices_changed'}, exclude=device_id)
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=25)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
        finally:
            _devices.pop(device_id, None)
            await _broadcast({'type': 'devices_changed'}, exclude=device_id)

    return StreamingResponse(
        generate(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@app.get('/api/devices')
def list_devices():
    return [{'id': did, 'name': dev['name']} for did, dev in _devices.items()]


@app.get('/api/version')
def get_version():
    return {'version': __version__}


class HandoffRequest(BaseModel):
    to_device_id: str
    episode_id: int
    position: int
    prefer_video: bool


@app.post('/api/handoff')
async def handoff(req: HandoffRequest):
    if req.to_device_id not in _devices:
        raise HTTPException(404, 'Target device not connected')
    await _push(req.to_device_id, {
        'type': 'handoff',
        'episode_id': req.episode_id,
        'position': req.position,
        'prefer_video': req.prefer_video,
    })
    return {'ok': True}


class RemoteCommandRequest(BaseModel):
    to_device_id: str
    command: str  # 'play_pause' | 'seek_relative' | 'seek_absolute' | 'set_speed' | 'request_state' | 'reclaim'
    delta: Optional[float] = None
    speed: Optional[float] = None
    position: Optional[float] = None
    from_device_id: Optional[str] = None


@app.post('/api/remote')
async def send_remote_command(req: RemoteCommandRequest):
    if req.to_device_id not in _devices:
        raise HTTPException(404, 'Target device not connected')
    await _push(req.to_device_id, {
        'type': 'remote_command',
        'command': req.command,
        'delta': req.delta,
        'speed': req.speed,
        'position': req.position,
        'from_device_id': req.from_device_id,
    })
    return {'ok': True}


class PlayerStateRequest(BaseModel):
    from_device_id: str
    episode_id: Optional[int] = None
    position: float = 0
    duration: float = 0
    playing: bool = False
    speed: float = 1.0
    prefer_video: bool = False


@app.post('/api/state')
async def broadcast_player_state(req: PlayerStateRequest):
    device_name = _devices.get(req.from_device_id, {}).get('name', '')
    await _broadcast({
        'type': 'player_state',
        'device_id': req.from_device_id,
        'device_name': device_name,
        'episode_id': req.episode_id,
        'position': req.position,
        'duration': req.duration,
        'playing': req.playing,
        'speed': req.speed,
        'prefer_video': req.prefer_video,
    }, exclude=req.from_device_id)
    return {'ok': True}


# ── Streaming ──────────────────────────────────────────────────────────────────

@app.get('/api/stream/{episode_id}')
async def stream_episode(episode_id: int, request: Request, video: Optional[bool] = None, no_cache: bool = False):
    with get_db() as db:
        ep = db.execute(
            '''SELECT e.*, f.prefer_video as feed_prefer_video
               FROM episodes e JOIN feeds f ON e.feed_id = f.id
               WHERE e.id = ?''',
            (episode_id,),
        ).fetchone()

    if not ep:
        raise HTTPException(404)

    prefer_video = video if video is not None else bool(ep['feed_prefer_video'])

    # RSS/Substack: redirect directly to the CDN URL
    if ep['media_url'] and not ep['youtube_id']:
        return RedirectResponse(ep['media_url'])

    if not ep['youtube_id']:
        raise HTTPException(404, 'No media available for this episode')

    # YouTube: resolve stream URL and proxy (required for range-request seeking)
    # no_cache=True forces re-resolution (used by client on retry after stream failure)
    cached = None if no_cache else _get_cached_stream(ep['youtube_id'], prefer_video)
    if cached:
        stream_url, content_type = cached
    else:
        try:
            stream_url, content_type = await asyncio.get_running_loop().run_in_executor(
                None, get_youtube_stream_url, ep['youtube_id'], prefer_video
            )
            _set_cached_stream(ep['youtube_id'], prefer_video, stream_url, content_type)
        except Exception as e:
            raise HTTPException(500, f'Could not get stream URL: {e}')

    range_header = request.headers.get('range')
    upstream_headers: dict[str, str] = {'User-Agent': 'Mozilla/5.0'}
    if range_header:
        upstream_headers['Range'] = range_header

    client = httpx.AsyncClient(follow_redirects=True, timeout=None)
    try:
        upstream = await client.send(
            httpx.Request('GET', stream_url, headers=upstream_headers),
            stream=True,
        )
    except Exception:
        await client.aclose()
        raise HTTPException(502, 'Could not reach upstream stream')

    resp_headers: dict[str, str] = {
        'Content-Type': upstream.headers.get('content-type', content_type),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
    }
    for h in ('content-length', 'content-range'):
        if h in upstream.headers:
            resp_headers[h] = upstream.headers[h]

    async def generate():
        try:
            async for chunk in upstream.aiter_bytes(65536):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        generate(),
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=content_type,
    )


# ── Podcast search ────────────────────────────────────────────────────────────

@app.get('/api/search')
async def search_podcasts(q: str, limit: int = 12):
    if not q.strip():
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                'https://itunes.apple.com/search',
                params={'term': q, 'media': 'podcast', 'limit': limit, 'entity': 'podcast'},
            )
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f'Search service error: {e.response.status_code}')
    except httpx.RequestError:
        raise HTTPException(502, 'Search service unreachable')
    results = resp.json().get('results', [])
    return [
        {
            'name': r.get('collectionName', ''),
            'author': r.get('artistName', ''),
            'feed_url': r.get('feedUrl', ''),
            'artwork': r.get('artworkUrl100', ''),
            'genre': r.get('primaryGenreName', ''),
        }
        for r in results
        if r.get('feedUrl')
    ]


# ── Stream URL pre-warming ─────────────────────────────────────────────────────

@app.post('/api/prewarm')
async def prewarm(episode_ids: list[int]):
    """Background-resolve stream URLs for a list of episode IDs."""
    async def warm_one(episode_id: int):
        with get_db() as db:
            ep = db.execute(
                'SELECT e.youtube_id, f.prefer_video FROM episodes e JOIN feeds f ON e.feed_id = f.id WHERE e.id = ?',
                (episode_id,),
            ).fetchone()
        if not ep or not ep['youtube_id']:
            return
        prefer_video = bool(ep['prefer_video'])
        if _get_cached_stream(ep['youtube_id'], prefer_video):
            return
        try:
            url, ct = await asyncio.get_running_loop().run_in_executor(
                None, get_youtube_stream_url, ep['youtube_id'], prefer_video
            )
            _set_cached_stream(ep['youtube_id'], prefer_video, url, ct)
        except Exception as e:
            print(f'Prewarm failed for episode {episode_id}: {e}')

    asyncio.create_task(asyncio.gather(
        *[warm_one(eid) for eid in episode_ids[:5]],
        return_exceptions=True,
    ))
    return {'ok': True}


# ── Static files (must be last) ────────────────────────────────────────────────

app.mount('/', StaticFiles(directory='static', html=True), name='static')
