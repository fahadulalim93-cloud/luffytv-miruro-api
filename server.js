/**
 * AnimeX Scraper — server.js
 *
 * Standalone API server that scrapes animex.one for ALL providers.
 * Routes by AniList ID. Ready for VPS deployment.
 *
 * Features:
 *   - Dual REST hosts (pp.animex.one primary, chad.anidap.lol fallback)
 *   - 429 rate-limit handling with retry_after
 *   - Request throttling (max 2 concurrent upstream)
 *   - Sequential provider fetching to avoid 429
 *   - In-memory cache with 1h TTL
 *   - CORS enabled
 */

import express from "express";
import cors from "cors";

// ─── Config ────────────────────────────────────────────────────────────────────
const GRAPHQL_URL = "https://graphql.animex.one/graphql";

// Dual REST hosts — try pp.animex.one first, fallback to chad.anidap.lol
const REST_HOSTS = [
  "https://pp.animex.one/rest/api",
  "https://chad.anidap.lol/rest/api",
];

const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600000", 10);
const MAX_RETRIES = 3;

// ─── Upstream Headers ──────────────────────────────────────────────────────────
const UPSTREAM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.5",
  Origin: "https://animex.one",
  Referer: "https://animex.one/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
};

// ─── Provider Metadata ────────────────────────────────────────────────────────
const PROVIDER_INFO = {
  beep:  { name: "Beep",  tip: "Soft sub, Fast (Default sub)",  type: "hls" },
  mimi:  { name: "Mimi",  tip: "Soft sub, Fastest, High quality (Default dub)", type: "hls" },
  yuki:  { name: "Yuki",  tip: "Soft sub, Good, Multi quality", type: "hls" },
  neko:  { name: "Neko",  tip: "Hard sub, Fast, High quality",  type: "hls" },
  kiwi:  { name: "Kiwi",  tip: "Hard sub, Cloudflare-protected (anidb.app)", type: "hls" },
  sora:  { name: "Sora",  tip: "Soft sub, Fast, High quality",  type: "hls" },
  miku:  { name: "Miku",  tip: "Hard sub, Best Quality HLS",    type: "hls" },
  vee:   { name: "Vee",   tip: "Soft sub, DASH manifest",       type: "dash" },
  huzz:  { name: "Huzz",  tip: "Hard sub, HLS Alt",            type: "hls" },
  mochi: { name: "Mochi", tip: "Hard sub, MP4 with expiring token", type: "mp4" },
  uwu:   { name: "Uwu",   tip: "Hard sub, HLS (Same CDN as Miku)", type: "hls" },
  koto:  { name: "Koto",  tip: "Hard sub, HLS (Same CDN as Miku)", type: "hls" },
  kami:  { name: "Kami",  tip: "Alt provider",                  type: "hls" },
};

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
const slugCache = new Map();
const episodesCache = new Map();
const sourcesCache = new Map();

function isCacheFresh(timestamp) {
  return Date.now() - timestamp < CACHE_TTL;
}

// ─── Request Throttler ────────────────────────────────────────────────────────
class Throttler {
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      this.queue.shift()();
    }
  }
}

const throttler = new Throttler(2);

// ─── REST Fetch with 429 Retry + Host Fallback ────────────────────────────────
async function restFetch(path, options = {}) {
  await throttler.acquire();
  try {
    for (let hostIdx = 0; hostIdx < REST_HOSTS.length; hostIdx++) {
      const baseUrl = REST_HOSTS[hostIdx];
      const url = baseUrl + path;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const res = await fetch(url, {
          ...options,
          headers: { ...UPSTREAM_HEADERS, ...(options.headers || {}) },
        });

        if (res.ok) {
          return await res.json();
        }

        const text = await res.text().catch(() => "");
        let errorData;
        try { errorData = JSON.parse(text); } catch { errorData = {}; }

        // 429 — wait retry_after and retry
        if (res.status === 429) {
          const retryAfterMs = (errorData.retry_after || 5) * 1000;
          if (attempt < MAX_RETRIES) {
            console.warn(`[429] ${url} retry_after=${retryAfterMs}ms attempt=${attempt + 1}/${MAX_RETRIES}`);
            await new Promise((r) => setTimeout(r, retryAfterMs));
            continue;
          }
          console.warn(`[429] ${url} retries exhausted, trying next host`);
          break;
        }

        // 403 bot_detected — try next host
        if (res.status === 403 && (errorData.error === "bot_detected" || text.includes("bot_detected"))) {
          console.warn(`[403 bot] ${url} switching host`);
          break;
        }

        throw new Error(`API ${res.status}: ${url} — ${text.slice(0, 200)}`);
      }
    }
    throw new Error("All hosts failed for: " + path);
  } finally {
    throttler.release();
  }
}

// ─── GraphQL Fetch ─────────────────────────────────────────────────────────────
async function graphqlFetch(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { ...UPSTREAM_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("GraphQL " + res.status + ": " + text.slice(0, 200));
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GraphQL — AniList ID → Slug
// ═══════════════════════════════════════════════════════════════════════════════

async function resolveSlug(anilistId) {
  const cached = slugCache.get(anilistId);
  if (cached && isCacheFresh(cached.timestamp)) return cached;

  const data = await graphqlFetch(
    "query($id:Int!){anime(anilistId:$id){id anilistId titleEnglish titleRomaji}}",
    { id: anilistId }
  );

  const anime = data?.data?.anime;
  if (!anime?.id) throw new Error("Anime not found for AniList ID " + anilistId);

  const result = {
    slug: anime.id,
    anilistId: anime.anilistId,
    titleEnglish: anime.titleEnglish || "",
    titleRomaji: anime.titleRomaji || "",
    timestamp: Date.now(),
  };
  slugCache.set(anilistId, result);
  return result;
}

async function searchAnime(query) {
  const data = await graphqlFetch(
    "query($q:String!){searchAnime(query:$q){items{id anilistId titleEnglish titleRomaji}}}",
    { q: query }
  );
  return (data?.data?.searchAnime?.items || []).map((item) => ({
    slug: item.id,
    anilistId: item.anilistId,
    titleEnglish: item.titleEnglish || "",
    titleRomaji: item.titleRomaji || "",
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REST — Episodes, Servers, Sources
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchEpisodes(slug) {
  const cacheKey = "eps:" + slug;
  const cached = episodesCache.get(cacheKey);
  if (cached && isCacheFresh(cached.timestamp)) return cached.episodes;

  const episodes = await restFetch("/episodes?id=" + encodeURIComponent(slug));
  episodesCache.set(cacheKey, { episodes, timestamp: Date.now() });
  return episodes;
}

async function fetchServers(slug, epNum) {
  const data = await restFetch(
    "/servers?id=" + encodeURIComponent(slug) + "&epNum=" + epNum
  );
  const mapProvider = (p) => ({
    id: p.id,
    default: p.default || false,
    tip: p.tip || "",
    ...(PROVIDER_INFO[p.id] || {}),
  });
  return {
    sub: (data.subProviders || []).map(mapProvider),
    dub: (data.dubProviders || []).map(mapProvider),
  };
}

async function fetchSources(slug, epNum, type, providerId) {
  const cacheKey = "src:" + slug + ":" + epNum + ":" + type + ":" + providerId;
  const cached = sourcesCache.get(cacheKey);
  if (cached && isCacheFresh(cached.timestamp)) return cached.data;

  const data = await restFetch(
    "/sources?id=" + encodeURIComponent(slug) +
    "&epNum=" + epNum + "&type=" + type +
    "&providerId=" + encodeURIComponent(providerId)
  );

  const result = {
    provider: providerId,
    type,
    sources: (data.sources || []).map((s) => ({
      url: s.url,
      quality: s.quality || "auto",
      type: s.type || "video/mpegurl",
      isM3U8: (s.url || "").includes(".m3u8") || (s.type || "").includes("mpegurl"),
      isMP4: (s.url || "").includes(".mp4") || (s.type || "").includes("mp4"),
      isDASH: (s.url || "").includes(".mpd") || (s.type || "").includes("dash"),
    })),
    tracks: (data.tracks || [])
      .filter((t) => t.url && !t.url.startsWith("https:///"))
      .map((t) => ({
        id: t.id,
        url: t.url,
        lang: t.lang || "en",
        label: t.label || "English",
        kind: t.kind || "captions",
        default: t.default || false,
      })),
    chapters: (data.chapters || []).map((c) => ({
      title: c.title,
      start: c.start,
      end: c.end,
    })),
    headers: data.headers || {},
  };

  const intro = result.chapters.find((c) => c.title?.toLowerCase() === "intro");
  const outro = result.chapters.find((c) => c.title?.toLowerCase() === "outro");
  if (intro) result.intro = { start: intro.start, end: intro.end };
  if (outro) result.outro = { start: outro.start, end: outro.end };

  sourcesCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

async function fetchAllSources(slug, epNum, type = "sub") {
  const servers = await fetchServers(slug, epNum);
  const providerList = type === "dub" ? servers.dub : servers.sub;

  // SEQUENTIAL to avoid 429 rate limits
  const results = [];
  for (const p of providerList) {
    try {
      const data = await fetchSources(slug, epNum, type, p.id);
      if (data?.sources?.length > 0) {
        results.push({
          ...data,
          providerName: p.name || p.id,
          default: p.default || false,
          tip: p.tip || "",
        });
      }
    } catch (err) {
      console.warn("[fetchAllSources] " + p.id + " failed: " + err.message);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Express
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(req.method + " " + req.path + " → " + res.statusCode + " (" + (Date.now() - start) + "ms)");
  });
  next();
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "animex-scraper",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    hosts: REST_HOSTS,
    cache: { slugs: slugCache.size, episodes: episodesCache.size, sources: sourcesCache.size },
    throttler: { running: throttler.running, queued: throttler.queue.length },
  });
});

// Providers
app.get("/providers", (req, res) => {
  res.json({ providers: Object.entries(PROVIDER_INFO).map(([id, info]) => ({ id, ...info })) });
});

// Search
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing ?q= parameter" });
    const results = await searchAnime(q);
    res.json({ query: q, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anime Info
app.get("/anime/:anilistId", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    if (isNaN(anilistId)) return res.status(400).json({ error: "Invalid AniList ID" });
    const info = await resolveSlug(anilistId);
    res.json({ anilistId: info.anilistId, slug: info.slug, titleEnglish: info.titleEnglish, titleRomaji: info.titleRomaji });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Episodes
app.get("/anime/:anilistId/episodes", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    if (isNaN(anilistId)) return res.status(400).json({ error: "Invalid AniList ID" });
    const info = await resolveSlug(anilistId);
    const episodes = await fetchEpisodes(info.slug);
    const normalized = episodes.map((ep) => ({
      number: ep.number,
      title: ep.titles?.en || ep.titles?.en_jp || ep.titles?.romaji || "Episode " + ep.number,
      titles: ep.titles || {},
    }));
    res.json({ anilistId, slug: info.slug, title: info.titleEnglish || info.titleRomaji, totalEpisodes: normalized.length, episodes: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Servers
app.get("/anime/:anilistId/servers/:epNum", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    const epNum = parseInt(req.params.epNum, 10);
    if (isNaN(anilistId)) return res.status(400).json({ error: "Invalid AniList ID" });
    if (isNaN(epNum) || epNum < 1) return res.status(400).json({ error: "Invalid episode number" });
    const info = await resolveSlug(anilistId);
    const servers = await fetchServers(info.slug, epNum);
    res.json({ anilistId, slug: info.slug, title: info.titleEnglish || info.titleRomaji, episode: epNum, subProviders: servers.sub, dubProviders: servers.dub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stream
app.get("/anime/:anilistId/stream/:epNum", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    const epNum = parseInt(req.params.epNum, 10);
    const type = req.query.type === "dub" ? "dub" : "sub";
    const provider = req.query.provider || null;
    if (isNaN(anilistId)) return res.status(400).json({ error: "Invalid AniList ID" });
    if (isNaN(epNum) || epNum < 1) return res.status(400).json({ error: "Invalid episode number" });
    const info = await resolveSlug(anilistId);
    let results;
    if (provider) {
      const data = await fetchSources(info.slug, epNum, type, provider);
      results = data?.sources?.length > 0 ? [data] : [];
    } else {
      results = await fetchAllSources(info.slug, epNum, type);
    }
    res.json({ anilistId, slug: info.slug, title: info.titleEnglish || info.titleRomaji, episode: epNum, type, provider: provider || "all", count: results.length, streams: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Watch (combined)
app.get("/anime/:anilistId/watch/:epNum", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    const epNum = parseInt(req.params.epNum, 10);
    const type = req.query.type === "dub" ? "dub" : "sub";
    if (isNaN(anilistId)) return res.status(400).json({ error: "Invalid AniList ID" });
    if (isNaN(epNum) || epNum < 1) return res.status(400).json({ error: "Invalid episode number" });
    const info = await resolveSlug(anilistId);
    const [episodes, servers, streams] = await Promise.all([
      fetchEpisodes(info.slug).catch(() => []),
      fetchServers(info.slug, epNum).catch(() => ({ sub: [], dub: [] })),
      fetchAllSources(info.slug, epNum, type).catch(() => []),
    ]);
    const epInfo = episodes.find((e) => e.number === epNum);
    res.json({
      anilistId, slug: info.slug, title: info.titleEnglish || info.titleRomaji,
      episode: { number: epNum, title: epInfo?.titles?.en || epInfo?.titles?.en_jp || "Episode " + epNum },
      totalEpisodes: episodes.length, servers, streams,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cache clear
app.delete("/cache", (req, res) => {
  const sizes = { slugs: slugCache.size, episodes: episodesCache.size, sources: sourcesCache.size };
  slugCache.clear();
  episodesCache.clear();
  sourcesCache.clear();
  res.json({ cleared: true, ...sizes });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    endpoints: [
      "GET /health",
      "GET /providers",
      "GET /search?q=",
      "GET /anime/:anilistId",
      "GET /anime/:anilistId/episodes",
      "GET /anime/:anilistId/servers/:epNum",
      "GET /anime/:anilistId/stream/:epNum?type=sub&provider=",
      "GET /anime/:anilistId/watch/:epNum?type=sub",
      "DELETE /cache",
    ],
  });
});

// Start
app.listen(PORT, () => {
  console.log("\n  AnimeX Scraper API — Ready!\n");
  console.log("  Port:      " + PORT);
  console.log("  GraphQL:   graphql.animex.one");
  console.log("  REST:      pp.animex.one -> chad.anidap.lol (fallback)");
  console.log("  Cache TTL: " + CACHE_TTL + "ms");
  console.log("  Throttle:  max 2 concurrent");
  console.log("  Retry:     429 auto-retry with retry_after\n");
});
