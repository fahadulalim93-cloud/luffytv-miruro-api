/**
 * LuffyTV Miruro API — Combined Server v7.0
 *
 * THREE providers running in parallel:
 *   - /anidap/*  — anidap.lol (native API: search + AniList ID lookup + chad.anidap.lol REST)
 *   - /kaa/*     — kaa.lt (fsearch API, episode servers, HLS via krussdomi)
 *   - /mkissa/*  — mkissa.to (encrypted API, multi-embed extractor, m3u8/mp4)
 *
 * Unified routes (/search, /anilist/:id/episodes) try ALL providers.
 */

import express from "express";
import cors from "cors";
import compression from "compression";
import crypto from "node:crypto";
import { gotScraping } from "got-scraping";

const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600000", 10);  // 1hr default
const CACHE_TTL_LONG = CACHE_TTL * 4;  // 4hr for stable data (slug mapping)

// ─── Shared Cache ──────────────────────────────────────────────────────────────
const cache = new Map();
function getCached(key) { const e = cache.get(key); if (e && Date.now() - e.ts < CACHE_TTL) return e.data; cache.delete(key); return null; }
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ─── Shared Throttler ──────────────────────────────────────────────────────────
class Throttler {
  constructor(max = 2) { this.max = max; this.running = 0; this.queue = []; }
  async acquire() { if (this.running < this.max) { this.running++; return; } return new Promise(r => this.queue.push(r)); }
  release() { this.running--; if (this.queue.length > 0) { this.running++; this.queue.shift()(); } }
}

// ─── Shared Utilities ──────────────────────────────────────────────────────────
function diceCoeff(a, b) {
  if (!a || !b) return 0;
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const bg = s.slice(i, i + 2); m.set(bg, (m.get(bg) || 0) + 1); } return m; };
  const ba = bigrams(na), bb = bigrams(nb);
  let inter = 0;
  for (const [k, v] of ba) inter += Math.min(v, bb.get(k) || 0);
  return (2 * inter) / (na.length - 1 + nb.length - 1);
}

async function fetchAniListMedia(anilistId) {
  try {
    const q = "query($id:Int!){Media(id:$id,type:ANIME){id seasonYear format episodes status startDate{year}title{romaji english native}synonyms coverImage{large}}}";
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: q, variables: { id: Number(anilistId) } }),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.Media ?? null;
  } catch { return null; }
}

async function fetchAniZip(anilistId) {
  try {
    const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

function buildTitles(media, anizip) {
  const titles = new Set();
  if (media?.title) {
    if (media.title.romaji) titles.add(media.title.romaji);
    if (media.title.english) titles.add(media.title.english);
    if (media.title.native) titles.add(media.title.native);
  }
  if (Array.isArray(media?.synonyms)) media.synonyms.forEach(s => s && titles.add(s));
  if (anizip?.titles) {
    for (const [k, v] of Object.entries(anizip.titles)) {
      if (v) titles.add(v);
    }
  }
  return [...titles];
}

function episodeMetaFromAnizip(num, anizip) {
  const ep = anizip?.episodes?.[String(num)] ?? {};
  return {
    title: ep.title?.en || ep.title?.["x-jat"] || null,
    duration: ep.runtime ?? ep.length ?? null,
    image: ep.image ?? null,
    description: ep.overview?.en ?? null,
    airDate: ep.airdate ?? null,
    filler: ep.filler ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ANIDAP PROVIDER  —  anidap.lol native API + chad.anidap.lol REST
// ═══════════════════════════════════════════════════════════════════════════════

const AN_API   = "https://anidap.lol/api/anime";    // Main API (search, details by AniList ID)
const AN_REST  = "https://chad.anidap.lol/rest/api"; // Chad API (episodes, servers, sources)
const AN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Origin": "https://anidap.lol",
  "Referer": "https://anidap.lol/",
};
const anThrottle = new Throttler(4);

// ─── Proxy Pool for Cloudflare bypass ──────────────────────────────────────
const PROXY_POOL = [
  "http://bvmbsmie:shibby2511@us4.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@us6.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@au1.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@it1.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@in1.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@my1.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@uk3.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@pt1.cactussstp.com:81",
  "http://bvmbsmie:shibby2511@ro1.cactussstp.com:81",
  "http://uncpjndo:w77Ebc0h2A@us4.cactussstp.com:81",
  "http://uncpjndo:w77Ebc0h2A@it1.cactussstp.com:81",
  "http://hughmuir2:lisamarie11@us4.cactussstp.com:81",
];
let proxyIdx = 0;
function nextProxy() { const p = PROXY_POOL[proxyIdx % PROXY_POOL.length]; proxyIdx++; return p; }

async function anFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    await anThrottle.acquire();
    try {
      const r = await fetch(url, { headers: AN_HEADERS, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        const wait = j.retry_after ? Math.min(j.retry_after * 1000, 30000) : 5000;
        console.warn(`[Anidap] 429, waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i === retries) console.warn(`[Anidap] ${url} failed: ${e.message}`); }
    finally { anThrottle.release(); }
  }
  throw new Error(`Anidap fetch failed: ${url}`);
}

// Chad API — try regular fetch() first (fast), fall back to rotating proxy via got-scraping if Cloudflare blocks
async function anChadFetch(path, retries = 1) {
  const url = `${AN_REST}${path}`;
  for (let i = 0; i <= retries; i++) {
    await anThrottle.acquire();
    try {
      // Try regular fetch first (much faster, works on non-datacenter IPs)
      const r = await fetch(url, { headers: AN_HEADERS, signal: AbortSignal.timeout(15000) });
      if (r.status === 403 || r.status === 503) {
        // Cloudflare blocked — use rotating proxy pool via got-scraping
        const proxy = nextProxy();
        console.warn(`[Anidap/Chad] fetch got HTTP ${r.status}, retrying via proxy ${proxy.replace(/\/\/[^@]+@/, "//***@")}`);
        const gr = await gotScraping(url, {
          headers: { ...AN_HEADERS, Accept: "application/json" },
          timeout: { request: 15000 },
          followRedirect: true,
          agent: { http: undefined, https: undefined },
          proxyUrl: proxy,
        });
        if (gr.statusCode === 429) {
          let j = {}; try { j = JSON.parse(gr.body); } catch {}
          const wait = j.retry_after ? Math.min(j.retry_after * 1000, 30000) : 5000;
          console.warn(`[Anidap/Chad] 429, waiting ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (gr.statusCode >= 400) throw new Error(`HTTP ${gr.statusCode}`);
        return JSON.parse(gr.body);
      }
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        const wait = j.retry_after ? Math.min(j.retry_after * 1000, 30000) : 5000;
        console.warn(`[Anidap/Chad] 429, waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i === retries) console.warn(`[Anidap/Chad] ${url} failed: ${e.message}`); }
    finally { anThrottle.release(); }
  }
  throw new Error(`Anidap Chad fetch failed: ${path}`);
}

// Search via anidap.lol native API — LIGHTWEIGHT results
async function anSearch(q) {
  const ck = `an-search:${q}`;
  const c = getCached(ck); if (c) return c;
  const d = await anFetch(`${AN_API}/search?q=${encodeURIComponent(q)}`);
  const results = Array.isArray(d?.results) ? d.results : [];
  const out = results.map(a => ({
    id: a.id,
    title: a.title?.userPreferred || a.title?.english || a.title?.romaji,
    image: a.image,
    type: a.type,
    episodes: a.totalEpisodes || a.episodes,
  }));
  setCache(ck, out);
  return out;
}

// AniList ID → slug + metadata
// anidap.lol has its own AniList IDs that may differ from official AniList.
// Strategy: try direct ID lookup first (fast, works when IDs match),
// then fall back to title search via AniList + ani.zip if that fails.
async function anAnilistToSlug(alId) {
  const ck = `an-resolve:${alId}`;
  const c = getCached(ck); if (c) return c;

  // Step 1: Try direct ID lookup (works when anidap's ID matches official AniList)
  try {
    const raw = await anFetch(`${AN_API}/${alId}`);
    const d = raw?.data && typeof raw.data === "object" ? raw.data : raw;
    if (d?.id && d?.anilistId) {
      const result = {
        id: d.id,
        slug: d.id,
        anilistId: d.anilistId || alId,
        title: d.titleEnglish || d.titleRomaji || d.titles?.en || d.titles?.romaji,
        image: d.coverImage?.extraLarge || d.coverImage?.large || (typeof d.coverImage === "string" ? d.coverImage : null),
        episodeCount: d.episodeCount,
      };
      setCache(ck, result);  // cache slug mapping with long TTL
      return result;
    }
  } catch (e) {
    console.warn(`[Anidap] Direct ID lookup for ${alId} failed: ${e.message}, trying search fallback`);
  }

  // Step 2: Fallback — fetch title from AniList/ani.zip, search on anidap, find best match
  try {
    const [media, anizip] = await Promise.all([fetchAniListMedia(alId), fetchAniZip(alId)]);
    if (!media) return null;
    const titles = buildTitles(media, anizip);
    if (!titles.length) return null;

    // Search anidap with first usable title
    for (const title of titles.slice(0, 3)) {
      if (/[\u3000-\u9fff\u4e00-\u9faf]/.test(title)) continue; // skip CJK
      const searchResults = await anSearch(title);
      if (!searchResults.length) continue;

      // Find best match by year + title similarity
      const targetYear = media?.seasonYear || media?.startDate?.year;
      let best = null, bestScore = -1;
      for (const r of searchResults) {
        let score = diceCoeff(titles[0], r.title || "");
        // Year bonus
        if (targetYear && r.releaseDate && r.releaseDate === targetYear) score += 0.15;
        // Type bonus
        const af = (media?.format || "").toUpperCase();
        const rf = (r.type || "").toUpperCase();
        if (af === "MOVIE" && rf === "MOVIE") score += 0.1;
        else if (af === "TV" && rf === "TV") score += 0.1;
        if (score > bestScore) { bestScore = score; best = r; }
      }

      if (best && bestScore >= 0.5) {
        // Now resolve the matched anidap ID to get the slug
        const raw2 = await anFetch(`${AN_API}/${best.id}`);
        const d2 = raw2?.data && typeof raw2.data === "object" ? raw2.data : raw2;
        if (d2?.id) {
          const result = {
            id: d2.id,
            slug: d2.id,
            anilistId: d2.anilistId || alId,
            title: d2.titleEnglish || d2.titleRomaji || d2.titles?.en || d2.titles?.romaji,
            image: d2.coverImage?.extraLarge || d2.coverImage?.large || (typeof d2.coverImage === "string" ? d2.coverImage : null),
            episodeCount: d2.episodeCount,
          };
          setCache(ck, result);
          return result;
        }
      }
    }
  } catch (e) {
    console.warn(`[Anidap] Search fallback for AniList ${alId} failed: ${e.message}`);
  }

  return null;
}

// Episodes via chad.anidap.lol REST — STRIPPED DOWN for speed
async function anEpisodes(slug) {
  const ck = `an-eps:${slug}`;
  const c = getCached(ck); if (c) return c;
  const d = await anChadFetch(`/episodes?id=${encodeURIComponent(slug)}`);
  const eps = Array.isArray(d) ? d : (d?.data || []);
  // Only number + title + hasDub — drops img/desc/airDate/rating (saves 70%+ on long anime)
  const result = eps.map((e, i) => ({
    n: e.number ?? (i + 1),
    t: e.titles?.en || e.title || `Episode ${e.number ?? (i + 1)}`,
    d: e.hasDub ? 1 : 0,
  }));
  setCache(ck, result);
  return result;
}

// Servers via chad.anidap.lol REST
async function anServers(slug, ep) {
  const d = await anChadFetch(`/servers?id=${encodeURIComponent(slug)}&epNum=${ep}`);
  const sub = Array.isArray(d?.subProviders) ? d.subProviders : [];
  const dub = Array.isArray(d?.dubProviders) ? d.dubProviders : [];
  const norm = p => typeof p === "string" ? { id: p } : { id: p.id, type: p.type, default: p.default, tip: p.tip };
  return { sub: sub.map(norm), dub: dub.map(norm) };
}

// Source via chad.anidap.lol REST — ONLY stream url + subtitles, nothing else
async function anSource(slug, ep, providerId = "beep", type = "sub") {
  const d = await anChadFetch(`/sources?id=${encodeURIComponent(slug)}&epNum=${ep}&providerId=${providerId}&type=${type}`);
  const payload = d?.data && typeof d.data === "object" && !Array.isArray(d.data) ? d.data : d;
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  const rawTracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  // Only m3u8/mp4 url + VTT subtitle tracks
  const stream = sources.map(s => s.url || s.file).filter(Boolean);
  const subs = rawTracks.filter(t => t?.url && (t.kind === "captions" || t.kind === "subtitles")).map(t => ({ url: t.url, lang: t.lang || t.label || "en" }));
  return { stream, subs };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  KAA PROVIDER  —  kaa.lt (fsearch + episode servers, HLS via krussdomi)
// ═══════════════════════════════════════════════════════════════════════════════

const KAA_BASE     = "https://kaa.lt";
const KAA_HLS_BASE = "https://hls.krussdomi.com/manifest";
const KAA_UA       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const KAA_H        = { "User-Agent": KAA_UA, Accept: "application/json", Origin: "https://kaa.lt", Referer: "https://kaa.lt/" };
const kaaThrottle  = new Throttler(3);

async function kaaFetch(url, opts = {}) {
  await kaaThrottle.acquire();
  try {
    const method = (opts.method || "GET").toUpperCase();
    const fetchOpts = {
      method,
      headers: { ...KAA_H, ...opts.headers },
      signal: AbortSignal.timeout(15000),
    };
    if (opts.body) fetchOpts.body = opts.body;
    const r = await fetch(url, fetchOpts);
    if (r.status === 403 || r.status === 503) {
      // Cloudflare blocked — use rotating proxy pool
      const proxy = nextProxy();
      console.warn(`[KAA] fetch got HTTP ${r.status}, retrying via proxy ${proxy.replace(/\/\/[^@]+@/, "//***@")}`);
      const gotOpts = { method, headers: { ...KAA_H, ...opts.headers }, timeout: { request: 15000 }, followRedirect: true, agent: { http: undefined, https: undefined }, proxyUrl: proxy };
      if (opts.body) gotOpts.body = opts.body;
      const gr = await gotScraping(url, gotOpts);
      if (gr.statusCode >= 400) throw new Error(`KAA HTTP ${gr.statusCode}: ${url}`);
      return JSON.parse(gr.body);
    }
    if (!r.ok) throw new Error(`KAA HTTP ${r.status}: ${url}`);
    return await r.json();
  } finally { kaaThrottle.release(); }
}

async function kaaSearch(query) {
  const data = await kaaFetch(`${KAA_BASE}/api/fsearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page: 1, query }),
  });
  return Array.isArray(data?.result) ? data.result : [];
}

async function kaaShowInfo(showSlug) {
  return kaaFetch(`${KAA_BASE}/api/show/${showSlug}`);
}

async function kaaEpisodePage(showSlug, ep) {
  return kaaFetch(`${KAA_BASE}/api/show/${showSlug}/episodes?ep=${ep}&lang=ja-JP`);
}

async function kaaAllEpisodes(showSlug) {
  const first = await kaaEpisodePage(showSlug, 1);
  const pages  = Array.isArray(first.pages)  ? first.pages  : [];
  const all    = Array.isArray(first.result) ? [...first.result] : [];

  if (pages.length > 1) {
    const rest = await Promise.all(
      pages.slice(1).map(async (pg) => {
        const startEp = pg.eps?.[0];
        if (!startEp) return [];
        const d = await kaaEpisodePage(showSlug, startEp);
        return Array.isArray(d.result) ? d.result : [];
      })
    );
    for (const batch of rest) all.push(...batch);
  }

  return all;
}

async function kaaEpisodeServers(showSlug, fullEpSlug) {
  return kaaFetch(`${KAA_BASE}/api/show/${showSlug}/episode/${fullEpSlug}`);
}

function buildKaaQueries(titles) {
  const queries = new Set();
  for (const title of titles.slice(0, 4)) {
    if (/[\u3000-\u9fff\u4e00-\u9faf]/.test(title)) continue;
    const clean = title.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 3) continue;
    const words = clean.split(" ").filter(Boolean);
    if (words.length <= 3) {
      queries.add(clean);
    } else {
      queries.add(words.slice(0, 2).join(" "));
      queries.add(words.slice(0, 3).join(" "));
    }
  }
  return [...queries];
}

function scoreKaaCandidate(candidate, titles, seasonYear, anilistFormat) {
  const titleEn = candidate.title_en || "";
  const titleJp = candidate.title   || "";
  const kaaYear = Number(candidate.year);
  const kaaType = (candidate.type || "").toLowerCase();

  let base = 0;
  for (const t of titles.slice(0, 3)) {
    if (/[\u3000-\u9fff\u4e00-\u9faf]/.test(t)) continue;
    base = Math.max(base, diceCoeff(t, titleEn), diceCoeff(t, titleJp));
  }

  let yearMult = 1.0;
  if (seasonYear && kaaYear) {
    const diff = Math.abs(Number(seasonYear) - kaaYear);
    if (diff === 0)      yearMult = 1.2;
    else if (diff === 1) yearMult = 0.8;
    else                 yearMult = 0.5;
  }

  let typeMult = 1.0;
  const af = (anilistFormat || "").toUpperCase();
  if      (af === "MOVIE" && kaaType !== "movie")                        typeMult = 0.25;
  else if (af !== "MOVIE" && kaaType === "movie")                        typeMult = 0.25;
  else if ((af === "OVA" || af === "ONA" || af === "SPECIAL") && kaaType === "tv") typeMult = 0.5;
  else if (af === "TV"   && (kaaType === "ova" || kaaType === "special")) typeMult = 0.5;

  return Math.min(1, base * yearMult) * typeMult;
}

async function kaaResolveSeries(anilistId) {
  const ck = `kaa-resolve:${anilistId}`;
  const c = getCached(ck); if (c) return c;

  const [media, anizip] = await Promise.all([fetchAniListMedia(anilistId), fetchAniZip(anilistId)]);
  if (!media) throw new Error(`KAA: AniList media not found for ID ${anilistId}`);

  const titles     = buildTitles(media, anizip);
  const queries    = buildKaaQueries(titles);
  const seasonYear = media?.seasonYear;
  const format     = media?.format;

  if (!queries.length) throw new Error(`KAA: no usable search queries for AniList ${anilistId}`);

  const allCandidates = new Map();
  await Promise.all(
    queries.map(async (q) => {
      try {
        const results = await kaaSearch(q);
        for (const r of results) {
          if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r);
        }
      } catch {}
    })
  );

  if (!allCandidates.size) throw new Error(`KAA: no search results for AniList ${anilistId}`);

  const scored = [];
  for (const [, candidate] of allCandidates) {
    const score = scoreKaaCandidate(candidate, titles, seasonYear, format);
    if (score >= 0.5) {
      scored.push({
        slug:    candidate.slug,
        title:   candidate.title_en || candidate.title,
        locales: Array.isArray(candidate.locales) ? candidate.locales : [],
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (!scored.length) {
    throw new Error(`KAA: no confident match for AniList ${anilistId}`);
  }

  const best = scored[0];
  if (best.score < 0.6) {
    console.warn(`[KAA] Low confidence match for AniList ${anilistId} — "${best.slug}" score ${best.score.toFixed(3)}`);
  }

  const data = {
    slug:    best.slug,
    title:   best.title,
    locales: best.locales,
    score:   best.score,
    media,
    anizip,
  };
  setCache(ck, data);
  return data;
}

async function kaaBuildEpMap(showSlug, showInfo) {
  if (showInfo?.type === "movie") {
    const m = (showInfo.watch_uri || "").match(/\/(ep-(\d+)-([a-f0-9]+))$/i);
    if (m) return [{ number: 1, fullSlug: m[1] }];
    return [];
  }
  const episodes = await kaaAllEpisodes(showSlug);
  return episodes.map((e) => ({
    number:   e.episode_number,
    fullSlug: `ep-${e.episode_number}-${e.slug}`,
    title:    e.title,
    duration: e.duration_ms ? Math.round(e.duration_ms / 1000) : null,
  }));
}

async function kaaGetEpisodes(anilistId) {
  const ck = `kaa-episodes:${anilistId}`;
  const c = getCached(ck); if (c) return c;

  const series   = await kaaResolveSeries(anilistId);
  const showInfo = await kaaShowInfo(series.slug);

  const locales = Array.isArray(showInfo.locales) ? showInfo.locales : series.locales;
  const hasDub  = locales.includes("en-US");

  const epMap = await kaaBuildEpMap(series.slug, showInfo);
  if (!epMap.length) throw new Error(`KAA: no episodes found for AniList ${anilistId} (slug: ${series.slug})`);

  const anizip  = series.anizip;
  const maxEp   = series.media?.episodes || 0;
  const sub     = [];
  const dub     = [];

  for (const ep of epMap) {
    const num = ep.number;
    if (!Number.isFinite(num) || num < 1)   continue;
    if (maxEp && num > maxEp)               continue;
    const meta  = episodeMetaFromAnizip(num, anizip);
    const base  = {
      number:      num,
      title:       meta.title       ?? ep.title ?? `Episode ${num}`,
      duration:    meta.duration    ?? ep.duration,
      filler:      meta.filler,
      description: meta.description,
      image:       meta.image,
      airDate:     meta.airDate,
    };
    sub.push({ id: `kaa/${anilistId}/sub/kaa-${num}`, ...base, audio: "sub" });
    if (hasDub) {
      dub.push({ id: `kaa/${anilistId}/dub/kaa-${num}`, ...base, audio: "dub" });
    }
  }

  const result = {
    anilistId: Number(anilistId),
    meta: {
      id:         series.slug,
      title:      series.title,
      source:     "kaa",
      matchScore: Number(series.score.toFixed(3)),
    },
    episodes: { sub, dub },
  };
  setCache(ck, result);
  return result;
}

async function kaaHandleWatch(anilistId, audio, epNum) {
  const ck = `kaa-watch:${anilistId}:${audio}:${epNum}`;
  const c = getCached(ck); if (c) return c;

  const series   = await kaaResolveSeries(anilistId);
  const showInfo = await kaaShowInfo(series.slug);

  const locales = Array.isArray(showInfo.locales) ? showInfo.locales : series.locales;
  if (audio === "dub" && !locales.includes("en-US")) {
    throw new Error(`KAA: no English dub for AniList ${anilistId}`);
  }

  const epMap = await kaaBuildEpMap(series.slug, showInfo);
  const ep    = epMap.find((e) => e.number === Number(epNum));
  if (!ep) {
    throw new Error(`KAA: episode ${epNum} not found for AniList ${anilistId}`);
  }

  const episodeData = await kaaEpisodeServers(series.slug, ep.fullSlug);
  const servers     = Array.isArray(episodeData.servers) ? episodeData.servers : [];
  if (!servers.length) {
    throw new Error(`KAA: no streams for episode ${epNum} (AniList ${anilistId})`);
  }

  const streams = [];
  for (const s of servers) {
    if (!s.src) continue;
    const m = s.src.match(/[?&]id=([^&]+)/);
    if (!m) continue;
    streams.push({
      url:        `${KAA_HLS_BASE}/${m[1]}/master.m3u8`,
      playerUrl:  s.src,
      type:       "hls",
      server:     s.name || s.shortName || "KAA",
      headers:    { Referer: "https://krussdomi.com/" },
      priority:   1,
      isActive:   true,
    });
  }

  if (!streams.length) {
    throw new Error(`KAA: could not resolve stream for episode ${epNum}`);
  }

  const result = {
    anilistId: Number(anilistId),
    episode:   Number(epNum),
    audio,
    streams,
  };
  setCache(ck, result);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MKISSA PROVIDER  —  mkissa.to encrypted API + multi-embed extractors
// ═══════════════════════════════════════════════════════════════════════════════

const MK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const MK_REFERER = "https://mkissa.to";
const MK_API = "https://api.mkissa.net";
const MK_API_URL = `${MK_API}/api`;
const MK_CDN_ROOT = "https://cdn.mkissa.net/all/mk";
const MK_DISCOVERY_PATH = "/anime/attack-on-titan-Ycid9tDZd2FxGCJ8o/sub/1";
const ANIZIP = "https://api.ani.zip/mappings";
const MK_CONTENT_LANE = "k7";
const MK_REFERER_HOST = "mkissa.to";
const MK_KEY_GROUP = "mkissa";
const MK_BOOT_EPOCH_MS = 604800000;
const MK_BOOT_GRACE_MS = 86400000;
const MK_AA_REQ_MS = 300000;
const MK_WATCH_TTL = 3 * 60 * 60 * 1000;
const MK_EPISODE_QUERY_HASH = "b0a4efecd8df8fce709468d54aaa716b712c93b5b7e351888ddc242898abc38e";
const MK_DISCOVERY_CONCURRENCY = 16;
const MK_DISCOVERY_LIMIT = 600;
const MK_FETCH_TIMEOUT = 10000;
const MK_EXTRACT_TIMEOUT = 5000;

const HEX_TABLE = { "79":"A","7a":"B","7b":"C","7c":"D","7d":"E","7e":"F","7f":"G","70":"H","71":"I","72":"J","73":"K","74":"L","75":"M","76":"N","77":"O","68":"P","69":"Q","6a":"R","6b":"S","6c":"T","6d":"U","6e":"V","6f":"W","60":"X","61":"Y","62":"Z","59":"a","5a":"b","5b":"c","5c":"d","5d":"e","5e":"f","5f":"g","50":"h","51":"i","52":"j","53":"k","54":"l","55":"m","56":"n","57":"o","48":"p","49":"q","4a":"r","4b":"s","4c":"t","4d":"u","4e":"v","4f":"w","40":"x","41":"y","42":"z","08":"0","09":"1","0a":"2","0b":"3","0c":"4","0d":"5","0e":"6","0f":"7","00":"8","01":"9","15":"-","16":".","67":"_","46":"~","02":":","17":"/","07":"?","1b":"#","63":"[","65":"]","78":"@","19":"!","1c":"$","1e":"&","10":"(","11":")","12":"*","13":"+","14":",","03":";","05":"=","1d":"%" };

let mkCryptoConfigCache = null;
let mkBootstrapCache = null;
const mkSessionCookies = new Map();
const mkWatchCache = new Map();

function mkDecodeHexUrl(hex) { let out = ""; for (let i = 0; i < hex.length; i += 2) { out += HEX_TABLE[hex.substring(i, i + 2).toLowerCase()] ?? hex.substring(i, i + 2); } return out; }
function mkSha256Hex(v) { return crypto.createHash("sha256").update(v).digest("hex"); }
function mkHmacBytes(k, v) { return crypto.createHmac("sha256", k).update(v).digest(); }
function mkSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mkStoreCookies(headers) {
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  for (const value of raw) { for (const part of String(value).split(/,(?=[^;,]+=)/)) { const pair = part.split(";")[0]?.trim(); const idx = pair?.indexOf("="); if (idx > 0) mkSessionCookies.set(pair.slice(0, idx), pair.slice(idx + 1)); } }
}

function mkCookieHeader() { return [...mkSessionCookies].map(([k, v]) => `${k}=${v}`).join("; "); }

function mkBrowserHeaders(extra = {}) {
  const c = mkCookieHeader();
  return { "User-Agent": MK_UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"', ...(c ? { Cookie: c } : {}), ...extra };
}

async function mkSessionFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: mkBrowserHeaders(opts.headers || {}) });
  mkStoreCookies(res.headers);
  return res;
}

async function mkFetchText(url, extra = {}) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), MK_FETCH_TIMEOUT);
  try { const res = await mkSessionFetch(url, { signal: ac.signal, headers: { Referer: `${MK_REFERER}/`, ...extra } }); if (!res.ok) throw new Error(`Fetch ${res.status}: ${url}`); return res.text(); } finally { clearTimeout(timer); }
}

async function mkFetchWithTimeout(url, opts = {}, timeout = MK_EXTRACT_TIMEOUT) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeout);
  try { const res = await fetch(url, { ...opts, signal: opts.signal || ac.signal }); mkStoreCookies(res.headers); return res; } finally { clearTimeout(timer); }
}

// ─── Crypto Config Discovery ──────────────────────────────────────────────────
function mkNormalizeCryptoConfig(out) { if (!out?.buildId || !Array.isArray(out.maskParts) || out.maskParts.length < 4) return null; return { buildId: String(out.buildId), maskParts: out.maskParts.slice(0, 4).map(String) }; }

function mkEvalOldCryptoChunk(chunk) {
  const cs = chunk.search(/const\s+[A-Za-z_$][\w$]*\s*=[^;]{0,180}\?"\d+":"",\s*[A-Za-z_$][\w$]*=\[/);
  if (cs < 0) return null;
  const tm = [...chunk.slice(0, cs).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(\)\{const e=\[/g)];
  const ts = tm.at(-1)?.index ?? -1;
  const as = chunk.indexOf("async function", cs);
  if (ts < 0 || as < 0) return null;
  let code = chunk.slice(ts, as);
  const bm = code.match(/const\s+([A-Za-z_$][\w$]*)\s*=([^;]+?\?"(\d+)":"")\s*,\s*([A-Za-z_$][\w$]*)=\[/);
  if (!bm) return null;
  const bn = bm[1], mn = bm[4];
  code = code.replace(new RegExp(`\\b[A-Za-z_$][\\w$]*\\(\\);\\s*const\\s+${bn}=`), `const ${bn}=`);
  code = code.replace(new RegExp(`const\\s+${bn}=`), `var ${bn}=`);
  code = code.replace(new RegExp(`,\\s*${mn}=\\[`), `;var ${mn}=[`);
  code += `\nreturn { buildId: ${bn}, maskParts: ${mn} };`;
  return mkNormalizeCryptoConfig(Function(code)());
}

function mkEvalModernCryptoChunk(chunk) {
  const cs = chunk.search(/const\s+[A-Za-z_$][\w$]*\s*=[^;]{0,220}\?"\d+":"",\s*[A-Za-z_$][\w$]*=\[/);
  if (cs < 0) return null;
  const wm = [...chunk.slice(0, cs).matchAll(/const\s+[A-Za-z_$][\w$]*=\(function\(\)\{/g)].at(-1);
  const ws = wm?.index ?? -1;
  const tm2 = [...chunk.slice(0, ws).matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(\)\{const\s+[A-Za-z_$][\w$]*=\[/g)].at(-1);
  const ts = tm2?.index ?? -1;
  const dm = [...chunk.slice(0, ts).matchAll(/function\s+[A-Za-z_$][\w$]*\s*\([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)?\)\{return\s+[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*-\d+,[A-Za-z_$][\w$]*\(\)\[[A-Za-z_$][\w$]*\]\}/g)].at(-1);
  const ti = dm?.index ?? -1;
  const as = chunk.indexOf("async function", cs);
  if (ti < 0 || ws < 0 || as < 0) return null;
  const head = chunk.slice(ti, ws);
  let body = chunk.slice(cs, as);
  const bMatch = body.match(/const\s+([A-Za-z_$][\w$]*)=/);
  const mMatch = body.match(/,([A-Za-z_$][\w$]*)=\[/);
  const mfMatch = body.match(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*=\s*([A-Za-z_$][\w$]*)\)/);
  if (!bMatch || !mMatch || !mfMatch) return null;
  const bn = bMatch[1], mn = mMatch[1], mfn = mfMatch[1];
  body = body.replace(new RegExp(`const\\s+${bn}=`), `var ${bn}=`);
  body = body.replace(new RegExp(`,${mn}=\\[`), `;var ${mn}=[`);
  body += `\nreturn { buildId: ${bn}, maskParts: ${mn}, mask: Array.from(${mfn}(${bn}) || []) };`;
  return mkNormalizeCryptoConfig(Function(head + body)());
}

function mkEvalCryptoChunk(chunk) { try { return mkEvalModernCryptoChunk(chunk); } catch {} try { return mkEvalOldCryptoChunk(chunk); } catch {} return null; }

async function mkDiscoverCryptoConfig(force = false) {
  if (!force && mkCryptoConfigCache?.expiresAt && Date.now() < mkCryptoConfigCache.expiresAt) return mkCryptoConfigCache;
  const html = await mkFetchText(`${MK_REFERER}${MK_DISCOVERY_PATH}`, { Accept: "text/html,*/*" });
  const appUrl = html.match(/import\("([^"]+\/_app\/immutable\/entry\/app\.[^"]+\.js)"\)/)?.[1] || html.match(/src="([^"]+\/_app\/immutable\/entry\/app\.[^"]+\.js)"/)?.[1];
  if (!appUrl) throw new Error("MKissa app entry not found");
  const app = await mkFetchText(appUrl, { Accept: "application/javascript,*/*" });
  const queue = [appUrl]; const seen = new Set();
  while (queue.length && seen.size < MK_DISCOVERY_LIMIT) {
    const batch = queue.splice(0, MK_DISCOVERY_CONCURRENCY).filter(u => { if (seen.has(u)) return false; seen.add(u); return true; });
    const chunks = await Promise.all(batch.map(async u => { try { return { url: u, text: u === appUrl ? app : await mkFetchText(u, { Accept: "application/javascript,*/*" }) }; } catch { return null; } }));
    for (const item of chunks.filter(Boolean)) {
      const imported = [...item.text.matchAll(/(?:import\(|from\s*)["']([^"']+\.js)["']/g), ...item.text.matchAll(/"(\.\.\/(?:chunks|nodes)\/[^"\n]+\.js)"/g)].map(m => m[1]).filter(v => v.startsWith(".") || v.startsWith("/"));
      for (const v of imported) { const next = new URL(v, item.url).toString(); if (!seen.has(next)) queue.push(next); }
      if (!/client-crypto|x-aa-boot|aaReq|partB/.test(item.text)) continue;
      const config = mkEvalCryptoChunk(item.text);
      const valid = config ? await mkIsValidCryptoConfig(config).catch(e => e?.name === "AbortError" ? null : false) : false;
      if (config && valid !== false) { mkCryptoConfigCache = { ...config, expiresAt: Date.now() + 1800000 }; return mkCryptoConfigCache; }
    }
  }
  throw new Error("MKissa crypto chunk not found");
}

function mkBuildMaskSeed(buildId) { const n = String(buildId || ""); const out = Buffer.alloc(32); for (let i = 0; i < 32; i++) out[i] = (n.charCodeAt(i % n.length) || 0) ^ ((i * 17 + 31) & 255); return out; }

function mkBuildMask(buildId, maskParts) {
  const seed = mkBuildMaskSeed(buildId); const out = Buffer.alloc(32);
  for (let i = 0; i < maskParts.length; i++) { const part = Buffer.from(maskParts[i], "base64"); const off = i * 8; for (let j = 0; j < 8; j++) out[off + j] = (part[j] ^ seed[off + j]) ^ ((i * 41 + j * 7) & 255); }
  return out;
}

function mkCurrentEpoches(now = Date.now()) { const epoch = Math.floor(now / MK_BOOT_EPOCH_MS); const pg = now - epoch * MK_BOOT_EPOCH_MS < MK_BOOT_GRACE_MS && epoch > 0 ? epoch - 1 : epoch; return [...new Set([pg, epoch])]; }

function mkMakeBootToken(config, epoch, lane = MK_CONTENT_LANE) {
  const mask = mkBuildMask(config.buildId, config.maskParts);
  const bootKey = mkHmacBytes(mask, `aa-boot:${config.buildId}`);
  return mkHmacBytes(bootKey, `${config.buildId}:${MK_KEY_GROUP}:${MK_REFERER_HOST}:${epoch}:${lane}`).toString("hex");
}

async function mkIsValidCryptoConfig(config, lane = MK_CONTENT_LANE) {
  for (const epoch of mkCurrentEpoches()) {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), MK_FETCH_TIMEOUT);
    try { const res = await mkSessionFetch(`${MK_API}/client-crypto/v1/bootstrap?buildId=${encodeURIComponent(config.buildId)}&k=${encodeURIComponent(lane)}`, { signal: ac.signal, headers: { Referer: `${MK_REFERER}/`, Origin: MK_REFERER, "x-build-id": config.buildId, "x-aa-boot": mkMakeBootToken(config, epoch, lane) } }); if (res.ok) return true; } finally { clearTimeout(timer); }
  }
  return false;
}

async function mkFetchBootstrap(lane = MK_CONTENT_LANE, force = false) {
  const config = await mkDiscoverCryptoConfig(force);
  if (!force && mkBootstrapCache?.lane === lane && mkBootstrapCache.buildId === config.buildId && mkBootstrapCache.switchAt && Date.now() < mkBootstrapCache.switchAt) return mkBootstrapCache;
  let lastErr = null;
  for (const epoch of mkCurrentEpoches()) {
    const res = await mkSessionFetch(`${MK_API}/client-crypto/v1/bootstrap?buildId=${encodeURIComponent(config.buildId)}&k=${encodeURIComponent(lane)}`, { headers: { Referer: `${MK_REFERER}/`, Origin: MK_REFERER, "x-build-id": config.buildId, "x-aa-boot": mkMakeBootToken(config, epoch, lane) } });
    const raw = await res.text(); if (!res.ok) { lastErr = new Error(`Bootstrap ${res.status}: ${raw.slice(0, 180)}`); continue; }
    const data = JSON.parse(raw); if (!data?.partB) { lastErr = new Error("Bootstrap missing partB"); continue; }
    mkBootstrapCache = { ...data, lane, buildId: config.buildId, maskParts: config.maskParts }; return mkBootstrapCache;
  }
  throw lastErr || new Error("MKissa bootstrap failed");
}

function mkDeriveLaneKey(partB, config) { const enc = Buffer.from(partB, "base64"); const mask = mkBuildMask(config.buildId, config.maskParts); const key = Buffer.alloc(32); for (let i = 0; i < 32; i++) key[i] = enc[i] ^ mask[i % mask.length]; return key; }

async function mkGetLaneKey(lane = MK_CONTENT_LANE, force = false) { const boot = await mkFetchBootstrap(lane, force); return { key: mkDeriveLaneKey(boot.partB, boot), epoch: boot.epoch, buildId: boot.buildId }; }

function mkMakeAaReq(key, epoch, buildId, queryHash, lane = MK_CONTENT_LANE) {
  const ts = Math.floor(Date.now() / MK_AA_REQ_MS) * MK_AA_REQ_MS;
  const payload = Buffer.from(JSON.stringify({ v: 1, ts, epoch, buildId, qh: queryHash, k: lane }));
  const iv = crypto.createHash("sha256").update(`${epoch}:${buildId}:${queryHash}:${ts}:${lane}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([1]), iv, body]).toString("base64");
}

function mkDecryptTobeparsed(b64, key) {
  const buf = Buffer.from(b64, "base64"); if (buf[0] !== 1) throw new Error(`Unsupported MKissa encryption version: ${buf[0]}`);
  const iv = buf.subarray(1, 13); const body = buf.subarray(13); const ct = body.subarray(0, body.length - 16); const tag = body.subarray(body.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", key, iv); dec.setAuthTag(tag);
  return JSON.parse(Buffer.concat([dec.update(ct), dec.final()]).toString("utf8"));
}

// ─── Episode Query ────────────────────────────────────────────────────────────
function mkEpisodeQuery() {
  const zt = `tbObj { u sm md ts }`;
  const pu = `_id name englishName nativeName slugTime`;
  const xa = `${pu} thumbnail ${zt} lastEpisodeInfo lastEpisodeDate type season score airedStart availableEpisodes episodeDuration episodeCount lastUpdateEnd characterCount`;
  return `query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!) { episode(showId:$showId translationType:$translationType episodeString:$episodeString) { episodeString uploadDate sourceUrls thumbnail notes show { ${xa} description broadcastInterval banner characters availableEpisodesDetail nameOnlyString isAdult relatedShows relatedMangas altNames } } }`;
}

// ─── API Calls ────────────────────────────────────────────────────────────────
async function mkApiPost(query, variables, opts = {}) {
  const config = opts.buildId ? opts : await mkDiscoverCryptoConfig();
  const body = opts.extensions ? { query, variables, extensions: opts.extensions } : { query, variables };
  const res = await mkSessionFetch(MK_API_URL, { method: "POST", headers: { Referer: `${MK_REFERER}/`, Origin: MK_REFERER, "Content-Type": "application/json", "x-build-id": config.buildId, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site" }, body: JSON.stringify(body) });
  const raw = await res.text(); if (!res.ok) throw new Error(`API POST ${res.status}: ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw); if (json.errors?.length) { const msgs = json.errors.map(e => e.message || e.extensions?.code || "GraphQL error"); const err = new Error(msgs.join(" · ")); if (msgs.includes("NEED_CAPTCHA")) err.code = "NEED_CAPTCHA"; throw err; }
  return json.data;
}

async function mkApiEpisode(query, variables, opts = {}) {
  const { force = false, hashIndex = 0, captchaRetry = 0, postFallback = false } = opts;
  const hashes = [...new Set([MK_EPISODE_QUERY_HASH, mkSha256Hex(query)].filter(Boolean))];
  const hash = hashes[Math.min(hashIndex, hashes.length - 1)];
  const { key, epoch, buildId } = await mkGetLaneKey(MK_CONTENT_LANE, force);
  const extensions = { persistedQuery: { version: 1, sha256Hash: hash }, k: MK_CONTENT_LANE, aaReq: mkMakeAaReq(key, epoch, buildId, hash, MK_CONTENT_LANE) };
  const url = `${MK_API_URL}?variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
  const res = await mkSessionFetch(url, { headers: { Referer: `${MK_REFERER}/`, Origin: MK_REFERER, "x-build-id": buildId, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site" } });
  const raw = await res.text(); if (!res.ok) throw new Error(`API ${res.status}: ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw);
  const msgs = json.errors?.map(e => e.message || e.extensions?.code).filter(Boolean) || [];
  if (msgs.includes("PersistedQueryNotFound") || msgs.some(m => /Context creation failed/i.test(m))) {
    if (hashIndex + 1 < hashes.length) return mkApiEpisode(query, variables, { force: true, hashIndex: hashIndex + 1 });
    const posted = await mkApiPost(query, variables, { buildId, extensions });
    return posted?.tobeparsed ? mkDecryptTobeparsed(posted.tobeparsed, key) : posted;
  }
  if (msgs.includes("NEED_CAPTCHA")) {
    if (!postFallback) {
      try {
        const postHash = mkSha256Hex(query);
        const postExt = { persistedQuery: { version: 1, sha256Hash: postHash }, k: MK_CONTENT_LANE, aaReq: mkMakeAaReq(key, epoch, buildId, postHash, MK_CONTENT_LANE) };
        const posted = await mkApiPost(query, variables, { buildId, extensions: postExt });
        return posted?.tobeparsed ? mkDecryptTobeparsed(posted.tobeparsed, key) : posted;
      } catch (err) { if (err.code !== "NEED_CAPTCHA") throw err; }
    }
    if (captchaRetry < 5) {
      console.warn(`[MKissa] CAPTCHA retry ${captchaRetry + 1}/5`);
      await mkSleep(1500 + captchaRetry * 1200);
      return mkApiEpisode(query, variables, { force: true, captchaRetry: captchaRetry + 1, hashIndex, postFallback: true });
    }
    const err = new Error("MKissa requested captcha — try again later or use captcha endpoint"); err.code = "NEED_CAPTCHA"; throw err;
  }
  if (msgs.some(m => /^AA_CRYPTO_/.test(m))) {
    if (!force) return mkApiEpisode(query, variables, { force: true, captchaRetry, hashIndex, postFallback });
    throw new Error(msgs.join(" · "));
  }
  if (json.data?.tobeparsed) return mkDecryptTobeparsed(json.data.tobeparsed, key);
  if (msgs.length) throw new Error(msgs.join(" · "));
  return json.data;
}

// ─── Search & Resolve ─────────────────────────────────────────────────────────
async function mkSearch(query, mode = "sub") {
  const gql = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){shows(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name englishName nativeName slugTime availableEpisodes availableEpisodesDetail aniListId __typename}}}`;
  const data = await mkApiPost(gql, { search: { allowAdult: false, allowUnknown: false, query }, limit: 40, page: 1, translationType: mode, countryOrigin: "ALL" });
  return data?.shows?.edges ?? [];
}

async function mkGetEpisodeSources(showId, epNum, audio = "sub") {
  const data = await mkApiEpisode(mkEpisodeQuery(), { showId, translationType: audio, episodeString: String(epNum) });
  return data?.episode ?? null;
}

function mkSlugifyTitle(v) { return String(v || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

async function mkWarmWatchPage(showId, show, epNum, audio) {
  const slug = show?.slugTime || mkSlugifyTitle(show?.englishName || show?.name || show?.nativeName);
  if (!slug || !showId) return;
  try { await mkFetchWithTimeout(`${MK_REFERER}/anime/${slug}-${showId}/${audio}/${epNum}`, { headers: mkBrowserHeaders({ Accept: "text/html,*/*", Referer: `${MK_REFERER}/`, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" }) }, MK_FETCH_TIMEOUT); } catch {}
}

function mkNormalize(s) { return (s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }
function mkExtractYear(t) { if (!t) return null; const m = t.match(/\b(19\d{2}|20\d{2})\b/); return m ? parseInt(m[1]) : null; }

function mkFindBestMatch(results, titles, targetYear, targetId) {
  const nTitles = titles.map(mkNormalize).filter(Boolean);
  let best = null, maxScore = -Infinity;
  for (const r of results) {
    if (targetId && r.aniListId && String(r.aniListId) === String(targetId)) return r;
    const names = [r.name, r.englishName, r.nativeName].map(mkNormalize).filter(Boolean);
    let nameScore = 0, isExact = false;
    for (const n of names) { if (nTitles.includes(n)) { nameScore = 100; isExact = true; break; } }
    if (!isExact) { let maxF = 0; for (const rn of names) for (const t of nTitles) { if (t.includes(rn) || rn.includes(t)) { maxF = Math.max(maxF, Math.min(rn.length, t.length) - Math.abs(rn.length - t.length) * 0.1); } } nameScore = maxF; }
    let yearScore = 0; const rYear = mkExtractYear(r.name) || mkExtractYear(r.englishName); if (targetYear && rYear) yearScore = rYear === targetYear ? 50 : -200;
    const total = nameScore + yearScore; if (total > maxScore) { maxScore = total; best = r; }
  }
  return best || results[0];
}

async function mkResolveMkissaId(anilistId) {
  const [anizipRes, alMedia] = await Promise.all([fetchAniZip(anilistId).catch(() => ({})), fetchAniListMedia(anilistId).catch(() => null)]);
  const anizip = anizipRes || {};
  let titlesToTry = [];
  if (anizip.titles) titlesToTry = [anizip.titles.en, anizip.titles.ja, anizip.titles["x-jat"], ...Object.values(anizip.titles)].filter(Boolean);
  if (alMedia?.title) { const alT = [alMedia.title.english, alMedia.title.romaji, alMedia.title.native].filter(Boolean); titlesToTry = [...new Set([...alT, ...titlesToTry])]; }
  if (!titlesToTry.length && anizip.mappings) { const apId = anizip.mappings.animeplanet_id; if (apId) titlesToTry = [apId.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")]; }
  if (!titlesToTry.length) throw new Error(`Could not resolve titles for AniList ID: ${anilistId}`);
  const targetYear = alMedia?.seasonYear || alMedia?.startDate?.year || null;
  let allResults = [];
  for (const title of titlesToTry.slice(0, 3)) allResults.push(...await mkSearch(title, "sub"));
  const seen = new Set(); allResults = allResults.filter(r => { if (seen.has(r._id)) return false; seen.add(r._id); return true; });
  if (!allResults.length) throw new Error(`No MKissa match for "${titlesToTry[0]}"`);
  const match = mkFindBestMatch(allResults, titlesToTry, targetYear, anilistId);
  return { showId: match._id, show: match, anizip };
}

// ─── Embed Extractors ─────────────────────────────────────────────────────────
function mkHexToBytes(hex) { const c = hex.replace(/[^0-9a-f]/gi, ""); const out = new Uint8Array(c.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16); return out; }

async function mkAesDecrypt(hex) { const d = crypto.createDecipheriv("aes-128-cbc", Buffer.from("kiemtienmua911ca"), Buffer.from("1234567890oiuytr")); return Buffer.concat([d.update(Buffer.from(mkHexToBytes(hex))), d.final()]).toString("utf8"); }

async function mkExtractMp4(id) { try { const r = await mkFetchWithTimeout(`https://www.mp4upload.com/embed-${id}.html`, { headers: { "User-Agent": MK_UA, Referer: "https://mp4upload.com/" } }); if (!r.ok) return null; const h = await r.text(); const m = h.match(/player\.src\s*\(\s*\{[^}]*\bsrc\s*:\s*"([^"]+)"/) || h.match(/"file"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/) || h.match(/\bsrc\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/); return m?.[1]?.replace(/\\/g, "") || null; } catch { return null; } }

async function mkExtractUns(url) { try { const parsed = new URL(url); const id = parsed.hash.replace(/^#/, "").split("&")[0]; if (!id) return null; const base = `${parsed.protocol}//${parsed.host}`; const r = await mkFetchWithTimeout(`${base}/api/v1/video?id=${encodeURIComponent(id)}&w=1280&h=720&r=`, { headers: { "User-Agent": MK_UA, Referer: `${base}/#${id}`, Origin: base } }); if (!r.ok) return null; const hex = (await r.text()).trim(); if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null; const data = JSON.parse(await mkAesDecrypt(hex)); return data?.source || data?.cf || null; } catch { return null; } }

async function mkExtractOk(id) { try { const r = await mkFetchWithTimeout(`https://ok.ru/videoembed/${id}`, { headers: { "User-Agent": MK_UA, Referer: "https://ok.ru/" } }); if (!r.ok) return null; const h = await r.text(); const m = h.match(/ondemandHls\\&quot;:\\&quot;(https?:\/\/.*?)\\&quot;/); return m?.[1]?.replace(/\\u0026/g, "&") || null; } catch { return null; } }

async function mkExtractStreamSB(id) { try { const bh = { "User-Agent": MK_UA, Referer: `${MK_REFERER}/`, watchsb: "streamsb", Accept: "application/json,*/*" }; const r1 = await mkFetchWithTimeout(`https://streamsb.net/api/v1/video?id=${id}`, { headers: bh }); const sid = (r1.headers.get("set-cookie") || "").match(/sid=([^;]+)/)?.[1] ?? ""; const html = await r1.text(); const m = html.match(/window\.location\.replace\('([^']+)'\)/); if (!m) return null; const r2 = await mkFetchWithTimeout(m[1], { headers: { ...bh, Cookie: `sid=${sid}`, Referer: `https://streamsb.net/e/${id}.html` } }); if (!r2.ok) return null; const ct = r2.headers.get("content-type") ?? ""; if (!ct.includes("json")) return null; const data = await r2.json(); return data?.stream_data?.file ?? data?.data?.file ?? null; } catch { return null; } }

async function mkExtractStreamlare(id) { try { const r = await mkFetchWithTimeout("https://streamlare.com/api/video/stream/get", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": MK_UA, Referer: "https://streamlare.com/", Origin: "https://streamlare.com" }, body: JSON.stringify({ id }) }); if (!r.ok) return null; const data = await r.json(); return data?.data?.file ?? null; } catch { return null; } }

async function mkExtractClock(url) { try { const clockUrl = url.replace("/clock", "/clock.json"); const r = await mkFetchWithTimeout(clockUrl, { headers: { "User-Agent": MK_UA, Referer: "https://allanime.day/player.html" } }); if (!r.ok) return null; const data = await r.json(); const links = Array.isArray(data?.links) ? data.links : []; const best = links.find(i => i?.hls && i?.link) || links.find(i => i?.link); return best?.link || null; } catch { return null; } }

function mkEmbedMediaType(url) { if (!url) return null; if (url.includes(".m3u8")) return "hls"; if (url.includes(".mp4")) return "mp4"; return "direct"; }

async function mkExtractSource(src) {
  let url = src.sourceUrl;
  if (url && url.startsWith("--")) url = mkDecodeHexUrl(url.slice(2));
  if (url && url.startsWith("/apivtwo/clock")) url = "https://allanime.day" + url.replace("/clock", "/clock.json");
  if (url && /^https?:\/\/allanime\.day\/apivtwo\/clock(?:\.json)?/i.test(url)) url = url.replace("/clock?", "/clock.json?");
  let extractedUrl = null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "allanime.day" && /\/apivtwo\/clock(?:\.json)?/i.test(new URL(url).pathname)) extractedUrl = await mkExtractClock(url);
    else if (src.type === "player") extractedUrl = url;
    else if (host === "mp4upload.com") { const m = url.match(/embed-([a-zA-Z0-9]+)\.html/i); if (m?.[1]) extractedUrl = await mkExtractMp4(m[1]); }
    else if (/uns\.bio$/i.test(host)) extractedUrl = await mkExtractUns(url);
    else if (host === "ok.ru") { const m = url.match(/\/(?:videoembed\/)?(\d+)(?:[/?#]|$)/i); if (m?.[1]) extractedUrl = await mkExtractOk(m[1]); }
    else if (/streamsb\./i.test(host)) { const m = url.match(/\/(?:e\/|embed-)([a-zA-Z0-9]+)(?:\.html)?/i); if (m?.[1]) extractedUrl = await mkExtractStreamSB(m[1]); }
    else if (/streamlare\./i.test(host)) { const m = url.match(/\/e\/([a-zA-Z0-9]+)/i); if (m?.[1]) extractedUrl = await mkExtractStreamlare(m[1]); }
  } catch {}
  return { name: src.sourceName || "", url, extractedUrl, extractedType: mkEmbedMediaType(extractedUrl), type: src.type, priority: src.priority, headers: { Referer: MK_REFERER, "User-Agent": MK_UA } };
}

// ─── MKissa Route Handlers ────────────────────────────────────────────────────
async function mkHandleEpisodes(anilistId) {
  const ck = `mk-episodes:${anilistId}`;
  const c = getCached(ck); if (c) return c;
  const { showId, show, anizip } = await mkResolveMkissaId(anilistId);
  const epDetail = show.availableEpisodesDetail || {};
  const subEps = (epDetail.sub || []).map(Number).sort((a, b) => a - b);
  const dubEps = (epDetail.dub || []).map(Number).sort((a, b) => a - b);
  const buildList = (nums, audio) => nums.map(n => {
    const meta = anizip.episodes?.[String(n)] ?? {};
    return { id: `mkissa/${anilistId}/${audio}/mkissa-${n}`, number: n, title: meta.title?.en || meta.title?.["x-jat"] || `Episode ${n}`, duration: meta.runtime ?? meta.length ?? 0, audio };
  });
  const result = { anilistId: Number(anilistId), mkissaId: showId, title: show.englishName || show.name, sub: buildList(subEps, "sub"), dub: buildList(dubEps, "dub") };
  setCache(ck, result);
  return result;
}

async function mkHandleWatch(anilistId, audio, epNum) {
  const ck = `mk-watch:${anilistId}:${audio}:${epNum}`;
  const c = getCached(ck); if (c) return c;
  const { showId, show, anizip } = await mkResolveMkissaId(anilistId);
  await mkWarmWatchPage(showId, show, epNum, audio);
  const episode = await mkGetEpisodeSources(showId, epNum, audio);
  if (!episode) throw new Error("Episode not found");
  const sources = await Promise.all((episode.sourceUrls || []).map(mkExtractSource));
  sources.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const result = { anilistId: Number(anilistId), mkissaId: showId, episode: Number(epNum), audio, sources };
  setCache(ck, result);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HLS PROXY
// ═══════════════════════════════════════════════════════════════════════════════

async function hlsProxy(req, res) {
  try {
    const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: "Missing ?url=" });
    const referer = req.query.referer || ""; const origin = referer ? new URL(referer).origin : "";
    const resp = await fetch(targetUrl, { headers: { "User-Agent": MK_UA, Referer: referer, Origin: origin }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return res.status(resp.status).send(`Upstream ${resp.status}`);
    const ct = resp.headers.get("content-type") || ""; const body = await resp.text();
    if (targetUrl.includes(".m3u8") || ct.includes("mpegurl")) {
      const base = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const proxyBase = `${req.protocol}://${req.get("host")}/hls-proxy`;
      const rewritten = body.split("\n").map(line => { if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri) => { const full = uri.startsWith("http") ? uri : base + uri; return `URI="${proxyBase}?url=${encodeURIComponent(full)}&referer=${encodeURIComponent(referer)}"`; }); if (!line.trim()) return line; const full = line.startsWith("http") ? line : base + line; return `${proxyBase}?url=${encodeURIComponent(full)}&referer=${encodeURIComponent(referer)}`; }).join("\n");
      res.set("Content-Type", "application/vnd.apple.mpegurl"); return res.send(rewritten);
    }
    const buf = Buffer.from(body, "binary"); res.set("Content-Type", ct || "video/mp2t"); res.set("Content-Length", buf.length); return res.send(buf);
  } catch (err) { res.status(502).json({ error: `HLS proxy: ${err.message}` }); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(compression({ threshold: 512, level: 6 }));  // gzip everything > 512B
app.use(cors());
app.use(express.json());

// ─── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", version: "7.3.0", providers: ["anidap", "kaa", "mkissa"], uptime: Math.floor(process.uptime()), mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB" }));

// ─── HLS Proxy ────────────────────────────────────────────────────────────────
app.get("/hls-proxy", hlsProxy);

// ─── ANIDAP ROUTES ────────────────────────────────────────────────────────────
// Direct AniList ID routes — no slug needed!
app.get("/anidap/search", async (req, res) => { try { res.json(await anSearch(req.query.q)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/anidap/anilist/:id", async (req, res) => { try { const r = await anAnilistToSlug(+req.params.id); r ? res.json(r) : res.status(404).json({ error: "Not found" }); } catch (e) { res.status(502).json({ error: e.message }); } });
// Episodes & sources accept EITHER AniList ID or slug
app.get("/anidap/episodes/:id", async (req, res) => {
  try {
    const id = req.params.id;
    // If it's a pure number, treat as AniList ID → resolve slug first
    if (/^\d+$/.test(id)) {
      const m = await anAnilistToSlug(+id);
      if (!m) return res.status(404).json({ error: "AniList ID not found" });
      return res.json({ anime: m, episodes: await anEpisodes(m.slug) });  // episodes use short keys (n/t/d)
    }
    // Otherwise treat as slug
    res.json(await anEpisodes(id));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/anidap/servers/:id/:ep", async (req, res) => {
  try {
    const id = req.params.id;
    let slug = id;
    if (/^\d+$/.test(id)) { const m = await anAnilistToSlug(+id); if (m) slug = m.slug; }
    res.json(await anServers(slug, req.params.ep));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/anidap/sources/:id/:ep", async (req, res) => {
  try {
    const id = req.params.id;
    let slug = id;
    if (/^\d+$/.test(id)) { const m = await anAnilistToSlug(+id); if (m) slug = m.slug; }
    res.json(await anSource(slug, req.params.ep, req.query.provider || "beep", req.query.type || "sub"));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ─── KAA ROUTES ──────────────────────────────────────────────────────────────
app.get("/kaa/search", async (req, res) => { try { const results = await kaaSearch(req.query.q || ""); res.json(results); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/kaa/episodes/:anilistId", async (req, res) => { try { res.json(await kaaGetEpisodes(+req.params.anilistId)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/kaa/watch/:anilistId/:audio/:ep", async (req, res) => { try { res.json(await kaaHandleWatch(+req.params.anilistId, req.params.audio, +req.params.ep)); } catch (e) { res.status(502).json({ error: e.message }); } });

// ─── MKISSA ROUTES ────────────────────────────────────────────────────────────
app.get("/mkissa/search", async (req, res) => { try { res.json(await mkSearch(req.query.q || "", req.query.mode || "sub")); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/mkissa/episodes/:anilistId", async (req, res) => { try { res.json(await mkHandleEpisodes(+req.params.anilistId)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/mkissa/watch/:anilistId/:audio/:ep", async (req, res) => { try { res.json(await mkHandleWatch(+req.params.anilistId, req.params.audio, +req.params.ep)); } catch (e) { res.status(502).json({ error: e.message }); } });

// ─── UNIFIED ROUTES ───────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const q = req.query.q; if (!q) return res.status(400).json({ error: "Missing ?q=" });
  const results = { anidap: [], kaa: [], mkissa: [] };
  try { results.anidap = await anSearch(q); } catch (e) { results.anidap = { error: e.message }; }
  try { results.kaa = await kaaSearch(q); } catch (e) { results.kaa = { error: e.message }; }
  try { results.mkissa = await mkSearch(q); } catch (e) { results.mkissa = { error: e.message }; }
  res.json(results);
});

app.get("/anilist/:id/episodes", async (req, res) => {
  const id = +req.params.id; const result = { anidap: null, kaa: null, mkissa: null };
  try { const m = await anAnilistToSlug(id); if (m) result.anidap = { anime: m, episodes: await anEpisodes(m.slug) }; } catch (e) { result.anidap = { error: e.message }; }
  try { result.kaa = await kaaGetEpisodes(id); } catch (e) { result.kaa = { error: e.message }; }
  try { result.mkissa = await mkHandleEpisodes(id); } catch (e) { result.mkissa = { error: e.message }; }
  res.json(result);
});

// Unified watch — get streams from anidap directly by AniList ID
app.get("/anilist/:id/watch/:ep", async (req, res) => {
  const id = +req.params.id;
  const ep = +req.params.ep;
  const provider = req.query.provider || "beep";
  const type = req.query.type || "sub";
  const result = { anidap: null };
  try {
    const m = await anAnilistToSlug(id);
    if (m) result.anidap = await anSource(m.slug, ep, provider, type);
  } catch (e) { result.anidap = { error: e.message }; }
  res.json(result);
});

// ─── Start ────────────────────────────────────────────────────────────────────
process.on("unhandledRejection", (err) => { console.error("[Unhandled Rejection]", err?.message || err); });
process.on("uncaughtException", (err) => { console.error("[Uncaught Exception]", err?.message || err); });

app.listen(PORT, () => {
  console.log(`LuffyTV API v7.1 on :${PORT}`);
  console.log(`  Anidap: ${AN_API} + ${AN_REST}`);
  console.log(`  KAA:    ${KAA_BASE}`);
  console.log(`  MKissa: ${MK_REFERER} → ${MK_API}`);
  // Warm up MKissa crypto config
  mkDiscoverCryptoConfig().then(c => console.log(`[MKissa] Crypto config warmed up: buildId=${c.buildId}`)).catch(e => console.warn(`[MKissa] Crypto warmup failed: ${e.message}`));
});
