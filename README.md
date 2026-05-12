# One Life Transportation · VA Trip Invoicing

Static web app that turns a Master Trip Export (`.xlsx`) into invoice sheets and an internal report for **VA San Diego** and **VA Long Beach**. Runs entirely in the browser. No backend.

## Features

- **One upload, both facilities.** Drop the Master Trip Export once — switch between San Diego and Long Beach freely. Use **Replace File** to load a different export.
- **Invoice sheets**:
  - San Diego: two toggleable invoice sheets — Stretcher/Bariatric and Wheelchair/Ambulatory (with companion rates). Click the sheet title to rename it.
  - Long Beach: single combined invoice sheet.
- **Data tab (editable)**: full 20-column view plus a **Mobility** dropdown (Gurney / Bariatric / Wheelchair / WC Companion / Ambulatory / Amb Companion). Click any cell to edit. Edits to Status, Mobility, Wait, or Mileage auto-recompute the price; manual **Total Price** edits override (yellow dot).
- **Internal Report tab**: read-only 20-column (A→T) layout for approval submission. Reflects all edits from the Data tab. Date / status / mode / payer-ID checkbox filters.
- **Print / Save PDF**:
  - Invoice Sheet → portrait letter (8.5 × 11 in)
  - Internal Report → landscape letter (11 × 8.5 in), all 20 columns fit
- **Dark mode** with persistent toggle (saved in `localStorage`). Print output is always light regardless of theme.
- **CSV / Excel export** for the internal report.

## Files

```
onelife-app/
├── index.html      # entry shell + xlsx CDN + theme toggle markup
├── styles.css      # design tokens, components, dark mode, print rules
├── app.js          # state, parser, views, pricing, exports
└── README.md       # this file
```

No build step. Edit any file → reload browser.

## Run locally

Just open `index.html` in a browser — it works from `file://`. Alternatively, serve the folder over HTTP:

```bash
cd onelife-app
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploy to GitHub Pages

1. Create a new GitHub repository (e.g. `onelife-invoicing`).
2. Push the contents of this folder to the repo root (do **not** put it inside a sub-folder unless you also set the Pages source to that folder):
   ```bash
   cd onelife-app
   git init
   git add -A
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-user>/onelife-invoicing.git
   git push -u origin main
   ```
3. In the repo on GitHub → **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: `main` · folder: `/ (root)` → **Save**.
4. Wait ~30 seconds, then visit `https://<your-user>.github.io/onelife-invoicing/`.

To update: commit + push → GitHub Pages redeploys automatically.

> Note: GitHub Pages serves over HTTPS. The xlsx CDN is loaded over HTTPS already, so there are no mixed-content issues.

## Rates

Rates live in `app.js` under the `RATES` constant (top of file). Edit there to change contracted rates globally.

```js
const RATES = {
  gurneyCompleted: 195,
  bariCompleted: 390,
  // ...
};
```

Payer IDs per facility are in `CITIES` (also top of `app.js`). Update if contracts change.

## Notes on logic

- **Wait time**: 15-minute grace; rounded up to the nearest 15-minute billable unit beyond that.
- **Additional miles**: 30-mile grace; any miles beyond that bill at the mode-specific rate.
- **Auto-computed price** vs **manual override**: each row in the internal report shows the manual override (if set, with a yellow indicator dot) or the auto-computed price (mode + status + extras + bariatric flag). The invoice sheet's **Total** column shows the sum of effective prices (override or auto) for each category. The **Rate** column always shows the contracted rate for reference.

## Browser support

Latest Chrome, Firefox, Safari, Edge. No IE.
