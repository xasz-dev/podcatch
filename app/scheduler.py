import asyncio
from datetime import datetime, timezone
from typing import Callable, Awaitable, Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from database import get_db
from feeds import fetch_feed_episodes

scheduler = AsyncIOScheduler()
_broadcast_fn: Callable[[dict], Awaitable[Any]] | None = None


def start_scheduler(broadcast_fn: Callable[[dict], Awaitable[Any]]):
    global _broadcast_fn
    _broadcast_fn = broadcast_fn
    scheduler.add_job(poll_due_feeds, 'interval', minutes=15, id='poll_feeds')
    scheduler.start()


async def poll_due_feeds():
    with get_db() as db:
        feeds = db.execute(
            'SELECT id, url, feed_type, check_interval, last_checked FROM feeds'
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
                count = await loop.run_in_executor(
                    None, fetch_feed_episodes, feed['id'], feed['url'], feed['feed_type']
                )
                if count > 0 and _broadcast_fn:
                    await _broadcast_fn({'type': 'new_episodes'})
            except Exception as e:
                print(f'Feed {feed["id"]} refresh error: {e}')
