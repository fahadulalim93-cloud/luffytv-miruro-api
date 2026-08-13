/**
 * LuffyTV Miruro API — Combined Server v4.1
 *
 * TWO providers running in parallel:
 *   - /animex/*  — animex.one (pp.animex.one + chad.anidap.lol fallback, 429 retry)
 *   - /pahe/*    — animepahe.pw (FlareSolverr CF UAM bypass, Kwik m3u8/HLS)
 *
 * Unified routes (/search, /anilist/:id/stream) try BOTH providers.
 *
 * CRITICAL: FlareSolverr makes ALL animepahe requests through its Chromium instance.
 * cf_clearance cookies are tied to the TLS fingerprint, so we can't transfer them
 * to got-scraping/axios. FlareSolverr's real Chrome handles both CF challenge AND
 * the TLS fingerprint match. Sessions are persisted for speed.
 */

import express from "express";
import cors from "cors";
import { createContext, Script } from "vm";
import { gotScraping } from "got-scraping";

const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600000", 10);
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const PAHE_SESSION = "animepahe"; // FlareSolverr session name for persistence

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

// ═══════════════════════════════════════════════════════════════════════════════
//  ANIMEX PROVIDER
// ═══════════════════════════════════════════════════════════════════════════════

const AX_GQL = "https://graphql.animex.one/graphql";
const AX_REST = ["https://pp.animex.one/rest/api", "https://chad.anidap.lol/rest/api"];
const AX_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Origin": "https://animex.one",
  "Referer": "https://animex.one/",
};
const axThrottle = new Throttler(3);

async function axGql(query, variables = {}) {
  await axThrottle.acquire();
  try {
    const r = await fetch(AX_GQL, { method: "POST", headers: { "Content-Type": "application/json", ...AX_HEADERS }, body: JSON.stringify({ query, variables }) });
    if (!r.ok) throw new Error(`GQL ${r.status}`);
    const j = await r.json();
    if (j.errors?.length) throw new Error(j.errors[0].message);
    return j.data;
  } finally { axThrottle.release(); }
}

async function axRest(path, retries = 2) {
  for (const base of AX_REST) {
    for (let i = 0; i <= retries; i++) {
      await axThrottle.acquire();
      try {
        const r = await fetch(`${base}${path}`, { headers: AX_HEADERS, signal: AbortSignal.timeout(15000) });
        if (r.status === 429) { const j = await r.json().catch(() => ({})); const wait = j.retry_after ? Math.min(j.retry_after * 1000, 30000) : 5000; console.warn(`[Animex] 429 from ${base}, waiting ${wait}ms`); await new Promise(r => setTimeout(r, wait)); continue; }
        if (!r.ok) throw new Error(`REST ${r.status}`);
        return await r.json();
      } catch (e) { if (i === retries) console.warn(`[Animex] ${base}${path} failed: ${e.message}`); }
      finally { axThrottle.release(); }
    }
  }
  throw new Error("All animex REST endpoints failed");
}

async function axSearch(q) {
  const d = await axGql(`query($s:String!){search(search:$s){id slug title coverImage{large}format episodes status}}`, { s: q });
  return (d.search || []).map(a => ({ id: a.id, slug: a.slug, title: a.title, image: a.coverImage?.large, type: a.format, episodes: a.episodes, status: a.status }));
}

async function axAnilistToSlug(alId) {
  const d = await axGql(`query($id:Int!){Media(id:$id,type:ANIME){id slug title{romaji}coverImage{large}}}`, { id: alId });
  if (!d.Media) return null;
  return { id: d.Media.id, slug: d.Media.slug, title: d.Media.title?.romaji, image: d.Media.coverImage?.large };
}

async function axEpisodes(slug) {
  const d = await axRest(`/episodes?id=${slug}`);
  const eps = d?.episodes || d?.data || [];
  return Array.isArray(eps) ? eps.map((e, i) => ({ number: e.number ?? (i + 1), title: e.title || `Episode ${e.number ?? (i + 1)}`, slug: e.slug || e.id || String(e.number ?? (i + 1)) })) : [];
}

async function axSources(slug, ep) {
  const d = await axRest(`/sources?id=${slug}&episode=${ep}`);
  const srcs = d?.sources || d?.data || [];
  return Array.isArray(srcs) ? srcs.map(s => ({ url: s.url || s.file, type: s.type || (s.url?.includes(".m3u8") ? "m3u8" : "mp4"), quality: s.quality || s.resolution || "auto", server: s.server || "animex" })) : [];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ANIMEPAHE PROVIDER  —  FlareSolverr for ALL requests
// ═══════════════════════════════════════════════════════════════════════════════

const PAHE_BASE = process.env.ANIMEPAHE_BASE || "https://animepahe.pw";
const ANILIST_API = "https://graphql.anilist.co";
const paheThrottle = new Throttler(2);

// ─── FlareSolverr Session Manager ─────────────────────────────────────────────
let fsSessionCreated = false;
let fsLastError = null;
let fsLastSuccess = 0;

/**
 * Make a request through FlareSolverr's Chromium instance.
 * This is the ONLY way to bypass Cloudflare UAM — the real browser handles
 * both the JS challenge AND the TLS fingerprint that cf_clearance is tied to.
 *
 * FlareSolverr uses persistent sessions so the browser stays open between requests.
 */
async function flaresolverrGet(url, maxTimeout = 30000) {
  await paheThrottle.acquire();
  try {
    const body = {
      cmd: "request.get",
      url,
      maxTimeout,
      session: PAHE_SESSION, // Persist browser session for speed
    };

    // Only create session on first request
    if (!fsSessionCreated) {
      body.session = PAHE_SESSION;
      fsSessionCreated = true;
    }

    const resp = await fetch(FLARESOLVERR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(maxTimeout + 15000),
    });

    if (!resp.ok) {
      throw new Error(`FlareSolverr HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
    }

    const data = await resp.json();

    if (data.status !== "ok") {
      throw new Error(`FlareSolverr error: ${data.message || "unknown"}`);
    }

    const solution = data.solution;
    const html = solution.response;
    const statusCode = solution.status;

    // Check if the response is still a CF challenge page
    if (html && (html.includes("Just a moment") || html.includes("Checking your browser") || html.includes("challenge-platform"))) {
      // FlareSolverr might need more time — retry with longer timeout
      throw new Error("CF challenge not solved within timeout — try increasing maxTimeout");
    }

    fsLastSuccess = Date.now();
    fsLastError = null;
    return { html, statusCode, url: solution.url, cookies: solution.cookies || [] };
  } catch (err) {
    fsLastError = err.message;
    throw err;
  } finally {
    paheThrottle.release();
  }
}

/**
 * Destroy and recreate the FlareSolverr session (useful after errors)
 */
async function flaresolverrReset() {
  try {
    await fetch(FLARESOLVERR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "session.destroy", session: PAHE_SESSION }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {}
  fsSessionCreated = false;
}

/**
 * Check if FlareSolverr is reachable
 */
async function flaresolverrHealth() {
  try {
    const resp = await fetch(FLARESOLVERR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url: "https://httpbin.org/get", maxTimeout: 10000 }),
      signal: AbortSignal.timeout(15000),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

// ─── Pahe Search ──────────────────────────────────────────────────────────────
async function paheSearch(query) {
  const ck = `pahe-search:${query}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    const { html } = await flaresolverrGet(`${PAHE_BASE}/api?m=search&q=${encodeURIComponent(query)}`);

    // Parse JSON from the HTML response
    let data;
    try {
      data = JSON.parse(html);
    } catch (e) {
      throw new Error(`Invalid JSON from animepahe search: ${html.substring(0, 200)}`);
    }

    const results = (data.data || []).map(a => ({
      id: a.id,
      title: a.title,
      image: a.poster,
      type: a.type,
      status: a.status,
      year: a.year,
      season: a.season,
      session: a.session,
    }));

    setCache(ck, results);
    return results;
  } catch (err) {
    console.error(`Pahe search error: ${err.message}`);
    throw err;
  }
}

// ─── Pahe Episodes ────────────────────────────────────────────────────────────
async function paheEpisodes(animeSession) {
  const ck = `pahe-episodes:${animeSession}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    // Step 1: Get anime page to find internal ID
    const { html: pageHtml } = await flaresolverrGet(`${PAHE_BASE}/anime/${animeSession}`);

    // Extract temp_id from og:url meta tag
    let tempId = null;
    const ogUrlMatch = pageHtml.match(/<meta\s+property="og:url"\s+content="[^"]*\/([^"]+)"/i);
    if (ogUrlMatch) tempId = ogUrlMatch[1];

    // Fallback: try extracting from page
    if (!tempId) {
      const idMatch = pageHtml.match(/"id"\s*:\s*(\d+)/);
      if (idMatch) tempId = idMatch[1];
    }
    if (!tempId) tempId = animeSession;

    // Step 2: Fetch episodes from release API (paginated)
    const allEpisodes = [];
    let page = 1;
    let lastPage = 1;

    do {
      const { html: epHtml } = await flaresolverrGet(`${PAHE_BASE}/api?m=release&id=${tempId}&sort=episode_asc&page=${page}`);

      let data;
      try { data = JSON.parse(epHtml); } catch (e) { throw new Error(`Invalid JSON from episodes API: ${epHtml.substring(0, 200)}`); }

      const episodes = data.data || [];
      for (const ep of episodes) {
        allEpisodes.push({
          number: ep.episode,
          title: `Episode ${ep.episode}`,
          session: ep.session,
          snapshot: ep.snapshot || null,
        });
      }

      lastPage = data.last_page || 1;
      page++;
    } while (page <= lastPage && page <= 20);

    setCache(ck, allEpisodes);
    return allEpisodes;
  } catch (err) {
    console.error(`Pahe episodes error: ${err.message}`);
    throw err;
  }
}

// ─── Pahe Sources (Kwik → m3u8) ──────────────────────────────────────────────
async function paheSources(animeSession, episodeSession) {
  const ck = `pahe-sources:${animeSession}:${episodeSession}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    // Step 1: Fetch the play page through FlareSolverr
    const { html: playHtml } = await flaresolverrGet(`${PAHE_BASE}/play/${animeSession}/${episodeSession}`);

    // Step 2: Extract Kwik links from the play page
    const kwikLinks = [];

    // Look for buttons with data-src
    const buttonRegex = /<button[^>]*data-src="([^"]+)"[^>]*(?:data-fansub="([^"]*)")?[^>]*(?:data-resolution="([^"]*)")?[^>]*(?:data-audio="([^"]*)")?/gi;
    let match;
    while ((match = buttonRegex.exec(playHtml)) !== null) {
      kwikLinks.push({
        url: match[1],
        fansub: match[2] || "unknown",
        resolution: match[3] || "auto",
        audio: match[4] || "jpn",
      });
    }

    // Fallback: look for <a> with data-src
    const linkRegex = /<a[^>]*data-src="([^"]+)"[^>]*(?:data-fansub="([^"]*)")?[^>]*(?:data-resolution="([^"]*)")?/gi;
    while ((match = linkRegex.exec(playHtml)) !== null) {
      kwikLinks.push({ url: match[1], fansub: match[2] || "unknown", resolution: match[3] || "auto", audio: "jpn" });
    }

    // Fallback: regex for kwik.cx/si URLs
    if (kwikLinks.length === 0) {
      const kwikRegex = /https?:\/\/kwik\.(si|cx|link)\/e\/[^\s"'<>]+/gi;
      while ((match = kwikRegex.exec(playHtml)) !== null) {
        kwikLinks.push({ url: match[0], fansub: "unknown", resolution: "auto", audio: "jpn" });
      }
    }

    if (kwikLinks.length === 0) {
      throw new Error("No Kwik links found on play page");
    }

    // Step 3: Resolve each Kwik link to m3u8
    const sources = [];
    for (const kwik of kwikLinks) {
      try {
        const m3u8 = await resolveKwikM3U8(kwik.url);
        if (m3u8) {
          sources.push({
            url: m3u8,
            type: "m3u8",
            quality: kwik.resolution || "auto",
            server: "pahe-kwik",
            fansub: kwik.fansub,
            audio: kwik.audio,
            headers: {
              Referer: kwik.url,
              Origin: new URL(kwik.url).origin,
            },
          });
        }
      } catch (err) {
        console.warn(`[Pahe] Kwik resolve failed for ${kwik.url}: ${err.message}`);
      }
    }

    if (sources.length === 0) {
      throw new Error("No m3u8 sources resolved from Kwik");
    }

    setCache(ck, sources);
    return sources;
  } catch (err) {
    console.error(`Pahe sources error: ${err.message}`);
    throw err;
  }
}

// ─── Kwik m3u8 Resolution (FlareSolverr + VM Sandbox) ────────────────────────
async function resolveKwikM3U8(kwikUrl) {
  const ck = `kwik-m3u8:${kwikUrl}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    // Fetch Kwik page through FlareSolverr (CF protected)
    const { html } = await flaresolverrGet(kwikUrl);

    // Quick check: is m3u8 directly in the HTML?
    const directM3u8 = html.match(/https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*/i);
    if (directM3u8) {
      setCache(ck, directM3u8[0]);
      return directM3u8[0];
    }

    // Extract all <script> blocks
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    const scripts = [];
    let scriptMatch;
    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      if (scriptMatch[1] && scriptMatch[1].trim().length > 20) {
        scripts.push(scriptMatch[1]);
      }
    }

    if (scripts.length === 0) {
      throw new Error("No scripts found on Kwik page");
    }

    // Try each script in VM sandbox with mocked Plyr/Hls
    for (const script of scripts) {
      try {
        const m3u8 = executeKwikScript(script, kwikUrl);
        if (m3u8) {
          setCache(ck, m3u8);
          return m3u8;
        }
      } catch (err) {
        // Try next script
      }
    }

    // Fallback: regex search for uwucdn/stream patterns
    const streamMatch = html.match(/https?:\/\/[^"'<>\s]+\/stream\/[^"'<>\s]+\.m3u8[^"'<>\s]*/i);
    if (streamMatch) {
      setCache(ck, streamMatch[0]);
      return streamMatch[0];
    }

    throw new Error("Could not extract m3u8 from Kwik page");
  } catch (err) {
    console.error(`Kwik resolve error for ${kwikUrl}: ${err.message}`);
    throw err;
  }
}

// ─── VM Sandbox Execution for Kwik Scripts (synchronous) ──────────────────────
function executeKwikScript(scriptContent, pageUrl) {
  const captured = new Set();

  try {
    // Mock Plyr constructor — captures m3u8 from opts.sources
    const Plyr = function (el, opts) {
      try {
        if (opts && Array.isArray(opts.sources)) {
          for (const s of opts.sources) {
            if (s && typeof s.src === "string" && s.src.includes(".m3u8")) {
              captured.add(s.src);
            }
          }
        }
      } catch (e) {}
      return { on: () => ({}), destroy: () => {} };
    };
    Plyr.isSupported = () => true;

    // Mock Hls constructor — captures m3u8 from loadSource()
    const Hls = function (cfg) {
      return {
        loadSource: (src) => {
          try { if (typeof src === "string" && src.includes(".m3u8")) captured.add(src); } catch (e) {}
        },
        attachMedia: () => {},
        on: () => {},
        startLoad: () => {},
        destroy: () => {},
      };
    };
    Hls.isSupported = () => true;
    Hls.Events = { MANIFEST_PARSED: "manifestParsed", ERROR: "error" };

    // Mock DOM
    const mockVideo = { src: "", textContent: "", innerHTML: "", appendChild: () => {}, removeChild: () => {}, addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null, style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false } };
    const mockDoc = { getElementById: () => mockVideo, querySelector: () => mockVideo, querySelectorAll: () => [], getElementsByTagName: () => [], getElementsByClassName: () => [], createElement: () => ({...mockVideo, setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } }), body: mockVideo, head: mockVideo, addEventListener: () => {}, removeEventListener: () => {}, cookie: "", referrer: PAHE_BASE + "/", domain: new URL(PAHE_BASE).hostname, title: "" };
    const mockWin = { document: mockDoc, location: { href: pageUrl, origin: new URL(pageUrl).origin, hostname: new URL(pageUrl).hostname, protocol: "https:", assign: () => {}, replace: () => {}, reload: () => {} }, navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", plugins: [1, 2, 3], languages: ["en-US", "en"], webdriver: false }, self: null, top: null, parent: null, frames: [], localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, addEventListener: () => {}, removeEventListener: () => {}, atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64"), fetch: async () => ({ ok: true, text: async () => "", json: async () => ({}) }), XMLHttpRequest: function () { this.open = this.send = this.setRequestHeader = this.getResponseHeader = this.getAllResponseHeaders = () => {}; }, Image: function () { this.src = ""; }, MutationObserver: class { observe() {} disconnect() {} }, };
    mockWin.self = mockWin;
    mockWin.top = mockWin;
    mockWin.parent = mockWin;

    const sandbox = {
      ...mockWin,
      window: mockWin,
      document: mockDoc,
      Plyr,
      Hls,
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
      setTimeout: (fn, ms) => { try { if (typeof fn === "function") return setTimeout(fn, Math.min(ms || 0, 1000)); return setTimeout(fn, ms); } catch (e) { return -1; } },
      clearTimeout: (id) => clearTimeout(id),
      setInterval: () => -1,
      clearInterval: () => {},
      requestAnimationFrame: () => -1,
      cancelAnimationFrame: () => {},
      Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Error, TypeError, RangeError,
      parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
      undefined, NaN, Infinity,
    };

    const ctx = createContext(sandbox);

    // Run the script
    try { new Script(scriptContent).runInContext(ctx, { timeout: 2000 }); } catch (e) {}

    // Also try evaluating eval() bodies directly
    const evalMatches = [...scriptContent.matchAll(/eval\(([\s\S]*?)\)\s*;?/gi)];
    for (const em of evalMatches) {
      try { if (em[1] && em[1].length > 10) new Script(em[1]).runInContext(ctx, { timeout: 1500 }); } catch (e) {}
    }

    // Check captured m3u8 URLs
    if (captured.size > 0) return Array.from(captured)[0];

    // Check video.src
    if (mockVideo.src && mockVideo.src.includes(".m3u8")) return mockVideo.src;

    // Deep search: stringify sandbox
    try {
      const str = JSON.stringify(sandbox);
      const deepMatch = str.match(/https?:\/\/[^"\\]+\.m3u8[^"\\]*/i);
      if (deepMatch) return deepMatch[0];
    } catch (e) {}

    return null;
  } catch (err) {
    return null;
  }
}

// ─── AniList ID → AnimePahe mapping ───────────────────────────────────────────
async function anilistToPahe(alId) {
  const ck = `al2pahe:${alId}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    const resp = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($id:Int!){Media(id:$id,type:ANIME){id title{romaji english native}synonyms}}`,
        variables: { id: alId },
      }),
    });
    const data = await resp.json();
    const media = data.data?.Media;
    if (!media) return null;

    const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean);

    for (const title of titles) {
      const results = await paheSearch(title);
      if (results.length > 0) {
        const exact = results.find(r => r.title.toLowerCase() === title.toLowerCase());
        const result = exact || results[0];
        setCache(ck, result);
        return result;
      }
    }

    return null;
  } catch (err) {
    console.error(`AniList→Pahe mapping error: ${err.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HLS PROXY — Rewrites m3u8 playlists and ts segments with correct Referer
// ═══════════════════════════════════════════════════════════════════════════════

async function hlsProxy(req, res) {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Missing ?url=" });

    const referer = req.query.referer || "";
    const origin = referer ? new URL(referer).origin : "";

    const resp = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: referer,
        Origin: origin,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return res.status(resp.status).send(`Upstream ${resp.status}`);

    const ct = resp.headers.get("content-type") || "";
    const body = await resp.text();

    if (targetUrl.includes(".m3u8") || ct.includes("mpegurl") || ct.includes("octet-stream")) {
      const base = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const proxyBase = `${req.protocol}://${req.get("host")}/hls-proxy`;

      const rewritten = body
        .split("\n")
        .map(line => {
          if (line.startsWith("#")) {
            return line.replace(/URI="([^"]+)"/g, (_, uri) => {
              const full = uri.startsWith("http") ? uri : base + uri;
              return `URI="${proxyBase}?url=${encodeURIComponent(full)}&referer=${encodeURIComponent(referer)}"`;
            });
          }
          if (!line.trim()) return line;
          const full = line.startsWith("http") ? line : base + line;
          return `${proxyBase}?url=${encodeURIComponent(full)}&referer=${encodeURIComponent(referer)}`;
        })
        .join("\n");

      res.set("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    const buf = Buffer.from(body, "binary");
    res.set("Content-Type", ct || "video/mp2t");
    res.set("Content-Length", buf.length);
    return res.send(buf);
  } catch (err) {
    res.status(502).json({ error: `HLS proxy error: ${err.message}` });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

// ─── Health ────────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const fsOk = await flaresolverrHealth().catch(() => false);
  res.json({
    status: "ok",
    version: "4.1.0",
    providers: ["animex", "pahe"],
    flaresolverr: { url: FLARESOLVERR_URL, reachable: fsOk, session: PAHE_SESSION, lastSuccess: fsLastSuccess ? `${Math.round((Date.now() - fsLastSuccess) / 1000)}s ago` : "never", lastError: fsLastError },
  });
});

// ─── HLS Proxy ────────────────────────────────────────────────────────────────
app.get("/hls-proxy", hlsProxy);

// ─── ANIMEX ROUTES ────────────────────────────────────────────────────────────
app.get("/animex/search", async (req, res) => { try { res.json(await axSearch(req.query.q)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/animex/anilist/:id", async (req, res) => { try { const r = await axAnilistToSlug(+req.params.id); r ? res.json(r) : res.status(404).json({ error: "Not found" }); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/animex/episodes/:slug", async (req, res) => { try { res.json(await axEpisodes(req.params.slug)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/animex/sources/:slug/:ep", async (req, res) => { try { res.json(await axSources(req.params.slug, req.params.ep)); } catch (e) { res.status(502).json({ error: e.message }); } });

// ─── PAHE ROUTES ──────────────────────────────────────────────────────────────
app.get("/pahe/search", async (req, res) => { try { res.json(await paheSearch(req.query.q)); } catch (e) { res.status(502).json({ error: `Pahe: ${e.message}` }); } });
app.get("/pahe/episodes/:session", async (req, res) => { try { res.json(await paheEpisodes(req.params.session)); } catch (e) { res.status(502).json({ error: `Pahe: ${e.message}` }); } });
app.get("/pahe/sources/:animeSession/:episodeSession", async (req, res) => { try { res.json(await paheSources(req.params.animeSession, req.params.episodeSession)); } catch (e) { res.status(502).json({ error: `Pahe: ${e.message}` }); } });
app.get("/pahe/anilist/:id", async (req, res) => { try { const r = await anilistToPahe(+req.params.id); r ? res.json(r) : res.status(404).json({ error: "Not found on animepahe" }); } catch (e) { res.status(502).json({ error: e.message }); } });

// ─── PAHE FLARESOLVERR MANAGEMENT ─────────────────────────────────────────────
app.get("/pahe/status", async (_req, res) => {
  const fsOk = await flaresolverrHealth().catch(() => false);
  res.json({
    flaresolverr: { url: FLARESOLVERR_URL, reachable: fsOk },
    session: PAHE_SESSION,
    lastSuccess: fsLastSuccess ? new Date(fsLastSuccess).toISOString() : null,
    lastError: fsLastError,
  });
});

app.post("/pahe/session/reset", async (_req, res) => {
  await flaresolverrReset();
  res.json({ status: "ok", message: "FlareSolverr session reset" });
});

// ─── UNIFIED ROUTES (try both providers) ──────────────────────────────────────
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing ?q=" });
  const results = { animex: [], pahe: [] };
  try { results.animex = await axSearch(q); } catch (e) { results.animex = { error: e.message }; }
  try { results.pahe = await paheSearch(q); } catch (e) { results.pahe = { error: e.message }; }
  res.json(results);
});

app.get("/anilist/:id/stream", async (req, res) => {
  const id = +req.params.id;
  const ep = req.query.ep || 1;
  const result = { animex: null, pahe: null };

  try {
    const mapping = await axAnilistToSlug(id);
    if (mapping) {
      result.animex = { anime: mapping, episodes: await axEpisodes(mapping.slug), sources: await axSources(mapping.slug, ep).catch(() => []) };
    }
  } catch (e) { result.animex = { error: e.message }; }

  try {
    const mapping = await anilistToPahe(id);
    if (mapping) {
      const episodes = await paheEpisodes(mapping.session);
      const epData = episodes.find(e => e.number === +ep) || episodes[0];
      result.pahe = { anime: mapping, episodes, sources: epData ? await paheSources(mapping.session, epData.session).catch(() => []) : [] };
    }
  } catch (e) { result.pahe = { error: e.message }; }

  res.json(result);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LuffyTV API v4.1 on :${PORT}`);
  console.log(`  Animex: ${AX_GQL} + ${AX_REST.join(", ")}`);
  console.log(`  Pahe:   ${PAHE_BASE} via FlareSolverr (${FLARESOLVERR_URL})`);
  console.log(`  ⚠️  FlareSolverr MUST be running for animepahe to work!`);
  console.log(`  Start with: docker-compose up -d`);
});
