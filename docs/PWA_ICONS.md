# PWA icons

The app icons used when the portal is installed to a phone home screen — the files in
`public/icons/` (referenced by `public/manifest.json` and the `apple-touch-icon` link in
`public/index.html`).

> Kept in `docs/` rather than `public/icons/` on purpose: anything under `public/` is
> copied verbatim into the build and served publicly. Internal notes shouldn't be.

## Source

**`public/brand/grays-fitness-logo.svg`** — the official Grays Fitness logo, taken from the
WordPress media library on graysfitness.com.au (attachment 13487, the site's `custom_logo`).
It is committed here so the icons can be regenerated without hunting for the asset again.

Nothing in this folder is drawn or AI-generated. Every icon is the real artwork, rasterised.

## How these were produced

| File | Size | Purpose | Inset |
|---|---|---|---|
| `icon-192.png` | 192×192 | manifest, `purpose: any` | 0.88 |
| `icon-512.png` | 512×512 | manifest, `purpose: any` | 0.88 |
| `icon-512-maskable.png` | 512×512 | manifest, `purpose: maskable` | 0.72 |
| `apple-touch-icon-180.png` | 180×180 | iOS home screen | 0.84 |

All four are the logo **centred on a white background**, trimmed to the artwork's real ink
bounds first so the wide lockup isn't shrunk by empty space in the viewBox.

Two deliberate decisions, both worth knowing before you regenerate:

1. **The red tagline is omitted.** The full lockup includes
   *"USED AND REMANUFACTURED COMMERCIAL GYM EQUIPMENT"* in small red type. At 192 px — and
   realistically ~48 px on a home screen — it is illegible, and renders as a muddy red
   smear that makes the whole icon look dirty. Dropping it is a subset of the official
   artwork, not a redesign, and it is normal practice for app icons (favicons never carry
   taglines). The wordmark and globe remain exactly as drawn.

2. **The maskable inset is 0.72, not 0.88.** Android crops maskable icons to a circle whose
   diameter is 80% of the canvas — so the artwork must fit the inscribed *circle*, not the
   square. For a w×h rectangle that means `sqrt(w² + h²) ≤ 0.8 × size`. The trimmed lockup
   is ≈2.9:1, giving `w ≤ 0.756 × size`; 0.72 keeps a safety margin. Set it higher and
   Android will clip the ends off "GRAYS" and "FITNESS".

## Regenerating

There is no npm script for this: rasterising SVG needs a renderer, and the repo has no
image dependency (adding one for four static files isn't worth it). The PNGs were produced
by loading the SVG into a canvas in a browser at each target size with the insets above,
on a white background.

If the logo changes, the simplest path is to re-export the four sizes from any vector tool
using the table above, keeping the same filenames. `scripts/podium-pwa-smoke.mjs` verifies
each file exists, is a real PNG, and has the exact pixel dimensions listed — so a
wrong-sized export fails the build rather than shipping a blurry home-screen icon.
