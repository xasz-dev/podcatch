import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get('DB_PATH', '/data/podcatch.db')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    feed_type TEXT NOT NULL,
    prefer_video INTEGER NOT NULL DEFAULT 0,
    check_interval INTEGER NOT NULL DEFAULT 3600,
    last_checked TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    page_url TEXT,
    media_url TEXT,
    youtube_id TEXT,
    duration INTEGER,
    published_at TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    playback_position INTEGER NOT NULL DEFAULT 0,
    thumbnail_url TEXT,
    has_video INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(feed_id, guid)
);
'''


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_db() as db:
        db.executescript(SCHEMA)
        # Clear bad fallback dates written by earlier versions
        db.execute(
            "UPDATE episodes SET published_at = NULL WHERE published_at = '2000-01-01T00:00:00'"
        )


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
