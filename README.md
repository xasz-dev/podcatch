# podcatch

A self-hosted podcast and video feed player that runs in the browser. Supports RSS/podcast feeds, YouTube channels, and custom YouTube playlists.

**Features**
- Add feeds by search (iTunes directory), URL, or YouTube channel/playlist link
- Unified "All Episodes" feed sorted by publish date across all sources
- Audio and video playback with seek, speed control, and progress saving
- Resizable video player
- Unread tracking and per-feed unread counts
- Multi-device playback handoff
- PWA-installable (works on mobile)

---

## Running locally

**Requirements:** Docker and Docker Compose.

```bash
git clone https://github.com/xasz-dev/podcatch.git
cd podcatch
docker compose up -d --build
```

The app will be available at `http://localhost:8000`.

The SQLite database is stored in a `data/` volume and persists across rebuilds.

---

## Running on a Synology NAS (or any remote host)

**Requirements:** Docker and Docker Compose installed on the NAS, SSH access.

1. Copy the project to the NAS:
   ```bash
   rsync -av /path/to/podcatch/ user@your-nas-ip:/volume1/docker/podcatch/
   ```

2. SSH in and build:
   ```bash
   ssh user@your-nas-ip
   cd /volume1/docker/podcatch
   DOCKER_BUILDKIT=1 sudo docker compose up -d --build
   ```

   > `DOCKER_BUILDKIT=1` is required on Synology to enable layer caching.

The app will be available at `http://your-nas-ip:8000`.

---

## Public access

The app is exposed over the internet through [Pangolin](https://github.com/fosrl/pangolin), a self-hosted tunnel and auth proxy, rather than Cloudflare Tunnel — the auth gate `app.js` talks about (session-expiry detection, opaque-redirect handling) is Pangolin's.

---

## Tech stack

- **Backend:** Python, FastAPI, yt-dlp, feedparser
- **Frontend:** Vanilla JS, no framework
- **Storage:** SQLite
- **Container:** Docker
