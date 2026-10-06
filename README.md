# Harmonica Studio — Bend Trainer

A static site for learning to bend notes on the 10-hole diatonic harmonica.

- **`index.html`**: the Bend Trainer, laid out as three steps. Pick a key (all 12, plus Low D/E/F/G and High G), choose a bend, and play. The mic shows your pitch on a bend-depth gauge and a live trace, scores each attempt, plays reference tones and the slide, and lets you record a take to compare.
- **`faq.html`**: the 10 most common bending questions, answered in our own words, with links to video lessons and sources.

Light and dark themes follow the device setting until the user picks one with the sun/moon toggle.

No framework, no build step and no backend. Plain HTML, CSS and JavaScript modules.

## What gets saved

Only settings are kept in the browser's `localStorage`: theme, harmonica key, selected bend and the advanced toggle. Practice results ("Today's practice") and recorded takes live in memory and are gone when the page closes, and the page says so.

## Project layout

```
index.html        Trainer page
faq.html          FAQ page
favicon.svg
css/styles.css    Light/dark tokens + both pages
js/harmonica.js   Richter layout, key octaves, bends/overblows, tips
js/pitch.js       YIN pitch detector + median smoothing
js/theme.js       Light/dark toggle (loads in <head> to avoid a flash)
js/app.js         Trainer UI, mic loop, scoring, gauge, trace, tones, recording
```

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
