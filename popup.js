const sw = document.getElementById('enabled');
const label = document.getElementById('label');
const stats = document.getElementById('stats');

function render() {
  sw.setAttribute('aria-checked', String(sw.checked));
  label.textContent = sw.checked ? 'Prawdziwe tytuły: wł.' : 'Prawdziwe tytuły: wył.';
}
chrome.storage.sync.get({ enabled: true }).then(s => { sw.checked = s.enabled; render(); });
sw.addEventListener('change', () => { render(); chrome.storage.sync.set({ enabled: sw.checked }); });

function refresh() {
  chrome.runtime.sendMessage({ type: 'stats' }).then(r => {
    stats.textContent = `W pamięci: ${r.cached} artykułów`;
  });
}
document.getElementById('clear').addEventListener('click', () =>
  chrome.runtime.sendMessage({ type: 'clearCache' }).then(refresh)
);
refresh();
