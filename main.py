import base64, json, gzip, httpx, os, time, asyncio
from curl_cffi.requests import AsyncSession
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
from dotenv import load_dotenv

# ─── Timeout Constants ─────────────────────────────────────────────────────────
PIPE_TIMEOUT = 15          # seconds for curl_cffi pipe requests
CF_SOLVE_TIMEOUT = 25     # seconds for Playwright CF challenge solving
EPISODES_TIMEOUT = 20     # total timeout for /episodes endpoint
SOURCES_TIMEOUT = 20      # total timeout for /sources endpoint

load_dotenv()

app = FastAPI(title="Miruro API", version="3.1", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.tv/",
    "Origin": "https://www.miruro.tv",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "sec-ch-ua": '"Chromium";v="131", "Not A(Brand";v="24", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}
ANILIST_URL = "https://graphql.anilist.co"
MIRURO_PIPE_URL = "https://www.miruro.tv/api/secure/pipe"

# ─── Cloudflare Turnstile Bypass via Playwright ────────────────────────────
# miruro.tv uses CF Turnstile JS challenge. curl_cffi can't solve it.
# We use Playwright (headless Chromium) to visit miruro.tv once, solve the
# challenge, and extract CF cookies. These cookies are cached and reused
# for all pipe requests. Refreshed every 30 minutes or on 403.

_cf_cookies: dict = {}       # {"cf_clearance": "...", ...}
_cf_cookie_ts: float = 0    # When cookies were last refreshed
_CF_COOKIE_TTL = 1800       # 30 minutes

async def _solve_cf_challenge() -> dict:
    """Use Playwright headless browser to solve CF Turnstile challenge on miruro.tv."""
    from playwright.async_api import async_playwright
    print("[CF-Bypass] Launching Playwright to solve miruro.tv CF challenge...")
    try:
        # Wrap in asyncio.wait_for to enforce a hard timeout
        return await asyncio.wait_for(_solve_cf_challenge_inner(), timeout=CF_SOLVE_TIMEOUT)
    except asyncio.TimeoutError:
        print(f"[CF-Bypass] Playwright timed out after {CF_SOLVE_TIMEOUT}s")
        return {}
    except Exception as e:
        print(f"[CF-Bypass] Playwright error: {e}")
        return {}

async def _solve_cf_challenge_inner() -> dict:
    """Inner CF challenge solver — separated for timeout wrapping."""
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
                  "--disable-blink-features=AutomationControlled",
                  "--window-size=1280,720"],
        )
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720},
        )
        page = await ctx.new_page()
        try:
            await page.goto("https://www.miruro.tv/", wait_until="domcontentloaded", timeout=20000)
            # Wait for CF challenge to resolve — check for actual content
            # Instead of fixed wait, poll for cf_clearance cookie or anime content
            for attempt in range(10):  # up to 10s
                await page.wait_for_timeout(1000)
                cookies = await ctx.cookies()
                cf_cookies = {}
                for c in cookies:
                    if "miruro" in c.get("domain", ""):
                        cf_cookies[c["name"]] = c["value"]
                # Check if we got cf_clearance — that means challenge is solved
                if "cf_clearance" in cf_cookies:
                    print(f"[CF-Bypass] Got cf_clearance cookie (attempt {attempt+1})")
                    await browser.close()
                    return cf_cookies
                # Also check if page has actual content (not just challenge page)
                try:
                    title = await page.title()
                    if title and "moment" not in title.lower() and "challenge" not in title.lower():
                        print(f"[CF-Bypass] Page loaded with title: {title}")
                        if cf_cookies:
                            await browser.close()
                            return cf_cookies
                except:
                    pass
            # If we didn't get cf_clearance but got other cookies, try them
            cookies = await ctx.cookies()
            cf_cookies = {}
            for c in cookies:
                if "miruro" in c.get("domain", ""):
                    cf_cookies[c["name"]] = c["value"]
            await browser.close()
            if cf_cookies:
                print(f"[CF-Bypass] Got {len(cf_cookies)} cookies (no cf_clearance)")
            else:
                print("[CF-Bypass] No miruro cookies found — CF challenge may not have been solved")
            return cf_cookies
        except Exception as e:
            await browser.close()
            raise e

async def _get_cf_cookies() -> dict:
    """Get cached CF cookies, refreshing if expired or missing."""
    global _cf_cookies, _cf_cookie_ts
    now = time.time()
    if _cf_cookies and (now - _cf_cookie_ts) < _CF_COOKIE_TTL:
        return _cf_cookies
    # Refresh cookies
    new_cookies = await _solve_cf_challenge()
    if new_cookies:
        _cf_cookies = new_cookies
        _cf_cookie_ts = now
    return _cf_cookies

async def _pipe_get(url: str) -> 'curl_cffi.requests.Response':
    """GET request to Miruro pipe with CF cookie bypass + timeout protection."""
    global _cf_cookies, _cf_cookie_ts
    headers = {**HEADERS}
    
    # Try with cached cookies first
    try:
        cookies = await asyncio.wait_for(_get_cf_cookies(), timeout=CF_SOLVE_TIMEOUT + 5)
    except asyncio.TimeoutError:
        print("[CF-Bypass] Cookie refresh timed out, proceeding without cookies")
        cookies = {}
    
    if cookies:
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
        headers["Cookie"] = cookie_str
    
    try:
        async with AsyncSession(impersonate="chrome131") as client:
            res = await client.get(url, headers=headers, timeout=PIPE_TIMEOUT)
    except Exception as e:
        print(f"[pipe-get] curl_cffi error: {e}")
        # Return a fake response with error info
        class FakeResponse:
            status_code = 502
            text = f"curl_cffi error: {e}"
            headers = {}
        return FakeResponse()
    
    # If 403, cookies expired — refresh and retry once
    if res.status_code == 403:
        print("[CF-Bypass] Got 403 — cookies expired or missing, refreshing...")
        try:
            new_cookies = await asyncio.wait_for(_solve_cf_challenge(), timeout=CF_SOLVE_TIMEOUT + 5)
        except asyncio.TimeoutError:
            print("[CF-Bypass] CF challenge refresh timed out")
            new_cookies = {}
        if new_cookies:
            _cf_cookies = new_cookies
            _cf_cookie_ts = time.time()
            cookie_str = "; ".join(f"{k}={v}" for k, v in new_cookies.items())
            headers2 = {**HEADERS, "Cookie": cookie_str}
            try:
                async with AsyncSession(impersonate="chrome131") as client:
                    res = await client.get(url, headers=headers2, timeout=PIPE_TIMEOUT)
            except Exception as e:
                print(f"[pipe-get] retry curl_cffi error: {e}")
                class FakeResponse:
                    status_code = 502
                    text = f"curl_cffi retry error: {e}"
                    headers = {}
                return FakeResponse()
    
    return res

def _proxy_img(url: str) -> str:
    return url

def _proxy_deep_images(obj):
    return obj

def _inject_source_slugs(data: dict, anilist_id: int):
    providers = data.get("providers", {})
    for provider_name, provider_data in providers.items():
        if not isinstance(provider_data, dict):
            continue
        episodes = provider_data.get("episodes", {})
        if not isinstance(episodes, dict):
            if isinstance(episodes, list):
                provider_data["episodes"] = {"sub": episodes}
                episodes = provider_data["episodes"]
            else:
                continue
        for category, ep_list in episodes.items():
            if not isinstance(ep_list, list):
                continue
            for ep in ep_list:
                if not isinstance(ep, dict):
                    continue
                if "id" in ep and "number" in ep:
                    orig_id = ep["id"]
                    prefix = orig_id.split(":")[0] if ":" in orig_id else orig_id
                    ep["id"] = f"watch/{provider_name}/{anilist_id}/{category}/{prefix}-{ep['number']}"
    return data

async def _fetch_raw_episodes(anilist_id: int) -> dict:
    """Fetch raw episodes with timeout protection."""
    payload = {
        "path": "episodes",
        "method": "GET",
        "query": {"anilistId": anilist_id},
        "body": None,
        "version": "0.1.0",
    }
    encoded_req = _encode_pipe_request(payload)
    pipe_url = f"{MIRURO_PIPE_URL}?e={encoded_req}"
    
    try:
        res = await asyncio.wait_for(_pipe_get(pipe_url), timeout=EPISODES_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail={
            "error": "Episodes request timed out",
            "detail": f"Pipe request for anilistId={anilist_id} timed out after {EPISODES_TIMEOUT}s. "
                      f"Cloudflare challenge on miruro.tv may be blocking the request.",
            "anilistId": anilist_id,
        })
    
    if res.status_code != 200:
        # Check if we got a CF challenge page instead of data
        body_preview = res.text[:500] if hasattr(res, 'text') else ''
        is_cf_challenge = 'Just a moment' in body_preview or 'challenge' in body_preview.lower()
        raise HTTPException(status_code=res.status_code, detail={
            "status": res.status_code,
            "body": body_preview,
            "cf_challenge": is_cf_challenge,
            "error": "Cloudflare challenge blocked the request" if is_cf_challenge else "Pipe request failed",
            "anilistId": anilist_id,
        })
    try:
        data = _decode_pipe_response(res.text.strip())
    except ValueError as e:
        raise HTTPException(status_code=502, detail={
            "error": "Failed to decode pipe response",
            "detail": str(e),
            "anilistId": anilist_id,
        })
    _deep_translate(data)
    return data

MEDIA_LIST_FIELDS = """
    id
    title { romaji english native }
    coverImage { large extraLarge }
    bannerImage
    format
    season
    seasonYear
    episodes
    duration
    status
    averageScore
    meanScore
    popularity
    favourites
    genres
    source
    countryOfOrigin
    isAdult
    studios(isMain: true) { nodes { name isAnimationStudio } }
    nextAiringEpisode { episode airingAt timeUntilAiring }
    startDate { year month day }
    endDate { year month day }
"""

MEDIA_FULL_FIELDS = """
    id
    idMal
    title { romaji english native }
    description(asHtml: false)
    coverImage { large extraLarge color }
    bannerImage
    format
    season
    seasonYear
    episodes
    duration
    status
    averageScore
    meanScore
    popularity
    favourites
    trending
    genres
    tags { name rank isMediaSpoiler }
    source
    countryOfOrigin
    isAdult
    hashtag
    synonyms
    siteUrl
    trailer { id site thumbnail }
    studios { nodes { id name isAnimationStudio siteUrl } }
    nextAiringEpisode { episode airingAt timeUntilAiring }
    startDate { year month day }
    endDate { year month day }
    characters(sort: [ROLE, RELEVANCE], perPage: 25) {
        edges {
            role
            node { id name { full native } image { large } }
            voiceActors(language: JAPANESE) { id name { full native } image { large } languageV2 }
        }
    }
    staff(sort: RELEVANCE, perPage: 25) {
        edges {
            role
            node { id name { full native } image { large } }
        }
    }
    relations {
        edges {
            relationType(version: 2)
            node {
                id
                title { romaji english native }
                coverImage { large }
                format
                type
                status
                episodes
                meanScore
            }
        }
    }
    recommendations(sort: RATING_DESC, perPage: 10) {
        nodes {
            rating
            mediaRecommendation {
                id
                title { romaji english native }
                coverImage { large }
                format
                episodes
                status
                meanScore
                averageScore
            }
        }
    }
    externalLinks { url site type }
    streamingEpisodes { title thumbnail url site }
    stats {
        scoreDistribution { score amount }
        statusDistribution { status amount }
    }
"""

def _translate_id(encoded_id: str) -> str:
    try:
        decoded = base64.urlsafe_b64decode(encoded_id + '=' * (4 - len(encoded_id) % 4)).decode()
        if ':' in decoded:
            return decoded
        return encoded_id
    except Exception:
        return encoded_id

def _deep_translate(obj):
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == 'id' and isinstance(value, str):
                obj[key] = _translate_id(value)
            elif isinstance(value, (dict, list)):
                _deep_translate(value)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)):
                _deep_translate(item)

def _decode_pipe_response(encoded_str: str) -> dict:
    try:
        encoded_str += '=' * (4 - len(encoded_str) % 4)
        compressed = base64.urlsafe_b64decode(encoded_str)
        return json.loads(gzip.decompress(compressed).decode('utf-8'))
    except Exception:
        raise ValueError("Failed to decode pipe response")

def _encode_pipe_request(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')

async def _anilist_query(query: str, variables: dict = None):
    body = {"query": query}
    if variables:
        body["variables"] = variables
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.post(ANILIST_URL, json=body)
        if res.status_code != 200:
            raise HTTPException(status_code=500, detail="AniList query failed")
        return res.json().get("data", {})

@app.get("/")
async def home():
    return {"api": "Miruro API", "version": "3.1", "status": "running", "endpoints": ["/episodes/{anilist_id}", "/watch/{provider}/{anilist_id}/{category}/{slug}", "/sources", "/search", "/info/{anilist_id}", "/trending", "/popular", "/recent", "/schedule"], "cf_cookies": bool(_cf_cookies), "cf_cookie_age": round(time.time() - _cf_cookie_ts, 1) if _cf_cookie_ts else 0}

@app.get("/health")
async def health_check():
    """Health check — tests if miruro.tv pipe is accessible."""
    try:
        # Quick test: try to access the pipe with current cookies
        payload = {"path": "episodes", "method": "GET", "query": {"anilistId": 1}, "body": None, "version": "0.1.0"}
        encoded = _encode_pipe_request(payload)
        res = await asyncio.wait_for(_pipe_get(f"{MIRURO_PIPE_URL}?e={encoded}"), timeout=10)
        return {
            "status": "ok" if res.status_code == 200 else "degraded",
            "pipe_status": res.status_code,
            "cf_cookies_loaded": bool(_cf_cookies),
            "cf_cookie_age_seconds": round(time.time() - _cf_cookie_ts, 1) if _cf_cookie_ts else 0,
        }
    except asyncio.TimeoutError:
        return {"status": "degraded", "pipe_status": "timeout", "cf_cookies_loaded": bool(_cf_cookies), "cf_cookie_age_seconds": round(time.time() - _cf_cookie_ts, 1) if _cf_cookie_ts else 0}
    except Exception as e:
        return {"status": "error", "error": str(e), "cf_cookies_loaded": bool(_cf_cookies)}

@app.post("/cf-cookies")
async def set_cf_cookies(cookies: dict):
    """Manually set CF cookies (e.g., from browser DevTools).
    
    Usage: POST /cf-cookies {"cf_clearance": "...", "other_cookie": "..."}
    
    To get cookies from your browser:
    1. Visit https://www.miruro.tv/ in Chrome
    2. Open DevTools > Application > Cookies > https://www.miruro.tv
    3. Copy cf_clearance and any other miruro.tv cookies
    4. POST them here
    """
    global _cf_cookies, _cf_cookie_ts
    if not cookies:
        raise HTTPException(status_code=400, detail="No cookies provided")
    _cf_cookies = cookies
    _cf_cookie_ts = time.time()
    return {"status": "ok", "cookies_set": list(cookies.keys()), "message": "CF cookies updated. Episodes endpoint should now work."}

@app.post("/solve-cf")
async def trigger_cf_solve():
    """Manually trigger CF challenge solving via Playwright."""
    global _cf_cookies, _cf_cookie_ts
    try:
        new_cookies = await asyncio.wait_for(_solve_cf_challenge(), timeout=CF_SOLVE_TIMEOUT + 5)
        if new_cookies:
            _cf_cookies = new_cookies
            _cf_cookie_ts = time.time()
            return {"status": "ok", "cookies_found": list(new_cookies.keys()), "message": "CF challenge solved successfully"}
        return {"status": "failed", "message": "Playwright could not solve CF challenge — try /cf-cookies endpoint to set manually"}
    except asyncio.TimeoutError:
        return {"status": "timeout", "message": f"CF solve timed out after {CF_SOLVE_TIMEOUT}s — try /cf-cookies endpoint to set manually"}
    except Exception as e:
        return {"status": "error", "error": str(e)}

@app.get("/search")
async def search_anime(
    query: str,
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(20, ge=1, le=50, description="Results per page"),
):
    gql = f"""
    query ($search: String, $page: Int, $perPage: Int) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            media(search: $search, type: ANIME, sort: SEARCH_MATCH) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await _anilist_query(gql, {"search": query, "page": page, "perPage": per_page})
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})
    response = {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": page_data.get("media", []),
    }
    return _proxy_deep_images(response)

@app.get("/suggestions")
async def search_suggestions(
    query: str = Query(..., min_length=1, description="Search query for autocomplete"),
):
    gql = """
    query ($search: String) {
        Page(page: 1, perPage: 8) {
            media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                id
                title { romaji english }
                coverImage { large }
                format
                status
                startDate { year }
                episodes
            }
        }
    }
    """
    data = await _anilist_query(gql, {"search": query})
    results = []
    for item in data.get("Page", {}).get("media", []):
        results.append({
            "id": item["id"],
            "title": item["title"].get("english") or item["title"].get("romaji"),
            "title_romaji": item["title"].get("romaji"),
            "poster": item["coverImage"]["large"],
            "format": item.get("format"),
            "status": item.get("status"),
            "year": (item.get("startDate") or {}).get("year"),
            "episodes": item.get("episodes"),
        })
    return _proxy_deep_images({"suggestions": results})

SORT_MAP = {
    "SCORE_DESC": "SCORE_DESC",
    "POPULARITY_DESC": "POPULARITY_DESC",
    "TRENDING_DESC": "TRENDING_DESC",
    "START_DATE_DESC": "START_DATE_DESC",
    "FAVOURITES_DESC": "FAVOURITES_DESC",
    "UPDATED_AT_DESC": "UPDATED_AT_DESC",
}

@app.get("/filter")
async def filter_anime(
    genre: Optional[str] = Query(None, description="Genre name, e.g. Action, Romance"),
    tag: Optional[str] = Query(None, description="Tag name, e.g. Isekai, Time Skip"),
    year: Optional[int] = Query(None, description="Season year, e.g. 2025"),
    season: Optional[str] = Query(None, description="WINTER, SPRING, SUMMER, or FALL"),
    format: Optional[str] = Query(None, description="TV, MOVIE, OVA, ONA, SPECIAL, MUSIC"),
    status: Optional[str] = Query(None, description="RELEASING, FINISHED, NOT_YET_RELEASED, CANCELLED, HIATUS"),
    sort: str = Query("POPULARITY_DESC", description="Sort order"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
):
    args = ["type: ANIME", f"sort: [{SORT_MAP.get(sort, 'POPULARITY_DESC')}]"]
    variables = {"page": page, "perPage": per_page}

    if genre:
        args.append("genre: $genre")
        variables["genre"] = genre
    if tag:
        args.append("tag: $tag")
        variables["tag"] = tag
    if year:
        args.append("seasonYear: $seasonYear")
        variables["seasonYear"] = year
    if season:
        args.append("season: $season")
        variables["season"] = season.upper()
    if format:
        args.append("format: $format")
        variables["format"] = format.upper()
    if status:
        args.append("status: $status")
        variables["status"] = status.upper()

    var_types = ["$page: Int", "$perPage: Int"]
    if genre:
        var_types.append("$genre: String")
    if tag:
        var_types.append("$tag: String")
    if year:
        var_types.append("$seasonYear: Int")
    if season:
        var_types.append("$season: MediaSeason")
    if format:
        var_types.append("$format: MediaFormat")
    if status:
        var_types.append("$status: MediaStatus")

    gql = f"""
    query ({', '.join(var_types)}) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            media({', '.join(args)}) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await _anilist_query(gql, variables)
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})
    response = {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": page_data.get("media", []),
    }
    return _proxy_deep_images(response)

async def _fetch_collection(sort_type: str, status: str = None, page: int = 1, per_page: int = 20):
    status_filter = f", status: {status}" if status else ""
    gql = f"""
    query ($page: Int, $perPage: Int) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            media(type: ANIME, sort: [{sort_type}]{status_filter}) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await _anilist_query(gql, {"page": page, "perPage": per_page})
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})
    response = {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": page_data.get("media", []),
    }
    return _proxy_deep_images(response)

@app.get("/spotlight")
async def get_spotlight():
    gql = f"""
    query {{
        Page(page: 1, perPage: 10) {{
            media(sort: [TRENDING_DESC, POPULARITY_DESC], type: ANIME) {{
                {MEDIA_LIST_FIELDS}
            }}
        }}
    }}
    """
    data = await _anilist_query(gql)
    media = data.get("Page", {}).get("media", [])
    return _proxy_deep_images({"results": media})

@app.get("/trending")
async def get_trending(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
):
    return await _fetch_collection("TRENDING_DESC", page=page, per_page=per_page)

@app.get("/popular")
async def get_popular(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
):
    return await _fetch_collection("POPULARITY_DESC", page=page, per_page=per_page)

@app.get("/upcoming")
async def get_upcoming(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
):
    return await _fetch_collection("POPULARITY_DESC", "NOT_YET_RELEASED", page=page, per_page=per_page)

@app.get("/recent")
async def get_recent(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
):
    return await _fetch_collection("START_DATE_DESC", "RELEASING", page=page, per_page=per_page)

@app.get("/schedule")
async def get_schedule(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=50),
):
    gql = f"""
    query ($page: Int, $perPage: Int) {{
        Page(page: $page, perPage: $perPage) {{
            pageInfo {{ total currentPage lastPage hasNextPage perPage }}
            airingSchedules(notYetAired: true, sort: TIME) {{
                episode
                airingAt
                timeUntilAiring
                media {{
                    {MEDIA_LIST_FIELDS}
                }}
            }}
        }}
    }}
    """
    data = await _anilist_query(gql, {"page": page, "perPage": per_page})
    page_data = data.get("Page", {})
    page_info = page_data.get("pageInfo", {})
    results = []
    for item in page_data.get("airingSchedules", []):
        entry = item.get("media", {})
        entry["next_episode"] = item.get("episode")
        entry["airingAt"] = item.get("airingAt")
        entry["timeUntilAiring"] = item.get("timeUntilAiring")
        results.append(entry)
    response = {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "results": results,
    }
    return _proxy_deep_images(response)

@app.get("/info/{anilist_id}")
async def get_anime_info(anilist_id: int):
    gql = f"""
    query ($id: Int) {{
        Media(id: $id, type: ANIME) {{
            {MEDIA_FULL_FIELDS}
        }}
    }}
    """
    data = await _anilist_query(gql, {"id": anilist_id})
    media = data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")
    return _proxy_deep_images(media)

@app.get("/anime/{anilist_id}/characters")
async def get_anime_characters(
    anilist_id: int,
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=50),
):
    gql = """
    query ($id: Int, $page: Int, $perPage: Int) {
        Media(id: $id, type: ANIME) {
            id
            title { romaji english }
            characters(sort: [ROLE, RELEVANCE], page: $page, perPage: $perPage) {
                pageInfo { total currentPage lastPage hasNextPage perPage }
                edges {
                    role
                    node {
                        id
                        name { full native userPreferred }
                        image { large medium }
                        description
                        gender
                        dateOfBirth { year month day }
                        age
                        favourites
                        siteUrl
                    }
                    voiceActors {
                        id
                        name { full native }
                        image { large }
                        languageV2
                    }
                }
            }
        }
    }
    """
    data = await _anilist_query(gql, {"id": anilist_id, "page": page, "perPage": per_page})
    media = data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")
    chars = media.get("characters", {})
    page_info = chars.get("pageInfo", {})
    response = {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "characters": chars.get("edges", []),
    }
    return _proxy_deep_images(response)

@app.get("/anime/{anilist_id}/relations")
async def get_anime_relations(anilist_id: int):
    gql = """
    query ($id: Int) {
        Media(id: $id, type: ANIME) {
            id
            title { romaji english }
            relations {
                edges {
                    relationType(version: 2)
                    node {
                        id
                        title { romaji english native }
                        coverImage { large }
                        bannerImage
                        format
                        type
                        status
                        episodes
                        chapters
                        meanScore
                        averageScore
                        popularity
                        startDate { year month day }
                    }
                }
            }
        }
    }
    """
    data = await _anilist_query(gql, {"id": anilist_id})
    media = data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")
    response = {
        "id": media["id"],
        "title": media["title"],
        "relations": media.get("relations", {}).get("edges", []),
    }
    return _proxy_deep_images(response)

@app.get("/anime/{anilist_id}/recommendations")
async def get_anime_recommendations(
    anilist_id: int,
    page: int = Query(1, ge=1),
    per_page: int = Query(10, ge=1, le=25),
):
    gql = """
    query ($id: Int, $page: Int, $perPage: Int) {
        Media(id: $id, type: ANIME) {
            id
            title { romaji english }
            recommendations(sort: RATING_DESC, page: $page, perPage: $perPage) {
                pageInfo { total currentPage lastPage hasNextPage perPage }
                nodes {
                    rating
                    mediaRecommendation {
                        id
                        title { romaji english native }
                        coverImage { large extraLarge }
                        bannerImage
                        format
                        episodes
                        status
                        meanScore
                        averageScore
                        popularity
                        genres
                        startDate { year }
                    }
                }
            }
        }
    }
    """
    data = await _anilist_query(gql, {"id": anilist_id, "page": page, "perPage": per_page})
    media = data.get("Media")
    if not media:
        raise HTTPException(status_code=404, detail="Anime not found")
    recs = media.get("recommendations", {})
    page_info = recs.get("pageInfo", {})
    response = {
        "page": page_info.get("currentPage", page),
        "perPage": page_info.get("perPage", per_page),
        "total": page_info.get("total", 0),
        "hasNextPage": page_info.get("hasNextPage", False),
        "recommendations": recs.get("nodes", []),
    }
    return _proxy_deep_images(response)

@app.get("/episodes/{anilist_id}")
async def get_episodes(anilist_id: int):
    data = await _fetch_raw_episodes(anilist_id)
    return _proxy_deep_images(_inject_source_slugs(data, anilist_id))

@app.get("/sources")
async def get_sources(
    episodeId: str = Query(..., description="Plain-text episode ID from /episodes response"),
    provider: str = Query(..., description="Provider name, e.g. kiwi, arc, telli"),
    anilistId: int = Query(..., description="AniList anime ID"),
    category: str = Query("sub", description="sub or dub"),
):
    enc_id = base64.urlsafe_b64encode(episodeId.encode()).decode().rstrip('=')
    payload = {
        "path": "sources",
        "method": "GET",
        "query": {
            "episodeId": enc_id,
            "provider": provider,
            "category": category,
            "anilistId": anilistId,
        },
        "body": None,
        "version": "0.1.0",
    }
    encoded_req = _encode_pipe_request(payload)
    pipe_url = f"{MIRURO_PIPE_URL}?e={encoded_req}"
    
    try:
        res = await asyncio.wait_for(_pipe_get(pipe_url), timeout=SOURCES_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail={
            "error": "Sources request timed out",
            "detail": f"Pipe request timed out after {SOURCES_TIMEOUT}s. Cloudflare challenge may be blocking.",
        })
    
    if res.status_code != 200:
        body_preview = res.text[:500] if hasattr(res, 'text') else ''
        is_cf_challenge = 'Just a moment' in body_preview or 'challenge' in body_preview.lower()
        raise HTTPException(status_code=res.status_code, detail={
            "status": res.status_code,
            "body": body_preview,
            "cf_challenge": is_cf_challenge,
            "error": "Cloudflare challenge blocked the request" if is_cf_challenge else "Pipe request failed",
        })
    try:
        data = _decode_pipe_response(res.text.strip())
    except ValueError as e:
        raise HTTPException(status_code=502, detail={"error": "Failed to decode pipe response", "detail": str(e)})
    return _proxy_deep_images(data)

@app.get("/watch/{provider}/{anilist_id}/{category}/{slug}")
async def get_watch_sources(provider: str, anilist_id: int, category: str, slug: str):
    data = await _fetch_raw_episodes(anilist_id)
    prov_data = data.get("providers", {}).get(provider, {})
    ep_list = prov_data.get("episodes", {}).get(category, [])
    
    target_id = None
    for ep in ep_list:
        orig_id = ep.get("id", "")
        prefix = orig_id.split(":")[0] if ":" in orig_id else orig_id
        generated = f"{prefix}-{ep.get('number')}"
        if generated == slug:
            target_id = orig_id
            break
            
    if not target_id:
        raise HTTPException(status_code=404, detail=f"Episode slug '{slug}' not found for provider {provider}")
        
    return await get_sources(episodeId=target_id, provider=provider, anilistId=anilist_id, category=category)
