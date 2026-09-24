// BezOwijania — background service worker.
// Fetches article pages (cross-origin, so it must happen here, not in the content script)
// and extracts the publisher's own factual summary from <meta property="og:description">.
importScripts('sites.js');

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const CACHE_PREFIX = 'c2:';                    // bump to invalidate older cache formats
const MAX_CONCURRENT = 4;
const MAX_BYTES = 400_000;
const MAX_SUMMARY = 160;                       // keep whole sentences up to about this length

const inflight = new Map(); // key -> Promise<{s, p}|null>
const queue = [];
let active = 0;

// ---------- queue ----------
function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active++;
    task().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

// ---------- HTML helpers (no DOMParser in service workers) ----------
function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bdquo: '„', rdquo: '”', ldquo: '“', oacute: 'ó', Oacute: 'Ó' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in named ? named[n] : m));
}
function clean(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function metaContent(html, key) {
  const tagRe = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const tag = html.match(tagRe)?.[0];
  if (!tag) return '';
  const c = tag.match(/content\s*=\s*"([^"]*)"/i) || tag.match(/content\s*=\s*'([^']*)'/i);
  return c ? clean(c[1]) : '';
}
function firstParagraph(html) {
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = clean(m[1]);
    if (t.length > 80) return t;
  }
  return '';
}

// Sentence ends: . ! ? … optionally followed by a closing quote, then space/end.
function sentenceEnds(text) {
  const ends = [];
  const re = /[.!?…]["”]?(?=\s|$)/g;
  let m;
  while ((m = re.exec(text))) ends.push(m.index + m[0].length);
  return ends;
}

// Make the summary scannable: drop a truncation marker, keep whole sentences, cap the length.
function tidy(text) {
  text = text.trim();
  const marker = /(\.\.\.|…)$/.test(text);
  if (marker) text = text.replace(/\s*(\.\.\.|…)$/, '');
  const truncated = marker || !/[.!?…]["”]?$/.test(text);
  const ends = sentenceEnds(text).filter(i => !truncated || i < text.length);
  // Longest run of whole sentences that fits MAX_SUMMARY (but always at least the first one).
  let cut = ends.filter(i => i <= MAX_SUMMARY).pop() ?? ends[0];
  if (truncated && !cut) return text.length > 60 ? text + '…' : text;
  if (cut && (cut < text.length)) {
    // If the text was cut mid-sentence and trimming would lose most of it, keep it with an ellipsis instead.
    if (truncated && cut < text.length * 0.8 && text.length <= MAX_SUMMARY) return text + '…';
    return text.slice(0, cut).trim();
  }
  if (!cut && text.length > MAX_SUMMARY) return text.slice(0, MAX_SUMMARY).replace(/\s+\S*$/, '') + '…';
  return truncated ? text + '…' : text;
}

function norm(s) { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

function pickSummary(html, originalTitle) {
  const candidates = [metaContent(html, 'og:description'), metaContent(html, 'description'), firstParagraph(html)];
  const t = norm(originalTitle || '');
  for (const c of candidates) {
    if (!c || c.length < 40) continue;
    if (t && norm(c).startsWith(t)) continue; // just repeats the teaser title
    return tidy(c);
  }
  return null;
}

// Sponsored / affiliate content: explicit flags first, then telltale shopping phrases.
const PROMO_WORDS = /(w promocji|w ofercie|znaleźliśmy|kupisz|kod rabatowy|rabat|taniej o|obniżk|okazj[aię] cenow|allegro|materiał partnera|artykuł sponsorowany|materiał promocyjny)/i;
function isPromo(html, summary) {
  if (/sponsored\s*:\s*true/i.test(html)) return true;
  if (/(materiał partnera|artykuł sponsorowany|materiał promocyjny)/i.test(metaContent(html, 'keywords') + ' ' + metaContent(html, 'article:tag'))) return true;
  return PROMO_WORDS.test(summary || '');
}

// Read the response only as far as we need: stop after </head> if og:description is already good.
async function fetchHtml(url, originalTitle) {
  const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let html = '';
  let checkedHead = false;
  while (html.length < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (!checkedHead && /<\/head>/i.test(html)) {
      checkedHead = true;
      if (pickSummary(html.replace(/<p\b[\s\S]*$/i, ''), originalTitle)) break;
    }
  }
  reader.cancel().catch(() => {});
  return html;
}

// ---------- cache ----------
async function getCached(key) {
  const k = CACHE_PREFIX + key;
  const obj = await chrome.storage.local.get(k);
  const v = obj[k];
  if (v && Date.now() - v.t < CACHE_TTL_MS) return v;
  return null;
}
async function setCached(key, s, p) {
  await chrome.storage.local.set({ [CACHE_PREFIX + key]: { s, p, t: Date.now() } });
}
async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter(k =>
    !k.startsWith(CACHE_PREFIX) ? /^(a|c\d+):/.test(k) : Date.now() - all[k].t > CACHE_TTL_MS);
  if (stale.length) await chrome.storage.local.remove(stale);
}
chrome.runtime.onStartup.addListener(pruneCache);
chrome.runtime.onInstalled.addListener(pruneCache);

// ---------- main ----------
async function getSummary(url, title) {
  const art = boArticle(url);
  if (!art) return null;
  const { key } = art;

  const cached = await getCached(key);
  if (cached) return cached.s ? { summary: cached.s, promo: !!cached.p } : null;
  if (inflight.has(key)) return inflight.get(key);

  const p = schedule(async () => {
    try {
      const html = await fetchHtml(url, title);
      const s = pickSummary(html, title);
      const promo = s ? isPromo(html, s) : false;
      await setCached(key, s, promo); // cache misses too (null) so we don't refetch
      return s ? { summary: s, promo } : null;
    } catch (e) {
      console.warn('[BezOwijania]', url, e);
      return null;
    }
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getSummary') {
    getSummary(msg.url, msg.title).then(r => sendResponse(r || {}));
    return true; // async
  }
  if (msg?.type === 'clearCache') {
    chrome.storage.local.get(null).then(all =>
      chrome.storage.local.remove(Object.keys(all).filter(k => /^(a|c\d+):/.test(k)))
    ).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'stats') {
    chrome.storage.local.get(null).then(all =>
      sendResponse({ cached: Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX)).length })
    );
    return true;
  }
});
