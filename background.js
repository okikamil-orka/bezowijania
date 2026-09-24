// BezOwijania — background service worker.
// Fetches article pages (cross-origin, so it must happen here, not in the content script)
// and extracts the publisher's own factual summary from <meta property="og:description">.

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MAX_CONCURRENT = 4;
const MAX_BYTES = 400_000;

const ALLOWED_HOSTS = /(^|\.)(interia\.pl|pomponik\.pl|deccoria\.pl|top\.pl|polsat\.pl|terazgotuje\.pl|smaker\.pl)$/i;

const inflight = new Map(); // articleId -> Promise<string|null>
const queue = [];
let active = 0;

function articleId(url) {
  const m = url.match(/nId,(\d+)/);
  return m ? m[1] : null;
}

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

// If the text was cut mid-sentence, trim to the last full sentence (or add an ellipsis).
function tidy(text) {
  text = text.trim();
  if (/[.!?…"”]$/.test(text)) return text;
  const lastStop = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
  // Trim to the last full sentence only if that keeps most of the information.
  if (lastStop > 60 && lastStop >= text.length * 0.8) return text.slice(0, lastStop + 1);
  return text + '…';
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
async function getCached(id) {
  const key = 'a:' + id;
  const obj = await chrome.storage.local.get(key);
  const v = obj[key];
  if (v && Date.now() - v.t < CACHE_TTL_MS) return v;
  return null;
}
async function setCached(id, summary) {
  await chrome.storage.local.set({ ['a:' + id]: { s: summary, t: Date.now() } });
}
async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter(k => k.startsWith('a:') && Date.now() - all[k].t > CACHE_TTL_MS);
  if (stale.length) await chrome.storage.local.remove(stale);
}
chrome.runtime.onStartup.addListener(pruneCache);
chrome.runtime.onInstalled.addListener(pruneCache);

// ---------- main ----------
async function getSummary(url, title) {
  const id = articleId(url);
  if (!id) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!ALLOWED_HOSTS.test(host)) return null;

  const cached = await getCached(id);
  if (cached) return cached.s;
  if (inflight.has(id)) return inflight.get(id);

  const p = schedule(async () => {
    try {
      const html = await fetchHtml(url, title);
      const s = pickSummary(html, title);
      await setCached(id, s); // cache misses too (null) so we don't refetch
      return s;
    } catch (e) {
      console.warn('[BezOwijania]', url, e);
      return null;
    }
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getSummary') {
    getSummary(msg.url, msg.title).then(summary => sendResponse({ summary }));
    return true; // async
  }
  if (msg?.type === 'clearCache') {
    chrome.storage.local.get(null).then(all =>
      chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith('a:')))
    ).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'stats') {
    chrome.storage.local.get(null).then(all =>
      sendResponse({ cached: Object.keys(all).filter(k => k.startsWith('a:')).length })
    );
    return true;
  }
});
