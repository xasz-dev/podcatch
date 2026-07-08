import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Callable, Awaitable, Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from database import get_db, get_setting
from feeds import fetch_feed_episodes

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()
_broadcast_fn: Callable[[dict], Awaitable[Any]] | None = None
_download_fn: Callable[[int], None] | None = None

# Downloaded files older than this are cleared regardless of read status, so a
# half-listened episode you never finish or mark read doesn't sit forever.
MAX_DOWNLOAD_AGE_DAYS = 30


def start_scheduler(broadcast_fn: Callable[[dict], Awaitable[Any]], download_fn: Callable[[int], None]):
    global _broadcast_fn, _download_fn
    _broadcast_fn = broadcast_fn
    _download_fn = download_fn
    scheduler.add_job(poll_due_feeds, 'interval', minutes=15, id='poll_feeds')
    scheduler.add_job(cleanup_downloads, 'interval', hours=24, id='cleanup_downloads')
    scheduler.start()


async def poll_due_feeds():
    with get_db() as db:
        feeds = db.execute(
            'SELECT id, url, feed_type, check_interval, last_checked, auto_download FROM feeds'
        ).fetchall()

    now = datetime.now(timezone.utc)
    for feed in feeds:
        last_str = feed['last_checked']
        if last_str:
            try:
                last = datetime.fromisoformat(last_str).replace(tzinfo=timezone.utc)
            except ValueError:
                last = datetime.min.replace(tzinfo=timezone.utc)
        else:
            last = datetime.min.replace(tzinfo=timezone.utc)

        if (now - last).total_seconds() >= feed['check_interval']:
            try:
                loop = asyncio.get_running_loop()
                count, new_ids = await loop.run_in_executor(
                    None, fetch_feed_episodes, feed['id'], feed['url'], feed['feed_type']
                )
                if count > 0 and _broadcast_fn:
                    await _broadcast_fn({'type': 'new_episodes'})
                if feed['auto_download'] and _download_fn:
                    for eid in new_ids:
                        _download_fn(eid)
            except Exception as e:
                logger.warning(f'Feed {feed["id"]} refresh error: {e}')


async def cleanup_downloads():
    """Remove locally cached media for episodes that have aged out, per the
    cleanup_days setting, plus an unconditional safety-net max age."""
    with get_db() as db:
        cleanup_days = int(get_setting(db, 'cleanup_days'))
        rows = db.execute(
            '''SELECT id, downloaded_path FROM episodes
               WHERE downloaded_path IS NOT NULL
                 AND (
                   (is_read = 1 AND read_at IS NOT NULL AND read_at <= datetime('now', ?))
                   OR (downloaded_at IS NOT NULL AND downloaded_at <= datetime('now', ?))
                 )''',
            (f'-{cleanup_days} days', f'-{MAX_DOWNLOAD_AGE_DAYS} days'),
        ).fetchall()

    if not rows:
        return

    for row in rows:
        path = row['downloaded_path']
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except OSError as e:
            logger.warning(f'Cleanup: could not remove {path}: {e}')

    with get_db() as db:
        db.executemany(
            'UPDATE episodes SET downloaded_path = NULL, downloaded_at = NULL WHERE id = ?',
            [(row['id'],) for row in rows],
        )
    logger.info(f'Cleanup: removed {len(rows)} downloaded episode file(s)')
