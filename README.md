# Harmonica Bending

A free harmonica bending trainer and FAQ for the 10-hole diatonic harmonica, planned for **harmonicabending.com**.

- **`index.html`**: the Bend Trainer, laid out as three steps. Pick a key (all 12, plus Low D/E/F/G and High G), choose a bend, and play. The mic shows your pitch on a bend-depth gauge and a live trace, scores each attempt, plays reference tones and the slide, and lets you record a take to compare.
- **`faq.html`**: the 10 most common bending questions, answered in our own words, with links to video lessons and sources.

Light and dark themes follow the device setting until the user picks one with the sun/moon toggle.

No framework, no build step and no backend. Plain HTML, CSS and JavaScript modules.

## What gets saved

Only settings are kept in the browser's `localStorage`: theme, harmonica key, selected bend and the advanced toggle. Practice results ("Today's practice") and recorded takes live in memory and are gone when the page closes, and the page says so. Microphone audio is processed in the browser and never uploaded.

Both pages load Google Analytics 4 (`G-1V1MS5JSF1`) with Consent Mode v2. In the EEA, UK and Switzerland analytics cookies stay off until the visitor clicks "Allow analytics" in the banner (`js/consent.js`), which only appears for European time zones; everywhere else analytics is on by default. Anyone can change their choice from "Cookie settings" in the footer, and declining deletes any `_ga` cookies. Ads storage is always denied. GA4's enhanced measurement records outbound clicks, so Ko-fi button clicks show up without extra code.

## Project layout

```
index.html        Trainer page
faq.html          FAQ page
privacy.html      Privacy policy (update it if analytics, hosting or fonts change)
favicon.svg
llms.txt          Plain-text site summary for AI assistants (llmstxt.org)
robots.txt        Allows all crawlers, points to the sitemap
sitemap.xml
scripts/build-faq-schema.py   Rebuilds the FAQ page's JSON-LD from its visible answers
css/styles.css    Light/dark tokens + both pages
js/harmonica.js   Richter layout, key octaves, bends/overblows, tips
js/pitch.js       YIN pitch detector + median smoothing
js/theme.js       Light/dark toggle (loads in <head> to avoid a flash)
js/consent.js     Cookie banner for Google Analytics
js/app.js         Trainer UI, mic loop, scoring, gauge, trace, tones, recording
```

## SEO and structured data

- Both pages have a keyword-focused `<title>`, meta description, canonical URL, and Open Graph/Twitter tags, all pointing at `https://harmonicabending.com`. If the domain changes, search-and-replace it across `index.html`, `faq.html`, `llms.txt`, `robots.txt`, `sitemap.xml` and the script.
- `index.html` carries JSON-LD for `WebSite`, `WebPage`, `WebApplication` (free, browser-based) and a `HowTo` that matches the visible "How it works" section.
- `faq.html` carries `FAQPage` (all 10 questions) and `BreadcrumbList`. The answer text is generated from the page itself, so **after editing any FAQ answer, run** `python3 scripts/build-faq-schema.py` to keep them identical.
- Canonical URLs use `/faq` (no `.html`), which is how Cloudflare Pages serves `faq.html`. Update `lastmod` in `sitemap.xml` when content changes.

## Run locally

The mic only works on `https://` or `localhost`, so open the site through a local server, not by double-clicking the file:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy free on Cloudflare

1. Push this folder to `github.com/rw-matt/Harmonica-Bending`.
2. In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Connect to Git** and pick the repo.
3. Build settings: framework preset **None**, build command **(empty)**, output directory **`/`**.
4. Deploy. Every push to `main` redeploys, and pull requests get preview URLs.
5. Add your domain under the project's **Custom domains** tab. HTTPS (required for the mic) is automatic.

Cloudflare's dashboard labels change from time to time. If a step doesn't match, look for "import a Git repository" under Workers & Pages.

## Harmonica model notes

- Hole 1 blow is MIDI note `root`. Standard G–B harps start in octave 3 (G3–B3); C–F♯ start in octave 4 (C4–F♯4).
- Draw bends: holes 1–6 (½, 1, 1½, ½, —, ½ steps). Blow bends: holes 8–10 (½, ½, 1).
- Overblows: holes 1, 4, 5, 6. Overdraws: holes 7, 9, 10 (shown when "advanced" is on).
- A bend counts as on target within ±20 cents, and as "nailed" when held for 0.35 s.
