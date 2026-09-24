# BezOwijania

<img src="icons/logo.svg" width="96" align="right" alt="">

Rozszerzenie do Chrome, które zamienia clickbaitowe tytuły na portalach na zdania mówiące, co się naprawdę stało.
Przeskanuj wiadomości i otwórz tylko te, które Cię interesują.

**Strona:** https://okikamil-orka.github.io/bezowijania/

| Oryginał | BezOwijania |
|---|---|
| Sensacja w ćwierćfinale mistrzostw Europy. Włosi za burtą | Finlandia wyeliminowała mistrzów świata Włochy 3:2 w ćwierćfinale siatkarskich ME, zagra z Francją o finał. |
| Marian Kmita tłumaczy ws. długów PKOl. Oto szczegóły | Długi PKOl przekraczają 4 mln zł. Największe dotyczą leasingu aut i związków sportowych. |

## Jak działa

Każdy artykuł ma w `<meta property="og:description">` krótkie, rzeczowe streszczenie od redakcji.

1. `content.js` znajduje linki do artykułów, gdy wjeżdżają w widok. Jak rozpoznać artykuł na danym portalu, opisuje `sites.js`
   (Interia: `,nId,123`; WP: `-7332962258495744a`; Onet: `/slug-artykulu/c69kw8r`).
2. `background.js` pobiera stronę artykułu (tylko `<head>`, bez ciasteczek) i odczytuje streszczenie
   (zapasowo: `meta description`, potem pierwszy akapit). Pomija streszczenia, które tylko powtarzają tytuł.
3. Tytuł jest podmieniany i dopasowywany do kafelka. Niebieska kropka = podmieniony tytuł, pomarańczowa = prawdopodobnie reklama.
   **Najechanie pokazuje oryginał.** Znaczniki gatunku z tytułu (np. `[OPINIA]`) zostają.
4. Wyniki są trzymane lokalnie przez 3 dni, maks. 4 pobrania naraz. Bez AI, bez serwerów, bez analityki.

## Instalacja (dev)

1. `chrome://extensions` → włącz **Tryb dewelopera**.
2. **Załaduj rozpakowane** → wskaż ten folder.
3. Po zmianach w kodzie: ↻ na karcie rozszerzenia i odśwież stronę.

## Wydanie

```bash
# podbij "version" w manifest.json, potem:
zip -r dist/bezowijania-$(jq -r .version manifest.json).zip \
  manifest.json sites.js background.js content.js content.css popup.html popup.js icons
```

ZIP wgrywasz do GitHub Releases i/lub do Chrome Web Store Developer Dashboard.

## Pliki

| Plik | Rola |
|---|---|
| `manifest.json` | Manifest V3, uprawnienia do Interii, WP, Onetu i ich serwisów |
| `sites.js` | konfiguracja portali: gdzie działa, jak rozpoznać artykuł, skąd wolno pobierać |
| `background.js` | kolejka pobrań, wyciąganie streszczeń, pamięć podręczna |
| `content.js` | wyszukiwanie linków, podmiana tytułów, dopasowanie do kafelków |
| `content.css` | niebieska kropka przy podmienionym tytule |
| `popup.html/js` | suwak wł./wył., statystyka pamięci |
| `docs/` | strona GitHub Pages i polityka prywatności |

## Plany

- Opcjonalny krok AI dla słabych streszczeń; oznaczanie artykułów sponsorowanych.

Polityka prywatności: [docs/privacy.html](https://okikamil-orka.github.io/bezowijania/privacy.html)
