// BezOwijania — content script (runs after sites.js).
// Finds article links, asks the background worker for the article's own summary,
// and swaps the teaser title for it. Hover a rewritten title to see the original.

(() => {
  if (!boSiteForPage(location.hostname)) return;

  const MIN_TITLE_LEN = 25;
  const MIN_FONT_PX = 12;
  const MIN_FONT_SCALE = 0.75; // longer summaries get a smaller font, but never below 75% of the original

  let enabled = true;
  const applied = []; // { a, node, original, summary, promo, touched: [{el, cssText}] }
  const seen = new WeakSet();

  // ---------- settings ----------
  chrome.storage.sync.get({ enabled: true }).then(s => {
    enabled = s.enabled;
    if (enabled) start();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.enabled) return;
    enabled = changes.enabled.newValue;
    if (enabled) { start(); applied.forEach(reapply); } else { applied.forEach(restore); }
  });

  // ---------- discovery ----------
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      request(e.target);
    }
  }, { rootMargin: '800px 0px' });

  function scan(root = document) {
    root.querySelectorAll('a[href]').forEach(a => {
      if (seen.has(a)) return;
      seen.add(a);
      if (a.closest('header, footer, nav')) return;
      if ((a.innerText || '').trim().length < MIN_TITLE_LEN) return;
      if (!boArticle(a.href)) return;
      io.observe(a);
    });
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    scan();
    let t;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (enabled) { scan(); guard(); } }, 300);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // Sites built with React (WP, Onet) may re-render a card and put the old title back.
  function guard() {
    for (const rec of applied) {
      if (!rec.a.isConnected) continue;
      if (rec.node.isConnected && rec.node.nodeValue === rec.shown) continue;
      const node = titleTextNode(rec.a);
      if (!node) continue;
      if (node.nodeValue.trim() === rec.original.trim()) { rec.node = node; rec.extra = siblingTitleNodes(rec.a, node); rec.touched = []; reapply(rec); }
    }
  }

  // ---------- rewrite ----------
  function titleTextNode(a) {
    // Longest text node that isn't inside a label/badge ("PILNE", "Polityczny WF", comment counts…).
    const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (p && p.closest('[class*="label"], [class*="Label"], [class*="badge"], [class*="Badge"], time, script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let best = null, n;
    while ((n = walker.nextNode())) {
      if (!best || n.nodeValue.trim().length > best.nodeValue.trim().length) best = n;
    }
    return best;
  }

  // Other title fragments in the same heading (e.g. WP: <h3><strong>Wrze po…</strong> reszta tytułu</h3>).
  function siblingTitleNodes(a, node) {
    const box = node.parentElement?.closest('h1, h2, h3, h4, h5, h6');
    if (!box || !a.contains(box)) return [];
    const out = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === node || !n.nodeValue.trim()) continue;
      if (n.parentElement?.closest('[class*="label"], [class*="Label"], [class*="badge"], [class*="Badge"], time')) continue;
      out.push({ node: n, value: n.nodeValue });
    }
    return out;
  }

  async function request(a) {
    const node = titleTextNode(a);
    if (!node) return;
    const original = node.nodeValue;
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'getSummary', url: a.href, title: original.trim() });
    } catch { return; } // extension reloaded
    const summary = resp?.summary;
    if (!summary || !enabled || !node.isConnected) return;
    const extra = siblingTitleNodes(a, node);
    const fullOriginal = (a.querySelector('h1, h2, h3, h4, h5, h6')?.textContent || original).replace(/\s+/g, ' ').trim();
    const rec = { a, node, original, fullOriginal, extra, summary, promo: !!resp.promo, touched: [] };
    applied.push(rec);
    reapply(rec);
  }

  function reapply(rec) {
    const { a, node, fullOriginal, extra, summary, promo } = rec;
    if (!node.isConnected) return;
    // Keep genre markers from the original title, e.g. "[OPINIA]".
    const tag = fullOriginal.match(/\[(opinia|komentarz|analiza|felieton|wywiad|sonda[żz]|quiz|wideo|galeria|na żywo|relacja)\]/i)?.[0];
    node.nodeValue = tag && !summary.startsWith(tag) ? tag.toUpperCase() + ' ' + summary : summary;
    rec.shown = node.nodeValue;
    extra.forEach(x => { if (x.node.isConnected) x.node.nodeValue = ''; });
    a.dataset.boState = 'done';
    if (!('boTitleBackup' in a.dataset)) a.dataset.boTitleBackup = a.getAttribute('title') ?? '';
    a.setAttribute('title', (promo ? 'Prawdopodobnie treść reklamowa. ' : '') + 'Oryginalny tytuł: ' + fullOriginal);
    const el = node.parentElement;
    el?.classList.add('bo-text');
    el?.classList.toggle('bo-promo', promo);
    fit(rec);
  }

  function restore(rec) {
    const { a, node, original, extra } = rec;
    if (node.isConnected) node.nodeValue = original;
    extra.forEach(x => { if (x.node.isConnected) x.node.nodeValue = x.value; });
    node.parentElement?.classList.remove('bo-text', 'bo-promo');
    rec.touched.forEach(({ el, cssText }) => { el.style.cssText = cssText; });
    rec.touched = [];
    delete a.dataset.boState;
    const backup = a.dataset.boTitleBackup;
    if (backup) a.setAttribute('title', backup); else a.removeAttribute('title');
    delete a.dataset.boTitleBackup;
  }

  function touch(rec, el) {
    if (!rec.touched.some(t => t.el === el)) rec.touched.push({ el, cssText: el.style.cssText });
  }

  // Make the longer text fit fixed-size tiles and line-clamped lists.
  function fit(rec) {
    const { a, node } = rec;
    const textEl = node.parentElement;
    if (!textEl) return;

    // 1) Lift line clamps between the text and the link.
    for (let el = textEl; el && el !== a.parentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') {
        touch(rec, el);
        el.style.webkitLineClamp = '6';
        el.style.maxHeight = 'none';
        el.style.height = 'auto';
      }
    }

    // 2) Longer text → proportionally smaller font (keeps roughly the same area), at most down to 75%.
    const cs = getComputedStyle(textEl);
    const base = parseFloat(cs.fontSize);
    const ratio = rec.original.trim().length / node.nodeValue.length;
    let fs = Math.max(MIN_FONT_PX, Math.min(base, Math.round(base * Math.max(MIN_FONT_SCALE, Math.sqrt(ratio)))));
    touch(rec, textEl);
    if (cs.lineHeight.endsWith('px')) textEl.style.lineHeight = String(parseFloat(cs.lineHeight) / base); // keep spacing proportional
    if (fs < base) textEl.style.fontSize = fs + 'px';

    // 3) If it still spills out of its card (fixed-height tiles, list rows) or covers a badge, keep shrinking.
    const boxes = cardBoxes(a);
    const card = boxes[boxes.length - 1];
    const badges = [...card.querySelectorAll('*')].filter(el =>
      !el.contains(textEl) && !textEl.contains(el) &&
      [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim())
    ).map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
    const range = document.createRange();
    range.selectNodeContents(node);
    let clamped = false;
    const overflows = () => {
      // Range rects ignore overflow clipping, so once clamped measure the element and only its visible lines.
      const clip = clamped ? textEl.getBoundingClientRect() : null;
      const tr = clip || range.getBoundingClientRect();
      if (!tr.height) return false;
      for (const el of boxes) {
        const br = el.getBoundingClientRect();
        if (br.height && (tr.top < br.top - 1 || tr.bottom > br.bottom + 1)) return true;
      }
      const lines = [...range.getClientRects()].filter(l => !clip || l.bottom <= clip.bottom + 1);
      return lines.some(l => badges.some(b =>
        l.left < b.right - 1 && l.right > b.left + 1 && l.top < b.bottom - 1 && l.bottom > b.top + 1));
    };
    let guardN = 0;
    while (overflows() && fs > MIN_FONT_PX && guardN++ < 40) {
      fs -= 1;
      textEl.style.fontSize = fs + 'px';
    }

    // 4) Still too long at the minimum font: cut it to the lines that fit; full text stays in the tooltip.
    if (!overflows()) return;
    const lh = parseFloat(getComputedStyle(textEl).lineHeight) || fs * 1.25;
    let lines = Math.max(2, Math.round(range.getBoundingClientRect().height / lh));
    Object.assign(textEl.style, { display: '-webkit-box', webkitBoxOrient: 'vertical', overflow: 'hidden', maxHeight: 'none', height: 'auto' });
    textEl.style.webkitLineClamp = String(lines);
    clamped = true;
    while (overflows() && lines > 2) textEl.style.webkitLineClamp = String(--lines);
    a.setAttribute('title', node.nodeValue + '\n\n' + a.getAttribute('title'));
  }

  // The link plus every ancestor that belongs only to this article (the "card").
  function cardBoxes(a) {
    const out = [a];
    let el = a.parentElement;
    for (let i = 0; el && el !== document.body && i < 8; i++, el = el.parentElement) {
      if (![...el.querySelectorAll('a[href]')].every(x => x.href === a.href)) break;
      out.push(el);
    }
    return out;
  }
})();
