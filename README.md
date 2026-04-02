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

## Public access with Cloudflare Tunnel (optional)

To expose the app securely over the internet without opening firewall ports:

1. Install `cloudflared` on the host and authenticate:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create podcatch
   ```

2. Create `/etc/cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>

   ingress:
     - hostname: podcatch.yourdomain.com
       service: http://localhost:8000
     - service: http_status:404
   ```

3. Route DNS and run as a service:
   ```bash
   cloudflared tunnel route dns podcatch podcatch.yourdomain.com
   cloudflared --config /etc/cloudflared/config.yml service install
   systemctl enable cloudflared
   systemctl start cloudflared
   ```

4. Add passwordless auth via [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (Zero Trust → Access → Applications). Email one-time code requires no password and works well on mobile.

> After any rebuild, purge the Cloudflare cache (Dashboard → Caching → Purge Everything) to pick up updated static files.

---

## Tech stack

- **Backend:** Python, FastAPI, yt-dlp, feedparser
- **Frontend:** Vanilla JS, no framework
- **Storage:** SQLite
- **Container:** Docker
