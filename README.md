# 🍕 LuffyTV Miruro API

A fast **FastAPI** scraper for **anikototv.to** that returns JSON with anime metadata, episode lists, server lists, and direct **m3u8 stream URLs**.

Built for VPS hosting — async I/O, connection pooling, multi-layer caching, HTTP/2.

## 🚀 Quick Deploy (Docker)

```bash
docker run -d \
  --name luffytv-api \
  --restart unless-stopped \
  -p 8080:8080 \
  -e PORT=8080 \
  -e WORKERS=2 \
  fahadulalim93-cloud/luffytv-miruro-api:latest
```

Or build from source:

```bash
git clone https://github.com/fahadulalim93-cloud/luffytv-miruro-api
cd luffytv-miruro-api
docker build -t luffytv-api .
docker run -d --name luffytv-api --restart unless-stopped -p 8080:8080 luffytv-api
```

## 📡 Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | API info |
| `GET /docs` | Interactive Swagger docs |
| `GET /health` | Health check |
| `GET /az-list/{letter}` | Anime by letter (A-Z, 0-9, other) |
| `GET /search?q={query}` | Search anime |
| `GET /anime/{slug}` | Anime detail (metadata + episode link) |
| `GET /episodes/{anime_id}` | Episode list |
| `GET /servers/{ids}` | Server list for an episode |
| `GET /stream/{link_id}` | Stream iframe URL |
| `GET /m3u8/{link_id}` | Direct m3u8 URL (full pipeline) |
| `GET /m3u8-direct/{link_id}` | Plain-text m3u8 URL (for players) |
| `GET /full/{slug}/{episode_num}` | One-shot: anime + ep → m3u8 |
| `GET /recent` | Recently updated |
| `GET /popular` | Most viewed |
| `GET /genres` | All genres |
| `GET /genre/{name}` | Anime by genre |

## 🎯 Usage Examples

### Search for One Piece
```
GET /search?q=one piece
```

### Get the m3u8 URL for "A Silent Voice" episode 1
```
GET /full/a-silent-voice-fghla/1
```

Returns:
```json
{
  "anime": { "title": "A Silent Voice", "image": "..." },
  "episode": { "number": "1", "title": "Full" },
  "server_used": { "name": "Vidstream-2", "type": "sub" },
  "stream": {
    "m3u8_url": "https://cdn.kryntal.top/anime/.../master.m3u8",
    "subtitles": [...],
    "intro": { "start": 0, "end": 25 },
    "outro": { "start": 370, "end": 382 }
  }
}
```

### Use the m3u8 URL in your player
```
GET /m3u8-direct/{link_id}
```
Returns plain text — drop directly into an HLS player.

## ⚡ Performance

- **Async I/O** with httpx + http2
- **Multi-layer caching** with TTL:
  - Anime lists: 1 hour
  - Anime details: 1 hour
  - Episode lists: 30 min
  - Server lists: 10 min
  - Stream URLs: 5 min
  - m3u8 URLs: 5 min
- **Connection pooling** (100 max connections, 20 keepalive)
- **No access logs** (less I/O overhead)
- **Single worker** by default — set `WORKERS=2-4` for higher load

## 🛠️ VPS Deployment (systemd)

For non-Docker VPS deployment:

```bash
# Install dependencies
sudo apt install python3 python3-pip python3-venv
git clone https://github.com/fahadulalim93-cloud/luffytv-miruro-api
cd luffytv-miruro-api
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Create systemd service
sudo tee /etc/systemd/system/luffytv-api.service << 'EOF'
[Unit]
Description=LuffyTV Miruro API
After=network.target

[Service]
User=root
WorkingDirectory=/root/luffytv-miruro-api
Environment=PORT=8080
Environment=WORKERS=2
ExecStart=/root/luffytv-miruro-api/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8080 --workers 2 --no-access-log
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable luffytv-api
sudo systemctl start luffytv-api

# Check status
sudo systemctl status luffytv-api
```

## 🆘 Reverse Proxy (Nginx + SSL)

```nginx
server {
    listen 80;
    server_name api.luffytv.live;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.luffytv.live;

    ssl_certificate /etc/letsencrypt/live/api.luffytv.live/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.luffytv.live/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Get SSL with certbot:
```bash
sudo certbot --nginx -d api.luffytv.live
```

## 📝 Notes

- All data scraped from `anikototv.to` (public site)
- m3u8 URLs come from megaplay.buzz's `getSources` endpoint
- Subtitles (VTT format) are returned alongside m3u8 when available
- Intro/outro skip timestamps are included when available
- The API caches aggressively — first request may be slow, subsequent ones are fast
