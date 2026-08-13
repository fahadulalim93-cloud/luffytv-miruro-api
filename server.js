/**
 * LuffyTV Miruro API — Combined Server
 *
 * TWO providers running in parallel:
 *   - /animex/*  — animex.one (pp.animex.one + chad.anidap.lol fallback, 429 retry)
 *   - /pahe/*    — animepahe.pw (FlareSolverr + got-scraping CF bypass, Kwik m3u8)
 *
 * Unified routes (/search, /anilist/:id/stream) try BOTH providers.
 */

import express from "express";
import cors from "cors";
import { createContext, Script } from "vm";
import { gotScraping } from "got-scraping";

const PORT = process.env.PORT || 3000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600000", 10);

// ─── Shared Cache ──────────────────────────────────────────────────────────────
const cache = new Map();
function getCached(key) { const e = cache.get(key); if (e && Date.now()-e.ts < CACHE_TTL) return e.data; cache.delete(key); return null; }
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
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.5",
  Origin: "https://animex.one",
  Referer: "https://animex.one/",
  "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site",
};
const AX_PROVIDERS = {
  beep:{name:"Beep",tip:"Soft sub, Fast (Default sub)",type:"hls"},
  mimi:{name:"Mimi",tip:"Soft sub, Fastest, High quality (Default dub)",type:"hls"},
  yuki:{name:"Yuki",tip:"Soft sub, Good, Multi quality",type:"hls"},
  neko:{name:"Neko",tip:"Hard sub, Fast, High quality",type:"hls"},
  sora:{name:"Sora",tip:"Soft sub, Fast, High quality",type:"hls"},
  miku:{name:"Miku",tip:"Hard sub, Best Quality HLS",type:"hls"},
  vee:{name:"Vee",tip:"Soft sub, DASH manifest",type:"dash"},
  huzz:{name:"Huzz",tip:"Hard sub, HLS Alt",type:"hls"},
  mochi:{name:"Mochi",tip:"Hard sub, MP4 with expiring token",type:"mp4"},
  uwu:{name:"Uwu",tip:"Hard sub, HLS (Same CDN as Miku)",type:"hls"},
  koto:{name:"Koto",tip:"Hard sub, HLS (Same CDN as Miku)",type:"hls"},
  kami:{name:"Kami",tip:"Alt provider",type:"hls"},
};

const axThrottler = new Throttler(2);
const AX_MAX_RETRIES = 3;

async function axRestFetch(path, opts = {}) {
  await axThrottler.acquire();
  try {
    for (let h = 0; h < AX_REST.length; h++) {
      const url = AX_REST[h] + path;
      for (let attempt = 0; attempt <= AX_MAX_RETRIES; attempt++) {
        const res = await fetch(url, { ...opts, headers: { ...AX_HEADERS, ...(opts.headers || {}) } });
        if (res.ok) return await res.json();
        const text = await res.text().catch(() => "");
        let errData; try { errData = JSON.parse(text); } catch { errData = {}; }
        if (res.status === 429) {
          const wait = (errData.retry_after || 5) * 1000;
          if (attempt < AX_MAX_RETRIES) { console.warn(`[AX 429] attempt ${attempt+1}/${AX_MAX_RETRIES} wait=${wait}ms`); await new Promise(r => setTimeout(r, wait)); continue; }
          break;
        }
        if (res.status === 403) break;
        throw new Error(`AX API ${res.status}: ${text.slice(0,200)}`);
      }
    }
    throw new Error("AX: All hosts failed for " + path);
  } finally { axThrottler.release(); }
}

async function axGqlFetch(query, variables) {
  const res = await fetch(AX_GQL, { method: "POST", headers: { ...AX_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error("AX GQL " + res.status);
  return res.json();
}

async function axResolveSlug(anilistId) {
  const ck = "ax:slug:" + anilistId;
  const cached = getCached(ck); if (cached) return cached;
  const data = await axGqlFetch("query($id:Int!){anime(anilistId:$id){id anilistId titleEnglish titleRomaji}}", { id: anilistId });
  const anime = data?.data?.anime;
  if (!anime?.id) throw new Error("AX: Not found for AniList ID " + anilistId);
  const result = { slug: anime.id, anilistId: anime.anilistId, titleEnglish: anime.titleEnglish || "", titleRomaji: anime.titleRomaji || "" };
  setCache(ck, result); return result;
}

async function axSearch(query) {
  const ck = "ax:search:" + query.toLowerCase();
  const cached = getCached(ck); if (cached) return cached;
  const data = await axGqlFetch("query($q:String!){searchAnime(query:$q){items{id anilistId titleEnglish titleRomaji}}}", { q: query });
  const results = (data?.data?.searchAnime?.items || []).map(i => ({ slug: i.id, anilistId: i.anilistId, titleEnglish: i.titleEnglish || "", titleRomaji: i.titleRomaji || "" }));
  setCache(ck, results); return results;
}

async function axGetEpisodes(slug) {
  const ck = "ax:eps:" + slug;
  const cached = getCached(ck); if (cached) return cached;
  const episodes = await axRestFetch("/episodes?id=" + encodeURIComponent(slug));
  setCache(ck, episodes); return episodes;
}

async function axGetServers(slug, epNum) {
  const data = await axRestFetch("/servers?id=" + encodeURIComponent(slug) + "&epNum=" + epNum);
  const mapP = p => ({ id: p.id, default: p.default || false, tip: p.tip || "", ...(AX_PROVIDERS[p.id] || {}) });
  return { sub: (data.subProviders || []).map(mapP), dub: (data.dubProviders || []).map(mapP) };
}

async function axGetSources(slug, epNum, type, providerId) {
  const ck = "ax:src:" + slug + ":" + epNum + ":" + type + ":" + providerId;
  const cached = getCached(ck); if (cached) return cached;
  const data = await axRestFetch("/sources?id=" + encodeURIComponent(slug) + "&epNum=" + epNum + "&type=" + type + "&providerId=" + encodeURIComponent(providerId));
  const result = {
    provider: providerId, type,
    sources: (data.sources || []).map(s => ({ url: s.url, quality: s.quality || "auto", type: s.type || "video/mpegurl", isM3U8: (s.url||"").includes(".m3u8") || (s.type||"").includes("mpegurl"), isMP4: (s.url||"").includes(".mp4") || (s.type||"").includes("mp4"), isDASH: (s.url||"").includes(".mpd") || (s.type||"").includes("dash") })),
    tracks: (data.tracks || []).filter(t => t.url && !t.url.startsWith("https:///")).map(t => ({ id: t.id, url: t.url, lang: t.lang || "en", label: t.label || "English", kind: t.kind || "captions", default: t.default || false })),
    headers: data.headers || {},
  };
  setCache(ck, result); return result;
}

async function axGetAllSources(slug, epNum, type = "sub") {
  const servers = await axGetServers(slug, epNum);
  const plist = type === "dub" ? servers.dub : servers.sub;
  const results = [];
  for (const p of plist) {
    try { const data = await axGetSources(slug, epNum, type, p.id); if (data?.sources?.length > 0) results.push({ ...data, providerName: p.name || p.id, default: p.default || false, tip: p.tip || "" }); }
    catch (err) { console.warn("[AX] " + p.id + " failed: " + err.message); }
  }
  return results;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ANIMEPAHE PROVIDER
// ═══════════════════════════════════════════════════════════════════════════════

const PAHE_BASE = process.env.PAHE_BASE || "https://animepahe.pw";
const FS_URL = process.env.FLARESOLVERR_URL || "http://flaresolverr:8191/v1";

let paheCookies = "";
let paheUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
let fsAvailable = false;
let paheReady = false;

// FlareSolverr
async function checkFS() {
  try {
    const res = await fetch(FS_URL.replace("/v1", ""), { method: "GET", signal: AbortSignal.timeout(5000) });
    if (res.ok) { fsAvailable = true; console.log("[FS] FlareSolverr available"); return true; }
  } catch {}
  fsAvailable = false; console.log("[FS] FlareSolverr not available, using got-scraping"); return false;
}

async function fsRequest(url) {
  const res = await fetch(FS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 120000 }) });
  if (!res.ok) throw new Error("FlareSolverr error: " + res.status);
  const data = await res.json();
  if (data.status !== "ok") throw new Error("FlareSolverr failed: " + (data.message || "unknown"));
  const sol = data.solution || {};
  if (sol.cookies) paheCookies = sol.cookies.map(c => c.name + "=" + c.value).join("; ");
  if (sol.userAgent) paheUA = sol.userAgent;
  return { status: sol.status || 200, body: sol.response || "" };
}

async function gsGet(url, extra = {}) {
  const res = await gotScraping({ url, method: "GET", headers: { "User-Agent": paheUA, Accept: "application/json, text/html, */*", "Accept-Language": "en-US,en;q=0.5", Referer: PAHE_BASE + "/", Cookie: paheCookies, ...extra }, followRedirect: true, maxRedirects: 5, timeout: { request: 30000 } });
  if (res.headers["set-cookie"]) { const arr = Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [res.headers["set-cookie"]]; const nc = arr.map(h => h.split(";")[0].trim()).filter(c => c.length > 0); if (nc.length > 0) paheCookies = nc.join("; "); }
  return { status: res.statusCode, body: res.body };
}

async function paheReq(url, extra = {}) {
  if (fsAvailable) { try { const r = await fsRequest(url); if (r.status < 400) return r; } catch (e) { console.warn("[FS]", e.message); } }
  return gsGet(url, extra);
}

async function initPahe() {
  await checkFS();
  if (fsAvailable) {
    try { const r = await fsRequest(PAHE_BASE + "/"); paheReady = true; console.log("[PAHE] CF solved via FlareSolverr"); return; } catch {}
  }
  try { const r = await gsGet(PAHE_BASE + "/"); paheReady = true; console.log("[PAHE] Homepage loaded via got-scraping"); } catch { paheReady = true; }
}

// P.A.C.K.E.R decoder
function unpackByRegex(packedStr) {
  let m = packedStr.match(/\(['"]([^'"]+)['"]\s*,\s*(\d+)\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]?([^'"]*?)['"]?\s*\)/);
  if (!m) m = packedStr.match(/\(['"]([^'"]+)['"]\s*,\s*(\d+)\s*,\s*['"]([^'"]+)['"]\s*\)/);
  if (!m) return null;
  return doUnpack(m[1], 62, parseInt(m[2],10), m[3].split("|"));
}

function doUnpack(p, a, c, k) {
  function be(n) { return n<a?""+e(n):be(Math.floor(n/a))+e(n%a); }
  function e(n) { if(n<36)return n.toString(36); if(n<62)return String.fromCharCode(n-36+65); return n.toString(); }
  const r = {};
  for (let i=c-1;i>=0;i--) { const key=be(i); if(k[i]&&k[i].length>0) r[key]=k[i]; }
  let result=p;
  const keys=Object.keys(r).sort((a,b)=>b.length-a.length);
  for (const key of keys) { result=result.replace(new RegExp("\\b"+key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\b","g"),r[key]); }
  return result;
}

function extractM3U8(code) {
  if (!code) return null;
  for (const p of [/https?:\/\/[^\s'"]+\.m3u8[^\s'"]*/, /(?:source|src|url)\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/]) {
    const m=code.match(p); if(m) return m[1]||m[0];
  }
  return null;
}

function extractMP4(code) {
  if (!code) return null;
  const m=code.match(/https?:\/\/[^\s'"]+\.mp4[^\s'"]*/);
  return m?m[0]:null;
}

function executePackerInVM(packedCode) {
  let captured = null;
  const sb = createContext({
    document: { querySelector:()=>null, querySelectorAll:()=>[], getElementById:()=>null, getElementsByClassName:()=>[],
      createElement:()=>({setAttribute:()=>{},getAttribute:()=>null,appendChild:()=>{},style:{},classList:{add:()=>{},remove:()=>{},contains:()=>false},addEventListener:()=>{},innerHTML:"",src:""}),
      head:{appendChild:()=>{}},body:{appendChild:()=>{},style:{}},addEventListener:()=>{},removeEventListener:()=>{}},
    window:{},
    Plyr:function(){return{on:()=>{},play:()=>{},destroy:()=>{}}},
    Hls:class{static isSupported(){return true}static Events={MANIFEST_PARSED:"mp"};constructor(){this.on=()=>{};this.loadSource=(s)=>{captured=captured||s};this.attachMedia=()=>{};this.startLoad=()=>{};this.destroy=()=>{}}},
    eval:function(c){if(typeof c==="string"){captured=c;if(c.includes("eval(")){try{new Script(c,{filename:"inner.js"}).runInContext(sb)}catch(_){}}}return c},
    console:{log:()=>{},warn:()=>{},error:()=>{},info:()=>{}},
    setTimeout:(fn)=>{try{if(typeof fn==="function")fn()}catch(_){}return 0},
    setInterval:()=>0,clearTimeout:()=>{},clearInterval:()=>{},
    fetch:()=>Promise.resolve({ok:false}),XMLHttpRequest:function(){return{open:()=>{},send:()=>{},setRequestHeader:()=>{}}},
    atob:(s)=>Buffer.from(s,"base64").toString("binary"),btoa:(s)=>Buffer.from(s,"binary").toString("base64"),
    Buffer,String,Number,Math,Array,Object,RegExp,JSON,parseInt,parseFloat,isNaN,isFinite,
  });
  sb.window=sb;sb.self=sb;sb.top=sb;sb.parent=sb;
  try{new Script(packedCode,{filename:"kwik.js"}).runInContext(sb,{timeout:5000});return captured}
  catch(e){if(captured)return captured;throw e}
}

function decodeKwikPacker(html) {
  const sr=/<script[^>]*>([\s\S]*?)<\/script>/gi;
  let s,m3u8=null,mp4=null;
  while((s=sr.exec(html))!==null){
    const code=s[1].trim();
    if(!code.includes("eval")||!code.includes("function(p"))continue;
    try{const r=executePackerInVM(code);if(r){m3u8=m3u8||extractM3U8(r);mp4=mp4||extractMP4(r);if(m3u8)break}}catch(_){}
    try{const r=unpackByRegex(code);if(r){m3u8=m3u8||extractM3U8(r);mp4=mp4||extractMP4(r);if(m3u8)break}}catch(_){}
  }
  if(!m3u8)m3u8=extractM3U8(html);
  if(!mp4)mp4=extractMP4(html);
  return{m3u8,mp4};
}

// AnimePahe API functions
async function paheSearch(query) {
  const ck="pahe:search:"+query.toLowerCase();
  const cached=getCached(ck);if(cached)return cached;
  const url=PAHE_BASE+"/api?m=search&q="+encodeURIComponent(query);
  const res=await paheReq(url,{"X-Requested-With":"XMLHttpRequest"});
  try{const d=JSON.parse(res.body);setCache(ck,d);return d}
  catch(e){if(res.body.includes("Just a moment"))throw new Error("Cloudflare blocked. Deploy with FlareSolverr.");throw new Error("Pahe search error: "+res.body.slice(0,200))}
}

async function paheGetEpisodes(session,page=1) {
  const ck="pahe:eps:"+session+":"+page;
  const cached=getCached(ck);if(cached)return cached;
  const url=PAHE_BASE+"/api?m=release&id="+encodeURIComponent(session)+"&sort=episode_desc&page="+page;
  const res=await paheReq(url,{"X-Requested-With":"XMLHttpRequest"});
  try{const d=JSON.parse(res.body);setCache(ck,d);return d}
  catch(e){throw new Error("Pahe episodes error: "+res.body.slice(0,200))}
}

async function paheGetAllEpisodes(session) {
  const ck="pahe:eps:all:"+session;
  const cached=getCached(ck);if(cached)return cached;
  let all=[],page=1,last=1;
  while(page<=last){const d=await paheGetEpisodes(session,page);all=all.concat(d.data||[]);if(d.last_page)last=d.last_page;if(!d.next_page_url||page>=last)break;page++}
  const result={total:all.length,episodes:all.map(ep=>({number:ep.episode,session:ep.session,createdAt:ep.created_at,fansub:ep.fansub||"unknown",quality:ep.quality||"1080"}))};
  setCache(ck,result);return result;
}

async function paheGetPlayPage(animeSession,epSession) {
  const res=await paheReq(PAHE_BASE+"/play/"+animeSession+"/"+epSession,{Accept:"text/html"});
  return res.body;
}

function paheExtractKwikLinks(html) {
  const links=[];let m;
  const r1=/data-src=["']([^"']+)["']/g;while((m=r1.exec(html))!==null){if(m[1].includes("kwik"))links.push(m[1])}
  const r2=/https?:\/\/kwik\.[a-z]+\/[ef]\/[a-zA-Z0-9]+/g;while((m=r2.exec(html))!==null){if(!links.includes(m[0]))links.push(m[0])}
  return links;
}

function paheExtractQualityMap(html) {
  const map={};let m;
  const r1=/data-resolution=["'](\d+)["'][^>]*data-src=["'](https?:\/\/kwik\.[a-z]+\/[ef]\/[a-zA-Z0-9]+)["']/g;
  while((m=r1.exec(html))!==null)map[m[2]]=parseInt(m[1],10);
  const r2=/data-src=["'](https?:\/\/kwik\.[a-z]+\/[ef]\/[a-zA-Z0-9]+)["'][^>]*data-resolution=["'](\d+)["']/g;
  while((m=r2.exec(html))!==null)map[m[1]]=parseInt(m[2],10);
  return map;
}

async function paheGetKwikStream(kwikUrl) {
  const ck="pahe:kwik:"+kwikUrl;const cached=getCached(ck);if(cached)return cached;
  const res=await paheReq(kwikUrl,{Accept:"text/html",Referer:PAHE_BASE+"/",Origin:PAHE_BASE});
  const{m3u8,mp4}=decodeKwikPacker(res.body);
  let fM3U8=m3u8,fMP4=mp4;
  if(!fM3U8&&!fMP4){const cdn=res.body.match(/https?:\/\/[a-zA-Z0-9.-]+\.kwik\.[a-z]+/);const path=res.body.match(/\/[a-zA-Z0-9_-]{6,}\/[a-zA-Z0-9_-]{6,}/);if(cdn&&path)fM3U8=cdn[0]+path[0]+"/index.m3u8"}
  const result={kwikUrl,m3u8:fM3U8,mp4:fMP4,type:fM3U8?"hls":fMP4?"mp4":null};
  if(fM3U8||fMP4)setCache(ck,result);return result;
}

async function paheGetEpisodeStreams(animeSession,epSession,qualityFilter) {
  const ck="pahe:streams:"+animeSession+":"+epSession+":"+(qualityFilter||"all");
  const cached=getCached(ck);if(cached)return cached;
  const html=await paheGetPlayPage(animeSession,epSession);
  const kwikLinks=paheExtractKwikLinks(html);
  const qualityMap=paheExtractQualityMap(html);
  if(kwikLinks.length===0)throw new Error("No kwik links found on play page");
  const streams=[];
  for(const kwikUrl of kwikLinks){
    try{const r=await paheGetKwikStream(kwikUrl);if(r.m3u8||r.mp4){streams.push({url:r.m3u8||r.mp4,type:r.type,quality:qualityMap[kwikUrl]||1080,isM3U8:!!r.m3u8,isMP4:!!r.mp4,source:"kwik",provider:"animepahe"})}}catch(err){console.warn("[kwik] "+kwikUrl+": "+err.message)}
  }
  streams.sort((a,b)=>b.quality-a.quality);
  let filtered=streams;
  if(qualityFilter){const q=parseInt(qualityFilter,10);const exact=streams.filter(s=>s.quality===q);filtered=exact.length>0?exact:streams}
  const result={totalFound:kwikLinks.length,totalDecoded:streams.length,streams:filtered};
  setCache(ck,result);return result;
}

// Pahe AniList mapping
const AL_GQL="https://graphql.anilist.co";
async function anilistById(id){const q=`query($id:Int){Media(id:$id,type:ANIME){id title{romaji english native}episodes}}`;const res=await fetch(AL_GQL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:q,variables:{id:parseInt(id,10)}})});if(!res.ok)throw new Error("AniList failed: "+res.status);return(await res.json()).data?.Media||null}

const anilistToPahe=new Map();
async function paheResolveAnilist(anilistId){
  const cached=anilistToPahe.get(anilistId);if(cached&&Date.now()-cached.ts<CACHE_TTL)return cached;
  const anime=await anilistById(anilistId);if(!anime)throw new Error("AniList ID "+anilistId+" not found");
  const title=anime.title.english||anime.title.romaji||anime.title.native;
  const results=await paheSearch(title);if(!results.data||results.data.length===0)throw new Error("Not found on AnimePahe: "+title);
  const best=results.data[0];
  const r={anilistId:anime.id,paheSession:best.session,paheTitle:best.title,anilistTitle:title,episodes:anime.episodes,ts:Date.now()};
  anilistToPahe.set(anilistId,r);return r;
}

// ─── HLS Proxy (for pahe m3u8 streams) ────────────────────────────────────────
async function proxyStream(req, res) {
  try {
    const { url, referer: customReferer } = req.query;
    if (!url) return res.status(400).json({ error: "Missing ?url=", usage: "/proxy?url=<m3u8|ts>&referer=<referer>" });

    // Auto-resolve kwik URLs
    if (/kwik\.[a-z]+\/(?:e|f|d)\//i.test(url)) {
      try { const result = await paheGetKwikStream(url); return res.redirect(302, `/proxy?url=${encodeURIComponent(result.m3u8)}&referer=${encodeURIComponent(PAHE_BASE+"/")}`); }
      catch (e) { return res.status(500).json({ error: "Kwik resolution failed", details: e.message }); }
    }

    const urlObj = new URL(url);
    const referer = customReferer || `${urlObj.protocol}//${urlObj.host}/`;

    const upstream = await fetch(url, {
      headers: {
        "User-Agent": paheUA,
        Referer: referer,
        Origin: referer.replace(/\/$/, ""),
        Accept: "*/*",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
    });

    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}`, url });

    const ct = upstream.headers.get("content-type") || "";
    const isM3U8 = ct.includes("mpegurl") || url.includes(".m3u8");

    if (isM3U8) {
      const text = await upstream.text();
      const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);
      const rp = customReferer ? `&referer=${encodeURIComponent(customReferer)}` : "";
      const modified = text.split("\n").map(line => {
        const t = line.trim();
        if (t.startsWith("#")) {
          if (t.includes('URI="')) return t.replace(/URI="([^"]+)"/, (match, uri) => { let fullUrl = uri.startsWith("http") ? uri : baseUrl + uri; return `URI="/proxy?url=${encodeURIComponent(fullUrl)}${rp}"`; });
          return line;
        } else if (t && !t.startsWith("http")) return `/proxy?url=${encodeURIComponent(baseUrl + t)}${rp}`;
        else if (t.startsWith("http")) return `/proxy?url=${encodeURIComponent(t)}${rp}`;
        return line;
      }).join("\n");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(modified);
    }

    // Stream through (ts segments)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", ct || "video/mp2t");
    if (upstream.headers.get("content-length")) res.setHeader("Content-Length", upstream.headers.get("content-length"));
    const reader = upstream.body.getReader();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } catch {}
    res.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  EXPRESS — Combined Routes
// ═══════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(cors()); app.use(express.json());
app.use((req,res,next)=>{const s=Date.now();res.on("finish",()=>console.log(req.method+" "+req.path+" → "+res.statusCode+" ("+(Date.now()-s)+"ms)"));next()});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get("/health",(req,res)=>res.json({status:"ok",service:"miruro-api",version:"3.0.0",providers:{animex:{status:"active",hosts:AX_REST},animepahe:{status:paheReady?"active":"init",site:PAHE_BASE,cfBypass:fsAvailable?"flaresolverr":"got-scraping",streamType:"m3u8/mp4 (HLS)"}},cache:cache.size,uptime:Math.floor(process.uptime())}));

// ─── ANIMEX Routes ─────────────────────────────────────────────────────────────
app.get("/animex/providers",(req,res)=>res.json({providers:Object.entries(AX_PROVIDERS).map(([id,info])=>({id,...info}))}));

app.get("/animex/search",async(req,res)=>{try{const q=req.query.q;if(!q)return res.status(400).json({error:"Missing ?q="});const r=await axSearch(q);res.json({provider:"animex",query:q,count:r.length,results:r})}catch(e){res.status(500).json({error:e.message})}});

app.get("/animex/anime/:anilistId/episodes",async(req,res)=>{try{const id=parseInt(req.params.anilistId,10);const info=await axResolveSlug(id);const eps=await axGetEpisodes(info.slug);const norm=eps.map(ep=>({number:ep.number,title:ep.titles?.en||ep.titles?.en_jp||ep.titles?.romaji||"Episode "+ep.number,titles:ep.titles||{}}));res.json({provider:"animex",anilistId:id,slug:info.slug,title:info.titleEnglish||info.titleRomaji,totalEpisodes:norm.length,episodes:norm})}catch(e){res.status(500).json({error:e.message})}});

app.get("/animex/anime/:anilistId/servers/:epNum",async(req,res)=>{try{const id=parseInt(req.params.anilistId,10),n=parseInt(req.params.epNum,10);const info=await axResolveSlug(id);const servers=await axGetServers(info.slug,n);res.json({provider:"animex",anilistId:id,episode:n,sub:servers.sub,dub:servers.dub})}catch(e){res.status(500).json({error:e.message})}});

app.get("/animex/anime/:anilistId/stream/:epNum",async(req,res)=>{try{const id=parseInt(req.params.anilistId,10),n=parseInt(req.params.epNum,10),type=req.query.type==="dub"?"dub":"sub",prov=req.query.provider||null;const info=await axResolveSlug(id);let results;if(prov){const data=await axGetSources(info.slug,n,type,prov);results=data?.sources?.length>0?[data]:[];}else{results=await axGetAllSources(info.slug,n,type);}res.json({provider:"animex",anilistId:id,title:info.titleEnglish||info.titleRomaji,episode:n,type,provider:prov||"all",count:results.length,streams:results})}catch(e){res.status(500).json({error:e.message})}});

// ─── ANIMEPAHE Routes ──────────────────────────────────────────────────────────
app.get("/pahe/search",async(req,res)=>{try{const q=req.query.q;if(!q)return res.status(400).json({error:"Missing ?q="});const data=await paheSearch(q);const results=(data.data||[]).map(i=>({session:i.session,title:i.title,status:i.status||"unknown",type:i.type||"TV",episodes:i.episodes||0,poster:i.poster||""}));res.json({provider:"animepahe",query:q,count:results.length,results})}catch(e){res.status(500).json({error:e.message})}});

app.get("/pahe/anime/:session/episodes",async(req,res)=>{try{const data=await paheGetAllEpisodes(req.params.session);res.json({provider:"animepahe",session:req.params.session,totalEpisodes:data.total,episodes:data.episodes})}catch(e){res.status(500).json({error:e.message})}});

app.get("/pahe/anime/:session/stream/:epNum",async(req,res)=>{try{const s=req.params.session,n=parseInt(req.params.epNum,10),q=req.query.quality||null;const d=await paheGetAllEpisodes(s);const ep=d.episodes.find(e=>e.number===n);if(!ep)return res.status(404).json({error:"Episode "+n+" not found"});const streams=await paheGetEpisodeStreams(s,ep.session,q);res.json({provider:"animepahe",session:s,episode:n,quality:q||"all",totalDecoded:streams.totalDecoded,streams:streams.streams})}catch(e){res.status(500).json({error:e.message})}});

app.get("/pahe/anime/:session/watch/:epNum",async(req,res)=>{try{const s=req.params.session,n=parseInt(req.params.epNum,10),q=req.query.quality||null;const d=await paheGetAllEpisodes(s);const ep=d.episodes.find(e=>e.number===n);if(!ep)return res.status(404).json({error:"Episode "+n+" not found"});const streams=await paheGetEpisodeStreams(s,ep.session,q);res.json({provider:"animepahe",session:s,episode:n,totalEpisodes:d.total,quality:q||"all",streams:streams.streams})}catch(e){res.status(500).json({error:e.message})}});

app.get("/pahe/anilist/:id/episodes",async(req,res)=>{try{const id=parseInt(req.params.id,10);const m=await paheResolveAnilist(id);const d=await paheGetAllEpisodes(m.paheSession);res.json({provider:"animepahe",anilistId:id,paheSession:m.paheSession,title:m.anilistTitle,totalEpisodes:d.total,episodes:d.episodes})}catch(e){res.status(500).json({error:e.message})}});

app.get("/pahe/anilist/:id/stream/:epNum",async(req,res)=>{try{const id=parseInt(req.params.id,10),n=parseInt(req.params.epNum,10),q=req.query.quality||null;const m=await paheResolveAnilist(id);const d=await paheGetAllEpisodes(m.paheSession);const ep=d.episodes.find(e=>e.number===n);if(!ep)return res.status(404).json({error:"Episode "+n+" not found"});const streams=await paheGetEpisodeStreams(m.paheSession,ep.session,q);res.json({provider:"animepahe",anilistId:id,title:m.anilistTitle,episode:n,quality:q||"all",streams:streams.streams})}catch(e){res.status(500).json({error:e.message})}});

// ─── HLS Proxy ─────────────────────────────────────────────────────────────────
app.get("/proxy", proxyStream);
app.options("/proxy",(req,res)=>{res.setHeader("Access-Control-Allow-Origin","*");res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Range,Content-Type");res.sendStatus(200)});

// ─── UNIFIED Routes (try both providers) ───────────────────────────────────────

app.get("/search",async(req,res)=>{
  try{
    const q=req.query.q;if(!q)return res.status(400).json({error:"Missing ?q="});
    const results={animex:[],animepahe:[]};
    try{const ax=await axSearch(q);results.animex=ax.map(i=>({provider:"animex",slug:i.slug,anilistId:i.anilistId,title:i.titleEnglish||i.titleRomaji}))}catch{}
    try{const p=await paheSearch(q);results.animepahe=(p.data||[]).map(i=>({provider:"animepahe",session:i.session,title:i.title,type:i.type||"TV",poster:i.poster||""}))}catch{}
    res.json({query:q,animex:results.animex.length,animepahe:results.animepahe.length,results});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/anilist/:id/stream/:epNum",async(req,res)=>{
  try{
    const id=parseInt(req.params.id,10),n=parseInt(req.params.epNum,10),q=req.query.quality||null,type=req.query.type==="dub"?"dub":"sub";
    const result={anilistId:id,episode:n,animex:null,animepahe:null};

    // Try animex
    try{
      const info=await axResolveSlug(id);
      const streams=await axGetAllSources(info.slug,n,type);
      if(streams.length>0)result.animex={title:info.titleEnglish||info.titleRomaji,count:streams.length,streams};
    }catch{}

    // Try animepahe
    try{
      const m=await paheResolveAnilist(id);
      const d=await paheGetAllEpisodes(m.paheSession);
      const ep=d.episodes.find(e=>e.number===n);
      if(ep){const streams=await paheGetEpisodeStreams(m.paheSession,ep.session,q);if(streams.totalDecoded>0)result.animepahe={title:m.anilistTitle,count:streams.totalDecoded,streams:streams.streams}}
    }catch{}

    res.json(result);
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/anilist/:id/episodes",async(req,res)=>{
  try{
    const id=parseInt(req.params.id,10);
    const result={anilistId:id,animex:null,animepahe:null};

    try{const info=await axResolveSlug(id);const eps=await axGetEpisodes(info.slug);result.animex={title:info.titleEnglish||info.titleRomaji,total:eps.length,episodes:eps.map(ep=>({number:ep.number,title:ep.titles?.en||ep.titles?.en_jp||"Episode "+ep.number}))}}catch{}
    try{const m=await paheResolveAnilist(id);const d=await paheGetAllEpisodes(m.paheSession);result.animepahe={title:m.anilistTitle,total:d.total,episodes:d.episodes}}catch{}

    res.json(result);
  }catch(e){res.status(500).json({error:e.message})}
});

// ─── Cache ─────────────────────────────────────────────────────────────────────
app.delete("/cache",(req,res)=>{const s=cache.size;cache.clear();anilistToPahe.clear();res.json({cleared:true,entries:s})});

// ─── 404 ───────────────────────────────────────────────────────────────────────
app.use((req,res)=>res.status(404).json({error:"Not found",endpoints:[
  "GET /health",
  "── Animex ──",
  "GET /animex/providers",
  "GET /animex/search?q=",
  "GET /animex/anime/:anilistId/episodes",
  "GET /animex/anime/:anilistId/servers/:epNum",
  "GET /animex/anime/:anilistId/stream/:epNum?type=sub&provider=",
  "── AnimePahe ──",
  "GET /pahe/search?q=",
  "GET /pahe/anime/:session/episodes",
  "GET /pahe/anime/:session/stream/:epNum?quality=1080",
  "GET /pahe/anilist/:id/stream/:epNum",
  "── Unified ──",
  "GET /search?q=",
  "GET /anilist/:id/episodes",
  "GET /anilist/:id/stream/:epNum",
  "── Proxy ──",
  "GET /proxy?url=<m3u8|ts>&referer=<referer>",
  "DELETE /cache",
]}));

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT,async()=>{
  console.log("\n  ╔══════════════════════════════════════════════╗");
  console.log("  ║   LuffyTV Miruro API v3.0                    ║");
  console.log("  ║   Animex + AnimePahe — Dual Providers         ║");
  console.log("  ╚════════════════════════════════════════════════╝\n");
  console.log("  Port:     "+PORT);
  console.log("  ── Animex ──");
  console.log("  GraphQL:  graphql.animex.one");
  console.log("  REST:     pp.animex.one → chad.anidap.lol");
  console.log("  ── AnimePahe ──");
  console.log("  Site:     "+PAHE_BASE);
  console.log("  Provider: kwik.cx → m3u8/mp4 (HLS)");
  console.log("  CF:       "+(fsAvailable?"FlareSolverr":"got-scraping"));
  console.log("  ── Proxy ──");
  console.log("  HLS:      /proxy?url=<m3u8>&referer=<referer>\n");
  await initPahe();
});

process.on("unhandledRejection",(err)=>console.error("[unhandledRejection]",err?.message||err));
process.on("uncaughtException",(err)=>console.error("[uncaughtException]",err?.message||err));
