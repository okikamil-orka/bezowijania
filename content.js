// BezOwijania — content script (runs after sites.js).
// Finds article links, asks the background worker for the article's own summary,
// and swaps the teaser title for it. Hover a rewritten title to see the original.

(() => {
  if (!boSiteForPage(location.hostname)) return;

  const MIN_TITLE_LEN = 25;
  const MIN_FONT_PX = 12;

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

    // 2) If it still overflows the link box (image tiles have fixed height), shrink the font.
    const overflows = () => {
      const ar = a.getBoundingClientRect();
      const tr = textEl.getBoundingClientRect();
      if (!ar.height) return false;
      return tr.top < ar.top - 1 || tr.bottom > ar.bottom + 1;
    };
    let fs = parseFloat(getComputedStyle(textEl).fontSize);
    let guardN = 0;
    if (overflows()) {
      touch(rec, textEl);
      textEl.style.lineHeight = '1.25';
    }
    while (overflows() && fs > MIN_FONT_PX && guardN++ < 40) {
      fs -= 1;
      textEl.style.fontSize = fs + 'px';
    }
  }
})();
