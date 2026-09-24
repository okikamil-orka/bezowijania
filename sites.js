// BezOwijania — per-portal configuration, shared by content.js and background.js.
// To support a new portal: add an entry with the pages it runs on, the article hosts it may fetch,
// and a function that extracts a stable article id from a link (null = not an article).

const BO_SITES = [
  {
    id: 'interia',
    pages: /(^|\.)interia\.pl$/,
    hosts: /(^|\.)(interia\.pl|pomponik\.pl|deccoria\.pl|top\.pl|polsat\.pl|terazgotuje\.pl|smaker\.pl)$/,
    articleId: u => (u.pathname + u.search).match(/nId,(\d+)/)?.[1] ?? null,
  },
  {
    id: 'wp',
    pages: /(^|\.)wp\.pl$/,
    hosts: /(^|\.)(wp\.pl|money\.pl|o2\.pl|pudelek\.pl|abczdrowie\.pl|autokult\.pl|jastrzabpost\.pl|pysznosci\.pl|dobreprogramy\.pl|fotoblogia\.pl|benchmark\.pl|gadzetomania\.pl|komorkomania\.pl|parenting\.pl|ipolska24\.pl|genialne\.pl|polygamia\.pl)$/,
    // …-7332962258495744a  /  …,7331798044846304a.html   (a = article, v = video, g = gallery; q = quiz is skipped)
    // sportowefakty.wp.pl/pilka-nozna/1234567/slug
    articleId: u =>
      u.pathname.match(/[-,/](\d{13,19})[avg](?:\.html)?$/)?.[1] ??
      (/(^|\.)sportowefakty\.wp\.pl$/.test(u.hostname) ? u.pathname.match(/\/(\d{5,9})\/[^/]+$/)?.[1] ?? null : null),
  },
  {
    id: 'onet',
    pages: /(^|\.)onet\.pl$/,
    hosts: /(^|\.)(onet\.pl|businessinsider\.com\.pl|komputerswiat\.pl|auto-swiat\.pl|fakt\.pl|plejada\.pl|medonet\.pl|noizz\.pl|forbes\.pl|newsweek\.pl)$/,
    // …/some-article-slug/c69kw8r   or   www.onet.pl/…/some-slug/1qfhckk,0898b825
    // (7-char id right after a hyphenated slug, so section pages like /informacje/kultura don't match)
    articleId: u => {
      const m = u.pathname.match(/\/[^/]*-[^/]*\/([a-z0-9]{7})(?:,[0-9a-f]{8})?$/);
      return m ? m[1] : null;
    },
  },
];

// Returns { site, key } for an article link, or null.
function boArticle(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  for (const site of BO_SITES) {
    if (!site.hosts.test(u.hostname)) continue;
    const id = site.articleId(u);
    if (id) return { site, key: site.id + ':' + id };
  }
  return null;
}

function boSiteForPage(hostname) {
  return BO_SITES.find(s => s.pages.test(hostname)) || null;
}
