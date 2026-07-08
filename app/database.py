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
    auto_download INTEGER NOT NULL DEFAULT 0,
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
    read_at TEXT,
    playback_position INTEGER NOT NULL DEFAULT 0,
    last_played_at TEXT,
    thumbnail_url TEXT,
    has_video INTEGER NOT NULL DEFAULT 0,
    downloaded_path TEXT,
    downloaded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(feed_id, guid)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
'''


DEFAULT_SETTINGS = {
    'cleanup_days': '7',
}


def _ensure_column(db, table, column, coldef):
    cols = [row[1] for row in db.execute(f'PRAGMA table_info({table})').fetchall()]
    if column not in cols:
        db.execute(f'ALTER TABLE {table} ADD COLUMN {column} {coldef}')


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_db() as db:
        db.executescript(SCHEMA)
        # Clear bad fallback dates written by earlier versions
        db.execute(
            "UPDATE episodes SET published_at = NULL WHERE published_at = '2000-01-01T00:00:00'"
        )
        # Migrations for columns added after initial release (CREATE TABLE IF NOT
        # EXISTS above doesn't touch already-existing tables on deployed DBs)
        _ensure_column(db, 'feeds', 'auto_download', 'INTEGER NOT NULL DEFAULT 0')
        _ensure_column(db, 'episodes', 'read_at', 'TEXT')
        _ensure_column(db, 'episodes', 'last_played_at', 'TEXT')
        _ensure_column(db, 'episodes', 'downloaded_path', 'TEXT')
        _ensure_column(db, 'episodes', 'downloaded_at', 'TEXT')
        for key, value in DEFAULT_SETTINGS.items():
            db.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', (key, value))


def get_setting(db, key: str) -> str:
    row = db.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
    return row['value'] if row else DEFAULT_SETTINGS[key]


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
