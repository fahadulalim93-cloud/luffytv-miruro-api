/**
 * LuffyTV Miruro API — Combined Server v4.0
 *
 * TWO providers running in parallel:
 *   - /animex/*  — animex.one (pp.animex.one + chad.anidap.lol fallback, 429 retry)
 *   - /pahe/*    — animepahe.pw (FlareSolverr CF UAM bypass, Kwik m3u8/HLS)
 *
 * Unified routes (/search, /anilist/:id/stream) try BOTH providers.
 *
 * FlareSolverr solves Cloudflare UAM challenges and returns cf_clearance cookies.
 * Cookies are cached and auto-refreshed on 401/403 or expiry.
 * Kwik embed pages are resolved via Node.js VM sandbox (mock Plyr/Hls → m3u8).
 */

import express from "express";
import cors from "cors";
import { createContext, Script } from "vm";
import { gotScraping } from "got-scraping";

const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600000", 10);
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const PAHE_COOKIES_ENV = process.env.PAHE_COOKIES || ""; // Manual cookie fallback: cf_clearance=xxx; __ddgid_=yyy

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

// ─── Simple fetch helper ──────────────────────────────────────────────────────
async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", ...opts.headers }, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
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
//  ANIMEPAHE PROVIDER  —  FlareSolverr CF UAM bypass + Kwik m3u8
// ═══════════════════════════════════════════════════════════════════════════════

const PAHE_BASE = process.env.ANIMEPAHE_BASE || "https://animepahe.com";
const ANILIST_API = "https://graphql.anilist.co";
const paheThrottle = new Throttler(2);

// ─── Cookie Manager ────────────────────────────────────────────────────────────
let paheCookies = null;          // { cookieHeader: string, timestamp: number }
let paheIsRefreshing = false;
const PAHE_COOKIE_TTL = 4 * 60 * 60 * 1000; // 4 hours (cf_clearance usually lasts longer)

async function paheRefreshCookies() {
  if (paheIsRefreshing) return paheCookies?.cookieHeader;
  paheIsRefreshing = true;
  try {
    console.log("[Pahe] Refreshing CF cookies via FlareSolverr...");
    const res = await fetch(FLARESOLVERR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url: PAHE_BASE, maxTimeout: 60000 }),
      signal: AbortSignal.timeout(70000),
    });
    if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
    const data = await res.json();

    if (data.status !== "ok" || !data.solution) {
      throw new Error(`FlareSolverr failed: ${data.message || "unknown"}`);
    }

    const cookies = data.solution.cookies || [];
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const userAgent = data.solution.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

    if (!cookieHeader) throw new Error("No cookies from FlareSolverr");

    paheCookies = { cookieHeader, userAgent, timestamp: Date.now() };
    console.log(`[Pahe] Got ${cookies.length} cookies from FlareSolverr (cf_clearance: ${cookies.find(c => c.name === "cf_clearance") ? "YES" : "NO"})`);
    return cookieHeader;
  } catch (err) {
    console.error(`[Pahe] FlareSolverr error: ${err.message}`);
    // If FlareSolverr fails, try got-scraping as fallback
    try {
      console.log("[Pahe] Trying got-scraping fallback...");
      const resp = await gotScraping({ url: PAHE_BASE, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" } });
      const html = resp.body;
      if (html && html.length > 500 && !html.includes("Just a moment") && !html.includes("Checking your browser")) {
        const setCookies = resp.headers["set-cookie"];
        if (setCookies) {
          const cookieHeader = Array.isArray(setCookies) ? setCookies.map(c => c.split(";")[0]).join("; ") : setCookies.split(";")[0];
          if (cookieHeader) {
            paheCookies = { cookieHeader, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", timestamp: Date.now() };
            console.log("[Pahe] got-scraping fallback succeeded");
            return cookieHeader;
          }
        }
      }
      throw new Error("got-scraping also blocked by CF");
    } catch (fbErr) {
      console.error(`[Pahe] All CF bypass methods failed: ${fbErr.message}`);
      throw new Error(`CF bypass failed: ${err.message}`);
    }
  } finally {
    paheIsRefreshing = false;
  }
}

async function paheGetCookies() {
  // Check for manually set cookies from environment variable
  if (PAHE_COOKIES_ENV && !paheCookies) {
    paheCookies = {
      cookieHeader: PAHE_COOKIES_ENV,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      timestamp: Date.now(),
    };
    console.log("[Pahe] Using PAHE_COOKIES from environment variable");
  }

  if (paheCookies && (Date.now() - paheCookies.timestamp) < PAHE_COOKIE_TTL) {
    // Proactive refresh if > 3.5 hours old (only for FlareSolverr-managed cookies, not env-set)
    if (!PAHE_COOKIES_ENV && (Date.now() - paheCookies.timestamp) > (PAHE_COOKIE_TTL - 30 * 60 * 1000) && !paheIsRefreshing) {
      paheRefreshCookies().catch(e => console.warn("[Pahe] Background cookie refresh failed:", e.message));
    }
    return paheCookies;
  }
  await paheRefreshCookies();
  return paheCookies;
}

// ─── Pahe HTTP request with CF cookies ────────────────────────────────────────
async function paheFetch(url, opts = {}) {
  const { cookieHeader, userAgent } = await paheGetCookies();
  const headers = {
    "User-Agent": userAgent,
    "Cookie": cookieHeader,
    "Referer": PAHE_BASE + "/",
    "Accept": opts.accept || "application/json, text/html, */*",
    ...opts.headers,
  };

  await paheThrottle.acquire();
  try {
    const resp = await gotScraping({
      url,
      headers,
      followRedirect: true,
      timeout: { request: 20000 },
      ...opts.gotOpts,
    });

    const body = resp.body;

    // Check if we got a CF challenge page
    if (body.includes("Just a moment") || body.includes("Checking your browser") || body.includes("challenge-platform")) {
      console.warn("[Pahe] CF challenge detected, refreshing cookies...");
      await paheRefreshCookies();
      // Retry with fresh cookies
      const fresh = await paheGetCookies();
      const retryResp = await gotScraping({
        url,
        headers: { ...headers, Cookie: fresh.cookieHeader, "User-Agent": fresh.userAgent },
        followRedirect: true,
        timeout: { request: 20000 },
        ...opts.gotOpts,
      });
      if (retryResp.body.includes("Just a moment") || retryResp.body.includes("Checking your browser")) {
        throw new Error("Still blocked by CF after cookie refresh");
      }
      return retryResp;
    }

    return resp;
  } finally {
    paheThrottle.release();
  }
}

// ─── Pahe Search ──────────────────────────────────────────────────────────────
async function paheSearch(query) {
  const ck = `pahe-search:${query}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    const resp = await paheFetch(`${PAHE_BASE}/api?m=search&q=${encodeURIComponent(query)}`);
    const data = JSON.parse(resp.body);
    const results = (data.data || []).map(a => ({
      id: a.id,
      title: a.title,
      image: a.poster,
      type: a.type,
      status: a.status,
      year: a.year,
      season: a.season,
      session: a.session, // needed for episode fetching
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
    // First, get the anime page to find the internal temp_id
    const pageResp = await paheFetch(`${PAHE_BASE}/anime/${animeSession}`, { accept: "text/html, */*" });
    const pageHtml = pageResp.body;

    // Extract temp_id from og:url meta tag
    let tempId = null;
    const ogUrlMatch = pageHtml.match(/<meta\s+property="og:url"\s+content="[^"]*\/([^"]+)"/i);
    if (ogUrlMatch) {
      tempId = ogUrlMatch[1];
    }

    // Fallback: try to extract from the page HTML
    if (!tempId) {
      const idMatch = pageHtml.match(/"id"\s*:\s*(\d+)/);
      if (idMatch) tempId = idMatch[1];
    }

    if (!tempId) {
      // Try the anime session as the ID
      tempId = animeSession;
    }

    // Fetch episodes from the release API (paginated)
    const allEpisodes = [];
    let page = 1;
    let lastPage = 1;

    do {
      const resp = await paheFetch(`${PAHE_BASE}/api?m=release&id=${tempId}&sort=episode_asc&page=${page}`);
      const data = JSON.parse(resp.body);
      const episodes = data.data || [];

      for (const ep of episodes) {
        allEpisodes.push({
          number: ep.episode,
          title: `Episode ${ep.episode}`,
          session: ep.session, // needed for source fetching
          snapshot: ep.snapshot || null,
        });
      }

      lastPage = data.last_page || 1;
      page++;
    } while (page <= lastPage && page <= 20); // safety limit

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
    // Step 1: Fetch the play page
    const playResp = await paheFetch(`${PAHE_BASE}/play/${animeSession}/${episodeSession}`, { accept: "text/html, */*" });
    const playHtml = playResp.body;

    // Step 2: Extract Kwik links from the play page
    // Look for data-src attributes on buttons
    const kwikLinks = [];
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

    // Fallback: regex for any kwik.cx/si/link URLs
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
            server: `pahe-kwik`,
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

// ─── Kwik m3u8 Resolution (VM Sandbox) ────────────────────────────────────────
async function resolveKwikM3U8(kwikUrl) {
  const ck = `kwik-m3u8:${kwikUrl}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    // Fetch the Kwik embed page with proper Referer
    const { cookieHeader, userAgent } = await paheGetCookies();
    const resp = await gotScraping({
      url: kwikUrl,
      headers: {
        "User-Agent": userAgent,
        "Cookie": cookieHeader,
        "Referer": PAHE_BASE + "/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      followRedirect: true,
      timeout: { request: 15000 },
    });

    const html = resp.body;

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
        const m3u8 = await executeKwikScript(script, kwikUrl);
        if (m3u8) {
          setCache(ck, m3u8);
          return m3u8;
        }
      } catch (err) {
        // Try next script
      }
    }

    // Fallback: regex search entire HTML for uwucdn/stream patterns
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

// ─── VM Sandbox Execution for Kwik Scripts ────────────────────────────────────
function executeKwikScript(scriptContent, pageUrl) {
  return new Promise((resolve, reject) => {
    const captured = new Set();
    let resolved = false;

    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    // Timeout safety
    const timer = setTimeout(() => finish(null), 3000);

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
        const hlsObj = {
          loadSource: (src) => {
            try {
              if (typeof src === "string" && src.includes(".m3u8")) {
                captured.add(src);
              }
            } catch (e) {}
          },
          attachMedia: () => {},
          on: () => {},
          startLoad: () => {},
          destroy: () => {},
        };
        return hlsObj;
      };
      Hls.isSupported = () => true;
      Hls.Events = { MANIFEST_PARSED: "manifestParsed", ERROR: "error" };

      // Mock DOM element
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
        setInterval: (fn, ms) => -1,
        clearInterval: () => {},
        requestAnimationFrame: (fn) => -1,
        cancelAnimationFrame: () => {},
        Math,
        Date,
        JSON,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        TypeError,
        RangeError,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        undefined,
        NaN,
        Infinity,
      };

      const ctx = createContext(sandbox);

      // Run the script
      try {
        new Script(scriptContent).runInContext(ctx, { timeout: 2000 });
      } catch (e) {
        // Script may throw but we may have captured the m3u8 already
      }

      // Also try evaluating eval() bodies directly
      const evalMatches = [...scriptContent.matchAll(/eval\(([\s\S]*?)\)\s*;?/gi)];
      for (const em of evalMatches) {
        try {
          if (em[1] && em[1].length > 10) {
            new Script(em[1]).runInContext(ctx, { timeout: 1500 });
          }
        } catch (e) {}
      }

      // Check captured m3u8 URLs
      if (captured.size > 0) {
        clearTimeout(timer);
        const m3u8 = Array.from(captured)[0];
        finish(m3u8);
        return;
      }

      // Check video.src
      if (mockVideo.src && mockVideo.src.includes(".m3u8")) {
        clearTimeout(timer);
        finish(mockVideo.src);
        return;
      }

      // Deep search: stringify sandbox and look for m3u8
      try {
        const str = JSON.stringify(sandbox);
        const deepMatch = str.match(/https?:\/\/[^"\\]+\.m3u8[^"\\]*/i);
        if (deepMatch) {
          clearTimeout(timer);
          finish(deepMatch[0]);
          return;
        }
      } catch (e) {}

      clearTimeout(timer);
      finish(null);
    } catch (err) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

// ─── AniList ID → AnimePahe mapping ───────────────────────────────────────────
async function anilistToPahe(alId) {
  const ck = `al2pahe:${alId}`;
  const c = getCached(ck);
  if (c) return c;

  try {
    // Get anime title from AniList
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

    // Try each title variant to search on animepahe
    const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])].filter(Boolean);

    for (const title of titles) {
      const results = await paheSearch(title);
      if (results.length > 0) {
        // Find best match (exact or closest)
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

    // If m3u8 playlist, rewrite URLs to go through our proxy
    if (targetUrl.includes(".m3u8") || ct.includes("mpegurl") || ct.includes("octet-stream")) {
      const base = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const proxyBase = `${req.protocol}://${req.get("host")}/hls-proxy`;

      const rewritten = body
        .split("\n")
        .map(line => {
          if (line.startsWith("#")) {
            // Rewrite URI= in EXT-X-MAP or EXT-X-KEY
            return line.replace(/URI="([^"]+)"/g, (_, uri) => {
              const full = uri.startsWith("http") ? uri : base + uri;
              return `URI="${proxyBase}?url=${encodeURIComponent(full)}&referer=${encodeURIComponent(referer)}"`;
            });
          }
          if (!line.trim()) return line;
          // Rewrite segment URLs
          const full = line.startsWith("http") ? line : base + line;
          return `${proxyBase}?url=${encodeURIComponent(full)}&referer=${encodeURIComponent(referer)}`;
        })
        .join("\n");

      res.set("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewritten);
    }

    // Otherwise pass through (ts segments, etc.)
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
app.get("/health", (_req, res) => res.json({ status: "ok", version: "4.0.0", providers: ["animex", "pahe"], paheCfBypass: "FlareSolverr + got-scraping fallback", paheCookies: paheCookies ? `fresh (${Math.round((Date.now() - paheCookies.timestamp) / 60000)}m ago, cf_clearance: ${paheCookies.cookieHeader.includes("cf_clearance")})` : "none", flaresolverr: FLARESOLVERR_URL }));

// ─── HLS Proxy ────────────────────────────────────────────────────────────────
app.get("/hls-proxy", hlsProxy);

// ─── ANIMEX ROUTES ────────────────────────────────────────────────────────────
app.get("/animex/search", async (req, res) => { try { res.json(await axSearch(req.query.q)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/animex/anilist/:id", async (req, res) => { try { const r = await axAnilistToSlug(+req.params.id); r ? res.json(r) : res.status(404).json({ error: "Not found" }); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/animex/episodes/:slug", async (req, res) => { try { res.json(await axEpisodes(req.params.slug)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/animex/sources/:slug/:ep", async (req, res) => { try { res.json(await axSources(req.params.slug, req.params.ep)); } catch (e) { res.status(502).json({ error: e.message }); } });

// ─── PAHE ROUTES ──────────────────────────────────────────────────────────────
app.get("/pahe/search", async (req, res) => { try { res.json(await paheSearch(req.query.q)); } catch (e) { res.status(502).json({ error: `Pahe search: ${e.message}` }); } });
app.get("/pahe/episodes/:session", async (req, res) => { try { res.json(await paheEpisodes(req.params.session)); } catch (e) { res.status(502).json({ error: `Pahe episodes: ${e.message}` }); } });
app.get("/pahe/sources/:animeSession/:episodeSession", async (req, res) => { try { res.json(await paheSources(req.params.animeSession, req.params.episodeSession)); } catch (e) { res.status(502).json({ error: `Pahe sources: ${e.message}` }); } });
app.get("/pahe/anilist/:id", async (req, res) => { try { const r = await anilistToPahe(+req.params.id); r ? res.json(r) : res.status(404).json({ error: "Not found on animepahe" }); } catch (e) { res.status(502).json({ error: e.message }); } });

// ─── PAHE COOKIE MANAGEMENT ───────────────────────────────────────────────────
app.get("/pahe/cookies", async (_req, res) => { try { await paheGetCookies(); res.json({ status: "ok", age: paheCookies ? `${Math.round((Date.now() - paheCookies.timestamp) / 60000)} minutes` : "none", hasCfClearance: paheCookies?.cookieHeader?.includes("cf_clearance") || false }); } catch (e) { res.status(502).json({ error: e.message }); } });
app.post("/pahe/cookies/refresh", async (_req, res) => { try { await paheRefreshCookies(); res.json({ status: "ok", message: "Cookies refreshed" }); } catch (e) { res.status(502).json({ error: e.message }); } });

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

  // Try animex
  try {
    const mapping = await axAnilistToSlug(id);
    if (mapping) {
      result.animex = { anime: mapping, episodes: await axEpisodes(mapping.slug), sources: await axSources(mapping.slug, ep).catch(() => []) };
    }
  } catch (e) { result.animex = { error: e.message }; }

  // Try pahe
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
  console.log(`LuffyTV API v4.0 on :${PORT}`);
  console.log(`  Animex: ${AX_GQL} + ${AX_REST.join(", ")}`);
  console.log(`  Pahe:   ${PAHE_BASE} (FlareSolverr: ${FLARESOLVERR_URL})`);

  // Proactively warm up pahe cookies on startup
  paheRefreshCookies().then(() => console.log("[Pahe] Startup cookie warmup OK")).catch(e => console.warn(`[Pahe] Startup cookie warmup failed: ${e.message}`));
});
