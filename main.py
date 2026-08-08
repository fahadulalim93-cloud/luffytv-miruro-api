import base64, json, gzip, httpx, os
from curl_cffi.requests import AsyncSession
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Miruro API", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.tv/",
    "Origin": "https://www.miruro.tv",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "sec-ch-ua": '"Chromium";v="110", "Not A(Brand";v="24", "Google Chrome";v="110"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}
ANILIST_URL = "https://graphql.anilist.co"
MIRURO_PIPE_URL = "https://www.miruro.tv/api/secure/pipe"

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
    payload = {
        "path": "episodes",
        "method": "GET",
        "query": {"anilistId": anilist_id},
        "body": None,
        "version": "0.1.0",
    }
    encoded_req = _encode_pipe_request(payload)
    async with AsyncSession(impersonate="chrome110") as client:
        res = await client.get(f"{MIRURO_PIPE_URL}?e={encoded_req}", headers=HEADERS)
        if res.status_code != 200:
            raise HTTPException(status_code=res.status_code, detail={"status": res.status_code, "body": res.text[:500], "headers": dict(res.headers)})
        data = _decode_pipe_response(res.text.strip())
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

@app.get("/", response_class=HTMLResponse)
async def home():
    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Miruro API v3.0</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#03040a;--surface:rgba(255,255,255,0.03);--border:rgba(255,255,255,0.07);
  --blue:#38bdf8;--purple:#818cf8;--green:#34d399;--amber:#fbbf24;
  --text:#e2e8f0;--muted:#64748b;--dim:#334155;
  --font:'Inter',sans-serif;--mono:'JetBrains Mono',monospace;
}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased}

/* ── canvas bg ── */
#bg{position:fixed;inset:0;z-index:0;pointer-events:none}

/* ── notice banner ── */
.notice{position:relative;z-index:10;background:linear-gradient(90deg,rgba(251,191,36,.12),rgba(251,191,36,.06));border-bottom:1px solid rgba(251,191,36,.2);padding:11px 20px;text-align:center;font-size:.82em;color:#fde68a;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
.notice strong{color:#fbbf24}
.notice-icon{font-size:1em;flex-shrink:0}

/* ── layout ── */
.wrap{position:relative;z-index:1;max-width:860px;margin:0 auto;padding:60px 20px 80px}

/* ── hero ── */
.hero{text-align:center;padding:50px 0 60px;perspective:1000px}
.logo-wrap{display:inline-block;margin-bottom:28px;animation:float 6s ease-in-out infinite}
.logo-wrap img{width:88px;border-radius:22px;box-shadow:0 0 0 1px var(--border),0 20px 60px rgba(56,189,248,.2);display:block}
@keyframes float{0%,100%{transform:translateY(0) rotateY(0deg)}50%{transform:translateY(-8px) rotateY(6deg)}}
h1{font-size:clamp(2rem,6vw,3.2rem);font-weight:700;letter-spacing:-.03em;line-height:1.1;margin-bottom:14px}
.grad{background:linear-gradient(135deg,#fff 0%,var(--blue) 50%,var(--purple) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sub{color:var(--muted);font-size:1em;font-weight:400;max-width:480px;margin:0 auto 20px;line-height:1.6}
.chip{display:inline-flex;align-items:center;gap:6px;background:rgba(56,189,248,.08);color:var(--blue);border:1px solid rgba(56,189,248,.18);border-radius:999px;padding:5px 14px;font-size:.78em;font-weight:500;letter-spacing:.04em}
.chip::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}

/* ── section ── */
.section{margin-top:56px}
.section-head{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.section-head h2{font-size:.7em;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.section-line{flex:1;height:1px;background:var(--border)}

/* ── card ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 24px;margin-bottom:10px;cursor:default;will-change:transform;transition:transform .2s cubic-bezier(.23,1,.32,1),box-shadow .2s cubic-bezier(.23,1,.32,1),border-color .2s;transform-style:preserve-3d}
.card:hover{transform:translateY(-3px) scale(1.005);box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 0 1px rgba(56,189,248,.12);border-color:rgba(56,189,248,.18)}
.card-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.method{font-family:var(--mono);font-size:.72em;font-weight:500;background:rgba(52,211,153,.1);color:var(--green);border:1px solid rgba(52,211,153,.2);padding:3px 9px;border-radius:6px;letter-spacing:.04em}
.path{font-family:var(--mono);font-size:.92em;color:var(--text);font-weight:500}
.badge{font-size:.65em;padding:2px 7px;border-radius:5px;font-weight:600;letter-spacing:.05em}
.b-new{background:rgba(52,211,153,.12);color:var(--green);border:1px solid rgba(52,211,153,.25)}
.b-hot{background:rgba(251,191,36,.1);color:var(--amber);border:1px solid rgba(251,191,36,.2)}
.b-rec{background:rgba(129,140,248,.12);color:var(--purple);border:1px solid rgba(129,140,248,.25)}
.desc{color:var(--muted);font-size:.87em;line-height:1.65;margin-top:12px}
.desc b{color:var(--text);font-weight:500}
.params{font-family:var(--mono);font-size:.78em;color:var(--dim);margin-top:10px;line-height:1.9}
.params em{color:var(--blue);font-style:normal}
.try{display:inline-flex;align-items:center;gap:5px;margin-top:12px;font-size:.8em;color:var(--blue);text-decoration:none;border:1px solid rgba(56,189,248,.15);border-radius:7px;padding:4px 10px;transition:background .15s,border-color .15s}
.try:hover{background:rgba(56,189,248,.08);border-color:rgba(56,189,248,.3)}
.try::after{content:'↗';font-size:.9em}
.returns{font-size:.8em;color:var(--dim);margin-top:10px;line-height:1.7}
.returns b{color:#a5b4fc;font-weight:500}

/* ── step cards ── */
.step-card{border-radius:14px;padding:22px 24px;margin-bottom:10px;border:1px solid var(--border);will-change:transform;transition:transform .2s cubic-bezier(.23,1,.32,1),box-shadow .2s}
.step-card:hover{transform:translateY(-3px);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.step1{background:linear-gradient(135deg,rgba(56,189,248,.05),rgba(56,189,248,.02))}
.step2{background:linear-gradient(135deg,rgba(52,211,153,.05),rgba(52,211,153,.02));border-color:rgba(52,211,153,.15)}
.step3{background:linear-gradient(135deg,rgba(129,140,248,.05),rgba(129,140,248,.02));border-color:rgba(129,140,248,.15)}
.step-num{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-size:.78em;font-weight:700;margin-right:8px;flex-shrink:0}
.s1{background:rgba(56,189,248,.12);color:var(--blue);border:1px solid rgba(56,189,248,.25)}
.s2{background:rgba(52,211,153,.12);color:var(--green);border:1px solid rgba(52,211,153,.25)}
.s3{background:rgba(129,140,248,.12);color:var(--purple);border:1px solid rgba(129,140,248,.25)}

/* ── code ── */
pre{background:rgba(0,0,0,.4);border:1px solid var(--border);border-radius:10px;padding:16px;font-family:var(--mono);font-size:.76em;color:#94a3b8;overflow-x:auto;margin-top:14px;line-height:1.7;tab-size:2}
code{font-family:var(--mono);font-size:.85em;color:#a5b4fc;background:rgba(165,180,252,.07);padding:1px 5px;border-radius:4px}

/* ── param table ── */
.ptable{width:100%;margin-top:14px;border-collapse:collapse;font-size:.8em}
.ptable th{text-align:left;color:var(--purple);font-weight:500;padding:7px 10px;border-bottom:1px solid var(--border);font-size:.9em}
.ptable td{padding:7px 10px;color:var(--muted);border-bottom:1px solid rgba(255,255,255,.025)}
.ptable td:first-child{font-family:var(--mono);color:#a5b4fc;white-space:nowrap}

/* ── alert ── */
.alert{border-radius:10px;padding:13px 16px;font-size:.83em;line-height:1.6;margin-top:14px}
.alert-yellow{background:rgba(251,191,36,.06);border:1px solid rgba(251,191,36,.15);color:#fde68a}
.alert-yellow b{color:var(--amber)}
.alert-green{background:rgba(52,211,153,.06);border:1px solid rgba(52,211,153,.15);color:#6ee7b7}
.alert-green b{color:var(--green)}

/* ── footer ── */
.footer{text-align:center;margin-top:72px;padding-top:28px;border-top:1px solid var(--border);color:var(--dim);font-size:.82em;line-height:2}
.footer a{color:var(--blue);text-decoration:none;font-weight:500}
.footer a:hover{color:var(--purple)}

@media(max-width:600px){
  .wrap{padding:40px 14px 60px}
  .hero{padding:36px 0 44px}
  .card,.step-card{padding:18px}
  pre{font-size:.7em}
}
</style>
</head>
<body>

<canvas id="bg"></canvas>

<!-- ── notice ── -->
<div class="notice">
  <span class="notice-icon">⚠️</span>
  <span><strong>Hosting Notice:</strong> Miruro now has Cloudflare protection on the pipe endpoint. <strong>Do not deploy on Vercel</strong> — its IPs are datacenter-blocked by CF. Use a <strong>VPS with a residential or non-datacenter IP</strong> instead.</span>
</div>

<div class="wrap">

  <!-- ── hero ── -->
  <div class="hero">
    <div class="logo-wrap">
      <img src="https://www.miruro.to/assets/logo-Dnw3w3dS.png?v=1.12.0" alt="Miruro">
    </div>
    <h1><span class="grad">Miruro API</span></h1>
    <p class="sub">Reverse-engineered anime streaming API. Episodes, sources, metadata — all in one place.</p>
    <div class="chip">v3.0 &nbsp;·&nbsp; Live</div>
  </div>

  <!-- ── search ── -->
  <div class="section">
    <div class="section-head"><h2>Search &amp; Discovery</h2><div class="section-line"></div></div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/search</span></div>
      <p class="desc">Search anime by name. Returns full metadata — title, cover, banner, genres, studios, scores, airing status, and more.</p>
      <div class="params">Params: <em>query</em> (required) &nbsp;·&nbsp; <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=20</div>
      <div class="returns">Returns: <b>page</b>, <b>perPage</b>, <b>total</b>, <b>hasNextPage</b>, <b>results[]</b> (20+ fields each)</div>
      <a class="try" href="/search?query=naruto&page=1&per_page=5" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/suggestions</span><span class="badge b-new">NEW</span></div>
      <p class="desc">Lightweight autocomplete search. Returns only essentials: id, title, poster, format, status, year, episode count. Max 8 results.</p>
      <div class="params">Params: <em>query</em> (required)</div>
      <a class="try" href="/suggestions?query=one piece" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/spotlight</span><span class="badge b-hot">HOT</span></div>
      <p class="desc">Top 10 anime currently trending and popular globally. Perfect for hero banners and home carousels.</p>
      <a class="try" href="/spotlight" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/filter</span><span class="badge b-new">NEW</span></div>
      <p class="desc">Advanced filter and browse. All params are optional — combine freely.</p>
      <table class="ptable">
        <tr><th>Param</th><th>Values</th></tr>
        <tr><td>genre</td><td>Action, Romance, Comedy, Drama, Fantasy, Sci-Fi …</td></tr>
        <tr><td>tag</td><td>Isekai, Time Skip, Reincarnation …</td></tr>
        <tr><td>year</td><td>2025, 2024 …</td></tr>
        <tr><td>season</td><td>WINTER · SPRING · SUMMER · FALL</td></tr>
        <tr><td>format</td><td>TV · MOVIE · OVA · ONA · SPECIAL</td></tr>
        <tr><td>status</td><td>RELEASING · FINISHED · NOT_YET_RELEASED · CANCELLED</td></tr>
        <tr><td>sort</td><td>SCORE_DESC · POPULARITY_DESC · TRENDING_DESC · START_DATE_DESC</td></tr>
        <tr><td>page / per_page</td><td>Pagination (default 1 / 20)</td></tr>
      </table>
      <a class="try" href="/filter?genre=Action&format=TV&sort=SCORE_DESC&per_page=5" target="_blank">Try it</a>
    </div>
  </div>

  <!-- ── collections ── -->
  <div class="section">
    <div class="section-head"><h2>Collections</h2><div class="section-line"></div></div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/trending</span></div>
      <p class="desc">Currently trending anime across the community.</p>
      <div class="params">Params: <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=20</div>
      <a class="try" href="/trending?per_page=5" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/popular</span></div>
      <p class="desc">Most popular anime of all time by total user count.</p>
      <div class="params">Params: <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=20</div>
      <a class="try" href="/popular" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/upcoming</span></div>
      <p class="desc">Most anticipated anime not yet aired.</p>
      <div class="params">Params: <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=20</div>
      <a class="try" href="/upcoming" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/recent</span></div>
      <p class="desc">Currently airing / this season's anime.</p>
      <div class="params">Params: <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=20</div>
      <a class="try" href="/recent" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/schedule</span></div>
      <p class="desc">Next episodes airing soon — includes <b>airingAt</b> (UNIX), <b>timeUntilAiring</b> (seconds), and <b>next_episode</b> number.</p>
      <div class="params">Params: <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=20</div>
      <a class="try" href="/schedule" target="_blank">Try it</a>
    </div>
  </div>

  <!-- ── details ── -->
  <div class="section">
    <div class="section-head"><h2>Anime Details</h2><div class="section-line"></div></div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/info/{anilist_id}</span></div>
      <p class="desc">Complete anime detail page in one request — title, description, cover, banner, format, season, scores, genres, <b>tags</b>, <b>studios</b>, <b>characters</b>, <b>staff</b>, <b>relations</b>, <b>recommendations</b>, <b>trailer</b>, <b>external links</b>, stats, and more.</p>
      <a class="try" href="/info/20" target="_blank">Try /info/20</a>
      <a class="try" href="/info/21" target="_blank" style="margin-left:6px">Try /info/21</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/anime/{id}/characters</span></div>
      <p class="desc">Paginated character list — name, image, role (MAIN / SUPPORTING), Japanese voice actors with images.</p>
      <div class="params">Params: <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=25</div>
      <a class="try" href="/anime/20/characters" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/anime/{id}/relations</span></div>
      <p class="desc">All related media — sequels, prequels, side stories, spin-offs, source material. Each entry includes relation type and basic metadata.</p>
      <a class="try" href="/anime/20/relations" target="_blank">Try it</a>
    </div>

    <div class="card">
      <div class="card-top"><span class="method">GET</span><span class="path">/anime/{id}/recommendations</span></div>
      <p class="desc">Community "if you liked X, try Y" recommendations sorted by rating.</p>
      <div class="params">Params: <em>page</em>=1 &nbsp;·&nbsp; <em>per_page</em>=10</div>
      <a class="try" href="/anime/20/recommendations" target="_blank">Try it</a>
    </div>
  </div>

  <!-- ── streaming ── -->
  <div class="section">
    <div class="section-head"><h2>Streaming — 3-Step Flow</h2><div class="section-line"></div></div>

    <div class="alert alert-yellow" style="margin-bottom:16px">
      <b>How it works:</b> Follow these 3 steps in order. Each step's output feeds directly into the next.
    </div>

    <div class="step-card step1">
      <div class="card-top"><span class="step-num s1">1</span><span class="method">GET</span><span class="path">/episodes/{anilist_id}</span></div>
      <p class="desc">Get all available episodes across multiple providers (kiwi, arc, zoro, hop …) organised by audio type (sub / dub).</p>
      <div class="returns">Returns: <b>mappings</b> (AniList / MAL / Kitsu IDs) + <b>providers</b> (episode lists per provider)</div>
<pre>{
  "mappings": { "anilistId": 178005, "malId": 56885, ... },
  "providers": {
    "kiwi": {
      "episodes": {
        "sub": [
          {
            "id": "watch/kiwi/178005/sub/animepahe-1",
            "number": 1,
            "title": "Episode Title",
            "image": "https://...",
            "airDate": "2026-01-04",
            "duration": 1420,
            "filler": false
          }
        ]
      }
    }
  }
}</pre>
      <a class="try" href="/episodes/178005" target="_blank">Try it</a>
    </div>

    <div class="step-card step2">
      <div class="card-top"><span class="step-num s2">2</span><span class="path">/watch/{provider}/{anilistId}/{category}/{slug}</span><span class="badge b-rec">RECOMMENDED</span></div>
      <p class="desc">Take the <b>id</b> from Step 1 and use it directly as the URL — no extra params needed.</p>
      <a class="try" href="/watch/kiwi/178005/sub/animepahe-1" target="_blank">Try it</a>
<pre>{
  "streams": [
    { "url": "https://.../master.m3u8", "type": "hls", "quality": "1080p" }
  ],
  "subtitles": [ { "file": "...", "label": "English" } ],
  "intro":  { "start": 0,    "end": 90   },
  "outro":  { "start": 1300, "end": 1420 }
}</pre>
      <div class="alert alert-green" style="margin-top:14px;font-size:.78em">
        <b>Alternative:</b> <code>GET /sources?episodeId=...&amp;provider=...&amp;anilistId=...&amp;category=...</code>
      </div>
    </div>

    <div class="step-card step3">
      <div class="card-top"><span class="step-num s3">3</span><span class="path" style="color:var(--purple)">Play the stream</span></div>
      <p class="desc">Feed <b>streams[0].url</b> into any HLS player — Video.js, hls.js, VLC, mpv. Subtitles are hard-subbed (kiwi/pahe) or in the <b>subtitles[]</b> array (zoro/arc). Use <b>intro/outro</b> timestamps for skip buttons.</p>
    </div>
  </div>

  <div class="footer">
    All collection endpoints return <code>{ page, perPage, total, hasNextPage, results[] }</code>
    <br>
    Built by Walter &nbsp;·&nbsp; <a href="https://github.com/walterwhite-69" target="_blank">github.com/walterwhite-69</a>
  </div>

</div>

<script>
(function(){
  const c=document.getElementById('bg'),x=c.getContext('2d');
  let W,H,pts=[];
  const N=60,COLOR='rgba(56,189,248,';
  function resize(){W=c.width=innerWidth;H=c.height=innerHeight;pts=Array.from({length:N},()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,r:Math.random()*1.5+.5}))}
  function draw(){
    x.clearRect(0,0,W,H);
    for(let i=0;i<N;i++){
      const p=pts[i];
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<0||p.x>W)p.vx*=-1;
      if(p.y<0||p.y>H)p.vy*=-1;
      x.beginPath();x.arc(p.x,p.y,p.r,0,6.28);x.fillStyle=COLOR+'.4)';x.fill();
      for(let j=i+1;j<N;j++){
        const q=pts[j],dx=p.x-q.x,dy=p.y-q.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<140){x.beginPath();x.moveTo(p.x,p.y);x.lineTo(q.x,q.y);x.strokeStyle=COLOR+(1-d/140)*.08+')';x.lineWidth=.6;x.stroke()}
      }
    }
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize',resize);resize();draw();

  /* 3-D tilt on cards */
  document.querySelectorAll('.card,.step-card').forEach(el=>{
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
      const rx=((e.clientY-cy)/r.height)*6,ry=-((e.clientX-cx)/r.width)*6;
      el.style.transform=`perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-3px)`;
    });
    el.addEventListener('mouseleave',()=>el.style.transform='');
  });
})();
</script>
</body>
</html>"""

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
    async with AsyncSession(impersonate="chrome110") as client:
        res = await client.get(f"{MIRURO_PIPE_URL}?e={encoded_req}", headers=HEADERS)
        if res.status_code != 200:
            raise HTTPException(status_code=res.status_code, detail={"status": res.status_code, "body": res.text[:500], "headers": dict(res.headers)})
        return _proxy_deep_images(_decode_pipe_response(res.text.strip()))

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
