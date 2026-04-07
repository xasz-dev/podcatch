from datetime import datetime
from urllib.parse import parse_qs, urlparse

import feedparser
import yt_dlp

from database import get_db


def detect_feed_type(url: str) -> str:
    if 'youtube.com' in url or 'youtu.be' in url:
        return 'youtube'
    elif 'substack.com' in url:
        return 'substack'
    return 'rss'


def resolve_feed(url: str, feed_type: str) -> tuple[str, str]:
    """Return (canonical_url, display_name) for any feed URL."""
    if feed_type == 'youtube':
        return _resolve_youtube(url)
    return _resolve_rss(url)


def _resolve_youtube(url: str) -> tuple[str, str]:
    opts = {'quiet': True, 'no_warnings': True, 'extract_flat': True, 'playlist_items': '1'}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if not info:
        raise ValueError('Could not extract info from YouTube URL')

    info_id = info.get('id', '')
    channel_id = info.get('channel_id') or info.get('uploader_id', '')
    name = info.get('title') or info.get('channel') or info.get('uploader', 'YouTube Feed')

    # yt-dlp sets id to the playlist ID for playlist URLs, channel ID for channel URLs
    if info_id and info_id != channel_id:
        # It's a playlist
        rss_url = f'https://www.youtube.com/feeds/videos.xml?playlist_id={info_id}'
    elif channel_id:
        rss_url = f'https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}'
    else:
        raise ValueError('Could not resolve YouTube channel or playlist ID')

    return rss_url, name


def _resolve_rss(url: str) -> tuple[str, str]:
    parsed = feedparser.parse(url)
    if not parsed.entries and parsed.bozo:
        raise ValueError(f'Could not parse feed at {url}')
    name = parsed.feed.get('title') or url
    return url, name


def fetch_feed_episodes(feed_id: int, url: str, feed_type: str) -> int:
    """Fetch and save new episodes. Returns count of new episodes saved."""
    if feed_type == 'youtube':
        episodes = _parse_youtube_feed(feed_id, url)
    else:
        episodes = _parse_rss_feed(feed_id, url)

    saved = 0
    with get_db() as db:
        for idx, ep in enumerate(episodes):
            try:
                db.execute(
                    '''INSERT OR IGNORE INTO episodes
                       (feed_id, guid, title, description, page_url, media_url, youtube_id,
                        duration, published_at, thumbnail_url, has_video, created_at)
                       VALUES (:feed_id, :guid, :title, :description, :page_url, :media_url,
                               :youtube_id, :duration, :published_at, :thumbnail_url, :has_video,
                               datetime('now', :offset))''',
                    {**ep, 'offset': f'-{idx} seconds'},
                )
                saved += db.execute('SELECT changes()').fetchone()[0]
                # Backfill published_at on existing rows that were stored without a date
                if ep.get('published_at'):
                    db.execute(
                        '''UPDATE episodes SET published_at = :published_at
                           WHERE feed_id = :feed_id AND guid = :guid''',
                        {'published_at': ep['published_at'], 'feed_id': ep['feed_id'], 'guid': ep['guid']},
                    )
            except Exception as e:
                print(f'Error saving episode: {e}')
        db.execute("UPDATE feeds SET last_checked = datetime('now') WHERE id = ?", (feed_id,))
    return saved


def _parse_rss_feed(feed_id: int, url: str) -> list[dict]:
    parsed = feedparser.parse(url)
    episodes = []
    feed_thumbnail = parsed.feed.get('image', {}).get('href')

    for entry in parsed.entries:
        media_url = None
        has_video = 0
        if entry.get('enclosures'):
            enc = entry.enclosures[0]
            media_url = enc.get('href') or enc.get('url')
            if 'video' in enc.get('type', ''):
                has_video = 1

        thumbnail = None
        if entry.get('image'):
            thumbnail = entry.image.get('href')
        elif feed_thumbnail:
            thumbnail = feed_thumbnail

        episodes.append({
            'feed_id': feed_id,
            'guid': entry.get('id') or entry.get('link') or entry.get('title', ''),
            'title': entry.get('title', 'Untitled'),
            'description': entry.get('summary') or entry.get('description', ''),
            'page_url': entry.get('link'),
            'media_url': media_url,
            'youtube_id': None,
            'duration': _parse_duration(entry.get('itunes_duration')),
            'published_at': _format_date(
                entry.get('published_parsed') or entry.get('updated_parsed')
            ),
            'thumbnail_url': thumbnail,
            'has_video': has_video,
        })
    return episodes


def _parse_youtube_feed(feed_id: int, url: str) -> list[dict]:
    # Custom playlists (PL... IDs) have no RSS feed — fetch via yt-dlp
    qs = parse_qs(urlparse(url).query)
    playlist_id = qs.get('playlist_id', [None])[0]
    if playlist_id and not playlist_id.startswith(('UC', 'UU')):
        return _fetch_playlist_ytdlp(feed_id, playlist_id)

    # Channel or auto-playlist — use RSS
    parsed = feedparser.parse(url)
    episodes = []

    for entry in parsed.entries:
        eid = entry.get('id', '')
        youtube_id = entry.get('yt_videoid') or (eid.split(':')[-1] if ':' in eid else eid)

        thumbnail = None
        if hasattr(entry, 'media_thumbnail') and entry.media_thumbnail:
            thumbnail = entry.media_thumbnail[0].get('url')

        episodes.append({
            'feed_id': feed_id,
            'guid': eid or youtube_id,
            'title': entry.get('title', 'Untitled'),
            'description': entry.get('summary', ''),
            'page_url': entry.get('link'),
            'media_url': None,
            'youtube_id': youtube_id,
            'duration': None,
            'published_at': _format_date(entry.get('published_parsed')),
            'thumbnail_url': thumbnail,
            'has_video': 1,
        })
    return episodes


def _fetch_playlist_ytdlp(feed_id: int, playlist_id: str) -> list[dict]:
    opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'ignoreerrors': True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(
            f'https://www.youtube.com/playlist?list={playlist_id}', download=False
        )

    entries = [e for e in ((info.get('entries') if info else None) or []) if e and e.get('id')]
    episodes = []
    needs_date: list[tuple[int, str]] = []  # (index, youtube_id)

    for idx, entry in enumerate(entries):
        youtube_id = entry['id']

        # Prefer release_timestamp/timestamp (time-accurate) over upload_date
        # (YYYYMMDD only — reflects when the file was uploaded, not when it premiered)
        published_at = None
        ts = entry.get('release_timestamp') or entry.get('timestamp')
        if ts:
            published_at = datetime.utcfromtimestamp(ts).isoformat()
        if not published_at:
            published_at = _parse_upload_date(entry.get('upload_date'))

        if not published_at:
            needs_date.append((idx, youtube_id))

        episodes.append({
            'feed_id': feed_id,
            'guid': f'yt:video:{youtube_id}',
            'title': entry.get('title', 'Untitled'),
            'description': entry.get('description', ''),
            'page_url': f'https://www.youtube.com/watch?v={youtube_id}',
            'media_url': None,
            'youtube_id': youtube_id,
            'duration': entry.get('duration'),
            'published_at': published_at,
            'thumbnail_url': f'https://i.ytimg.com/vi/{youtube_id}/mqdefault.jpg',
            'has_video': 1,
        })

    # Flat mode doesn't always return upload_date for custom playlists.
    # Do individual lookups for episodes that are still missing a date,
    # capped to avoid excessive delays on large initial fetches.
    if needs_date:
        _enrich_playlist_dates(episodes, needs_date[:15])

    return episodes


def _enrich_playlist_dates(episodes: list[dict], missing: list[tuple[int, str]]) -> None:
    """Fetch upload dates for playlist entries that flat-extraction missed."""
    opts = {'quiet': True, 'no_warnings': True, 'ignoreerrors': True, 'skip_download': True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        for idx, youtube_id in missing:
            try:
                info = ydl.extract_info(
                    f'https://www.youtube.com/watch?v={youtube_id}', download=False
                )
                if not info:
                    continue
                ts = info.get('release_timestamp') or info.get('timestamp')
                date = datetime.utcfromtimestamp(ts).isoformat() if ts else None
                if not date:
                    date = _parse_upload_date(info.get('upload_date'))
                if date:
                    episodes[idx]['published_at'] = date
            except Exception:
                pass


def _parse_upload_date(d: str | None) -> str | None:
    """Convert yt-dlp's YYYYMMDD string to ISO format."""
    if not d or len(d) != 8:
        return None
    try:
        return datetime(int(d[:4]), int(d[4:6]), int(d[6:8])).isoformat()
    except ValueError:
        return None


def get_youtube_stream_url(youtube_id: str, prefer_video: bool) -> tuple[str, str]:
    """Return (stream_url, content_type) for a YouTube video ID."""
    if prefer_video:
        fmt = 'best[height<=720][ext=mp4]/best[height<=720]'
        content_type = 'video/mp4'
    else:
        fmt = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio'
        content_type = 'audio/mp4'

    opts = {'quiet': True, 'no_warnings': True, 'format': fmt}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(
            f'https://www.youtube.com/watch?v={youtube_id}', download=False
        )

    url = info.get('url')
    if not url:
        raise ValueError(f'No stream URL found for {youtube_id}')
    return url, content_type


def _parse_duration(s) -> int | None:
    if not s:
        return None
    try:
        parts = str(s).split(':')
        if len(parts) == 1:
            return int(float(parts[0]))
        elif len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        else:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except (ValueError, TypeError):
        return None


def _format_date(ts) -> str | None:
    if not ts:
        return None
    try:
        return datetime(*ts[:6]).isoformat()
    except (TypeError, ValueError):
        return None
