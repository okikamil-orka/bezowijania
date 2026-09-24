// BezOwijania — content script.
// Finds article links on Interia pages, asks the background worker for the article's
// own summary, and swaps the teaser title for it. Hover a rewritten title to see the original.

(() => {
  const LINK_SEL = 'a[href*="nId,"]';
  const MIN_TITLE_LEN = 25;
  const MIN_FONT_PX = 12;

  let enabled = true;
  const applied = []; // { a, node, original, touched: [{el, cssText}] }
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
    root.querySelectorAll(LINK_SEL).forEach(a => {
      if (seen.has(a)) return;
      seen.add(a);
      if (a.closest('header, footer, nav')) return;
      if ((a.innerText || '').trim().length < MIN_TITLE_LEN) return;
      io.observe(a);
    });
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    scan();
    let t;
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => enabled && scan(), 300); })
      .observe(document.body, { childList: true, subtree: true });
  }

  // ---------- rewrite ----------
  function titleTextNode(a) {
    // Longest text node that isn't inside a label/badge ("PILNE", "Polityczny WF", ...).
    const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (p && p.closest('[class*="label"], [class*="badge"], time, script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let best = null, n;
    while ((n = walker.nextNode())) {
      if (!best || n.nodeValue.trim().length > best.nodeValue.trim().length) best = n;
    }
    return best;
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
    const rec = { a, node, original, summary, touched: [] };
    applied.push(rec);
    reapply(rec);
  }

  function reapply(rec) {
    const { a, node, original, summary } = rec;
    if (!node.isConnected) return;
    node.nodeValue = summary;
    a.dataset.tiState = 'done';
    a.dataset.tiOriginal = original.trim();
    if (!a.dataset.tiTitleBackup) a.dataset.tiTitleBackup = a.getAttribute('title') ?? '';
    a.setAttribute('title', 'Oryginalny tytuł: ' + original.trim());
    node.parentElement?.classList.add('ti-text');
    fit(rec);
  }

  function restore(rec) {
    const { a, node, original } = rec;
    if (node.isConnected) node.nodeValue = original;
    node.parentElement?.classList.remove('ti-text');
    rec.touched.forEach(({ el, cssText }) => { el.style.cssText = cssText; });
    rec.touched = [];
    delete a.dataset.tiState;
    const backup = a.dataset.tiTitleBackup;
    if (backup) a.setAttribute('title', backup); else a.removeAttribute('title');
    delete a.dataset.tiTitleBackup;
  }

  function touch(rec, el) {
    if (!rec.touched.some(t => t.el === el)) rec.touched.push({ el, cssText: el.style.cssText });
  }

  // Make the longer text fit Interia's fixed-size tiles and line-clamped lists.
  function fit(rec) {
    const { a, node } = rec;
    const textEl = node.parentElement;
    if (!textEl) return;

    // 1) Lift line clamps between the text and the link (list items clamp to 2–4 lines).
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
    let guard = 0;
    if (overflows()) {
      touch(rec, textEl);
      textEl.style.lineHeight = '1.25';
    }
    while (overflows() && fs > MIN_FONT_PX && guard++ < 40) {
      fs -= 1;
      textEl.style.fontSize = fs + 'px';
    }
  }
})();
