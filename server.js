/**
 * AnimeX Scraper — server.js
 *
 * Standalone API server that scrapes animex.one for ALL providers.
 * Routes by AniList ID. Ready for VPS deployment.
 *
 * API Endpoints:
 *   GET /health                          — Health check
 *   GET /anime/:anilistId                — Anime info (slug, title)
 *   GET /anime/:anilistId/episodes       — Episode list
 *   GET /anime/:anilistId/servers/:epNum — Available sub/dub providers
 *   GET /anime/:anilistId/stream/:epNum  — Stream URLs for ALL providers
 *          ?type=sub|dub                 — Filter by type (default: sub)
 *          ?provider=beep                — Specific provider (default: all)
 *   GET /search?q=naruto                 — Search anime by name
 *   GET /providers                       — List all known providers
 *
 * Architecture:
 *   1. AniList ID → GraphQL (graphql.animex.one) → anime slug
 *   2. Slug → REST API (chad.anidap.lol) → episodes/servers/sources
 *   3. Sources include m3u8/mp4 URLs, subtitle tracks, chapters
 *   4. Slug cache (in-memory, 1h TTL) avoids repeated GraphQL calls
 */

import express from "express";
import cors from "cors";

// ─── Config, entry point ──────────────────────────────────────────────────────
const GRAPHQL_URL = "https://graphql.animex.one/graphql";
const REST_BASE = "https://chad.anidap.lol/rest/api";
const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600000", 10); // 1 hour default

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
const slugCache = new Map(); // anilistId → {slug, title, timestamp}
const episodesCache = new Map(); // slug → {episodes, timestamp}
const sourcesCache = new Map(); // key → {data, timestamp}

function isCacheFresh(timestamp) {
  return Date.now() - timestamp < CACHE_TTL;
}

// ─── Fetch Helper ─────────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...UPSTREAM_HEADERS, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${url} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GRAPHQL — AniList ID → Slug
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve AniList ID to animex slug
 */
async function resolveSlug(anilistId) {
  const cached = slugCache.get(anilistId);
  if (cached && isCacheFresh(cached.timestamp)) {
    return cached;
  }

  const data = await apiFetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($id:Int!){anime(anilistId:$id){id anilistId titleEnglish titleRomaji}}`,
      variables: { id: anilistId },
    }),
  });

  const anime = data?.data?.anime;
  if (!anime?.id) {
    throw new Error(`Anime not found for AniList ID ${anilistId}`);
  }

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

/**
 * Search anime by name
 */
async function searchAnime(query) {
  const data = await apiFetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($q:String!){searchAnime(query:$q){items{id anilistId titleEnglish titleRomaji}}}`,
      variables: { q: query },
    }),
  });

  return (data?.data?.searchAnime?.items || []).map((item) => ({
    slug: item.id,
    anilistId: item.anilistId,
    titleEnglish: item.titleEnglish || "",
    titleRomaji: item.titleRomaji || "",
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REST API — Episodes, Servers, Sources
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch episode list for an anime slug
 */
async function fetchEpisodes(slug) {
  const cacheKey = `eps:${slug}`;
  const cached = episodesCache.get(cacheKey);
  if (cached && isCacheFresh(cached.timestamp)) {
    return cached.episodes;
  }

  const episodes = await apiFetch(
    `${REST_BASE}/episodes?id=${encodeURIComponent(slug)}`
  );

  episodesCache.set(cacheKey, { episodes, timestamp: Date.now() });
  return episodes;
}

/**
 * Fetch available servers (providers) for an episode
 */
async function fetchServers(slug, epNum) {
  const data = await apiFetch(
    `${REST_BASE}/servers?id=${encodeURIComponent(slug)}&epNum=${epNum}`
  );

  return {
    sub: (data.subProviders || []).map((p) => ({
      id: p.id,
      default: p.default || false,
      tip: p.tip || "",
      ...(PROVIDER_INFO[p.id] || {}),
    })),
    dub: (data.dubProviders || []).map((p) => ({
      id: p.id,
      default: p.default || false,
      tip: p.tip || "",
      ...(PROVIDER_INFO[p.id] || {}),
    })),
  };
}

/**
 * Fetch sources (stream URLs, subtitles, chapters) for a specific provider
 */
async function fetchSources(slug, epNum, type, providerId) {
  const cacheKey = `src:${slug}:${epNum}:${type}:${providerId}`;
  const cached = sourcesCache.get(cacheKey);
  if (cached && isCacheFresh(cached.timestamp)) {
    return cached.data;
  }

  const data = await apiFetch(
    `${REST_BASE}/sources?id=${encodeURIComponent(slug)}&epNum=${epNum}&type=${type}&providerId=${encodeURIComponent(providerId)}`
  );

  // Normalize the response
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
      .filter((t) => t.url) // skip broken subtitle URLs
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

  // Extract intro/outro from chapters
  const intro = result.chapters.find(
    (c) => c.title?.toLowerCase() === "intro"
  );
  const outro = result.chapters.find(
    (c) => c.title?.toLowerCase() === "outro"
  );
  if (intro) result.intro = { start: intro.start, end: intro.end };
  if (outro) result.outro = { start: outro.start, end: outro.end };

  sourcesCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}

/**
 * Fetch sources from ALL providers for a given episode
 */
async function fetchAllSources(slug, epNum, type = "sub") {
  const servers = await fetchServers(slug, epNum);
  const providerList = type === "dub" ? servers.dub : servers.sub;

  // Fetch all providers in parallel
  const results = await Promise.allSettled(
    providerList.map((p) =>
      fetchSources(slug, epNum, type, p.id).then((data) => ({
        ...data,
        providerName: p.name || p.id,
        default: p.default || false,
        tip: p.tip || "",
      }))
    )
  );

  return results
    .filter((r) => r.status === "fulfilled" && r.value?.sources?.length > 0)
    .map((r) => r.value);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS APP
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "animex-scraper",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    cache: {
      slugs: slugCache.size,
      episodes: episodesCache.size,
      sources: sourcesCache.size,
    },
  });
});

// ─── Providers list ────────────────────────────────────────────────────────────
app.get("/providers", (req, res) => {
  res.json({
    providers: Object.entries(PROVIDER_INFO).map(([id, info]) => ({
      id,
      ...info,
    })),
  });
});

// ─── Search ────────────────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing ?q= parameter" });

    const results = await searchAnime(q);
    res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error("[search]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Anime Info (resolve AniList ID → slug + title) ────────────────────────────
app.get("/anime/:anilistId", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    if (isNaN(anilistId))
      return res.status(400).json({ error: "Invalid AniList ID" });

    const info = await resolveSlug(anilistId);
    res.json({
      anilistId: info.anilistId,
      slug: info.slug,
      titleEnglish: info.titleEnglish,
      titleRomaji: info.titleRomaji,
    });
  } catch (err) {
    console.error("[anime]", err.message);
    res.status(404).json({ error: err.message });
  }
});

// ─── Episodes ──────────────────────────────────────────────────────────────────
app.get("/anime/:anilistId/episodes", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    if (isNaN(anilistId))
      return res.status(400).json({ error: "Invalid AniList ID" });

    const info = await resolveSlug(anilistId);
    const episodes = await fetchEpisodes(info.slug);

    // Normalize episode format
    const normalized = episodes.map((ep) => ({
      number: ep.number,
      title:
        ep.titles?.en ||
        ep.titles?.en_jp ||
        ep.titles?.romaji ||
        `Episode ${ep.number}`,
      titles: ep.titles || {},
    }));

    res.json({
      anilistId,
      slug: info.slug,
      title: info.titleEnglish || info.titleRomaji,
      totalEpisodes: normalized.length,
      episodes: normalized,
    });
  } catch (err) {
    console.error("[episodes]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Servers (available providers) ────────────────────────────────────────────
app.get("/anime/:anilistId/servers/:epNum", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    const epNum = parseInt(req.params.epNum, 10);
    if (isNaN(anilistId))
      return res.status(400).json({ error: "Invalid AniList ID" });
    if (isNaN(epNum) || epNum < 1)
      return res.status(400).json({ error: "Invalid episode number" });

    const info = await resolveSlug(anilistId);
    const servers = await fetchServers(info.slug, epNum);

    res.json({
      anilistId,
      slug: info.slug,
      title: info.titleEnglish || info.titleRomaji,
      episode: epNum,
      subProviders: servers.sub,
      dubProviders: servers.dub,
    });
  } catch (err) {
    console.error("[servers]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Stream (source URLs) ─────────────────────────────────────────────────────
app.get("/anime/:anilistId/stream/:epNum", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    const epNum = parseInt(req.params.epNum, 10);
    const type = req.query.type === "dub" ? "dub" : "sub";
    const provider = req.query.provider || null;

    if (isNaN(anilistId))
      return res.status(400).json({ error: "Invalid AniList ID" });
    if (isNaN(epNum) || epNum < 1)
      return res.status(400).json({ error: "Invalid episode number" });

    const info = await resolveSlug(anilistId);

    let results;
    if (provider) {
      // Single provider
      const data = await fetchSources(info.slug, epNum, type, provider);
      results = data?.sources?.length > 0 ? [data] : [];
    } else {
      // ALL providers
      results = await fetchAllSources(info.slug, epNum, type);
    }

    res.json({
      anilistId,
      slug: info.slug,
      title: info.titleEnglish || info.titleRomaji,
      episode: epNum,
      type,
      provider: provider || "all",
      count: results.length,
      streams: results,
    });
  } catch (err) {
    console.error("[stream]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Combined endpoint — everything for a single episode in one call ──────────
app.get("/anime/:anilistId/watch/:epNum", async (req, res) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    const epNum = parseInt(req.params.epNum, 10);
    const type = req.query.type === "dub" ? "dub" : "sub";

    if (isNaN(anilistId))
      return res.status(400).json({ error: "Invalid AniList ID" });
    if (isNaN(epNum) || epNum < 1)
      return res.status(400).json({ error: "Invalid episode number" });

    const info = await resolveSlug(anilistId);

    // Fetch episodes + servers + all sources in parallel
    const [episodes, servers, streams] = await Promise.all([
      fetchEpisodes(info.slug).catch(() => []),
      fetchServers(info.slug, epNum).catch(() => ({ sub: [], dub: [] })),
      fetchAllSources(info.slug, epNum, type).catch(() => []),
    ]);

    const epInfo = episodes.find((e) => e.number === epNum);

    res.json({
      anilistId,
      slug: info.slug,
      title: info.titleEnglish || info.titleRomaji,
      episode: {
        number: epNum,
        title:
          epInfo?.titles?.en ||
          epInfo?.titles?.en_jp ||
          `Episode ${epNum}`,
      },
      totalEpisodes: episodes.length,
      servers,
      streams,
    });
  } catch (err) {
    console.error("[watch]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Cache management ──────────────────────────────────────────────────────────
app.delete("/cache", (req, res) => {
  const sizes = {
    slugs: slugCache.size,
    episodes: episodesCache.size,
    sources: sourcesCache.size,
  };
  slugCache.clear();
  episodesCache.clear();
  sourcesCache.clear();
  res.json({ cleared: true, ...sizes });
});

// ─── 404 ───────────────────────────────────────────────────────────────────────
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

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║       AnimeX Scraper API — Ready!                ║
║                                                   ║
║  Port:      ${PORT.toString().padEnd(36)}║
║  GraphQL:   graphql.animex.one${" ".repeat(23)}║
║  REST:      chad.anidap.lol/rest/api${" ".repeat(17)}║
║  Cache TTL: ${CACHE_TTL}ms${" ".repeat(28 - CACHE_TTL.toString().length)}║
║                                                   ║
║  Endpoints:                                       ║
║    GET /health                                    ║
║    GET /providers                                 ║
║    GET /search?q=naruto                           ║
║    GET /anime/:anilistId                          ║
║    GET /anime/:anilistId/episodes                 ║
║    GET /anime/:anilistId/servers/:epNum           ║
║    GET /anime/:anilistId/stream/:epNum?type=sub   ║
║    GET /anime/:anilistId/watch/:epNum?type=sub    ║
╚══════════════════════════════════════════════════╝
  `);
});
