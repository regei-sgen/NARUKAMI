---
name: asset-handling
description: godsite's asset-handling skill. Sourcing-or-generating images/logo/icons/fonts, optimizing them (format/size/dimensions/lazy-loading), and clearly marking every generated placeholder for swap-in. Use within godsite when adding images or fonts, optimizing assets, or producing placeholder media/copy.
---

# Asset handling (godsite)

Assets make or break both look and performance. Two modes: the user PROVIDES assets, or godsite GENERATES
placeholders — never silently ship a generated asset as if it were final.

## 1. Provided vs generated
- **Provided:** use the user's logo/images/colors/copy as given; fit them to the design tokens.
- **Generate:** create realistic placeholder copy (real-sounding, not "lorem ipsum" where readable copy
  matters) and suitable placeholder images/SVGs. **Mark every generated spot clearly** — an inline
  `<!-- TODO: replace with real <thing> -->` comment AND a note in the hand-off — so the user knows
  exactly what to swap before launch.

## 2. Images — format & size
- Prefer **SVG** for logos/icons/illustration; **WebP/AVIF** for photos (with a fallback where needed).
- Resize to the actual displayed dimensions (don't ship a 4000px hero rendered at 1200px). Provide
  responsive sizes (`srcset`/`sizes`) for large/hero images.
- ALWAYS set explicit `width`/`height` (or aspect-ratio) to prevent layout shift (CLS).
- `loading="lazy"` + `decoding="async"` on below-the-fold images; eager-load the LCP/hero image.
- Meaningful `alt` on every content image — see [`accessibility`](../accessibility/SKILL.md).

## 3. Icons & favicon
- Use an inline SVG sprite or a small icon set; avoid pulling a huge icon-font for three glyphs.
- Produce the favicon/OG image set — coordinate with [`seo-meta`](../seo-meta/SKILL.md).

## 4. Fonts
- Prefer a system font stack by default (zero load cost). If using web fonts: self-host or use
  `font-display: swap`, subset to needed weights, and `preload` the primary font. 1–2 families max.

## 5. Organization & hygiene
- Assets in a predictable dir (`/assets` or `/public`), referenced by correct (base-path-aware) URLs —
  coordinate with [`deployment-prep`](../deployment-prep/SKILL.md).
- No unused/huge assets shipped. No secrets or unrelated files in the asset dir.

## 6. Render path (don't block first paint)
Assets are half the story — the CSS/JS that block first paint are the other half. These are Core-Web-Vitals
levers: render-blocking resources hurt **FCP/LCP**, heavy JS hurts **TBT**.
- **Critical CSS:** inline the above-the-fold critical CSS in `<head>`; defer/async-load the rest. No large
  render-blocking stylesheet in `<head>`.
- **Scripts:** `defer` (or `async` for independent scripts) — never a render-blocking `<script>` in `<head>`.
  Keep total JS lean. Code-split / lazy-load only where a framework actually ships a bundle; most godsite
  static builds barely have one — don't add ceremony where there's no bundle to split.
- **Resource hints:** `preconnect` (with a `dns-prefetch` fallback) to required third-party origins;
  `prefetch` the likely next-nav documents; `fetchpriority="high"` on the LCP image (pairs with the eager-load
  LCP rule in §2). Keep the font `preload` from §4.
- **SRI:** every third-party `<script>`/`<link>` carries a valid `integrity` + `crossorigin` attribute —
  supply-chain hardening that pairs with [`deployment-prep`](../deployment-prep/SKILL.md)'s security headers.
- **Ownership:** this skill owns the render-path *levers*; the numeric CWV pass/fail thresholds (LCP ≤ 2.5s,
  CLS ≤ 0.1, TBT) and the remediation gate are owned by [`deployment-prep`](../deployment-prep/SKILL.md) — it judges, this skill tunes.

## 7. Verify (per the web-builder contract)
Verify on the served build: assets **load (network requests → 200, not 404)**, no oversized payloads
dragging the Lighthouse **performance** score, no layout shift from missing dimensions, and every
generated placeholder is marked. A 404 asset or an unoptimized hero tanking the score = not done; fix and
re-verify.

Then prove the render path moved the levers — a **measured** artifact, never "optimized" prose:
- Lighthouse on the served build flags nothing under **"Eliminate render-blocking resources"** or
  **"Reduce unused CSS/JS"**.
- Network waterfall shows render-blocking CSS/JS off the critical path, `preconnect`/`preload` firing
  **before** their consumers, and `fetchpriority="high"` on the LCP request.
- Third-party resources load **200 with a valid SRI hash** — no SRI-mismatch console error.
- Capture **LCP/FCP/TBT before and after** to show the lever actually moved.
