"""
LuffyTV Anime Stream API
A fast scraper for anikototv.to that provides:
- /                          -> API info
- /az-list/{letter}          -> Anime list by letter (A-Z, 0-9, other)
- /search?q={query}          -> Search anime
- /anime/{slug}              -> Anime detail + episode list
- /episodes/{anime_id}       -> Episode list (raw)
- /servers/{ids}             -> Server list for an episode (raw)
- /stream/{link_id}          -> Stream URL for a server
- /m3u8/{link_id}            -> Direct m3u8 URL (full pipeline)
- /recent                    -> Recently updated anime
- /popular                   -> Popular anime
- /genres                    -> Genre list
- /genre/{name}              -> Anime by genre
"""
import os
import re
import time
import asyncio
import hashlib
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, Query, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
import httpx
from bs4 import BeautifulSoup
from cachetools import TTLCache

# ============================================================
# CONFIG
# ============================================================
BASE_URL = "https://anikototv.to"
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BASE_URL + "/",
    "X-Requested-With": "XMLHttpRequest",
}

# Caches (TTL = time-to-live in seconds, maxsize = max items)
ANIME_LIST_CACHE = TTLCache(maxsize=50, ttl=3600)        # 1 hour
ANIME_DETAIL_CACHE = TTLCache(maxsize=2000, ttl=3600)    # 1 hour
EPISODE_LIST_CACHE = TTLCache(maxsize=5000, ttl=1800)    # 30 min
SERVER_LIST_CACHE = TTLCache(maxsize=10000, ttl=600)     # 10 min
STREAM_URL_CACHE = TTLCache(maxsize=20000, ttl=300)      # 5 min
M3U8_CACHE = TTLCache(maxsize=20000, ttl=300)            # 5 min
SEARCH_CACHE = TTLCache(maxsize=500, ttl=1800)           # 30 min

# HTTP client (shared, connection pool)
_http_client: Optional[httpx.AsyncClient] = None

app = FastAPI(
    title="LuffyTV Anime Stream API",
    description="Fast scraper for anikototv.to — get anime, episodes, m3u8 stream URLs",
    version="2.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS — allow all origins (you can restrict later)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# HTTP CLIENT
# ============================================================
async def get_http_client() -> httpx.AsyncClient:
    """Get or create a shared HTTP client."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            headers=DEFAULT_HEADERS,
            timeout=httpx.Timeout(15.0, connect=10.0),
            follow_redirects=True,
            http2=True,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        )
    return _http_client


@app.on_event("shutdown")
async def close_http_client():
    global _http_client
    if _http_client and not _http_client.is_closed:
        await _http_client.aclose()


# ============================================================
# HELPER FUNCTIONS
# ============================================================
async def fetch_page(url: str, headers: Optional[Dict] = None) -> str:
    """Fetch a page and return its HTML content."""
    client = await get_http_client()
    h = {**DEFAULT_HEADERS, **(headers or {})}
    response = await client.get(url, headers=h)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=f"Failed to fetch {url}")
    return response.text


async def fetch_json(url: str, headers: Optional[Dict] = None) -> Dict:
    """Fetch a JSON endpoint."""
    client = await get_http_client()
    h = {**DEFAULT_HEADERS, **(headers or {})}
    response = await client.get(url, headers=h)
    if response.status_code != 200:
        raise HTTPException(status_code=response.status_code, detail=f"Failed to fetch {url}")
    return response.json()


def parse_anime_card(card_html: str) -> Dict[str, Any]:
    """Parse a single anime card from list pages."""
    soup = BeautifulSoup(card_html, "html.parser")
    
    # Find the watch URL
    link = soup.find("a", href=re.compile(r"/watch/"))
    if not link:
        return None
    
    href = link.get("href", "")
    # URL format: /watch/{slug}-{id}/ep-1
    match = re.match(r"/watch/([a-z0-9-]+)-([a-z0-9]+)/ep-\d+", href)
    if not match:
        return None
    slug = match.group(1)
    anime_id = match.group(2)
    
    # Get title
    title = link.get("title") or link.get_text(strip=True) or slug.replace("-", " ").title()
    
    # Get image
    img = soup.find("img")
    image = img.get("src") or img.get("data-src") if img else None
    
    # Get JP name
    jp = link.get("data-jp") or ""
    
    return {
        "id": anime_id,
        "slug": slug,
        "title": title,
        "jp_title": jp,
        "url": f"{BASE_URL}/watch/{slug}-{anime_id}/ep-1",
        "image": image,
    }


def parse_anime_list_html(html: str) -> List[Dict]:
    """Parse the HTML of an anime list page (az-list, genre, search, etc.)."""
    soup = BeautifulSoup(html, "html.parser")
    anime_list = []
    
    # Anime cards are in <div class="item"> (anikototv.to uses this structure)
    # Also check <li> for fallback
    cards = soup.find_all("div", class_="item")
    if not cards:
        # Fallback to li elements
        cards = soup.find_all("li")
    
    seen_ids = set()
    for card in cards:
        link = card.find("a", href=re.compile(r"/watch/"))
        if not link:
            continue
        
        href = link.get("href", "")
        # URL format: https://anikototv.to/watch/{slug}-{id}/ep-1 OR /watch/{slug}-{id}/ep-1
        match = re.search(r"/watch/([a-z0-9-]+)-([a-z0-9]+)/ep-\d+", href)
        if not match:
            continue
        slug = match.group(1)
        anime_id = match.group(2)
        
        if anime_id in seen_ids:
            continue
        seen_ids.add(anime_id)
        
        # Get title from .name.d-title or link title
        name_el = card.find("a", class_="name") or card.find(class_="d-title") or link
        title = name_el.get("data-jp") or name_el.get_text(strip=True) or slug.replace("-", " ").title()
        
        # Get JP name
        jp = name_el.get("data-jp") if name_el else ""
        
        # Get image
        img = card.find("img")
        image = img.get("src") or img.get("data-src") if img else None
        
        anime_list.append({
            "id": anime_id,
            "slug": slug,
            "title": title,
            "jp_title": jp,
            "url": f"{BASE_URL}/watch/{slug}-{anime_id}/ep-1",
            "image": image,
        })
    
    return anime_list


def parse_episode_list_html(html: str) -> List[Dict]:
    """Parse episode list HTML returned by ajax/episode/list/{id}."""
    soup = BeautifulSoup(html, "html.parser")
    episodes = []
    for a in soup.find_all("a", attrs={"data-id": True}):
        ep_id = a.get("data-id")
        ep_num = a.get("data-num")
        ep_slug = a.get("data-slug")
        ids = a.get("data-ids")
        sub = a.get("data-sub")
        dub = a.get("data-dub")
        # Title from <span class="d-title">
        title_span = a.find("span", class_="d-title")
        title = title_span.get("data-jp") or title_span.get_text(strip=True) if title_span else f"Episode {ep_num}"
        
        episodes.append({
            "episode_id": ep_id,
            "number": ep_num,
            "slug": ep_slug,
            "ids": ids,  # This is what we pass to /ajax/server/list
            "sub": sub == "1",
            "dub": dub == "1",
            "title": title,
        })
    return episodes


def parse_server_list_html(html: str) -> List[Dict]:
    """Parse server list HTML returned by ajax/server/list."""
    soup = BeautifulSoup(html, "html.parser")
    servers = []
    
    # Each <div class="type" data-type="sub|dub|hsub"> contains a <ul> with <li> servers
    for type_div in soup.find_all("div", class_="type"):
        type_name = type_div.get("data-type", "unknown")
        for li in type_div.find_all("li"):
            link_id = li.get("data-link-id")
            ep_id = li.get("data-ep-id")
            sv_id = li.get("data-sv-id")
            cmid = li.get("data-cmid")
            name = li.get_text(strip=True)
            
            servers.append({
                "type": type_name,  # sub, dub, hsub
                "name": name,       # Vidstream-2, HD-1, VidPlay-1
                "link_id": link_id,
                "episode_id": ep_id,
                "server_id": sv_id,
                "cmid": cmid,
            })
    return servers


def parse_megaplay_url(url: str) -> Optional[str]:
    """Extract the realid from a megaplay URL.
    URL format: https://megaplay.buzz/stream/s-2/{realid}/{type}"""
    # https://megaplay.buzz/stream/s-2/50465/sub
    match = re.match(r"https?://[^/]+/stream/[^/]+/(\d+)/[^/]+", url)
    if match:
        return match.group(1)
    return None


# ============================================================
# API ENDPOINTS
# ============================================================
@app.get("/")
async def root():
    """API info and available endpoints."""
    return {
        "name": "LuffyTV Anime Stream API",
        "version": "2.0.0",
        "source": "anikototv.to",
        "endpoints": {
            "az_list": "/az-list/{letter} — Get anime by letter (A-Z, 0-9, other)",
            "search": "/search?q={query} — Search anime",
            "anime_detail": "/anime/{slug} — Get anime detail page",
            "episodes": "/episodes/{anime_id} — Get episode list",
            "servers": "/servers/{ids} — Get server list for an episode",
            "stream": "/stream/{link_id} — Get stream iframe URL",
            "m3u8": "/m3u8/{link_id} — Get direct m3u8 URL (full pipeline)",
            "recent": "/recent — Recently updated anime",
            "popular": "/popular — Popular anime",
            "genres": "/genres — List all genres",
            "genre": "/genre/{name} — Anime by genre",
        },
        "usage_example": "/m3u8/{link_id} — get the m3u8 stream URL for an episode",
        "docs": "/docs",
    }


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "timestamp": time.time()}


@app.get("/az-list/{letter}")
async def get_az_list(letter: str):
    """Get anime list by letter (A-Z, 0-9, 'other')."""
    letter = letter.lower()
    if letter not in list("abcdefghijklmnopqrstuvwxyz") + ["0-9", "other"]:
        raise HTTPException(status_code=400, detail="Letter must be A-Z, 0-9, or 'other'")
    
    cache_key = f"azlist_{letter}"
    if cache_key in ANIME_LIST_CACHE:
        return ANIME_LIST_CACHE[cache_key]
    
    url = f"{BASE_URL}/az-list/{letter}"
    html = await fetch_page(url)
    anime_list = parse_anime_list_html(html)
    
    result = {
        "letter": letter,
        "count": len(anime_list),
        "anime": anime_list,
    }
    ANIME_LIST_CACHE[cache_key] = result
    return result


@app.get("/search")
async def search(q: str = Query(..., description="Search query")):
    """Search anime by keyword."""
    cache_key = f"search_{q.lower()}"
    if cache_key in SEARCH_CACHE:
        return SEARCH_CACHE[cache_key]
    
    url = f"{BASE_URL}/filter?keyword={q}"
    html = await fetch_page(url)
    anime_list = parse_anime_list_html(html)
    
    result = {
        "query": q,
        "count": len(anime_list),
        "results": anime_list,
    }
    SEARCH_CACHE[cache_key] = result
    return result


@app.get("/anime/{slug}")
async def get_anime_detail(slug: str):
    """Get anime detail page (includes metadata + episode list link).
    slug format: {title-slug}-{id}"""
    cache_key = f"anime_{slug}"
    if cache_key in ANIME_DETAIL_CACHE:
        return ANIME_DETAIL_CACHE[cache_key]
    
    # Try fetching ep-1 first to get the anime_id
    url = f"{BASE_URL}/watch/{slug}/ep-1"
    html = await fetch_page(url)
    soup = BeautifulSoup(html, "html.parser")
    
    # Find data-anime-id (in the watch2gether button or elsewhere)
    anime_id_el = soup.find(attrs={"data-anime-id": True})
    anime_id = anime_id_el.get("data-anime-id") if anime_id_el else None
    
    # Find title
    title_el = soup.find("h1", class_="title")
    title = title_el.get_text(strip=True) if title_el else slug
    
    # JP title
    jp = title_el.get("data-jp") if title_el else ""
    
    # Image
    img = soup.find("img", attrs={"itemprop": "image"})
    image = img.get("src") if img else None
    
    # Synopsis
    synopsis_el = soup.find("div", class_="synopsis")
    synopsis = synopsis_el.get_text(strip=True) if synopsis_el else ""
    
    # Get meta info
    meta = {}
    bmeta = soup.find("div", class_="bmeta")
    if bmeta:
        for div in bmeta.find_all("div", class_="meta"):
            text = div.get_text(separator=" ", strip=True)
            if ":" in text:
                key, _, value = text.partition(":")
                meta[key.strip().lower().replace(" ", "_")] = value.strip()
    
    # Names (alternative titles)
    names_el = soup.find("div", class_="names")
    names = names_el.get_text(strip=True) if names_el else ""
    
    result = {
        "slug": slug,
        "anime_id": anime_id,
        "title": title,
        "jp_title": jp,
        "alternative_names": names,
        "image": image,
        "synopsis": synopsis,
        "meta": meta,
        "url": url,
        "episodes_endpoint": f"/episodes/{anime_id}" if anime_id else None,
    }
    
    ANIME_DETAIL_CACHE[cache_key] = result
    return result


@app.get("/episodes/{anime_id}")
async def get_episodes(anime_id: str):
    """Get episode list for an anime (calls ajax/episode/list)."""
    cache_key = f"eps_{anime_id}"
    if cache_key in EPISODE_LIST_CACHE:
        return EPISODE_LIST_CACHE[cache_key]
    
    url = f"{BASE_URL}/ajax/episode/list/{anime_id}"
    data = await fetch_json(url)
    
    if data.get("status") != 200:
        raise HTTPException(status_code=404, detail="Anime not found")
    
    html = data.get("result", "")
    episodes = parse_episode_list_html(html)
    
    result = {
        "anime_id": anime_id,
        "count": len(episodes),
        "episodes": episodes,
    }
    EPISODE_LIST_CACHE[cache_key] = result
    return result


@app.get("/servers/{ids}")
async def get_servers(ids: str):
    """Get server list for an episode (calls ajax/server/list).
    ids = the data-ids value from the episode list."""
    # Use hash for cache key — the data-ids strings can be very long (300+ chars)
    # and truncating them causes cache collisions between different anime
    cache_key = f"srv_{hashlib.md5(ids.encode()).hexdigest()}"
    if cache_key in SERVER_LIST_CACHE:
        return SERVER_LIST_CACHE[cache_key]
    
    url = f"{BASE_URL}/ajax/server/list?servers={ids}"
    data = await fetch_json(url)
    
    if data.get("status") != 200:
        raise HTTPException(status_code=404, detail="Episode not found")
    
    html = data.get("result", "")
    servers = parse_server_list_html(html)
    
    result = {
        "ids": ids,
        "count": len(servers),
        "servers": servers,
    }
    SERVER_LIST_CACHE[cache_key] = result
    return result


@app.get("/stream/{link_id}")
async def get_stream_url(link_id: str):
    """Get the stream iframe URL for a server (calls ajax/server?get=).
    link_id = the data-link-id value from the server list."""
    # Use full hash — link_ids share long common prefixes (86+ chars),
    # so truncating to 50 chars causes cache collisions between different anime
    cache_key = f"stream_{hashlib.md5(link_id.encode()).hexdigest()}"
    if cache_key in STREAM_URL_CACHE:
        return STREAM_URL_CACHE[cache_key]
    
    url = f"{BASE_URL}/ajax/server?get={link_id}"
    data = await fetch_json(url)
    
    if data.get("status") != 200:
        raise HTTPException(status_code=404, detail="Server not found")
    
    result_data = data.get("result", {})
    iframe_url = result_data.get("url")
    skip_data = result_data.get("skip_data", {})
    
    # Format skip data into intro/outro
    intro = skip_data.get("intro", [0, 0]) if skip_data else [0, 0]
    outro = skip_data.get("outro", [0, 0]) if skip_data else [0, 0]
    
    result = {
        "link_id": link_id,
        "iframe_url": iframe_url,
        "intro": {"start": intro[0], "end": intro[1]} if intro else None,
        "outro": {"start": outro[0], "end": outro[1]} if outro else None,
    }
    STREAM_URL_CACHE[cache_key] = result
    return result


@app.get("/m3u8/{link_id}")
async def get_m3u8_url(link_id: str):
    """Get the direct m3u8 URL for an episode (full pipeline).
    
    Handles multiple streaming providers:
    - megaplay.buzz (Vidstream-2, HD-1, HD-2 servers)
    - vidtube.site  (VidPlay-1 servers)
    
    Both use the same /stream/getSources?id={data-id} endpoint, just on
    their own domain. We use data-id (numeric) which works for both.
    """
    # Use full hash — link_ids share long common prefixes,
    # so truncating causes cache collisions between different anime
    cache_key = f"m3u8_{hashlib.md5(link_id.encode()).hexdigest()}"
    if cache_key in M3U8_CACHE:
        return M3U8_CACHE[cache_key]
    
    # Step 1: Get the iframe URL
    stream_data = await get_stream_url(link_id)
    iframe_url = stream_data.get("iframe_url")
    if not iframe_url:
        raise HTTPException(status_code=404, detail="No iframe URL")
    
    # Step 2: Fetch the iframe page (megaplay.buzz or vidtube.site) to extract player data
    iframe_html = await fetch_page(iframe_url, headers={"Referer": BASE_URL + "/"})
    soup = BeautifulSoup(iframe_html, "html.parser")
    
    player_div = soup.find(id="megaplay-player")
    if not player_div:
        raise HTTPException(status_code=500, detail="Player div not found in iframe page")
    
    # Determine the provider's base URL (use the iframe's own domain)
    from urllib.parse import urlparse, quote
    parsed = urlparse(iframe_url)
    provider_base = f"{parsed.scheme}://{parsed.netloc}"
    
    # Try different ID attributes — order matters:
    # 1. data-id (numeric, works for BOTH megaplay and vidtube)
    # 2. data-mediaid (numeric, works for both as fallback)
    # 3. data-realid (numeric for megaplay, but a slug string for vidtube — only use if numeric)
    candidate_ids = []
    for attr in ["data-id", "data-mediaid", "data-realid"]:
        val = player_div.get(attr)
        if val and val not in candidate_ids:
            # Only add numeric IDs (vidtube's data-realid is a string slug like "anime-name/ep-1")
            try:
                int(val)
                candidate_ids.append(val)
            except (ValueError, TypeError):
                pass  # skip non-numeric
    
    if not candidate_ids:
        raise HTTPException(status_code=500, detail="Could not extract numeric media ID from player")
    
    # Step 3: Try getSources endpoint on the provider's domain
    # Try each candidate ID until one returns a valid m3u8
    client = await get_http_client()
    sources_data = None
    last_error = None
    
    for real_id in candidate_ids:
        sources_url = f"{provider_base}/stream/getSources?id={real_id}"
        try:
            sources_response = await client.get(
                sources_url,
                headers={
                    **DEFAULT_HEADERS,
                    "Referer": iframe_url,
                    "X-Requested-With": "XMLHttpRequest",
                }
            )
            if sources_response.status_code != 200:
                last_error = f"getSources returned {sources_response.status_code} for id={real_id}"
                continue
            
            sources_data = sources_response.json()
            sources = sources_data.get("sources", {})
            m3u8_url = sources.get("file") if isinstance(sources, dict) else None
            if m3u8_url:
                break  # Found it!
            last_error = f"No m3u8 in sources for id={real_id}"
        except Exception as e:
            last_error = f"Error fetching getSources for id={real_id}: {e}"
            continue
    
    if not sources_data or not m3u8_url:
        raise HTTPException(status_code=502, detail=f"getSources failed: {last_error}")
    
    # Get tracks (subtitles)
    tracks = sources_data.get("tracks", [])
    subtitles = [
        {
            "url": t.get("file"),
            "label": t.get("label"),
            "default": t.get("default", False),
        }
        for t in tracks
    ]
    
    # Get intro/outro
    intro = sources_data.get("intro", {})
    outro = sources_data.get("outro", {})
    
    result = {
        "link_id": link_id,
        "iframe_url": iframe_url,
        "provider": parsed.netloc,
        "m3u8_url": m3u8_url,
        "subtitles": subtitles,
        "intro": intro,
        "outro": outro,
        "server": sources_data.get("server"),
    }
    M3U8_CACHE[cache_key] = result
    return result


@app.get("/m3u8-direct/{link_id}")
async def get_m3u8_direct(link_id: str):
    """Get just the m3u8 URL as plain text (for use in players)."""
    data = await get_m3u8_url(link_id)
    return PlainTextResponse(data["m3u8_url"])


@app.get("/recent")
async def get_recent():
    """Get recently updated anime from homepage."""
    cache_key = "recent"
    if cache_key in ANIME_LIST_CACHE:
        return ANIME_LIST_CACHE[cache_key]
    
    html = await fetch_page(BASE_URL + "/home")
    anime_list = parse_anime_list_html(html)
    
    result = {"count": len(anime_list), "anime": anime_list}
    ANIME_LIST_CACHE[cache_key] = result
    return result


@app.get("/popular")
async def get_popular():
    """Get popular anime."""
    cache_key = "popular"
    if cache_key in ANIME_LIST_CACHE:
        return ANIME_LIST_CACHE[cache_key]
    
    html = await fetch_page(BASE_URL + "/most-viewed")
    anime_list = parse_anime_list_html(html)
    result = {"count": len(anime_list), "anime": anime_list}
    ANIME_LIST_CACHE[cache_key] = result
    return result


@app.get("/genres")
async def get_genres():
    """Get list of all genres."""
    cache_key = "genres"
    if cache_key in ANIME_LIST_CACHE:
        return ANIME_LIST_CACHE[cache_key]
    
    html = await fetch_page(BASE_URL + "/home")
    soup = BeautifulSoup(html, "html.parser")
    
    genres = []
    for a in soup.find_all("a", href=re.compile(r"/genre/")):
        name = a.get_text(strip=True)
        href = a.get("href", "")
        slug = href.replace("/genre/", "")
        if name and slug and slug not in [g["slug"] for g in genres]:
            genres.append({"name": name, "slug": slug})
    
    result = {"count": len(genres), "genres": genres}
    ANIME_LIST_CACHE[cache_key] = result
    return result


@app.get("/genre/{name}")
async def get_genre(name: str):
    """Get anime by genre."""
    cache_key = f"genre_{name}"
    if cache_key in ANIME_LIST_CACHE:
        return ANIME_LIST_CACHE[cache_key]
    
    url = f"{BASE_URL}/genre/{name}"
    html = await fetch_page(url)
    anime_list = parse_anime_list_html(html)
    
    result = {
        "genre": name,
        "count": len(anime_list),
        "anime": anime_list,
    }
    ANIME_LIST_CACHE[cache_key] = result
    return result


@app.get("/full/{slug}/{episode_num}")
async def get_full_pipeline(slug: str, episode_num: str, preferred_type: str = "sub"):
    """One-shot endpoint: from anime slug + episode number, get everything including m3u8.
    
    Tries multiple servers (Vidstream-2, HD-1, HD-2, VidPlay-1) until it finds
    one that returns a working m3u8 URL. Falls back through the server list
    so we always return a playable stream when one exists.
    
    Example: /full/a-silent-voice-fghla/1
    Optional: /full/a-silent-voice-fghla/1?preferred_type=dub
    """
    cache_key = f"full_{slug}_{episode_num}_{preferred_type}"
    if cache_key in M3U8_CACHE:
        return M3U8_CACHE[cache_key]
    
    # Step 1: Get anime_id from the watch page
    anime_data = await get_anime_detail(slug)
    anime_id = anime_data.get("anime_id")
    if not anime_id:
        raise HTTPException(status_code=404, detail="Could not find anime_id")
    
    # Step 2: Get episode list
    episodes_data = await get_episodes(anime_id)
    
    # Step 3: Find the requested episode
    target_ep = None
    for ep in episodes_data["episodes"]:
        if str(ep["number"]) == str(episode_num):
            target_ep = ep
            break
    
    if not target_ep:
        raise HTTPException(status_code=404, detail=f"Episode {episode_num} not found")
    
    # Step 4: Get servers for this episode
    servers_data = await get_servers(target_ep["ids"])
    
    # Step 5: Try servers in priority order until we find a working m3u8
    # Priority: 
    # 1. Servers matching preferred_type (sub/dub/hsub) 
    # 2. Prefer Vidstream-2 and HD-1 (megaplay.buzz) over VidPlay-1 (vidtube.site) for stability
    # 3. Fall back to any remaining server
    all_servers = servers_data["servers"]
    
    # Sort servers: preferred_type first, then by name priority
    name_priority = {"Vidstream-2": 0, "HD-1": 1, "HD-2": 2, "VidPlay-1": 3}
    def server_sort_key(s):
        type_match = 0 if s["type"] == preferred_type else 1
        name_rank = name_priority.get(s["name"], 99)
        return (type_match, name_rank)
    
    sorted_servers = sorted(all_servers, key=server_sort_key)
    
    if not sorted_servers:
        raise HTTPException(status_code=404, detail="No servers available")
    
    # Step 6: Try each server until we get a working m3u8
    m3u8_data = None
    used_server = None
    errors = []
    
    for server in sorted_servers:
        try:
            candidate_m3u8 = await get_m3u8_url(server["link_id"])
            if candidate_m3u8 and candidate_m3u8.get("m3u8_url"):
                m3u8_data = candidate_m3u8
                used_server = server
                break
        except HTTPException as e:
            errors.append({
                "server": server["name"],
                "type": server["type"],
                "error": e.detail if hasattr(e, "detail") else str(e),
            })
            continue
        except Exception as e:
            errors.append({
                "server": server["name"],
                "type": server["type"],
                "error": f"{type(e).__name__}: {e}",
            })
            continue
    
    if not m3u8_data:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "All servers failed to return m3u8",
                "errors": errors,
                "available_servers": all_servers,
            }
        )
    
    result = {
        "anime": {
            "slug": slug,
            "title": anime_data.get("title"),
            "image": anime_data.get("image"),
            "anime_id": anime_id,
        },
        "episode": {
            "number": target_ep["number"],
            "title": target_ep["title"],
            "sub": target_ep["sub"],
            "dub": target_ep["dub"],
        },
        "server_used": {
            "name": used_server["name"],
            "type": used_server["type"],
        },
        "all_servers": servers_data["servers"],
        "stream": m3u8_data,
    }
    
    M3U8_CACHE[cache_key] = result
    return result


# ============================================================
# RUN
# ============================================================
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    workers = int(os.environ.get("WORKERS", 1))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        workers=workers,
        log_level="info",
        access_log=False,  # Disable access logs for performance
    )
